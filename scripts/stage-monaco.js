// Copies Monaco's prebuilt AMD bundle into the web app's static files.
//
// Monaco is not committed: it is 24 MB of third-party build output whose
// version is already pinned in package.json. This runs from `postinstall`,
// so `npm install` leaves the web app ready to serve.

const { cp, rm, access } = require('fs/promises');
const path = require('path');

const SOURCE = path.join(__dirname, '..', 'node_modules', 'monaco-editor', 'min', 'vs');
const TARGET = path.join(__dirname, '..', 'web', 'wwwroot', 'vs');

(async () => {
    try {
        await access(SOURCE);
    } catch {
        console.error(`monaco-editor not found at ${SOURCE}; run npm install first`);
        process.exit(1);
    }

    // Replace rather than merge, so a version bump cannot leave stale files
    // from the previous one behind.
    await rm(TARGET, { recursive: true, force: true });
    await cp(SOURCE, TARGET, { recursive: true });

    console.log(`staged monaco into ${path.relative(process.cwd(), TARGET)}`);
})();
