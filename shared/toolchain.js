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

// What user code can name. The test for an entry is whether it *runs* in the
// wasm host, not whether it is safe: nothing here reaches the server, which
// only compiles, and the browser sandbox is what bounds the program. Two
// families stay out on that test alone. `System.Runtime.InteropServices.JavaScript`
// would let a program script the hosting page, and it is the one exclusion
// that matters to anyone but the author. `System.Net.Http` is the browser's
// fetch, which makes every visitor's browser a network egress under our
// origin.
//
// This does NOT deny the filesystem: `System.Runtime` type-forwards the
// `System.IO` surface and cannot be dropped, so `IO.File.read_all_text`
// compiles under any set that also compiles ghūl. That is survivable only
// because compiled code runs in the browser, which has no host filesystem.
//
// The list has to be closed under assembly reference. A type whose signature
// names an assembly that is not loaded fails to materialise with a warning,
// and then reports as a missing member - `Regex` did exactly that while
// `System.Reflection.Emit.ILGeneration` was absent. The entries marked as
// closure are there for that reason and nothing names them directly.
const REFERENCES = [
    'System.Runtime',
    'System.Console',
    'System.Collections',
    'System.Collections.Concurrent',
    'System.Linq',
    'System.Memory',
    'System.Runtime.Extensions',
    'System.Runtime.Numerics',
    'System.Text.Json',
    'System.Text.RegularExpressions',
    'System.Threading',
    // The program runs on a worker thread, so Thread.sleep pauses it without
    // stopping the page - which is how an animation paces its frames.
    'System.Threading.Thread',
    'System.Threading.Tasks.Parallel',
    // closure of System.Text.RegularExpressions
    'System.Reflection.Emit.ILGeneration',
    'System.Diagnostics.StackTrace',
    'System.Reflection.Primitives',
    'System.Runtime.InteropServices',
    // closure of System.Text.Json
    'System.IO.Pipelines',
    'System.Text.Encodings.Web'
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

// Drawing. Held to the same rule as the runtime: the web app ships this exact
// assembly, so what is compiled against here is what the browser binds.
//
// It is a ghūl library like any other and needs nothing from the host, which
// is the point - a program here draws into a buffer and writes a PNG in
// managed code, where a graphics stack would need a native library the wasm
// host does not have.
async function resolveRaster() {
    if (process.env.GHUL_RASTER_DLL) {
        return process.env.GHUL_RASTER_DLL;
    }

    const packages = path.join(process.env.HOME, '.nuget', 'packages', 'ghul.raster');
    const version = highestVersion(await readdir(packages));

    return path.join(packages, version, 'lib', 'net10.0', 'ghul-raster.dll');
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

// Every reference as an absolute path: the ghūl assemblies first, then the
// framework ones. Both services build their arguments from this one list.
async function resolveReferencePaths() {
    const [referencePack, runtime, raster] = await Promise.all([
        resolveReferencePack(), resolveRuntime(), resolveRaster()
    ]);

    const paths = [runtime, raster, ...REFERENCES.map(r => path.join(referencePack, `${r}.dll`))];

    // A missing entry would not fail here: the compiler loads what it finds
    // and the gap surfaces later as a baffling missing member. Refuse to
    // start instead, so a renamed assembly is a failed deploy.
    const missing = paths.filter(p => !existsSync(p));
    if (missing.length > 0) {
        throw new Error(`reference assemblies not found: ${missing.join(', ')}`);
    }

    return paths;
}

module.exports = {
    REFERENCES,
    highestVersion,
    resolveCompiler,
    resolveRuntime,
    resolveRaster,
    resolveReferencePack,
    resolveReferencePaths
};
