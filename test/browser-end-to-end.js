// The playground in a real browser: does the editor load, does the analyser
// answer, and does a program compile and run?
//
// There is no way to check this without a browser. The pieces that break are
// the ones only a browser exercises: the wasm runtime, Monaco's loader, the
// WebSocket to the analyse service, and the interaction between them.
//
//   node test/browser-end-to-end.js
//   BASE=https://playground.ghul.dev/ TOKEN=... node test/browser-end-to-end.js
//
// Needs a Chrome or Chromium binary; set CHROME if it is not where Playwright
// puts it. Drives it over the DevTools protocol rather than through a test
// framework, so it has no dependencies of its own.

const { spawn, execFileSync } = require('child_process');

const CHROME = process.env.CHROME
    ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1140/chrome-linux/chrome`;

const BASE = process.env.BASE ?? 'http://127.0.0.1:5080/';
const TOKEN = process.env.TOKEN;
const PORT = Number(process.env.CDP_PORT ?? 9321);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

let failures = 0;

// Chromium left running by an earlier run has init as its parent. Reported
// rather than killed, since it could belong to something else.
try {
    const orphans = execFileSync('ps', ['-eo', 'ppid=,args='], { encoding: 'utf8' })
        .split('\n')
        .filter(line => /^\s*1\s/.test(line) && line.includes('ms-playwright/chromium'))
        .length;

    if (orphans) log(`warning: ${orphans} Chromium process(es) left by an earlier run are still running`);
} catch { /* no ps to ask */ }

function check(what, ok, detail = '') {
    if (!ok) failures++;
    log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  ${detail}` : ''}`);
}

const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=/tmp/ghul-playground-test-${process.pid}`,
    'about:blank'
], { stdio: 'ignore' });

// The browser outlives this process unless it is stopped, so it is stopped
// on every way out: the end of the run, a check that throws, a timeout's
// signal. Node reaches its exit event after an uncaught exception too.
process.on('exit', () => chrome.kill());

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
        log(`stopped by ${signal}`);
        process.exit(1);
    });
}

chrome.on('error', e => {
    console.error(`could not start ${CHROME}: ${e.message}`);
    process.exit(1);
});

