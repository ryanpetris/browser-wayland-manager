#!/bin/sh
set -eu
umask 077
: > /tmp/bwm-timings
stage() { echo "Stage: $1"; printf '%s\n' "$1" > /tmp/bwm-stage; printf '%s %s\n' "$(date +%s%3N)" "$1" >> /tmp/bwm-timings; }
trap 'echo "Setup failed during $(cat /tmp/bwm-stage)" >&2' EXIT
stage setup
if [ ! -f /opt/bwm/setup-complete ]; then
    sh /opt/bwm/setup.sh
    touch /opt/bwm/setup-complete
fi
mkdir -p /home/bw/.config/browser-wayland /tmp/runtime-bw /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix
if [ -d /seed ]; then
    cp /seed/token /seed/viewer-token /home/bw/.config/browser-wayland/
fi
test -s /home/bw/.config/browser-wayland/token
test -s /home/bw/.config/browser-wayland/viewer-token
chown -R bw:bw /home/bw /tmp/runtime-bw
chmod 700 /tmp/runtime-bw /home/bw/.config/browser-wayland
chmod 600 /home/bw/.config/browser-wayland/token /home/bw/.config/browser-wayland/viewer-token
rm -rf /seed
stage browser-wayland
if [ ! -f /opt/bwm/browser-wayland-installed ]; then
    if command -v pacman >/dev/null; then
        pacman -U --noconfirm --needed /opt/bwm/*.pkg.tar.zst
    else
        chmod 644 /opt/bwm/*.deb
        DEBIAN_FRONTEND=noninteractive apt-get install -y /opt/bwm/*.deb
    fi
    touch /opt/bwm/browser-wayland-installed
fi
stage packages
if [ ! -f /opt/bwm/packages-installed ]; then
    sh /opt/bwm/packages.sh "$@"
    touch /opt/bwm/packages-installed
fi
# Device group IDs come from the host and may differ from the image's groups.
for device in /dev/dri/card* /dev/dri/renderD*; do
    [ -c "$device" ] || continue
    gid=$(stat -c %g "$device")
    group=$(getent group "$gid" | cut -d: -f1)
    if [ -z "$group" ]; then
        group="bwm-gpu-$gid"
        groupadd -g "$gid" "$group"
    fi
    usermod -aG "$group" bw
done
stage launch
trap - EXIT
exec runuser -u bw -- sh /opt/bwm/start.sh
