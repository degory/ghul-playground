# Cloud code review brief

What this repository is, and what to watch for in it. Everything else - what PR
context is available, how to post a review, what makes a finding worth raising,
comment hygiene, PR-description shape - comes from the review workflow's runtime
notes. Don't restate it here: this file is read first, so a stale copy would
silently override the current text.

Not loaded by local Claude Code; only the cloud reviewer reads this.

## What this repo is

`ghul-playground` is the public ghūl playground and REPL at
`ghul.dev/playground/` and `ghul.dev/repl/`, embedded in the ghul.dev pages. It
has two server-side services, which compile and analyse ghūl source sent by
anyone on the internet, and a browser front end, which runs the compiled
program. There is no sign-in: what keeps the site safe is the design, not who
is allowed to use it.

A pull request that only moves version pins is approved before it reaches you,
by `scripts/version-bump-only.sh`. Everything you see is some other change.

## Changes that need the maintainer

The site's safety rests on a few decisions, and a change to any of them needs
the maintainer's own review, whatever the diff looks like. When a change
touches one of these areas, or you cannot convince yourself it leaves them as
they were, request changes with one finding that names the area and says the
change needs the maintainer's review. Do not approve it. That review is the
correct outcome for such a change, not a failure to finish: branch protection
then holds the pull request until the maintainer has read it.

The areas:

- **Where code runs.** A compiled program runs in the browser's sandbox, and
  the server never runs anything it compiles. Anything that executes,
  evaluates or loads user-supplied code or a compiled assembly on the server.
- **The reference set.** Which assemblies user code can name when it is
  compiled or analysed, and the exclusions from it, such as
  `System.Runtime.InteropServices.JavaScript`.
- **The limits.** The caps on simultaneous compiles and analyser sessions, the
  compile queue, per-request time and size limits, and the per-address limits
  in `deploy/nginx/`. These, not a login, are what bound the cost of an open
  service.
- **The origin and token checks.** `ALLOWED_ORIGINS`, `shared/origins.js`,
  `shared/tokens.js`, and CORS, including the deliberately open `/health`.
- **Headers.** The content security policy, `frame-ancestors`, and any other
  response header that decides what may frame, script or embed the site.
- **Deployment and the host.** `deploy/`, `compose.yaml`, the Dockerfiles,
  container user, network, volume or resource settings, nginx configuration,
  and the workflows under `.github/workflows/`.
- **Secrets.** Anything that reads, writes, logs or passes on a secret, a key,
  a token or a deploy credential.

A change that moves only a version pin inside one of these files is not a
change to the area. Anything else in them is.

## What to watch for otherwise

- User input reaching a shell, a file path or a process argument on the
  server without being validated.
- Error messages or logs that expose server paths, environment or internal
  addresses to the browser.
- ghūl in the runner or the examples that is wrong or non-idiomatic.
  `GHUL.md` is the source of truth.

## Versioning

This repo deploys a site, not a package. Version bumps are not a concern here.
