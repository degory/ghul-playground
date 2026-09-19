// The compile service's cells of an interactive session: does it compile a
// cell against the ones before it, reuse what it has built, refuse what it
// should, and never hand one chain's assembly to another?
//
//   node test/cell-cache.js
//
// Starts its own compile services, on ports 5186-5188, so it needs the
// compiler the service resolves for itself (GHUL_COMPILER_DLL, or the one the
// repository's tool manifest installs). Exits non-zero if any check fails.

const { spawn } = require('child_process');
const { mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const path = require('path');

const log = m => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;

function check(what, ok, detail = '') {
    if (!ok) failures++;
    log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  ${detail}` : ''}`);
}

const cacheDirectory = mkdtempSync(path.join(tmpdir(), 'ghul-cell-cache-test-'));
const services = [];

async function startService(port, env) {
    const service = spawn('node', [path.join(__dirname, '..', 'compile-service', 'server.js')], {
        env: { ...process.env, PORT: String(port), ...env },
        stdio: ['ignore', 'ignore', 'inherit']
    });

    services.push(service);

    for (let i = 0; i < 60; i++) {
        try {
            await fetch(`http://127.0.0.1:${port}/`);
            return service;
        } catch { /* not listening yet */ }

        await sleep(250);
    }

    throw new Error(`the service on ${port} never started`);
}

async function post(port, body) {
    const response = await fetch(`http://127.0.0.1:${port}/compile/cell`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body)
    });

    const text = await response.text();

    let reply;
    try { reply = JSON.parse(text); } catch { reply = { raw: text }; }

    return { status: response.status, reply };
}

const errors = reply => JSON.stringify(reply.diagnostics ?? reply.error ?? reply.raw);

const ENABLED = {
    REPL_ENABLED: '1',
    CELL_CACHE_DIR: cacheDirectory,
    MAX_CELLS: '4',
    MAX_CHAIN_BYTES: '4096'
};

(async () => {
    try {
        // Off unless enabled: the endpoint is absent, not refused.
        await startService(5186, {});

        const disabled = await post(5186, { cells: [{ name: 'cell1', source: '1' }] });

        check('with REPL_ENABLED unset the endpoint does not exist', disabled.status === 404,
            String(disabled.status));

        const disabledProbe = await fetch(`http://127.0.0.1:5186/compile/cell`);

        check('and asking whether sessions are on answers that they are not', disabledProbe.status === 404,
            String(disabledProbe.status));

        await startService(5187, ENABLED);

        const probe = await fetch(`http://127.0.0.1:5187/compile/cell`);
        const probed = probe.ok ? await probe.json() : null;

        check('with it set, asking answers the limits', probed?.maxCells === Number(ENABLED.MAX_CELLS),
            JSON.stringify(probed));

        const one = { name: 'cell1', source: 'use default\nlet x = 41\n' };
        const two = { name: 'cell2', source: 'use default\nuse cell1.x\nx + 1\n' };

        const first = await post(5187, { cells: [one] });

        check('a first cell compiles', first.status === 200 && first.reply.ok && first.reply.assembly,
            errors(first.reply));

        const second = await post(5187, { cells: [one, two] });

        check('a later cell compiles against it', second.status === 200 && second.reply.ok,
            errors(second.reply));
        check('and the earlier cell comes from the cache',
            JSON.stringify(second.reply.recompiled) === '[]', JSON.stringify(second.reply.recompiled));

        // The same names over different sources are a different chain: its
        // cell1 has no `x`, so cell2 can only compile if it were handed the
        // first chain's cell1.
        const other = { name: 'cell1', source: 'use default\nlet y = 1\n' };
        const crossed = await post(5187, { cells: [other, two] });

        check('another chain under the same names is compiled for itself',
            crossed.status === 409 || (crossed.status === 200 && !crossed.reply.ok),
            `${crossed.status} ${errors(crossed.reply)}`);

        // A key or an assembly in the request is not read: the cell2 here
        // uses `y`, which only this chain's cell1 declares, so it compiles
        // only against the cell1 built from these sources.
        const forged = await post(5187, {
            keys: ['0'.repeat(64)],
            cells: [
                { ...other, key: second.reply.keys?.[0] ?? 'x', assembly: first.reply.assembly },
                { name: 'cell2', source: 'use default\nuse cell1.y\ny + 1\n' }
            ]
        });

        check('a key or assembly the request supplies is ignored',
            forged.status === 200 && forged.reply.ok,
            `${forged.status} ${JSON.stringify(forged.reply.recompiled)} ${errors(forged.reply)}`);

        // A cell that failed is never cached, so a chain claiming it was
        // accepted cannot be built on.
        const bad = { name: 'cell1', source: 'use default\nlet z: int = "s"\n' };
        const failed = await post(5187, { cells: [bad] });

        check('a cell with an error fails', failed.status === 200 && !failed.reply.ok,
            errors(failed.reply));

        const onBad = await post(5187, { cells: [bad, { name: 'cell2', source: '1\n' }] });

        check('and a chain that includes it as accepted is refused', onBad.status === 409,
            `${onBad.status} ${errors(onBad.reply)}`);

        // Limits, checked before anything is compiled.
        const tooMany = await post(5187, {
            cells: [1, 2, 3, 4, 5].map(n => ({ name: `cell${n}`, source: '1\n' }))
        });

        check('more cells than the limit is refused', tooMany.status === 413, String(tooMany.status));

        const tooBig = await post(5187, { cells: [{ name: 'cell1', source: 'x'.repeat(5000) }] });

        check('more source than the limit is refused', tooBig.status === 413, String(tooBig.status));

        const badName = await post(5187, { cells: [{ name: '../x', source: '1\n' }] });

        check('a name that is not cellN is refused', badName.status === 400, String(badName.status));

        const unordered = await post(5187, { cells: [two, one] });

        check('cells out of order are refused', unordered.status === 400, String(unordered.status));

        // A toolchain change keys every cell afresh: the same chain is compiled
        // again rather than reusing assemblies built by another compiler.
        await startService(5188, { ...ENABLED, CELL_TOOLCHAIN_SALT: 'another toolchain' });

        const afterUpgrade = await post(5188, { cells: [one, two] });

        check('a changed toolchain compiles the earlier cells again',
            afterUpgrade.status === 200 && afterUpgrade.reply.ok &&
                JSON.stringify(afterUpgrade.reply.recompiled) === '["cell1"]',
            `${afterUpgrade.status} ${JSON.stringify(afterUpgrade.reply.recompiled)}`);

        // Many at once: the gate holds, and nothing fails for a reason other
        // than being busy.
        const burst = await Promise.all(Array.from({ length: 16 }, (_, n) => post(5187, {
            cells: [one, { name: 'cell2', source: `use default\nuse cell1.x\nx + ${n}\n` }]
        })));

        const statuses = burst.map(r => r.status);

        check('a burst is served or refused as busy, never failed',
            statuses.every(s => s === 200 || s === 503) && statuses.includes(200),
            statuses.join(','));
    } catch (e) {
        failures++;
        log(`FAIL  ${e.stack ?? e}`);
    } finally {
        for (const service of services) service.kill();
        rmSync(cacheDirectory, { recursive: true, force: true });
    }

    log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
})();
