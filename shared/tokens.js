// Access tokens for the back-end services.
//
// A short fixed list, supplied in the environment and never in the repository.
// Anyone holding one of them may use the services; there is no per-user
// identity, no expiry and no revocation beyond editing the list and restarting.
// That is the intended scope: it keeps a passer-by out of services that run the
// compiler on whatever they are sent, and it is not an authentication system.
//
// This replaces an address allow list, which cannot work once the services are
// reached from a documentation site whose readers are anywhere.

const crypto = require('crypto');

// Hashed once at load. Comparing hashes rather than the tokens themselves means
// the comparison is over fixed-length values, so timingSafeEqual can be used
// without leaking the length of the expected token.
const digest = value => crypto.createHash('sha256').update(String(value), 'utf8').digest();

const allowed = (process.env.PLAYGROUND_TOKENS ?? '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
    .map(digest);

// With no tokens configured the services are open. That is deliberate for local
// development, where they are bound to loopback anyway, but it is exactly the
// wrong thing to do silently in a deployment, so it is stated loudly at startup.
const required = allowed.length > 0;

function describe() {
    return required
        ? `${allowed.length} access token(s) configured`
        : 'NO ACCESS TOKENS CONFIGURED - the service is open to anyone who can reach it';
}

function accepts(token) {
    if (!required) return true;
    if (!token) return false;

    const candidate = digest(token);

    // Check every entry rather than stopping at the first match, so the time
    // taken does not depend on which token was presented.
    let matched = false;
    for (const expected of allowed) {
        if (crypto.timingSafeEqual(candidate, expected)) matched = true;
    }

    return matched;
}

// `Authorization: Bearer <token>`, which is what the compile service receives.
function fromAuthorizationHeader(header) {
    const match = /^Bearer\s+(.+)$/i.exec(header ?? '');

    return match ? match[1].trim() : null;
}

// The analyse service is reached over a WebSocket, where a browser cannot set
// headers. The token travels as a subprotocol instead of a query parameter, so
// it does not end up in access logs.
const SUBPROTOCOL_PREFIX = 'ghul-playground-token.';

function fromSubprotocols(protocols) {
    for (const protocol of protocols ?? []) {
        if (protocol.startsWith(SUBPROTOCOL_PREFIX)) {
            return protocol.slice(SUBPROTOCOL_PREFIX.length);
        }
    }

    return null;
}

module.exports = {
    required,
    describe,
    accepts,
    fromAuthorizationHeader,
    fromSubprotocols,
    SUBPROTOCOL_PREFIX
};
