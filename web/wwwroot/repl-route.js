// Where the REPL page is and where the service it talks to is, decided here
// and nowhere else. Every path is relative to the page, so the REPL moves with
// whatever directory serves it.

// The .NET dev server serves the page and does not proxy, so a page served
// from it talks to the compile service directly, as the playground page does.
const LOCAL = location.port === '5080';

export const REPL_PAGE = 'repl.html';

// The REPL is off unless the page is asked for it with this query parameter
// and the compile service has sessions switched on.
export const REPL_QUERY_FLAG = 'repl';

export const CELL_SERVICE = LOCAL
    ? 'http://127.0.0.1:5090/compile/cell'
    : new URL('compile/cell', document.baseURI).href;

export function replRequested(search = location.search) {
    return new URLSearchParams(search).has(REPL_QUERY_FLAG);
}

// The service's limits when sessions are on here, or null when they are not.
export async function replLimits() {
    try {
        const response = await fetch(CELL_SERVICE, { cache: 'no-store' });

        return response.ok ? await response.json() : null;
    } catch {
        return null;
    }
}

// The analyse service, asked for an interactive session's analyser.
export const ANALYSE_REPL_SERVICE = LOCAL
    ? 'ws://127.0.0.1:5091/analyse?repl'
    : new URL('analyse?repl', document.baseURI).href.replace(/^http/, 'ws');
