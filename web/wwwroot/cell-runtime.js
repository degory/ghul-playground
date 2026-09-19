// Runs the cells of an interactive session, in a frame the page can throw away.
//
// A cell runs on the .NET runtime in a hidden cell host frame. Managed code on
// another thread cannot be interrupted from the browser, so stopping a cell
// that will not finish means ending its runtime, and removing the frame does
// that without touching the page around it. The session goes with it: every
// cell the frame had run is gone, and the next cell starts a new session.

export class CellRuntime {
    constructor(container = document.body) {
        this.container = container;
        this.frame = null;
        this.ready = null;
        this.pending = new Map();
        this.nextId = 1;

        this._onMessage = event => this._receive(event);

        window.addEventListener('message', this._onMessage);
    }

    // The host page's text, fetched once. It is loaded into the frame as
    // `srcdoc` rather than by URL: a document written that way inherits this
    // page's origin and its cross-origin isolation, which the threaded runtime
    // needs, whatever headers the server sends for the host page itself.
    static _hostPage = null;

    static _loadHostPage() {
        // Relative to the document's base, so the host moves with the page.
        CellRuntime._hostPage ??= fetch(new URL('cell-host.html', document.baseURI))
            .then(response => response.text())
            .then(text => text.replace('<head>', `<head><base href="${document.baseURI}">`));

        return CellRuntime._hostPage;
    }

    _start() {
        const frame = document.createElement('iframe');

        frame.hidden = true;
        frame.setAttribute('aria-hidden', 'true');

        this.ready = new Promise(resolve => { this._resolveReady = resolve; });
        this.frame = frame;

        CellRuntime._loadHostPage().then(text => {
            // Stopped while the page was being fetched.
            if (this.frame !== frame) return;

            frame.srcdoc = text;
            this.container.appendChild(frame);
        });
    }

    _receive(event) {
        if (!this.frame || event.source !== this.frame.contentWindow) return;
        if (event.origin !== location.origin) return;

        const data = event.data ?? {};

        if (data.ready) {
            this._resolveReady();
            return;
        }

        const waiter = this.pending.get(data.id);

        if (waiter) {
            this.pending.delete(data.id);
            waiter.resolve(data.result);
        }
    }

    // Runs a cell, answering `{text, value?, error?}`, or `{stopped: true}` if
    // the session is stopped before it finishes.
    run(assembly, submission) {
        return this.call('run', assembly, submission);
    }

    // One of the host's operations - see cell-host.js - answering its result,
    // or `{stopped: true}` if the session is stopped before it finishes.
    async call(op, ...args) {
        if (!this.frame) this._start();

        await this.ready;

        // Stopped while the host was starting.
        if (!this.frame) return { stopped: true };

        const id = this.nextId++;

        return new Promise(resolve => {
            this.pending.set(id, { resolve });
            this.frame.contentWindow.postMessage({ id, op, args }, location.origin);
        });
    }

    // Whether a cell is running or waiting to.
    get busy() {
        return this.pending.size > 0;
    }

    // Ends the session: the frame and its runtime go, anything running or
    // waiting answers as stopped, and the next cell starts a new session.
    stop() {
        for (const { resolve } of this.pending.values()) {
            resolve({ stopped: true });
        }

        this.pending.clear();

        // A call waiting for the host to start sees the frame gone and answers
        // as stopped.
        this._resolveReady?.();
        this._resolveReady = null;

        this.frame?.remove();
        this.frame = null;
        this.ready = null;
    }

    dispose() {
        this.stop();
        window.removeEventListener('message', this._onMessage);
    }
}
