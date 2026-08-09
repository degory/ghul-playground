# ghūl playground

Edit [ghūl](https://ghul.dev) in the browser, with diagnostics, hover and
completion as you type. Compile it, and run it in the browser.

**This is a prototype.** The services have containers that contain them, but
there is no egress blocking and no rate limiting yet, so it is not something to
put on the public internet. See
[before this is exposed to anyone](#before-this-is-exposed-to-anyone).

## how it works

Four parts, separated by how much they are trusted with.

| | runs where | handles untrusted source | executes untrusted code |
| --- | --- | --- | --- |
| editor | browser | yes | no |
| analyse service | server | yes | no |
| compile service | server | yes | no |
| the compiled program | **browser** | yes | yes, in the browser's sandbox |

Source is compiled on the server, and the resulting .NET assembly is sent back
to the browser, which loads and runs it. The server never executes what it
compiles.

That split is what makes the playground defensible. A .NET runtime in the
browser has no host filesystem, no network beyond what the page already has,
and no process to escape into, so a program that tries `IO.File.read_all_text`
gets a `DirectoryNotFoundException` rather than reaching anything. A runaway
loop is a tab that stops responding, not a server to clean up.

The analyse service is separate from the compile service because analysis mode
never runs code generation, so a warm analyser cannot produce an assembly. That
suits both: compiling stays stateless and cacheable, and only analysis is
stateful.

## running it

You need the [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0)
and [Node.js](https://nodejs.org/) 22 or later.

```sh
dotnet tool restore
npm install
```

`npm install` also stages the Monaco editor into the web app, which is not
committed.

The services are best run in their containers, because the limits are what
contain the compiler:

```sh
docker compose up --build -d
```

That brings up the compile service on `127.0.0.1:5090` and the analyse service
on `127.0.0.1:5091`. Then:

```sh
npm run web                 # http://127.0.0.1:5080
```

Open <http://127.0.0.1:5080>. Edit the program and press **Compile and run**,
or <kbd>Ctrl</kbd>+<kbd>Enter</kbd>.

To run a service outside a container while working on it, `npm run
compile-service` and `npm run analyse-service` do that. The analyse service
needs `ghul-language-server` on `PATH`; it is published as an asset on the
[extension's releases](https://github.com/degory/ghul-vsce/releases), not to
npm.

## what works

Syntax highlighting, compile, run, output, and from the analyse service:
diagnostics as you type, hover, and completion. Measured in Chromium against
the containers: a diagnostic appears about 500 ms after a keystroke, of which
300 ms is the deliberate debounce.

The analyser is what makes those possible. Warm, it answers an edit in a
millisecond or two; a cold compile pays process start, reflection and a
from-scratch symbol table and takes seconds, so per-keystroke compilation would
be both slower and more expensive.

Not implemented: go to definition, references, rename, formatting and signature
help. The language server offers all of them, so they are wiring rather than
work.

Highlighting comes from a Monarch grammar (`web/wwwroot/ghul-language.js`) and
is approximate. It gives instant colour while typing. The language server also
serves semantic tokens, which would colour identifiers by what the compiler
resolved them to; that is not wired up yet.

## embedding

`embed.html` is the editor with no chrome, meant to be framed by another site.
The frame owns only the editor: output, diagnostics and status are posted to the
parent, which renders them in whatever it already has, so an embedding page does
not end up with two differently-styled output panels.

Messages carry `channel: "ghul-playground"`. Origins are checked both ways: the
frame ignores messages from anywhere but an allowed parent, and replies only to
that parent's origin, never to `*`.

Parent to frame:

| type | |
| --- | --- |
| `init` | `{ source, theme }` — create the editor. Must not be sent before `loaded`. |
| `source` | `{ source }` — replace the program |
| `theme` | `{ theme }` — a Monaco theme name |
| `run` | compile and run |

Frame to parent:

| type | |
| --- | --- |
| `loaded` | the frame's script is running and listening |
| `ready` | the editor exists |
| `height` | `{ height }` — what the content needs; the frame cannot size itself |
| `status` | `{ state, detail }` — `compiling`, `starting runtime`, `running`, `done`, `failed`, `error` |
| `output` | `{ text }` — what the program wrote |
| `diagnostics` | `{ diagnostics }` — from the compiler |
| `analyser` | `{ state }` — `ready`, `connecting` or `disconnected` |

**Wait for `loaded` before sending `init`.** `postMessage` is not queued, so a
parent that sends `init` while the frame is still loading loses it silently and
sees an editor that never appears.

The .NET runtime is fetched on the first run rather than at load, because a
documentation page embedding one of these per example cannot pay several
megabytes on every navigation.

## sessions

One WebSocket, one private workspace, one language server process. Processes
are never shared between clients: a fresh process is the isolation boundary
between them, so recycling one is a requirement rather than an optimisation.

A session is closed after five minutes idle, and after an hour regardless. The
client is expected to tolerate that, and reconnects and resends the document,
which is cheap because there is only ever one file.

The client addresses a fixed virtual path and never learns where its workspace
actually is; the bridge maps between the two, so a browser cannot address
anything outside its own session by naming a different URI.

Concurrency is capped rather than queued, because a warm analyser holds roughly
260 MB and opening a session is far cheaper for a client than for the service.
`/health` answers even when every slot is taken: it reports that the service
exists, which is what a front end needs in order to decide whether to offer
editing at all.

## before this is exposed to anyone

Run in their containers the services are contained: non-root, read-only root
filesystem, all capabilities dropped, `no-new-privileges`, a tmpfs for scratch,
and memory, CPU and process limits. Still outstanding:

- **Block egress.** Both containers have a network because they need ingress,
  and nothing currently stops them making outbound connections. Block it at the
  host firewall or put them on an internal network behind the proxy.
- Per-address rate limiting, and a concurrency cap on compiling as well as on
  sessions.
- Terminate TLS in front of them. A page served over HTTPS cannot call an HTTP
  backend or open an insecure WebSocket, so this is a functional requirement
  for embedding as well as a security one.

Restricting the reference set (`REFERENCES` in `shared/toolchain.js`) makes
some APIs unnameable and so uncallable: `System.Net.Http` and
`System.Diagnostics.Process` are both unreachable, and
`System.Runtime.InteropServices.JavaScript` is excluded so user code cannot
script the hosting page. It does **not** deny the filesystem.
`System.Runtime` type-forwards the `System.IO` surface and cannot be dropped,
so `IO.File` compiles regardless. That is survivable only because the compiled
program runs in the browser.

## layout

| | |
| --- | --- |
| `web/` | the browser app: a .NET WebAssembly host plus the Monaco front end |
| `web/Program.cs` | the only C#; see below |
| `web/wwwroot/main.js` | editor, compile request, run, and wiring the two below |
| `web/wwwroot/lsp.js` | the LSP client: markers, hover and completion providers |
| `web/wwwroot/ghul-language.js` | Monarch grammar and language configuration |
| `analyse-service/` | a WebSocket in front of one language server per editor |
| `compile-service/` | compiles posted source, returns an assembly |
| `shared/toolchain.js` | where the toolchain is, and the reference set |
| `runner/` | the load-and-run logic, in ghūl |
| `examples/` | small programs used to check the host by hand |

`shared/toolchain.js` is shared deliberately. If the analyse service and the
compile service disagreed about the reference set, the editor would report
errors the build does not, or stay silent about errors the build reports.

### no LSP client library

Monaco's own APIs cover what is needed: `setModelMarkers` for diagnostics,
`registerHoverProvider` for hover, `registerCompletionItemProvider` for
completion. Each takes a plain callback, so `web/wwwroot/lsp.js` speaks LSP
directly in a few hundred lines. That avoids `monaco-languageclient` and its
`@codingame/monaco-vscode-*` dependency chain.

### why there is any C# here

`web/Program.cs` exists because `[JSExport]`, the way JavaScript calls into
.NET, is implemented by a Roslyn source generator. It emits a module
initializer that registers the method and an unsafe wrapper that marshals
through a `JSMarshalerArgument*` buffer. ghūl emits the attribute itself
correctly, but the attribute does nothing without that generated glue.

`runner/src/runner.ghul` implements the same logic in ghūl and compiles
cleanly, with the intent that the C# shrinks to a single delegating call. That
is currently blocked: a C# project referencing the ghūl library fails with
`CS0012`, because the ghūl-emitted assembly records a reference to
`System.Runtime 8.0.0.0` while recording `System.Memory 10.0.0.0` alongside
it.
