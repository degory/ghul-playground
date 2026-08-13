// The compiler and runtime versions are written in five places, and they all
// have to say the same thing.
//
// The services compile user code against one runtime and the browser loads
// another, so a disagreement between the service images and the web app is not
// a build error - it is a program that compiles, downloads, and then fails to
// load, with nothing in the compiler output to explain it. The tool manifest
// matters for the same reason in the other direction: it is what a developer
// gets locally, so a manifest that disagrees with the images means local
// behaviour is not deployed behaviour.
//
// An updater proposing a new version edits each site separately, so this is
// also what catches a bump that landed in four of the five.
//
//   node scripts/check-versions.js

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const sites = [];

function record(file, what, version) {
    sites.push({ file, what, version });
}

// The compiler, as the tool manifest pins it.
const manifest = JSON.parse(read('.config/dotnet-tools.json'));
record('.config/dotnet-tools.json', 'compiler', manifest.tools['ghul.compiler'].version);

// The runtime, as each project references it.
for (const project of ['web/web.csproj', 'runner/runner.ghulproj']) {
    const match = read(project).match(/Include="ghul\.runtime"\s+Version="([^"]+)"/);

    if (!match) {
        console.error(`${project}: no ghul.runtime PackageReference`);
        process.exit(1);
    }

    record(project, 'runtime', match[1]);
}

// Both, as each service image builds them in.
for (const image of ['compile-service/Dockerfile', 'analyse-service/Dockerfile']) {
    const text = read(image);

    for (const [what, arg] of [['compiler', 'GHUL_COMPILER_VERSION'], ['runtime', 'GHUL_RUNTIME_VERSION']]) {
        const match = text.match(new RegExp(`^ARG ${arg}=(.+)$`, 'm'));

        if (!match) {
            console.error(`${image}: no ${arg}`);
            process.exit(1);
        }

        record(image, what, match[1].trim());
    }
}

let failed = false;

for (const what of ['compiler', 'runtime']) {
    const found = sites.filter(s => s.what === what);
    const versions = [...new Set(found.map(s => s.version))];

    if (versions.length === 1) {
        console.log(`${what}: ${versions[0]} in all ${found.length} places`);
        continue;
    }

    failed = true;

    console.error(`${what}: disagreement`);

    for (const site of found) {
        console.error(`    ${site.version.padEnd(12)} ${site.file}`);
    }
}

process.exit(failed ? 1 : 0);
