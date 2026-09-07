#!/usr/bin/env python3
"""Check certificate generation, persistence, HTTPS and explicit TLS settings in Docker."""
from contextlib import contextmanager
import hashlib
import http.client
import os
from pathlib import Path
import socket
import ssl
import stat
import subprocess
import tempfile
import time

binary = os.environ.get("INNKEEPER_BINARY", "elsewhere-innkeeper")

with tempfile.TemporaryDirectory(prefix="innkeeper-tls-") as temporary:
    work = Path(temporary)
    data = work / "data"
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base = dict(os.environ, INNKEEPER_DATA_DIR=str(data), INNKEEPER_IN_DOCKER="0",
                INNKEEPER_DOCKER_CONTAINER="", INNKEEPER_DOCKER_NETWORK="",
                INNKEEPER_RTC_ADDR="", INNKEEPER_TLS="1", INNKEEPER_TLS_CERT="",
                INNKEEPER_TLS_KEY="", INNKEEPER_LISTEN=f"127.0.0.1:{port}")
    base.pop("INNKEEPER_LOCAL_ELSEWHERE", None)

    @contextmanager
    def running(**settings):
        with tempfile.TemporaryFile(mode="w+") as log:
            process = subprocess.Popen([binary], env=dict(base, **settings), stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 15
                while True:
                    log.seek(0)
                    output = log.read()
                    if "listening on" in output:
                        try:
                            with socket.create_connection(("127.0.0.1", port), timeout=1):
                                break
                        except OSError:
                            pass
                    assert process.poll() is None, output
                    assert time.monotonic() < deadline, output
                    time.sleep(0.05)
                yield output
            finally:
                process.terminate()
                process.wait(timeout=10)

    def request(cert=None, hostname="localhost"):
        if cert:
            context = ssl.create_default_context(cafile=str(cert))
            context.set_alpn_protocols(["h2", "http/1.1"])
            connection = http.client.HTTPSConnection(hostname, port, context=context, timeout=5)
            connection.connect()
            assert connection.sock.selected_alpn_protocol() == "http/1.1"
        else:
            connection = http.client.HTTPConnection(hostname, port, timeout=5)
        try:
            connection.request("GET", "/")
            response = connection.getresponse()
            assert response.status == 200
            assert b"<html" in response.read()
        finally:
            connection.close()

    def rejected(message, **settings):
        result = subprocess.run([binary], env=dict(base, **settings), capture_output=True, text=True, timeout=15)
        assert result.returncode != 0, result.stdout
        assert message in result.stderr, result.stderr

    cert, key = data / "cert.pem", data / "key.pem"
    with running() as output:
        saved = cert.read_bytes(), key.read_bytes()
        for path in (cert, key):
            assert stat.S_IMODE(path.stat().st_mode) == 0o600
        digest = hashlib.sha256(ssl.PEM_cert_to_DER_cert(cert.read_text())).hexdigest().upper()
        assert ":".join(digest[i:i+2] for i in range(0, len(digest), 2)) in output
        request(cert)
        request(cert, "127.0.0.1")
    with running():
        assert saved == (cert.read_bytes(), key.read_bytes())
        request(cert)
    for unreadable in (cert, key):
        unreadable.chmod(0)
        try:
            rejected("Read saved HTTPS certificate or key")
        finally:
            unreadable.chmod(0o600)
        assert saved == (cert.read_bytes(), key.read_bytes())
    for missing in (cert, key):
        missing.unlink()
        with running():
            assert saved[0] != cert.read_bytes() and saved[1] != key.read_bytes()
            request(cert)
            saved = cert.read_bytes(), key.read_bytes()

    custom_cert, custom_key = work / "custom.pem", work / "custom-key.pem"
    custom_cert.write_bytes(saved[0])
    custom_key.write_bytes(saved[1])
    cert.write_text("invalid certificate")
    rejected("Parse HTTPS certificate", INNKEEPER_TLS="1")
    assert cert.read_text() == "invalid certificate"
    with running(INNKEEPER_TLS_CERT=str(custom_cert), INNKEEPER_TLS_KEY=str(custom_key)):
        request(custom_cert)
        assert cert.read_text() == "invalid certificate"
    rejected("Set both", INNKEEPER_TLS_CERT=str(custom_cert))
    rejected("Read HTTPS key", INNKEEPER_TLS_CERT=str(custom_cert), INNKEEPER_TLS_KEY=str(work / "missing"))
    rejected("INNKEEPER_TLS must be 0 or 1", INNKEEPER_TLS="invalid")
    with running(INNKEEPER_TLS="0"):
        request()
    assert not (work / "http-data").exists()
    with running(INNKEEPER_TLS="0", INNKEEPER_DATA_DIR=str(work / "http-data")):
        request()
        assert not (work / "http-data" / "cert.pem").exists()

print("PASS: generated HTTPS, fingerprint, permissions, SANs, HTTP/1.1, persistence, partial-pair recovery, explicit TLS and HTTP")
