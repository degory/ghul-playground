// Bumps the compiler and/or runtime version at every site check-versions.js
// checks, so a bump is one edit instead of five kept in sync by hand - the
// history this repository has is exactly the other way round, a version
// landing in four of the five sites and check-versions.js catching it after
// the fact.
//
//   node scripts/bump-versions.js --compiler 52.2.1
//   node scripts/bump-versions.js --runtime 18.0.1
//   node scripts/bump-versions.js --compiler 52.2.1 --runtime 18.0.1
//   node scripts/bump-versions.js --latest
//
// `--latest` resolves each version's current highest listed release on
// nuget.org and bumps both; an explicit `--compiler`/`--runtime` bumps only
// what it names. Running with neither prints the current versions and does
// nothing.

const fs = require('fs');
const path = require('path');
const https = require('https');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const write = (f, text) => fs.writeFileSync(path.join(root, f), text);

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'user-agent': 'ghul-playground-bump-versions' } }, res => {
            if (res.statusCode !== 200) {
                reject(new Error(`${url}: HTTP ${res.statusCode}`));
                res.resume();
                return;
            }

            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (err) {
                    reject(new Error(`${url}: ${err.message}`));
                }
            });
        }).on('error', reject);
    });
}

// Highest stable version nuget.org lists for a package - prereleases
// (anything with a `-`) are never what a routine bump wants.
async function latestPublished(packageId) {
    const index = await fetchJson(`https://api.nuget.org/v3-flatcontainer/${packageId}/index.json`);

    const stable = index.versions.filter(v => !v.includes('-'));

    stable.sort((a, b) => {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);

        for (let i = 0; i < 3; i++) {
            if (pa[i] !== pb[i]) return pa[i] - pb[i];
        }

        return 0;
    });

    return stable[stable.length - 1];
}

function bumpCompiler(version) {
    const manifestFile = '.config/dotnet-tools.json';
    const original = read(manifestFile);
    const before = JSON.parse(original).tools['ghul.compiler'].version;

    // A regex substitution rather than a parse/stringify round-trip, so a
    // manifest with no trailing newline (or different indentation) is left
    // exactly as it was apart from the one field this bump changes.
    const updated = original.replace(
        /("ghul\.compiler":\s*\{\s*"version":\s*")[^"]+(")/,
        `$1${version}$2`
    );

    if (updated === original) {
        throw new Error(`${manifestFile}: no ghul.compiler version to update`);
    }

    write(manifestFile, updated);

    for (const image of ['compile-service/Dockerfile', 'analyse-service/Dockerfile']) {
        const text = read(image);
        const updated = text.replace(/^ARG GHUL_COMPILER_VERSION=.+$/m, `ARG GHUL_COMPILER_VERSION=${version}`);

        if (updated === text) {
            throw new Error(`${image}: no ARG GHUL_COMPILER_VERSION line to update`);
        }

        write(image, updated);
    }

    console.log(`compiler: ${before} -> ${version}`);
}

function bumpRuntime(version) {
    let before;

    for (const project of ['web/web.csproj', 'runner/runner.ghulproj']) {
        const text = read(project);
        const match = text.match(/Include="ghul\.runtime"\s+Version="([^"]+)"/);

        if (!match) {
            throw new Error(`${project}: no ghul.runtime PackageReference`);
        }

        before = match[1];

        const updated = text.replace(
            /(Include="ghul\.runtime"\s+Version=")[^"]+(")/,
            `$1${version}$2`
        );

        write(project, updated);
    }

    for (const image of ['compile-service/Dockerfile', 'analyse-service/Dockerfile']) {
        const text = read(image);
        const updated = text.replace(/^ARG GHUL_RUNTIME_VERSION=.+$/m, `ARG GHUL_RUNTIME_VERSION=${version}`);

        if (updated === text) {
            throw new Error(`${image}: no ARG GHUL_RUNTIME_VERSION line to update`);
        }

        write(image, updated);
    }

    console.log(`runtime: ${before} -> ${version}`);
}

async function main() {
    const args = process.argv.slice(2);
    const wantLatest = args.includes('--latest');

    const flagValue = name => {
        const i = args.indexOf(name);
        return i === -1 ? null : args[i + 1];
    };

    let compilerVersion = flagValue('--compiler');
    let runtimeVersion = flagValue('--runtime');

    if (wantLatest) {
        [compilerVersion, runtimeVersion] = await Promise.all([
            compilerVersion || latestPublished('ghul.compiler'),
            runtimeVersion || latestPublished('ghul.runtime'),
        ]);
    }

    if (!compilerVersion && !runtimeVersion) {
        const manifest = JSON.parse(read('.config/dotnet-tools.json'));
        const runtimeMatch = read('web/web.csproj').match(/Include="ghul\.runtime"\s+Version="([^"]+)"/);

        console.log(`compiler: ${manifest.tools['ghul.compiler'].version}`);
        console.log(`runtime:  ${runtimeMatch ? runtimeMatch[1] : '(not found)'}`);
        console.log('\nNothing to do - pass --compiler/--runtime/--latest to bump.');
        return;
    }

    if (compilerVersion) bumpCompiler(compilerVersion);
    if (runtimeVersion) bumpRuntime(runtimeVersion);
}

main().catch(err => {
    console.error(err.message);
    process.exit(1);
});
