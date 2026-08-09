#!/usr/bin/env bash
#
# Everything the playground host needs that is not the application itself.
#
# Idempotent: run it on a fresh Ubuntu box to provision one, or on the running
# host to put a piece back after it has drifted. It changes only what it is
# named for and leaves the rest alone.
#
# It deliberately does NOT do three things, each because it cannot be done
# safely from a script that might be re-run:
#
#   - issue the certificate. Let's Encrypt rate-limits issuance, so a script
#     that re-issues on every run will eventually lock the host out of renewal.
#     See "certificates" in deploy/README.md for the one-time command.
#   - write .env. The access tokens live only on the host, at mode 600.
#   - set the Linode firewall, which is dashboard-side. deploy/README.md lists
#     the rules.
#
# Usage:  sudo ./deploy/host-setup.sh [--user NAME] [--domain NAME]

set -euo pipefail

USER_NAME="degory"
DOMAIN="playground.ghul.dev"

# The docker network the services share. Pinned in compose.yaml, and repeated
# here because the firewall rules below match on it: if the two ever disagree,
# the containers silently regain the egress these rules exist to remove.
SUBNET="172.31.240.0/24"

while [ $# -gt 0 ]; do
    case "$1" in
        --user) USER_NAME="$2"; shift 2 ;;
        --domain) DOMAIN="$2"; shift 2 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

if [ "$(id -u)" != 0 ]; then
    echo "run this with sudo" >&2
    exit 2
fi

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

say() { printf '\n== %s\n' "$1"; }

say "packages"

# All from Ubuntu's own archive - there are no third-party apt sources on this
# host, and adding one would be a new thing to trust.
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
    nginx certbot python3-certbot-nginx \
    docker.io docker-compose-v2 \
    iptables-persistent netfilter-persistent \
    chrony unattended-upgrades

say "ssh"

# A drop-in rather than an edit to sshd_config, so an Ubuntu upgrade replacing
# that file cannot silently undo this. Check that the main config actually
# includes the directory first: without the Include line a drop-in is read by
# nobody and the host looks hardened while accepting passwords.
if ! grep -qE '^\s*Include\s+/etc/ssh/sshd_config\.d/' /etc/ssh/sshd_config; then
    echo "sshd_config has no Include for sshd_config.d - refusing to write a drop-in nothing reads" >&2
    exit 1
fi

cat > "$tmpdir/10-hardening.conf" <<'CONF'
# Key-based authentication only, and no direct root login.
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
CONF
install -m 644 "$tmpdir/10-hardening.conf" /etc/ssh/sshd_config.d/10-hardening.conf

sshd -t
systemctl reload ssh

say "sudo"

# Written through a temporary file and validated before it is put in place: a
# malformed sudoers file locks every user out of sudo, including the one that
# would fix it.
echo "$USER_NAME ALL=(ALL) NOPASSWD:ALL" > "$tmpdir/sudoers"
visudo -cqf "$tmpdir/sudoers"
install -m 440 "$tmpdir/sudoers" "/etc/sudoers.d/90-${USER_NAME}-nopasswd"

say "web root and the acme challenge directory"

install -d -o www-data -g www-data /var/www/playground
install -d -o www-data -g www-data /var/www/certbot

say "nginx"

install -m 644 "$here/nginx/playground-limits.conf" /etc/nginx/conf.d/playground-limits.conf
install -m 644 "$here/nginx/$DOMAIN.conf" "/etc/nginx/sites-available/$DOMAIN"
ln -sfn "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
rm -f /etc/nginx/sites-enabled/default

# Only reload once the certificate exists: the server block references it, and
# nginx will not start without it. On a fresh host this is expected to be the
# state until the issuance step in deploy/README.md has been run.
if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    nginx -t
    systemctl reload nginx
else
    echo "no certificate for $DOMAIN yet; skipping the nginx reload"
    echo "see 'certificates' in deploy/README.md"
fi

say "firewall"

# Two separate jobs, and the second is easy to believe the first has covered.
#
# DOCKER-USER is consulted for FORWARDed traffic, which is how a container
# reaches the internet - so it denies that. It is NOT consulted for traffic to
# the host itself, which arrives on INPUT, so on its own it leaves the
# containers able to reach the host's own sshd and nginx. Both rules are needed;
# neither is visible from the other.

# Removed and re-added rather than checked, because order is load-bearing here:
# the ESTABLISHED rule has to precede the DROP, or replies travelling back to
# nginx match the DROP and the site goes down.
while iptables -D DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN 2>/dev/null; do :; done
while iptables -D DOCKER-USER -s "$SUBNET" -d "$SUBNET" -j RETURN 2>/dev/null; do :; done
while iptables -D DOCKER-USER -s "$SUBNET" -j DROP 2>/dev/null; do :; done

# Inserted at the head in reverse, so they end up in the order written here.
iptables -I DOCKER-USER 1 -s "$SUBNET" -j DROP
iptables -I DOCKER-USER 1 -s "$SUBNET" -d "$SUBNET" -j RETURN
iptables -I DOCKER-USER 1 -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN

# New connections only, so replies from the containers to nginx are unaffected.
if ! iptables -C INPUT -s "$SUBNET" -m conntrack --ctstate NEW -j DROP 2>/dev/null; then
    iptables -I INPUT 1 -s "$SUBNET" -m conntrack --ctstate NEW -j DROP
fi

netfilter-persistent save

say "unattended upgrades"

cat > "$tmpdir/20auto-upgrades" <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF
install -m 644 "$tmpdir/20auto-upgrades" /etc/apt/apt.conf.d/20auto-upgrades

say "root password"

# The console is the only place a password could still be used - ssh is
# key-only above. Locking it costs nothing and closes the last use of a
# credential that has been shared in plain text.
passwd -l root > /dev/null

say "done"

echo "still to do by hand, if this is a fresh host:"
echo "  - issue the certificate            (see deploy/README.md)"
echo "  - write /opt/ghul-playground/.env  (access tokens, mode 600)"
echo "  - set the Linode outbound rules    (see deploy/README.md)"
