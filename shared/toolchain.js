// Where the compiler, the runtime and the reference assemblies are, and which
// references user code is compiled and analysed against.
//
// Shared by both services deliberately. If the analyse service and the compile
// service disagreed about the reference set, the editor would report errors the
// build does not, or stay silent about errors the build reports. They have to
// be the same list.

const { readdir } = require('fs/promises');
const { existsSync } = require('fs');
const path = require('path');

// The capability surface user code can name.
//
// This does NOT deny the filesystem: `System.Runtime` type-forwards the
// `System.IO` surface and cannot be dropped, so `IO.File.read_all_text`
// compiles under any set that also compiles ghūl. That is survivable only
// because compiled code runs in the browser, which has no host filesystem.
// It does deny `System.Net.*` and `System.Diagnostics.Process`, both verified.
//
// `System.Runtime.InteropServices.JavaScript` is excluded on purpose: with
// execution client-side, JS interop would let user code script the hosting
// page.
const REFERENCES = [
    'System.Runtime',
    'System.Console',
    'System.Collections',
    'System.Linq',
    'System.Runtime.Extensions',
    'netstandard',
    'System.Text.RegularExpressions',
    'System.Threading.Tasks',
    'System.Memory'
];

function highestVersion(versions) {
    const key = v => v.split(/[.-]/).map(p => (/^\d+$/.test(p) ? +p : -1));

    return versions.sort((a, b) => {
        const [x, y] = [key(a), key(b)];
        for (let i = 0; i < Math.max(x.length, y.length); i++) {
            if ((x[i] ?? -1) !== (y[i] ?? -1)) return (x[i] ?? -1) - (y[i] ?? -1);
        }
        return 0;
    }).pop();
}

async function resolveCompiler() {
    if (process.env.GHUL_COMPILER_DLL) {
        return process.env.GHUL_COMPILER_DLL;
    }

    const packages = path.join(process.env.HOME, '.nuget', 'packages', 'ghul.compiler');
    const version = highestVersion(await readdir(packages));

    return path.join(packages, version, 'tools', 'net10.0', 'any', 'ghul.dll');
}

// Must be the runtime the web app ships, not the copy bundled with the
// compiler: user code is compiled against this and then bound against whatever
// the browser loaded, so a mismatch fails at load time rather than at compile
// time.
async function resolveRuntime() {
    if (process.env.GHUL_RUNTIME_DLL) {
        return process.env.GHUL_RUNTIME_DLL;
    }

    const packages = path.join(process.env.HOME, '.nuget', 'packages', 'ghul.runtime');
    const version = highestVersion(await readdir(packages));

    return path.join(packages, version, 'lib', 'net10.0', 'ghul-runtime.dll');
}

async function resolveReferencePack() {
    if (process.env.GHUL_REFERENCE_PACK) {
        return process.env.GHUL_REFERENCE_PACK;
    }

    for (const root of ['/usr/lib/dotnet', '/usr/share/dotnet', process.env.DOTNET_ROOT]) {
        if (!root) continue;

        const packs = path.join(root, 'packs', 'Microsoft.NETCore.App.Ref');
        if (!existsSync(packs)) continue;

        const version = highestVersion(await readdir(packs));

        return path.join(packs, version, 'ref', 'net10.0');
    }

    throw new Error('could not find Microsoft.NETCore.App.Ref; set GHUL_REFERENCE_PACK');
}

// Every reference as an absolute path: the runtime first, then the framework
// assemblies. Both services build their arguments from this one list.
async function resolveReferencePaths() {
    const [referencePack, runtime] = await Promise.all([
        resolveReferencePack(), resolveRuntime()
    ]);

    return [runtime, ...REFERENCES.map(r => path.join(referencePack, `${r}.dll`))];
}

module.exports = {
    REFERENCES,
    highestVersion,
    resolveCompiler,
    resolveRuntime,
    resolveReferencePack,
    resolveReferencePaths
};
