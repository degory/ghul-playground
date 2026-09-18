// Analyse service: a WebSocket in front of a small pool of warm ghūl language
// servers.
//
// The analyser is stateful and that is the point. Warm, it answers an edit in a
// millisecond or two; cold, the first edit pays process start, reflection and a
// full analysis pass. The pool keeps that cost off the user's path by paying it
// in advance.
//
// An analyser is handed to exactly one client and killed when that client goes
// away. The pool holds *fresh* processes, never recycled ones, so pooling does
// not weaken the isolation between sessions: a process a client has touched is
// destroyed, not returned.
//
// The wire protocol is LSP. Over a WebSocket messages are already framed, so
// the Content-Length headers stdio needs are added and stripped here and the
// browser deals in plain JSON-RPC objects.

const fs = require('fs');
const http = require('http');
const { WebSocketServer } = require('ws');

const { resolveCompiler, resolveReferencePaths } = require('../shared/toolchain');
const { Analyser } = require('./analyser');
const { MAX_SOURCE_BYTES } = require('../shared/limits');
const origins = require('../shared/origins');
const tokens = require('../shared/tokens');

const PORT = Number(process.env.PORT ?? 5091);
const HOST = process.env.HOST ?? '127.0.0.1';

// Sessions are the memory budget: a warm analyser holds a few hundred
// megabytes. The pool is kept the same size, so a connecting client normally
// finds one ready.
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS ?? 2);
const POOL_SIZE = Number(process.env.POOL_SIZE ?? MAX_SESSIONS);

const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS ?? 5 * 60 * 1000);
const MAX_SESSION_MS = Number(process.env.MAX_SESSION_MS ?? 60 * 60 * 1000);
const WARM_UP_TIMEOUT_MS = Number(process.env.WARM_UP_TIMEOUT_MS ?? 120 * 1000);

// How many sessions one client address may hold. An address at the limit that
// connects again takes the slot of its own least recently active session,
// provided that session has been quiet for EVICT_QUIET_MS: the editor a reader
// has just gone back to is the one they are using, and one they left is not.
// The quiet period stops two editors in use at once, or two people behind one
// address, taking a slot back and forth. When nothing at the address has been
// quiet that long, the new connection is refused instead.
const MAX_SESSIONS_PER_ADDRESS = Number(process.env.MAX_SESSIONS_PER_ADDRESS ?? 4);
const EVICT_QUIET_MS = Number(process.env.EVICT_QUIET_MS ?? 20 * 1000);

// How long a connecting client waits for the pool to produce a warm analyser
// before it gets a cold one instead. A cold analyser still works, it is just
// slow to first diagnostic.
const ACQUIRE_TIMEOUT_MS = Number(process.env.ACQUIRE_TIMEOUT_MS ?? 5000);

const SERVER_COMMAND = process.env.GHUL_LANGUAGE_SERVER ?? 'ghul-language-server';

// The client addresses one fixed path and never learns where its workspace
// actually is, so it cannot address anything outside its own session by naming
// a different URI.
const VIRTUAL_ROOT = 'file:///playground';

const log = message => console.log(`${new Date().toISOString().slice(11, 19)} ${message}`);

let references = null;
// The command the language server is told to run the compiler as. It is the
// pinned compiler resolved once, at startup, rather than something the server
// is left to hunt for - see createWorkspace.
let compiler = null;

// --- the pool -------------------------------------------------------------

const idle = [];
const waiting = [];
let warming = 0;

function poolState() {
    return { idle: idle.length, warming };
}

function replenish() {
    while (idle.length + warming < POOL_SIZE) {
        warming++;

        const analyser = new Analyser({ command: SERVER_COMMAND, compiler, references, log });

        (async () => {
            try {
                await analyser.start();

                if (!await analyser.warmUp(WARM_UP_TIMEOUT_MS)) {
                    analyser.log('did not warm up, discarding');
                    analyser.kill();
                    return;
                }

                analyser.log('warm');

                // Somebody may already be waiting for one.
                const next = waiting.shift();
                if (next) {
                    next(analyser);
                } else {
                    idle.push(analyser);
                }
            } catch (e) {
                analyser.log(`warm-up failed: ${e.message}`);
                analyser.kill();
            } finally {
                warming--;

                // Only top back up once this attempt has finished, or a
                // failing analyser would spin.
                setTimeout(replenish, 250);
            }
        })();
    }
}

