// The cells of an interactive session.
//
// The page holds the session. Each request carries the source of every cell
// the session has accepted, in order, and the new cell last; only source
// crosses the wire, exactly as for a whole program. The reply is the new
// cell's assembly, which the page runs. The service never executes it.
//
// A cell compiles against the assemblies of the cells before it, so the
// service keeps the assemblies it has built in a cache, keyed by a hash it
// computes itself over the toolchain and the ordered chain of cells up to and
// including that one. A cell's assembly depends on everything before it - the
// names earlier cells declared, and the imports generated from them - so
// nothing shorter than the whole chain identifies it. A request never names a
// key: what can be looked up is decided by the sources it posts, and anything
// the cache holds under a key was compiled by this service from exactly the
// sources that hash to it. Only a cell that compiled is cached.
//
// A request whose earlier cells are all cached compiles one cell. Any cell
// missing - evicted, or never seen by this service - is compiled again, in
// order, in the same compiler process, before the new one.

const crypto = require('crypto');
const { spawn } = require('child_process');
const { createReadStream } = require('fs');
const fs = require('fs/promises');
const path = require('path');
const readline = require('readline');

class BadRequest extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

// A cell's name is its namespace and the name of its assembly and file, so it
// is held to what is safe as all three. The page numbers cells as it accepts
// them, and a number can be skipped by a cell that failed.
const NAME = /^cell[1-9][0-9]{0,3}$/;

function parseCellRequest(body, { maxCells, maxChainBytes }) {
    let request;

    try {
        request = JSON.parse(body);
    } catch {
        throw new BadRequest(400, 'the request is not JSON');
    }

    const cells = request?.cells;

    if (!Array.isArray(cells) || cells.length === 0) {
        throw new BadRequest(400, 'cells must be a non-empty array');
    }

    if (cells.length > maxCells) {
        throw new BadRequest(413, `a session here is limited to ${maxCells} cells`);
    }

    const result = [];
    let bytes = 0;
    let previous = 0;

    for (const cell of cells) {
        const name = cell?.name;
        const source = cell?.source;

        if (typeof name !== 'string' || !NAME.test(name)) {
            throw new BadRequest(400, 'each cell must be named cell1, cell2 and so on');
        }

        const number = Number(name.slice(4));

        if (number <= previous) {
            throw new BadRequest(400, 'cells must be in the order they were accepted');
        }

        previous = number;

        if (typeof source !== 'string') {
            throw new BadRequest(400, 'each cell must carry its source as a string');
        }

        bytes += Buffer.byteLength(source, 'utf8');

        if (bytes > maxChainBytes) {
            throw new BadRequest(413,
                `a session here is limited to ${Math.floor(maxChainBytes / 1024)} KB of source`);
        }

        result.push({ name, source });
    }

    return result;
}

// One key per cell: each folds the one before it, so a key identifies the
// whole chain up to its cell. Lengths go in ahead of the text so no two
// different chains can be spelled the same way.
function chainKeys(toolchainId, cells) {
    const keys = [];
    let previous = crypto.createHash('sha256').update(toolchainId).digest('hex');

    for (const { name, source } of cells) {
        const hash = crypto.createHash('sha256');

        hash.update(previous);

        for (const part of [name, source]) {
            const bytes = Buffer.from(part, 'utf8');

            hash.update(`${bytes.length}:`);
            hash.update(bytes);
        }

        previous = hash.digest('hex');
        keys.push(previous);
    }

    return keys;
}

// What the compiled output depends on besides the cells: the compiler, the
// runtime, the references and the flags, hashed from their bytes so an upgrade
// gets new keys whatever it is called. `salt` lets the whole cache be
// invalidated by hand.
async function toolchainIdentity({ compiler, references, flags, salt }) {
    const hash = crypto.createHash('sha256');

    for (const file of [compiler, ...references]) {
        hash.update(file);
        hash.update('\0');

        await new Promise((resolve, reject) =>
            createReadStream(file)
                .on('data', chunk => hash.update(chunk))
                .on('end', resolve)
                .on('error', reject));
    }

    hash.update(JSON.stringify(flags));
    hash.update(salt ?? '');

    return hash.digest('hex');
}

// Assemblies this service built, by key, least recently used evicted first
// once the total passes `maxBytes`. Kept in a directory the container mounts
// as tmpfs, so a restart starts it empty, which costs recompiles and nothing
// else.
class CellCache {
    constructor(directory, maxBytes) {
        this.directory = directory;
        this.maxBytes = maxBytes;
        this.entries = new Map();
        this.bytes = 0;
        this.hits = 0;
        this.misses = 0;
    }

    async init() {
        await fs.mkdir(this.directory, { recursive: true });

        for (const file of await fs.readdir(this.directory)) {
            if (!file.endsWith('.dll')) {
                await fs.rm(path.join(this.directory, file), { force: true });
                continue;
            }

            const stat = await fs.stat(path.join(this.directory, file));

            this.entries.set(file.slice(0, -4), { size: stat.size, used: stat.mtimeMs });
            this.bytes += stat.size;
        }

        return this;
    }

    _file(key) {
        return path.join(this.directory, `${key}.dll`);
    }

    // The cached assembly's path, or null.
    get(key) {
        const entry = this.entries.get(key);

        if (!entry) {
            this.misses++;
            return null;
        }

        this.hits++;
        entry.used = Date.now();

        return this._file(key);
    }

