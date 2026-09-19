// The REPL's entry page for ghul.dev, where the REPL is served at /repl/ and
// the playground's files at /playground/.
//
// It is repl.html with one addition: a base naming the playground's directory,
// so every file, the .NET runtime and the services are reached there and shared
// with the playground page rather than served twice. The base is relative, so
// it holds under any prefix that keeps the two directories side by side. It has
// to come first in <head>, before the import map and the preload the build
// fills in, which resolve against it.
//
//   node scripts/repl-entry.js <published wwwroot>
//
// writes repl-entry.html beside repl.html. Run after publishing, so the page
// carries the fingerprinted names the build wrote into repl.html.

const fs = require('fs');
const path = require('path');

const PLAYGROUND_BASE = '../playground/';

function replEntry(html) {
    if (!html.includes('<head>')) throw new Error('repl.html has no <head>');

    return html.replace('<head>', `<head>\n  <base href="${PLAYGROUND_BASE}">`);
}

module.exports = { replEntry, PLAYGROUND_BASE };

if (require.main === module) {
    const root = process.argv[2];

    if (!root) {
        console.error('usage: node scripts/repl-entry.js <published wwwroot>');
        process.exit(2);
    }

    const html = fs.readFileSync(path.join(root, 'repl.html'), 'utf8');

    fs.writeFileSync(path.join(root, 'repl-entry.html'), replEntry(html));

    console.log(`wrote ${path.join(root, 'repl-entry.html')}`);
}
