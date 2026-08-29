// Build wwwroot/examples.json from the ghūl Rosetta Code solutions.
//
// The picker on the standalone page offers a menu of complete programs. Each
// entry's source is copied from a checkout of degory/ghul-rosetta-code at
// build time, so the menu stays current with the solutions - and CI compiles
// every entry through the compile service (test/examples-corpus.js), so an
// entry that does not build under the playground's pinned compiler and
// reference list fails the build rather than the visitor.
//
//   ROSETTA=../ghul-rosetta-code node scripts/build-examples.js

const fs = require('fs');
const path = require('path');

const ROSETTA = process.env.ROSETTA ?? '../ghul-rosetta-code';
const OUT = process.env.OUT ?? path.join(__dirname, '..', 'web', 'wwwroot', 'examples.json');

// The menu, in display order. Chosen for breadth - each entry shows a part of
// the language the others do not - from the solutions that compile against the
// service's deliberately short reference list.
const MENU = [
    ['hello-world-text', 'hello world'],
    ['100-doors', '100 doors'],
    ['fizzbuzz', 'fizzbuzz'],
    ['hailstone-sequence', 'hailstone sequence'],
    ['algebraic-data-types', 'algebraic data types'],
    ['arithmetic-evaluation', 'arithmetic evaluation'],
    ['tree-traversal', 'tree traversal'],
    ['huffman-coding', 'Huffman coding'],
    ['sieve-of-eratosthenes', 'sieve of Eratosthenes'],
    ['sorting-algorithms-quicksort', 'quicksort'],
    ['roman-numerals-encode', 'Roman numerals'],
    ['closures-value-capture', 'closures: value capture'],
    ['anonymous-recursion', 'anonymous recursion'],
    ['church-numerals', 'Church numerals'],
    ['quine', 'quine'],
];

const examples = MENU.map(([slug, title]) => {
    const file = path.join(ROSETTA, 'tasks', slug, `${slug}.ghul`);
    return { slug, title, source: fs.readFileSync(file, 'utf8') };
});

fs.writeFileSync(OUT, JSON.stringify({ examples }, null, 1));
console.log(`${examples.length} example(s) -> ${OUT}`);
