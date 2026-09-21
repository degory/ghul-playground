// The identifier and operator patterns on their own: what the editor treats
// as a name and what it treats as an operator.
//
//   node test/language-patterns.mjs

import { GHUL_LANGUAGE } from '../web/wwwroot/ghul-language.js';

let failures = 0;

function check(what, ok, detail = '') {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  ${detail}` : ''}`);
}

const whole = (pattern, text) => {
    const m = new RegExp(`^(?:${pattern.source})$`, pattern.flags).exec(text);
    return m !== null;
};

const name = text => {
    const { identifierStart: start, identifierPart: part } = GHUL_LANGUAGE;
    return whole(new RegExp(`${start.source}(?:${part.source})*`, 'u'), text);
};

for (const text of ['value', '_private', 'v1', 'café', 'ТИП', '説明', 'μέγεθος', 'naïve', 'الاسم', '$anon']) {
    check(`${text} is one identifier`, name(text));
}

for (const text of ['×', '∪', '+', '1st', 'a b']) {
    check(`${text} is not an identifier`, !name(text));
}

for (const text of ['+', '=~', '|>', '/\\', '×', '∪', '⊕']) {
    check(`${text} is one operator run`, whole(GHUL_LANGUAGE.symbols, text));
}

// The backtick escapes an identifier; reading it as an operator would take
// the name after it with it.
for (const text of ['`', 'a', 'é', '1']) {
    check(`${text} is not an operator`, !whole(GHUL_LANGUAGE.symbols, text));
}

// Monarch expands an `@name` reference to that attribute's source before it
// compiles a rule, including inside another attribute. Expanded here the same
// way, so what is checked is the character classes rather than the expansion.
const expand = pattern => new RegExp(
    pattern.source.replace(/@(\w+)/g, (_, name) => `(?:${GHUL_LANGUAGE[name].source})`),
    'u');

const escaped = expand(GHUL_LANGUAGE.escapedName);

// An operator used as a value is escaped the same way a keyword is, so a
// non-ASCII operator escapes too.
for (const text of ['`class', '`0', '`+', '`=~', '`caf\u00e9', '`\u00d7']) {
    check(`${text} is an escaped name`, whole(escaped, text));
}

for (const text of ['class', '`', '`(', '``']) {
    check(`${text} is not an escaped name`, !whole(escaped, text));
}

check('the grammar asks for unicode regular expressions', GHUL_LANGUAGE.unicode === true);

console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
