# the host

What a playground host is, beyond the application itself. `host-setup.sh` puts
all of it in place and is safe to re-run; this file is the part a script cannot
carry, which is the reasoning and the three things it deliberately leaves alone.

The box is a Linode VM, 2 vCPU / 4 GB, Ubuntu. Everything installed on it comes
from Ubuntu's own archive: nginx, certbot, docker.io, docker-compose-v2,
iptables-persistent, chrony, unattended-upgrades. There are no third-party apt
sources, and adding one would be a new thing to trust.

Treat the host as disposable. It holds no credentials beyond the access tokens
and its own certificate, and rebuilding it is `host-setup.sh` plus the three
steps below.

## what runs where

nginx terminates TLS and serves `/var/www/playground`, proxying `/compile`,
`/analyse` and `/health` to the two containers, which are bound to loopback and
never face the internet themselves. The containers come from `compose.yaml` in
the repository root.

## the three things host-setup.sh does not do

**Certificates.** Let's Encrypt rate-limits issuance, so a provisioning script
that re-issues every time it runs will eventually lock the host out of renewal.
Issue once, by hand, after DNS points at the host and nginx is serving port 80:

```sh
sudo certbot certonly --webroot -w /var/www/certbot -d playground.ghul.dev
sudo systemctl reload nginx
```

Webroot rather than the nginx authenticator, and the challenge path is served
directly from the port 80 server block rather than redirected, so renewal does
not depend on anything in the HTTPS block. Renewal is certbot's own systemd
timer and needs no cron entry.

**Access tokens.** `/opt/ghul-playground/.env`, mode 600, never in the
repository:

```
PLAYGROUND_TOKENS=one-token,another-token
ALLOWED_ORIGINS=https://ghul.dev,https://www.ghul.dev,https://playground.ghul.dev
```

An empty `PLAYGROUND_TOKENS` opens the services to anyone; both say so loudly at
startup. `ALLOWED_ORIGINS` has to include the playground's own origin, because a
POST carries `Origin` even same-origin.

**The Linode outbound firewall**, which is dashboard-side. Default outbound
policy DROP, allowing:

| Protocol | Port | For |
| --- | --- | --- |
| TCP | 443 | image pulls, NuGet, GitHub, ACME |
| TCP | 80 | apt, which is configured over plain http here |
| TCP+UDP | 53 | DNS |
| UDP | 123 | NTP |
| TCP | 4460 | the NTS key exchange chrony does before NTP |
| ICMP | | optional |

Two of those are easy to miss. apt on this host really is plain http
(mirrors.linode.com, security.ubuntu.com, archive.canonical.com), so port 80 is
a dependency rather than a courtesy. And chrony syncs over NTS, whose key
exchange runs on TCP 4460 before NTP speaks UDP 123 at all: allow 123 alone and
time sync fails in a way that looks nothing like a firewall rule.

The firewall is stateful, so this governs only connections the host starts.
Replies to inbound SSH and HTTPS need no outbound rule, and an outbound policy
cannot lock anyone out of SSH.

## the firewall rules on the host, and why there are two

Egress from the containers is denied on the host rather than at the Linode edge,
because container traffic is SNATed to the host address and the two are
indistinguishable from outside.

It takes two rules that look like one, and the second is easy to believe the
first has covered:

- `DOCKER-USER` is consulted for **forwarded** traffic, which is how a container
  reaches the internet. This is the rule everyone writes.
- It is **not** consulted for traffic addressed to the host itself, which
  arrives on `INPUT`. Without a matching rule there, the containers still reach
  the host's own sshd and nginx, and nothing in the `DOCKER-USER` rules hints at
  it. Confirmed by connecting from inside a container before the rule existed.

Order matters in the first set: the ESTABLISHED rule has to precede the DROP, or
replies travelling back to nginx match the DROP and the site goes down. That is
why `host-setup.sh` removes and re-adds those three rather than checking whether
each is present.

**Re-run `host-setup.sh` after recreating the docker network.** The subnet is
pinned in `compose.yaml` precisely so these rules keep matching, but a rule that
has been flushed is invisible: everything works, and the containers quietly have
the internet back. Checking is
`sudo iptables -S DOCKER-USER` and `sudo iptables -S INPUT`.

One trap in how they persist: `netfilter-persistent save` writes out the whole
table, which includes docker's own generated rules and the bridge interface
names current at that moment. Those names change when the network is recreated,
so the saved file ages. It restores harmlessly, because docker rebuilds its own
chains at start, but do not read `/etc/iptables/rules.v4` as the statement of
what we intended. `host-setup.sh` is that statement.

## deploying

The front end is published locally and copied up; the services are rebuilt in
place:

```sh
npm install                       # stages monaco, and the publish fails without it
dotnet publish web -c Release -o /tmp/playground-publish
rsync -az --delete /tmp/playground-publish/wwwroot/ HOST:/tmp/playground-deploy/
ssh HOST 'sudo rsync -a --delete /tmp/playground-deploy/ /var/www/playground/ \
    && sudo chown -R www-data:www-data /var/www/playground'

ssh HOST 'cd /opt/ghul-playground && sudo git pull && sudo docker compose up -d --build'
```

`/opt/ghul-playground` is a single-branch clone, so a branch other than main
needs naming explicitly:
`sudo git fetch origin BRANCH && sudo git checkout FETCH_HEAD`.

## getting back in

ssh is key-only and root's password is locked, so the routes back are, in order:
another key that is already in `authorized_keys`; the Linode console, which
needs a user with a password (`degory` has one, and passwordless sudo, so that
password is what console access rests on); Rescue Mode, which boots a rescue
image with the disk mounted; and the dashboard's root password reset, which
writes to the offline disk.

If none of that appeals, the honest answer for a box this disposable is to
rebuild it: `host-setup.sh` plus the three steps above.
