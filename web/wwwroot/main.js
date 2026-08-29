// The standalone playground page. All the behaviour is in playground.js; this
// is the chrome around it.

import { createPlayground } from './playground.js'

const runButton = document.getElementById('run');
const status = document.getElementById('status');
const compiler = document.getElementById('compiler');
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
    done: d => `compiled in ${d.compiled} ms, ran in ${d.ran} ms`,
    ready: () => 'compiler'
};

const BUSY = new Set(['compiling', 'running', 'starting runtime']);

// What the compiler dot's colour means, for the tooltip. `failed` is about the
// last run - a compile error or a busy service - not about the service dying.
const COMPILER_TITLE = {
    ready: 'The compile service is ready',
    working: 'Compiling or running',
    failed: 'The last run did not complete: see the problems pane'
};

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

// The editor's content survives the tab: saved on edit, restored on load.
// Storage can be unavailable (private windows, blocked site data), in which
// case the page behaves as it always did and starts from the default source.
const STORAGE_KEY = 'ghul-playground-source';

const savedSource = (() => {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
})();

const playground = await createPlayground({
    container: document.getElementById('editor'),
    theme: darkMode.matches ? 'vs-dark' : 'vs',
    ...(savedSource ? { source: savedSource } : {}),

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

        compiler.dataset.state =
            BUSY.has(state) ? 'working'
            : state === 'failed' || state === 'error' || state === 'busy' ? 'failed'
            : 'ready';
        compiler.title = COMPILER_TITLE[compiler.dataset.state];

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

// A reader coming back to the tab expects the analyser to be there when they
// click into the editor, not only after their first edit. Waking is a no-op
// unless the session was reaped for idleness, and every trigger here is a
// deliberate act in the editor - focus, click, cursor movement - so an idle
// window generates none of them and can never hold a slot.
playground.editor.onDidFocusEditorText(() => playground.wakeAnalyser());
playground.editor.onDidChangeCursorPosition(() => playground.wakeAnalyser());

// Chrome and editor have to move together, or one of them looks broken.
darkMode.addEventListener('change', event =>
    playground.setTheme(event.matches ? 'vs-dark' : 'vs'));

status.textContent = 'compiler';
compiler.dataset.state = 'ready';
compiler.title = COMPILER_TITLE.ready;
runButton.disabled = false;

// Ask up front rather than letting the analyser fail quietly and the first run
// come back rejected - but only where the services actually want a token.
if (await playground.tokenRequired() && !playground.hasToken()) {
    await playground.askForToken();
}

runButton.addEventListener('click', () => playground.run());

playground.editor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => playground.run());

// --- the example picker ----------------------------------------------------

const examplesMenu = document.getElementById('examples');

// Only what the reader typed is worth a confirmation; a menu entry loaded and
// left unedited is not theirs to lose.
let loadedSource = playground.getSource();

fetch('examples.json')
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then(({ examples }) => {
        for (const example of examples) {
            const option = document.createElement('option');
            option.value = example.slug;
            option.textContent = example.title;
            examplesMenu.append(option);
        }

        examplesMenu.hidden = false;

        // The menu names the loaded example while the buffer still is that
        // example, and falls back to its placeholder once the reader edits -
        // an edited buffer is theirs, not the example's.
        const showCurrent = () => {
            const current = examples.find(e => e.source === playground.getSource());
            examplesMenu.value = current ? current.slug : '';
        };

        showCurrent();
        playground.editor.onDidChangeModelContent(() =>
            setTimeout(showCurrent, 0));

        examplesMenu.addEventListener('change', () => {
            const chosen = examples.find(e => e.slug === examplesMenu.value);
            if (!chosen) { showCurrent(); return; }

            if (playground.getSource() !== loadedSource
                && !examples.some(e => e.source === playground.getSource())
                && !confirm('Replace your edits with this example?')) {
                showCurrent();
                return;
            }

            loadedSource = chosen.source;
            playground.setSource(chosen.source);
        });
    })
    .catch(() => { /* no manifest, no menu - the page works without it */ });

// --- saving and copying ----------------------------------------------------

let saveDebounce = null;
playground.editor.onDidChangeModelContent(() => {
    clearTimeout(saveDebounce);
    saveDebounce = setTimeout(() => {
        try { localStorage.setItem(STORAGE_KEY, playground.getSource()); } catch { }
    }, 500);
});

const copyButton = document.getElementById('copy');

copyButton.addEventListener('click', () => {
    navigator.clipboard?.writeText(playground.getSource()).then(() => {
        copyButton.dataset.copied = '';
        setTimeout(() => delete copyButton.dataset.copied, 1500);
    });
});
