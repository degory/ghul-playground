// The standalone playground page. All the behaviour is in playground.js; this
// is the chrome around it.

import { createPlayground } from './playground.js'
import { requestedProgram, loadProgram } from './collections.js'
import * as files from './files.js'

const runButton = document.getElementById('run');
const runLabel = document.getElementById('run-label');
const inputRow = document.getElementById('input-row');
const stdin = document.getElementById('stdin');
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
    done: () => 'compiler',
    ready: () => 'compiler'
};

const BUSY = new Set(['compiling', 'running', 'starting runtime']);

// What the run cost, beside its output rather than in the header. Somebody who
// pressed run is already looking at the pane below, while the header is for
// what the services are doing now rather than for what they did a moment ago.
const runCost = document.getElementById('run-cost');

function reportCost(detail) {
    runCost.textContent = detail
        ? `compiled in ${detail.compiled} ms \u00b7 ran in ${detail.ran} ms`
        : '';
}

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
    dormant: ['analyser idle', 'The analyser session was released after a pause or while the page was out of sight. Editing reconnects it, or click to reconnect now'],
    refused: ['analyser busy', 'Every analyser session this address may hold is in use, probably by another open editor. Close one, then edit or click here to reconnect'],
    disconnected: ['no analyser', 'The analyser is not reachable. Reconnecting automatically; click to try now']
};

// --- the pane below the editor -------------------------------------------

const pane = document.getElementById('pane');
const paneToggle = document.getElementById('pane-toggle');

// The height to come back to. The pane's own height is cleared while
// collapsed, so without this an expand would forget a drag made before it.
let paneHeight = '';

function setPaneCollapsed(collapsed) {
    if (collapsed === (pane.dataset.collapsed !== undefined)) return;

    if (collapsed) {
        paneHeight = pane.style.height;
        pane.style.height = '';
        pane.dataset.collapsed = '';
    } else {
        delete pane.dataset.collapsed;
        pane.style.height = paneHeight;
    }

    const label = collapsed ? 'Expand the pane' : 'Collapse the pane';

    paneToggle.setAttribute('aria-expanded', String(!collapsed));
    paneToggle.setAttribute('aria-label', label);
    paneToggle.title = label;
}

paneToggle.addEventListener('click', () => setPaneCollapsed(pane.dataset.collapsed === undefined));

const tabs = [
    { button: document.getElementById('tab-problems'), panel: diagnosticsPane },
    { button: document.getElementById('tab-output'), panel: outputPane }
];

// Every caller is putting something in front of the reader, so a collapsed
// pane is opened rather than switched behind their back.
function showTab(panel) {
    setPaneCollapsed(false);

    for (const tab of tabs) {
        const selected = tab.panel === panel;
        tab.button.setAttribute('aria-selected', String(selected));
        tab.panel.hidden = !selected;
    }

    showAbout();
}

// Filled in once the program is known, and emptied when the buffer stops
// being that program.
const aboutProgram = document.getElementById('about-program');

function showAbout() {
    aboutProgram.hidden = outputPane.hidden || !aboutProgram.hasChildNodes();
}

for (const tab of tabs) {
    tab.button.addEventListener('click', () => showTab(tab.panel));
}

const splitter = document.getElementById('splitter');

