// Does an address at its analyser cap give the new connection the slot of its
// quietest session, and refuse when none has been quiet long enough?
//
// Run against an analyse service started with a small cap and a short quiet
// period, so the test does not have to hold four sessions or wait twenty
// seconds:
//
//   MAX_SESSIONS_PER_ADDRESS=2 EVICT_QUIET_MS=2000 MAX_SESSIONS=6 POOL_SIZE=3 \
//       PORT=5093 node analyse-service/server.js &
//   ANALYSE_URL=ws://127.0.0.1:5093/analyse node test/analyse-eviction.js
//
// The client address is supplied the way nginx supplies it, in X-Real-IP.
// Exits non-zero if any check fails.

const WebSocket = require('ws');

const URL_ = process.env.ANALYSE_URL ?? 'ws://127.0.0.1:5093/analyse';
const QUIET_MS = Number(process.env.EVICT_QUIET_MS ?? 2000);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

let failures = 0;

function check(what, ok, detail = '') {
    if (!ok) failures++;
    log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  ${detail}` : ''}`);
}

// A connection from the given address, with what it has been told recorded:
// whether initialize was answered, and the reason it was closed for.
function connect(address) {
    const socket = new WebSocket(URL_, ['ghul-playground'], { headers: { 'x-real-ip': address } });
    const client = { socket, initialized: false, closed: null };

    client.ready = new Promise(resolve => {
        socket.on('open', () => {
            socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
        });

        socket.on('message', data => {
            if (JSON.parse(data.toString()).id === 1) {
                client.initialized = true;
                resolve(true);
            }
        });

        socket.on('close', (code, reason) => {
            client.closed = reason.toString();
            resolve(false);
        });

        socket.on('error', () => { });
    });

    // Anything the client sends counts as activity.
    client.touch = () => socket.send(JSON.stringify({ jsonrpc: '2.0', method: '$/ping' }));

    return client;
}

// Waits for the service to finish admitting or refusing, by which time a
// session it evicted has been closed too.
const settle = () => sleep(500);

(async () => {
    const first = connect('203.0.113.1');
    await first.ready;
    check('a first session is admitted', first.initialized, first.closed ?? '');

    await sleep(QUIET_MS + 500);

    const second = connect('203.0.113.1');
    await second.ready;
    second.touch();
    check('a second session is admitted', second.initialized, second.closed ?? '');

    const third = connect('203.0.113.1');
    await third.ready;
    await settle();

    check('at the cap, a new connection is admitted', third.initialized, third.closed ?? '');
    check('in place of the session quiet longest', first.closed === 'evicted', String(first.closed));
    check('and not the one in use', second.closed === null, String(second.closed));

    // Both in use just now, however long the third took to be handed an
    // analyser.
    second.touch();
    third.touch();

    const fourth = connect('203.0.113.1');
    await fourth.ready;
    await settle();

    check('with nothing quiet enough, a new connection is refused',
        fourth.closed === 'address limit', String(fourth.closed));
    check('and nothing is evicted for it', second.closed === null && third.closed === null);

    const other = connect('203.0.113.2');
    await other.ready;
    check('another address is not affected', other.initialized, other.closed ?? '');

    for (const client of [second, third, other]) client.socket.close();

    log(failures ? `${failures} failure(s)` : 'all checks passed');
    process.exit(failures ? 1 : 0);
})();
