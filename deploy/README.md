# the host

What a playground host is, beyond the application itself. `host-setup.sh` puts
all of it in place and is safe to re-run; this file is the part a script cannot
carry, which is the reasoning and the three things it deliberately leaves alone.

The box is a Linode VM, 2 vCPU / 4 GB, Ubuntu. Everything installed *by apt*
comes from Ubuntu's own archive: nginx, certbot, docker.io, docker-compose-v2,
iptables-persistent, chrony, unattended-upgrades. There are no third-party apt
sources, and adding one would be a new thing to trust.

There is one piece of software on this host that Ubuntu does not package, and
pretending otherwise would be worse than saying so: **GoatCounter**, the
analytics. It is not apt-installed - it is built from source at a pinned tag by
`goatcounter/Dockerfile` and runs in a container like the other two services. So
the rule above is intact as a statement about apt, and the honest version of the
broader claim is: one upstream Go program, built here from a revision we name,
rather than a binary or an image someone else assembled. See "analytics" below.

Treat the host as disposable **with one exception**. It holds no credentials
beyond its own certificate - the services run open by default and carry no
access tokens - and rebuilding it is `host-setup.sh` plus the steps below. The
exception is the analytics volume, which is the only state here that is not
reproducible from this repository: rebuild the box without copying it and the
history is gone for good. Everything else can be thrown away freely.

## what runs where

nginx terminates TLS and serves `/var/www/playground`, proxying `/compile`,
`/analyse` and `/health` to the compile and analyse containers, and `/stats/` to
the GoatCounter container. All three are bound to loopback and never face the
internet themselves. The containers come from `compose.yaml` in the repository
root.

## the things host-setup.sh does not do

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

**The analytics exclusion list and the GoatCounter site.**
`/etc/nginx/analytics-exclude.conf` names the networks whose visits are not
recorded, and it is not in the repository because it says who someone is rather
than what the service does. The site inside GoatCounter is created once, by
hand, for the same reason the certificate is - it takes a password. Both are
under "analytics" below, and the exclusion wants to be working before ghul.dev
is pointed at the instance.

**The `.env` file.** `/opt/ghul-playground/.env`, mode 600, never in the
repository. It holds two settings, read by `compose.yaml`:

```
PLAYGROUND_TOKENS=
ALLOWED_ORIGINS=https://ghul.dev,https://www.ghul.dev,https://playground.ghul.dev
```

The playground runs open: `PLAYGROUND_TOKENS` is empty, so anyone may compile
and run. That is deliberate - what bounds the load is the concurrency caps and
the per-address limits in nginx, not authentication - and the services note at
startup that no tokens are configured. Setting `PLAYGROUND_TOKENS` to a
comma-separated list re-enables the gate, and both services then require one.

`ALLOWED_ORIGINS` is a separate axis and is not access control: a request with
no browser `Origin`, such as a `curl`, is still accepted. It stops a
third-party page from driving the service through its own visitors' browsers,
and it has to include the playground's own origin because a POST carries
`Origin` even same-origin.

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

**The deploy key.** `host-setup.sh` creates the `deploy` account and its
`~/.ssh` directory, but not the key that goes in `authorized_keys`: it is
created per deployment and held as a CI secret. See "deploy key" under
deploying.

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

## analytics

GoatCounter, self-hosted, serving `playground.ghul.dev/stats`. Both ghul.dev and
this playground report to it. It runs under a path rather than a subdomain of
its own, which upstream supports through `-base-path` and which saves a DNS
record, a second certificate and a second server block. The flag in
`goatcounter/Dockerfile` and the `location` prefix in
`nginx/playground.ghul.dev.conf` have to agree; neither works alone.

Because they share one hostname they are one GoatCounter *site* - sites are
keyed on vhost - so site pageviews, playground pageviews and per-example events
land in one dashboard. That is what we want here, but it is why separating them
later would mean a second hostname after all.

### first-time setup

The database starts empty and holds no site, so the dashboard answers nothing
until one is created. Once, by hand, like the certificate and `.env`:

```sh
cd /opt/ghul-playground
docker compose exec goatcounter goatcounter db create site \
    -vhost=playground.ghul.dev -user.email=YOU@EXAMPLE.COM
```

It prompts for a password. The dashboard is then at
`https://playground.ghul.dev/stats`.

Then turn on **Individual pageviews**, in Settings, "Data collection". It is off
by default, and off means each pageview is folded into the hourly aggregates and
the row itself discarded - the totals are identical either way, but nothing can
reconstruct the detail afterwards.

