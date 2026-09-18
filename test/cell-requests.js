// Does the compile service compile the cells of an interactive session, and
// turn away the requests for one that it should?
//
// Run against a compile service started with small reference limits, so the
// limits can be reached with a handful of real cells:
//
//   MAX_REFERENCES=2 MAX_REFERENCE_BYTES=8192 PORT=5096 node compile-service/server.js &
//   COMPILE_URL=http://127.0.0.1:5096/compile node test/cell-requests.js
//
// Exits non-zero if any check fails.

const URL_ = process.env.COMPILE_URL ?? 'http://127.0.0.1:5096/compile';

const log = m => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

let failures = 0;

function check(what, ok, detail = '') {
    if (!ok) failures++;
    log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  ${detail}` : ''}`);
}

async function post(body) {
    const response = await fetch(URL_, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body)
    });

    return { status: response.status, reply: await response.json() };
}

(async () => {
    const first = await post({
        source: 'use default\nlet names mut = LIST[string]()\nnames.add("first")\n',
        submission: 'cell1'
    });

    check('a first cell compiles', first.status === 200 && first.reply.ok,
        JSON.stringify(first.reply.diagnostics ?? first.reply.error));

    const earlier = [{ submission: 'cell1', assembly: first.reply.assembly }];

    const second = await post({
        source: 'use default\nuse cell1.names\nnames.add("second")\nnames.count\n',
        submission: 'cell2',
        references: earlier
    });

    check('a later cell compiles against it', second.status === 200 && second.reply.ok,
        JSON.stringify(second.reply.diagnostics ?? second.reply.error));

    const unreferenced = await post({
        source: 'use default\nuse cell1.names\nnames.count\n',
        submission: 'cell2'
    });

    check('and cannot without it',
        unreferenced.status === 200 && !unreferenced.reply.ok &&
            unreferenced.reply.diagnostics.some(d => d.severity === 'error'));

    for (const name of ['1cell', 'cell-1', '../cell', '', 'x'.repeat(65), 7]) {
        const { status } = await post({ source: '', submission: name });

        check(`submission ${JSON.stringify(name)} is refused`, status === 400, String(status));
    }

    const loose = await post({ source: '', references: earlier });
    check('references without a submission are refused', loose.status === 400, String(loose.status));

    const unnamed = await post({ source: '', submission: 'cell2', references: [first.reply.assembly] });
    check('a reference without its submission is refused', unnamed.status === 400,
        String(unnamed.status));

    const twice = await post({
        source: '', submission: 'cell2', references: [...earlier, ...earlier]
    });
    check('a submission named twice is refused', twice.status === 400, String(twice.status));

    const itself = await post({ source: '', submission: 'cell1', references: earlier });
    check('a reference named as the cell itself is refused', itself.status === 400,
        String(itself.status));

    const garbled = await post({
        source: '', submission: 'cell2',
        references: [{ submission: 'cell1', assembly: 'not base64!' }]
    });
    check('a reference that is not base64 is refused', garbled.status === 400,
        String(garbled.status));

    // The service under test allows two references.
    const many = await post({
        source: '', submission: 'cell4',
        references: ['cell1', 'cell2', 'cell3'].map(submission =>
            ({ submission, assembly: first.reply.assembly }))
    });
    check('more earlier cells than the limit are refused', many.status === 413,
        String(many.status));

    // And 8 KB of them, where one cell weighs about 3 KB.
    const padding = Buffer.alloc(6 * 1024).toString('base64');

    const heavy = await post({
        source: '', submission: 'cell3',
        references: [earlier[0], { submission: 'cell2', assembly: padding }]
    });
    check('more bytes of earlier cells than the limit are refused', heavy.status === 413,
        String(heavy.status));

    const whole = await post({
        source: 'use IO.Std.write_line;\n\nentry() is\n    write_line("hello");\nsi\n'
    });
    check('a whole program still compiles as before', whole.status === 200 && whole.reply.ok);

    log(failures ? `${failures} failure(s)` : 'all checks passed');
    process.exit(failures ? 1 : 0);
})();
