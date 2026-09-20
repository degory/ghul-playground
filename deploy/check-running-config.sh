#!/bin/bash
# Whether the configuration the services are *running* is the one in this
# checkout. Run by the deploy workflow on the host, after it has brought the
# services up. It only reads.
#
# This exists because a deploy can succeed while changing nothing. A file
# mounted into a container, or read once at start, can be replaced on the host
# without the running process ever seeing it - and every signal a deploy has
# says success: the run is green, the host has the new file, the container is
# up. The only thing that disagrees is the service's own answer about what it
# is running, which is what this asks for.
#
# Found the hard way: a Prometheus relabelling rule that reached the host and
# never reached Prometheus, because its configuration was a single-file bind
# mount and a single-file bind mount pins the inode it started with.

set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
compose="${COMPOSE_DIR:-$(cd "$here/.." && pwd)}"

cd "$compose"

failures=0

note() {
    echo "$1"
    failures=$((failures + 1))
}

# Prometheus hands back the configuration it parsed at start. Comparing whole
# files would fail on formatting, so this asks whether what the repository says
# should be there is there.
running=$(docker compose exec -T prometheus \
    wget -qO- http://127.0.0.1:9090/api/v1/status/config 2>/dev/null) || running=""

if [ -z "$running" ]; then
    note "prometheus: could not be asked what configuration it is running"
else
    for wanted in metric_relabel_configs 'job_name' cadvisor node-exporter; do
        case "$running" in
            *"$wanted"*) ;;
            *) note "prometheus: running configuration does not mention $wanted" ;;
        esac
    done
fi

# The snapshotter says whether it is writing by its own health, which is the
# one thing about it that a deploy cannot see: it fails by going on running.
health=$(docker compose ps snapshot --format '{{.Status}}' 2>/dev/null)

case "$health" in
    *healthy*) ;;
    *starting*) echo "snapshot: still starting, which is not yet a failure" ;;
    *) note "snapshot: not healthy ($health)" ;;
esac

if [ "$failures" -gt 0 ]; then
    echo
    echo "A service is not running what this checkout says it should. If a"
    echo "configuration file changed, the container carrying it has to be"
    echo "replaced rather than restarted:"
    echo
    echo "    sudo docker compose up -d --build <service>"
    exit 1
fi

echo "the running services match this checkout"