Worth doing deliberately rather than by reflex, because it is the one setting
here that is asymmetric in time: turning it off later keeps everything already
collected, while any period it was off is permanently aggregate-only. It is what
makes CSV export possible at all, and it is what makes the exclusion checkable
by eye on the dashboard. The cost is storage - one row per pageview, on the
order of 100 bytes - and a retained per-visit trail: the row carries the session
id, so a visitor's path through the site is linkable for the eight hours a
session lasts. Still no IP address; that is never stored under any setting. On a
site of this size the storage is nothing and the trail is the whole reason to
turn it on.

`Data retention` in the same settings page will purge rows past a chosen age if
that trail is worth keeping bounded.

Do all of this **before** pointing ghul.dev at it, and get the exclusion below
working first - see the warning under "clearing data".

### not counting yourself

On a site this size the maintainer's own visits will otherwise swamp the
numbers. Two mechanisms, and both are needed because each covers what the other
cannot:

**By network, in nginx.** `geo $count_excluded` in `nginx/playground-limits.conf`
answers `/stats/count` with a 202 for an excluded address instead of proxying
it. The ranges live in `/etc/nginx/analytics-exclude.conf` on the host - written
by hand, not in this repository, because they identify a person rather than the
service and this repository is public. `nginx/analytics-exclude.conf.example` is
the template and explains the format.

This is deliberately not done with GoatCounter's own "ignore IPs" setting, which
matches a single literal address with no CIDR support - useless against a
consumer address that moves around its pool.

Note what a range costs: an ISP allocation covers every subscriber on it, so
excluding one also discards genuine visitors who share it. Usually the right
trade, but know that you are making it.

**By browser, in GoatCounter.** Visiting `#toggle-goatcounter` on a page sets a
`localStorage` flag that `count.js` honours. It covers what nginx cannot see - a
VPN exit, a phone on a foreign network - and it is per-origin, so it must be
done on each:

- `https://ghul.dev/#toggle-goatcounter`
- `https://playground.ghul.dev/#toggle-goatcounter`

Per browser and per profile, and clearing site data clears it.

Never put a shared VPN exit range in the nginx list. Those addresses are shared
with strangers, so excluding one discards other people's visits and buys nothing
the browser flag does not already cover from that same browser.

### clearing data

**GoatCounter cannot delete one visitor's history, and this is not a gap that
can be worked around.** It never stores the IP address - it derives a session
from it and drops it - and the session it does store is a random identifier
rather than anything computed from the address. There is no query that finds
"everything from that address" because the information is not in the database.

What exists is:

- **By path**, from the dashboard: Settings, "Manage pageviews", with `%`
  wildcards. Useful when the pollution is one page.
- **Everything**, with `deploy/reset-analytics.sh`. Stops the service, drops the
  volume, brings it back on an empty database, and reminds you to recreate the
  site.

There is nothing in between. Which is why the exclusion has to be verified
*before* ghul.dev points at the instance: get it wrong and the only remedy is a
total reset.

Verify it at the count endpoint rather than on the dashboard, because the status
code says directly what happened and needs nothing to have been aggregated yet:

```sh
curl -s -o /dev/null -w '%{http_code}\n' \
    'https://playground.ghul.dev/stats/count?p=/exclusion-test'
```

**202** means excluded and not recorded; **200** means it was counted. Run it
from the network you expect to be excluded, then from a phone on mobile data,
and check you get one of each.

With "Individual pageviews" on, the dashboard's own pageview list is the second
opinion, and worth taking - the status code says nginx made the right decision,
the list says the decision had the effect it was supposed to. Without that
setting the list stays empty whatever happens, and the status code is all there
is to go on.

### backups

The volume is `ghul-playground_goatcounter-data` - compose prefixes it with the
project name, which is the directory `compose.yaml` sits in, so it is that on
this host and something else in a test checkout. It is the only thing here worth
backing up, and nothing does so automatically yet.

```sh
docker run --rm \
    -v ghul-playground_goatcounter-data:/data:ro \
    -v "$PWD":/backup \
    debian:bookworm-slim \
    tar czf /backup/goatcounter-$(date +%F).tar.gz -C /data .
```

Take one before any upgrade that migrates the schema. `-automigrate` runs
pending migrations on start, so the first run of a new image is the moment the
old database stops being readable by the old binary.

### upgrading

`GOATCOUNTER_VERSION` in `goatcounter/Dockerfile` is the pin, and moving it is
the whole upgrade - the next deploy rebuilds and `-automigrate` handles the
schema. Back up first, and read upstream's release notes for that version:
migrations here are one-way.

## traffic that is not a reader

`reject-unknown-hosts.conf` makes nginx refuse any request whose `Host` is not a
name we serve, which in practice means requests addressed to the bare IP. It
closes the connection with 444, and refuses the TLS handshake outright rather
than presenting a certificate for a name the client did not ask for.

