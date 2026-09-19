// The REPL page: a transcript of cells, an input at the bottom, and the
// session behind it running in a cell host frame.
//
// The page holds no session logic of its own. What to send for a submission,
// what the reply means and how a value is shown are all decided by
// Playground.REPL_SESSION in the frame, on the same session core the terminal
// REPL uses. The page moves text between that, the compile service and the
// screen.

import { GHUL_LANGUAGE, GHUL_CONFIGURATION } from './ghul-language.js'
import { defineThemes, themeName } from './theme.js'
import { getToken } from './token.js'
import { CellRuntime } from './cell-runtime.js'
import { CELL_SERVICE, replRequested, replLimits } from './repl-route.js'

const transcript = document.getElementById('transcript');
const inputRow = document.getElementById('input-row');
const prompt = document.getElementById('prompt');
const help = document.getElementById('help');
const status = document.getElementById('status');
const stopButton = document.getElementById('stop');
const resetButton = document.getElementById('reset');

const darkMode = matchMedia('(prefers-color-scheme: dark)');

const limits = replRequested() ? await replLimits() : null;

if (!limits) {
    document.getElementById('unavailable').hidden = false;
    stopButton.hidden = true;
    resetButton.hidden = true;
} else {
    await start();
}

function loadMonaco() {
    return new Promise(resolve => {
        require.config({ paths: { vs: 'vs' } });

        require(['vs/editor/editor.main'], () => {
            monaco.languages.register({ id: 'ghul' });
            monaco.languages.setMonarchTokensProvider('ghul', GHUL_LANGUAGE);
            monaco.languages.setLanguageConfiguration('ghul', GHUL_CONFIGURATION);

            defineThemes();

            resolve();
        });
    });
}

