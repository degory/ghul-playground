// The standalone playground page. All the behaviour is in playground.js; this
// is the chrome around it.

import { createPlayground } from './playground.js'

const status = document.getElementById('status');
const analyserStatus = document.getElementById('analyser-status');
const output = document.getElementById('output');
const diagnosticsPane = document.getElementById('diagnostics');
const runButton = document.getElementById('run');

const STATUS_TEXT = {
    compiling: () => 'compiling ...',
    'starting runtime': () => 'starting the .NET runtime ...',
    running: () => 'running ...',
    failed: () => 'compilation failed',
    busy: () => 'the service is busy, try again',
    error: () => 'failed',
    done: d => `compiled in ${d.compiled} ms, ran in ${d.ran} ms`
};

const playground = await createPlayground({
    container: document.getElementById('editor'),

    onOutput: text => { output.textContent = text; },

    onDiagnostics: list => {
        diagnosticsPane.textContent = list.length
            ? list.map(d => `${d.startLine},${d.startColumn}: ${d.severity}: ${d.message}`).join('\n')
            : 'none';
    },

    onStatus: (state, detail) => {
        status.textContent = (STATUS_TEXT[state] ?? (() => state))(detail);

        // Re-enable once the run has finished, however it finished.
        runButton.disabled = state === 'compiling' || state === 'running'
            || state === 'starting runtime';
    },

    onAnalyser: state => {
        analyserStatus.textContent =
            state === 'ready' ? 'analyser: ready'
                : state === 'connecting' ? 'analyser: connecting'
                    : 'analyser: unavailable';
        analyserStatus.dataset.state = state;
    }
});

status.textContent = 'ready';
runButton.disabled = false;

// Ask up front rather than letting the analyser fail quietly and the first run
// come back rejected.
if (!playground.hasToken()) {
    await playground.askForToken();
}

runButton.addEventListener('click', () => playground.run());

playground.editor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => playground.run());
