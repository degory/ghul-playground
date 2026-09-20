// Counting what a reader does, for the pages that do any counting at all.
//
// One event is one path, because the counter has no properties: everything an
// event says has to be in its path, and the first segment is the family the
// report groups on. Paths stay low-cardinality on purpose - a family and a
// small closed set of outcomes - and nothing a reader typed, no source text and
// no message from the compiler ever reaches one.
//
// Counting is never allowed to matter. Every call is safe when the counter is
// absent, when the reader has opted out, when storage throws, and when it is
// called before count.js has loaded.

// The counter is loaded with `async`, so the first events of a page load land
// before it exists. They wait here rather than going uncounted, which is what
// the run-on-arrival event needed when it was the only one.
const queued = [];

let listening = false;

// Two ways to not be counted, and both are the reader's rather than ours.
//
// `skipgc` is GoatCounter's own opt-out, set by visiting #toggle-goatcounter,
// and count.js honours it by itself - this is only so that nothing is queued
// for a counter that will discard it.
//
// `?notrack` on the URL is for the end-to-end tests, which drive a real browser
// against the real site and would otherwise count themselves. It is a page-load
// decision, so it is read once.
const suppressed = (() => {
    try {
        if (new URLSearchParams(location.search).has('notrack')) return true;
    } catch {
        // No location to read, which only happens somewhere this is not wanted.
        return true;
    }

    try {
        return localStorage.getItem('skipgc') === 't';
    } catch {
        // Storage can throw rather than answer, in a private window or with
        // site data blocked. Not being able to read the opt-out is not consent
        // to count, so it is read as opted out.
        return true;
    }
})();

function send(event) {
    try {
        window.goatcounter.count(event);
    } catch {
        // A counter that fails is not a reason for the page to.
    }
}

// Count one event. `path` is the whole of what is recorded; `title` is what the
// dashboard shows beside it and is free text.
export function countEvent(path, title) {
    if (suppressed) return;

    const event = { path, title, event: true };

    if (window.goatcounter?.count) {
        send(event);
        return;
    }

    const script = document.getElementById('goatcounter');

    // A page that does not load the counter at all is a page that counts
    // nothing, so the event is dropped rather than queued. Queueing it would
    // wait for a load event that can never arrive, which is how a page with no
    // counter came to look as though it were sending events.
    if (!script) return;

    queued.push(event);

    if (listening) return;

    listening = true;

    // The script is in the page's own markup, so if it is already loaded the
    // load event has been and gone - hence sending straight away above, and
    // waiting only when the function is genuinely not there yet.
    script.addEventListener('load', () => {
        while (queued.length) send(queued.shift());
    }, { once: true });
}

// Which band a duration falls in. A bucket rather than the number, because a
// path is a name and thousands of distinct millisecond values would be a
// histogram nobody can read and a cardinality nobody wants.
export function band(ms) {
    if (ms < 1000) return 'under-1s';
    if (ms < 3000) return '1-3s';
    if (ms < 10000) return '3-10s';
    return 'over-10s';
}

// The same idea for a count of things done in one session.
export function countBand(n) {
    if (n <= 1) return '1';
    if (n <= 5) return '2-5';
    if (n <= 20) return '6-20';
    return 'over-20';
}