(async () => {
    let target;
    for (let i = 0; i < 40; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
            target = list.find(t => t.type === 'page');
            if (target) break;
        } catch { /* not listening yet */ }
        await sleep(500);
    }

    if (!target) { console.error('chrome never became available'); process.exit(1); }

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r));

    let id = 0;
    const pending = new Map();

    // Requests the browser has paused for the test to answer, by URL.
    const intercepted = new Map();

    ws.addEventListener('message', e => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        if (m.method === 'Fetch.requestPaused') answerIntercepted(m.params);
        if (m.method === 'Runtime.exceptionThrown') {
            log(`page exception: ${m.params.exceptionDetails?.exception?.description
                ?? m.params.exceptionDetails?.text}`);
            failures++;
        }
    });

    const cmd = (method, params = {}) => new Promise(res => {
        const i = ++id;
        pending.set(i, res);
        ws.send(JSON.stringify({ id: i, method, params }));
    });

    // Answered from the map, or as not found, with the header a cross-origin
    // fetch needs to be allowed to read the answer.
    function answerIntercepted({ requestId, request }) {
        const body = intercepted.get(request.url);

        ws.send(JSON.stringify({
            id: ++id,
            method: 'Fetch.fulfillRequest',
            params: {
                requestId,
                responseCode: body === undefined ? 404 : 200,
                responseHeaders: [
                    { name: 'Access-Control-Allow-Origin', value: '*' },
                    ...(request.url.endsWith('.js') ? [{ name: 'Content-Type', value: 'text/javascript' }] : [])
                ],
                body: Buffer.from(body ?? '').toString('base64')
            }
        }));
    }

    const ev = async expression => (await cmd('Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;

    await cmd('Runtime.enable');
    await cmd('Page.enable');

    // The token lives in the playground origin's storage, which is where a
    // reader would have entered it.
    if (TOKEN) {
        await cmd('Page.navigate', { url: new URL('/embed.html', BASE).toString() });
        await sleep(4000);
        await ev(`localStorage.setItem('ghul-playground-token', ${JSON.stringify(TOKEN)}); true`);
    }

    await cmd('Page.navigate', { url: BASE });

    for (let i = 0; i < 120; i++) {
        if (await ev(`document.getElementById('compiler')?.dataset.state === 'ready'`)) break;
        await sleep(500);
    }
    check('the runtime and editor load',
        await ev(`document.getElementById('compiler')?.dataset.state === 'ready'`),
        await ev(`document.getElementById('status')?.innerText`));

    for (let i = 0; i < 90; i++) {
        if (await ev(`document.getElementById('analyser')?.dataset.state === 'ready'`)) break;
        await sleep(500);
    }
    check('the analyser connects',
        await ev(`document.getElementById('analyser')?.dataset.state === 'ready'`),
        await ev(`document.getElementById('analyser')?.innerText`));

    // Diagnostics as you type: break the program and wait for a marker.
    const broken = [
        'use IO.Std.write_line;', '', 'entry() is',
        '    let squares = [1, 2, 3] | .map(n => n * n) | .collect_list();',
        '    write_line("{squares.no_such_member}");', 'si', ''
    ].join('\n');

    const started = Date.now();
    await ev(`monaco.editor.getModels()[0].setValue(${JSON.stringify(broken)}); true`);

    let markers = '[]';
    for (let i = 0; i < 120; i++) {
        markers = await ev(
            `JSON.stringify(monaco.editor.getModelMarkers({owner:'ghul-analyse'}).map(m => m.message))`);
        if (markers && markers !== '[]') break;
        await sleep(250);
    }
    check('live diagnostics arrive', markers !== '[]', `${Date.now() - started} ms, ${markers}`);

    // Hover, driven through the real UI: there is no public API to invoke it.
    await ev(`(() => {
        const editor = monaco.editor.getEditors()[0];
        editor.setPosition({ lineNumber: 4, column: 9 });
        editor.trigger('test', 'editor.action.showHover', {});
        return true;
    })()`);
    await sleep(2500);
    const hover = await ev(`(document.querySelector('.monaco-hover-content') || {}).innerText || null`);
    check('hover answers', Boolean(hover), hover ? JSON.stringify(hover.slice(0, 60)) : '');

    // Completion.
    await ev(`(() => {
        const editor = monaco.editor.getEditors()[0];
        editor.getModel().setValue('use IO.Std.write_line;\\n\\nentry() is\\n    let xs = [1, 2, 3] | .collect_list();\\n    xs.\\nsi\\n');
        editor.setPosition({ lineNumber: 5, column: 8 });
        return true;
    })()`);
    await sleep(1500);
    await ev(`monaco.editor.getEditors()[0].trigger('test','editor.action.triggerSuggest',{}); true`);
    await sleep(3000);

    const suggestions = await ev(
        `document.querySelectorAll('.suggest-widget .monaco-list-row').length`);
    check('completion offers members', suggestions > 0, `${suggestions} suggestion(s)`);

    // Compile and run, which exercises the compile service and the wasm host.
    await ev(`(() => {
        monaco.editor.getModels()[0].setValue(
            'use IO.Std.write_line;\\n\\nentry() is\\n    IO.Std.error.write_line("and complained");\\n    write_line("it ran");\\nsi\\n');
        return true;
    })()`);
    await sleep(1000);
    await ev(`document.getElementById('run').click(); true`);

    // Waits for what the program actually prints rather than for the pane to
    // become non-empty: the pane carries a placeholder when there is no output,
    // which would satisfy "non-empty" the moment the tab is shown.
    let output = '';
    for (let i = 0; i < 180; i++) {
        output = await ev(`document.getElementById('output').innerText`);
        if (output.includes('it ran')) break;
        await sleep(500);
    }
    check('the program compiles and runs', output.includes('it ran'), JSON.stringify(output.trim()));

    // Standard error goes to the same stream as standard output, so a program
    // that writes to it is not left talking to the browser's own console,
    // where nobody using the page would look. The program writes this line
    // before the one above, so a run that got as far as the check above gave
    // this one its chance to arrive too.
    check('standard error reaches the output pane', output.includes('and complained'),
        JSON.stringify(output.trim()));

    // A program that reads a line. This is the one thing on the page that
    // cannot work at all unless the runtime is on a worker thread and the page
    // is cross-origin isolated, so it is also the check that says both are
    // true - and neither shows up as a failure anywhere else, because a
    // runtime that will not start looks like a run that never finishes.
    check('the page is cross-origin isolated', await ev(`self.crossOriginIsolated`));

    // Visibility rather than the hidden attribute. A style rule of its own
    // outranks the user agent's [hidden] rule, so the box can carry the
    // attribute and still be on screen - which it was, permanently, and no
    // check that asked the attribute could see it.
    const boxShowing = () => ev(`(() => { const r = document.getElementById('input-row');
                 return Boolean(r) && r.offsetParent !== null; })()`);

    // Asked separately, because boxShowing() is also false when the box is not
    // there at all - so on its own it would pass against a build that has no
    // input row, which is the one build where it means nothing.
    check('the input row exists',
        await ev(`Boolean(document.getElementById('input-row'))`));

    check('no box before a program has asked for a line', !(await boxShowing()));

    const reading = [
        'use IO.Std.write_line;', 'use IO.Std.read_line;', '', 'entry() is',
        '    write_line("what is your name?");', '', '    let name = read_line();', '',
        '    write_line("hello, {name ?? "nobody"}");', 'si', ''
    ].join('\n');

    await ev(`monaco.editor.getModels()[0].setValue(${JSON.stringify(reading)}); true`);
    await sleep(1000);
    await ev(`document.getElementById('run').click(); true`);

    let asked = false;
    for (let i = 0; i < 180; i++) {
        asked = await boxShowing();
        if (asked) break;
        await sleep(500);
    }
    check('a program that reads asks for a line', asked);

    // Mid-run, so this is the state the button is actually in while something
    // is running rather than what it settles back to afterwards.
    check('the button offers to stop while the program runs',
        (await ev(`document.getElementById('run-label').textContent`)) === 'Stop'
        && !(await ev(`document.getElementById('run').disabled`)));

    // The prompt has to be readable before anything is typed, which is only
    // possible if output reaches the page while the program is still running.
    check('output arrives before the run has finished',
        (await ev(`document.getElementById('output').innerText`)).includes('what is your name?'));

    await ev(`(() => {
        document.getElementById('stdin').value = 'world';
        document.getElementById('input-row')
            .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        return true;
    })()`);

    let answered = '';
    for (let i = 0; i < 180; i++) {
        answered = await ev(`document.getElementById('output').innerText`);
        if (answered.includes('hello, world')) break;
        await sleep(500);
    }
    check('the typed line reaches the program', answered.includes('hello, world'),
        JSON.stringify(answered.trim()));
    // A line of its own, so this is the echo rather than the greeting that
    // also contains the word.
    check('what was typed is echoed into the transcript', /^world$/m.test(answered));
    check('the box goes away once the run has finished', !(await boxShowing()));

    // Following the output. A program printing more than the pane holds, and
    // then asking for a line: the box appearing takes its height off the pane,
    // so a build that decides whether to follow by measuring the pane when the
    // text arrives reads as scrolled up from that moment on and never follows
    // again. The board games are exactly this shape.
    const long = [
        'use IO.Std.write_line;', 'use IO.Std.read_line;', '', 'entry() is',
        '    for i in 1::200 do', '        write_line("line {i}");', '    od', '',
        '    write_line("what is your name?");', '', '    let name = read_line();', '',
        '    write_line("hello, {name ?? "nobody"}");', 'si', ''
    ].join('\n');

    await ev(`monaco.editor.getModels()[0].setValue(${JSON.stringify(long)}); true`);
    await sleep(1000);
    await ev(`document.getElementById('run').click(); true`);

    let longAsked = false;
    for (let i = 0; i < 180; i++) {
        longAsked = await boxShowing();
        if (longAsked) break;
        await sleep(500);
    }
    check('a long program that reads asks for a line', longAsked);

    const pane = () => ev(`(() => { const o = document.getElementById('output');
                 return { top: o.scrollTop, height: o.clientHeight, total: o.scrollHeight }; })()`);

    // Asked first, because every check below passes for free on a pane whose
    // content fits - which is the one case where following means nothing.
    const asking = await pane();
    check('the output overflows the pane', asking.total > asking.height,
        JSON.stringify(asking));

    check('the pane follows the output up to the prompt',
        asking.top + asking.height >= asking.total - 4, JSON.stringify(asking));

    // Scrolled away from the tail on purpose, and then answered, so that more
    // output arrives while the reader is somewhere else. Following is for a
    // reader at the bottom, not a rule that drags one back from what they went
    // to look at.
    await ev(`(() => { const o = document.getElementById('output');
                 o.scrollTop = 0; return true; })()`);
    await sleep(200);

    await ev(`(() => {
        document.getElementById('stdin').value = 'world';
        document.getElementById('input-row')
            .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        return true;
    })()`);

    let longAnswered = '';
    for (let i = 0; i < 180; i++) {
        longAnswered = await ev(`document.getElementById('output').innerText`);
        if (longAnswered.includes('hello, world')) break;
        await sleep(500);
    }
    check('the long program read the typed line', longAnswered.includes('hello, world'));

    const parked = await pane();
    check('output arriving does not drag a scrolled-up reader back',
        parked.top < 4, JSON.stringify(parked));
    // The button is how a program is stopped while it runs, so it has to stay
    // live through that state rather than being disabled with the rest.
    check('the run button offers to stop a running program, and returns to Run after',
        (await ev(`document.getElementById('run-label').textContent`)) === 'Run'
        && !(await ev(`document.getElementById('run').hasAttribute('data-stop')`)));

    // Stop, clicked rather than merely looked at. The button showing the right
    // word proves nothing about what pressing it does: it went a whole round
    // saying Stop while still being wired to run the program again.
    await ev(`monaco.editor.getModels()[0].setValue(${JSON.stringify(reading)}); true`);
    await sleep(1000);
    await ev(`document.getElementById('run').click(); true`);

    let waiting = false;
    for (let i = 0; i < 180; i++) {
        waiting = await boxShowing();
        if (waiting) break;
        await sleep(500);
    }
    check('the program is waiting again', waiting);

    await ev(`document.getElementById('run').click(); true`);

    let stopped = '';
    for (let i = 0; i < 60; i++) {
        stopped = await ev(`document.getElementById('run-label').textContent`);
        if (stopped === 'Run') break;
        await sleep(500);
    }
    check('stopping ends the program rather than starting another', stopped === 'Run',
        await ev(`document.getElementById('status').textContent`));

    // Ending the input is what a waiting program is told, so it runs on to
    // whatever it does with no more input rather than being cut off.
    check('the stopped program saw the end of its input',
        (await ev(`document.getElementById('output').innerText`)).includes('hello, nobody'));

    // A program that draws: the picture has to survive being written to the
    // wasm filesystem, read back by the host, and carried to the page as a
    // data URL, and the marker naming it has to leave the text. Nothing short
    // of a browser exercises any of that.
    const drawing = require('fs')
        .readFileSync(`${__dirname}/../examples/draw.ghul`, 'utf8');

    await ev(`monaco.editor.getModels()[0].setValue(${JSON.stringify(drawing)}); true`);
    await sleep(1000);
    await ev(`document.getElementById('run').click(); true`);

    let drawn = 0;
    for (let i = 0; i < 180; i++) {
        drawn = await ev(`document.querySelectorAll('#images-grid img').length`);
        if (drawn > 0) break;
        await sleep(500);
    }

    check('a drawing reaches the page', drawn === 1, `${drawn} image(s)`);
    check('the picture decoded',
        await ev(`(() => { const i = document.querySelector('#images-grid img');
                           return Boolean(i && i.naturalWidth === 640 && i.naturalHeight === 400); })()`));
    check('the image marker leaves the output',
        !(await ev(`document.getElementById('output').innerText`)).includes('<<image'));

    // An animation: the same name shown over and over while the program runs,
    // each showing replacing the picture where it is. So the picture has to
    // change while the run is still going, and it has to be the same element
    // throughout - a pane rebuilt per frame flickers and loses its scroll.
    const bouncing = require('fs')
        .readFileSync(`${__dirname}/../examples/bounce.ghul`, 'utf8');

    await ev(`monaco.editor.getModels()[0].setValue(${JSON.stringify(bouncing)}); true`);
    await sleep(1000);
    await ev(`document.getElementById('run').click(); true`);

    for (let i = 0; i < 180; i++) {
        if (await ev(`document.querySelectorAll('#images-grid img').length === 1
                      && document.getElementById('run-label').textContent === 'Stop'`)) break;
        await sleep(250);
    }

    await ev(`window.firstFrame = document.querySelector('#images-grid img'); true`);

    const frames = new Set();
    let sameElement = true;

    for (let i = 0; i < 20; i++) {
        const frame = await ev(`(() => {
            const img = document.querySelector('#images-grid img');
            return img ? { src: img.src, same: img === window.firstFrame,
                           running: document.getElementById('run-label').textContent === 'Stop' } : null;
        })()`);

        if (!frame?.running) break;

        frames.add(frame.src);
        sameElement &&= frame.same;

        await sleep(200);
    }

    check('an animation changes the picture while it runs', frames.size >= 3, `${frames.size} distinct frame(s)`);
    check('each frame replaces the picture in place', sameElement);

    for (let i = 0; i < 120; i++) {
        if (await ev(`document.getElementById('run-label').textContent`) === 'Run') break;
        await sleep(500);
    }

    const ended = await ev(`document.getElementById('output').innerText`);

    check('the animation finishes with one picture and no markers',
        ended.includes('done') && !ended.includes('<<image')
        && await ev(`document.querySelectorAll('#images-grid img').length`) === 1,
        JSON.stringify(ended.trim()));

    // A carriage return goes back to the start of the line, as a terminal's
    // does, which is how a text spinner draws in place.
    const spinner = [
        'use IO.Std.write;', '', 'entry() is',
        '    write("working |\\r");', '    write("finished  \\n");', 'si', ''
    ].join('\n');

    await ev(`monaco.editor.getModels()[0].setValue(${JSON.stringify(spinner)}); true`);
    await sleep(1000);
    await ev(`document.getElementById('run').click(); true`);

    let spun = '';
    for (let i = 0; i < 120; i++) {
        spun = await ev(`document.getElementById('output').innerText`);
        if (spun.includes('finished')) break;
        await sleep(500);
    }
    check('a carriage return overwrites the line', spun.includes('finished') && !spun.includes('working'),
        JSON.stringify(spun));

    // The file menu, as far as a headless browser can be taken: the pickers
    // themselves are native dialogs with nothing to drive them, so what is
    // checked is that the menu opens, says what Save would do, and closes.
    await ev(`document.getElementById('images-close').click();
              document.getElementById('file-toggle').click(); true`);
    await sleep(500);

    check('the file menu opens', await ev(`!document.getElementById('file-menu').hidden`));
    check('Ctrl+S is the page\'s, not the browser\'s', await ev(`(() => {
        const e = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
        document.dispatchEvent(e);
        return e.defaultPrevented;
    })()`));

    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await sleep(300);
    check('Escape closes the file menu', await ev(`document.getElementById('file-menu').hidden`));

    // A page out of sight gives its analyser session back, and takes one again
    // when it is looked at. A headless tab is never hidden, so the page is told
    // it is: the client reads document.hidden when the event arrives.
    const setHidden = hidden => ev(`(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => ${hidden} });
        document.dispatchEvent(new Event('visibilitychange'));
        return true;
    })()`);

    const analyserState = () => ev(`document.getElementById('analyser')?.dataset.state`);

    await setHidden(true);

    let released = '';
    for (let i = 0; i < 90; i++) {
        released = await analyserState();
        if (released === 'dormant') break;
        await sleep(500);
    }
    check('a hidden page gives its analyser session back', released === 'dormant', released);

    await setHidden(false);

    let resumed = '';
    for (let i = 0; i < 90; i++) {
        resumed = await analyserState();
        if (resumed === 'ready') break;
        await sleep(500);
    }
    check('and takes one again when it is looked at', resumed === 'ready', resumed);

    // A program opened by path is fetched from its collection into the editor,
    // which exercises the path fallback, the <base> the page's own assets are
    // resolved against, and the cross-origin fetch.
    await cmd('Page.navigate', { url: new URL('/rosetta-code/hello-world-text', BASE).toString() });

    let opened = '';
    for (let i = 0; i < 120; i++) {
        opened = await ev(`globalThis.monaco?.editor.getModels()[0]?.getValue() ?? ''`);
        if (opened.includes('Hello world!')) break;
        await sleep(500);
    }
    check('a program opens by path', opened.includes('Hello world!'), JSON.stringify(opened.slice(0, 60)));

    let arrived = '';
    for (let i = 0; i < 180; i++) {
        arrived = await ev(`document.getElementById('output').innerText`) ?? '';
        if (arrived.includes('Hello world!')) break;
        await sleep(500);
    }
    check('a program opened by path runs on arrival', arrived.includes('Hello world!'), JSON.stringify(arrived.trim()));

    for (let i = 0; i < 60; i++) {
        if (await ev(`document.getElementById('run-label').textContent`) === 'Run') break;
        await sleep(500);
    }

    // The path says where the buffer came from, so editing the program leaves
    // it alone - the link still loads what it names - while replacing the
    // buffer wholesale gives it up, along with the name Save would offer.
    await ev(`monaco.editor.getModels()[0].applyEdits(
        [{ range: new monaco.Range(1, 1, 1, 1), text: '// edited\\n' }]); true`);
    await sleep(300);
    check('editing a program keeps its path',
        await ev(`location.pathname`) === '/rosetta-code/hello-world-text');

    await ev(`monaco.editor.getModels()[0].setValue('entry() is si\\n'); true`);
    await sleep(300);
    check('replacing the buffer gives up the path', await ev(`location.pathname`) === '/');

    // A program that reads files it names in playground-files. The collection
    // is served by the test rather than fetched, so this checks the playground
    // and not what the repository holds today. One file is reached through a
    // path outside the task's own directory, as a shared one would be.
    const TASKS = 'https://raw.githubusercontent.com/degory/ghul-rosetta-code/main/';
    const reader = [
        'use IO.Std.write_line;', '', 'entry() is',
        '    for line in IO.File.read_all_lines("words.txt") do',
        '        write_line("read {line}");',
        '    od', '',
        '    write_line(IO.File.read_all_text("notes.txt"));',
        '    IO.File.write_all_text("notes.txt", "changed");',
        'si', ''
    ].join('\n');

    intercepted.set(`${TASKS}tasks/reads-files/reads-files.ghul`, reader);
    intercepted.set(`${TASKS}tasks/reads-files/playground-files`, '../../data/words.txt\nnotes.txt\n');
    intercepted.set(`${TASKS}data/words.txt`, 'alpha\nbeta\n');
    intercepted.set(`${TASKS}tasks/reads-files/notes.txt`, 'from the notes');
    intercepted.set(`${TASKS}tasks/reads-files/task.json`, '{ "task": "Reads files" }');

    // The analytics counter, replaced by one that records what it is asked
    // to count, so the run events can be checked without a GoatCounter.
    const COUNTER = new URL('/stats/count.js', BASE).toString();
    intercepted.set(COUNTER,
        'window.goatcounter.count = e => (window.counted ??= []).push(e.path);');

    await cmd('Fetch.enable', { patterns: [{ urlPattern: `${TASKS}*` }, { urlPattern: COUNTER }] });
    await cmd('Page.navigate', { url: new URL('/rosetta-code/reads-files', BASE).toString() });

    let ready = false;
    for (let i = 0; i < 120; i++) {
        ready = await ev(`document.getElementById('compiler')?.dataset.state === 'ready'
            && (globalThis.monaco?.editor.getModels()[0]?.getValue() ?? '').includes('words.txt')`);
        if (ready) break;
        await sleep(500);
    }
    check('a program that reads files opens by path', ready);

    // Run twice: the program overwrites one of its inputs, and the second run
    // has to be handed the original again. The first run is the one the page
    // starts itself on arrival.
    for (const attempt of ['first', 'second']) {
        if (attempt === 'second') await ev(`document.getElementById('run').click(); true`);

        let read = '';
        for (let i = 0; i < 180; i++) {
            read = await ev(`document.getElementById('output').innerText`) ?? '';
            if (read.includes('from the notes') || read.includes('unhandled')) break;
            await sleep(500);
        }
        check(`the program reads the files it names (${attempt} run)`,
            read.includes('read alpha') && read.includes('read beta') && read.includes('from the notes'),
            JSON.stringify(read.trim()));

        for (let i = 0; i < 60; i++) {
            if (await ev(`document.getElementById('run-label').textContent`) === 'Run') break;
            await sleep(500);
        }
    }

    const about = await ev(`(() => { const a = document.getElementById('about-program');
                 return a.offsetParent !== null ? a.innerText : null; })()`);
    check('the program is named under its output', about?.startsWith('Reads files'), JSON.stringify(about));
    check('and linked to its page on ghul.dev', await ev(
        `Boolean(document.querySelector('#about-program a[href="https://ghul.dev/rosetta/reads-files"]'))`));

    const counted = await ev(`JSON.stringify(window.counted ?? [])`);
    check('the run on arrival and the one asked for are counted apart',
        counted === JSON.stringify([
            `${new URL(BASE).host}/run/automatic/rosetta-code/reads-files`,
            `${new URL(BASE).host}/run/manual/rosetta-code/reads-files`
        ]), counted);

    await cmd('Fetch.disable');

    // Cells of an interactive session: compiled by the service against the
    // cells before them, and run in the cell host frame, where a runaway cell
    // is stopped by replacing the frame. Each cell's `use` lines are written
    // out here, where a session would generate them. Skipped where the
    // service has no session cells.
    const COMPILE = process.env.COMPILE ?? (new URL(BASE).hostname === '127.0.0.1'
        ? 'http://127.0.0.1:5090'
        : new URL('.', BASE).toString().replace(/\/$/, ''));

    const health = await (await fetch(`${COMPILE}/health`)).json().catch(() => ({}));

    if (!health.repl) {
        log('skip  session cells: the compile service has none');
    } else {
        const cells = [
            // Definitions only, so there is nothing to run.
            'use default\n_helper(n: int) -> int => n + 1\nclass _HIDDEN(value: int)\n' +
                'let names = LIST[string]()\n',
            'use default\nuse cell1._helper\nuse cell1._HIDDEN\nuse cell1.names\n' +
                'names.add("second")\nwrite_line("{names.count} name")\n_helper(_HIDDEN(41).value)\n',
            'use default\nthrow System.InvalidOperationException("from cell 3")\n',
            'use default\nuse cell1.names\nnames.add("fourth")\nnames.count\n'
        ];

        const session = JSON.parse(await ev(`(async () => {
            const { CellRuntime } = await import('./cell-runtime.js');
            window.cellRuntime = new CellRuntime();
            const headers = { 'content-type': 'application/json' };
            const token = ${JSON.stringify(TOKEN ?? null)};
            if (token) headers.authorization = 'Bearer ' + token;
            window.compileCells = async chain => (await fetch(${JSON.stringify(COMPILE)} + '/compile/cell', {
                method: 'POST', headers, body: JSON.stringify({ cells: chain })
            })).json();
            const accepted = [];
            const results = [];
            for (const [index, source] of ${JSON.stringify(cells)}.entries()) {
                const cell = { name: 'cell' + (index + 1), source };
                const compiled = await compileCells([...accepted, cell]);
                if (!compiled.ok) {
                    results.push({ compiled: false, reply: compiled });
                    break;
                }
                accepted.push(cell);
                results.push(await cellRuntime.run(compiled.assembly, cell.name));
            }
            return JSON.stringify(results);
        })()`) ?? '[]');

        check('a cell of definitions only runs as nothing',
            session[0] !== undefined && session[0].text === '' && !('value' in session[0]) && !session[0].error,
            JSON.stringify(session[0]));
        check("a later cell reaches its state and underscore names",
            session[1]?.text === '1 name\n' && session[1]?.value === '42', JSON.stringify(session[1]));
        check('a cell that throws reports it',
            (session[2]?.error ?? '').includes('from cell 3'), JSON.stringify(session[2]));
        check('and the session carries on after it', session[3]?.value === '2',
            JSON.stringify(session[3]));

        // A cell that never finishes is stopped by replacing the frame: the
        // page survives, the run answers as stopped, and the next cell starts
        // a new session.
        const stopped = JSON.parse(await ev(`(async () => {
            const chain = [{ name: 'cell1', source: 'use default\\nlet spins mut = 0\\nwhile true do spins = spins + 1 od\\n' }];
            const compiled = await compileCells(chain);
            if (!compiled.ok) return JSON.stringify({ compiled: false, reply: compiled });
            const running = cellRuntime.run(compiled.assembly, 'cell1');
            await new Promise(r => setTimeout(r, 2000));
            const busy = cellRuntime.busy;
            cellRuntime.stop();
            const result = await running;
            const fresh = [{ name: 'cell1', source: 'use default\\n6 * 7\\n' }];
            const again = await compileCells(fresh);
            const after = await cellRuntime.run(again.assembly, 'cell1');
            return JSON.stringify({ busy, result, after, frames: document.querySelectorAll('iframe').length });
        })()`) ?? '{}');

        check('a runaway cell is still running until stopped', stopped.busy === true, JSON.stringify(stopped));
        check('stopping it answers as stopped', stopped.result?.stopped === true, JSON.stringify(stopped.result));
        check('and a new session runs on a fresh frame',
            stopped.after?.value === '42' && stopped.frames === 1, JSON.stringify(stopped));
        check('with the page still answering', await ev(`document.getElementById('run-label').textContent`) === 'Run');

        // The REPL page, off unless asked for.
        await cmd('Page.navigate', { url: new URL('repl.html', BASE).toString() });
        await sleep(3000);

        check('the REPL page is off without its query flag',
            await ev(`!document.getElementById('unavailable').hidden`));

        // The .NET dev host sends the cross-origin isolation headers for `/`
        // and `/_framework/` only, where nginx sends them for every page and
        // serves the compile service from the same origin. Locally, a small
        // proxy stands in for nginx, so the page reaches the service by the
        // relative path it uses in production.
        const replBase = new URL(BASE).port === '5080'
            ? `http://127.0.0.1:${(await startNginxStandIn()).address().port}/`
            : BASE;

        const replUrl = new URL('repl.html?repl', replBase).toString();

        await cmd('Page.navigate', { url: replUrl });

        for (let i = 0; i < 60; i++) {
            if (await ev(`!document.getElementById('input-row').hidden`)) break;
            await sleep(500);
        }

        const replStarted = await ev(`!document.getElementById('input-row').hidden`);

        check('the REPL page starts with its query flag', replStarted,
            await ev(`(async () => JSON.stringify({
                probe: await fetch('compile/cell').then(r => r.status).catch(e => String(e)),
                isolated: self.crossOriginIsolated,
                unavailable: !document.getElementById('unavailable').hidden,
                monaco: typeof monaco,
                status: document.getElementById('status').textContent
            }))()`));

        // Typed into the input and submitted with Shift-Enter, as a reader
        // would; answers the text of the entry it produced once the page is
        // ready for the next.
        const submit = async text => {
            const before = await ev(`document.querySelectorAll('.entry').length`);

            await ev(`(() => { const e = monaco.editor.getEditors()[0]; e.setValue(${JSON.stringify(text)}); e.focus(); return true; })()`);
            await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 });
            await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 });

            for (let i = 0; i < 240; i++) {
                const done = await ev(`document.querySelectorAll('.entry').length > ${before} &&
                    document.getElementById('status').textContent === ''`);

                if (done) break;
                await sleep(250);
            }

            return await ev(`[...document.querySelectorAll('.entry')].at(-1).querySelector('.result').innerText`);
        };

        if (replStarted) {
            const defined = await submit('let x = 41');

            // What is typed next is analysed as the next cell, against the cells
            // before it: x is only an int if the analyser has cell 1.
            await ev(`(() => { monaco.editor.getEditors()[0].setValue('let y: string = x'); return true; })()`);

            let analysed = '[]';

            for (let i = 0; i < 120; i++) {
                analysed = await ev(`JSON.stringify(monaco.editor.getModelMarkers({ owner: 'ghul-analyse' }).map(m => m.message))`);
                if (analysed?.includes('not assignable')) break;
                await sleep(250);
            }

            check('the input is analysed against the cells before it',
                analysed.includes('not assignable') && !analysed.includes('not defined'), analysed);
            const used = await submit('x + 1');
            const redefined = await submit('let x = "forty-one"');
            const reread = await submit('x');
            const failed = await submit('let y: int = "s"');
            const after = await submit('x.length');

            check('the REPL page accepts a definition', defined === '', JSON.stringify(defined));
            check('a later cell uses it and shows its value', used === '42', JSON.stringify(used));
            check('a redefinition replaces it going forward',
                redefined === '' && reread.includes('forty-one'), JSON.stringify([redefined, reread]));
            check('a cell with an error shows the error', failed.includes('not assignable'), JSON.stringify(failed));
            check('and the session carries on after it', after === '9', JSON.stringify(after));
            check('the prompt numbers every submission, as the terminal does',
                await ev(`document.getElementById('prompt').textContent`) === '[7]',
                await ev(`document.getElementById('prompt').textContent`));
        }
    }

    log(failures ? `${failures} failure(s)` : 'all checks passed');
    process.exit(failures ? 1 : 0);
})();

