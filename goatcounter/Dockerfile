# GoatCounter, the analytics ghul.dev and this playground report to.
#
# Unlike the compile and analyse services, none of this is our code: the image
# exists only to get an upstream program onto the host in a form we can account
# for. It is built from source at a pinned tag rather than pulled as a prebuilt
# image, because every other piece of software on this host comes from Ubuntu's
# archive and this is the one thing that does not - so the least we can do is
# build it from a revision we name, with a toolchain we name.
#
# Nothing here parses hostile input the way the compiler does. What it does hold
# is the only state on the box that cannot be rebuilt from this repository,
# which is a different kind of care: see "analytics" in deploy/README.md for the
# backup and reset story.

# The tag, not the release-2.7 branch the upstream README suggests: a branch
# moves, and an image that builds different code on different days is not one we
# can reason about. Moving to a new release is an edit here.
ARG GOATCOUNTER_VERSION=v2.7.0

# v2.7.0's go.mod requires 1.25.5, so this cannot go backwards without the build
# failing outright. It can go forwards.
FROM golang:1.26-bookworm AS build

ARG GOATCOUNTER_VERSION

WORKDIR /src

# --depth=1 at the tag: the full history is around 100 MB and nothing in the
# build reads it. The resolved commit is carried into the final image so a
# running container can say exactly what it is.
RUN git clone --depth=1 --branch="${GOATCOUNTER_VERSION}" \
        https://github.com/arp242/goatcounter . \
 && git rev-parse HEAD > /revision

# Flags copied from upstream's own build instructions and its Dockerfile, which
# agree. SQLite needs cgo, so this cannot be CGO_ENABLED=0; the static flags and
# the osusergo/netgo tags are together what let the result run in a slim image
# without dragging the Go toolchain's libc behind it.
RUN CGO_ENABLED=1 go build \
        -trimpath \
        -ldflags='-s -w -extldflags=-static' \
        -tags='osusergo,netgo,sqlite_omit_load_extension' \
        -o /goatcounter \
        ./cmd/goatcounter

FROM debian:bookworm-slim

# The binary is static, so this is not about linking. tzdata is here because the
# dashboard renders timestamps in the viewer's timezone and a static Go binary
# carries no zoneinfo of its own; curl is here for HEALTHCHECK, which otherwise
# has nothing to make a request with. Upstream's own image ships neither and
# gets away with it - we would rather the health check work and the timestamps
# be right.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata curl \
 && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /usr/sbin/nologin goatcounter

# The data directory has to exist in the image, owned by the user that will run.
# compose mounts a named volume over this path, and docker seeds a *new* volume
# from whatever is at the mount point in the image - ownership included. With no
# directory here, docker creates the mount point itself as root, the container
# drops to an unprivileged user, and every start dies with
#
#   DB dir not writeable: open .../zdb-write-test-NNN: permission denied
#
# in a restart loop. Testing the image with `docker run` and no volume does not
# reach this: the directory is then created by the running user, who can of
# course write to it. It only appears once a volume is actually mounted.
RUN install -d -o goatcounter -g goatcounter /home/goatcounter/goatcounter-data

COPY --from=build /goatcounter /usr/local/bin/goatcounter
COPY --from=build /revision /etc/goatcounter-revision

USER goatcounter
WORKDIR /home/goatcounter

# The SQLite database lives here and compose.yaml mounts a named volume over it.
# Anything written outside this path is lost when the container is replaced,
# which is correct: the volume is the only thing on this box worth backing up.
ENV GOATCOUNTER_DB=sqlite+/home/goatcounter/goatcounter-data/db.sqlite3

EXPOSE 5092

# count.js, and NOT the /status endpoint upstream's README recommends for health
# monitors, because /status does not work when -base-path is set. The intercept
# for it compares the request path to the literal "/status" before the base path
# has been stripped (handlers/mw.go, "Intercept /status here so it works
# everywhere"), so under a base path neither spelling reaches it: /status is not
# routed at all and /stats/status falls through to the static file handler.
# Verified against v2.7.0 - both 404, with different bodies.
#
# count.js is a better probe than it looks. It is served without authentication
# and without resolving a site from the Host header, so it answers 200 whether
# or not a site exists yet and whatever the check calls itself - which a
# dashboard URL does not. It proves the process is up and the base path is
# mounted where the nginx config expects it, which is all a health check here
# should claim.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -fsS -o /dev/null http://127.0.0.1:5092/stats/count.js || exit 1

# The flags are given here rather than as GOATCOUNTER_* environment variables
# because a boolean like -automigrate is set by an environment variable being
# *present*, empty value and all, which reads as a mistake every time anyone
# sees it. Spelled out, each one means exactly what its documentation says.
#
# -base-path is what lets GoatCounter live under a path on an existing domain
# instead of claiming a subdomain of its own. It must agree with the location
# block in deploy/nginx/playground.ghul.dev.conf.
ENTRYPOINT ["goatcounter", "serve"]
CMD ["-listen=0.0.0.0:5092", "-tls=none", "-base-path=/stats", "-automigrate"]
