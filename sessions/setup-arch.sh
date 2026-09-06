#!/bin/sh
set -eu
pacman -Syu --noconfirm --needed dbus pipewire pipewire-pulse wireplumber gst-plugin-pipewire pipewire-alsa libpulse gst-plugins-ugly xorg-xwayland util-linux xterm ttf-dejavu coreutils
id -u bw >/dev/null 2>&1 || useradd -m -u 1000 bw
