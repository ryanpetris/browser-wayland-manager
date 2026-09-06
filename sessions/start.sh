#!/bin/sh
set -eu
export HOME=/home/bw XDG_RUNTIME_DIR=/tmp/runtime-bw
cd "$HOME"
DBUS_SESSION_BUS_ADDRESS=$(dbus-daemon --session --fork --print-address)
export DBUS_SESSION_BUS_ADDRESS
rm -f "$XDG_RUNTIME_DIR/output"
mkfifo "$XDG_RUNTIME_DIR/output"
# Keep browser-wayland's startup links out of Docker's persisted logs.
# The backend also redacts exact token values in returned log output.
LC_ALL=C stdbuf -oL sed -E 's/(#token=)[[:xdigit:]]{64}/\1[REDACTED]/g' < "$XDG_RUNTIME_DIR/output" &
exec browser-wayland --listen 0.0.0.0:19443 --rtc-port 19443 --software-encoding --elements > "$XDG_RUNTIME_DIR/output" 2>&1
