#!/bin/sh
set -eu
if [ "${1:-}" = dependencies ]; then
    pacman -Syu --noconfirm --needed gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugins-ugly mesa libxkbcommon xorg-xwayland dbus pipewire pipewire-pulse wireplumber libpulse gst-plugin-pipewire ttf-dejavu util-linux xterm
    pacman -Scc --noconfirm
    exit
fi
id -u bw >/dev/null 2>&1 || useradd -m -u 1000 bw