// A warm one if there is one, otherwise wait briefly for the pool, otherwise
// start one cold rather than refusing the client.
function acquire() {
    const warm = idle.shift();

    if (warm) {
        replenish();
        return Promise.resolve(warm);
    }

    return new Promise(resolve => {
        let settled = false;

        const hand = analyser => {
            if (settled) return;
            settled = true;
            resolve(analyser);
        };

        waiting.push(hand);
        replenish();

        setTimeout(async () => {
            if (settled) return;

            const index = waiting.indexOf(hand);
            if (index >= 0) waiting.splice(index, 1);

            log('pool empty, starting a cold analyser');

            const analyser = new Analyser({ command: SERVER_COMMAND, compiler, references, log });

            try {
                await analyser.start();
                await analyser.warmUp(WARM_UP_TIMEOUT_MS);
                hand(analyser);
            } catch (e) {
                log(`cold start failed: ${e.message}`);
                analyser.kill();
                hand(null);
            }
        }, ACQUIRE_TIMEOUT_MS);
    });
}

// --- sessions -------------------------------------------------------------

const sessions = new Set();
let nextSessionId = 1;

// CPU seconds the given process has used, or null if it cannot be read - the
// process may have exited between the caller deciding to ask and asking. Fields
// 14 and 15 of /proc/<pid>/stat are user and system time in clock ticks; the
// command name in field 2 can itself contain spaces and brackets, so the split
// starts after the last ')' rather than at the first space.
function cpuSeconds(pid) {
    if (!pid) return null;

    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');

        return (Number(fields[11]) + Number(fields[12])) / HERTZ;
    } catch {
        return null;
    }
}

// The kernel reports those times in clock ticks. It is 100 on every Linux this
// runs on, and there is no way to ask for it from node without spawning
// getconf, so it is named here rather than hidden as a bare 100 below.
const HERTZ = 100;

// The address a session is counted against, or null when there is none to
// count by. Behind nginx every connection comes from the proxy - through
// Docker, from the bridge's gateway - so the only usable address is the one
// nginx puts in X-Real-IP, which it sets rather than appends to and so cannot
// be supplied by the client. The port is published on loopback only, so
// nothing but nginx can reach the service to set it. Without the header every
// reader would share one address and one cap, so a connection without it is
// not capped per address at all.
function clientAddress(request) {
    return request.headers['x-real-ip'] || null;
}

// The address's own sessions, least recently active first.
function sessionsFrom(address) {
    return [...sessions]
        .filter(session => session.address === address)
        .sort((a, b) => a.lastActive - b.lastActive);
}

class Session {
    constructor(socket, analyser, address) {
        this.id = nextSessionId++;
        this.socket = socket;
        this.analyser = analyser;
        this.address = address;
        this.closed = false;

        // What the analyser had already spent being warmed, so that the figure
        // logged on close is the work this client asked for and not the pool's.
        this.startedAt = Date.now();
        this.startCpu = cpuSeconds(analyser.process?.pid);

        this.idleTimer = null;
        this.lifetimeTimer = setTimeout(
            () => this.close('session lifetime exceeded'), MAX_SESSION_MS);

        analyser.onMessage = body => this.fromAnalyser(body);

        this.touch();
    }

    log(message) {
        console.log(`[session ${this.id}] ${message}`);
    }

    // What the session actually cost, for deciding whether MAX_SESSIONS is the
    // right number. Sessions are capped well below one per core on the premise
    // that an editor is idle between keystrokes; this is the measurement that
    // says whether that is true, and how far the cap could move. Read before
    // the analyser is killed, since it comes from that process.
    cost() {
        const endCpu = cpuSeconds(this.analyser.process?.pid);

        if (this.startCpu === null || endCpu === null) return '';

        const wall = (Date.now() - this.startedAt) / 1000;
        const cpu = endCpu - this.startCpu;
        const duty = wall > 0 ? (100 * cpu / wall).toFixed(1) : '0.0';

        return ` (${wall.toFixed(0)}s wall, ${cpu.toFixed(1)}s cpu, ${duty}% duty)`;
    }

