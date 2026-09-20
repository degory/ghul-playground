// What the "More to run" strip offers, checked against a made-up index and then
// against the real one.
//
//   node test/rosetta-suggestions.js
//   INDEX=../ghul-rosetta-code/index.json node test/rosetta-suggestions.js
//
// The selection is data rather than behaviour, so it is checked here rather than
// in the browser: the browser test's job is that the strip appears, that a click
// swaps the program and that Back works.

const { readFileSync, existsSync } = require('fs');
const path = require('path');

// The module is an ES module the page imports; this is a CommonJS test, so it is
// loaded through import() rather than require().
const MODULE = path.join(__dirname, '../web/wwwroot/rosetta-index.js');

let failures = 0;

function check(what, ok, detail = '') {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  ${detail}` : ''}`);
}

// A task as the index holds one, with only the fields the selection reads.
const task = (slug, tags, { images = [], playground = true, parts } = {}) => ({
    slug, title: slug, tags, images, playground,
    parts: parts ?? [{ id: slug, playground, images }]
});

(async () => {
    const { suggestions, isVisual, isRunnable, loadIndex } = await import(`file://${MODULE}`);

    // --- what counts as visual, and as runnable ---------------------------

    check('a task that draws is visual', isVisual(task('a', ['maths'], { images: ['a.png'] })));
    check('a graphics-tagged task is visual', isVisual(task('b', ['graphics'])));
    check('a fractal-tagged task is visual', isVisual(task('c', ['fractal'])));
    check('a plain task is not', !isVisual(task('d', ['puzzles'])));

    check('the first part decides whether a task can run',
        !isRunnable({ slug: 'e', tags: [], parts: [{ playground: false }, { playground: true }] }));
    check('and a task with no parts falls back to its own flag',
        isRunnable({ slug: 'f', tags: [], playground: true }));

    // --- the shape of what is offered -------------------------------------

    const index = {
        showcase: ['show-one', 'show-two'],
        tasks: [
            task('current', ['graphics', 'fractal']),
            task('close', ['graphics', 'fractal']),
            task('closer-still', ['graphics', 'fractal'], { images: ['x.png'] }),
            task('distant', ['graphics']),
            task('unrelated', ['strings']),
            task('cannot-run', ['graphics', 'fractal'], { playground: false }),
            task('show-one', ['strings']),
            task('show-two', ['strings'])
        ]
    };

    const offered = suggestions(index, 'current');

    check('three tasks are offered', offered.length === 3, JSON.stringify(offered.map(t => t.slug)));
    check('two of them are related and one is the showcase',
        offered.filter(t => t.kind === 'related').length === 2
        && offered.filter(t => t.kind === 'showcase').length === 1,
        JSON.stringify(offered.map(t => `${t.slug}:${t.kind}`)));
    check('the task being run is never offered', !offered.some(t => t.slug === 'current'));
    check('a task that cannot run here is never offered', !offered.some(t => t.slug === 'cannot-run'));
    check('a task sharing no tag is not offered as related',
        !offered.some(t => t.kind === 'related' && t.slug === 'unrelated'));
    check('the showcase pick comes last', offered[2].kind === 'showcase');

    // --- rotation ---------------------------------------------------------

    const first = suggestions(index, 'current', 0).map(t => t.slug);
    const second = suggestions(index, 'current', 1).map(t => t.slug);

    check('moving the window changes what is offered',
        JSON.stringify(first) !== JSON.stringify(second), `${first} then ${second}`);

    check('and the showcase moves along its own list too',
        suggestions(index, 'current', 0)[2].slug !== suggestions(index, 'current', 1)[2].slug);

    // --- nothing to offer -------------------------------------------------

    check('no index means no strip', suggestions(null, 'current').length === 0);
    check('an index naming no showcase still offers related tasks',
        suggestions({ tasks: index.tasks }, 'current').length === 2);
    check('a task the index has never heard of still gets the showcase',
        suggestions(index, 'not-in-the-index').length === 1);

    // A showcase slug that names a task which cannot run, or no task at all, is
    // caught by the generating repository's own check; the page drops it rather
    // than offering something it cannot open.
    check('a showcase slug the index cannot run is dropped',
        suggestions({ showcase: ['cannot-run'], tasks: index.tasks }, 'current')
            .every(t => t.kind === 'related'));

    // --- a fetch that fails ----------------------------------------------

    check('a failed fetch answers with nothing rather than throwing',
        await loadIndex(() => Promise.reject(new Error('offline'))) === null);

    // --- against the real index ------------------------------------------

    // Checked out beside this repository, or beside the workspace that holds its
    // worktrees. INDEX names it anywhere else.
    const real = [
        process.env.INDEX,
        path.join(__dirname, '../../ghul-rosetta-code/index.json'),
        path.join(__dirname, '../../../../ghul-rosetta-code/index.json')
    ].find(candidate => candidate && existsSync(candidate));

    if (real) {
        const live = JSON.parse(readFileSync(real, 'utf8'));

        // Only meaningful once the showcase list has landed in that repository.
        if (Array.isArray(live.showcase)) {
            check('every showcase slug names a task that can run here',
                live.showcase.every(slug => {
                    const found = live.tasks.find(t => t.slug === slug);
                    return found && isRunnable(found);
                }), JSON.stringify(live.showcase.filter(slug => {
                    const found = live.tasks.find(t => t.slug === slug);
                    return !found || !isRunnable(found);
                })));
        } else {
            console.log('ok    (the real index carries no showcase list yet)');
        }

        // Every runnable task should have something to offer beside it, or the
        // strip would appear empty for it. Two without a showcase list, three
        // with one, so this says the same thing before and after that lands.
        const wanted = Array.isArray(live.showcase) ? 3 : 2;

        const thin = live.tasks
            .filter(isRunnable)
            .map(t => ({ slug: t.slug, n: suggestions(live, t.slug).length }))
            .filter(entry => entry.n < wanted);

        check(`every runnable task has ${wanted} tasks to offer beside it`,
            thin.length === 0, `${thin.length} with fewer: ${JSON.stringify(thin.slice(0, 8))}`);
    } else {
        console.log(`ok    (no index at ${real}; set INDEX to check against the real one)`);
    }

    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
})();
