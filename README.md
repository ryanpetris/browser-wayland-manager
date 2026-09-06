# Elsewhere Innkeeper

A separate Rust/Axum and React/Vite application that creates and manages Elsewhere desktops in Docker. Choose Arch Linux or Debian, add package names, and open a ready desktop in a new tab. List and grid views show authenticated desktop previews. Each session has live download, setup, and runtime logs.

## Run with Docker Compose

```sh
docker compose up -d --build
docker compose exec innkeeper cat /var/lib/elsewhere-innkeeper/admin-token
```

Open `http://<server-hostname>:19300` and sign in with that token. Innkeeper generates it once and saves it with mode `0600` in its private data directory. Compose retains Innkeeper state in `innkeeper-data` and mounts the Docker socket. Session home directories use separate Docker named volumes, managed by the application.

Innkeeper downloads the pinned Elsewhere release package from GitHub and caches it in its data directory. It pulls a stock distribution image if needed, then installs the package and its dependencies inside each new container. Open **Logs** to follow downloads and setup. Innkeeper does not clone or compile Elsewhere at runtime.

Session links use HTTPS and the existing `#token=…` convention. Each session generates a self-signed certificate; accept it when opening that session. WebCodecs needs a secure browser context. Innkeeper uses its viewer token for previews and keeps tokens out of URLs used for API requests and out of returned logs.

## Network configuration

Innkeeper listens on port `19300`. Sessions publish matching TCP and UDP ports from `19500` through `19999`, forwarding to container port `19443`. Docker rejects occupied ports, and the failed session remains available for cleanup. Each retained session reserves its port until destruction.

| Variable | Native default | Purpose |
| --- | --- | --- |
| `INNKEEPER_LISTEN` | `0.0.0.0:19300` | Innkeeper HTTP listen address |
| `INNKEEPER_PUBLIC_HOST` | Empty | Override the browser hostname used in session links |
| `INNKEEPER_DOCKER_HOST` | `127.0.0.1` | Address where the backend reaches published session ports |
| `INNKEEPER_SESSION_BIND` | `0.0.0.0` | Host address on which Docker publishes session ports |
| `INNKEEPER_DATA_DIR` | `/var/lib/elsewhere-innkeeper` | Private Innkeeper state, administrator token, build logs |
| `INNKEEPER_ASSETS_DIR` | `/usr/share/elsewhere-innkeeper` | Session setup scripts and pinned Elsewhere version |

The native application and session ports bind all IPv4 interfaces by default. Compose publishes Innkeeper's port on the addresses supported by the Docker daemon. Desktop links use the hostname or IP address in the browser's Innkeeper URL, with the session's HTTPS port. Set `INNKEEPER_PUBLIC_HOST` to override that hostname. When a reverse proxy runs on another machine, set it to the Docker host's browser-reachable address unless the proxy also forwards the session ports. IPv6 literal overrides must include brackets, for example `[2001:db8::1]`; IPv6 links also require Docker to publish the session ports over IPv6. Compose uses `host.docker.internal:host-gateway` for backend access, independently of browser links. Use an HTTPS reverse proxy to protect management traffic on untrusted networks. To restrict management access to the local machine, change the Compose port mapping to `127.0.0.1:19300:19300`, or set `INNKEEPER_LISTEN=127.0.0.1:19300` for a native installation. For a native installation, `INNKEEPER_SESSION_BIND=127.0.0.1` also restricts desktop ports to loopback. Forward both TCP and UDP session ports when using NAT. One Innkeeper controls one local Linux Docker daemon; remote Docker daemons and rootless Docker are not currently supported.

After changing Compose configuration, rebuild and recreate Innkeeper with `docker compose up -d --build`.

Management access grants Docker control. Treat the administrator token and Docker socket as host-administrator credentials. The service stores session tokens in a private `state.json`; back up the complete Innkeeper data directory together with session volumes. The frontend retains the administrator token only in the tab's session storage. No cross-origin API access is enabled.

