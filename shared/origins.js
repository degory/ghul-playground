// Which sites may drive the services from a browser.
//
// This is NOT access control, and it must not be mistaken for it: a browser
// sends `Origin` and honours the reply, but anything else can omit it or set it
// to whatever it likes. What the list does is stop a third-party page using its
// own visitors' browsers to compile, which is otherwise free for the attacker
// and paid for by us. Anyone willing to use curl is unaffected, and the
// concurrency and rate limits are what answer them.
//
// A request with no `Origin` at all is allowed through for the same reason:
// refusing it would inconvenience curl and command-line testing while stopping
// no browser, since a browser always sends one.

const ALLOWED = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

// Unset means any origin, which is what local development wants and what the
// services did before the list existed.
const restricted = ALLOWED.length > 0;

function describe() {
    return restricted
        ? `browser origins restricted to: ${ALLOWED.join(', ')}`
        : 'any browser origin accepted (ALLOWED_ORIGINS is unset)';
}

function accepts(origin) {
    return !restricted || !origin || ALLOWED.includes(origin);
}

// What to echo back, or null to send no CORS header at all, which is what makes
// the browser refuse the response.
function allowOriginHeader(origin) {
    if (!restricted) return '*';
    if (!origin) return null;

    return ALLOWED.includes(origin) ? origin : null;
}

module.exports = { ALLOWED, restricted, describe, accepts, allowOriginHeader };
