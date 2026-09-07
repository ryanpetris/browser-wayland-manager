#!/usr/bin/env python3
"""Run in the Innkeeper Docker image with Python, zstd, OpenSSL and the Docker socket.

Uses tiny real Arch/Debian packages and disposable sessions to check upgrades and settings.
"""
import concurrent.futures
import http.server
import json
import os
from pathlib import Path
import shutil
import signal
import sys
import threading
import subprocess
import tempfile
import time
import tomllib
import urllib.request
import urllib.parse


def run(*args):
    return subprocess.check_output(args, text=True).strip()


with tempfile.TemporaryDirectory(prefix="innkeeper-refresh-") as temporary:
    work = Path(temporary)
    data = work / "data"
    assets = work / "assets"
    recipes = assets / "sessions"
    recipes.mkdir(parents=True)
    source = Path("/usr/share/elsewhere-innkeeper/sessions")
    shutil.copytree(source, recipes, dirs_exist_ok=True)
    for distro in ("arch", "debian"):
        (recipes / f"setup-{distro}.sh").write_text(
            "set -eu\nuseradd -m -u 1000 elsewhere\n"
        )
    (recipes / "packages.sh").write_text("exit 0\n")
    # Exercise the production launcher with a fixture session bus and desktop.
    class Ready(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            try:
                records = json.loads((data / "state.json").read_text())["sessions"]
                sid = next(s["id"] for s in records if s["port"] == self.server.server_port)
                token = run("docker", "exec", "--user", "elsewhere", "--env", "HOME=/home/elsewhere", "innkeeper-" + sid, "elsewhere", "token", "--viewer")
                authenticated = self.headers.get("Authorization") == "Bearer " + token
            except Exception:
                authenticated = False
            self.send_response(503 if (work / "not-ready").exists() else 200 if authenticated else 401)
            self.end_headers()
            self.wfile.write(b"[]")
        def log_message(self, *args):
            pass
    for port in (19500, 19501):
        readiness = http.server.ThreadingHTTPServer(("127.0.0.1", port), Ready)
        threading.Thread(target=readiness.serve_forever, daemon=True).start()
    # Use Docker-assigned host ports so the rig can coexist with live sessions.
    tools = work / "bin"
    tools.mkdir()
    wrapper = tools / "docker"
    wrapper.write_text("""#!/usr/bin/python3
import os, sys
from pathlib import Path
args = sys.argv[1:]
if args[:1] in (['image'], ['pull']) and Path(__file__).with_name('no-base').exists():
    Path(__file__).with_name('image-attempt').touch()
    sys.exit(1)
if args and args[0] in ('cp', 'start', 'stop') and Path(__file__).with_name('fail-' + args[0]).exists():
    sys.exit(1)
if args and args[0] == 'create':
    # Model a daemon whose default logging driver is journald.
    if '--log-driver' not in args:
        args[1:1] = ['--log-driver', 'journald']
    if Path(__file__).with_name('fail-create').exists():
        args[args.index('--log-driver') + 1] = 'journald'
    args[1:1] = ['--env', 'INNKEEPER_SCREEN_SIZE=640x480', '--env', 'INNKEEPER_KIOSK=1', '--env', 'INNKEEPER_STARTUP_COMMAND=stale']
    for i, arg in enumerate(args):
        if arg == '-p':
            args[i + 1] = '127.0.0.1::' + args[i + 1].rsplit(':', 1)[1]
os.execv('/usr/bin/docker', ['docker', *args])
""")
    wrapper.chmod(0o755)
    version = tomllib.loads((Path(__file__).resolve().parent.parent / "Cargo.toml").read_text())["package"]["metadata"]["elsewhere"]["version"]
    local_mode = sys.argv[1:] == ["--local"]
    if local_mode:
        version = "0.4.4.7.dirty"


    def package(distro, label, installed=None):
        installed = installed or version
        root = work / f"package-{distro}"
        shutil.rmtree(root, ignore_errors=True)
        (root / "usr/bin").mkdir(parents=True)
        binary = root / "usr/bin/elsewhere"
        binary.write_text("""#!/bin/sh
set -eu
if [ "${1:-}" = token ]; then
    file=token
    if [ "${2:-}" = --viewer ]; then file=viewer-token; fi
    if [ -f "$HOME/token-command-fails" ]; then echo credential-output-must-not-leak; echo credential-diagnostic-must-not-leak >&2; exit 1; fi
    cat "$HOME/.config/elsewhere/$file"
    printf '\n'
    exit 0
fi
mkdir -p "$HOME/.config/elsewhere"
if [ ! -f "$HOME/.config/elsewhere/token" ]; then printf 'opaque control+/=?%%:initial' > "$HOME/.config/elsewhere/token"; fi
if [ ! -f "$HOME/.config/elsewhere/viewer-token" ]; then printf 'opaque.viewer+/=?%%:initial' > "$HOME/.config/elsewhere/viewer-token"; fi
printf '%s\\0' "$@" > "$HOME/launch-args"
printf '%s\n' LABEL >> "$HOME/launches"
echo 'https://example.invalid/#token=opaque control+/=?%%:initial'
exec sleep 10000
""".replace("LABEL", label))
        (root / "usr/local/bin").mkdir(parents=True)
        bus = root / "usr/local/bin/dbus-daemon"
        bus.write_text("#!/bin/sh\necho unix:path=/tmp/fixture-bus\n")
        bus.chmod(0o755)
        binary.chmod(0o755)
        cache = data / "packages" / version / "x86_64" / distro
        cache.mkdir(parents=True, exist_ok=True)
        if distro == "arch":
            (root / ".PKGINFO").write_text(
                f"pkgname = elsewhere\npkgver = {installed}-1\npkgdesc = Refresh fixture\n"
                "arch = x86_64\nbuilddate = 0\nsize = 100\nlicense = MIT\n"
            )
            path = cache / f"elsewhere-{version}-1-x86_64.pkg.tar.zst"
            run("tar", "--zstd", "-cf", str(path), "-C", str(root), ".PKGINFO", "usr")
        else:
            (root / "DEBIAN").mkdir()
            (root / "DEBIAN/control").write_text(
                f"Package: elsewhere\nVersion: {installed}-1\nArchitecture: amd64\n"
                "Maintainer: Test <test@example.invalid>\nDescription: Refresh fixture\n"
            )
            path = cache / f"elsewhere_{version}-1_amd64.deb"
            run("dpkg-deb", "--build", "--root-owner-group", str(root), str(path))
        return path

    # Pre-pull only the two stock images used by our disposable containers.
    for image in ("archlinux:base", "debian:trixie-slim"):
        run("docker", "pull", image)
    for distro in ("arch", "debian"):
        package(distro, "first")
    env = dict(os.environ, PATH=f"{tools}:{os.environ['PATH']}",
               INNKEEPER_DATA_DIR=str(data), INNKEEPER_ASSETS_DIR=str(assets),
               INNKEEPER_LISTEN="127.0.0.1:29300", INNKEEPER_IN_DOCKER="0", INNKEEPER_RTC_ADDR="127.0.0.1")
    if local_mode:
        local = work / "local"
        generation = local / "build-fixture"
        generation.mkdir(parents=True)
        for distro in ("arch", "debian"):
            archive = package(distro, "first")
            shutil.copyfile(archive, generation / archive.name)
        manifest = local / "manifest.json"
        manifest.write_text(json.dumps({"version": version, "directory": generation.name}))
        env["INNKEEPER_LOCAL_ELSEWHERE"] = str(manifest)
        curl = tools / "curl"
        curl.write_text("#!/bin/sh\ntouch " + str(work / "download-attempt") + "\nexit 1\n")
        curl.chmod(0o755)
    log = (work / "manager.log").open("w+")
    manager = subprocess.Popen(["elsewhere-innkeeper"], env=env, stdout=log, stderr=log)
    created = []

    def api(path, method="GET", body=None):
        request = urllib.request.Request(
            "http://127.0.0.1:29300/api" + path, method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": "Bearer " + (data / "admin-token").read_text().strip(),
                     "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            payload = response.read()
            return json.loads(payload) if payload else None

    def wait(check, timeout=45):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if check():
                return
            time.sleep(0.2)
        raise AssertionError("Timed out waiting for " + str(check))

    def state(sid):
        return next(s for s in api("/sessions")["sessions"] if s["id"] == sid)

    def launched(sid, count):
        result = subprocess.run(
            ["docker", "exec", "innkeeper-" + sid, "cat", "/home/elsewhere/launches"],
            capture_output=True, text=True,
        )
        return result.returncode == 0 and len(result.stdout.splitlines()) == count

    def restart_manager():
        global manager
        manager.send_signal(signal.SIGINT)
        manager.wait(timeout=10)
        manager = subprocess.Popen(["elsewhere-innkeeper"], env=env, stdout=log, stderr=log)
        def online():
            try: return api("/sessions")
            except OSError: return False
        wait(online)

    def rejected_action(sid, action, code):
        try:
            api(f"/sessions/{sid}/{action}", "POST")
            raise AssertionError(f"Unexpectedly accepted {action}")
        except urllib.error.HTTPError as error:
            assert error.code == code, error.code
            return error.read().decode()

    try:
        wait(lambda: (data / "admin-token").exists())
        (tools / "fail-create").touch()
        probe = api("/sessions", "POST", {"name": "Container creation failure", "distribution": "debian", "packages": []})["id"]
        created.append(probe)
        wait(lambda: state(probe)["status"] == "failed")
        cause = state(probe)["error"]
        assert isinstance(cause, str) and "unknown log opt" in cause and "journald" in cause, cause
        time.sleep(7)
        assert state(probe)["error"] == cause
        (tools / "fail-create").unlink()
        api(f"/sessions/{probe}", "DELETE")
        created.remove(probe)
        print("Container creation error survives status polling", flush=True)
        if local_mode:
            assert api("/sessions")["local_elsewhere"] is True
            for distro in ("arch", "debian"):
                sid = api("/sessions", "POST", {"name": "Local " + distro,
                          "distribution": distro, "packages": []})["id"]
                created.append(sid)
                wait(lambda: state(sid)["status"] == "running", timeout=90)
                logging = json.loads(run("docker", "inspect", "innkeeper-" + sid))[0]["HostConfig"]["LogConfig"]
                assert logging == {"Type": "json-file", "Config": {"max-size": "10m", "max-file": "3"}}, logging
                assert state(sid)["expected_version"] == version
                assert state(sid)["installed_version"] == version + "-1"
                assert state(sid)["version_status"] == "current"
                assert api(f"/sessions/{sid}/link", "POST")["url"]
                rejected_action(sid, "upgrade", 409)
                # Start uses the installed package even if the local artifact disappears.
                cached = package(distro, "first")
                artifact = generation / cached.name
                artifact.unlink()
                api(f"/sessions/{sid}/stop", "POST")
                api(f"/sessions/{sid}/start", "POST")
                wait(lambda: state(sid)["status"] == "running")
                missing = api("/sessions", "POST", {"name": "Missing package",
                              "distribution": distro, "packages": []})["id"]
                created.append(missing)
                wait(lambda: state(missing)["status"] == "failed")
                assert "Local Elsewhere package is missing" in api(f"/sessions/{missing}/logs")["text"]
                assert not (work / "download-attempt").exists()
                api(f"/sessions/{missing}", "DELETE")
                created.remove(missing)
                invalid = subprocess.run(["elsewhere-innkeeper"], env=dict(env, INNKEEPER_DATA_DIR=str(work / "invalid")),
                                         capture_output=True, text=True, timeout=10)
                assert invalid.returncode != 0 and "Local Elsewhere package is missing" in invalid.stderr
                shutil.copyfile(cached, artifact)
                api(f"/sessions/{sid}/stop", "POST")
                print(f"{distro}: local dirty package, exact version, token CLI, launch-only Start and missing-package failure passed", flush=True)
            manager.send_signal(signal.SIGINT)
            manager.wait(timeout=10)
            env.pop("INNKEEPER_LOCAL_ELSEWHERE")
            manager = subprocess.Popen(["elsewhere-innkeeper"], env=env, stdout=log, stderr=log)
            def normal_mode():
                try: return api("/sessions")["local_elsewhere"] is False
                except OSError: return False
            wait(normal_mode)
            pinned = tomllib.loads((Path(__file__).resolve().parent.parent / "Cargo.toml").read_text())["package"]["metadata"]["elsewhere"]["version"]
            assert all(s["expected_version"] == pinned for s in api("/sessions")["sessions"])
            print("Ordinary startup restores the Cargo release pin without changing installed packages", flush=True)
        for distro in (() if local_mode else ("arch", "debian")):
            # Creation failures retain their cause even when no container exists.
            cached = package(distro, "first")
            cached.unlink()
            prepare_script = (recipes / "prepare.sh").read_text()
            for script, cancelled in [("echo 'Fixture download failure'\nexit 1\n", False),
                                      ("echo 'Fixture waiting'\nexec sleep 60\n", True)]:
                (recipes / "prepare.sh").write_text(script)
                probe = api("/sessions", "POST", {"name": "Creation recovery", "distribution": distro, "packages": []})["id"]
                created.append(probe)
                wait(lambda: "Fixture" in api(f"/sessions/{probe}/logs")["text"])
                if cancelled:
                    api(f"/sessions/{probe}/stop", "POST")
                else:
                    wait(lambda: state(probe)["status"] == "failed")
                expected = state(probe)
                time.sleep(4)
                assert state(probe)["status"] == ("cancelled" if cancelled else "failed")
                assert state(probe)["error"] == expected["error"]
                api(f"/sessions/{probe}", "DELETE")
                created.remove(probe)
            (recipes / "prepare.sh").write_text(prepare_script)
            package(distro, "first")
            # A failed initial install has an explicit repair, with no install on Start.
            installer = (recipes / "install.sh").read_text()
            (recipes / "install.sh").write_text("echo 'Fixture create install failure'\nexit 7\n")
            probe = api("/sessions", "POST", {"name": "Install recovery", "distribution": distro, "packages": []})["id"]
            created.append(probe)
            wait(lambda: state(probe)["status"] == "failed")
            api(f"/sessions/{probe}/stop", "POST")
            restart_manager()
            wait(lambda: state(probe)["repair_available"])
            rejected_action(probe, "start", 409)
            (tools / "fail-cp").touch()
            rejected_action(probe, "upgrade", 500)
            (tools / "fail-cp").unlink()
            (recipes / "install.sh").write_text(installer)
            api(f"/sessions/{probe}/upgrade", "POST")
            wait(lambda: state(probe)["status"] == "stopped", timeout=90)
            assert not state(probe)["repair_available"]
            api(f"/sessions/{probe}/start", "POST")
            wait(lambda: state(probe)["status"] == "running")
            probe_name = "innkeeper-" + probe
            if distro == "arch":
                run("docker", "exec", probe_name, "ln", "-s", "/tmp/unreadable", "/var/lib/pacman/local/elsewhere-invalid")
                restart_manager()
                wait(lambda: state(probe)["installed_version"] is None)
                assert not state(probe)["repair_available"]
                rejected_action(probe, "upgrade", 500)
                run("docker", "exec", probe_name, "rm", "/var/lib/pacman/local/elsewhere-invalid")
            else:
                # A pending journal can supersede status; never authorize from stale metadata.
                run("docker", "exec", probe_name, "sh", "-c", "printf 'Package: elsewhere\\nStatus: install ok unpacked\\nVersion: 99.0.0-1\\nArchitecture: amd64\\nDescription: Pending fixture\\n' > /var/lib/dpkg/updates/0000")
                restart_manager()
                wait(lambda: state(probe)["version_error"] is not None)
                assert "journal is pending" in state(probe)["version_error"]
                assert state(probe)["installed_version"] is None and not state(probe)["repair_available"]
                rejected_action(probe, "upgrade", 500)
                run("docker", "exec", probe_name, "rm", "/var/lib/dpkg/updates/0000")
                # Settled dpkg metadata can describe an incomplete installation.
                archive = package(distro, "first")
                run("docker", "cp", str(archive), probe_name + ":/tmp/fixture.deb")
                run("docker", "exec", probe_name, "dpkg", "--unpack", "/tmp/fixture.deb")
                api(f"/sessions/{probe}/stop", "POST")
                restart_manager()
                wait(lambda: state(probe)["repair_available"])
                assert state(probe)["installed_version"] == version + "-1"
                api(f"/sessions/{probe}/upgrade", "POST")
                wait(lambda: state(probe)["status"] == "stopped", timeout=90)
                assert not state(probe)["repair_available"]
                api(f"/sessions/{probe}/start", "POST")
                wait(lambda: state(probe)["status"] == "running")
                archive = package(distro, "newer", "99.0.0")
                run("docker", "cp", str(archive), probe_name + ":/tmp/fixture.deb")
                run("docker", "exec", probe_name, "dpkg", "--unpack", "/tmp/fixture.deb")
                api(f"/sessions/{probe}/stop", "POST")
                restart_manager()
                wait(lambda: state(probe)["version_status"] == "newer")
                assert not state(probe)["repair_available"]
                rejected_action(probe, "upgrade", 409)
                assert "Manual package-manager recovery" in rejected_action(probe, "start", 409)
                package(distro, "first")
            api(f"/sessions/{probe}", "DELETE")
            created.remove(probe)
            print(f"{distro}: cancelled/failed creation and explicit initial-install repair passed", flush=True)
            sid = api("/sessions", "POST", {"name": "Refresh " + distro,
                      "distribution": distro, "packages": []})["id"]
            created.append(sid)
            name = "innkeeper-" + sid
            wait(lambda: state(sid)["status"] == "running")
            assert state(sid)["installed_version"] == version + "-1"
            assert state(sid)["version_status"] == "current"
            identity = run("docker", "inspect", name, "--format", "{{.Id}}")
            def install_fixture(label, installed):
                archive = package(distro, label, installed)
                destination = "/tmp/fixture." + ("pkg.tar.zst" if distro == "arch" else "deb")
                run("docker", "cp", str(archive), name + ":" + destination)
                if distro == "arch":
                    run("docker", "exec", name, "pacman", "-U", "--noconfirm", destination)
                else:
                    run("docker", "exec", name, "dpkg", "-i", destination)
                return archive
            cached = install_fixture("old", "0.0.1")
            # A newer cache entry cannot change the package during Start.
            package(distro, "upgraded")
            run("docker", "exec", name, "sh", "-c", "printf 'exit 99\\n' > /opt/innkeeper/entrypoint.sh")
            api(f"/sessions/{sid}/stop", "POST")
            # Reload forces immediate metadata detection on the stopped container.
            restart_manager()
            wait(lambda: state(sid)["version_status"] == "older")
            assert state(sid)["installed_version"] == "0.0.1-1"
            (tools / "no-base").touch()
            api(f"/sessions/{sid}/start", "POST")
            wait(lambda: state(sid)["status"] == "running")
            assert run("docker", "exec", name, "cat", "/home/elsewhere/launches").splitlines() == ["first", "old"]
            api(f"/sessions/{sid}/stop", "POST")
            cached.unlink()
            (recipes / "prepare.sh").write_text("echo 'Fixture download failure'\nexit 1\n")
            api(f"/sessions/{sid}/upgrade", "POST")
            wait(lambda: state(sid)["status"] == "failed")
            api(f"/sessions/{sid}/stop", "POST")
            # Start has no download dependency, even with a failed upgrade and empty cache.
            api(f"/sessions/{sid}/start", "POST")
            wait(lambda: state(sid)["status"] == "running")
            assert launched(sid, 3)
            api(f"/sessions/{sid}/stop", "POST")
            (recipes / "prepare.sh").write_text("echo 'Fixture waiting'\nexec sleep 60\n")
            api(f"/sessions/{sid}/upgrade", "POST")
            wait(lambda: "Fixture waiting" in api(f"/sessions/{sid}/logs")["text"])
            api(f"/sessions/{sid}/stop", "POST")
            restart_manager()
            wait(lambda: state(sid)["version_status"] == "older")
            assert state(sid)["status"] == "stopped"
            # An upgrade exits without launching or applying pending desktop settings.
            pending_profile = {"name":"Upgrade test", "screen_size":{"width":1280,"height":720}, "kiosk":False, "startup_command":""}
            api(f"/sessions/{sid}/settings", "PUT", pending_profile)
            package(distro, "upgraded")
            api(f"/sessions/{sid}/upgrade", "POST")
            wait(lambda: state(sid)["status"] == "stopped")
            assert state(sid)["installed_version"] == version + "-1"
            assert state(sid)["settings_pending"]
            assert run("docker", "inspect", name, "--format", "{{.State.Running}}") == "false"
            api(f"/sessions/{sid}/start", "POST")
            wait(lambda: state(sid)["status"] == "running")
            assert run("docker", "exec", name, "cat", "/home/elsewhere/launches").splitlines() == ["first", "old", "old", "upgraded"]
            # Failed maintenance is durable and Start never retries it.
            install_fixture("old-again", "0.0.1")
            package(distro, "upgraded")
            installer = (recipes / "install.sh").read_text()
            (recipes / "install.sh").write_text("echo 'Fixture install failure'\nexit 7\n")
            api(f"/sessions/{sid}/upgrade", "POST")
            wait(lambda: state(sid)["status"] == "failed")
            assert run("docker", "inspect", name, "--format", "{{.State.Running}}") == "false"
            restart_manager()
            time.sleep(4)
            assert state(sid)["status"] == "failed"
            api(f"/sessions/{sid}/stop", "POST")
            time.sleep(4)
            assert state(sid)["status"] == "stopped" and state(sid)["error"] is None
            api(f"/sessions/{sid}/start", "POST")
            wait(lambda: state(sid)["status"] == "running")
            assert run("docker", "exec", name, "cat", "/home/elsewhere/launches").splitlines()[-1] == "old-again"
            # Restart during a running desktop's upgrade download reconnects without a relaunch.
            cached.unlink()
            (recipes / "prepare.sh").write_text("echo 'Fixture interrupted download'\nexec sleep 60\n")
            api(f"/sessions/{sid}/upgrade", "POST")
            wait(lambda: "Fixture interrupted download" in api(f"/sessions/{sid}/logs")["text"])
            restart_manager()
            wait(lambda: state(sid)["status"] == "running")
            assert api(f"/sessions/{sid}/link", "POST")["url"]
            assert run("docker", "exec", name, "cat", "/home/elsewhere/launches").splitlines()[-1] == "old-again"
            package(distro, "upgraded")
            # A slow maintenance operation stays monitored across restart and late success.
            (recipes / "install.sh").write_text("echo 'Fixture install waiting'\nwhile [ ! -f /tmp/finish-upgrade ]; do sleep 1; done\n" + installer)
            api(f"/sessions/{sid}/upgrade", "POST")
            wait(lambda: "Fixture install waiting" in api(f"/sessions/{sid}/logs")["text"])
            manager.send_signal(signal.SIGINT)
            manager.wait(timeout=10)
            interrupted = json.loads((data / "state.json").read_text())
            for session in interrupted["sessions"]:
                if session["id"] == sid:
                    session["upgrade_started_ms"] = 1
            (data / "state.json").write_text(json.dumps(interrupted))
            manager = subprocess.Popen(["elsewhere-innkeeper"], env=env, stdout=log, stderr=log)
            def warned():
                try: return "longer than 30 minutes" in (state(sid)["error"] or "")
                except OSError: return False
            wait(warned)
            time.sleep(4)
            assert state(sid)["status"] == "upgrading"
            assert run("docker", "inspect", name, "--format", "{{.State.Running}}") == "true"
            run("docker", "exec", name, "touch", "/tmp/finish-upgrade")
            wait(lambda: state(sid)["status"] == "stopped", timeout=90)
            assert state(sid)["error"] is None
            assert state(sid)["installed_version"] == version + "-1"
            (recipes / "install.sh").write_text(installer)
            api(f"/sessions/{sid}/start", "POST")
            wait(lambda: state(sid)["status"] == "running")
            # Newer packages are shown as newer and cannot be downgraded by Upgrade or Start.
            install_fixture("newer", "99.0.0")
            api(f"/sessions/{sid}/stop", "POST")
            restart_manager()
            wait(lambda: state(sid)["version_status"] == "newer")
            try:
                api(f"/sessions/{sid}/upgrade", "POST")
                raise AssertionError("Newer package accepted for upgrade")
            except urllib.error.HTTPError as e:
                assert e.code == 409
            package(distro, "upgraded")
            api(f"/sessions/{sid}/start", "POST")
            wait(lambda: state(sid)["status"] == "running")
            assert state(sid)["version_status"] == "newer"
            assert not (tools / "image-attempt").exists()
            (tools / "no-base").unlink()
            api(f"/sessions/{sid}/settings", "PUT", dict(pending_profile, screen_size=None))
            api(f"/sessions/{sid}/relaunch", "POST")
            wait(lambda: state(sid)["status"] == "running")
            # Credentials are read on demand and opaque, with no database copies.
            def token(viewer=False):
                return run("docker", "exec", "--user", "elsewhere", "--env", "HOME=/home/elsewhere", name, "elsewhere", "token", *(["--viewer"] if viewer else []))
            def link_token():
                link = api(f"/sessions/{sid}/link", "POST")["url"]
                return urllib.parse.parse_qs(urllib.parse.urlparse(link).fragment)["token"][0]
            assert link_token() == token()
            run("docker", "exec", name, "sh", "-c", "printf 'rotated opaque+/=?%%:value' > /home/elsewhere/.config/elsewhere/token; printf 'rotated.viewer+/=?%%:value' > /home/elsewhere/.config/elsewhere/viewer-token")
            assert link_token() == token()
            run("docker", "exec", name, "sh", "-c", "cat /home/elsewhere/.config/elsewhere/token > /proc/1/fd/1; printf '\\n' > /proc/1/fd/1")
            assert token() not in api(f"/sessions/{sid}/logs")["text"]
            assert "opaque control" not in api(f"/sessions/{sid}/logs")["text"]
            run("docker", "exec", name, "touch", "/home/elsewhere/token-command-fails")
            try:
                api(f"/sessions/{sid}/link", "POST")
                raise AssertionError("Failed token command accepted")
            except urllib.error.HTTPError as e:
                assert e.code == 500 and b"must-not-leak" not in e.read()
            api(f"/sessions/{sid}/relaunch", "POST")
            wait(lambda: state(sid)["error"] and "token" in state(sid)["error"])
            assert state(sid)["status"] == "preparing"
            assert "must-not-leak" not in json.dumps(state(sid))
            run("docker", "exec", name, "rm", "/home/elsewhere/token-command-fails")
            wait(lambda: state(sid)["status"] == "running")
            baseline = len(run("docker", "exec", name, "cat", "/home/elsewhere/launches").splitlines())
            private = next(s for s in json.loads((data / "state.json").read_text())["sessions"] if s["id"] == sid)
            run("docker", "exec", name, "sh", "-c", "echo retained > /root/settings-sentinel")
            assert "token" not in private and "viewer_token" not in private
            run("docker", "exec", name, "test", "!", "-d", "/seed")
            # Legacy state has no snapshots. Its stored settings describe its last launch.
            manager.send_signal(signal.SIGINT)
            manager.wait(timeout=10)
            legacy = json.loads((data / "state.json").read_text())
            for session in legacy["sessions"]:
                if session["id"] == sid:
                    session["token"] = "stale credential"
                    session["viewer_token"] = "stale viewer credential"
                    session.pop("applied_settings", None)
                    session.pop("launching_settings", None)
            (data / "state.json").write_text(json.dumps(legacy))
            manager = subprocess.Popen(["elsewhere-innkeeper"], env=env, stdout=log, stderr=log)
            def legacy_ready():
                try:
                    return state(sid)["status"] == "running"
                except OSError:
                    return False
            wait(legacy_ready)
            assert not state(sid)["settings_pending"]
            original = {k: state(sid)[k] for k in ("name", "screen_size", "kiosk", "startup_command")}
            def save(settings):
                return api(f"/sessions/{sid}/settings", "PUT", settings)
            def pending():
                return state(sid)["settings_pending"]
            def rejected(path, method, body, status):
                try:
                    api(path, method, body)
                except urllib.error.HTTPError as e:
                    assert e.code == status, (e.code, e.read())
                else:
                    raise AssertionError("Request unexpectedly succeeded")
            # Saving and renaming never restart the desktop; reverting clears pending.
            renamed = dict(original, name="Renamed")
            assert not save(renamed)["settings_pending"]
            command = "printf '%s' \"$(touch /tmp/unexpected)\";\n echo 'quoted'"
            edited = dict(renamed, screen_size={"width": 1280, "height": 720}, kiosk=True,
                          startup_command=command)
            assert save(edited)["settings_pending"]
            assert launched(sid, baseline)
            assert not save(renamed)["settings_pending"]
            save(edited)
            for bad in (dict(edited, screen_size={"width": 3, "height": 720}),
                        dict(edited, startup_command="\0"), dict(edited, name=" ")):
                rejected(f"/sessions/{sid}/settings", "PUT", bad, 400)
            missing = dict(edited)
            del missing["screen_size"]
            rejected(f"/sessions/{sid}/settings", "PUT", missing, 422)
            rejected(f"/sessions/{sid}/settings", "PUT", dict(edited, packages=[]), 422)
            # A failed write cannot publish edits in memory.
            (data / "state.tmp").mkdir()
            rejected(f"/sessions/{sid}/settings", "PUT", renamed, 500)
            assert pending() and state(sid)["kiosk"]
            (data / "state.tmp").rmdir()
            manager.send_signal(signal.SIGINT)
            manager.wait(timeout=10)
            manager = subprocess.Popen(["elsewhere-innkeeper"], env=env, stdout=log, stderr=log)
            def online():
                try:
                    return pending()
                except OSError:
                    return False
            wait(online)
            # Stop failure preserves the current desktop and pending settings.
            (tools / "fail-stop").touch()
            rejected(f"/sessions/{sid}/relaunch", "POST", None, 500)
            (tools / "fail-stop").unlink()
            assert launched(sid, baseline) and pending()
            # The operation lock admits only one of simultaneous relaunch requests.
            def restart():
                try:
                    api(f"/sessions/{sid}/relaunch", "POST")
                    return 202
                except urllib.error.HTTPError as e:
                    return e.code
            (work / "not-ready").touch()
            with concurrent.futures.ThreadPoolExecutor(2) as pool:
                assert sorted(pool.map(lambda _: restart(), range(2))) == [202, 409]
            wait(lambda: launched(sid, baseline + 1))
            assert pending() and state(sid)["status"] == "preparing"
            rejected(f"/sessions/{sid}/settings", "PUT", renamed, 409)
            (work / "not-ready").unlink()
            wait(lambda: state(sid)["status"] == "running" and not pending())
            assert launched(sid, baseline + 1)
            args = subprocess.check_output(["docker", "exec", name, "cat", "/home/elsewhere/launch-args"]).decode().split("\0")[:-1]
            assert args == ["--no-tls", "--listen", "0.0.0.0:19443", "--url-prefix", "/e/" + sid, "--rtc-port", str(state(sid)["port"]), "--elements", "--rtc-addr", "127.0.0.1",
                            "--screen-size", "1280x720", "--kiosk", "--exec", command], args
            run("docker", "exec", name, "test", "!", "-e", "/tmp/unexpected")
            assert run("docker", "inspect", name, "--format", "{{.Id}}") == identity
            current = next(s for s in json.loads((data / "state.json").read_text())["sessions"] if s["id"] == sid)
            assert all(current[k] == private[k] for k in ("id", "port"))
            assert "token" not in current and "viewer_token" not in current
            assert run("docker", "exec", name, "cat", "/root/settings-sentinel") == "retained"
            # Copy and Docker start failures retain edits for a later start.
            for failure in ("cp", "start"):
                save(renamed)
                (tools / ("fail-" + failure)).touch()
                api(f"/sessions/{sid}/relaunch", "POST")
                wait(lambda: state(sid)["status"] == "failed")
                error = state(sid)["error"]
                time.sleep(4)
                assert pending() and state(sid)["status"] == "failed" and state(sid)["error"] == error
                (tools / ("fail-" + failure)).unlink()
                api(f"/sessions/{sid}/stop", "POST")
                assert save(renamed)["settings_pending"]
                api(f"/sessions/{sid}/start", "POST")
                wait(lambda: state(sid)["status"] == "running" and not pending())
                args = subprocess.check_output(["docker", "exec", name, "cat", "/home/elsewhere/launch-args"]).decode().split("\0")[:-1]
                assert args == ["--no-tls", "--listen", "0.0.0.0:19443", "--url-prefix", "/e/" + sid, "--rtc-port", str(state(sid)["port"]), "--elements", "--rtc-addr", "127.0.0.1"]
                save(edited)
                api(f"/sessions/{sid}/relaunch", "POST")
                wait(lambda: state(sid)["status"] == "running" and not pending())
            # A persistence failure after stopping leaves settings available for retry.
            save(renamed)
            (data / "state.tmp").mkdir()
            rejected(f"/sessions/{sid}/relaunch", "POST", None, 500)
            assert run("docker", "inspect", name, "--format", "{{.State.Running}}") == "false"
            assert pending()
            (data / "state.tmp").rmdir()
            wait(lambda: state(sid)["status"] == "stopped")
            api(f"/sessions/{sid}/start", "POST")
            wait(lambda: state(sid)["status"] == "running" and not pending())
            print(f"{distro}: saved settings, resets, quoting, pending state, persistence, serialized relaunch and failure retry passed", flush=True)
            print(f"{distro}: explicit upgrade, stopped version detection, newer warning, launch-only start, cancellation, opaque token commands and migration passed", flush=True)
    except BaseException:
        for sid in created:
            subprocess.run(["docker", "logs", "--tail", "80", "innkeeper-" + sid])
        raise
    finally:
        for sid in created:
            try:
                api(f"/sessions/{sid}", "DELETE")
            except Exception:
                subprocess.run(["docker", "rm", "-f", "innkeeper-" + sid], capture_output=True)
                subprocess.run(["docker", "volume", "rm", "innkeeper-" + sid + "-data"], capture_output=True)
        manager.terminate()
        manager.wait(timeout=10)
        log.seek(0)
        print(log.read())
