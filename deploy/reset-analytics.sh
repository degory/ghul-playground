#!/usr/bin/env bash
#
# Throw away all analytics history and start again from an empty database.
#
# This is the only complete undo there is, and it is worth knowing why there is
# no narrower one. GoatCounter never stores a visitor's IP address: it derives a
# session from it and drops it, and the session it does store is a random
# identifier rather than anything computed from the address. So no query can
# find "everything from that address" - the information is not in the database.
# Deleting by path is possible from the dashboard (Settings, "Manage
# pageviews"); deleting everything is this script; there is nothing in between.
#
# The situation this is for: the exclusion list was wrong or missing, the
# numbers are polluted, and the history is not yet worth enough to keep. Fix and
# verify the exclusion first, then run this.
#
# Usage:  ./deploy/reset-analytics.sh [--yes]

set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-/opt/ghul-playground}"

# Compose prefixes volume names with the project, which defaults to the name of
# the directory the compose file is in - so this is ghul-playground_… on the
# host but something else in a worktree or a test checkout. Derived rather than
# written out, so the script deletes the volume belonging to the deployment it
# was pointed at instead of whichever one happens to match a hardcoded name.
VOLUME="${VOLUME:-$(basename "$COMPOSE_DIR")_goatcounter-data}"

ASSUME_YES=0

while [ $# -gt 0 ]; do
    case "$1" in
        --yes|-y) ASSUME_YES=1; shift ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

if [ ! -f "$COMPOSE_DIR/compose.yaml" ]; then
    echo "no compose.yaml under $COMPOSE_DIR - set COMPOSE_DIR" >&2
    exit 1
fi

cd "$COMPOSE_DIR"

# Named so the operator sees what is about to go, rather than trusting that the
# script and the deployment agree about which volume is the live one.
if ! docker volume inspect "$VOLUME" >/dev/null 2>&1; then
    echo "no such volume: $VOLUME" >&2
    echo "existing volumes:" >&2
    docker volume ls --format '  {{.Name}}' >&2
    exit 1
fi

echo "This will permanently delete ALL analytics history."
echo
echo "  compose:  $COMPOSE_DIR"
echo "  volume:   $VOLUME"
echo
echo "There is no undo and no partial version of this - see the note at the top"
echo "of this script for why deleting one visitor's data is not possible."
echo

if [ "$ASSUME_YES" != 1 ]; then
    read -r -p "Type 'delete' to confirm: " reply
    if [ "$reply" != "delete" ]; then
        echo "nothing done"
        exit 1
    fi
fi

echo "==> stopping goatcounter"
docker compose stop goatcounter

echo "==> removing the volume"
# `compose rm -f` first: a volume attached to a stopped-but-present container
# cannot be removed, and the failure message points at docker rather than here.
docker compose rm -f goatcounter >/dev/null
docker volume rm "$VOLUME" >/dev/null

echo "==> starting goatcounter on an empty database"
docker compose up -d goatcounter

# -automigrate builds the schema on start, so the wait is for that rather than
# for the process. Until it finishes there is no site to create.
echo "==> waiting for the schema"
for _ in $(seq 1 30); do
    if docker compose exec -T goatcounter \
            curl -fsS -o /dev/null http://127.0.0.1:5092/stats/status 2>/dev/null; then
        break
    fi
    sleep 2
done

echo
echo "Done. The database is empty and has no site in it, so the dashboard will"
echo "not answer until one is created - and nothing is counted until then"
echo "either, which is the safe half of this. See 'analytics' in the README:"
echo
echo "  docker compose exec goatcounter goatcounter db create site \\"
echo "      -vhost=playground.ghul.dev -user.email=YOU@EXAMPLE.COM"
echo
echo "It prompts for a password; that is the dashboard login. Site settings"
echo "went with the old database, so anything changed from the defaults -"
echo "Individual pageviews in particular - has to be set again."
