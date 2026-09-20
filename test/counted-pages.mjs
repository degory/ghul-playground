// A page that sends events has to load the counter, or the events go nowhere.
//
// This is here because that is exactly what happened: repl.js raised every one
// of its events correctly and repl.html carried no counter, so the REPL was
// invisible for as long as it had been up, and nothing said so. Neither the
// page nor the helper can tell - an event with nowhere to go looks the same as
// a page nobody visited - so the check has to be made against the markup.
//
// It reads the sources rather than a published site, so it needs no browser,
// no services and no build, and it covers pages the browser test never opens.
//
//   node test/counted-pages.mjs

import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';

const wwwroot = new URL('../web/wwwroot/', import.meta.url);

let failures = 0;

const check = (what, ok, detail = '') => {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${ok || !detail ? '' : `: ${detail}`}`);
};

const read = name => readFileSync(new URL(name, wwwroot), 'utf8');

// The publish fingerprints a page's own module, so the name in the markup
// carries a placeholder the file on disk does not.
const unfingerprinted = src => src.replace(/#\[\.\{fingerprint\}\]/, '');

// Every module a page reaches, following relative imports from the one its
// markup names. Only relative specifiers are followed: anything else is not a
// file of ours.
function modulesReachedBy(entry) {
    const seen = new Set();
    const queue = [entry];

    while (queue.length) {
        const name = queue.shift();

        if (seen.has(name)) continue;
        seen.add(name);

        let source;

        try {
            source = read(name);
        } catch {
            // A module the markup names and the tree does not have is the
            // build's problem to report, not this check's.
            continue;
        }

        for (const [, specifier] of source.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*from\s*['"](\.[^'"]+)['"]/g)) {
            queue.push(specifier.replace(/^\.\//, ''));
        }
    }

    return seen;
}

// embed.html deliberately carries no counter, and is the one page that is
// checked for carrying none. It loads on every example edit on ghul.dev, where
// the edit is already counted by the example's own event with the example's
// name attached; counting the frame as well would count one act twice and say
// less about it than the event it duplicated. It is named here rather than
// passed over silently, so that giving it a counter is a decision somebody
// makes rather than a check nobody notices, and so that the exception fails
// loudly if the page ever starts sending events of its own.
const NOT_COUNTED = ['embed.html'];

const pages = readdirSync(fileURLToPath(wwwroot)).filter(name => name.endsWith('.html')).sort();

check('there are pages to check', pages.length > 0, `${pages.length} found`);

for (const page of pages) {
    const markup = read(page);
    const entry = /<script[^>]*type=['"]module['"][^>]*src=['"]([^'"]+)['"]/.exec(markup)?.[1];

    // A page with no module of its own runs no code of ours and sends nothing.
    if (!entry) continue;

    const sends = modulesReachedBy(unfingerprinted(entry)).has('events.js');
    const counts = /id=['"]goatcounter['"]/.test(markup);

    if (NOT_COUNTED.includes(page)) {
        check(`${page} deliberately counts nothing`, !counts && !sends,
            counts
                ? 'it now carries a counter, so either the counter or this exception is wrong'
                : 'it now sends events, which it has no counter to deliver');
        continue;
    }

    if (!sends) {
        check(`${page} sends no events`, true);
        continue;
    }

    check(`${page} sends events and loads the counter`, counts,
        'no element with id="goatcounter", so every event it sends goes nowhere');
}

console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
