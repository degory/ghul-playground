// Every query the analytics dashboards make, run against GoatCounter's own
// schema.
//
// The dashboards are SQL in a repository, provisioned read-only, and nothing
// else exercises them: a column renamed upstream, or a typo, shows up as an
// empty panel on a page somebody looks at once a week. This builds an empty
// database with the real schema, puts a handful of rows in it, and runs each
// panel's query. It does not check the numbers - a fixture cannot say what the
// site did - only that every query is one SQLite will answer.
//
//   node test/dashboard-queries.mjs
//
// Needs sqlite3; skips rather than fails without one, since it is not part of
// what this repository builds.

import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import path from 'path';

const dashboards = path.join(import.meta.dirname, '../deploy/grafana/dashboards');

let failures = 0;

const check = (what, ok, detail = '') => {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${ok || !detail ? '' : `: ${detail}`}`);
};

try {
    execFileSync('sqlite3', ['--version'], { stdio: 'ignore' });
} catch {
    console.log('ok    (no sqlite3 here; the dashboard queries are unchecked)');
    process.exit(0);
}

// GoatCounter v2.7.0's own definitions, copied from a running instance rather
// than written from memory: `session` is a blob, `width` is nullable, and a
// query that forgets either is wrong in a way a made-up schema would hide.
const SCHEMA = `
create table hits (hit_id integer primary key autoincrement, site_id integer not null,
  path_id integer not null, ref_id integer not null default 1, session blob default null,
  first_visit integer default 0, browser_id integer not null, system_id integer not null,
  campaign integer default null, width smallint null, location varchar not null default '',
  language varchar, created_at timestamp not null);
create table paths (path_id integer primary key autoincrement, site_id integer not null,
  path varchar not null, title varchar not null default '', event integer default 0);
create table refs (ref_id integer primary key autoincrement, ref varchar not null,
  ref_scheme varchar not null);

insert into paths (path_id, site_id, path, event) values
  (1, 1, '/', 0), (2, 1, '/playground/', 0), (3, 1, 'playground-open/rosetta-code', 1),
  (4, 1, 'playground-run/manual/rosetta-code/x', 1), (5, 1, 'playground-result/compiled-ok', 1),
  (6, 1, '/repl/', 0), (7, 1, 'repl-open', 1), (8, 1, 'repl-cell/ok', 1),
  (9, 1, '/control-flow', 0), (10, 1, 'example-run/a', 1), (11, 1, 'example-result/ok', 1),
  (12, 1, 'rosetta-more/related/1', 1),
  -- A path from before the playground moved under ghul.dev, which the queries
  -- rewrite as the path it would be today.
  (13, 1, '/playground.ghul.dev/rosetta-code/x', 0);
insert into refs (ref_id, ref, ref_scheme) values (1, '', 'o'), (2, 'rosettacode.org', 'h');
insert into hits (site_id, path_id, ref_id, session, first_visit, browser_id, system_id, width, location, created_at) values
  (1, 1, 2, x'01', 1, 1, 1, 1280, 'GB', datetime('now', '-1 day')),
  (1, 2, 1, x'01', 0, 1, 1, 1280, 'GB', datetime('now', '-1 day')),
  (1, 3, 1, x'01', 0, 1, 1, 1280, 'GB', datetime('now', '-1 day')),
  (1, 4, 1, x'01', 0, 1, 1, 1280, 'GB', datetime('now', '-1 day')),
  (1, 5, 1, x'01', 0, 1, 1, 1280, 'GB', datetime('now', '-1 day')),
  (1, 6, 1, x'02', 1, 1, 1, null, 'FR', datetime('now', '-2 day')),
  (1, 7, 1, x'02', 0, 1, 1, null, 'FR', datetime('now', '-2 day')),
  (1, 8, 1, x'02', 0, 1, 1, null, 'FR', datetime('now', '-2 day')),
  (1, 9, 1, x'03', 1, 1, 1, 390, 'DE', datetime('now', '-3 day')),
  (1, 10, 1, x'03', 0, 1, 1, 390, 'DE', datetime('now', '-3 day')),
  (1, 11, 1, x'03', 0, 1, 1, 390, 'DE', datetime('now', '-3 day')),
  (1, 12, 1, x'03', 0, 1, 1, 390, 'DE', datetime('now', '-3 day')),
  (1, 13, 1, x'04', 1, 1, 1, 1280, 'US', datetime('now', '-4 day'));
`;

const work = mkdtempSync(path.join(tmpdir(), 'ghul-dashboards-'));

try {
    const database = path.join(work, 'analytics.sqlite3');

    execFileSync('sqlite3', [database], { input: SCHEMA, stdio: ['pipe', 'ignore', 'inherit'] });

    let asked = 0;

    for (const file of readdirSync(dashboards).filter(name => name.endsWith('.json')).sort()) {
        const dashboard = JSON.parse(readFileSync(path.join(dashboards, file), 'utf8'));

        for (const panel of dashboard.panels) {
            const target = panel.targets?.[0];

            if (panel.datasource?.uid !== 'analytics' || !target?.queryText) continue;

            asked++;

            // Grafana substitutes a dashboard variable before the datasource
            // ever sees the query, so this stands in for the reader's choice.
            const query = target.queryText.replaceAll('${days}', '30');

            try {
                execFileSync('sqlite3', [database, query], { stdio: ['ignore', 'ignore', 'pipe'] });
                check(`${file}: ${panel.title}`, true);
            } catch (e) {
                check(`${file}: ${panel.title}`, false,
                    (e.stderr?.toString() ?? e.message).trim().split('\n')[0]);
            }
        }
    }

    check('there were dashboard queries to run', asked > 0, `${asked} found`);
} finally {
    rmSync(work, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
