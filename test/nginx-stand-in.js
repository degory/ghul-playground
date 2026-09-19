// What nginx does in production and the .NET dev host does not, for tests run
// against local services: the cross-origin isolation headers on every
// response, and the compile and analyse services beside the playground's files
// on the same origin. A prefix serves the playground below a path, as ghul.dev
// serves it below /playground/.
//
// From a test: `await startNginxStandIn({ prefix: '/playground/' })`. From the
// command line, to run the browser test against it:
//
//   node test/nginx-stand-in.js 5081 /playground/ &
//   BASE=http://127.0.0.1:5081/playground/ node test/browser-end-to-end.js

const http = require('http');
const net = require('net');

const WEB = 5080;
const COMPILE = 5090;
const ANALYSE = 5091;

// The upstream port and path for a request path below the prefix, or null.
function route(url, prefix) {
    if (!url.startsWith(prefix)) return null;

    const path = '/' + url.slice(prefix.length);

    if (path.startsWith('/compile')) return { port: COMPILE, path };
    if (path.startsWith('/analyse') || path.startsWith('/health')) return { port: ANALYSE, path };

    return { port: WEB, path };
}

function startNginxStandIn({ prefix = '/', port = 0 } = {}) {
    const server = http.createServer((request, response) => {
        const target = route(request.url, prefix);

        if (!target) {
            response.writeHead(404).end();
            return;
        }

        const upstream = http.request({
            host: '127.0.0.1',
            port: target.port,
            path: target.path,
            method: request.method,
            headers: { ...request.headers, host: `127.0.0.1:${target.port}` }
        }, answer => {
            response.writeHead(answer.statusCode, {
                ...answer.headers,
                'cross-origin-opener-policy': 'same-origin',
                'cross-origin-embedder-policy': 'require-corp'
            });

            answer.pipe(response);
        });

        upstream.on('error', () => response.writeHead(502).end());
        request.pipe(upstream);
    });

    // The analyser's WebSocket: the upgrade request is passed on with the
    // prefix taken off, and from then on the two sockets are joined.
    server.on('upgrade', (request, socket, head) => {
        const target = route(request.url, prefix);

        if (!target) {
            socket.destroy();
            return;
        }

        const upstream = net.connect(target.port, '127.0.0.1', () => {
            const headers = Object.entries(request.headers)
                .map(([name, value]) => `${name}: ${name === 'host' ? `127.0.0.1:${target.port}` : value}`)
                .join('\r\n');

            upstream.write(`${request.method} ${target.path} HTTP/1.1\r\n${headers}\r\n\r\n`);
            upstream.write(head);
            upstream.pipe(socket);
            socket.pipe(upstream);
        });

        upstream.on('error', () => socket.destroy());
        socket.on('error', () => upstream.destroy());
    });

    return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}

module.exports = { startNginxStandIn };

if (require.main === module) {
    const [port = '5081', prefix = '/'] = process.argv.slice(2);

    startNginxStandIn({ prefix, port: Number(port) })
        .then(server => console.log(`nginx stand-in on http://127.0.0.1:${server.address().port}${prefix}`));
}
