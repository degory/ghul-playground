// Every entry in the standalone page's example menu, through the compile
// service.
//
// The menu's sources are copied from degory/ghul-rosetta-code at build time
// (scripts/build-examples.js), and this is the check that each one still
// compiles under the playground's own pinned compiler and deliberately short
// reference list - so a menu entry that would fail for a visitor fails the
// build instead.
//
//   node scripts/build-examples.js && node test/examples-corpus.js
//   MANIFEST=web/wwwroot/examples.json SERVICE=http://127.0.0.1:5090 node test/examples-corpus.js

const fs = require('fs');

const MANIFEST = process.env.MANIFEST ?? 'web/wwwroot/examples.json';
const SERVICE = process.env.SERVICE ?? 'http://127.0.0.1:5090';

async function compile(source) {
    const response = await fetch(`${SERVICE}/compile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source })
    });

    return response.json();
}

async function main() {
    const { examples } = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

    let failed = 0;

    for (const example of examples) {
        const result = await compile(example.source);

        if (result.ok) {
            console.log(`ok    ${example.slug}`);
        } else {
            failed++;
            console.error(`FAIL  ${example.slug}`);
            for (const d of result.diagnostics ?? []) {
                console.error(`      ${d.startLine},${d.startColumn}: ${d.severity}: ${d.message}`);
            }
        }
    }

    console.log(`${examples.length - failed}/${examples.length} compiled`);
    process.exit(failed ? 1 : 0);
}

main().catch(error => { console.error(error); process.exit(1); });
