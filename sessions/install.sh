#!/bin/sh
set -eu
if command -v pacman >/dev/null; then
    test "$(pacman -Qp /opt/innkeeper/elsewhere.pkg.tar.zst)" = "elsewhere $1"
    pacman -U --noconfirm /opt/innkeeper/elsewhere.pkg.tar.zst
else
    test "$(dpkg-deb -f /opt/innkeeper/elsewhere.deb Package)" = elsewhere
    test "$(dpkg-deb -f /opt/innkeeper/elsewhere.deb Version)" = "$1"
    chmod 644 /opt/innkeeper/elsewhere.deb
    DEBIAN_FRONTEND=noninteractive apt-get install -y --reinstall /opt/innkeeper/elsewhere.deb
fi