    async put(key, file) {
        if (this.entries.has(key)) return;

        const bytes = await fs.readFile(file);
        const temporary = `${this._file(key)}.${process.pid}.${crypto.randomUUID()}.tmp`;

        await fs.writeFile(temporary, bytes);
        await fs.rename(temporary, this._file(key));

        this.entries.set(key, { size: bytes.length, used: Date.now() });
        this.bytes += bytes.length;

        await this._evict();
    }

    async _evict() {
        if (this.bytes <= this.maxBytes) return;

        const oldest = [...this.entries].sort((a, b) => a[1].used - b[1].used);

        for (const [key, { size }] of oldest) {
            if (this.bytes <= this.maxBytes) break;

            this.entries.delete(key);
            this.bytes -= size;

            await fs.rm(this._file(key), { force: true });
        }
    }

    describe() {
        return {
            entries: this.entries.size,
            bytes: this.bytes,
            maxBytes: this.maxBytes,
            hits: this.hits,
            misses: this.misses
        };
    }
}

// One compiler in compile-server mode, for the life of one request: it takes
// requests and answers them a line of JSON at a time.
class CompilerProcess {
    constructor({ compiler, references, cwd }) {
        const args = [compiler];

        for (const reference of references) {
            args.push('-a', reference);
        }

        args.push('--compile-server');

        this.process = spawn('dotnet', args, { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
        this.lines = readline.createInterface({ input: this.process.stdout });
        this.pending = [];
        this.exited = false;

        this.lines.on('line', line => this.pending.shift()?.resolve(line));

        this.process.on('exit', () => {
            this.exited = true;

            for (const waiter of this.pending.splice(0)) {
                waiter.reject(new Error('the compiler stopped'));
            }
        });
    }

    _next() {
        if (this.exited) return Promise.reject(new Error('the compiler stopped'));

        return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
    }

    ready() {
        return this._next();
    }

    async compile(request) {
        const answer = this._next();

        this.process.stdin.write(`${JSON.stringify(request)}\n`);

        return JSON.parse(await answer);
    }

    kill() {
        this.process.kill('SIGKILL');
    }
}

const SEVERITY = { 0: 'error', 1: 'error', 2: 'warn', 3: 'info' };

// The new cell's diagnostics, in the shape a whole-program compile answers
// with. Only those about the new cell's own text: an earlier cell compiled
// once already, and the page showed its diagnostics then.
function diagnosticsOf(reply, name) {
    return (reply.diagnostics ?? [])
        .filter(d => !d.is_internal && (!d.path || path.basename(d.path, '.ghul') === name))
        .map(d => ({
            startLine: d.start_line, startColumn: d.start_column,
            endLine: d.end_line, endColumn: d.end_column,
            severity: SEVERITY[d.severity] ?? 'hint',
            message: d.message
        }));
}

// Compiles the last of `cells`, compiling again first any earlier cell the
// cache does not hold.
async function compileCells({ cells, keys, cache, toolchain, directory, timeoutMs }) {
    const cellsDirectory = path.join(directory, 'cells');

    await fs.mkdir(cellsDirectory);

    // Each cell's assembly is written under the name it was compiled as,
    // because the compiler records a reference by its file name, and that is
    // the name the page's runtime then looks the cell up by.
    const assemblyOf = name => path.join(cellsDirectory, `${name}.dll`);

    const last = cells.length - 1;
    const toCompile = [];

    for (let i = 0; i < last; i++) {
        const cached = cache.get(keys[i]);

        // Copied rather than linked, so a concurrent request evicting the
        // entry cannot pull it from under this one; a copy that finds it
        // already gone is a miss like any other.
        try {
            if (!cached) throw new Error('not cached');

            await fs.copyFile(cached, assemblyOf(cells[i].name));
        } catch {
            toCompile.push(i);
        }
    }

    toCompile.push(last);

    const compiler = new CompilerProcess({ ...toolchain, cwd: directory });
    let timedOut = false;

    const timer = setTimeout(() => {
        timedOut = true;
        compiler.kill();
    }, timeoutMs);

    try {
        await compiler.ready();

        for (const i of toCompile) {
            const { name, source } = cells[i];

            const reply = await compiler.compile({
                name,
                text: source,
                output: assemblyOf(name),
                references: cells.slice(0, i).map(earlier => assemblyOf(earlier.name))
            });

            if (reply.status !== 0) {
                if (i === last) {
                    return { ok: false, diagnostics: diagnosticsOf(reply, name), assembly: null };
                }

                // It compiled when the page first submitted it, so either the
                // toolchain has changed under the session or the page has sent
                // something it never had accepted. Either way the session
                // cannot continue here.
                return {
                    ok: false, diagnostics: [], assembly: null, sessionBroken: true,
                    error: `${name}, accepted earlier, no longer compiles; start a new session`
                };
            }

            await cache.put(keys[i], assemblyOf(name));

            if (i === last) {
                return {
                    ok: true,
                    diagnostics: diagnosticsOf(reply, name),
                    assembly: (await fs.readFile(assemblyOf(name))).toString('base64'),
                    recompiled: toCompile.slice(0, -1).map(j => cells[j].name)
                };
            }
        }
    } catch (e) {
        if (timedOut) {
            return {
                ok: false, assembly: null,
                diagnostics: [{
                    startLine: 1, startColumn: 1, endLine: 1, endColumn: 1,
                    severity: 'error',
                    message: `compilation timed out after ${timeoutMs} ms`
                }]
            };
        }

        throw e;
    } finally {
        clearTimeout(timer);
        compiler.kill();
    }
}

module.exports = {
    BadRequest, parseCellRequest, chainKeys, toolchainIdentity, CellCache, compileCells
};
