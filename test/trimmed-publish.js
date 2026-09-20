// Did the publish keep every assembly the compile service will let a program
// name?
//
//   node test/trimmed-publish.js <published wwwroot/_framework>
//
// The failure this guards against is silent and only shows up in a reader's
// browser: the editor accepts a reference, the compile service compiles it, and
// the assembly it resolved to is not in the published output, so the program
// loads and dies. The whitelist is the authority for what may be named, so the
// check is that each entry, and each assembly the host itself needs, came out
// the other side.

const { readdirSync, statSync } = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = process.argv[2];

if (!dir) {
    console.error('usage: node test/trimmed-publish.js <published wwwroot/_framework>');
    process.exit(2);
}

const roots = execFileSync('node', [path.join(__dirname, '../scripts/trimmer-roots.js')], { encoding: 'utf8' })
    .trim().split(';').filter(Boolean);

// Published assemblies are WebCIL wrapped in wasm and fingerprinted, so the
// name to match is everything before the fingerprint.
const published = new Map();

for (const file of readdirSync(dir)) {
    const m = /^(.+?)(?:\.[a-z0-9]{10})?\.wasm$/.exec(file);
    if (m) published.set(m[1], statSync(path.join(dir, file)).size);
}

let failures = 0;

for (const root of roots) {
    if (!published.has(root)) { console.log(`FAIL  missing: ${root}`); failures++; }
}

const dropped = [...published.keys()].filter(n => !roots.includes(n) && !/^dotnet/.test(n));

console.log(`ok    ${roots.length - failures} of ${roots.length} named assemblies published`);
console.log(`      ${published.size} assemblies in the output, ${dropped.length} of them beyond the named set`);

if (failures) {
    console.log(`\n${failures} assembly(ies) the compile service accepts are not in the published output.`);
    process.exit(1);
}
