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

const { spawn } = require('child_process');

const CHROME = process.env.CHROME
    ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1140/chrome-linux/chrome`;

const BASE = process.env.BASE ?? 'http://127.0.0.1:5080/';
const TOKEN = process.env.TOKEN;
const PORT = Number(process.env.CDP_PORT ?? 9321);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

let failures = 0;

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

    ws.addEventListener('message', e => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
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

    chrome.kill();

    log(failures ? `${failures} failure(s)` : 'all checks passed');
    process.exit(failures ? 1 : 0);
})();
