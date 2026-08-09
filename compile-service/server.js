// Compile service for the ghūl playground.
//
// SECURITY: this is a prototype. It runs the ghūl compiler on whatever source
// it is posted, as whatever user it runs as, with no sandbox, no resource
// limit and no rate limit. Bind it to localhost and do not expose it. See
// "Before this is exposed to anyone" in the README.
//
//   POST /compile  {"source": "..."}
//     -> {"ok": bool, "diagnostics": [...], "assembly": "<base64>"|null}
//
// The assembly is returned to the browser, which runs it. The service never
// executes what it compiles.

const http = require('http');
const { execFile } = require('child_process');
const { mkdtemp, writeFile, readFile, rm, readdir } = require('fs/promises');
const { existsSync } = require('fs');
const { tmpdir } = require('os');
const path = require('path');

const PORT = Number(process.env.PORT ?? 5090);
const HOST = process.env.HOST ?? '127.0.0.1';

// Source larger than this is rejected before the compiler is started.
const MAX_SOURCE_BYTES = 256 * 1024;
const COMPILE_TIMEOUT_MS = 30000;

// The reference set user code is compiled against. Deliberately small: it is
// the capability surface a program can name.
//
// Note this does NOT deny filesystem access. `System.Runtime` type-forwards
// the `System.IO` surface and cannot be dropped, so `IO.File.read_all_text`
// compiles whatever is listed here. That is only safe because the compiled
// assembly runs in the browser, where there is no host filesystem for it to
// reach.
const REFERENCES = [
    'System.Runtime',
    'System.Console',
    'System.Collections',
    'System.Linq',
    'System.Runtime.Extensions',
    'netstandard',
    'System.Text.RegularExpressions',
    'System.Threading.Tasks',
    'System.Memory'
];

// `file: LINE,COL..LINE,COL: severity: message`
const DIAGNOSTIC = /^(.*?):\s*(\d+),(\d+)\.\.(\d+),(\d+):\s*(error|warn|info|hint):\s*(.*)$/;

function highestVersion(versions) {
    const key = v => v.split(/[.-]/).map(p => (/^\d+$/.test(p) ? +p : -1));

    return versions.sort((a, b) => {
        const [x, y] = [key(a), key(b)];
        for (let i = 0; i < Math.max(x.length, y.length); i++) {
            if ((x[i] ?? -1) !== (y[i] ?? -1)) return (x[i] ?? -1) - (y[i] ?? -1);
        }
        return 0;
    }).pop();
}

async function resolveCompiler() {
    if (process.env.GHUL_COMPILER_DLL) {
        return process.env.GHUL_COMPILER_DLL;
    }

    const packages = path.join(process.env.HOME, '.nuget', 'packages', 'ghul.compiler');
    const version = highestVersion(await readdir(packages));

    return path.join(packages, version, 'tools', 'net10.0', 'any', 'ghul.dll');
}

async function resolveReferencePack() {
    if (process.env.GHUL_REFERENCE_PACK) {
        return process.env.GHUL_REFERENCE_PACK;
    }

    for (const root of ['/usr/lib/dotnet', '/usr/share/dotnet', process.env.DOTNET_ROOT]) {
        if (!root) continue;

        const packs = path.join(root, 'packs', 'Microsoft.NETCore.App.Ref');
        if (!existsSync(packs)) continue;

        const version = highestVersion(await readdir(packs));

        return path.join(packs, version, 'ref', 'net10.0');
    }

    throw new Error('could not find Microsoft.NETCore.App.Ref; set GHUL_REFERENCE_PACK');
}

// Must be the runtime the web app ships, not the copy bundled with the
// compiler: user code is compiled against this and then bound against
// whatever the browser loaded, so a mismatch fails at load time rather than
// at compile time.
async function resolveRuntime() {
    if (process.env.GHUL_RUNTIME_DLL) {
        return process.env.GHUL_RUNTIME_DLL;
    }

    const packages = path.join(process.env.HOME, '.nuget', 'packages', 'ghul.runtime');
    const version = highestVersion(await readdir(packages));

    return path.join(packages, version, 'lib', 'net10.0', 'ghul-runtime.dll');
}

let toolchain = null;

async function getToolchain() {
    if (!toolchain) {
        const [compiler, referencePack, runtime] = await Promise.all([
            resolveCompiler(), resolveReferencePack(), resolveRuntime()
        ]);

        toolchain = { compiler, referencePack, runtime };

        console.log(`compiler:       ${compiler}`);
        console.log(`runtime:        ${runtime}`);
        console.log(`reference pack: ${referencePack}`);
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
    const { compiler, referencePack, runtime } = await getToolchain();
    const directory = await mkdtemp(path.join(tmpdir(), 'ghul-playground-'));

    try {
        await writeFile(path.join(directory, 'main.ghul'), source, 'utf8');

        const args = [compiler, '-a', runtime];

        for (const reference of REFERENCES) {
            args.push('-a', path.join(referencePack, `${reference}.dll`));
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
