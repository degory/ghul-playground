// A small LSP client for the analyse service.
//
// Deliberately not `monaco-languageclient`: Monaco's own provider APIs take
// plain callbacks, so speaking LSP directly is a few hundred lines and avoids
// that library's `@codingame/monaco-vscode-*` dependency chain entirely.
//
// The analyser is expected to go away and be replaced by a fresh one with no
// prior state. Every reconnect therefore re-initializes and re-opens the
// document from scratch, which is cheap because there is only ever one file.

// The bridge maps this onto the session's real workspace, so the browser never
// learns or addresses a server path.
const ROOT_URI = 'file:///playground';
const DOCUMENT_URI = `${ROOT_URI}/src/main.ghul`;

// LSP DiagnosticSeverity -> monaco.MarkerSeverity
const SEVERITY = { 1: 8, 2: 4, 3: 2, 4: 1 };

// LSP CompletionItemKind -> monaco.languages.CompletionItemKind. The two
// enumerations do not share numbering, so this cannot be a cast.
const COMPLETION_KIND = {
    1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: 8, 10: 9,
    11: 12, 12: 13, 13: 15, 14: 17, 15: 27, 16: 19, 17: 20, 18: 21,
    19: 23, 20: 16, 21: 14, 22: 22, 23: 18, 24: 11, 25: 24
};

// The token travels as a subprotocol, because a browser cannot set headers on
// a WebSocket and a query parameter would end up in access logs.
const TOKEN_SUBPROTOCOL_PREFIX = 'ghul-playground-token.';

export class GhulLanguageClient {
    constructor(url, { onStatus, getToken } = {}) {
        this.url = url;
        this.onStatus = onStatus ?? (() => { });
        this.getToken = getToken ?? (() => null);

        this.socket = null;
        this.connected = false;
        this.initialized = false;

        this.nextId = 0;
        this.pending = new Map();
        this.version = 0;

        this.model = null;
        this.reconnectDelay = 1000;
        this.disposed = false;
    }

    // Whether queries are worth making. Callers use this to decide between
    // asking the analyser and doing without.
    get ready() {
        return this.connected && this.initialized;
    }

    attach(model) {
        this.model = model;
        this.connect();
    }

    dispose() {
        this.disposed = true;
        this.socket?.close();
    }

    // Drop the current connection and try again now. Used after a token is
    // entered: the previous attempt was refused at the handshake, and the
    // backoff would otherwise leave the editor waiting for up to a minute.
    reconnect() {
        this.reconnectDelay = 1000;

        if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
            // The close handler schedules the retry.
            this.socket.close();
            return;
        }

