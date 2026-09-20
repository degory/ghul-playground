// The behaviour behind chrome.css that the playground and the REPL share: the
// full-screen toggle and the help panel.

// The page is the whole window's worth of editor, so there is nothing to fill
// but the window itself. F11 is the browser's own and is left alone; this is
// for the reader on a machine where that key does something else, and for a
// phone, where there is no key at all.
// `used` is called when the reader works the toggle, so each page can count it
// under its own event family. Nothing here counts anything itself: this file is
// shared, and the family is the caller's to name.
export function setUpFullscreen(button, used = () => { }) {
    button.addEventListener('click', () => {
        used();

        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            document.documentElement.requestFullscreen().catch(() => { });
        }
    });

    // The browser can leave full screen without going through the button -
    // Escape, or the window manager - so the tooltip follows the document
    // rather than the last click.
    document.addEventListener('fullscreenchange', () => {
        button.title = document.fullscreenElement ? 'Leave full screen' : 'Full screen';
    });

    // A browser that cannot do it should not offer it.
    if (!document.documentElement.requestFullscreen) button.hidden = true;
}

// The help panel: opened and closed by its toggle, closed by its own button or
// a click on the backdrop. Escape is left to the page, which knows what else
// is layered over it and should dismiss one layer at a time.
export function setUpHelp(panel, toggle, close, opened = () => { }) {
    const show = open => { panel.hidden = !open; };

    toggle.addEventListener('click', () => {
        if (panel.hidden) opened();

        show(panel.hidden);
    });
    close.addEventListener('click', () => show(false));
    panel.addEventListener('click', event => { if (event.target === panel) show(false); });

    return {
        get open() { return !panel.hidden; },
        close: () => show(false)
    };
}