## Session lifecycle

Creation validates package names, records the session, downloads a release package if it is not cached, and prepares a stock base image. It creates a labeled volume and container, then copies the setup scripts, package, and distinct 64-character hexadecimal control and viewer tokens into the stopped container through the Docker API. This also works when Innkeeper runs inside Docker; the source files are read from Innkeeper's filesystem.

Inside the session container, setup installs runtime services, prepares the user and runtime directories, and installs Elsewhere with `apt` or `pacman`. The package manager resolves the package's declared dependencies, including Debian recommendations. A separate script installs requested extra packages before Elsewhere starts. Innkeeper publishes an Open action only after an authenticated readiness request succeeds. Setup and installation markers allow stopped sessions to restart without reinstalling packages.

Both distributions include xterm for sessions with no extra packages. Sessions use hardware encoding when a supported GPU is available, and software encoding without a GPU. Release packages are assumed compatible with the selected distribution; Innkeeper does not perform a separate binary or shared-library compatibility check.

Sessions default to `GSK_RENDERER=ngl` to work around GTK 4 Vulkan rendering artifacts
and `QT_QPA_PLATFORM='wayland;xcb'` so Qt tries Wayland, then X11 when its Wayland
plugin is unavailable. These settings apply to Elsewhere and applications it launches,
including applications activated through the session bus. Values already set in the
session environment, including empty values, are preserved. Innkeeper's own environment
is not forwarded to session containers.

An empty package list is valid. Package names cannot contain shell syntax, whitespace, paths, version expressions, or leading-dash options. Failed installations stop startup and expose their stage and output in Logs. Setup stages time out after 30 minutes; launch readiness times out after two minutes; release download and base-image preparation time out after 30 minutes. A failed session remains available for Stop and Destroy.

**Stop** terminates the container while retaining the complete session home directory. **Start** relaunches a stopped session with the same tokens and data. **Destroy** removes the owned container, home volume, and Innkeeper preparation log. It permanently deletes that session's data. Shared base images and downloaded packages remain available for reuse. Remove obsolete image tags individually with `docker image rm <exact-tag>` after checking that no retained container uses them; Innkeeper never prunes shared Docker resources. Cancelling a session during download or base-image preparation terminates that preparation process group. A cancelled preparation has no desktop to restart; destroy its record and create a new session.

Innkeeper restarts preserve sessions. Innkeeper inspects its recorded containers and reconciles exits and readiness; an interrupted preparation becomes a visible failure that can be destroyed and recreated. Container and volume deletion require a matching persistent owner label, and cleanup never uses global pruning or name-prefix deletion.

Previews use the shared screenshot API with a width in device pixels, preserving aspect ratio. Visible sessions refresh every five seconds, with at most two requests in flight. Hidden tabs and offscreen previews pause. The backend also limits captures to two concurrent requests and one request per session every two seconds. Unavailable previews leave the session controls usable.

The Logs dialog polls without overlapping requests. It shows the last 128 KiB of download and image-pull output and the last 1,000 Docker log lines. Docker logs rotate at 10 MiB, with three files retained. Exact session tokens are redacted before output reaches the browser, and startup token fragments are redacted before Docker persists them.

## Supported session images

Release packages currently support x86_64 Docker hosts. Base images are reused locally; refresh them for future sessions with `docker pull archlinux:base` and `docker pull debian:trixie-slim`.

- Arch Linux `archlinux:base`, rolling repositories.
- Debian 13 `debian:trixie-slim`, Trixie repositories with `main`, `contrib`, `non-free`, and `non-free-firmware` enabled.

The Elsewhere release version is pinned in `sessions/elsewhere-version`. Innkeeper generates GitHub download URLs and package filenames from that single version using the release package naming convention. Packages are cached under `packages/<version>/x86_64/<distribution>/<asset>` in Innkeeper's data directory. Downloads use HTTPS and a temporary file renamed only after a successful transfer. Concurrent session creation shares the preparation lock and reuses completed downloads. Interrupted transfers are retried on the next request.

