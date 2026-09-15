// Programs the playground opens by path rather than from the example menu.
//
// A path is /<collection>/<id>, and each collection says which ids it accepts
// and where the source for one lives. Keeping every collection under a prefix
// of its own is what lets another set of programs be added later without its
// ids colliding with these.
//
// Sources are fetched from the browser, so each location has to answer
// cross-origin requests. raw.githubusercontent.com does, and unlike the
// GitHub API it is not held to 60 requests an hour.

const ROSETTA_CODE = 'https://raw.githubusercontent.com/degory/ghul-rosetta-code/main/tasks';

const COLLECTIONS = {
    // A task is tasks/<slug>/<slug>.ghul, or, for a task solved more than one
    // way, tasks/<slug>/<NN-part>/<NN-part>.ghul. A solution the playground
    // cannot run carries a playground-unsupported file giving the reason.
    'rosetta-code': {
        pattern: /^([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/([0-9]{2}(?:-[a-z0-9]+)+))?$/,

        locate: ([slug, part]) => {
            const directory = part ? `${ROSETTA_CODE}/${slug}/${part}` : `${ROSETTA_CODE}/${slug}`;

            return {
                source: `${directory}/${part ?? slug}.ghul`,
                unsupported: `${directory}/playground-unsupported`
            };
        }
    }
};

// What a page path asks for: null when it names no collection, so the page
// behaves as it always has; otherwise the program's name and where to find it,
// or a message saying why the path does not name one.
export function requestedProgram(pathname) {
    const match = /^\/([a-z0-9-]+)\/(.+?)\/?$/.exec(pathname);
    const collection = match && COLLECTIONS[match[1]];

    if (!collection) return null;

    const name = `${match[1]}/${match[2]}`;
    const id = collection.pattern.exec(match[2]);

    if (!id) return { name, error: `${name} is not the name of a program` };

    return { name, ...collection.locate(id.slice(1)) };
}

// The program's source, and the reason it will not run here if it carries
// one. Throws with a message fit to show the reader.
export async function loadProgram(request, fetchImpl = fetch) {
    if (request.error) throw new Error(request.error);

    const get = url => fetchImpl(url, { signal: AbortSignal.timeout(10000) });

    let source;
    let unsupported;

    try {
        [source, unsupported] = await Promise.all([get(request.source), get(request.unsupported)]);
    } catch (e) {
        throw new Error(`could not load ${request.name}: ${e.message}`);
    }

    if (source.status === 404) throw new Error(`there is no program called ${request.name}`);
    if (!source.ok) throw new Error(`could not load ${request.name}: ${source.status}`);

    return {
        source: await source.text(),
        unsupported: unsupported.ok ? (await unsupported.text()).trim() : null
    };
}
