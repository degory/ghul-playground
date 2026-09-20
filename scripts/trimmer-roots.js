// The assemblies the trimmer must keep whole, as a semicolon-separated list for
// MSBuild.
//
// Read from shared/toolchain.js rather than written out again here. The two
// lists have to be the same list: a reference the compile service accepts whose
// assembly the trimmer removed is a program that compiles in the editor and
// fails to load in the browser, which is the one failure this must not be able
// to have.
//
//   node scripts/trimmer-roots.js

const { REFERENCES } = require('../shared/toolchain');

// What the host itself reaches, which the whitelist says nothing about: the
// runner is loaded and driven by reflection, the interop layer is how the page
// calls into it, and the rest is what those two pull in that nothing in the
// whitelist does.
const HOST = [
    'ghul-runtime',
    'ghul-raster',
    'ghul.repl',
    'runner',
    'System.Private.CoreLib',
    'System.Runtime.InteropServices.JavaScript',
    'System.Runtime.Loader',
    'System.Reflection',
    'System.Reflection.Metadata',
    'System.Reflection.Emit.Lightweight'
];

// One per line: MSBuild turns each line of a captured console output into its
// own item, where a semicolon-separated property would arrive escaped and be
// read as a single assembly name.
for (const name of [...new Set([...REFERENCES, ...HOST])].sort()) console.log(name);
