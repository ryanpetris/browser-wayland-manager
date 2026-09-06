#!/bin/sh
set -eu
pacman -Syu --noconfirm --needed dbus pipewire pipewire-pulse wireplumber util-linux xterm ttf-dejavu coreutils
id -u bw >/dev/null 2>&1 || useradd -m -u 1000 bw
