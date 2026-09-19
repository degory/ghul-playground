// The runtime side of an interactive session, in the cell host frame.
//
// The parent page posts `{id, op, args}` and gets `{id, result}` back, with
// `result` parsed from the runner's JSON:
//
// - `run`, args `[assembly, submission]`: runs one cell's assembly, base64 as
//   the compile service returned it. Playground.RUNNER.run_cell's answer.
// - `prepare`, args `[text]`: what to post to the compile service for a
//   submission. Playground.REPL_SESSION.prepare's answer.
// - `accept`, args `[reply]`: the compile service's reply, as text; runs the
//   cell if it compiled. Playground.REPL_SESSION.accept's answer.
// - `analysis`, args `[text]`: what to analyse for the input being typed.
//   Playground.REPL_SESSION.analysis's answer.
//
// Everything run here goes into the one session this frame's runtime holds.
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

const OPS = {
    run: (runner, [assembly, submission]) => runner.RunCell(assembly, submission),
    prepare: (runner, [text]) => runner.ReplPrepare(text),
    accept: (runner, [reply]) => runner.ReplAccept(reply),
    analysis: (runner, [text]) => runner.ReplAnalysis(text)
};

// Calls are answered one after another, in the order they arrive, since each
// can depend on the one before it.
let queue = Promise.resolve();

window.addEventListener('message', event => {
    if (event.origin !== self.origin || event.source !== window.parent) return;

    const { id, op, args } = event.data ?? {};

    if (typeof id !== 'number' || !Object.hasOwn(OPS, op) || !Array.isArray(args)) return;
    if (!args.every(a => typeof a === 'string')) return;

    queue = queue.then(async () => {
        let result;

        try {
            const { GhulRunner } = await runtime();

            result = JSON.parse(await OPS[op](GhulRunner, args));
        } catch (e) {
            result = { text: '', error: `host error: ${e}` };
        }

        window.parent.postMessage({ id, result }, self.origin);
    });
});

window.parent.postMessage({ ready: true }, self.origin);
