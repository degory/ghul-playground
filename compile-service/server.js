// Compile service for the ghūl playground.
//
// SECURITY: run this in the container. Outside it there is no sandbox and no
// resource limit beyond a source size cap and a compile timeout, and it runs
// the ghūl compiler on whatever it is posted.
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

const PORT = Number(process.env.PORT ?? 5090);
const HOST = process.env.HOST ?? '127.0.0.1';

const MAX_SOURCE_BYTES = 256 * 1024;
const COMPILE_TIMEOUT_MS = 30000;

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

http.createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'content-type');

    if (request.method === 'OPTIONS') {
        response.writeHead(204).end();
        return;
    }

    if (request.method !== 'POST' || !request.url.startsWith('/compile')) {
        response.writeHead(404).end('not found');
        return;
    }

    let body = '';
    let aborted = false;

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
            const result = await compile(JSON.parse(body).source ?? '');

            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(result));
        } catch (e) {
            console.error(e);

            response.writeHead(500, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                ok: false, diagnostics: [], assembly: null, error: String(e)
            }));
        }
    });
}).listen(PORT, HOST, () => console.log(`compile service on http://${HOST}:${PORT}`));
