// Where the REPL page is and where the service it talks to is, decided here
// and nowhere else. Every path is relative to the page's base, so the REPL
// moves with whatever directory serves it.

// The .NET dev server serves the page and does not proxy, so a page served
// from it talks to the compile service directly, as the playground page does.
const LOCAL = location.port === '5080';

export const CELL_SERVICE = LOCAL
    ? 'http://127.0.0.1:5090/compile/cell'
    : new URL('compile/cell', document.baseURI).href;

// Whether sessions are on here: `{ limits }` when they are, `{ off: true }`
// when the service is there and has them switched off, and `{ unreachable:
// true }` when it could not be asked.
export async function replAvailability() {
    try {
        const response = await fetch(CELL_SERVICE, { cache: 'no-store' });

        if (response.status === 404) return { off: true };
        if (!response.ok) return { unreachable: true };

        return { limits: await response.json() };
    } catch {
        return { unreachable: true };
    }
}

// The REPL page, from a page served beside the playground's files. On ghul.dev
// the playground is below /playground/ and the REPL has a path of its own
// beside it, /repl/, which is the one to link to; anywhere else it is the page
// in the same directory.
export function replPageUrl(base = document.baseURI) {
    return new URL(base).pathname.endsWith('/playground/')
        ? new URL('../repl/', base).href
        : new URL('repl.html', base).href;
}

// The analyse service, asked for an interactive session's analyser.
export const ANALYSE_REPL_SERVICE = LOCAL
    ? 'ws://127.0.0.1:5091/analyse?repl'
    : new URL('analyse?repl', document.baseURI).href.replace(/^http/, 'ws');
