# Design notes

How the playground is put together, and why. The [README](../README.md) covers
running and embedding it.

## where things run

| | runs where | handles untrusted source | executes untrusted code |
| --- | --- | --- | --- |
| editor | browser | yes | no |
| analyse service | server | yes | no |
| compile service | server | yes | no |
| the compiled program | **browser** | yes | yes, in the browser's sandbox |

The server compiles the source and sends the assembly back to the browser. The
browser loads and runs it. The server never runs what it compiles.

This is the main design decision. A .NET runtime in the browser has no host
filesystem, and no network beyond what the page already has. A program that
calls `IO.File.read_all_text` gets a `DirectoryNotFoundException`. A program
that loops forever makes a tab stop responding; the server is not involved. The
program runs inside the browser's own sandbox, so escaping it would need a
browser vulnerability, which is not something this project can add to or take
away.

Analysing as you type and compiling on demand are different jobs. The same
compiler binary does both, in different modes, so they are two services. The
analyse service holds one session open per editor. The compile service takes a
source file and returns an assembly.

The browser fetches the .NET runtime on the first run, not at page load. A
documentation page can embed several editors, and downloading the runtime for
each one on every visit would be several megabytes per page.

## sessions

Each editor gets one WebSocket, one private workspace directory, and one
language server process. Processes are not shared between clients. The process
is the isolation boundary, so a session ends by ending its process.

A session closes after five minutes idle, and after an hour in any case. The
client reconnects and resends the document. There is only one file, so this is
cheap.

The client refers to its document by a fixed virtual path. The service maps
that path to the real workspace directory. The client never sees the real path
and cannot name any other.

Sessions are capped, not queued. A warm analyser uses tens of megabytes, so the
cap is what bounds the service's memory. `/health` still answers when every
slot is taken, so an embedding page can tell that the service is up.

## limits

Anyone can send source to the services, so the limits are on cost, not on who
is sending.

The compile service runs at most two compiles at once and queues a few more
behind them. Past the queue it answers 503. Each compile gets ten seconds and
32 KB of source. The compile cap is what keeps the container inside its memory
limit: a compile peaks near 200 MB, and without the cap thirty simultaneous
requests were enough to hit the limit, at which point the kernel killed
compilers and every request in flight failed.

The analyse service caps the number of open sessions, with the idle timeout and
lifetime above. The cap bounds memory directly.

nginx adds per-address limits in `deploy/nginx/playground-limits.conf`: a
compile rate limit and at most two sessions from one address. A proxy can only
see addresses, so these bound one client; the service caps above bound the
total.

`ALLOWED_ORIGINS` lists the sites allowed to call the services from a browser.
It is not access control, because a non-browser client can send any origin
header or none. It stops another site from using this CPU through its own
visitors' browsers. Unset, any origin is accepted, which is right for local
development.

The containers run as a non-root user with a read-only root filesystem, all
capabilities dropped, `no-new-privileges`, a tmpfs for scratch space, and
memory, CPU and process limits. Outbound traffic is blocked by the host
firewall. Compose cannot do this, because a container needs a network for
inbound traffic and Docker does not offer inbound without outbound.

## the reference set

`REFERENCES` in `shared/toolchain.js` lists the framework assemblies user code
can use. An assembly is on the list if what it offers runs in the browser. The
list is not a security boundary: the server only compiles, so the list does not
change what the server is exposed to.

Two things are left out. `System.Runtime.InteropServices.JavaScript` would let
a program script the page that hosts it. `System.Net.Http` maps to the
browser's `fetch`, which would let a program make requests from every visitor's
browser under this origin.

The list does not exclude the filesystem. `System.Runtime` forwards the
`System.IO` types and cannot be left out, so `IO.File` always compiles. This is
fine because the program runs in the browser, where there is no filesystem to
reach.

The list includes each assembly's transitive references. The compiler cannot
load a type whose members mention an assembly it does not have, and reports the
type's members as missing. Some entries are there only for this reason.

Both services read the same list. If they differed, the editor would show
errors the build does not, or miss errors the build reports.

## access tokens

playground.ghul.dev runs without access tokens. Anyone can use it. Its
audience is everyone who reads ghul.dev, and a shared token cannot be given to
everyone without being public. The limits above bound the cost instead.
`/health` reports `tokensRequired: false` there.

The token mechanism is kept for a deployment with a smaller audience.
`PLAYGROUND_TOKENS` is a comma-separated list of shared tokens. Anyone with one
can use the services. There is no per-user identity, no expiry, and no
revocation except editing the list and restarting. With the variable unset the
services are open, and both print a warning at startup saying so.

The compile service takes the token as `Authorization: Bearer <token>` and
answers 401 without it. The analyse service takes it as a WebSocket
subprotocol, because a browser cannot set headers on a WebSocket and a query
parameter would appear in access logs. It is checked at the upgrade, so a bad
token means the socket never opens.

`/health` needs no token and reports `tokensRequired`, so an embedding page can
find out whether the service is up and whether to ask for a token before it has
one. If `/health` is unreachable the page assumes no token is needed, because
a token prompt is the wrong way to say the service is down. The browser keeps
the token in `localStorage` for the playground's origin, so it is entered once
and used by every embedded editor on every page.

An IP address allow list was tried first and removed. It cannot work when the
audience is the readers of a public site.

## no LSP client library

Monaco's own API is enough: `setModelMarkers` for diagnostics,
`registerHoverProvider`, `registerCompletionItemProvider`, and the same pattern
for semantic tokens and inlay hints. Each takes a callback, so
`web/wwwroot/lsp.js` speaks LSP directly in a few hundred lines. This avoids
`monaco-languageclient` and its `@codingame/monaco-vscode-*` dependency chain.

## why there is any C#

`web/Program.cs` exists because `[JSExport]`, which is how JavaScript calls into
.NET, is implemented by a Roslyn source generator. The generator emits a module
initializer that registers the method, and an unsafe wrapper that marshals
arguments through a `JSMarshalerArgument*` buffer. ghūl can emit the attribute,
but without the generated code the attribute does nothing.

`runner/src/runner.ghul` implements the same logic in ghūl. The C# can shrink to
a single call into it. A `CS0012` error used to stop a C# project from
referencing a ghūl library; it no longer occurs, so this is now just work to do.
