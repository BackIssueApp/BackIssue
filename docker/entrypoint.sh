#!/bin/sh
# Drop from root to PUID:PGID before running the app (Unraid / LinuxServer
# convention) so files written to mounted shares are owned by the user, not
# root. Defaults are Unraid's nobody:users (99:100). UMASK controls new-file
# permissions. Set these as container env vars.
set -e

PUID="${PUID:-99}"
PGID="${PGID:-100}"
UMASK_VAL="${UMASK:-022}"
DATA_DIR="${DATA_DIR:-/data}"

# Reuse an existing group/user with those ids, else create one. -o allows a
# non-unique id so any host UID/GID works.
if ! getent group "$PGID" >/dev/null 2>&1; then
  groupadd -o -g "$PGID" backissue
fi
if ! getent passwd "$PUID" >/dev/null 2>&1; then
  useradd -o -M -N -u "$PUID" -g "$PGID" -s /usr/sbin/nologin -d "$DATA_DIR" backissue
fi

mkdir -p "$DATA_DIR"
# Fix ownership recursively only when the data dir isn't already the run user —
# fast on restarts, and avoids walking a large downloads dir every boot.
if [ "$(stat -c %u "$DATA_DIR" 2>/dev/null)" != "$PUID" ]; then
  echo "backissue: setting ownership of $DATA_DIR to $PUID:$PGID (first run / id change)…"
  chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null || true
fi

# npm (plugin dependency installs) needs a writable HOME for its cache.
export HOME="$DATA_DIR"
umask "$UMASK_VAL"

exec gosu "$PUID:$PGID" "$@"
