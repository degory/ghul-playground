// The runtime side of an interactive session, in the cell host frame.
//
// The parent page posts `{id, assembly, submission}` - a cell's assembly as
// the compile service returned it, base64 - and gets `{id, result}` back, where
// `result` is Playground.RUNNER.run_cell's answer: `{text, value?, error?}`.
// Every cell run here goes into the one session this frame's runtime holds.
// Only a parent of the same origin is answered. The frame is written as
// srcdoc, where `location` is about:srcdoc, so the origin is `self.origin`.

import { dotnet } from './_framework/dotnet.js'

let exports = null;

async function runtime() {
    exports ??= (async () => {
        const api = await dotnet.create();

        return await api.getAssemblyExports(api.getConfig().mainAssemblyName);
    })();

    return exports;
}

// Cells run one after another, in the order they arrive, since each can depend
// on the one before it.
let queue = Promise.resolve();

window.addEventListener('message', event => {
    if (event.origin !== self.origin || event.source !== window.parent) return;

    const { id, assembly, submission } = event.data ?? {};

    if (typeof id !== 'number' || typeof assembly !== 'string' || typeof submission !== 'string') return;

    queue = queue.then(async () => {
        let result;

        try {
            const { GhulRunner } = await runtime();

            result = JSON.parse(await GhulRunner.RunCell(assembly, submission));
        } catch (e) {
            result = { text: '', error: `host error: ${e}` };
        }

        window.parent.postMessage({ id, result }, self.origin);
    });
});

window.parent.postMessage({ ready: true }, self.origin);
