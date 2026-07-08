#!/bin/sh
# Start a virtual X display, then run the app against it. Sites behind Cloudflare
# block true-headless Chromium — so we run a REAL (headed) browser and give it
# this fake screen to render into.
#
# We start Xvfb directly rather than via `xvfb-run`: xvfb-run does not exit while
# orphaned Chromium processes still hold the display, which wedges the container.
set -e

export DISPLAY=:99
Xvfb :99 -screen 0 1366x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &

# Wait for the display socket before launching anything that needs it.
i=0
while [ ! -S /tmp/.X11-unix/X99 ]; do
  i=$((i + 1))
  if [ "$i" -gt 100 ]; then echo "Xvfb failed to start:" >&2; cat /tmp/xvfb.log >&2; exit 1; fi
  sleep 0.1
done

exec "$@"
