# Design notes

Why the playground is shaped the way it is: what runs where, what bounds the
cost of running it for anyone who turns up, and the decisions that are not
obvious from the code. The [README](../README.md) says how to run and embed it.

## the trust split

Four parts, separated by how much they are trusted with.

| | runs where | handles untrusted source | executes untrusted code |
| --- | --- | --- | --- |
| editor | browser | yes | no |
| analyse service | server | yes | no |
| compile service | server | yes | no |
| the compiled program | **browser** | yes | yes, in the browser's sandbox |

Source is compiled on the server, and the resulting .NET assembly is sent back
to the browser, which loads and runs it. The server never executes what it
compiles, and that is the load-bearing decision. A .NET runtime in the browser
has no host filesystem and no network beyond what the page already has, so a
program that tries `IO.File.read_all_text` gets a `DirectoryNotFoundException`
rather than reaching anything. It runs inside the browser's own sandbox, so
getting out of it would take a browser vulnerability - the same one any web
page would need - rather than anything this project controls. A runaway loop is
a tab that stops responding, not a server to clean up.

Analysing as you type and compiling on demand are different jobs, done by the
same compiler binary in different modes, so they are two services: one holds a
session open per editor, the other takes a source and hands back an assembly.

The .NET runtime is fetched on the first run rather than at page load, because a
documentation page embedding one of these per example cannot pay several
megabytes on every navigation.

## sessions

One WebSocket, one private workspace, one language server process. Processes
are never shared between clients: a fresh process is the isolation boundary
between them, so recycling one is a requirement rather than an optimisation.

A session is closed after five minutes idle, and after an hour regardless. The
client tolerates that: it reconnects and resends the document, which is cheap
because there is only ever one file.

The client addresses a fixed virtual path and never learns where its workspace
actually is; the bridge maps between the two, so a browser cannot address
anything outside its own session by naming a different URI.

Sessions are capped rather than queued, because a warm analyser holds tens of
megabytes and opening one is far cheaper for a client than for the service.
`/health` answers even when every slot is taken: it reports that the service
exists, which is what a front end needs in order to decide whether to offer
editing at all.

## limits

The services run the compiler on whatever they are sent, so what bounds the cost
matters more than who is sending it.

Compiling is capped at two at once with a short queue behind it, and answers 503
past the end of the queue. The cap rather than `mem_limit` is what keeps the
container off its ceiling: a compile costs about a CPU-second and peaks near
200 MB, and enough simultaneous requests without one drove the container into
its memory cap, where the kernel killed compilers and every request in flight
failed. Thirty at once was enough. Each compile is also given ten seconds and
32 KB of source.

Analysing is capped at six sessions, which bounds memory directly, with the idle
timeout and lifetime above.

`deploy/nginx/playground-limits.conf` adds the per-address half: a compile rate
limit and at most two concurrent sessions from one address. It bounds one
address, which is all a proxy can see; the caps above hold whatever the traffic
is spread across.

`ALLOWED_ORIGINS` names the sites that may drive the services from a browser.
It is not access control - anything that is not a browser can claim any origin,
or none - but it stops a third-party page spending this CPU through its own
visitors' browsers. Unset, any origin is accepted, which is what local
development wants.

Run in their containers the services are non-root, on a read-only root
filesystem, with all capabilities dropped, `no-new-privileges`, a tmpfs for
scratch, and memory, CPU and process limits. Outbound traffic is blocked at the
host firewall rather than in compose, because a container needs a network for
ingress and Docker will not give it one without the other.

## the reference set

`REFERENCES` in `shared/toolchain.js` is the list of framework assemblies user
code can name. The test for an entry is whether it runs in the wasm host, not
whether it is safe: the server only compiles, so nothing in the list changes
what the server is exposed to. Two families stay out on that test.
`System.Runtime.InteropServices.JavaScript` would let a program script the
hosting page, which is the one exclusion that matters to anyone but the
program's author. `System.Net.Http` is the browser's `fetch`, which would make
every visitor's browser a network egress under this origin.

The list does **not** deny the filesystem. `System.Runtime` type-forwards the
`System.IO` surface and cannot be dropped, so `IO.File` compiles regardless;
that is survivable only because the compiled program runs in the browser. If
execution ever moved server-side, none of this would be a sandbox.

The list has to be closed under assembly reference: a type whose members name an
assembly that is not loaded fails to materialise and then reports as a missing
member, which is why some entries are there only as the closure of others.

Both services read the same list deliberately. If they disagreed, the editor
would report errors the build does not, or stay silent about errors the build
reports.

## access tokens

The deployment at playground.ghul.dev configures none. The audience is whoever
is reading ghul.dev, which a shared token cannot be handed to without handing it
to everybody; and what a token would have bounded is cost, which the caps bound
directly and without asking a reader for anything. `/health` reports
`tokensRequired: false` there.

The mechanism stays for a deployment with a smaller audience. The services take
a short fixed list of shared tokens, comma separated, in `PLAYGROUND_TOKENS`.
Anyone holding one may use them; there is no per-user identity, no expiry, and
no revocation beyond editing the list and restarting. With none configured the
services are open, and both say so at startup - a decision to make deliberately
rather than a default to arrive at.

The compile service takes `Authorization: Bearer <token>` and answers 401 when
it is missing or wrong. The analyse service takes it as a WebSocket subprotocol,
because a browser cannot set headers on a WebSocket and a query parameter would
land in access logs; it is checked at the upgrade, so a bad token is a socket
that never opens.

`/health` is unauthenticated and reports `tokensRequired`, so an embedding page
can ask whether a back end exists, and whether to ask for a token, before it has
one to offer. A front end that cannot reach `/health` treats the answer as "no
token needed": the token dialog is not the way to tell somebody the back end is
down. The token lives in `localStorage` for the playground's own origin, so a
reader entering it once has it for every embedded example on every page.

An address allow list was tried first and removed. It cannot work once the
audience is the readers of a documentation site.

## no LSP client library

Monaco's own APIs cover what is needed: `setModelMarkers` for diagnostics,
`registerHoverProvider` for hover, `registerCompletionItemProvider` for
completion, and the same shape for semantic tokens and inlay hints. Each takes
a plain callback, so `web/wwwroot/lsp.js` speaks LSP directly in a few hundred
lines. That avoids `monaco-languageclient` and its `@codingame/monaco-vscode-*`
dependency chain.

## why there is any C# here

`web/Program.cs` exists because `[JSExport]`, the way JavaScript calls into
.NET, is implemented by a Roslyn source generator. It emits a module
initializer that registers the method and an unsafe wrapper that marshals
through a `JSMarshalerArgument*` buffer. ghūl emits the attribute itself
correctly, but the attribute does nothing without that generated glue.

`runner/src/runner.ghul` implements the same logic in ghūl, so the C# can
shrink to a single call that delegates to it. The `CS0012` mismatch that once
stopped a C# project from referencing a ghūl-built library no longer occurs,
so that is now only a matter of doing it.
