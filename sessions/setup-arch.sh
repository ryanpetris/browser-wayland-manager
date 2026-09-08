#!/bin/sh
set -eu
if ! pacman-conf --repo-list | grep -qx multilib; then
    printf '\n[multilib]\nInclude = /etc/pacman.d/mirrorlist\n' >> /etc/pacman.conf
fi
pacman -Syu --noconfirm --needed dbus pipewire pipewire-pulse wireplumber pipewire-alsa libpulse intel-media-driver libva-mesa-driver vulkan-intel vulkan-radeon xorg-xwayland util-linux xterm ttf-dejavu coreutils
id -u elsewhere >/dev/null 2>&1 || useradd -m -u 1000 elsewhere