splitter.addEventListener('pointerdown', event => {
    splitter.setPointerCapture(event.pointerId);
    setPaneCollapsed(false);
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

// --- the images this program drew ----------------------------------------

const imagesPane = document.getElementById('images');
const imagesGrid = document.getElementById('images-grid');
const imagesTitle = document.getElementById('images-title');
const imagesToggle = document.getElementById('images-toggle');
const imagesCount = document.getElementById('images-count');
const imagesSize = document.getElementById('images-size');

const DOWNLOAD_ICON =
    '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M7.2 1h1.6v6.3l2.3-2.3 1.1 1.1L8 10.4 3.8 6.1l1.1-1.1 2.3 2.3V1zM2 12h12v1.6H2z" /></svg>';

function showImages(list) {
    imagesToggle.hidden = list.length === 0;
    imagesCount.textContent = list.length > 1 ? String(list.length) : '';

    if (!list.length) {
        imagesPane.hidden = true;
        imagesGrid.replaceChildren();
        return;
    }

    imagesTitle.textContent = list.length === 1 ? 'Image' : `${list.length} images`;

    // Roughly square: with four drawings, two rows of two uses a window far
    // better than one row of four does. The floor keeps a tile worth looking
    // at once there are enough of them for that to bite.
    const across = Math.ceil(Math.sqrt(list.length));

    imagesGrid.style.setProperty('--tile', `${Math.max(18, 60 / across)}rem`);

    // How tall one drawing may be, so that laying them out across also lays
    // them out down: one gets the pane, four get a quarter of it each.
    imagesGrid.style.setProperty('--shelf', `${Math.max(24, 68 / across)}vh`);

    imagesGrid.replaceChildren(...list.map(image => {
        const figure = document.createElement('figure');

        const frame = document.createElement('div');
        frame.className = 'frame';

        const img = document.createElement('img');
        img.src = image.url;
        img.alt = image.name;

        // The shelf above bounds the height, and the layout needs the width
        // that height implies. Only the decoded image knows its proportions,
        // so the figure is told once it has them.
        img.addEventListener('load', () =>
            figure.style.setProperty('--aspect', img.naturalWidth / img.naturalHeight));

        frame.append(img);

        const caption = document.createElement('figcaption');

        const name = document.createElement('span');
        name.textContent = image.name;

        // The picture exists only in this page - the program wrote it to a
        // filesystem that is the browser's memory - so without this there is
        // no way to get one out.
        const download = document.createElement('button');
        download.innerHTML = DOWNLOAD_ICON;
        download.title = `Save ${image.name}`;
        download.setAttribute('aria-label', `Save ${image.name}`);
        download.addEventListener('click', () => files.saveImage(image.url, image.name));

        caption.append(name, download);
        figure.append(frame, caption);

        return figure;
    }));

    imagesPane.hidden = false;
}

imagesToggle.addEventListener('click', () => { imagesPane.hidden = !imagesPane.hidden; });
document.getElementById('images-close').addEventListener('click', () => { imagesPane.hidden = true; });

// Fit is the useful default and actual size is the one a reader asks for when
// a detail matters, so the button says which it would switch to.
imagesSize.addEventListener('click', () => {
    const actual = imagesPane.dataset.size === 'actual';

    imagesPane.dataset.size = actual ? 'fit' : 'actual';
    imagesSize.textContent = actual ? 'Fit' : 'Actual size';
    imagesSize.title = actual
        ? 'Show the images at their own size'
        : 'Scale the images to fit';
});

// --- full screen ----------------------------------------------------------

// The editor is the whole page, so there is nothing to fill but the window
// itself. F11 is the browser's own and is left alone; this is for the reader
// on a machine where that key does something else, and for a phone, where
// there is no key at all.
const fullscreen = document.getElementById('fullscreen');

fullscreen.addEventListener('click', () => {
    if (document.fullscreenElement) {
        document.exitFullscreen();
    } else {
        document.documentElement.requestFullscreen().catch(() => { });
    }
});

// The browser can leave full screen without going through the button - Escape,
// or the window manager - so the tooltip follows the document rather than the
// last click.
document.addEventListener('fullscreenchange', () => {
    fullscreen.title = document.fullscreenElement ? 'Leave full screen' : 'Full screen';
});

// A browser that cannot do it should not offer it.
if (!document.documentElement.requestFullscreen) fullscreen.hidden = true;

// --- the about panel ------------------------------------------------------

const help = document.getElementById('help');
const showHelp = show => { help.hidden = !show; };

document.getElementById('help-toggle').addEventListener('click', () => showHelp(help.hidden));
document.getElementById('help-close').addEventListener('click', () => showHelp(false));

// Clicking the backdrop rather than the panel dismisses it.
help.addEventListener('click', event => { if (event.target === help) showHelp(false); });

document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;

    // Innermost first: the about panel sits over the images, which sit over
    // the editor, and Escape should dismiss one layer rather than all of them.
    if (!help.hidden) showHelp(false);
    else if (!imagesPane.hidden) imagesPane.hidden = true;
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

// A program named by the page's path, such as /rosetta-code/100-doors, takes
// the place of the saved source. Loading it again on reload is what the link
// promises, so edits to it are not restored over it.
const requested = requestedProgram(location.pathname);

const program = requested
    ? await loadProgram(requested).catch(e => ({ error: e.message }))
    : null;

if (program?.source) document.title = `${requested.name} - ghūl playground`;

// Two questions about the buffer, kept together because they answer as a pair:
// which file it is, once it has been opened or saved as one, and which program
// it came from, when the page was asked for one by path.
//
// The path is provenance rather than identity. It stays true while the buffer
// is that program edited - following the link still loads the program, which is
// what a reader who is sent one expects - and stops naming it the moment the
// buffer becomes something else. Same rule as Save As in an editor: once the
// document is saved somewhere else, the path it was opened from is no longer
// what it is.
let currentName = null;
let provenance = requested;

function forgetProvenance() {
    if (!provenance) return;

    provenance = null;

    // replaceState rather than pushState: replacing the buffer is not a
    // navigation, and a back button that returned to the program the reader
    // has just thrown away would be a trap rather than a convenience.
    history.replaceState(null, '', '/');

    document.title = currentName ? `${currentName} - ghūl playground` : 'ghūl playground';

    aboutProgram.replaceChildren();
    showAbout();
}

// Whether the output pane is showing its own tail, and so whether new output
// should be scrolled into view - the way a terminal follows its own output,
// while a reader who has scrolled up to look at something is left where they
// are. It is tracked from the reader's own scrolling rather than measured when
// text arrives, because the input box appearing takes its height off the pane
// and moves the tail out of view without the reader having touched anything;
// measured at that moment the pane reads as scrolled up, and would stay that
// way for the rest of the run.
let followingOutput = true;

outputPane.addEventListener('scroll', () => {
    followingOutput =
        outputPane.scrollTop + outputPane.clientHeight >= outputPane.scrollHeight - 4;
});

const followOutput = () => {
    if (followingOutput) outputPane.scrollTop = outputPane.scrollHeight;
};

const initialSource = program?.source ?? savedSource;

const playground = await createPlayground({
    container: document.getElementById('editor'),
    theme: darkMode.matches ? 'vs-dark' : 'vs',
    ...(initialSource ? { source: initialSource } : {}),
    files: program?.files ?? [],

    onOutput: text => {
        if (!text) followingOutput = true;

        outputPane.textContent = text;
        if (!text) outputPane.innerHTML = '<span class="empty">The program produced no output.</span>';

        followOutput();
    },

    // Shown when the program asks and taken away the moment it stops asking,
    // including when the run ends while it is still waiting - a box left
    // behind would take a line nothing is going to read.
    onInput: wanted => {
        inputRow.hidden = !wanted;

        if (!wanted) return;

        // showTab expands the pane as well, so a box in a collapsed one is
        // not asked for and then hidden.
        showTab(outputPane);
        stdin.focus();

        // The row takes its height off the pane, and focusing the box can
        // scroll an ancestor, so the tail has to be brought back after both.
        followOutput();
    },

    onImages: showImages,

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

        // Once a program is actually running the button is how it is stopped,
        // so it stays live through that state alone - compiling and starting
        // the runtime have nothing to interrupt yet.
        const running = state === 'running';

        runButton.disabled = BUSY.has(state) && !running;
        runButton.toggleAttribute('data-busy', BUSY.has(state) && !running);
        runButton.toggleAttribute('data-stop', running);

        runLabel.textContent = running ? 'Stop' : 'Run';
        runButton.title = running
            ? 'Stop the program. A program waiting for input is told there is none left; '
              + 'one that is busy can only be stopped by reloading the page'
            : 'Compile and run (Ctrl+Enter)';

        // Follow the run: its output while it runs, its problems when it will
        // not compile. Somebody watching the button should not also have to
        // know which tab to be on.
        if (state === 'running' || state === 'done') showTab(outputPane);
        if (state === 'failed') showTab(diagnosticsPane);

        // Cleared when the next run starts, so it always describes the run
        // whose output is on screen.
        if (state === 'done') reportCost(detail);
        if (BUSY.has(state)) reportCost(null);
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

// Said where the program's output would appear, since that is where a reader
// who pressed run would look for why nothing happened.
const notice = program?.error
    ?? (program?.unsupported && `This program does not run in the playground: ${program.unsupported}`);

if (notice) {
    outputPane.replaceChildren(Object.assign(document.createElement('span'),
        { className: 'notice', textContent: notice }));
    showTab(outputPane);
}

// Ask up front rather than letting the analyser fail quietly and the first run
// come back rejected - but only where the services actually want a token.
if (await playground.tokenRequired() && !playground.hasToken()) {
    await playground.askForToken();
}

if (program?.source) {
    const link = (text, href) => Object.assign(document.createElement('a'),
        { textContent: text, href, target: '_blank', rel: 'noopener' });

    aboutProgram.append(program.title ?? requested.name);

    if (requested.page) aboutProgram.append(' · ', link('more about this task on ghul.dev', requested.page));

    aboutProgram.append(' · ', link('take the tour', 'https://ghul.dev/expression-oriented-programming'));

    showAbout();
}

const isRunning = () => runButton.hasAttribute('data-stop');

// Counted as an event, so the stats can say how often a program is run and
// whether the reader asked for it or arrived at a link that ran it for them.
// The counter loads asynchronously and may not be there yet for a run on
// arrival, so that one waits for it rather than going uncounted.
function countRun(automatic) {
    const event = {
        path: `${location.host}/run/${automatic ? 'automatic' : 'manual'}/${provenance?.name ?? 'editor'}`,
        title: automatic ? 'run on arrival' : 'run',
        event: true
    };

    if (window.goatcounter?.count) {
        window.goatcounter.count(event);
    } else {
        document.getElementById('goatcounter')?.addEventListener('load',
            () => window.goatcounter?.count?.(event), { once: true });
    }
}

function runProgram({ automatic = false } = {}) {
    countRun(automatic);
    playground.run();
}

runButton.addEventListener('click', () => {
    if (!isRunning()) {
        runProgram();
        return;
    }

    // Ending the input is enough for a program that is waiting for a line, and
    // leaves its transcript on screen. Nothing else can interrupt managed code
    // on another thread, so for a program that is busy the only way to stop it
    // is to take the runtime away, which means reloading - and the page comes
    // back with nothing running, which is the state that was asked for. The
    // editor's content is saved as it is typed, so that much survives.
    if (playground.stop()) return;

    location.reload();
});

// Enter sends the line. The box is cleared rather than left holding it,
// because what was typed reappears in the output a moment later - the program
// echoes it there, where it belongs in the transcript.
inputRow.addEventListener('submit', event => {
    event.preventDefault();

    const line = stdin.value;

    stdin.value = '';
    inputRow.hidden = true;

    playground.sendInput(line);
});

// A program reading until its input runs out is waiting for this rather than
// for another line, and nothing else on the page can say it.
stdin.addEventListener('keydown', event => {
    if (event.key !== 'd' || !event.ctrlKey) return;

    event.preventDefault();

    stdin.value = '';
    inputRow.hidden = true;

    playground.endInput();
});

playground.editor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => { if (!isRunning()) runProgram(); });

// A link to a program is a request to see it run, so it runs on arrival -
// unless it cannot run here, which the notice above already says, or a token
// is wanted and the reader has not given one.
if (program?.source && !notice && (playground.hasToken() || !(await playground.tokenRequired()))) {
    runProgram({ automatic: true });
}

// --- saving and copying ----------------------------------------------------

let saveDebounce = null;
let sourceLength = playground.getSource().length;

playground.editor.onDidChangeModelContent(event => {
    const source = playground.getSource();

    // One edit spanning the whole buffer is a paste over it or a select-all
    // delete, and either way what is there now did not come from the program
    // the page loaded. Deleting it in pieces reaches the same place, hence the
    // second test. Opening a file needs no case of its own: replacing the
    // source is exactly the edit this describes.
    //
    // Undoing such an edit does not bring the path back. Following the link
    // again does, and tracking it through the undo stack would cost more than
    // it is worth.
    const replaced = !event.isEolChange
        && event.changes.length === 1
        && event.changes[0].rangeOffset === 0
        && event.changes[0].rangeLength >= sourceLength;

    sourceLength = source.length;

    if (replaced || !source.trim()) forgetProvenance();

    clearTimeout(saveDebounce);
    saveDebounce = setTimeout(() => {
        try { localStorage.setItem(STORAGE_KEY, source); } catch { }
    }, 500);
});

const copyButton = document.getElementById('copy');

copyButton.addEventListener('click', () => {
    navigator.clipboard?.writeText(playground.getSource()).then(() => {
        copyButton.dataset.copied = '';
        setTimeout(() => delete copyButton.dataset.copied, 1500);
    });
});

// --- the file menu ---------------------------------------------------------

const fileToggle = document.getElementById('file-toggle');
const fileMenu = document.getElementById('file-menu');
const fileNote = document.getElementById('file-note');
const saveItem = document.getElementById('file-save');
const saveLabel = document.getElementById('file-save-label');

function closeMenu() {
    fileMenu.hidden = true;
    fileToggle.setAttribute('aria-expanded', 'false');
}

// What Save would do is not fixed: it writes back to a file once one has been
// opened, and before that it has to ask. The menu is told each time it opens
// rather than kept in step, so it is right after a reload as well.
async function openMenu() {
    fileMenu.hidden = false;
    fileToggle.setAttribute('aria-expanded', 'true');

    if (!files.canWriteFiles) {
        saveLabel.textContent = 'Save a copy';
        fileNote.textContent =
            'This browser cannot write back to a file it opened, so saving downloads a copy.';
        return;
    }

    const target = await files.savesTo();

    saveLabel.textContent = target ? `Save to ${target}` : 'Save';
    fileNote.textContent = '';
}

fileToggle.addEventListener('click', () => {
    if (fileMenu.hidden) openMenu(); else closeMenu();
});

// Anywhere outside it, including the editor, which does not bubble a click the
// way an ordinary element does.
document.addEventListener('pointerdown', event => {
    if (!fileMenu.hidden && !event.target.closest('.menu')) closeMenu();
});

document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !fileMenu.hidden) closeMenu();
});

