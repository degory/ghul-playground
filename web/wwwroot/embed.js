// Embedded mode: the editor only, framed by another site.
//
// The frame owns nothing but the editor. Output, diagnostics and status are
// posted to the parent, which renders them in whatever it already has, so an
// embedding page does not end up with two differently-styled output panels.
//
// Origins are checked in both directions. The parent must be one of the sites
// allowed to embed this, and messages claiming to come from elsewhere are
// ignored.

import { createPlayground, DEFAULT_SOURCE } from './playground.js'

const ALLOWED_PARENTS = [
    'https://ghul.dev',
    'https://www.ghul.dev'
];

// Local development: a parent served from localhost is trusted so the
// integration can be worked on without deploying either side.
const LOCAL_PARENT = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function parentIsAllowed(origin) {
    return ALLOWED_PARENTS.includes(origin) || LOCAL_PARENT.test(origin);
}

// The marker field is `channel`, not `source`: `source` carries the program
// text, and using one name for both would set the editor to the marker.
const CHANNEL = 'ghul-playground';

// The parent's origin, learned from the first message it sends. Replies go
// only there, never to '*'.
let parentOrigin = null;

function post(type, payload = {}) {
    if (!parentOrigin) return;

    parent.postMessage({ channel: CHANNEL, type, ...payload }, parentOrigin);
}

const container = document.getElementById('editor');

let playground = null;
let lastHeight = 0;

function reportHeight() {
    // Monaco knows what its content needs; the frame cannot size itself, so
    // the parent is told and sizes the iframe.
    const height = Math.max(playground?.contentHeight() ?? 0, 80);

    if (Math.abs(height - lastHeight) >= 4) {
        lastHeight = height;
        post('height', { height });
    }
}

window.addEventListener('message', async event => {
    if (!parentIsAllowed(event.origin)) return;
    if (event.data?.channel !== CHANNEL) return;

    parentOrigin = event.origin;

    const message = event.data;

    if (message.type === 'init') {
        if (playground) {
            playground.setSource(message.source ?? DEFAULT_SOURCE);
            if (message.theme) playground.setTheme(message.theme);
            reportHeight();
            return;
        }

        playground = await createPlayground({
            container,
            source: message.source ?? DEFAULT_SOURCE,
            theme: message.theme ?? 'vs',

            onOutput: text => post('output', { text }),
            onDiagnostics: list => post('diagnostics', { diagnostics: list }),
            onStatus: (state, detail) => post('status', { state, detail: detail ?? null }),
            onAnalyser: state => post('analyser', { state })
        });

        playground.editor.onDidContentSizeChange(reportHeight);
        playground.editor.addCommand(
            monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => playground.run());

        reportHeight();
        post('ready');

        // The frame is only shown once a reader has asked to edit, so asking
        // for the token here is not an interruption.
        if (!playground.hasToken()) {
            const entered = await playground.askForToken(
                'Editing and running needs an access token.');

            post('token', { held: Boolean(entered) });
        } else {
            post('token', { held: true });
        }

        return;
    }

    if (!playground) return;

    if (message.type === 'source') {
        playground.setSource(message.source ?? '');
        reportHeight();
        return;
    }

    if (message.type === 'theme') {
        playground.setTheme(message.theme ?? 'vs');
        return;
    }

    if (message.type === 'run') {
        playground.run();
    }
});

// The parent cannot know when the frame's script is ready, so the frame says
// so. It has no origin to reply to yet, hence the wildcard on this one
// message, which carries nothing.
parent.postMessage({ channel: CHANNEL, type: 'loaded' }, '*');