Update that version file and rebuild Innkeeper to change the pinned release. The new package downloads when first needed. Existing sessions retain their installed Elsewhere version. Cached packages survive Innkeeper upgrades and session destruction. Individually remove obsolete version directories from the cache when they are no longer needed; Innkeeper will download a missing package again. `sessions/recipe-version` versions the setup scripts; increment it when changing their behavior. Restart Innkeeper after updating its installed assets.

The release package supplies Elsewhere and its accompanying notices. Innkeeper's own code uses the accompanying MIT license.

## Arch Linux and Debian packages

Build installable packages entirely in Docker:

```sh
./scripts/build-packages
```

Packages appear in `dist/`. Install with `pacman -U dist/*.pkg.tar.zst` on Arch, or `apt install ./dist/*.deb` on Debian 13. The package creates a dedicated service account, installs the session recipes, and provides a systemd service. Docker must be running. Enable Innkeeper explicitly:

```sh
sudo systemctl enable --now docker elsewhere-innkeeper
sudo cat /var/lib/elsewhere-innkeeper/admin-token
```

Edit `/etc/elsewhere-innkeeper/environment` to configure native installations and restart the service. Restart `elsewhere-innkeeper` after every native package upgrade; creation refuses mismatched recipes until the running binary is updated. The account receives access to Docker through its supplementary `docker` group. Package build recipes are in `packaging/PKGBUILD` and `packaging/debian/`. The Docker package builder is the supported packaging path and requires network access for Cargo and npm dependencies; it does not produce an offline Debian buildd source package. Native source builds require Rust with edition 2024 support and Node.js 24.

## Development

```sh
docker build --target check .
```

The footer displays Innkeeper's own build version. Builds use `INNKEEPER_VERSION` when set, otherwise `git describe` from a `v`-prefixed Innkeeper tag, falling back to the Cargo package version when Git tags are unavailable. Docker includes Git metadata only in the build stage. Override the version with `docker build --build-arg INNKEEPER_VERSION=1.2.3 .`, `INNKEEPER_VERSION=1.2.3 docker compose up -d --build`, or `INNKEEPER_VERSION=1.2.3 ./scripts/build-packages`. Elsewhere's pinned release is independent of Innkeeper's version.

## Hardware encoding

New sessions use the host GPU for rendering and VA-API video encoding when
`/dev/dri/renderD128` is available to Innkeeper. The Compose file mounts
`/dev/dri` so Innkeeper can detect it, and Innkeeper passes GPU devices to
session containers. When running Innkeeper with `docker run`, also mount
`/dev/dri:/dev/dri:ro`. The Docker daemon must run on the same host.

Native installations detect the devices directly without additional configuration.
Session setup installs Intel and AMD VA-API and Vulkan drivers for encoding and
rendering, and grants the desktop user access to the device groups. Hosts without a render device use software rendering
and encoding. A GPU must support VA-API encoding to use the hardware path.
Existing sessions retain their original container configuration and startup scripts;
create a new session to use hardware encoding.

## Session profiles

In **New session**, expand **Import profile**, paste JSON, and choose **Apply profile**.
Review the settings and choose **Create session**. See [the 0 A.D. profile](profiles/0ad.json)
for a game that starts in kiosk mode at 1920 × 1080.

Profiles support `name`, `distribution` (`arch` or `debian`), `packages` (an array of
package names), `startup_command`, `screen_size`, and `kiosk`. Omitted fields use the
form defaults. Unknown fields are rejected. `screen_size` is `null` for dynamic sizing, or an object with `width`
and `height`, both even integers from 2 to 8192. Kiosk mode defaults to `false`.
The startup command runs through `sh -c` as the desktop user on each session start,
with the desktop's display and audio environment. An empty command starts no application.
Settings are saved with the session and retained when it is stopped and started.
