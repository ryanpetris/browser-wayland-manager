#!/bin/sh
set -eu
if [ "${1:-}" = dependencies ]; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly libgl1-mesa-dri libegl1 libgbm1 libgles2 libxkbcommon0 xwayland dbus pipewire pipewire-pulse wireplumber libpulse0 gstreamer1.0-pipewire fonts-dejavu-core util-linux ca-certificates xterm
    rm -rf /var/lib/apt/lists/*
    exit
fi
id -u bw >/dev/null 2>&1 || useradd -m -u 1000 bw