    touch() {
        this.lastActive = Date.now();
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.close('idle'), IDLE_TIMEOUT_MS);
    }

    fromAnalyser(body) {
        // null means the process died.
        if (body === null) {
            this.close('analyser exited');
            return;
        }

        if (this.socket.readyState === this.socket.OPEN) {
            this.socket.send(body.split(this.analyser.realRoot).join(VIRTUAL_ROOT));
        }
    }

    // The analyser was initialized by the pool, so the opening exchange cannot
    // simply be forwarded: a second initialize is a protocol error, and the
    // document is already open. The first three messages of a session are
    // therefore answered or translated here.
    fromClient(text) {
        let message;

        try {
            message = JSON.parse(text);
        } catch {
            return;
        }

        if (message.method === 'initialize') {
            this.socket.send(JSON.stringify({
                jsonrpc: '2.0',
                id: message.id,
                result: this.analyser.capabilities
            }));
            return;
        }

        // The pool has already sent this one.
        if (message.method === 'initialized') return;

        // The document is open with the warm-up source, so the client opening
        // "its" document is really a change to the one already there.
        if (message.method === 'textDocument/didOpen') {
            this.replaceDocument(message.params?.textDocument?.text ?? '');
            return;
        }

        if (message.method === 'textDocument/didChange') {
            const changes = message.params?.contentChanges ?? [];
            const whole = changes[changes.length - 1]?.text;

            if (typeof whole !== 'string') {
                this.log('incremental didChange is not supported; send whole-document changes');
                return;
            }

            // Versions are the analyser's to allocate: the client's numbering
            // starts from its own didOpen and would go backwards against a
            // document the pool already opened.
            this.replaceDocument(whole);
            return;
        }

        this.analyser.write(text.split(VIRTUAL_ROOT).join(this.analyser.realRoot));
    }

    // Analysing a document costs a full pass, so an oversized one is declined
    // here for the same reason the compile service declines one. The editor
    // enforces the same limit, so reaching this means something other than the
    // editor is sending it.
    replaceDocument(text) {
        if (text.length > MAX_SOURCE_BYTES) {
            this.log(`declining a ${text.length} byte document; the limit is ${MAX_SOURCE_BYTES}`);
            return;
        }

        this.analyser.replaceDocument(text);
    }

    close(reason) {
        if (this.closed) return;
        this.closed = true;

        clearTimeout(this.idleTimer);
        clearTimeout(this.lifetimeTimer);

        this.log(`closing: ${reason}${this.cost()}`);

        // The analyser is destroyed rather than returned: a process a client
        // has touched is never handed to another one.
        this.analyser.onMessage = null;
        this.analyser.kill();

        try {
            this.socket.close(1000, reason);
        } catch { /* already gone */ }

        sessions.delete(this);

        replenish();
    }
}

// --- wiring ---------------------------------------------------------------

const server = http.createServer((request, response) => {
    // Always-on: a front end uses this to decide whether to offer editing at
    // all, so it must answer even when every slot is taken. It reports that the
    // service exists, not that a slot is free.
    if (request.url.startsWith('/health')) {
        // Probed cross-origin by whatever page is deciding whether to offer
        // editing at all, so it has to say so. Without this the browser blocks
        // the read and an embedding site concludes there is no back end.
        response.writeHead(200, {
            'content-type': 'application/json',
            'access-control-allow-origin': '*'
        });
        response.end(JSON.stringify({
            ok: true,
            sessions: sessions.size,
            maxSessions: MAX_SESSIONS,
            pool: poolState(),
            // Read by the front end so the editor can enforce the same limit
            // the services do, rather than a reader discovering it by having a
            // paste silently do nothing.
            maxSourceBytes: MAX_SOURCE_BYTES,
            // So a front end can tell whether to ask for a token at all. Asking
            // for one the services do not want is worse than not asking: it
            // reads as a closed door on a service that is open.
            tokensRequired: tokens.required
        }));
        return;
    }

    response.writeHead(404).end('not found');
});

