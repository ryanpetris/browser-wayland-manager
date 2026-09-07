#!/usr/bin/env python3
"""Exercise HTTP, TLS, WebSocket and Docker routing in the Docker verification rig.

Run with Python, OpenSSL, the Docker CLI/socket available.
The rig image must also contain this script and an `elsewhere` token fixture.
"""
import base64
import concurrent.futures
import hashlib
import http.client
import http.server
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import uuid
from sqlite_fixture import seed

TOKEN = "opaque+/=?%:token"


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def backend():
    prefix = "/e/" + os.environ["SESSION_ID"]

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        closed_stalls = 0

        def log_message(self, *args):
            pass

        def do_GET(self):
            if not self.path.startswith(prefix):
                self.send_error(404)
                return
            if self.path == prefix:
                self.send_response(308)
                self.send_header("Location", prefix + "/")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if self.headers.get("Authorization") != "Bearer " + TOKEN:
                self.send_error(401)
                return
            if self.path.endswith("/stall"):
                self.connection.settimeout(45)
                if self.connection.recv(1) == b"":
                    Handler.closed_stalls += 1
                self.close_connection = True
                return
            if self.path.endswith("/ws"):
                key = self.headers["Sec-WebSocket-Key"]
                accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
                self.send_response(101)
                self.send_header("Connection", "Upgrade")
                self.send_header("Upgrade", "websocket")
                self.send_header("Sec-WebSocket-Accept", accept)
                self.send_header("Sec-WebSocket-Protocol", "fixture")
                self.end_headers()
                while True:
                    head = self.rfile.read(2)
                    if not head:
                        break
                    mask = self.rfile.read(4)
                    payload = self.rfile.read(head[1] & 127)
                    payload = bytes(c ^ mask[i % 4] for i, c in enumerate(payload))
                    opcode = head[0] & 15
                    self.wfile.write(bytes([0x80 | (10 if opcode == 9 else opcode), len(payload)]) + payload)
                    self.wfile.flush()
                    if opcode == 8:
                        break
                self.close_connection = True
                return
            if self.path.endswith("/stream"):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                for chunk in (b"first\n", b"last\n"):
                    self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                    self.wfile.flush()
                    if chunk == b"first\n":
                        time.sleep(9)
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
                return
            body = json.dumps({"path": self.path, "session": os.environ["SESSION_ID"],
                               "leaked": self.headers.get("X-Remove-Me"),
                               "forwarded": self.headers.get("Forwarded"), "closed_stalls": Handler.closed_stalls}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "X-Remove-Response")
            self.send_header("X-Remove-Response", "private")
            self.send_header("Service-Worker-Allowed", "/")
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            response = hashlib.sha256(body).hexdigest().encode()
            self.send_response(201)
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

    http.server.ThreadingHTTPServer(("0.0.0.0", 19443), Handler).serve_forever()


