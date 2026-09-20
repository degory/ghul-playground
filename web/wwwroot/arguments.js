// The arguments a program is run with, as one line of text.
//
// A task's `run.args` holds one argument a line, which is exact but reads
// naturally to nobody who has not seen that file. The field shows them the way
// a command line does, because that is the notation anybody running a program
// that takes arguments already knows, and it keeps the row one row - which is
// what the pane can afford.
//
// That needs a quoting rule, because an argument containing a space is not a
// corner case: `alpha beta` is one argument of Rosetta's Command-line
// arguments, and one of Bitcoin/address validation's addresses is invalid
// precisely because it has a space in it. So the rule has to be exact in both
// directions, which is what the test checks.
//
// Nothing here touches the document, and nothing here is ever recorded: what a
// reader types is theirs.

// Whitespace separates arguments. Single and double quotes each protect a run
// of characters, and a backslash protects the character after it, inside double
// quotes or outside any. Single quotes protect a backslash too, as a shell's
// do, so an argument full of them can be written without doubling every one.
export function parseArguments(text) {
    const args = [];

    let current = null;
    let quote = null;
    let escaped = false;

    for (const character of text ?? '') {
        if (escaped) {
            current = (current ?? '') + character;
            escaped = false;
            continue;
        }

        if (character === '\\' && quote !== "'") {
            escaped = true;
            current ??= '';
            continue;
        }

        if (quote) {
            if (character === quote) quote = null;
            else current = (current ?? '') + character;
            continue;
        }

        if (character === '"' || character === "'") {
            quote = character;
            current ??= '';
            continue;
        }

        if (/\s/.test(character)) {
            if (current !== null) args.push(current);
            current = null;
            continue;
        }

        current = (current ?? '') + character;
    }

    // An unterminated quote or a trailing backslash is a half-typed argument
    // rather than an error: the field is read on every run, including while
    // somebody is still typing in it.
    if (current !== null) args.push(current);

    return args;
}

// The other direction. An argument is left bare where it can be read back
// unambiguously, and double-quoted otherwise, so the common line stays free of
// punctuation nobody needs.
export function renderArguments(args) {
    return (args ?? [])
        .map(argument => /^[^\s'"\\]+$/.test(argument)
            ? argument
            : `"${argument.replace(/([\\"])/g, '\\$1')}"`)
        .join(' ');
}

// A task's run.args file: one argument a line, and nothing else. A blank line
// is not an empty argument - the file is written by hand and ends in a newline.
export function argumentsFromFile(text) {
    return (text ?? '').split('\n').filter(line => line !== '').map(line => line.replace(/\r$/, ''));
}
