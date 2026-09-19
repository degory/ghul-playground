// The REPL's output stream on its own: text, display records among it, and
// records split across the parts the stream arrives in. A few lines of stand-in
// DOM are enough, since the module only makes divs and sets their text.
//
//   node test/cell-output.mjs

let failures = 0;

function check(what, ok, detail = '') {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  ${detail}` : ''}`);
}

class NODE {
    constructor() {
        this.children = [];
        this.parent = null;
        this.className = '';
        this._text = '';
    }

    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    set textContent(value) { this._text = value; this.children = []; }

    append(text) { this._text += text; }

    appendChild(child) {
        child.parent = this;
        this.children.push(child);
        return child;
    }

    remove() {
        if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this);
        this.parent = null;
    }
}

globalThis.document = { createElement: () => new NODE() };

const { CellOutput, OPEN, CLOSE } = await import('../web/wwwroot/cell-output.js');

const record = (kind, id, content) =>
    `${OPEN}${JSON.stringify({ kind, id, parts: [{ mime: 'text/plain', content }] })}${CLOSE}`;

const shape = container => container.children.map(c => [c.className, c.textContent]);

{
    const container = new NODE();
    const output = new CellOutput(container);

    output.feed(`before\n${record('show', null, '[1, 2]')}after\n`);

    check('text and a display keep the order they were written in',
        JSON.stringify(shape(container)) === JSON.stringify([['output', 'before\n'], ['display', '[1, 2]'], ['output', 'after\n']]),
        JSON.stringify(shape(container)));
}

{
    const container = new NODE();
    const output = new CellOutput(container);
    const whole = `a${record('show', 'p', '10%')}b${record('update', 'p', '50%')}c`;

    // Every way of cutting the stream in two gives the same page.
    const shapes = new Set();

    for (let cut = 0; cut <= whole.length; cut++) {
        const inner = new NODE();
        const split = new CellOutput(inner);

        split.feed(whole.slice(0, cut));
        split.feed(whole.slice(cut));
        shapes.add(JSON.stringify(shape(inner)));
    }

    output.feed(whole);

    check('a record split anywhere across two parts is read once, whole',
        shapes.size === 1 && [...shapes][0] === JSON.stringify(shape(container)),
        [...shapes].join(' | '));

    check('update redraws the display with that id in place',
        JSON.stringify(shape(container)) === JSON.stringify([['output', 'a'], ['display', '50%'], ['output', 'bc']]),
        JSON.stringify(shape(container)));
}

{
    const container = new NODE();
    const output = new CellOutput(container);

    output.feed(record('update', 'nobody', 'x'));
    output.feed(`${OPEN}not json${CLOSE}`);
    output.feed(`${OPEN}${JSON.stringify({ kind: 'show', parts: [{ mime: 'image/png', content: 'AAAA' }] })}${CLOSE}`);

    check('an update for an unknown id, a malformed record and one with no text show nothing',
        container.children.length === 0, JSON.stringify(shape(container)));
}

{
    const container = new NODE();
    const output = new CellOutput(container);

    output.feed(`kept${record('show', 'x', 'shown')}`);
    output.clear();

    check('clear takes everything off the page', container.children.length === 0);

    output.feed(record('update', 'x', 'again'));

    check('and forgets the ids it had', container.children.length === 0);
}

console.log(failures ? `${failures} failure(s)` : 'all checks passed');
process.exit(failures ? 1 : 0);
