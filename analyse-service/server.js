// Analyse service: a WebSocket in front of one ghūl language server per
// connected editor.
//
// The analyser is stateful and that is the point. A warm one answers an edit in
// a millisecond or two, where a cold compile pays process start, reflection and
// a from-scratch symbol table and takes seconds. Per-keystroke cold compilation
// would be both slower for the user and more CPU overall.
//
// A session is one WebSocket, one private workspace directory, and one language
// server process. Processes are never shared between clients: a fresh process
// is the isolation boundary, so recycling one is a requirement rather than an
// optimisation.
//
// The wire protocol is LSP itself. Over a WebSocket the messages are already
// framed, so the Content-Length headers stdio needs are added and stripped
// here and the browser deals in plain JSON-RPC objects.

const http = require('http');
const { spawn } = require('child_process');
const { mkdtemp, writeFile, mkdir, rm } = require('fs/promises');
const { tmpdir } = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');

const { resolveReferencePaths } = require('../shared/toolchain');

const PORT = Number(process.env.PORT ?? 5091);
const HOST = process.env.HOST ?? '127.0.0.1';

// Session admission. Opening a session is cheap for a client and expensive for
// us: a warm analyser holds a few hundred megabytes. Queueing is not useful
// here, so excess connections are refused and told to retry.
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS ?? 3);

// Idle long enough and the analyser is recycled. The client is expected to
// reconnect and resend the document, which is cheap because there is only ever
// one file.
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS ?? 5 * 60 * 1000);

// A hard ceiling regardless of activity, so a session cannot pin an analyser
// indefinitely.
const MAX_SESSION_MS = Number(process.env.MAX_SESSION_MS ?? 60 * 60 * 1000);

const SERVER_COMMAND = process.env.GHUL_LANGUAGE_SERVER ?? 'ghul-language-server';

const sessions = new Set();
let nextSessionId = 1;

let referencePaths = null;

// The workspace deliberately has no .ghulproj and no tool manifest. The
// language server regenerates .assemblies.json from the project's reference
// closure when a project file is present, which would replace the restricted
// reference set with the full one; with no project file it skips that step and
// trusts what is on disk.
async function createWorkspace() {
    const directory = await mkdtemp(path.join(tmpdir(), 'ghul-analyse-'));

    await mkdir(path.join(directory, 'src'));
    await writeFile(path.join(directory, 'src', 'main.ghul'), '', 'utf8');
    await writeFile(path.join(directory, 'ghul.json'), '{}', 'utf8');
    await writeFile(
        path.join(directory, '.assemblies.json'),
        JSON.stringify({ assemblies: referencePaths }),
        'utf8');

    return directory;
}

// The client talks about one fixed path and never learns where the session's
// workspace actually is. The bridge maps between the two, so a browser cannot
// address anything outside its own workspace by asking about a different URI.
const VIRTUAL_ROOT = 'file:///playground';
const DOCUMENT_URI = `${VIRTUAL_ROOT}/src/main.ghul`;

class Session {
    constructor(socket) {
        this.id = nextSessionId++;
        this.socket = socket;
        this.workspace = null;
        this.realRoot = null;
        this.server = null;
        this.buffer = Buffer.alloc(0);
        this.closed = false;

        this.idleTimer = null;
        this.lifetimeTimer = setTimeout(
            () => this.close('session lifetime exceeded'), MAX_SESSION_MS);

        this.touch();
    }

    log(message) {
        console.log(`[session ${this.id}] ${message}`);
    }

