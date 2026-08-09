// Compile service for the ghūl playground.
//
// SECURITY: run this in the container. It runs the ghūl compiler on whatever it
// is posted, and its own limits - a source size cap, a compile timeout and a
// cap on how many compile at once - bound what one request costs, not what the
// compiler can reach. The container is what does that.
//
//   POST /compile  {"source": "..."}
//     -> {"ok": bool, "diagnostics": [...], "assembly": "<base64>"|null}
//
// The assembly is returned to the browser, which runs it. The service never
// executes what it compiles.

const http = require('http');
const { execFile } = require('child_process');
const { mkdtemp, writeFile, readFile, rm } = require('fs/promises');
const { tmpdir } = require('os');
const path = require('path');

const { resolveCompiler, resolveReferencePaths } = require('../shared/toolchain');
const origins = require('../shared/origins');
const tokens = require('../shared/tokens');

const PORT = Number(process.env.PORT ?? 5090);
const HOST = process.env.HOST ?? '127.0.0.1';

const MAX_SOURCE_BYTES = 256 * 1024;
const COMPILE_TIMEOUT_MS = Number(process.env.COMPILE_TIMEOUT_MS ?? 10000);

// A compile costs about a CPU-second and peaks near 200 MB, so the number that
// may run at once is the service's real resource limit. Without one, enough
// simultaneous requests drive the container into its memory cap, the kernel
// kills compilers, and every request in flight fails: measured, thirty at once
// was enough. A queue turns that into waiting, which is a far better failure.
//
// The queue is deliberately short. Past its end the honest answer is that the
// service is busy, not a request that waits a minute and then times out.
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_COMPILES ?? 2);
const MAX_QUEUED = Number(process.env.MAX_QUEUED_COMPILES ?? 6);

// `file: LINE,COL..LINE,COL: severity: message`
const DIAGNOSTIC = /^(.*?):\s*(\d+),(\d+)\.\.(\d+),(\d+):\s*(error|warn|info|hint):\s*(.*)$/;

let toolchain = null;

async function getToolchain() {
    if (!toolchain) {
        const [compiler, references] = await Promise.all([
            resolveCompiler(), resolveReferencePaths()
        ]);

        toolchain = { compiler, references };

        console.log(`compiler:   ${compiler}`);
        console.log(`references: ${references.length}`);
    }

    return toolchain;
}

function parseDiagnostics(text) {
    const diagnostics = [];

    for (const line of text.split('\n')) {
        const m = DIAGNOSTIC.exec(line.trim());

        if (m) {
            diagnostics.push({
                startLine: +m[2], startColumn: +m[3],
                endLine: +m[4], endColumn: +m[5],
                severity: m[6],
                message: m[7]
            });
        }
    }

    return diagnostics;
}

