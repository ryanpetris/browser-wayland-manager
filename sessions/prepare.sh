#!/bin/sh
set -eu
umask 077
url=$1
package=$2
image=$3
if [ -z "$url" ] && [ ! -s "$package" ]; then
    echo "Local Elsewhere package is missing; rebuild with make elsewhere-local." >&2
    exit 1
fi
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
elif [ -z "$url" ]; then
    echo "Using local $(basename "$package")"
else
    echo "Using cached $(basename "$package")"
fi
if [ -n "$image" ] && ! docker image inspect "$image" >/dev/null 2>&1; then
    docker pull --platform linux/amd64 "$image"
fi
