#!/bin/bash
# Installs the nginx files from this checkout on the host and reloads nginx,
# for an admin to run on demand after a deploy has brought in an nginx change:
#
#     sudo /opt/ghul-playground/deploy/apply-nginx.sh
#
# Only files that differ are touched, and the live ones are backed up first.
# The new configuration is tested before nginx is reloaded; if the test fails,
# the backups are put back, nothing is reloaded, and the script says so.
# Running it when nothing differs does nothing.
#
# NGINX_ROOT, BACKUP_ROOT, NGINX_TEST and NGINX_RELOAD stand in for the real
# paths and commands, for testing.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="${NGINX_ROOT:-/etc/nginx}"
test_command="${NGINX_TEST:-nginx -t}"
reload_command="${NGINX_RELOAD:-systemctl reload nginx}"

. "$here/nginx-files.sh"

changed=()

for pair in "${nginx_files[@]}"; do
    if ! cmp -s "$here/${pair%%:*}" "$root/${pair#*:}"; then
        changed+=("$pair")
    fi
done

if [ ${#changed[@]} -eq 0 ]; then
    echo "nginx configuration already matches the repository; nothing to do"
    exit 0
fi

if [ -z "${NGINX_ROOT:-}" ] && [ "$(id -u)" -ne 0 ]; then
    echo "run as root: sudo $0" >&2
    exit 1
fi

backup="${BACKUP_ROOT:-/var/backups/ghul-playground-nginx}/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup"

# A live path with no previous version is recorded, so a failed test removes
# what this run added rather than leaving it behind.
created=()

for pair in "${changed[@]}"; do
    source="$here/${pair%%:*}"
    relative="${pair#*:}"
    live="$root/$relative"

    if [ -e "$live" ]; then
        mkdir -p "$backup/$(dirname "$relative")"
        cp -p "$live" "$backup/$relative"
    else
        created+=("$live")
    fi

    install -m 644 "$source" "$live"
    echo "installed $live"
done

if $test_command; then
    $reload_command
    echo "nginx reloaded; the previous files are in $backup"
    exit 0
fi

echo "the new configuration failed nginx's test; restoring the previous files" >&2

for pair in "${changed[@]}"; do
    relative="${pair#*:}"

    if [ -e "$backup/$relative" ]; then
        cp -p "$backup/$relative" "$root/$relative"
    fi
done

for live in "${created[@]}"; do
    rm -f "$live"
done

$test_command >/dev/null 2>&1 \
    && echo "restored; nginx was not reloaded and is still running the previous configuration" >&2 \
    || echo "restored, but the restored configuration also fails the test; check nginx before it next reloads" >&2

exit 1
