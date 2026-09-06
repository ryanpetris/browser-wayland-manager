#!/bin/sh
set -eu
sed -i 's/^Components:.*/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends dbus pipewire pipewire-pulse wireplumber gstreamer1.0-pipewire pipewire-alsa pulseaudio-utils gstreamer1.0-plugins-ugly xwayland util-linux xterm fonts-dejavu-core ca-certificates coreutils
id -u bw >/dev/null 2>&1 || useradd -m -u 1000 bw
