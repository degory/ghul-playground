// The standalone playground page. All the behaviour is in playground.js; this
// is the chrome around it.

import { createPlayground } from './playground.js'

const runButton = document.getElementById('run');
const status = document.getElementById('status');
const analyser = document.getElementById('analyser');
const analyserText = document.getElementById('analyser-text');
const diagnosticsPane = document.getElementById('diagnostics');
const outputPane = document.getElementById('output');
const problemCount = document.getElementById('problem-count');

const STATUS_TEXT = {
    compiling: () => 'compiling ...',
    'starting runtime': () => 'starting the .NET runtime ...',
    running: () => 'running ...',
    failed: () => 'compilation failed',
    busy: () => 'the service is busy, try again',
    error: () => 'failed',
    done: d => `compiled in ${d.compiled} ms, ran in ${d.ran} ms`
};

const BUSY = new Set(['compiling', 'running', 'starting runtime']);

// What the dot means, and what the tooltip says it means. `dormant` is not a
// failure: the session was reaped for idleness and the next edit brings it
// back, so it must not look like the analyser has died.
const ANALYSER_STATE = {
    ready: ['analyser', 'The analyser is connected: errors, hovers and completions are live'],
    connecting: ['connecting', 'Connecting to the analyser ...'],
    dormant: ['analyser idle', 'The analyser session was released after a pause. Editing reconnects it, or click to reconnect now'],
    disconnected: ['no analyser', 'The analyser is not reachable. Reconnecting automatically; click to try now']
};

// --- the pane below the editor -------------------------------------------

const tabs = [
    { button: document.getElementById('tab-problems'), panel: diagnosticsPane },
    { button: document.getElementById('tab-output'), panel: outputPane }
];

function showTab(panel) {
    for (const tab of tabs) {
        const selected = tab.panel === panel;
        tab.button.setAttribute('aria-selected', String(selected));
        tab.panel.hidden = !selected;
    }
}

for (const tab of tabs) {
    tab.button.addEventListener('click', () => showTab(tab.panel));
}

const splitter = document.getElementById('splitter');
const pane = document.getElementById('pane');

splitter.addEventListener('pointerdown', event => {
    splitter.setPointerCapture(event.pointerId);
    splitter.dataset.dragging = '';

    const move = e => {
        // Bounded so neither the editor nor the pane can be dragged away
        // entirely, which is easy to do by accident and hard to undo.
        const height = Math.min(Math.max(window.innerHeight - e.clientY, 36), window.innerHeight - 160);
        pane.style.height = `${height}px`;
    };

    const up = () => {
        delete splitter.dataset.dragging;
        splitter.removeEventListener('pointermove', move);
        splitter.removeEventListener('pointerup', up);
    };

    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
});

// --- the about panel ------------------------------------------------------

const help = document.getElementById('help');
const showHelp = show => { help.hidden = !show; };

document.getElementById('help-toggle').addEventListener('click', () => showHelp(help.hidden));
document.getElementById('help-close').addEventListener('click', () => showHelp(false));

// Clicking the backdrop rather than the panel dismisses it.
help.addEventListener('click', event => { if (event.target === help) showHelp(false); });

document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !help.hidden) showHelp(false);
});

// --- the editor -----------------------------------------------------------

const darkMode = window.matchMedia('(prefers-color-scheme: dark)');

const playground = await createPlayground({
    container: document.getElementById('editor'),
    theme: darkMode.matches ? 'vs-dark' : 'vs',

    onOutput: text => {
        outputPane.textContent = text;
        if (!text) outputPane.innerHTML = '<span class="empty">The program produced no output.</span>';
    },

    onDiagnostics: list => {
        problemCount.hidden = list.length === 0;
        problemCount.textContent = String(list.length);
        problemCount.dataset.severity = list.some(d => d.severity === 'error') ? 'error' : 'warn';

        if (!list.length) {
            diagnosticsPane.innerHTML = '<span class="empty">No problems.</span>';
            return;
        }

        diagnosticsPane.replaceChildren(...list.map(d => {
            const line = document.createElement('div');
            line.className = d.severity;
            line.textContent = `${d.startLine},${d.startColumn}: ${d.severity}: ${d.message}`;
            return line;
        }));
    },

    onStatus: (state, detail) => {
        status.textContent = (STATUS_TEXT[state] ?? (() => state))(detail);

        // Re-enable once the run has finished, however it finished.
        runButton.disabled = BUSY.has(state);
        runButton.toggleAttribute('data-busy', BUSY.has(state));

        // Follow the run: its output while it runs, its problems when it will
        // not compile. Somebody watching the button should not also have to
        // know which tab to be on.
        if (state === 'running' || state === 'done') showTab(outputPane);
        if (state === 'failed') showTab(diagnosticsPane);
    },

    onAnalyser: state => {
        const [label, tooltip] = ANALYSER_STATE[state] ?? ANALYSER_STATE.disconnected;

        analyser.dataset.state = state;
        analyser.title = tooltip;
        analyserText.textContent = label;
    }
});

// The client already retries on its own, backing off to a minute between
// attempts. This is for the reader who does not want to wait out the backoff,
// and it is why the indicator is a button rather than a label.
analyser.addEventListener('click', () => {
    if (analyser.dataset.state !== 'ready') playground.reconnectAnalyser();
});

// Chrome and editor have to move together, or one of them looks broken.
darkMode.addEventListener('change', event =>
    playground.setTheme(event.matches ? 'vs-dark' : 'vs'));

status.textContent = 'ready';
runButton.disabled = false;

// Ask up front rather than letting the analyser fail quietly and the first run
// come back rejected - but only where the services actually want a token.
if (await playground.tokenRequired() && !playground.hasToken()) {
    await playground.askForToken();
}

runButton.addEventListener('click', () => playground.run());

playground.editor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => playground.run());
