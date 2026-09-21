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

check('the grammar asks for unicode regular expressions', GHUL_LANGUAGE.unicode === true);

console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
