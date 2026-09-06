#!/bin/sh
set -eu
umask 077
url=$1
package=$2
image=$3
mkdir -p "$(dirname "$package")"
if [ ! -s "$package" ]; then
    partial="$package.part"
    trap 'rm -f "$partial"' EXIT
    trap 'exit 1' HUP INT TERM
    echo "Downloading $(basename "$package")"
    curl --fail --location --retry 3 --retry-max-time 1200 --connect-timeout 30 --max-time 300 \
        --proto '=https' --proto-redir '=https' --output "$partial" "$url"
    test -s "$partial"
    mv "$partial" "$package"
    trap - EXIT HUP INT TERM
else
    echo "Using cached $(basename "$package")"
fi
if ! docker image inspect "$image" >/dev/null 2>&1; then
    docker pull --platform linux/amd64 "$image"
fi
