#!/bin/sh
set -eu
umask 077
stage() { echo "Stage: $1"; printf '%s\n' "$1" > /tmp/bwm-stage; printf '%s %s\n' "$(date +%s)" "$1" >> /tmp/bwm-timings; }
trap 'echo "Setup failed during $(cat /tmp/bwm-stage)" >&2' EXIT
stage setup
sh /opt/bwm/setup.sh
mkdir -p /home/bw/.config/browser-wayland /tmp/runtime-bw
if [ -d /seed ]; then
    cp /seed/token /seed/viewer-token /home/bw/.config/browser-wayland/
fi
test -s /home/bw/.config/browser-wayland/token
test -s /home/bw/.config/browser-wayland/viewer-token
chown -R bw:bw /home/bw /tmp/runtime-bw
chmod 700 /tmp/runtime-bw /home/bw/.config/browser-wayland
chmod 600 /home/bw/.config/browser-wayland/token /home/bw/.config/browser-wayland/viewer-token
rm -rf /seed
stage packages
if [ ! -f /opt/bwm/packages-installed ]; then
    sh /opt/bwm/packages.sh "$@"
    touch /opt/bwm/packages-installed
fi
stage binary
install -m 755 /opt/bwm/browser-wayland /usr/local/bin/browser-wayland
mkdir -p /usr/share/licenses/browser-wayland
cp /opt/bwm/THIRD_PARTY.txt /usr/share/licenses/browser-wayland/
ldd /usr/local/bin/browser-wayland
stage launch
trap - EXIT
exec runuser -u bw -- sh /opt/bwm/start.sh