def check():
    context = ssl._create_unverified_context()
    plain = os.environ.get("PROXY_TEST_HTTP") == "1"
    def connect():
        return http.client.HTTPConnection("127.0.0.1", 29300, timeout=40) if plain else http.client.HTTPSConnection("127.0.0.1", 29300, context=context, timeout=40)
    image = os.environ.get("PROXY_RIG_IMAGE", "innkeeper-proxy-rig")
    docker_mode = os.environ.get("INNKEEPER_IN_DOCKER") == "1"
    network = os.environ.get("PROXY_TEST_NETWORK", "bridge")
    created = []
    manager = None
    existing = run("docker", "ps", "-q").split()
    used_ports = {int(binding["HostPort"])
                  for info in (json.loads(run("docker", "inspect", *existing)) if existing else [])
                  for bindings in info["NetworkSettings"]["Ports"].values()
                  for binding in (bindings or [])}
    available_ports = iter(port for port in range(19999, 19499, -1) if port not in used_ports)
    with tempfile.TemporaryDirectory(prefix="innkeeper-proxy-") as temporary:
        work = Path(temporary)
        owner = str(uuid.uuid4())
        sessions = []
        try:
            for index in range(2):
                sid = str(uuid.uuid4())
                port = next(available_ports)
                name = "innkeeper-" + sid
                args = ["docker", "run", "-d", "--name", name, "--label", "io.innkeeper.owner=" + owner,
                        "--network", network, "-e", "SESSION_ID=" + sid, "-p", f"0.0.0.0:{port}:{port}/udp"]
                if not docker_mode:
                    args += ["-p", f"127.0.0.1:{port}:19443/tcp"]
                created.append(name)
                run(*args, "--entrypoint", "python3", image, "/check-proxy.py", "backend")
                info = json.loads(run("docker", "inspect", name))[0]
                bindings = info["HostConfig"]["PortBindings"]
                if docker_mode:
                    assert "19443/tcp" not in bindings
                else:
                    assert bindings["19443/tcp"] == [{"HostIp": "127.0.0.1", "HostPort": str(port)}]
                sessions.append(dict(id=sid, name="Proxy fixture", distribution="debian", packages=[],
                                     port=port, status="running", stage="launch", error=None))
            data = work / "data"
            data.mkdir()
            seed(data, sessions, owner)
            cert, key = work / "cert.pem", work / "key.pem"
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                            "-subj", "/CN=localhost", "-keyout", str(key), "-out", str(cert)],
                           check=True, capture_output=True)
            env = dict(os.environ, INNKEEPER_DATA_DIR=str(data), INNKEEPER_LISTEN="127.0.0.1:29300",
                       INNKEEPER_TLS_CERT="" if plain else str(cert), INNKEEPER_TLS_KEY="" if plain else str(key))
            log = (work / "manager.log").open("w+")
            manager = subprocess.Popen(["elsewhere-innkeeper"], env=env, stdout=log, stderr=log)

            def request(path, method="GET", body=None, headers=None):
                connection = connect()
                connection.request(method, path, body=body, headers=headers or {})
                response = connection.getresponse()
                payload = response.read()
                result = response.status, dict(response.getheaders()), payload
                connection.close()
                return result

            for _ in range(100):
                if manager.poll() is not None:
                    raise AssertionError(log.read())
                try:
                    if request("/")[0] == 200:
                        break
                except OSError:
                    time.sleep(.1)
            else:
                raise AssertionError("Manager did not start")
            admin = {"Authorization": "Bearer " + (data / "admin-token").read_text().strip()}
            headers = {"Authorization": "Bearer " + TOKEN}
            assert request("/api/sessions")[0] == 401
            assert request("/api/sessions", headers=admin)[0] == 200
            for session in sessions:
                prefix = "/e/" + session["id"]
                assert request(prefix)[0] == 308
                assert json.loads(request(prefix + "/", headers=headers)[2])["session"] == session["id"]
                assert request(prefix + "/api/windows")[0] == 401
                status, response_headers, body = request(prefix + "/api/windows?q=a%2Fb&x=1", headers={**headers,
                    "Connection": "X-Remove-Me", "X-Remove-Me": "private", "Forwarded": "host=evil"})
                parsed = json.loads(body)
                assert status == 200 and parsed["session"] == session["id"]
                assert parsed["path"] == prefix + "/api/windows?q=a%2Fb&x=1"
                assert parsed["leaked"] is None and parsed["forwarded"] is None
                assert "X-Remove-Response" not in response_headers
                assert "Service-Worker-Allowed" not in response_headers
                status, _, body = request("/api/sessions/" + session["id"] + "/link", "POST", headers=admin)
                assert status == 200 and json.loads(body)["url"].startswith(prefix + "/#token=")
            prefix = "/e/" + sessions[0]["id"]
            with concurrent.futures.ThreadPoolExecutor(max_workers=32) as pool:
                statuses = list(pool.map(lambda _: request(prefix + "/api/windows", headers=headers)[0], range(32)))
            assert statuses == [200] * 32, statuses
            payload = b"test" * (256 * 1024)
            status, _, body = request(prefix + "/upload", "POST", payload, headers)
            assert status == 201 and body.decode() == hashlib.sha256(payload).hexdigest()
            assert request("/e/not-a-uuid/ws")[0] == 404
            assert request("/e/" + str(uuid.uuid4()) + "/ws")[0] == 404
            connection = connect()
            started = time.monotonic()
            connection.request("GET", prefix + "/stream", headers=headers)
            response = connection.getresponse()
            assert response.read(6) == b"first\n" and time.monotonic() - started < 3
            assert response.read() == b"last\n"
            connection.close()
            sock = socket.create_connection(("127.0.0.1", 29300))
            if not plain:
                sock = context.wrap_socket(sock, server_hostname="localhost")
            sock.settimeout(15)
            sock.sendall((f"GET {prefix}/ws HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {TOKEN}\r\n"
                          "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n"
                          "Sec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\nSec-WebSocket-Protocol: fixture\r\n\r\n").encode())
            stream = sock.makefile("rb")
            handshake = b""
            while not handshake.endswith(b"\r\n\r\n"):
                handshake += stream.read(1)
            assert b"101 Switching Protocols" in handshake and b"fixture" in handshake
            for opcode, value, expected in [(2, b"\x00\xffbinary", 2), (9, b"ping", 10), (8, b"\x03\xe8", 8)]:
                mask = b"abcd"
                sock.sendall(bytes([0x80 | opcode, 0x80 | len(value)]) + mask + bytes(c ^ mask[i % 4] for i,c in enumerate(value)))
                assert stream.read(2) == bytes([0x80 | expected, len(value)])
                assert stream.read(len(value)) == value
            stream.close()
            sock.close()
            if os.environ.get("PROXY_TEST_TIMEOUTS") == "1":
                started = time.monotonic()
                assert request(prefix + "/stall", headers=headers)[0] == 504
                assert time.monotonic() - started < 40
                for _ in range(30):
                    if json.loads(request(prefix + "/status", headers=headers)[2])["closed_stalls"] > 0:
                        break
                    time.sleep(.1)
                else:
                    raise AssertionError("Timed-out upstream socket remained open")
                print("PASS: stalled response times out and closes upstream", flush=True)
                def chunks():
                    for _ in range(10):
                        yield b"x" * 65536
                        time.sleep(4)
                connection = connect()
                connection.request("POST", prefix + "/upload", body=chunks(), headers={**headers, "Content-Length": str(10 * 65536)})
                response = connection.getresponse()
                assert response.status == 201 and response.read().decode() == hashlib.sha256(b"x" * 655360).hexdigest()
                connection.close()
                print("PASS: active upload longer than response timeout", flush=True)
            run("docker", "stop", "--time", "1", created[0])
            assert request(prefix + "/api/windows", headers=headers)[0] == 503
            run("docker", "start", created[0])
            for _ in range(50):
                if request(prefix + "/api/windows", headers=headers)[0] == 200:
                    break
                time.sleep(.1)
            else:
                raise AssertionError("Restart routing failed")
            # An existing registry record does not authorize a foreign container.
            run("docker", "rm", "-f", created[0])
            run("docker", "run", "-d", "--name", created[0], "--network", network,
                "--entrypoint", "sleep", image, "60")
            assert request(prefix + "/api/windows", headers=headers)[0] == 503
            print("PASS: " + ("HTTP" if plain else "TLS") + ", authenticated routing, two sessions, headers/query, upload, streaming >8s, binary WebSocket/ping/close, restart; mode=" + ("docker " + network if docker_mode else "native"), flush=True)
        finally:
            if manager is not None:
                manager.terminate()
                manager.wait(timeout=10)
                if sys.exc_info()[0]:
                    print((work / "manager.log").read_text())
            for name in created:
                subprocess.run(["docker", "rm", "-f", "-v", name], capture_output=True)


if __name__ == "__main__":
    if sys.argv[1:2] == ["token"]:
        print(TOKEN)
    else:
        backend() if sys.argv[1:] == ["backend"] else check()
