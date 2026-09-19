# The nginx files the host runs verbatim from this repository, as
# "repository file:live path" with the live path under /etc/nginx. Sourced by
# check-nginx.sh and apply-nginx.sh; host-setup.sh installs the same files on
# first setup, so a file added there belongs here too.
nginx_files=(
    "nginx/playground-limits.conf:conf.d/playground-limits.conf"
    "nginx/reject-unknown-hosts.conf:conf.d/reject-unknown-hosts.conf"
    "nginx/playground.ghul.dev.conf:sites-available/playground.ghul.dev"
    "nginx/ghul.dev.conf:sites-available/ghul.dev"
)
