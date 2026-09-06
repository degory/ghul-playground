# ghūl playground

Edit [ghūl](https://ghul.dev) in the browser, with diagnostics, hover and
completion as you type. Compile it, and run it in the browser.

It runs at [playground.ghul.dev](https://playground.ghul.dev) and is embedded in
the examples on [ghul.dev](https://ghul.dev). Source is compiled on the server;
the resulting assembly is sent back and run in the browser, so the server never
executes what it compiles. What that rests on, and what bounds the cost of
compiling for anyone who turns up, is in [docs/design.md](docs/design.md).

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
needs `ghul-language-server` on `PATH`, which is published as an asset on the
[extension's releases](https://github.com/degory/ghul-vsce/releases).

## what works

Syntax highlighting, compile, run and output; and from the analyse service,
diagnostics as you type, hover, completion, semantic tokens and the narrowing
inlay hints. A diagnostic appears about 500 ms after a keystroke, 300 ms of
which is the debounce.

Not implemented: go to definition, references, rename, formatting and signature
help. The language server offers all of them, so they are wiring rather than
work.

## configuration

Everything is an environment variable read by `docker compose`, or by the
services directly when run outside it. None of these is set for local use.

| | |
| --- | --- |
| `PLAYGROUND_TOKENS` | comma-separated shared tokens; unset, the services are open, which is how playground.ghul.dev runs |
| `ALLOWED_ORIGINS` | the sites that may drive the services from a browser; unset, any |
| `MAX_CONCURRENT_COMPILES`, `MAX_QUEUED_COMPILES`, `COMPILE_TIMEOUT_MS` | compile service caps |
| `MAX_SESSIONS`, `POOL_SIZE`, `MAX_SESSION_MS` | analyse service caps |

The reference assemblies user code can name are listed in
`shared/toolchain.js`, which both services read.

## embedding

`embed.html` is the editor with no chrome, meant to be framed by another site.
The frame owns only the editor: output, diagnostics and status are posted to the
parent, which renders them in whatever it already has.

Messages carry `channel: "ghul-playground"`. Origins are checked both ways: the
frame ignores messages from anywhere but an allowed parent, and replies only to
that parent's origin, never to `*`.

Parent to frame:

| type | |
| --- | --- |
| `init` | `{ source, theme }` - create the editor. Must not be sent before `loaded`. |
| `source` | `{ source }` - replace the program |
| `theme` | `{ theme }` - a Monaco theme name |
| `run` | compile and run |

Frame to parent:

| type | |
| --- | --- |
| `loaded` | the frame's script is running and listening |
| `ready` | the editor exists |
| `height` | `{ height }` - what the content needs; the frame cannot size itself |
| `status` | `{ state, detail }` - `compiling`, `starting runtime`, `running`, `done`, `failed`, `error` |
| `output` | `{ text }` - what the program wrote |
| `diagnostics` | `{ diagnostics }` - from the compiler |
| `analyser` | `{ state }` - `ready`, `connecting` or `disconnected` |

**Wait for `loaded` before sending `init`.** `postMessage` is not queued, so a
parent that sends `init` while the frame is still loading loses it silently and
sees an editor that never appears.

## checking it works

Two harnesses, neither with dependencies of its own:

```sh
node test/analyser-stress.js        # can broken source stop the analyser answering?
node test/browser-end-to-end.js     # editor, analyser, compile and run, in a real browser
```

Both take `ANALYSE_URL` / `BASE` and `TOKEN` to run against a deployment rather
than a local one. The browser test needs a Chrome or Chromium binary and takes
`CHROME` if it is not where Playwright puts it.

## layout

| | |
| --- | --- |
| `web/` | the browser app: a .NET WebAssembly host plus the Monaco front end |
| `web/Program.cs` | the only C#: the `[JSExport]` glue the source generator needs (see the design notes) |
| `web/wwwroot/playground.js` | the editor wired to the services: diagnostics, hover, completion, compile, run |
| `web/wwwroot/main.js` | the standalone page's chrome around it |
| `web/wwwroot/embed.js` | embedded mode: the editor alone, framed by another site |
| `web/wwwroot/lsp.js` | the LSP client the two modes share |
| `web/wwwroot/ghul-language.js` | Monarch grammar and language configuration |
| `web/wwwroot/theme.js` | editor themes, matched to how ghul.dev renders a static example |
| `web/wwwroot/token.js` | the access token, and asking for one |
| `analyse-service/` | a WebSocket in front of one language server per editor |
| `compile-service/` | compiles posted source, returns an assembly |
| `shared/toolchain.js` | where the toolchain is, and the reference set |
| `runner/` | the load-and-run logic, in ghūl |
| `examples/` | small programs used to check the host by hand |
| `deploy/` | host setup and the nginx configuration |
| `docs/design.md` | why it is built this way |

## issues

[View open issues](https://github.com/degory/ghul/issues?q=is%3Aopen+is%3Aissue+label%3Aghul-playground) or [raise a new one](https://github.com/degory/ghul/issues/new?labels=ghul-playground).
