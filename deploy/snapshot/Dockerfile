# The snapshotter: sqlite3 and a shell, and nothing else.
#
# Not the goatcounter image, which carries the server but no sqlite3 binary -
# it links the library rather than shipping the tool. Not a general-purpose
# image either: this reads the one file on the host that cannot be rebuilt, so
# the less in here the better.

FROM alpine:3.22

RUN apk add --no-cache sqlite

# The same user the goatcounter image runs as, because that is who owns the
# database and its write-ahead log. Reading a WAL database means opening its
# -shm file, which is a write, so a different user fails outright - loudly,
# which is what we want if the other image's user ever changes.
RUN adduser -D -u 1000 snapshot

USER snapshot

ENTRYPOINT ["/bin/sh", "/snapshot.sh"]