// A browser cannot set headers on a WebSocket, so the token arrives as a
// subprotocol rather than a query parameter, which keeps it out of access logs.
//
// The check has to be in verifyClient, not handleProtocols: declining a
// subprotocol does not refuse the connection, it just leaves the connection
// without one. Rejecting at the upgrade gives the client an HTTP 401 and a
// socket that never opens.
const wss = new WebSocketServer({
    server,
    path: '/analyse',

    // A frame can only ever be an LSP message about a document that is itself
    // capped, so anything materially larger is not a client of ours.
    maxPayload: 4 * MAX_SOURCE_BYTES,

    verifyClient: (info, callback) => {
        // Sessions are a small fixed pool, so a third-party page opening them
        // from its visitors' browsers would deny editing to everyone at no cost
        // to itself. Browsers always send Origin on a WebSocket and cannot
        // forge it; anything that can is answered by the session cap instead.
        if (!origins.accepts(info.req.headers.origin)) {
            log(`refusing connection: origin ${info.req.headers.origin} not allowed`);
            callback(false, 403, 'origin not allowed');
            return;
        }

        const offered = (info.req.headers['sec-websocket-protocol'] ?? '')
            .split(',')
            .map(protocol => protocol.trim())
            .filter(Boolean);

        if (tokens.accepts(tokens.fromSubprotocols(offered))) {
            callback(true);
            return;
        }

        log('refusing connection: invalid or missing access token');
        callback(false, 401, 'invalid or missing access token');
    },

    // Echo the plain marker, never the token-bearing one.
    handleProtocols: protocols => protocols.has('ghul-playground') ? 'ghul-playground' : false
});

wss.on('connection', async (socket, request) => {
    const address = clientAddress(request);
    const mine = address ? sessionsFrom(address) : [];

    if (mine.length >= MAX_SESSIONS_PER_ADDRESS) {
        const quiet = mine.find(session =>
            session.close && Date.now() - session.lastActive >= EVICT_QUIET_MS);

        if (!quiet) {
            log(`refusing connection: ${mine.length}/${MAX_SESSIONS_PER_ADDRESS} sessions ` +
                'from one address, none quiet enough to give up');
            socket.close(1013, 'address limit');
            return;
        }

        // The client reads this reason as going dormant, like an idle close:
        // it reconnects when its reader next does something, not on a timer.
        quiet.close('evicted');
    }

    if (sessions.size >= MAX_SESSIONS) {
        log(`refusing connection: ${sessions.size}/${MAX_SESSIONS} sessions in use`);
        socket.close(1013, 'try again later');
        return;
    }

    // Hold the slot while acquiring, so two connections arriving together
    // cannot both pass the checks above. It counts against the address and is
    // never evicted, since nobody has used it yet.
    const placeholder = { closed: false, address, lastActive: Infinity };
    sessions.add(placeholder);

    let analyser;
    try {
        analyser = await acquire();
    } finally {
        sessions.delete(placeholder);
    }

    if (!analyser || socket.readyState !== socket.OPEN) {
        analyser?.kill();
        try { socket.close(1011, 'no analyser available'); } catch { }
        return;
    }

    const session = new Session(socket, analyser, address);
    sessions.add(session);

    session.log(`took analyser ${analyser.id} (${analyser.warm ? 'warm' : 'cold'}), ` +
        `pool now ${JSON.stringify(poolState())}`);

    socket.on('message', data => {
        session.touch();
        session.fromClient(data.toString());
    });

    socket.on('close', () => session.close('client disconnected'));
    socket.on('error', () => session.close('socket error'));
});

(async () => {
    references = await resolveReferencePaths();
    compiler = `dotnet ${await resolveCompiler()}`;

    log(`references: ${references.length}`);
    log(`compiler: ${compiler}`);

    server.listen(PORT, HOST, () => {
        log(`analyse service on ws://${HOST}:${PORT}/analyse ` +
            `(max ${MAX_SESSIONS} sessions, ${MAX_SESSIONS_PER_ADDRESS} per address, ` +
            `pool ${POOL_SIZE}, idle ${IDLE_TIMEOUT_MS / 1000}s, evictable after ${EVICT_QUIET_MS / 1000}s)`);
        log(tokens.describe());
        log(origins.describe());

        replenish();
    });
})();

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        for (const session of [...sessions]) session.close?.('service shutting down');
        for (const analyser of idle) analyser.kill();
        process.exit(0);
    });
}
