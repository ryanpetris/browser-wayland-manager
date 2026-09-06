#!/bin/sh
set -eu
export HOME=/home/elsewhere XDG_RUNTIME_DIR=/tmp/runtime-elsewhere NO_COLOR=1
cd "$HOME"
DBUS_SESSION_BUS_ADDRESS=$(dbus-daemon --session --fork --print-address)
export DBUS_SESSION_BUS_ADDRESS
rm -f "$XDG_RUNTIME_DIR/output"
mkfifo "$XDG_RUNTIME_DIR/output"
# Redact startup links before Docker persists them, including rotated token links.
LC_ALL=C stdbuf -oL sed -E 's/(#token=)[[:xdigit:]]{64}/\1[REDACTED]/g' < "$XDG_RUNTIME_DIR/output" &
filter=$!
set -- --listen 0.0.0.0:19443 --rtc-port 19443 --elements
if [ -n "${INNKEEPER_SCREEN_SIZE:-}" ]; then set -- "$@" --screen-size "$INNKEEPER_SCREEN_SIZE"; fi
if [ "${INNKEEPER_KIOSK:-0}" = 1 ]; then set -- "$@" --kiosk; fi
if [ -n "${INNKEEPER_STARTUP_COMMAND:-}" ]; then set -- "$@" --exec "$INNKEEPER_STARTUP_COMMAND"; fi
elsewhere "$@" > "$XDG_RUNTIME_DIR/output" 2>&1 &
desktop=$!
trap 'kill -TERM "$desktop" 2>/dev/null || true' TERM INT
set +e
wait "$desktop"
status=$?
if kill -0 "$desktop" 2>/dev/null; then
    wait "$desktop"
    status=$?
fi
# Drain crash output; an application inheriting stdout cannot hold shutdown forever.
(sleep 2; kill "$filter" 2>/dev/null) &
drain_timeout=$!
wait "$filter"
kill "$drain_timeout" 2>/dev/null
wait "$drain_timeout" 2>/dev/null
exit "$status"
