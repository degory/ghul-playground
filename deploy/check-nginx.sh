#!/bin/bash
# Whether the nginx configuration the host is running is the one in this
# checkout. Run by the deploy workflow on the host, after it has pulled.
#
# The deploy updates the checkout but cannot install nginx files: that needs
# root, and the deploy user has none. So a change to deploy/nginx/ reaches
# production only when somebody runs apply-nginx.sh on the host. This exits
# non-zero, naming each file that differs and that command, until they have.
# It only reads.
#
# NGINX_ROOT stands in for /etc/nginx, for testing.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="${NGINX_ROOT:-/etc/nginx}"

. "$here/nginx-files.sh"

differs=0

for pair in "${nginx_files[@]}"; do
    live="$root/${pair#*:}"

    if ! cmp -s "$here/${pair%%:*}" "$live"; then
        echo "differs from the repository: $live"
        differs=1
    fi
done

if [ "$differs" -eq 0 ]; then
    echo "nginx configuration matches the repository"
    exit 0
fi

echo
echo "Apply on the host with:"
echo "    sudo $here/apply-nginx.sh"

exit 1
