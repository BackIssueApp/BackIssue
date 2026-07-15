#!/bin/sh
# Start a virtual X display, then run the app against it. Sites behind Cloudflare
# block true-headless Chromium — so we run a REAL (headed) browser and give it
# this fake screen to render into.
#
# We start Xvfb directly rather than via `xvfb-run`: xvfb-run does not exit while
# orphaned Chromium processes still hold the display, which wedges the container.
set -e

export DISPLAY=:99
# A `docker restart` (e.g. autoheal, or the restart policy after a crash) keeps
# the container's /tmp, so a leftover lock/socket from the previous run makes
# Xvfb abort with "Server is already active for display 99". Clear any stale ones
# so Xvfb always starts clean — and so the socket wait below tracks the REAL new
# socket rather than being fooled by a stale one into launching against a dead
# display.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 1366x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &

# Wait for the display socket before launching anything that needs it.
i=0
while [ ! -S /tmp/.X11-unix/X99 ]; do
  i=$((i + 1))
  if [ "$i" -gt 100 ]; then echo "Xvfb failed to start:" >&2; cat /tmp/xvfb.log >&2; exit 1; fi
  sleep 0.1
done

exec "$@"
