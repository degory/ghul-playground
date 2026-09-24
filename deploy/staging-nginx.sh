#!/usr/bin/env bash
#
# The deployed nginx configuration, with the host out of it.
#
# Staging serves what ghul.dev serves, so it has to be the same file: a second
# configuration maintained beside the first drifts from it, and what staging
# then proves is that the second one works. This derives the staging
# configuration from ghul.dev.conf by applying the substitutions that are
# genuinely about the host - the certificate, the names, where the files are,
# where the services listen - and nothing else. Anything that changes about how
# the site is served changes in one place and both follow.
#
#   deploy/staging-nginx.sh > wherever.conf
#
# What is dropped, and why each one is host rather than behaviour:
#
#   the :80 redirect server, and the www redirect server - both exist to get a
#     browser onto the canonical name over TLS, and staging has one name and no
#     TLS
#   the TLS listeners, certificates and options - staging is reached through an
#     ssh tunnel, which is the encryption
#   the analytics locations - they proxy to a service staging does not run, and
#     counting a preview would put it in the real figures
#
# What is rewritten: the listeners to plain :80, the name to localhost, the
# roots to where the staging root is mounted, and the service addresses to the
# compose service names.

set -euo pipefail

CONF=$(dirname "${BASH_SOURCE[0]}")/nginx/ghul.dev.conf

[ -f "$CONF" ] || { echo "staging-nginx: no $CONF" >&2; exit 1; }

# The last server block is the site itself; the two before it are redirects to
# it. Taking it by its `server_name ghul.dev;` rather than by line number so
# that adding a block above does not silently take the wrong one.
awk '
    /^server \{/ { block = ""; inside = 1 }
    inside { block = block $0 "\n" }
    /^\}/ && inside {
        inside = 0
        if (block ~ /server_name ghul\.dev;/) site = block
    }
    END { printf "%s", site }
' "$CONF" |
awk '
    # The analytics locations proxy to a service staging does not run.
    /^    location = \/stats\/count \{/ { skip = 1 }
    /^    location \^~ \/stats\/ \{/ { skip = 1 }
    skip && /^    \}/ { skip = 0; next }
    skip { next }
    { print }
' |
sed \
    -e 's|^    listen 443 ssl;|    listen 80;|' \
    -e '/^    listen \[::\]:443 ssl;/d' \
    -e '/^    http2 on;/d' \
    -e 's|^    server_name ghul\.dev;|    server_name localhost;|' \
    -e '/^    ssl_certificate/d' \
    -e '/^    ssl_dhparam/d' \
    -e '/^    include \/etc\/letsencrypt/d' \
    -e 's|^    access_log .*|    access_log /dev/stdout combined;|' \
    -e 's|root /var/www/ghul-dev;|root /srv/site;|' \
    -e 's|root /var/www/playground;|root /srv/playground;|' \
    -e 's|root /var/www;|root /srv;|' \
    -e 's|http://127\.0\.0\.1:5090|http://compile:5090|' \
    -e 's|http://127\.0\.0\.1:5091|http://analyse:5091|'
