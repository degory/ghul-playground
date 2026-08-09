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
        if (await ev(`document.getElementById('status')?.innerText === 'ready'`)) break;
        await sleep(500);
    }
    check('the runtime and editor load',
        await ev(`document.getElementById('status')?.innerText === 'ready'`));

    for (let i = 0; i < 90; i++) {
        if (await ev(`document.getElementById('analyser-status')?.dataset.state === 'ready'`)) break;
        await sleep(500);
    }
    check('the analyser connects',
        await ev(`document.getElementById('analyser-status')?.dataset.state === 'ready'`),
        await ev(`document.getElementById('analyser-status')?.innerText`));

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
            'use IO.Std.write_line;\\n\\nentry() is\\n    write_line("it ran");\\nsi\\n');
        return true;
    })()`);
    await sleep(1000);
    await ev(`document.getElementById('run').click(); true`);

    let output = '';
    for (let i = 0; i < 180; i++) {
        output = await ev(`document.getElementById('output').innerText`);
        if (output && output.trim()) break;
        await sleep(500);
    }
    check('the program compiles and runs', output.includes('it ran'), JSON.stringify(output.trim()));

    chrome.kill();

    log(failures ? `${failures} failure(s)` : 'all checks passed');
    process.exit(failures ? 1 : 0);
})();
