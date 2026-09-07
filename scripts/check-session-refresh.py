#!/usr/bin/env python3
"""Run in the Innkeeper Docker image with Python, zstd and the Docker socket.

Uses tiny real Arch/Debian packages and disposable sessions to check package refresh.
"""
import json
import os
from pathlib import Path
import shutil
import signal
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
    (recipes / "start.sh").write_text("exec elsewhere\n")
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
if args and args[0] == 'create':
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
        binary.write_text(f"#!/bin/sh\necho {label} >> \"$HOME/launches\"\nexec sleep 10000\n")
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
