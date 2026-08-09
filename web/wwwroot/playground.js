// The playground itself: an editor wired to the analyse service, plus compile
// and run. No chrome and no layout opinions, so the standalone page and the
// embedded one can present it differently without duplicating any of this.

import { dotnet } from './_framework/dotnet.js'
import { GHUL_LANGUAGE, GHUL_CONFIGURATION } from './ghul-language.js'
import { GhulLanguageClient } from './lsp.js'
import { getToken, setToken, askForToken } from './token.js'
import { defineThemes, themeName } from './theme.js'

// Deployed, both services sit behind the same reverse proxy that serves this
// page, so same-origin paths avoid CORS entirely. The .NET dev server does not
// proxy, so a page served from it talks to them directly.
const LOCAL = location.port === '5080';

const COMPILE_SERVICE = LOCAL ? 'http://127.0.0.1:5090/compile' : '/compile';

const ANALYSE_SERVICE = LOCAL
    ? 'ws://127.0.0.1:5091/analyse'
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/analyse`;

// Long enough not to send a message per character, short enough that
// diagnostics feel live.
const EDIT_DEBOUNCE_MS = 300;

export const DEFAULT_SOURCE = `use IO.Std.write_line;

entry() is
    write_line("hello from ghūl, compiled on the server");

    let squares = [1, 2, 3, 4, 5] | .map(n => n * n) | .collect_list();

    for s in squares do
        write_line("square: {s}");
    od
