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

// The raster formats the page puts in an image. Anything else a value offers -
// markup above all - is never shown as itself, only as the value's text.
const PICTURE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif']);

// The runner leaves out a picture past this; checked here as well, so the page
// holds to it whatever it is sent.
export const MAX_PICTURE_BYTES = 4 * 1024 * 1024;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

// Fills `node` with a shown value: its picture where it offers one the page
// shows, with the text as the image's alternative, and otherwise its text,
// with a note where a picture was offered and could not be shown. `picture`
// is a part as the runner writes it - see Playground.PICTURE.
export function showValue(node, text, picture) {
    const content = picture?.content;

    if (PICTURE_TYPES.has(picture?.mime) && typeof content === 'string' && BASE64.test(content)
        && decodedSize(content) <= MAX_PICTURE_BYTES) {
        const image = document.createElement('img');

        image.alt = text;
        image.src = `data:${picture.mime};base64,${content}`;
        node.replaceChildren(image);
        return;
    }

    node.replaceChildren(text);

    const note = pictureNote(picture);

    if (note) {
        const span = document.createElement('span');

        span.className = 'picture-note';
        span.textContent = `\n${note}`;
        node.append(span);
    }
}

function decodedSize(base64) {
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;

    return Math.floor(base64.length / 4) * 3 - padding;
}

function pictureNote(picture) {
    if (!PICTURE_TYPES.has(picture?.mime)) return null;

    if (picture.deferred === true) return '(its picture is shown when the cell finishes)';

    const size = typeof picture.omitted === 'number' ? picture.omitted
        : typeof picture.content === 'string' ? decodedSize(picture.content) : null;

    if (size !== null && size > MAX_PICTURE_BYTES) {
        return `(its picture is ${(size / 1048576).toFixed(1)} MB, over the ${MAX_PICTURE_BYTES / 1048576} MB shown here)`;
    }

    return null;
}

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

        const parts = Array.isArray(record?.parts) ? record.parts : [];
        const text = parts.find(part => part?.mime === 'text/plain')?.content;

        if (typeof text !== 'string') return;

        const picture = parts.find(part => part?.mime !== 'text/plain');
        const id = typeof record.id === 'string' ? record.id : null;

        if (record.kind === 'show') {
            const node = this._add('display');

            showValue(node, text, picture);

            // What the cell writes next goes after this, not into the text
            // before it.
            this.text = null;

            if (id !== null) this.displays.set(id, node);
        } else if (record.kind === 'update' && id !== null) {
            const node = this.displays.get(id);

            if (node) showValue(node, text, picture);
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
