// The page's side of Playground.CHANNEL: the slots of its control block, and
// how to read the output buffer. The runner has the same list of slots, and
// the two have to agree; see that file for why everything crossing this
// boundary crosses through memory rather than through a call.

export const OUTPUT_WRITTEN = 0;
export const OUTPUT_TRUNCATED = 1;
export const INPUT_TURN = 2;
export const INPUT_READY = 3;
export const INPUT_LENGTH = 4;
export const OUTPUT_ADDRESS = 5;
export const OUTPUT_CAPACITY = 6;
export const INPUT_ADDRESS = 7;
export const INPUT_CAPACITY = 8;
export const CONTROL_SLOTS = 9;

// Views over the channel in the runtime's memory, given the address of its
// control block. Rebuilt whenever the memory grows: growing replaces the
// buffer, which leaves every view made over the old one detached and reading
// zero. Nothing announces that, so the check is on every use rather than
// wired to an event.
export function channelViews(module, address) {
    let over = null;
    let views = null;

    return () => {
        const heap = module.HEAPU8.buffer;

        if (heap !== over) {
            over = heap;

            const control = new Int32Array(heap, address, CONTROL_SLOTS);

            views = {
                control,
                output: new Uint16Array(heap, control[OUTPUT_ADDRESS], control[OUTPUT_CAPACITY]),
                input: new Uint16Array(heap, control[INPUT_ADDRESS], control[INPUT_CAPACITY])
            };
        }

        return views;
    };
}

// The buffers carry UTF-16, which is what a JavaScript string already is, so
// there is nothing to decode - but a very long run cannot go through apply() in
// one call without overflowing the argument stack.
export function readOutput(output, from, to) {
    let text = '';

    for (let at = from; at < to; at += 8192) {
        text += String.fromCharCode.apply(null, output.subarray(at, Math.min(at + 8192, to)));
    }

    return text;
}
