# Browser Wayland Manager

A separate Rust/Axum and React/Vite application that creates and manages browser-wayland desktops in Docker. Choose Arch Linux or Debian, add package names, and open a ready desktop in a new tab. List and grid views show authenticated desktop previews. Each session has live image-build, setup, and runtime logs.

## Run with Docker Compose

```sh
docker compose up -d --build
docker compose exec manager cat /var/lib/browser-wayland-manager/admin-token
```

Open `http://localhost:19300` and sign in with that token. The manager generates it once and saves it with mode `0600` in its private data directory. Compose retains manager state in `manager-data` and mounts the Docker socket. Session home directories use separate Docker named volumes, managed by the application.

The first session for a distribution builds its image. This can take several minutes and requires internet access, several gigabytes of disk space, and a Docker daemon with BuildKit. Open **Logs** to follow the build. Later sessions reuse the image. You can also prepare both images with `./scripts/build-sessions`.

Session links use HTTPS and the existing `#token=…` convention. Each session generates a self-signed certificate; accept it when opening that session. WebCodecs needs a secure browser context. The manager uses its viewer token for previews and keeps tokens out of URLs used for API requests and out of returned logs.

## Network configuration

The manager listens on port `19300`. Sessions publish matching TCP and UDP ports from `19500` through `19999`, forwarding to container port `19443`. Docker rejects occupied ports, and the failed session remains available for cleanup. Each retained session reserves its port until destruction.

| Variable | Native default | Purpose |
| --- | --- | --- |
| `BWM_LISTEN` | `127.0.0.1:19300` | Manager HTTP listen address |
| `BWM_PUBLIC_HOST` | `localhost` | Browser-reachable hostname used in session links |
| `BWM_DOCKER_HOST` | `127.0.0.1` | Address where the backend reaches published session ports |
| `BWM_SESSION_BIND` | `127.0.0.1` | Host address on which Docker publishes session ports |
| `BWM_DATA_DIR` | `/var/lib/browser-wayland-manager` | Private manager state, administrator token, build logs |
| `BWM_ASSETS_DIR` | `/usr/share/browser-wayland-manager` | Session recipes and build scripts |

Compose binds the manager to host loopback, publishes session ports on all host interfaces, and uses `host.docker.internal:host-gateway` for backend access. For remote browsers, set `BWM_PUBLIC_HOST` to the Docker host's reachable hostname and expose the manager through an HTTPS reverse proxy. Forward both TCP and UDP session ports when using NAT. One manager controls one local Linux Docker daemon; remote Docker daemons and rootless Docker are not currently supported.

Management access grants Docker control. Treat the administrator token and Docker socket as host-administrator credentials. The service stores session tokens in a private `state.json`; back up the complete manager data directory together with session volumes. The frontend retains the administrator token only in the tab's session storage. No cross-origin API access is enabled.

## Session lifecycle

Creation validates package names, records the session, prepares a distribution-specific image if needed, creates a labeled volume and container, and seeds distinct 64-character hexadecimal control and viewer tokens. Inside the container, setup prepares the user and runtime directories, a separate script installs requested packages, the binary and license assets are copied into place, and browser-wayland starts. The manager publishes an Open action only after an authenticated readiness request succeeds.

Runtime dependencies are installed by each distribution's setup script at image-build time. Arch and Debian compile browser-wayland independently against their own libraries. Image builds check shared-library resolution with `ldd`; the binary embeds its React viewer. Each base includes xterm as a terminal, including sessions created with no extra packages. Sessions use software rendering and encoding, so GPU device mounts are not required.

An empty package list is valid. Package names cannot contain shell syntax, whitespace, paths, version expressions, or leading-dash options. Failed installations stop startup and expose their stage and output in Logs. Setup stages time out after 30 minutes; launch readiness times out after two minutes; image builds time out after two hours. A failed session remains available for Stop and Destroy.

**Stop** terminates the container while retaining the complete session home directory. **Start** relaunches a stopped session with the same tokens and data. **Destroy** removes the owned container, home volume, and manager build log. It permanently deletes that session's data. Shared distribution images and Docker's build cache remain available for reuse. Remove obsolete image tags individually with `docker image rm <exact-tag>` after checking that no retained container uses them; the manager never prunes shared Docker resources. Cancelling a session during image preparation terminates that build process group. A cancelled build has no desktop to restart; destroy its record and create a new session.

Manager restarts preserve sessions. The manager inspects its recorded containers and reconciles exits and readiness; an interrupted image build becomes a visible failure that can be destroyed and recreated. Container and volume deletion require a matching persistent owner label, and cleanup never uses global pruning or name-prefix deletion.

Previews use the shared screenshot API with a width in device pixels, preserving aspect ratio. Visible sessions refresh every five seconds, with at most two requests in flight. Hidden tabs and offscreen previews pause. The backend also limits captures to two concurrent requests and one request per session every two seconds. Unavailable previews leave the session controls usable.

The Logs dialog polls without overlapping requests. It shows the last 128 KiB of image-build output and the last 1,000 Docker log lines. Docker logs rotate at 10 MiB, with three files retained. Exact session tokens are redacted before output reaches the browser, and startup token fragments are redacted before Docker persists them.

## Supported session images

The current Docker rig and packages target x86_64 Linux.

- Arch Linux `archlinux:base`, rolling repositories as of the image build.
- Debian 13 `debian:trixie-slim`, Trixie repositories.

The browser-wayland source revision is pinned in `sessions/revision`. Builds clone that exact revision into a temporary directory, without using or modifying another working checkout. `sessions/recipe-version` versions this application's image recipe; increment it when changing session scripts or the session Dockerfile so existing installations rebuild. Tags include distribution, upstream revision, and recipe version. Distribution tags and package repositories receive upstream updates; rebuilding is not bit-for-bit reproducible.

The upstream binary embeds an audio visualizer with AGPL-3.0-or-later licensing. Session images include its `THIRD_PARTY.txt` notice. The pinned upstream source and its build instructions are available at `https://github.com/ryanpetris/browser-wayland`; the manager's own code uses the accompanying MIT license.

## Arch Linux and Debian packages

Build installable packages entirely in Docker:

```sh
./scripts/build-packages
```

Packages appear in `dist/`. Install with `pacman -U dist/*.pkg.tar.zst` on Arch, or `apt install ./dist/*.deb` on Debian 13. The package creates a dedicated service account, installs the session recipes, and provides a systemd service. Docker must be running. Enable the manager explicitly:

```sh
sudo systemctl enable --now docker browser-wayland-manager
sudo cat /var/lib/browser-wayland-manager/admin-token
```

Edit `/etc/browser-wayland-manager/environment` to configure native installations and restart the service. Restart `browser-wayland-manager` after every native package upgrade; creation refuses mismatched recipes until the running binary is updated. The account receives access to Docker through its supplementary `docker` group. Package build recipes are in `packaging/PKGBUILD` and `packaging/debian/`. The Docker package builder is the supported packaging path and requires network access for Cargo and npm dependencies; it does not produce an offline Debian buildd source package. Native source builds require Rust with edition 2024 support and Node.js 24.

## Development

```sh
docker build --target check .
./scripts/build-sessions
```