    touch() {
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.close('idle'), IDLE_TIMEOUT_MS);
    }

    async start() {
        this.workspace = await createWorkspace();
        this.realRoot = 'file://' + this.workspace;

        this.server = spawn(SERVER_COMMAND, ['--stdio'], {
            cwd: this.workspace,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        this.server.on('error', e => {
            this.log(`language server failed to start: ${e.message}`);
            this.close('language server failed to start');
        });

        this.server.on('exit', code => {
            if (!this.closed) {
                this.log(`language server exited (${code})`);
                this.close('language server exited');
            }
        });

        this.server.stdout.on('data', chunk => this.onServerData(chunk));

        // The analyser reports progress and problems on stderr. Useful when a
        // session misbehaves, noisy otherwise, so it is opt-in.
        this.server.stderr.on('data', chunk => {
            if (process.env.LOG_SERVER_STDERR) {
                process.stderr.write(`[session ${this.id}] ${chunk}`);
            }
        });

        this.log(`started in ${this.workspace}`);
    }

    // stdio framing in: Content-Length header, blank line, exactly that many
    // bytes of JSON. A chunk can hold part of a message or several.
    onServerData(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);

        for (;;) {
            const split = this.buffer.indexOf('\r\n\r\n');
            if (split < 0) return;

            const match = /Content-Length: (\d+)/i.exec(this.buffer.subarray(0, split).toString());
            if (!match) {
                this.log('malformed header from language server, dropping buffer');
                this.buffer = Buffer.alloc(0);
                return;
            }

            const length = Number(match[1]);
            const start = split + 4;
            if (this.buffer.length < start + length) return;

            const body = this.buffer.subarray(start, start + length).toString();
            this.buffer = this.buffer.subarray(start + length);

            if (this.socket.readyState === this.socket.OPEN) {
                this.socket.send(body.split(this.realRoot).join(VIRTUAL_ROOT));
            }
        }
    }

    // ... and out. The browser sends bare JSON-RPC; stdio wants the header.
    sendToServer(text) {
        if (this.closed || !this.server?.stdin.writable) return;

        this.mirrorToDisk(text);

        const mapped = text.split(VIRTUAL_ROOT).join(this.realRoot);

        this.server.stdin.write(`Content-Length: ${Buffer.byteLength(mapped)}\r\n\r\n${mapped}`);
    }

    // The analyser reads the file from disk as well as taking it over the
    // protocol, so an open or a change has to land on disk or it analyses an
    // empty file and reports nothing. Only whole-document sync is supported,
    // which is all a single-file playground needs.
    mirrorToDisk(text) {
        let message;

        try {
            message = JSON.parse(text);
        } catch {
            return;
        }

        const method = message.method;
        if (method !== 'textDocument/didOpen' && method !== 'textDocument/didChange') return;

        const content = method === 'textDocument/didOpen'
            ? message.params?.textDocument?.text
            : message.params?.contentChanges?.[message.params.contentChanges.length - 1]?.text;

        if (typeof content !== 'string') {
            if (method === 'textDocument/didChange') {
                this.log('incremental didChange is not supported; send whole-document changes');
            }
            return;
        }

        writeFile(path.join(this.workspace, 'src', 'main.ghul'), content, 'utf8')
            .catch(e => this.log(`could not mirror document to disk: ${e.message}`));
    }

    close(reason) {
        if (this.closed) return;
        this.closed = true;

        clearTimeout(this.idleTimer);
        clearTimeout(this.lifetimeTimer);

        this.log(`closing: ${reason}`);

        // SIGKILL rather than a polite shutdown: the process is being discarded
        // and a hung analyser must not be able to keep its slot.
        this.server?.kill('SIGKILL');

        try {
            this.socket.close(1000, reason);
        } catch { /* already gone */ }

        if (this.workspace) {
            rm(this.workspace, { recursive: true, force: true })
                .catch(e => this.log(`could not remove workspace: ${e.message}`));
        }

        sessions.delete(this);
    }
}

const server = http.createServer((request, response) => {
    // An always-on health endpoint. The front end uses this to decide whether
    // to offer editing at all, so it must answer even when every session slot
    // is taken: it reports that the service exists, not that a slot is free.
    if (request.url.startsWith('/health')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
            ok: true,
            sessions: sessions.size,
            maxSessions: MAX_SESSIONS
        }));
        return;
    }

    response.writeHead(404).end('not found');
});

const wss = new WebSocketServer({ server, path: '/analyse' });

wss.on('connection', async socket => {
    if (sessions.size >= MAX_SESSIONS) {
        console.log(`refusing connection: ${sessions.size}/${MAX_SESSIONS} sessions in use`);
        socket.close(1013, 'try again later');
        return;
    }

    const session = new Session(socket);
    sessions.add(session);

    try {
        await session.start();
    } catch (e) {
        session.log(`could not start: ${e.message}`);
        session.close('could not start');
        return;
    }

    socket.on('message', data => {
        session.touch();
        session.sendToServer(data.toString());
    });

    socket.on('close', () => session.close('client disconnected'));
    socket.on('error', () => session.close('socket error'));
});

(async () => {
    referencePaths = await resolveReferencePaths();

    console.log(`references: ${referencePaths.length}`);

    server.listen(PORT, HOST, () =>
        console.log(`analyse service on ws://${HOST}:${PORT}/analyse ` +
            `(max ${MAX_SESSIONS} sessions, idle ${IDLE_TIMEOUT_MS / 1000}s)`));
})();

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        for (const session of [...sessions]) session.close('service shutting down');
        process.exit(0);
    });
}
