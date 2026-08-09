# ghūl playground

Edit [ghūl](https://ghul.dev) in the browser, compile it, and run it in the browser.

**This is a prototype.** It works end to end, but the compile service has no
sandbox and no rate limiting, so it is not yet something to put on the public
internet. See [before this is exposed to anyone](#before-this-is-exposed-to-anyone).

## how it works

Three parts, separated by how much they are trusted with.

| | runs where | handles untrusted source | executes untrusted code |
| --- | --- | --- | --- |
| editor | browser | yes | no |
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

## running it

You need the [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0)
and [Node.js](https://nodejs.org/) 22 or later.

```sh
dotnet tool restore
npm install
```

`npm install` also stages the Monaco editor into the web app, which is not
committed.

Then, in two terminals:

```sh
npm run compile-service     # http://127.0.0.1:5090
npm run web                 # http://127.0.0.1:5080
```

Open <http://127.0.0.1:5080>. Edit the program and press **Compile and run**,
or <kbd>Ctrl</kbd>+<kbd>Enter</kbd>.

The compile service binds to `127.0.0.1` and the web app expects it at
`http://127.0.0.1:5090`. To run them apart, set `HOST` and `PORT` on the
service and change `COMPILE_SERVICE` at the top of `web/wwwroot/main.js`.

## what works, and what does not

Working: syntax highlighting, compile, run, output, and compiler diagnostics
reported as editor markers on the exact source range.

Not implemented:

- **Hover and completion.** Nothing of either is wired up.
- **Diagnostics as you type.** They arrive on Compile and run, not while
  editing.

Both need a language service holding a live analyser per editing session,
which is the next substantial piece of work. `ghul-language-server` already
speaks LSP and drives the compiler's analysis mode, so the work is hosting it
and connecting it, not writing it. Monaco needs no LSP client library for
this: `setModelMarkers`, `registerHoverProvider` and
`registerCompletionItemProvider` are plain callbacks.

Highlighting comes from a Monarch grammar (`web/wwwroot/ghul-language.js`) and
is approximate by design. It gives instant colour while typing; anything that
has to be correct rather than fast should come from the compiler.

## before this is exposed to anyone

The compile service runs the compiler on posted source, as whatever user it
runs as, in a temporary directory. It limits source size and compilation time
and nothing else. Before it faces anyone:

- Run it in a container with no network, a read-only root filesystem, a memory
  cap, a CPU quota, a process limit and a hard wall-clock kill. The compiler
  is the component parsing hostile input, so it is the component to contain.
- Add per-address rate limiting and a global concurrency cap that queues
  rather than scales.
- Cache on a hash of the source and the compiler version. Most requests to a
  playground are the same handful of examples.
- Serve it from its own origin, and run the browser runtime in a sandboxed
  iframe, so that a compromise cannot reach another site's session.

Restricting the reference set the service compiles against (see `REFERENCES`
in `compile-service/server.js`) makes some APIs unnameable and so uncallable:
`System.Net.Http` and `System.Diagnostics.Process` are both unreachable. It
does **not** deny the filesystem. `System.Runtime` type-forwards the
`System.IO` surface and cannot be dropped, so `IO.File` compiles regardless.
That is survivable only because the compiled program runs in the browser.

## layout

| | |
| --- | --- |
| `web/` | the browser app: a .NET WebAssembly host plus the Monaco front end |
| `web/Program.cs` | the only C#; see below |
| `web/wwwroot/main.js` | all UI logic: editor, compile request, markers, run |
| `web/wwwroot/ghul-language.js` | Monarch grammar and language configuration |
| `runner/` | the load-and-run logic, in ghūl |
| `compile-service/server.js` | compiles posted source, returns an assembly |
| `examples/` | small programs used to check the host by hand |

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
