#!/usr/bin/env python3
"""Run in the Innkeeper Docker image with Python, zstd, OpenSSL and the Docker socket.

Uses tiny real Arch/Debian packages and disposable sessions to check refresh and settings.
"""
import concurrent.futures
import http.server
import json
import os
from pathlib import Path
import shutil
import signal
import ssl
import threading
import subprocess
import tempfile
import time
import tomllib
import urllib.request


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
    cert, key = work / "cert.pem", work / "key.pem"
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                    "-keyout", str(key), "-out", str(cert), "-days", "1",
                    "-subj", "/CN=localhost"], check=True, capture_output=True)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(cert, key)
    class Ready(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(503 if (work / "not-ready").exists() else 200)
            self.end_headers()
            self.wfile.write(b"[]")
        def log_message(self, *args):
            pass
    for port in (19500, 19501):
        readiness = http.server.ThreadingHTTPServer(("127.0.0.1", port), Ready)
        readiness.socket = tls.wrap_socket(readiness.socket, server_side=True)
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
    args[1:1] = ['--env', 'INNKEEPER_SCREEN_SIZE=640x480', '--env', 'INNKEEPER_KIOSK=1', '--env', 'INNKEEPER_STARTUP_COMMAND=stale']
    for i, arg in enumerate(args):
        if arg == '-p':
            args[i + 1] = '127.0.0.1::' + args[i + 1].rsplit(':', 1)[1]
os.execv('/usr/bin/docker', ['docker', *args])
""")
    wrapper.chmod(0o755)
    version = tomllib.loads((Path(__file__).resolve().parent.parent / "Cargo.toml").read_text())["package"]["metadata"]["elsewhere"]["version"]

    def package(distro, label):
        root = work / f"package-{distro}"
        shutil.rmtree(root, ignore_errors=True)
        (root / "usr/bin").mkdir(parents=True)
        binary = root / "usr/bin/elsewhere"
        binary.write_text(f"#!/bin/sh\nprintf '%s\\0' \"$@\" > \"$HOME/launch-args\"\necho {label} >> \"$HOME/launches\"\nexec sleep 10000\n")
        (root / "usr/local/bin").mkdir(parents=True)
        bus = root / "usr/local/bin/dbus-daemon"
        bus.write_text("#!/bin/sh\necho unix:path=/tmp/fixture-bus\n")
        bus.chmod(0o755)
        binary.chmod(0o755)
        cache = data / "packages" / version / "x86_64" / distro
        cache.mkdir(parents=True, exist_ok=True)
        if distro == "arch":
            (root / ".PKGINFO").write_text(
                f"pkgname = elsewhere\npkgver = {version}-1\npkgdesc = Refresh fixture\n"
                "arch = x86_64\nbuilddate = 0\nsize = 100\nlicense = MIT\n"
            )
            path = cache / f"elsewhere-{version}-1-x86_64.pkg.tar.zst"
            run("tar", "--zstd", "-cf", str(path), "-C", str(root), ".PKGINFO", "usr")
        else:
            (root / "DEBIAN").mkdir()
            (root / "DEBIAN/control").write_text(
                f"Package: elsewhere\nVersion: {version}-1\nArchitecture: amd64\n"
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
               INNKEEPER_LISTEN="127.0.0.1:29300", INNKEEPER_DOCKER_HOST="127.0.0.1")
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

    try:
        wait(lambda: (data / "admin-token").exists())
        for distro in ("arch", "debian"):
            sid = api("/sessions", "POST", {"name": "Refresh " + distro,
                      "distribution": distro, "packages": []})["id"]
            created.append(sid)
            name = "innkeeper-" + sid
            wait(lambda: launched(sid, 1))
            # Simulate a legacy container with its installation marker, stale archives,
            # and an entrypoint which would fail if the manager didn't refresh it.
            run("docker", "exec", name, "sh", "-c",
                "touch /opt/innkeeper/elsewhere-installed; "
                "printf broken > /opt/innkeeper/old.deb; "
                "printf broken > /opt/innkeeper/old.pkg.tar.zst; "
                "printf 'exit 99\\n' > /opt/innkeeper/entrypoint.sh")
            api(f"/sessions/{sid}/stop", "POST")
            identity = run("docker", "inspect", name, "--format", "{{.Id}}")
            cached = package(distro, "refreshed")
            (tools / "no-base").touch()
            subprocess.run(["sh", str(source / "prepare.sh"), "https://example.invalid/package", str(cached), ""], env=env, check=True)
            api(f"/sessions/{sid}/start", "POST")
            wait(lambda: launched(sid, 2))
            assert run("docker", "inspect", name, "--format", "{{.Id}}") == identity
            assert run("docker", "exec", name, "cat", "/home/elsewhere/launches").splitlines() == ["first", "refreshed"]
            api(f"/sessions/{sid}/stop", "POST")
            # A cache miss invokes preparation. Failure must remain recoverable.
            cached.unlink()
            (recipes / "prepare.sh").write_text("echo 'Fixture download failure'\nexit 1\n")
            api(f"/sessions/{sid}/start", "POST")
            wait(lambda: state(sid)["status"] == "failed")
            assert run("docker", "inspect", name, "--format", "{{.State.Running}}") == "false"
            api(f"/sessions/{sid}/stop", "POST")
            assert state(sid)["status"] == "stopped"
            # Stop and immediately restart a blocked download. The old task must
            # neither start the container nor overwrite the new attempt's status.
            (recipes / "prepare.sh").write_text("echo 'Fixture waiting'\nexec sleep 60\n")
            api(f"/sessions/{sid}/start", "POST")
            wait(lambda: "Fixture waiting" in api(f"/sessions/{sid}/logs")["text"])
            api(f"/sessions/{sid}/stop", "POST")
            assert state(sid)["status"] == "stopped"
            package(distro, "recovered")
            api(f"/sessions/{sid}/start", "POST")
            wait(lambda: launched(sid, 3))
            assert run("docker", "exec", name, "cat", "/home/elsewhere/launches").splitlines()[-1] == "recovered"
            api(f"/sessions/{sid}/stop", "POST")
            cached.unlink()
            api(f"/sessions/{sid}/start", "POST")
            wait(lambda: "Fixture waiting" in api(f"/sessions/{sid}/logs")["text"])
            manager.send_signal(signal.SIGINT)
            manager.wait(timeout=10)
            manager = subprocess.Popen(["elsewhere-innkeeper"], env=env, stdout=log, stderr=log)
            def recovered_state():
                try:
                    return state(sid)["status"] == "failed"
                except OSError:
                    return False
            wait(recovered_state)
            api(f"/sessions/{sid}/stop", "POST")
            assert state(sid)["status"] == "stopped"
            package(distro, "after-interruption")
            api(f"/sessions/{sid}/start", "POST")
            wait(lambda: launched(sid, 4))
            assert not (tools / "image-attempt").exists()
            (tools / "no-base").unlink()
            wait(lambda: state(sid)["status"] == "running")
            private = next(s for s in json.loads((data / "state.json").read_text())["sessions"] if s["id"] == sid)
            run("docker", "exec", name, "sh", "-c", "echo retained > /root/settings-sentinel")
            # Legacy state has no snapshots. Its stored settings describe its last launch.
            manager.send_signal(signal.SIGINT)
            manager.wait(timeout=10)
            legacy = json.loads((data / "state.json").read_text())
            for session in legacy["sessions"]:
                if session["id"] == sid:
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
            assert launched(sid, 4)
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
            assert launched(sid, 4) and pending()
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
            wait(lambda: launched(sid, 5))
            assert pending() and state(sid)["status"] == "preparing"
            rejected(f"/sessions/{sid}/settings", "PUT", renamed, 409)
            (work / "not-ready").unlink()
            wait(lambda: state(sid)["status"] == "running" and not pending())
            assert launched(sid, 5)
            args = subprocess.check_output(["docker", "exec", name, "cat", "/home/elsewhere/launch-args"]).decode().split("\0")[:-1]
            assert args == ["--listen", "0.0.0.0:19443", "--rtc-port", "19443", "--elements",
                            "--screen-size", "1280x720", "--kiosk", "--exec", command], args
            run("docker", "exec", name, "test", "!", "-e", "/tmp/unexpected")
            assert run("docker", "inspect", name, "--format", "{{.Id}}") == identity
            current = next(s for s in json.loads((data / "state.json").read_text())["sessions"] if s["id"] == sid)
            assert all(current[k] == private[k] for k in ("id", "port", "token", "viewer_token"))
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
                assert args == ["--listen", "0.0.0.0:19443", "--rtc-port", "19443", "--elements"]
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
            print(f"{distro}: first install, refresh, legacy entrypoint, failed download retry, cancellation retry, manager interruption, no base-image lookup passed", flush=True)
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
