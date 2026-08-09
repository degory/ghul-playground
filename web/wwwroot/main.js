import { dotnet } from './_framework/dotnet.js'
import { GHUL_LANGUAGE, GHUL_CONFIGURATION } from './ghul-language.js'
import { GhulLanguageClient } from './lsp.js'

// Deployed, both services sit behind the same reverse proxy that serves this
// page, so same-origin paths avoid CORS entirely. The .NET dev server does not
// proxy, so a page served from it talks to them directly.
const LOCAL = location.port === '5080';

const COMPILE_SERVICE = LOCAL ? 'http://127.0.0.1:5090/compile' : '/compile';

const ANALYSE_SERVICE = LOCAL
    ? 'ws://127.0.0.1:5091/analyse'
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/analyse`;

// How long to wait after the last keystroke before telling the analyser. Long
// enough not to send a message per character, short enough that diagnostics
// feel live.
const EDIT_DEBOUNCE_MS = 300;

const SAMPLE = `use IO.Std.write_line;

entry() is
    write_line("hello from ghūl, compiled on the server");

    let squares = [1, 2, 3, 4, 5] | .map(n => n * n) | .collect_list();

    for s in squares do
        write_line("square: {s}");
    od
si
`;

const status = document.getElementById('status');
const analyserStatus = document.getElementById('analyser-status');
const output = document.getElementById('output');
const diagnosticsPane = document.getElementById('diagnostics');
const runButton = document.getElementById('run');

// --- Monaco ---------------------------------------------------------------

const editor = await new Promise(resolve => {
    require.config({ paths: { vs: 'vs' } });

    require(['vs/editor/editor.main'], () => {
        monaco.languages.register({ id: 'ghul' });
        monaco.languages.setMonarchTokensProvider('ghul', GHUL_LANGUAGE);
        monaco.languages.setLanguageConfiguration('ghul', GHUL_CONFIGURATION);

        resolve(monaco.editor.create(document.getElementById('editor'), {
            value: SAMPLE,
            language: 'ghul',
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 14,
            tabSize: 4
        }));
    });
});

// --- the analyser ---------------------------------------------------------

const client = new GhulLanguageClient(ANALYSE_SERVICE, {
    onStatus: state => {
        analyserStatus.textContent =
            state === 'ready' ? 'analyser: ready'
                : state === 'connecting' ? 'analyser: connecting'
                    : 'analyser: unavailable';
        analyserStatus.dataset.state = state;

        // A dead analyser leaves its last diagnostics on screen, which would be
        // stale and misleading. Compile results take over from here.
        if (state !== 'ready') {
            monaco.editor.setModelMarkers(editor.getModel(), 'ghul-analyse', []);
        }
    }
});

client.attach(editor.getModel());

let debounce = null;
editor.onDidChangeModelContent(() => {
    clearTimeout(debounce);
    debounce = setTimeout(() => client.changed(editor.getValue()), EDIT_DEBOUNCE_MS);
});

// Both providers decline when the analyser is not there, so the editor keeps
// working with nothing but highlighting rather than showing errors.
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

// --- .NET runtime ---------------------------------------------------------

const { getAssemblyExports, getConfig } = await dotnet.create();
const exports = await getAssemblyExports(getConfig().mainAssemblyName);

status.textContent = 'ready';
runButton.disabled = false;

// --- compile and run ------------------------------------------------------

function showCompileDiagnostics(list) {
    // The analyser owns the squiggles while it is up; showing compile results
    // as well would double every message. The panel shows them either way.
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

    diagnosticsPane.textContent = list.length
        ? list.map(d => `${d.startLine},${d.startColumn}: ${d.severity}: ${d.message}`).join('\n')
        : 'none';
}

async function compileAndRun() {
    runButton.disabled = true;
    output.textContent = '';
    status.textContent = 'compiling ...';

    const started = performance.now();

    try {
        const response = await fetch(COMPILE_SERVICE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source: editor.getValue() })
        });

        if (!response.ok) {
            throw new Error(`compile service returned HTTP ${response.status}`);
        }

        const result = await response.json();

        showCompileDiagnostics(result.diagnostics ?? []);

        if (!result.ok) {
            status.textContent = 'compilation failed';
            return;
        }

        const compiled = Math.round(performance.now() - started);
        status.textContent = 'running ...';

        const ran = performance.now();
        output.textContent = exports.GhulRunner.Run(result.assembly);

        status.textContent =
            `compiled in ${compiled} ms, ran in ${Math.round(performance.now() - ran)} ms`;
    } catch (e) {
        status.textContent = 'failed';
        output.textContent = String(e);
    } finally {
        runButton.disabled = false;
    }
}

runButton.addEventListener('click', compileAndRun);

editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, compileAndRun);