        this.connect();
    }

    connect() {
        if (this.disposed) return;

        this.onStatus('connecting');

        const token = this.getToken();

        let socket;
        try {
            socket = new WebSocket(this.url, token
                ? ['ghul-playground', TOKEN_SUBPROTOCOL_PREFIX + token]
                : ['ghul-playground']);
        } catch {
            this.scheduleReconnect();
            return;
        }

        this.socket = socket;

        socket.addEventListener('open', () => {
            this.connected = true;
            this.reconnectDelay = 1000;
            this.initialize();
        });

        socket.addEventListener('message', event => this.receive(JSON.parse(event.data)));

        socket.addEventListener('close', () => {
            this.connected = false;
            this.initialized = false;

            // Any in-flight request will never be answered now.
            for (const resolve of this.pending.values()) resolve(null);
            this.pending.clear();

            // Report every failure, including one that never got as far as
            // being ready. Reporting only the ready-then-lost case leaves a
            // service that was never reachable showing "connecting" for ever,
            // which reads as a hung client rather than an absent server.
            this.onStatus('disconnected');
            this.scheduleReconnect();
        });

        socket.addEventListener('error', () => { /* close follows */ });
    }

    scheduleReconnect() {
        if (this.disposed) return;

        setTimeout(() => this.connect(), this.reconnectDelay);
        // Back off to a minute: a service that is down stays down for a while,
        // and a tab left open should not hammer it.
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
    }

    send(method, params, isNotification) {
        if (!this.connected) return null;

        const message = { jsonrpc: '2.0', method, params };
        if (!isNotification) message.id = ++this.nextId;

        this.socket.send(JSON.stringify(message));

        return message.id ?? null;
    }

    request(method, params) {
        const id = this.send(method, params);
        if (id === null) return Promise.resolve(null);

        return new Promise(resolve => {
            this.pending.set(id, resolve);

            // A query that never comes back must not leave the editor waiting.
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    resolve(null);
                }
            }, 10000);
        });
    }

    async initialize() {
        await this.request('initialize', {
            processId: null,
            rootUri: ROOT_URI,
            workspaceFolders: [{ uri: ROOT_URI, name: 'playground' }],
            capabilities: {
                textDocument: {
                    publishDiagnostics: {},
                    hover: { contentFormat: ['markdown', 'plaintext'] },
                    completion: { completionItem: { snippetSupport: false } }
                }
            }
        });

        if (!this.connected) return;

        this.send('initialized', {}, true);

        this.version = 1;
        this.send('textDocument/didOpen', {
            textDocument: {
                uri: DOCUMENT_URI,
                languageId: 'ghul',
                version: this.version,
                text: this.model?.getValue() ?? ''
            }
        }, true);

        this.initialized = true;
        this.onStatus('ready');
    }

    // Whole-document sync. The bridge mirrors it to disk for the analyser, and
    // one file is small enough that computing deltas would buy nothing.
    changed(text) {
        if (!this.ready) return;

        this.send('textDocument/didChange', {
            textDocument: { uri: DOCUMENT_URI, version: ++this.version },
            contentChanges: [{ text }]
        }, true);
    }

    receive(message) {
        if (message.id !== undefined && this.pending.has(message.id)) {
            this.pending.get(message.id)(message);
            this.pending.delete(message.id);
            return;
        }

        if (message.method === 'textDocument/publishDiagnostics') {
            this.publishDiagnostics(message.params?.diagnostics ?? []);
        }
    }

    publishDiagnostics(diagnostics) {
        if (!this.model) return;

        monaco.editor.setModelMarkers(this.model, 'ghul-analyse', diagnostics.map(d => ({
            // LSP counts lines and characters from zero; Monaco counts from one.
            startLineNumber: d.range.start.line + 1,
            startColumn: d.range.start.character + 1,
            endLineNumber: d.range.end.line + 1,
            endColumn: d.range.end.character + 1,
            message: d.message,
            severity: SEVERITY[d.severity] ?? 8
        })));
    }

    async hover(position) {
        const result = await this.request('textDocument/hover', {
            textDocument: { uri: DOCUMENT_URI },
            position: { line: position.lineNumber - 1, character: position.column - 1 }
        });

        const contents = result?.result?.contents;
        if (!contents) return null;

        const value = typeof contents === 'string'
            ? contents
            : Array.isArray(contents)
                ? contents.map(c => (typeof c === 'string' ? c : c.value)).join('\n\n')
                : contents.value;

        return value ? { contents: [{ value }] } : null;
    }

    async completion(position) {
        const result = await this.request('textDocument/completion', {
            textDocument: { uri: DOCUMENT_URI },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
            context: { triggerKind: 1 }
        });

        const raw = result?.result;
        const items = Array.isArray(raw) ? raw : raw?.items ?? [];

        return items.map(item => ({
            label: item.label,
            kind: COMPLETION_KIND[item.kind] ?? 0,
            insertText: item.insertText ?? item.label,
            detail: item.detail,
            documentation: typeof item.documentation === 'object'
                ? item.documentation.value
                : item.documentation,
            sortText: item.sortText
        }));
    }
}

export { DOCUMENT_URI };