// The same acknowledgement the copy button gives: the act is over in a moment
// and there is nothing to keep saying about it. The document title carries the
// lasting half, which is which file this now is.
let acknowledgement = null;

function acknowledge(name) {
    currentName = name;
    document.title = `${name} - ghūl playground`;

    fileToggle.dataset.done = '';
    clearTimeout(acknowledgement);
    acknowledgement = setTimeout(() => delete fileToggle.dataset.done, 1500);
}

async function openFile() {
    closeMenu();

    const file = await files.open();

    if (!file) return;

    playground.setSource(file.text);
    acknowledge(file.name);
}

async function saveFile() {
    closeMenu();

    const name = await files.save(playground.getSource());

    if (name) {
        acknowledge(name);
        return;
    }

    // Nothing to write back to, so Save means Save as the first time.
    await saveFileAs();
}

async function saveFileAs() {
    closeMenu();

    const offered = files.defaultName({ current: currentName, requested: provenance });
    const name = await files.saveAs(playground.getSource(), offered);

    if (!name) return;

    // Keeping the name it was offered says this is still that program, so the
    // path stays. Choosing another one says it is theirs now.
    if (name !== offered) forgetProvenance();

    acknowledge(name);
}

document.getElementById('file-open').addEventListener('click', openFile);
saveItem.addEventListener('click', saveFile);
document.getElementById('file-save-as').addEventListener('click', saveFileAs);

// Taken off the browser, which would otherwise save or open the page. Monaco
// binds neither chord, so an event from inside the editor reaches here too and
// a second registration with the editor would run these twice.
document.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;

    const key = event.key.toLowerCase();

    if (key !== 's' && key !== 'o') return;

    event.preventDefault();

    if (key === 's') saveFile(); else openFile();
});
