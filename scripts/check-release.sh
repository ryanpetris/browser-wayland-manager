#!/bin/sh
# Check the installed release, package setup, and authenticated management API.
set -eu

version=${1:?expected release version}
expected="elsewhere-innkeeper $version"
actual=$(elsewhere-innkeeper --version)
if [ "$actual" != "$expected" ]; then
    printf 'Expected %s, got %s\n' "$expected" "$actual" >&2
    exit 1
fi

docker --version
getent passwd elsewhere-innkeeper
test -s /usr/share/elsewhere-innkeeper/sessions/start.sh
test -s /usr/lib/systemd/system/elsewhere-innkeeper.service
test -s /etc/elsewhere-innkeeper/environment
dpkg-query -W -f='${Conffiles}\n' elsewhere-innkeeper | grep -F ' /etc/elsewhere-innkeeper/environment '
state=$(systemctl is-enabled elsewhere-innkeeper.service 2>/dev/null || true)
test "$state" = disabled

work=$(mktemp -d)
pid=
cleanup() {
    if [ -n "$pid" ]; then
        kill -KILL "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
    fi
    rm -rf "$work"
}
trap 'cleanup' EXIT
trap 'exit 1' HUP INT TERM
export INNKEEPER_DATA_DIR="$work/data" INNKEEPER_LISTEN=127.0.0.1:29300
export INNKEEPER_IN_DOCKER=0 INNKEEPER_TLS=1
unset INNKEEPER_RTC_ADDR
elsewhere-innkeeper >"$work/server.log" 2>&1 &
pid=$!
for _ in $(seq 1 30); do
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    if curl --insecure --fail --silent --max-time 2 https://127.0.0.1:29300/api/setup -o "$work/setup.json"; then
        curl --insecure --fail --silent --max-time 10 -c "$work/cookies" \
            -H 'Origin: https://127.0.0.1:29300' -H 'Content-Type: application/json' \
            --data '{"username":"fixture","display_name":"Release check","password":"release fixture password"}' \
            https://127.0.0.1:29300/api/setup -o "$work/account.json"
        curl --insecure --fail --silent --max-time 2 -b "$work/cookies" \
            https://127.0.0.1:29300/api/sessions -o "$work/sessions.json"
        response=$(cat "$work/sessions.json")
        fields="\"local_elsewhere\":false,\"sessions\":[],\"version\":\"$version\""
        if [ "$response" != "{\"gpu_available\":false,$fields}" ] &&
           [ "$response" != "{\"gpu_available\":true,$fields}" ]; then
            printf 'Unexpected sessions response: ' >&2
            cat "$work/sessions.json" >&2
            cat "$work/server.log" >&2
            exit 1
        fi
        printf 'Release version, package setup and authenticated API verified\n'
        exit 0
    fi
    sleep 1
done
cat "$work/server.log" >&2
exit 1