function runCompiler(args, cwd) {
    return new Promise(resolve => {
        execFile('dotnet', args, { cwd, timeout: COMPILE_TIMEOUT_MS, maxBuffer: 4 << 20 },
            (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    });
}

// --- the concurrency gate -------------------------------------------------

class Busy extends Error { }

let running = 0;
const queue = [];

function acquireSlot() {
    if (running < MAX_CONCURRENT) {
        running++;
        return Promise.resolve();
    }

    if (queue.length >= MAX_QUEUED) {
        return Promise.reject(new Busy());
    }

    return new Promise(resolve => queue.push(resolve));
}

function releaseSlot() {
    // Hand the slot straight to whoever is next rather than releasing and
    // reacquiring it, so `running` stays accurate with no window in between.
    const next = queue.shift();

    if (next) {
        next();
        return;
    }

    running--;
}

async function withSlot(work) {
    await acquireSlot();

    try {
        return await work();
    } finally {
        releaseSlot();
    }
}

async function compile(source) {
    const { compiler, references } = await getToolchain();
    const directory = await mkdtemp(path.join(tmpdir(), 'ghul-playground-'));

    try {
        await writeFile(path.join(directory, 'main.ghul'), source, 'utf8');

        const args = [compiler];

        for (const reference of references) {
            args.push('-a', reference);
        }

        args.push(path.join(directory, 'main.ghul'));

        const { error, stdout, stderr } = await runCompiler(args, directory);
        const diagnostics = parseDiagnostics(`${stderr}\n${stdout}`);

        if (error) {
            // A timeout kills the compiler without it reporting anything, so
            // say so rather than returning an empty, puzzling failure.
            if (error.killed && !diagnostics.length) {
                diagnostics.push({
                    startLine: 1, startColumn: 1, endLine: 1, endColumn: 1,
                    severity: 'error',
                    message: `compilation timed out after ${COMPILE_TIMEOUT_MS} ms`
                });
            }

            return { ok: false, diagnostics, assembly: null };
        }

        const assembly = (await readFile(path.join(directory, 'main.exe'))).toString('base64');

        return { ok: true, diagnostics, assembly };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

// A compile of a fixed program, so a broken toolchain shows as unhealthy
// rather than as failing user requests. Cached, because the container checks
// every thirty seconds and a compile costs about a CPU-second.
const HEALTH_SOURCE = 'use IO.Std.write_line;\n\nentry() is\n    write_line("ok");\nsi\n';
const HEALTH_CACHE_MS = 60000;

let health = { at: 0, ok: false, error: 'not checked yet' };

async function checkHealth() {
    if (Date.now() - health.at < HEALTH_CACHE_MS) return health;

    try {
        // Through the gate like any other compile, so the check cannot add load
        // to an already saturated service, and so saturation is reported rather
        // than hidden.
        const result = await withSlot(() => compile(HEALTH_SOURCE));

        health = { at: Date.now(), ok: result.ok, error: result.ok ? null : 'compile failed' };
    } catch (e) {
        health = {
            at: Date.now(),
            ok: false,
            error: e instanceof Busy ? 'busy' : String(e)
        };
    }

    return health;
}

http.createServer((request, response) => {
    const allowed = origins.allowOriginHeader(request.headers.origin);

    if (allowed) {
        response.setHeader('Access-Control-Allow-Origin', allowed);
        response.setHeader('Vary', 'Origin');
    }

    response.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');

    if (request.method === 'OPTIONS') {
        response.writeHead(204).end();
        return;
    }

    // Deliberately unauthenticated, and deliberately before the token check:
    // the container's own health check has no token to present, and gating
    // this behind one made the service permanently unhealthy while it was in
    // fact working.
    //
    // Answers to every origin whatever the list says, because deciding whether
    // to offer editing at all is exactly what a page does before it knows it is
    // welcome, and the answer discloses nothing but a session count.
    if (request.method === 'GET' && request.url.startsWith('/health')) {
        response.setHeader('Access-Control-Allow-Origin', '*');
        checkHealth().then(state => {
            response.writeHead(state.ok ? 200 : 503, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ ok: state.ok, error: state.error ?? undefined }));
        });
        return;
    }

    if (request.method !== 'POST' || !request.url.startsWith('/compile')) {
        response.writeHead(404).end('not found');
        return;
    }

    if (!origins.accepts(request.headers.origin)) {
        response.writeHead(403, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: 'origin not allowed' }));
        return;
    }

    // 401 rather than 403, and a distinguishable body, so the front end can
    // say the token is wrong instead of showing a bare failure.
    if (!tokens.accepts(tokens.fromAuthorizationHeader(request.headers.authorization))) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: 'invalid or missing access token' }));
        return;
    }

    let body = '';
    let aborted = false;

    // Whether the client is still there to receive an answer. The request
    // stream cannot say: it is auto-destroyed once it has been read to the end,
    // so a completed upload looks exactly like an abandoned one. The response
    // closing before it has been written is the signal that means what it says.
    let clientGone = false;

    response.on('close', () => { clientGone = !response.writableEnded; });

    request.on('data', chunk => {
        body += chunk;

        if (body.length > MAX_SOURCE_BYTES) {
            aborted = true;
            response.writeHead(413, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ ok: false, diagnostics: [], assembly: null }));
            request.destroy();
        }
    });

    request.on('end', async () => {
        if (aborted) return;

        try {
            const source = JSON.parse(body).source ?? '';

            const result = await withSlot(() => {
                // The wait may have outlasted the client. Compiling for a
                // socket that has gone would spend a slot on nobody.
                if (clientGone) return null;

                return compile(source);
            });

            if (result === null) return;

            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(result));
        } catch (e) {
            if (e instanceof Busy) {
                response.writeHead(503, {
                    'content-type': 'application/json',
                    'retry-after': '5'
                });
                response.end(JSON.stringify({
                    ok: false, diagnostics: [], assembly: null,
                    error: 'the compile service is busy; try again in a moment'
                }));
                return;
            }

            console.error(e);

            response.writeHead(500, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                ok: false, diagnostics: [], assembly: null, error: String(e)
            }));
        }
    });
}).listen(PORT, HOST, () => {
    console.log(`compile service on http://${HOST}:${PORT}`);
    console.log(`at most ${MAX_CONCURRENT} compile(s) at once, ${MAX_QUEUED} queued, ` +
        `${COMPILE_TIMEOUT_MS} ms each`);
    console.log(tokens.describe());
    console.log(origins.describe());
});
