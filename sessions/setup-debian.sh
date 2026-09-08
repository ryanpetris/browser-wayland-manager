#!/bin/sh
set -eu
sed -i 's/^Components:.*/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends dbus pipewire pipewire-pulse wireplumber pipewire-alsa pulseaudio-utils intel-media-va-driver-non-free mesa-va-drivers mesa-vulkan-drivers xwayland util-linux xterm fonts-dejavu-core ca-certificates coreutils
id -u elsewhere >/dev/null 2>&1 || useradd -m -u 1000 elsewhere
