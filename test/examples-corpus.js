// Every entry in the standalone page's example menu, through the compile
// service.
//
// The menu's sources are copied from degory/ghul-rosetta-code at build time
// (scripts/build-examples.js), and this is the check that each one still
// compiles cleanly under the playground's own pinned compiler and
// deliberately short reference list - so a menu entry that would fail for a
// visitor, or draw a remark about itself, fails the build instead. A warning
// counts: these are the programs the menu offers as worth reading.
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

        const report = label => {
            console.error(`${label}  ${example.slug}`);
            for (const d of result.diagnostics ?? []) {
                console.error(`      ${d.startLine},${d.startColumn}: ${d.severity}: ${d.message}`);
            }
        };

        // A warning counts as a failure here. These are the programs the
        // menu offers as worth reading, so a visitor who opens one and
        // compiles it should see a clean result, not a remark about the
        // example itself.
        const warnings = (result.diagnostics ?? []).filter(d => d.severity !== 'error');

        if (!result.ok) {
            failed++;
            report('FAIL');
        } else if (warnings.length > 0) {
            failed++;
            report('WARN');
        } else {
            console.log(`ok    ${example.slug}`);
        }
    }

    console.log(`${examples.length - failed}/${examples.length} compiled cleanly`);
    process.exit(failed ? 1 : 0);
}

main().catch(error => { console.error(error); process.exit(1); });
