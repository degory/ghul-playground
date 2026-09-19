#!/bin/bash
# Whether the nginx configuration the host is running is the one in this
# checkout. Run by the deploy workflow on the host, after it has pulled.
#
# The deploy updates the checkout but cannot install nginx files: that needs
# root, and the deploy user has none. host-setup.sh installs them, so a change
# to deploy/nginx/ reaches production only when somebody runs it, and nothing
# said so. This says so: it exits non-zero, naming each file that differs and
# the commands that install it. It only reads.
#
# NGINX_ROOT stands in for /etc/nginx, for testing.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="${NGINX_ROOT:-/etc/nginx}"

# The files host-setup.sh installs verbatim, as repository file and live path.
# Keep this in step with the nginx section of host-setup.sh.
pairs=(
    "nginx/playground-limits.conf:conf.d/playground-limits.conf"
    "nginx/reject-unknown-hosts.conf:conf.d/reject-unknown-hosts.conf"
    "nginx/playground.ghul.dev.conf:sites-available/playground.ghul.dev"
    "nginx/ghul.dev.conf:sites-available/ghul.dev"
)

commands=()

for pair in "${pairs[@]}"; do
    source="$here/${pair%%:*}"
    live="$root/${pair#*:}"

    if ! cmp -s "$source" "$live"; then
        echo "differs from the repository: $live"
        commands+=("sudo install -m 644 $source $live")
    fi
done

if [ ${#commands[@]} -eq 0 ]; then
    echo "nginx configuration matches the repository"
    exit 0
fi

echo
echo "Install on the host with:"

for command in "${commands[@]}"; do
    echo "    $command"
done

echo "    sudo nginx -t && sudo systemctl reload nginx"

exit 1
