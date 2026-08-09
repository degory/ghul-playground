import { dotnet } from './_framework/dotnet.js'
import { GHUL_LANGUAGE, GHUL_CONFIGURATION } from './ghul-language.js'

const COMPILE_SERVICE = 'http://127.0.0.1:5090/compile';

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
const output = document.getElementById('output');
const diagnostics = document.getElementById('diagnostics');
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

const SEVERITY = {
    error: monaco.MarkerSeverity.Error,
    warn: monaco.MarkerSeverity.Warning,
    info: monaco.MarkerSeverity.Info,
    hint: monaco.MarkerSeverity.Hint
};

function showDiagnostics(list) {
    monaco.editor.setModelMarkers(editor.getModel(), 'ghul', list.map(d => ({
        startLineNumber: d.startLine,
        startColumn: d.startColumn,
        endLineNumber: d.endLine,
        endColumn: d.endColumn,
        message: d.message,
        severity: SEVERITY[d.severity] ?? monaco.MarkerSeverity.Error
    })));

    diagnostics.textContent = list.length
        ? list.map(d => `${d.startLine},${d.startColumn}: ${d.severity}: ${d.message}`).join('\n')
        : 'none';
}

// --- .NET runtime ---------------------------------------------------------

const { getAssemblyExports, getConfig } = await dotnet.create();
const exports = await getAssemblyExports(getConfig().mainAssemblyName);

status.textContent = 'ready';
runButton.disabled = false;

// --- compile and run ------------------------------------------------------

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

        showDiagnostics(result.diagnostics ?? []);

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