Without it nginx answers on the address as well as the name, and scanners find
it that way. The content is public either way, so this is not concealment: it is
that address-scan traffic is never a reader, and there is no reason to serve it,
log it, or let it spend from the per-address limits real readers share.

Expect a steady background of this regardless: probes for `/.env` and its
variants, `/wp-login.php`, and raw TLS or RDP handshakes sent to port 80. The
`.env` probes are the ones worth understanding rather than dismissing: the file
lives at `/opt/ghul-playground/.env`, outside the web root, so it is not
reachable. Today it holds only the origin list, but it is also where the access
tokens would live if the gate were re-enabled, so keep it there. Worth
re-checking with
`curl -s -o /dev/null -w '%{http_code}' https://playground.ghul.dev/.env` after
any change to the nginx roots.

## who does the deploying

A dedicated `deploy` account, not the interactive one. The services run in
containers that drop to an unprivileged user, and nginx runs as `www-data`, so
nothing is hosted as `deploy` either - it exists only to deploy. It has exactly
what a deploy needs and no sudo: it owns `/opt/ghul-playground` and
`/var/www/playground`, and it is in the `docker` group so it can rebuild the
services. The clone is an anonymous HTTPS checkout of a public repository, so it
pulls without a GitHub credential. `host-setup.sh` creates the account and the
ownership; CI logs in as it.

The interactive account is kept out of the deployment path on purpose, so its
key and the deploy key can be rotated or revoked independently and the two leave
separate trails.

## deploying

Merging to `main` deploys. The `deploy` workflow publishes the web app, copies
`wwwroot` to `/var/www/playground`, then pulls the new `main` on the box and
rebuilds and swaps both services, and finally checks the site answers and that
the freshly built toolchain compiles. It runs as `deploy` over SSH, with no
sudo anywhere. It also has a manual trigger for re-running a deploy without a
new merge.

Because the runtime version lives in both the published front end and the
service images, the two are deployed in the same run; deploying only one is how
the browser ends up loading a runtime the services did not compile against.

Deploying is what puts a merged compiler or runtime update in front of readers.
Until the services are rebuilt they keep running the versions their images were
built with, whatever main says.

### deploy key

The workflow authenticates with a dedicated SSH key, held as the
`PLAYGROUND_DEPLOY_KEY` secret, whose public half is the only entry in
`/home/deploy/.ssh/authorized_keys`. Generate one per deployment
(`ssh-keygen -t ed25519`), add the public half to that file, and keep the
private half only in the secret. `host-setup.sh` creates the account and its
`.ssh` directory but not the key, for the same reason it does not write `.env`.

### doing it by hand

If CI is not available, the same steps from a machine holding the deploy key:

```sh
npm install                       # stages monaco, and the publish fails without it
dotnet publish web -c Release -o /tmp/playground-publish
rsync -az --delete -e "ssh -i <deploy-key>" \
    /tmp/playground-publish/wwwroot/ deploy@HOST:/var/www/playground/
ssh -i <deploy-key> deploy@HOST \
    'cd /opt/ghul-playground && git pull --ff-only \
     && docker compose build && docker compose up -d'
```

`/opt/ghul-playground` is a single-branch clone, so a branch other than main
needs naming explicitly: `git fetch origin BRANCH && git checkout FETCH_HEAD`.

## moving to a new compiler or runtime

Renovate proposes these, so the usual answer is to let it. It knows all five
places the versions are written, and CI checks that they agree, that the
examples still compile, and that a program still runs in a browser. A green
pull request is the whole review.

To do it by hand, the five are:

| where | what |
| --- | --- |
| `.config/dotnet-tools.json` | the compiler, for local development |
| `web/web.csproj` | the runtime the browser loads |
| `runner/runner.ghulproj` | the runtime the runner builds against |
| `compile-service/Dockerfile` | both, as build arguments |
| `analyse-service/Dockerfile` | both, and the language server |

They have to move together. `node scripts/check-versions.js` says so if they
have not, which is the same check CI runs.

The runtime is the one to be careful with: the services compile a reader's
program against one runtime and the browser loads another, so a version left
behind in `web/web.csproj` is a program that compiles, downloads, and then
fails to load - with nothing in the compiler output to explain it. Nothing
short of running a program in a browser catches that, which is why CI does.

## getting back in

ssh is key-only and root's password is locked, so the routes back are, in order:
another key that is already in `authorized_keys`; the Linode console, which
needs a user with a password (`degory` has one, and passwordless sudo, so that
password is what console access rests on); Rescue Mode, which boots a rescue
image with the disk mounted; and the dashboard's root password reset, which
writes to the offline disk.

If none of that appeals, the honest answer for a box this disposable is to
rebuild it: `host-setup.sh` plus the three steps above.
