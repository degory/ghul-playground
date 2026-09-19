// What a REPL cell's output stream becomes on the page: the text it wrote,
// with what it showed through display and update_display in its place among
// that text. See Playground.DISPLAY_RECORDS in the runner for the stream's
// shape: a record is OPEN, a JSON object, then CLOSE, and the runner replaces
// both markers in anything the cell prints itself.
//
// Everything is put on the page as text. An id is a key in a map and nothing
// else, never an element id or a selector, since the cell chose it.

export const OPEN = String.fromCharCode(1);
export const CLOSE = String.fromCharCode(2);

export class CellOutput {
    constructor(container) {
        this.container = container;
        this.nodes = [];
        this.displays = new Map();
        this.text = null;
        this.pending = '';
    }

    // Takes the next part of the stream. A record split across two parts is
    // held until the rest of it arrives.
    feed(chunk) {
        const data = this.pending + chunk;

        this.pending = '';

        let at = 0;

        while (at < data.length) {
            const open = data.indexOf(OPEN, at);

            if (open < 0) {
                this._write(data.slice(at));
                return;
            }

            this._write(data.slice(at, open));

            const close = data.indexOf(CLOSE, open + 1);

            if (close < 0) {
                this.pending = data.slice(open);
                return;
            }

            this._record(data.slice(open + 1, close));

            at = close + 1;
        }
    }

    // Takes everything off the page again.
    clear() {
        for (const node of this.nodes) node.remove();

        this.nodes = [];
        this.displays.clear();
        this.text = null;
        this.pending = '';
    }

    _write(text) {
        if (!text) return;

        if (!this.text) {
            this.text = this._add('output');
        }

        this.text.append(text);
    }

    _record(json) {
        let record;

        try {
            record = JSON.parse(json);
        } catch {
            return;
        }

        const content = record?.parts?.find?.(part => part?.mime === 'text/plain')?.content;

        if (typeof content !== 'string') return;

        const id = typeof record.id === 'string' ? record.id : null;

        if (record.kind === 'show') {
            const node = this._add('display');

            node.textContent = content;

            // What the cell writes next goes after this, not into the text
            // before it.
            this.text = null;

            if (id !== null) this.displays.set(id, node);
        } else if (record.kind === 'update' && id !== null) {
            const node = this.displays.get(id);

            if (node) node.textContent = content;
        }
    }

    _add(className) {
        const node = document.createElement('div');

        node.className = className;
        this.container.appendChild(node);
        this.nodes.push(node);

        return node;
    }
}
