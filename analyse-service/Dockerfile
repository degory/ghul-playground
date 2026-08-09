# The analyse service, the ghūl language server, and the compiler it drives.
#
# Build context is the repository root, because the service shares the
# reference-set resolution in shared/ with the compile service. The two must
# agree, or the editor would report errors the build does not.
#
# Run limits are applied at run time, not here: see compose.yaml.

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS base

RUN apt-get update \
 && apt-get install -y --no-install-recommends nodejs npm curl \
 && rm -rf /var/lib/apt/lists/*

ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1

ARG GHUL_LANGUAGE_SERVER_VERSION=1.23.0

# Not published to npm; it ships as an asset on the extension's releases.
RUN npm install -g --no-audit --no-fund \
    "https://github.com/degory/ghul-vsce/releases/download/v${GHUL_LANGUAGE_SERVER_VERSION}/ghul-language-server-${GHUL_LANGUAGE_SERVER_VERSION}.tgz"

RUN useradd --create-home --shell /usr/sbin/nologin playground

USER playground
WORKDIR /home/playground

ARG GHUL_COMPILER_VERSION=28.0.0
ARG GHUL_RUNTIME_VERSION=8.1.0

# The language server resolves a compiler by trying `dotnet ghul-compiler` and
# then a bare `ghul-compiler` on PATH. The workspace deliberately has no tool
# manifest, so the bare form is the one that has to work.
RUN dotnet tool install --tool-path /home/playground/tools \
        ghul.compiler --version "${GHUL_COMPILER_VERSION}" \
 && dotnet new classlib -o /tmp/runtime-probe \
 && dotnet add /tmp/runtime-probe package ghul.runtime --version "${GHUL_RUNTIME_VERSION}" \
 && rm -rf /tmp/runtime-probe

ENV PATH="/home/playground/tools:${PATH}" \
    GHUL_RUNTIME_DLL=/home/playground/.nuget/packages/ghul.runtime/${GHUL_RUNTIME_VERSION}/lib/net10.0/ghul-runtime.dll

COPY --chown=playground:playground shared /home/playground/service/shared
COPY --chown=playground:playground analyse-service/*.js /home/playground/service/analyse-service/
COPY --chown=playground:playground package.json /home/playground/service/package.json

# `ws` is the only runtime dependency; monaco is a front-end asset and has no
# business in this image.
RUN cd /home/playground/service && npm install --omit=dev --no-audit --no-fund ws --ignore-scripts

ENV TMPDIR=/tmp \
    HOST=0.0.0.0 \
    PORT=5091

EXPOSE 5091

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:5091/health || exit 1

WORKDIR /home/playground/service
ENTRYPOINT ["node", "analyse-service/server.js"]
