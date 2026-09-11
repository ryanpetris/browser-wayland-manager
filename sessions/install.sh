#!/bin/sh
set -eu
if command -v pacman >/dev/null; then
    test "$(pacman -Qp /opt/innkeeper/elsewhere.pkg.tar.zst)" = "elsewhere $1"
    if [ "${INNKEEPER_BASE_READY:-0}" = 1 ]; then pacman -Syu --noconfirm; fi
    pacman -U --noconfirm /opt/innkeeper/elsewhere.pkg.tar.zst
else
    test "$(dpkg-deb -f /opt/innkeeper/elsewhere.deb Package)" = elsewhere
    test "$(dpkg-deb -f /opt/innkeeper/elsewhere.deb Version)" = "$1"
    chmod 644 /opt/innkeeper/elsewhere.deb
    apt-get update
    set -- --reinstall
    case "$(dpkg-query -W -f='${db:Status-Status}' elsewhere 2>/dev/null || true)" in
        unpacked|half-configured|triggers-awaited|triggers-pending)
            # Replace the selected package contents before configuration.
            dpkg --unpack /opt/innkeeper/elsewhere.deb
            set -- --fix-broken
            ;;
    esac
    DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades "$@" /opt/innkeeper/elsewhere.deb
fi
