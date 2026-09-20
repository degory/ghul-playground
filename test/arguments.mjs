// The arguments field's quoting, in both directions, and the round trip over
// the real run.args files in ghul-rosetta-code.
//
//   node test/arguments.mjs
//   ROSETTA=../ghul-rosetta-code node test/arguments.mjs
//
// The round trip is what matters: whatever a task's file says, the program has
// to receive exactly that, and whatever a reader types has to survive being
// shown back to them.

import { readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import { parseArguments, renderArguments, argumentsFromFile } from '../web/wwwroot/arguments.js';

let failures = 0;

const check = (what, ok, detail = '') => {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${ok || !detail ? '' : `: ${detail}`}`);
};

const same = (what, actual, expected) =>
    check(what, JSON.stringify(actual) === JSON.stringify(expected),
        `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);

// --- reading a line ------------------------------------------------------

same('whitespace separates arguments', parseArguments('a b  c'), ['a', 'b', 'c']);
same('leading and trailing space is not an argument', parseArguments('  a  '), ['a']);
same('an empty line is no arguments at all', parseArguments(''), []);
same('double quotes hold a space', parseArguments('-c "alpha beta" -h'), ['-c', 'alpha beta', '-h']);
same('single quotes do too', parseArguments("-c 'alpha beta'"), ['-c', 'alpha beta']);
same('a quote can be escaped', parseArguments('"say \\"hello\\""'), ['say "hello"']);
same('a backslash can be escaped', parseArguments('"a\\\\b"'), ['a\\b']);
same('a single-quoted backslash stands for itself', parseArguments("'a\\b'"), ['a\\b']);
same('quotes can open and close mid-argument', parseArguments('a"b c"d'), ['ab cd']);
same('an empty argument is writable', parseArguments('a "" b'), ['a', '', 'b']);

// Half-typed rather than wrong: the field is read on every run, including
// while somebody is still typing in it.
same('an unterminated quote gives what has been typed', parseArguments('a "b c'), ['a', 'b c']);
same('a trailing backslash does too', parseArguments('a b\\'), ['a', 'b']);

// --- writing a line ------------------------------------------------------

same('a plain argument is left alone', renderArguments(['a', 'b']), 'a b');
same('one with a space is quoted', renderArguments(['alpha beta']), '"alpha beta"');
same('one with a quote is escaped', renderArguments(['say "hello"']), '"say \\"hello\\""');
same('one with a backslash is escaped', renderArguments(['a\\b']), '"a\\\\b"');
same('an empty argument is quoted', renderArguments(['']), '""');
same('no arguments is an empty line', renderArguments([]), '');

// --- the round trip ------------------------------------------------------

const roundTrip = args =>
    check(`${JSON.stringify(args)} survives being shown and read back`,
        JSON.stringify(parseArguments(renderArguments(args))) === JSON.stringify(args),
        `through ${JSON.stringify(renderArguments(args))} to ${JSON.stringify(parseArguments(renderArguments(args)))}`);

for (const args of [
    ['-c', 'alpha beta', '-h', 'gamma'],
    ['1A Na15ZQXAZUgFiqJ2i7Z2DPU2J6hW62i'],
    ['say "hello"'],
    ["it's"],
    ['back\\slash'],
    ['"'],
    ['\\'],
    [''],
    ['  leading and trailing  '],
    ['tab\there']
]) roundTrip(args);

// --- a task's file -------------------------------------------------------

same('one argument a line', argumentsFromFile('-c\nalpha beta\n-h\n'), ['-c', 'alpha beta', '-h']);
same('a CRLF file reads the same', argumentsFromFile('a\r\nb\r\n'), ['a', 'b']);
same('an empty file is no arguments', argumentsFromFile(''), []);

// Checked out beside this repository, or beside the workspace that holds its
// worktrees. ROSETTA names it anywhere else.
const corpus = [
    process.env.ROSETTA,
    path.join(import.meta.dirname, '../../ghul-rosetta-code'),
    path.join(import.meta.dirname, '../../../../ghul-rosetta-code')
].find(candidate => candidate && existsSync(path.join(candidate, 'tasks')));

if (corpus) {
    const tasks = readdirSync(path.join(corpus, 'tasks'));
    let found = 0;

    for (const task of tasks) {
        const file = path.join(corpus, 'tasks', task, 'run.args');

        if (!existsSync(file)) continue;

        found++;

        const args = argumentsFromFile(readFileSync(file, 'utf8'));

        check(`${task}'s arguments survive the round trip`,
            JSON.stringify(parseArguments(renderArguments(args))) === JSON.stringify(args),
            `${JSON.stringify(args)} through ${JSON.stringify(renderArguments(args))}`);
    }

    check('there were task argument files to check', found > 0, `${found} found`);
} else {
    console.log('ok    (no ghul-rosetta-code beside this repository; set ROSETTA to check against it)');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