async function start() {
    await loadMonaco();

    const setTheme = () => monaco.editor.setTheme(themeName(darkMode.matches ? 'vs-dark' : 'vs'));

    setTheme();
    darkMode.addEventListener('change', setTheme);

    const container = document.getElementById('input');

    const editor = monaco.editor.create(container, {
        language: 'ghul',
        value: '',
        minimap: { enabled: false },
        lineNumbers: 'off',
        glyphMargin: false,
        folding: false,
        scrollBeyondLastLine: false,
        overviewRulerLanes: 0,
        renderLineHighlight: 'none',
        scrollbar: { vertical: 'hidden', alwaysConsumeMouseWheel: false },
        fontFamily: "'Fira Code', ui-monospace, SFMono-Regular, Menlo, monospace",
        fontLigatures: true,
        wordWrap: 'on',
        automaticLayout: true
    });

    // The input grows with what is typed rather than scrolling inside itself.
    const fit = () => {
        container.style.height = `${Math.max(editor.getContentHeight(), 22)}px`;
        editor.layout();
    };

    editor.onDidContentSizeChange(fit);
    fit();

    let runtime = new CellRuntime();
    let number = 1;
    let busy = false;

    // Counts sessions, so a reply that arrives after its session was stopped
    // is recognised and dropped rather than handed to the next one.
    let generation = 0;

    const history = [];
    let historyAt = 0;

    const setPrompt = () => { prompt.textContent = `[${number}]`; };

    const setBusy = (value, text = '') => {
        busy = value;
        status.textContent = text;
        stopButton.disabled = !value;
        editor.updateOptions({ readOnly: value });
    };

    inputRow.hidden = false;
    help.hidden = false;
    setPrompt();
    editor.focus();

    const scrollToInput = () => inputRow.scrollIntoView({ block: 'end' });

    function addEntry(label, text) {
        const entry = document.createElement('div');

        entry.className = 'entry';

        const input = document.createElement('div');
        const promptLabel = document.createElement('span');
        const code = document.createElement('code');

        input.className = 'input';
        promptLabel.className = 'prompt';
        promptLabel.textContent = label;
        code.textContent = text;

        monaco.editor.colorize(text, 'ghul', {}).then(html => { code.innerHTML = html; });

        input.append(promptLabel, code);

        const result = document.createElement('div');

        result.className = 'result';
        entry.append(input, result);
        transcript.insertBefore(entry, inputRow);

        return result;
    }

    function line(result, className, text) {
        const div = document.createElement('div');

        div.className = className;
        div.textContent = text;
        result.appendChild(div);
    }

    // Ends the session: its frame and every cell in it go, and the next
    // submission starts a new one at cell 1.
    function resetSession() {
        generation++;
        runtime.dispose();
        runtime = new CellRuntime();
        number = 1;
        setPrompt();
    }

    async function post(cells) {
        const token = getToken();

        const response = await fetch(CELL_SERVICE, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(token ? { authorization: `Bearer ${token}` } : {})
            },
            body: JSON.stringify({ cells })
        });

        if (response.status === 409) return { broken: true };

        if (response.status === 429 || response.status === 503) {
            return { reply: JSON.stringify({ ok: false, error: 'the compile service is busy; run the cell again in a moment' }) };
        }

        const text = await response.text();

        // Every answer the service gives is JSON; anything else came from
        // something in front of it.
        try {
            JSON.parse(text);
            return { reply: text };
        } catch {
            return { reply: JSON.stringify({ ok: false, error: `the compile service answered HTTP ${response.status}` }) };
        }
    }

    async function submit(text) {
        if (busy || !text.trim()) return;

        history.push(text);
        historyAt = history.length;

        editor.setValue('');

        const result = addEntry(`[${number}]`, text);

        scrollToInput();
        setBusy(true, 'compiling');

        try {
            const session = generation;

            let prepared = await runtime.call('prepare', text);
            let answer = null;

            while (prepared && !prepared.stopped && !prepared.error) {
                const posted = await post(prepared.cells);

                if (session !== generation) {
                    prepared = { stopped: true };
                    break;
                }

                if (posted.broken) {
                    line(result, 'error', 'an earlier cell no longer compiles here, so the session has been reset; run this cell again');
                    resetSession();
                    return;
                }

                setBusy(true, 'running');

                answer = await runtime.call('accept', posted.reply);

                if (answer.retry) {
                    prepared = answer.retry;
                    setBusy(true, 'compiling');
                    continue;
                }

                break;
            }

            if (prepared?.error) {
                line(result, 'error', prepared.error);
                return;
            }

            if (prepared?.stopped || answer?.stopped) {
                line(result, 'muted', 'stopped; the session was reset');
                number = 1;
                return;
            }

            for (const d of answer.diagnostics ?? []) {
                const kind = / warn:| warn$/.test(d) ? 'diagnostic warn' : d.startsWith('ghul:') ? 'note' : 'diagnostic';

                line(result, kind, d);
            }

            if (answer.text) line(result, 'output', answer.text.replace(/\n$/, ''));
            if (answer.value != null) line(result, 'value', answer.value);
            if (answer.error) line(result, 'error', answer.error);

            if (Number.isFinite(answer.next)) number = answer.next;

            if (answer.accepted && number > limits.maxCells) {
                line(result, 'muted', `a session here holds ${limits.maxCells} cells; the next one starts a new session`);
                resetSession();
            }
        } catch (e) {
            line(result, 'error', `${e.message ?? e}`);
        } finally {
            setPrompt();
            setBusy(false);
            scrollToInput();
            editor.focus();
        }
    }

    const isLastLine = () => editor.getPosition().lineNumber === editor.getModel().getLineCount();

    editor.onKeyDown(e => {
        if (e.keyCode === monaco.KeyCode.Enter) {
            const model = editor.getModel();

            if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) {
                e.preventDefault();
                e.stopPropagation();
                submit(model.getValue());
                return;
            }

            // A line holding only a dot ends the cell, as it does in the
            // terminal; the dot is not part of it.
            const lineNumber = editor.getPosition().lineNumber;

            if (isLastLine() && model.getLineContent(lineNumber).trim() === '.') {
                e.preventDefault();
                e.stopPropagation();

                const lines = model.getValue().split('\n');

                submit(lines.slice(0, lineNumber - 1).join('\n'));
            }

            return;
        }

        // Earlier cells, from the first or last line of the input.
        if (e.altKey && (e.keyCode === monaco.KeyCode.UpArrow || e.keyCode === monaco.KeyCode.DownArrow)) {
            e.preventDefault();

            historyAt = e.keyCode === monaco.KeyCode.UpArrow
                ? Math.max(0, historyAt - 1)
                : Math.min(history.length, historyAt + 1);

            editor.setValue(history[historyAt] ?? '');
            editor.setPosition({ lineNumber: editor.getModel().getLineCount(), column: 1e6 });
        }
    });

    stopButton.addEventListener('click', () => {
        generation++;
        runtime.stop();
    });

    resetButton.addEventListener('click', () => {
        if (busy) runtime.stop();

        resetSession();

        const result = addEntry('', '');

        line(result, 'muted', 'new session');
        scrollToInput();
        editor.focus();
    });
}
