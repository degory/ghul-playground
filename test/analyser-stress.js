// Can broken source make the analyser stop answering?
//
// The answer, as of 2026-08-09, is no: every case below is answered in
// single-digit milliseconds and the socket never drops. Kept because the
// question recurs whenever the editor appears to hang, and because the usual
// cause is something else entirely - restarting the analyse container kills
// every session, and the client's reconnect backs off for up to a minute.
//
//   node test/analyser-stress.js
//   ANALYSE_URL=wss://playground.ghul.dev/analyse TOKEN=... node test/analyser-stress.js
//
// Exits non-zero if any request goes unanswered or the socket closes.

const URL_ = process.env.ANALYSE_URL || 'ws://127.0.0.1:5091/analyse';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

const NL = String.fromCharCode(10);
const QUOTE = String.fromCharCode(34);

const line = (...parts) => parts.join('');

const BREAKAGE = [
    ['valid', line('use IO.Std.write_line;', NL, NL, 'entry() is', NL,
        '    write_line(', QUOTE, 'ok', QUOTE, ');', NL, 'si', NL)],
    ['unterminated string', line('entry() is', NL,
        '    write_line(', QUOTE, 'oops);', NL, 'si', NL)],
    ['unclosed block', line('entry() is', NL, '    write_line(', QUOTE, 'x', QUOTE, ');', NL)],
    ['stray si', line('si si si', NL)],
    ['unbalanced parens', line('entry() is', NL,
        '    write_line(((((((', QUOTE, 'x', QUOTE, ');', NL, 'si', NL)],
    ['unclosed interpolation', line('entry() is', NL,
        '    write_line(', QUOTE, '{1 + ', QUOTE, ');', NL, 'si', NL)],
    ['garbage', line('  !!! ??? }}} <<< >>>', NL)],
    ['very long line', line('entry() is', NL, '    let x = ', QUOTE,
        'a'.repeat(40000), QUOTE, ';', NL, 'si', NL)],
    ['deep nesting', line('entry() is', NL,
        '    if true then'.concat(NL).repeat(300),
        '    fi'.concat(NL).repeat(300), 'si', NL)],
    ['empty', ''],
    ['valid again', line('use IO.Std.write_line;', NL, NL, 'entry() is', NL,
        '    write_line(', QUOTE, 'still here', QUOTE, ');', NL, 'si', NL)]
];

const protocols = ['ghul-playground'];
if (process.env.TOKEN) protocols.push('ghul-playground-token.' + process.env.TOKEN);

const ws = new WebSocket(URL_, protocols);

const pending = new Map();
let id = 0;
let diags = [];
let unanswered = 0;

ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'textDocument/publishDiagnostics') diags.push(m.params);
});

ws.addEventListener('close', e => {
    log(`SOCKET CLOSED: ${e.code} ${e.reason}`);
    process.exit(1);
});

const send = (m, p, n) => {
    const o = { jsonrpc: '2.0', method: m, params: p };
    if (!n) o.id = ++id;
    ws.send(JSON.stringify(o));
    return o.id;
};

const req = (m, p, timeout = 15000) => new Promise(r => {
    const i = send(m, p);
    pending.set(i, r);
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); r(null); } }, timeout);
});

(async () => {
    await new Promise(r => ws.addEventListener('open', r));

    const root = 'file:///playground';
    const uri = root + '/src/main.ghul';

    await req('initialize', {
        processId: null, rootUri: root,
        workspaceFolders: [{ uri: root, name: 'p' }],
        capabilities: { textDocument: { publishDiagnostics: {}, hover: {}, completion: {} } }
    });

    send('initialized', {}, true);
    send('textDocument/didOpen', {
        textDocument: { uri, languageId: 'ghul', version: 1, text: BREAKAGE[0][1] }
    }, true);

    await sleep(3000);

    let version = 1;

    for (const [name, text] of BREAKAGE) {
        diags = [];

        send('textDocument/didChange', {
            textDocument: { uri, version: ++version },
            contentChanges: [{ text }]
        }, true);

        await sleep(2500);

        const started = Date.now();
        const hover = await req('textDocument/hover', {
            textDocument: { uri }, position: { line: 2, character: 4 }
        });

        if (!hover) unanswered++;

        log(`${name.padEnd(24)} hover ${hover ? 'answered' : 'NO ANSWER'} ` +
            `in ${Date.now() - started}ms, ` +
            `${diags.flatMap(d => d.diagnostics ?? []).length} diagnostic(s)`);
    }

    const final = await req('textDocument/completion', {
        textDocument: { uri }, position: { line: 3, character: 4 }
    });

    if (!final) unanswered++;

    log('completion after all that: ' + (final ? 'answered' : 'NO ANSWER'));

    ws.close();

    log(unanswered ? `${unanswered} request(s) unanswered` : 'the analyser answered everything');
    process.exit(unanswered ? 1 : 0);
})();