si
`;

// Monaco's AMD loader is global and must not be started twice.
let monacoLoaded = null;

function loadMonaco() {
    if (monacoLoaded) return monacoLoaded;

    monacoLoaded = new Promise(resolve => {
        require.config({ paths: { vs: 'vs' } });

        require(['vs/editor/editor.main'], () => {
            monaco.languages.register({ id: 'ghul' });
            monaco.languages.setMonarchTokensProvider('ghul', GHUL_LANGUAGE);
            monaco.languages.setLanguageConfiguration('ghul', GHUL_CONFIGURATION);

            defineThemes();

            resolve();
        });
    });

    return monacoLoaded;
}

// The .NET runtime is several megabytes and is only needed to run a program, so
// it is started on the first run rather than on load. A page that embeds one of
// these per example cannot pay that on every navigation.
let runtime = null;

function loadRuntime() {
    if (!runtime) {
        runtime = (async () => {
            const { getAssemblyExports, getConfig } = await dotnet.create();

            return await getAssemblyExports(getConfig().mainAssemblyName);
        })();
    }

    return runtime;
}

export async function createPlayground({
    container,
    source = DEFAULT_SOURCE,
    theme = 'vs',
    onOutput = () => { },
    onDiagnostics = () => { },
    onStatus = () => { },
    onAnalyser = () => { }
}) {
    await loadMonaco();

    const editor = monaco.editor.create(container, {
        value: source,
        language: 'ghul',
        theme: themeName(theme),
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        // The same face and features ghul.dev sets on a rendered example, so
        // clicking edit does not change how the code looks.
        fontFamily: "'Fira Code', var(--vp-font-family-mono, monospace)",
        fontLigatures: "'calt', 'liga', 'ss07'",
        fontSize: 14,
        tabSize: 4,
        'semanticHighlighting.enabled': true
    });

    // Identifiers coloured by what the compiler resolved them to, rather than
    // by the grammar's guess. Registered once the legend is known, and it only
    // becomes known after the first initialize.
    let semanticProvider = null;

    function registerSemanticTokens() {
        if (semanticProvider || !client.semanticTokensLegend) return;

        semanticProvider = monaco.languages.registerDocumentSemanticTokensProvider('ghul', {
            getLegend: () => client.semanticTokensLegend,
            provideDocumentSemanticTokens: () => client.semanticTokens(),
            releaseDocumentSemanticTokens: () => { }
        });
    }

    const client = new GhulLanguageClient(ANALYSE_SERVICE, {
        getToken,
        onStatus: state => {
            // A dead analyser leaves its last diagnostics on screen, which
            // would be stale and misleading. `dormant` is not a failure - the
            // session was reaped for idleness and the next edit wakes it - but
            // its diagnostics are just as stale, so they go too.
            if (state !== 'ready') {
                monaco.editor.setModelMarkers(editor.getModel(), 'ghul-analyse', []);
            }

            if (state === 'ready') registerSemanticTokens();

            onAnalyser(state);
        }
    });

    client.attach(editor.getModel());

    let debounce = null;
    editor.onDidChangeModelContent(() => {
        clearTimeout(debounce);
        debounce = setTimeout(() => client.changed(editor.getValue()), EDIT_DEBOUNCE_MS);
    });

    // Both decline when the analyser is not there, so the editor keeps working
    // with nothing but highlighting rather than showing errors.
    monaco.languages.registerHoverProvider('ghul', {
        provideHover: (_model, position) => client.ready ? client.hover(position) : null
    });

    monaco.languages.registerCompletionItemProvider('ghul', {
        triggerCharacters: ['.'],
        provideCompletionItems: async (_model, position) => {
            if (!client.ready) return { suggestions: [] };

            return { suggestions: await client.completion(position) };
        }
    });

    function showCompileDiagnostics(list) {
        // The analyser owns the squiggles while it is up; showing compile
        // results as well would double every message.
        if (!client.ready) {
            monaco.editor.setModelMarkers(editor.getModel(), 'ghul-compile', list.map(d => ({
                startLineNumber: d.startLine,
                startColumn: d.startColumn,
                endLineNumber: d.endLine,
                endColumn: d.endColumn,
                message: d.message,
                severity: d.severity === 'error' ? monaco.MarkerSeverity.Error
                    : d.severity === 'warn' ? monaco.MarkerSeverity.Warning
                        : monaco.MarkerSeverity.Info
            })));
        }

        onDiagnostics(list);
    }

    async function run() {
        onOutput('');
        onStatus('compiling');

        const started = performance.now();

        try {
            const token = getToken();

            const response = await fetch(COMPILE_SERVICE, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    ...(token ? { authorization: `Bearer ${token}` } : {})
                },
                body: JSON.stringify({ source: editor.getValue() })
            });

            // A rejected token is worth saying plainly and worth asking about,
            // rather than reporting as an opaque failure.
            if (response.status === 401) {
                onStatus('unauthorized');

                const entered = await askForToken(container.parentElement ?? container, {
                    message: token
                        ? 'That access token was not accepted. Try another?'
                        : 'Running a program needs an access token.'
                });

                if (entered) {
                    client.reconnect();
                    return run();
                }

                return;
            }

            if (!response.ok) {
                throw new Error(`compile service returned HTTP ${response.status}`);
            }

            const result = await response.json();

            showCompileDiagnostics(result.diagnostics ?? []);

            if (!result.ok) {
                onStatus('failed', { compiled: Math.round(performance.now() - started) });
                return;
            }

            const compiled = Math.round(performance.now() - started);

            onStatus('starting runtime');

            const exports = await loadRuntime();

            onStatus('running');

            const ran = performance.now();
            onOutput(exports.GhulRunner.Run(result.assembly));

            onStatus('done', { compiled, ran: Math.round(performance.now() - ran) });
        } catch (e) {
            onOutput(String(e));
            onStatus('error');
        }
    }

    return {
        editor,
        run,
        hasToken: () => Boolean(getToken()),
        askForToken: message =>
            askForToken(container.parentElement ?? container, { message })
                .then(entered => { if (entered) client.reconnect(); return entered; }),
        setToken: token => { setToken(token); client.reconnect(); },
        setSource: text => editor.setValue(text),
        getSource: () => editor.getValue(),
        setTheme: name => monaco.editor.setTheme(themeName(name)),
        contentHeight: () => editor.getContentHeight(),
        dispose: () => { client.dispose(); editor.dispose(); }
    };
}
