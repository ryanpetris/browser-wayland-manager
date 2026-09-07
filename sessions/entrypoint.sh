#!/bin/sh
set -eu
umask 077
: > /tmp/innkeeper-timings
stage() { echo "Stage: $1"; printf '%s\n' "$1" > /tmp/innkeeper-stage; printf '%s %s\n' "$(date +%s%3N)" "$1" >> /tmp/innkeeper-timings; }
trap 'echo "Setup failed during $(cat /tmp/innkeeper-stage)" >&2' EXIT
stage setup
if [ ! -f /opt/innkeeper/setup-complete ]; then
    sh /opt/innkeeper/setup.sh
    touch /opt/innkeeper/setup-complete
fi
mkdir -p /home/elsewhere/.config/elsewhere /tmp/runtime-elsewhere /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix
if [ -d /seed ]; then
    cp /seed/token /seed/viewer-token /home/elsewhere/.config/elsewhere/
fi
test -s /home/elsewhere/.config/elsewhere/token
test -s /home/elsewhere/.config/elsewhere/viewer-token
chown -R elsewhere:elsewhere /home/elsewhere /tmp/runtime-elsewhere
chmod 700 /tmp/runtime-elsewhere /home/elsewhere/.config/elsewhere
chmod 600 /home/elsewhere/.config/elsewhere/token /home/elsewhere/.config/elsewhere/viewer-token
rm -rf /seed
stage elsewhere
if command -v pacman >/dev/null; then
    pacman -U --noconfirm /opt/innkeeper/elsewhere.pkg.tar.zst
else
    chmod 644 /opt/innkeeper/elsewhere.deb
    DEBIAN_FRONTEND=noninteractive apt-get install -y --reinstall --allow-downgrades /opt/innkeeper/elsewhere.deb
fi
stage packages
if [ ! -f /opt/innkeeper/packages-installed ]; then
    sh /opt/innkeeper/packages.sh "$@"
    touch /opt/innkeeper/packages-installed
fi
# Device group IDs come from the host and may differ from the image's groups.
for device in /dev/dri/card* /dev/dri/renderD*; do
    [ -c "$device" ] || continue
    gid=$(stat -c %g "$device")
    group=$(getent group "$gid" | cut -d: -f1)
    if [ -z "$group" ]; then
        group="innkeeper-gpu-$gid"
        groupadd -g "$gid" "$group"
    fi
    usermod -aG "$group" elsewhere
done
stage launch
trap - EXIT
exec runuser -u elsewhere -- sh /opt/innkeeper/start.sh
