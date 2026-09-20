// nginx must publish no route to the dashboards.
//
// They are reached by forwarding Grafana's loopback port over ssh, which is a
// decision about what is exposed rather than about convenience: a published
// route is a login page on the public internet in front of a service that can
// reconstruct a visitor's session, and the alternative costs one ssh command.
//
// A route could come back by accident - a copied block, a merge, somebody
// adding a location while looking at something else - and it would look
// exactly like working software. This is cheaper than noticing.
//
//   node test/no-route-to-grafana.mjs

import { readFileSync, readdirSync } from 'fs';
import path from 'path';

const nginx = path.join(import.meta.dirname, '../deploy/nginx');

// The port compose publishes Grafana on, read from compose.yaml rather than
// written here twice: moving it there should not quietly disarm this.
const compose = readFileSync(path.join(import.meta.dirname, '../compose.yaml'), 'utf8');
const grafana = compose.slice(compose.indexOf('\n  grafana:'));
const published = /-\s+"127\.0\.0\.1:(\d+):\d+"/.exec(grafana)?.[1];

let failures = 0;

const check = (what, ok, detail = '') => {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${ok || !detail ? '' : `: ${detail}`}`);
};

check('compose says which port Grafana is published on', Boolean(published), String(published));

check('and publishes it on loopback only',
    /-\s+"127\.0\.0\.1:\d+:\d+"/.test(grafana) && !/-\s+"\d+:\d+"/.test(grafana));

if (published) {
    for (const file of readdirSync(nginx).filter(name => name.endsWith('.conf')).sort()) {
        const text = readFileSync(path.join(nginx, file), 'utf8');

        // Any line that would send a request there, however the block around it
        // is written.
        const routes = text.split('\n')
            .map((line, at) => ({ line: line.trim(), at: at + 1 }))
            .filter(({ line }) => !line.startsWith('#'))
            .filter(({ line }) => new RegExp(`proxy_pass\\s+https?://[^;]*:${published}\\b`).test(line));

        check(`${file} publishes no route to Grafana`, routes.length === 0,
            routes.map(({ line, at }) => `line ${at}: ${line}`).join('; '));
    }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