// What nginx does for the REPL page in production, and the .NET dev host does
// not: the cross-origin isolation headers on every response, and the compile
// and analyse services at `/compile` and `/analyse` on the same origin.
function startNginxStandIn() {
    const http = require('http');

    const server = http.createServer((request, response) => {
        const port = request.url.startsWith('/compile') ? 5090 : 5080;

        const upstream = http.request({
            host: '127.0.0.1',
            port,
            path: request.url,
            method: request.method,
            headers: { ...request.headers, host: `127.0.0.1:${port}` }
        }, answer => {
            response.writeHead(answer.statusCode, {
                ...answer.headers,
                'cross-origin-opener-policy': 'same-origin',
                'cross-origin-embedder-policy': 'require-corp'
            });

            answer.pipe(response);
        });

        upstream.on('error', () => response.writeHead(502).end());
        request.pipe(upstream);
    });

    // The analyser's WebSocket: the upgrade request is passed on as it came,
    // and from then on the two sockets are joined.
    server.on('upgrade', (request, socket, head) => {
        const upstream = require('net').connect(5091, '127.0.0.1', () => {
            const headers = Object.entries(request.headers)
                .map(([name, value]) => `${name}: ${name === 'host' ? '127.0.0.1:5091' : value}`)
                .join('\r\n');

            upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
            upstream.write(head);
            upstream.pipe(socket);
            socket.pipe(upstream);
        });

        upstream.on('error', () => socket.destroy());
        socket.on('error', () => upstream.destroy());
    });

    server.unref();

    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}
