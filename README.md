# Elsewhere Innkeeper

A separate Rust/Axum and React/Vite application that creates and manages Elsewhere desktops in Docker. Choose Arch Linux or Debian, add package names, and open a ready desktop in a new tab. List and grid views show authenticated desktop previews. Each session has live download, setup, and runtime logs.

## Run with Docker Compose

```sh
docker compose up -d --build
docker compose exec innkeeper cat /var/lib/elsewhere-innkeeper/admin-token
```

Open `http://<server-hostname>:19300` and sign in with that token. Innkeeper generates it once and saves it with mode `0600` in its private data directory. Compose retains Innkeeper state in `innkeeper-data` and mounts the Docker socket. Session home directories use separate Docker named volumes, managed by the application.

Innkeeper downloads the pinned Elsewhere release package from GitHub and caches it in its data directory. It pulls a stock distribution image if needed, then installs the package and its dependencies inside each new container. Open **Logs** to follow downloads and setup. Innkeeper does not clone or compile Elsewhere at runtime.

Sessions open at `/e/<session-uuid>/` on Innkeeper's origin. Serve that origin over HTTPS for WebCodecs and browser capture features. Set `INNKEEPER_TLS_CERT` and `INNKEEPER_TLS_KEY` to PEM files for Innkeeper to terminate TLS, or put Innkeeper behind an HTTPS gateway. Elsewhere serves plain HTTP privately; Innkeeper proxies HTTP and WebSockets. WebRTC uses a separate encrypted UDP connection directly to each session.

## Run the Docker Hub image

The published image supports Linux amd64. Replace `<namespace>` with the Docker Hub namespace:

```sh
docker run -d --name elsewhere-innkeeper --restart unless-stopped \
  -p 19300:19300 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /dev/dri:/dev/dri:ro \
  -v innkeeper-data:/var/lib/elsewhere-innkeeper \
  <namespace>/elsewhere-innkeeper:latest
docker exec elsewhere-innkeeper cat /var/lib/elsewhere-innkeeper/admin-token
```

Use `:X.Y.Z` to select a specific Innkeeper release. Every release pushes both its version tag and
`latest`; `latest` points to whichever release most recently pushed that tag. The network and HTTPS
configuration below applies to the published image too.

## Network configuration

Innkeeper listens on port `19300`. Each session reserves a port from `19500` through `19999` until destruction, including while stopped. WebRTC publishes `0.0.0.0:P:P/udp`. Open or forward that UDP range without changing port numbers. WebRTC uses the hostname in the browser URL with the session’s assigned UDP port. That hostname must resolve to a reachable address from inside the session container; set `INNKEEPER_RTC_ADDR` only to override it. Docker rejects occupied ports; the failed session remains available for cleanup. WebSocket video remains available when UDP connectivity fails.

| Variable | Default | Purpose |
| --- | --- | --- |
| `INNKEEPER_LISTEN` | `0.0.0.0:19300` | Innkeeper HTTP or HTTPS listen address |
| `INNKEEPER_RTC_ADDR` | Browser hostname | Optional reachable IPv4 address override for WebRTC |
| `INNKEEPER_IN_DOCKER` | `0` native, `1` in image | Reach sessions through a shared Docker bridge |
| `INNKEEPER_DOCKER_CONTAINER` | Container hostname | Innkeeper container name or ID for Docker inspection |
| `INNKEEPER_DOCKER_NETWORK` | Discover one attached bridge | Select an attached bridge by name or ID when there are several |
| `INNKEEPER_TLS_CERT` | Empty | PEM certificate chain; enables HTTPS together with the key |
| `INNKEEPER_TLS_KEY` | Empty | PEM private key |
| `INNKEEPER_DATA_DIR` | `/var/lib/elsewhere-innkeeper` | Private state, administrator token, build logs |
| `INNKEEPER_ASSETS_DIR` | `/usr/share/elsewhere-innkeeper` | Session setup scripts |

In Docker mode, Innkeeper discovers its own bridge network through Docker inspection and attaches new sessions to that network. Their HTTP ports are not published. Requests use each owned container's current IP and port `19443`, so both the default bridge and custom networks work without container-name DNS. Peers on that bridge can reach session HTTP; Elsewhere authenticates its API and WebSockets. If the container has a custom hostname, set `INNKEEPER_DOCKER_CONTAINER` to its Docker name or ID. The CLI equivalents are `--in-docker`, `--docker-container NAME_OR_ID`, and `--docker-network NAME_OR_ID`.

Native Innkeeper publishes session HTTP at `127.0.0.1:P:19443/tcp` and connects through loopback. One Innkeeper controls one local Linux Docker daemon. Remote daemons, rootless Docker, and changing an installation between native and Docker modes are unsupported. Start uses the container's existing Docker configuration.

For HTTPS in Compose, mount the certificate directory read-only and set both TLS variables in a Compose override. For example:

```yaml
services:
  innkeeper:
    environment:
      INNKEEPER_TLS_CERT: /run/innkeeper-tls/fullchain.pem
      INNKEEPER_TLS_KEY: /run/innkeeper-tls/key.pem
    volumes:
      - ./tls:/run/innkeeper-tls:ro
```

Restart Innkeeper after renewing certificates. An external HTTPS gateway must connect to Innkeeper using HTTP/1.1 and forward the complete path, authorization, WebSocket upgrades and streaming bodies. Session links use the browser's origin; no public-host override is needed. URL prefixes keep Elsewhere preferences and tokens separate but do not isolate applications within the browser origin.

After changing Compose configuration, rebuild and recreate Innkeeper with `docker compose up -d --build`.

Management access grants Docker control. Treat the administrator token and Docker socket as host-administrator credentials. Elsewhere owns session credentials in each session home volume. Innkeeper retrieves them on demand and does not store copies in the SQLite database. Back up the complete Innkeeper data directory together with session volumes. The frontend retains the administrator token only in the tab's session storage. No cross-origin API access is enabled.

Session state lives in `state.sqlite3` inside the data directory. SQLite stores sessions, launch
settings, package lists, ordered Docker options, timings, and the ownership ID in relational tables.
Each session update is transactional. The database uses WAL with full synchronization; the data directory is private and
the database is readable only by its owner.

Schema migrations are embedded in the binary and applied by `rusqlite_migration` before Innkeeper
starts serving requests. Startup fails on migration errors or a schema newer than the binary
supports. Add schema changes as new migrations; published migrations keep their original contents
and ordering. The migration library owns SQLite's `user_version` field.

Stop Innkeeper before copying its data directory for a backup or restore. Keep the database and any
`state.sqlite3-wal` and `state.sqlite3-shm` files together, along with session volumes. Restoring the
ownership ID together with its sessions preserves Docker ownership checks.

## Session lifecycle

Creation validates package names, records the session, downloads a release package if it is not cached, and prepares a stock base image. It creates a labeled volume and container, then copies the setup scripts and package into the stopped container through the Docker API. This also works when Innkeeper runs inside Docker; the source files are read from Innkeeper's filesystem.

Inside the session container, setup installs runtime services, prepares the user and runtime directories, and installs Elsewhere with `apt` or `pacman`. The package manager resolves the package's declared dependencies, including Debian recommendations. A separate script installs requested extra packages before Elsewhere starts. Elsewhere generates its own credentials on first launch. Innkeeper runs `elsewhere token` and `elsewhere token --viewer` as the desktop user when credentials are needed. Session packages must provide these commands and the `--url-prefix`, `--no-tls`, `--rtc-addr`, and `--rtc-port` launch flags. Innkeeper treats their output as opaque text. The session stays preparing until both commands succeed and an authenticated readiness request succeeds. Setup and installation markers allow stopped sessions to restart without reinstalling packages.

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

The Logs dialog polls without overlapping requests. It shows the last 128 KiB of download and image-pull output and the last 1,000 Docker log lines. Docker logs rotate at 10 MiB, with three files retained. Token-bearing URL fragments and the rest of their line are redacted before output reaches the browser and before Docker persists desktop output. Current tokens are also redacted verbatim when their commands are available. Token-command diagnostics are never returned to the browser.

## Supported session images

Release packages currently support x86_64 Docker hosts. Base images are reused locally; refresh them for future sessions with `docker pull archlinux:base` and `docker pull debian:trixie-slim`.

- Arch Linux `archlinux:base`, rolling repositories.
- Debian 13 `debian:trixie-slim`, Trixie repositories with `main`, `contrib`, `non-free`, and `non-free-firmware` enabled.

The Elsewhere release version is pinned in `package.metadata.elsewhere.version` in `Cargo.toml` and embedded in the application at build time. Innkeeper generates GitHub download URLs and package filenames from that single version using the release package naming convention. Packages are cached under `packages/<version>/x86_64/<distribution>/<asset>` in Innkeeper's data directory. Downloads use HTTPS and a temporary file renamed only after a successful transfer. Concurrent session creation shares the preparation lock and reuses completed downloads. Interrupted transfers are retried on the next request.

Update that metadata field in `Cargo.toml` and rebuild Innkeeper to change the pinned release. The new package downloads during creation or an explicit upgrade, when first needed. Existing sessions retain their installed Elsewhere version. Cached packages survive Innkeeper upgrades and session destruction. Individually remove obsolete version directories from the cache when they are no longer needed; Innkeeper will download a missing package again. Restart Innkeeper after updating its installed assets.

The release package supplies Elsewhere and its accompanying notices. Innkeeper's own code uses the accompanying MIT license.

## Arch Linux and Debian packages

Release packages are attached to `vX.Y.Z` GitHub releases. Install the downloaded package
with `pacman -U ./elsewhere-innkeeper-*.pkg.tar.zst` on Arch or
`apt install ./elsewhere-innkeeper_*.deb` on Debian and Ubuntu. The package creates a
dedicated service account, installs the session assets, and provides a systemd service.
Docker must be running. Enable Innkeeper:

```sh
sudo systemctl enable --now docker elsewhere-innkeeper
sudo cat /var/lib/elsewhere-innkeeper/admin-token
```

Edit `/etc/elsewhere-innkeeper/environment` to configure native installations and restart the service. Restart `elsewhere-innkeeper` after every native package upgrade to use the updated binary and its pinned Elsewhere release. The account receives access to Docker through its supplementary `docker` group. Arch packaging builds the checkout through `packaging/arch/PKGBUILD`. Debian packaging uses `cargo-deb` with metadata in `Cargo.toml` and the service setup in `packaging/debian/`. Native source builds require Rust with edition 2024 support and Node.js 24.

## Development

```sh
docker build --target check .
```

`elsewhere-innkeeper --version` and the footer display Innkeeper's own build version. Source and Docker builds report `0.0.0-dev` unless `INNKEEPER_VERSION` is set. Docker treats an empty build argument as unset. Cargo metadata stays at `0.0.0`, including release builds. Override the displayed version with `docker build --build-arg INNKEEPER_VERSION=1.2.3 .`, `INNKEEPER_VERSION=1.2.3 docker compose up -d --build`. Elsewhere's pinned release is independent of Innkeeper's version.

## Elsewhere upgrades

Each session displays its installed package version, read from the container's package
metadata even while stopped. Innkeeper refreshes this information periodically and after
installation or launch. Failed inspection shows “Version unavailable”.

An older version offers **Upgrade**. A newer version shows **Newer than expected** and the
expected release, with no Upgrade action. Release versions, numbered Git builds, and numeric package
revisions are compared numerically. Other version formats remain visible with a message
that their comparison is unavailable.

**Start** and **Relaunch** use the installed package without downloading, upgrading,
downgrading, or prompting about an available upgrade. **Upgrade** downloads the expected
package if needed, stops a running desktop, installs the package, and exits. It leaves the
session stopped so the user can choose **Start**. Upgrading does not run the startup command
or apply pending desktop settings. It retains the container and session home volume.

Installation failures remain visible in Logs and the session error. Stop a failed session
before retrying Upgrade or Repair. Start selects a normal launch and never retries an interrupted
upgrade automatically. **Repair** is available when package metadata confirms that Elsewhere is absent or
incompletely installed at the expected version or an older version. Unreadable metadata and
newer or unrecognized versions never authorize a repair. Repair installs the expected package
and leaves the session stopped. A pending Debian package-manager journal requires manual
recovery; Innkeeper reports this and blocks maintenance until it can read settled metadata.
Installation success requires a successful maintenance exit and verification of the installed version. After 30 minutes of installation, Innkeeper
shows a warning and continues monitoring completion. Restarting Innkeeper during an upgrade
download reconnects to the existing desktop; the user can request Upgrade again.

## Testing a local Elsewhere checkout

Run `make elsewhere-local` as a non-root user with Python 3.9+, Git, Make, and Docker available.
The adjacent `../elsewhere` checkout must already exist and have the history and tags required
by its `make version` target. Innkeeper never clones or fetches that checkout.

The target runs Elsewhere's `make package-arch` and `make package-deb` sequentially in Docker,
using separate Cargo and Node build caches and native build environments. It copies the packages from the
checkout's `dist/` into `.elsewhere-local/`, validates their metadata, and selects the build
only after both packages succeed. Source changes during packaging abort selection. A failed
build preserves the previous selection. Package metadata and filenames use Elsewhere's
normalized version, including `.dirty` for uncommitted changes.

`make run-local` rebuilds and recreates the Innkeeper Compose service with the selected
manifest and packages mounted read-only. Its footer identifies local mode. The override is
read at startup; selecting another build requires running `make run-local` again. Existing
session containers are retained. New sessions install the selected local package. Start and
Relaunch remain launch-only; use a fresh session to test changed packages with the same version.
Exact dirty-version matches display as current; other unrecognized comparisons remain unavailable.
An incomplete install whose version cannot be compared with the selected build may require
manual package-manager recovery or a fresh session.
Clean local versions can be installed through Upgrade when numerically newer than an existing
package. Returning to the release pin can leave those sessions showing Newer than expected;
Innkeeper does not downgrade them.
Missing local packages or an unreadable manifest cause an error rather than a GitHub download. Docker may still pull base
images and package managers may download dependencies.

All generated configuration, packages, and build caches live under `.elsewhere-local/`, which
is excluded by both `.gitignore` and `.dockerignore`. The override is never written to
`Cargo.toml` or embedded in an Innkeeper binary. Ordinary builds and Compose runs use the
release pin. Do not force-add the local directory.

`make elsewhere-local-reset` clears the local selection. Then run `docker compose up -d --build`
to return to the release pin. Reset does not stop or downgrade existing sessions, and it retains
staged packages and caches for running local instances. Remove `.elsewhere-local/` manually only
when no local instance needs those files.

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
Creation installs Innkeeper's pinned Elsewhere package. Start and Relaunch keep the installed
package and refresh the container entrypoint, desktop startup script, and launch settings.
Existing sessions retain their original Docker device configuration; create a new session
to add GPU access to a container created without it.

## Session profiles

The [profiles directory](profiles/) contains ready-to-import JSON session configurations.
They specify packages, startup commands, display settings, and Docker options.
In **New session**, expand **Import profile**, paste a profile's JSON, and choose **Apply profile**.
Review the settings and choose **Create session**.

Profiles support `name`, `distribution` (`arch` or `debian`), `packages` (an array of
package names), `startup_command`, `screen_size`, `kiosk`, and `docker_args`. Omitted fields use the
form defaults. Unknown fields are rejected. `screen_size` is `null` for dynamic sizing, or an object with `width`
and `height`, both even integers from 2 to 8192. Kiosk mode defaults to `false`.
The startup command runs through `sh -c` as the desktop user on each session start,
with the desktop's display and audio environment. An empty command starts no application.
Settings are saved with the session and retained when it is stopped and started.

Expand **Advanced Docker options** in New session to configure the Elsewhere session
container. Enter one complete `--flag=value` argument per line. Supported flags are
`--security-opt`, `--cap-add`, and `--cap-drop`; each can appear more than once.
Profiles and `POST /api/sessions` accept these options as a `docker_args` array of
complete `--flag=value` strings. Omitted `docker_args` defaults to an empty array.
Arguments allow up to 64 entries and 4096 bytes total, with nonempty values and no NUL
characters or line breaks. Innkeeper passes each argument directly to Docker without
shell expansion. Docker validates option values; a rejected value appears in the
session's startup error. Seccomp profile paths refer to files where Innkeeper's Docker
client runs. For containerized Innkeeper, mount custom seccomp profiles into that container.

Docker options apply when the session container is created and remain in effect through
Start, Relaunch, Upgrade, Repair, and Innkeeper restarts. They are read-only in Edit
settings and are separate from pending desktop settings. Create a new session to use
different Docker options.

Use **Edit settings** on a running or stopped session to change its name, screen size,
kiosk mode, or startup command. **Save** updates the name immediately and saves the
other settings for the next launch. It does not interrupt the desktop. Distribution
and extra packages are set at creation.

**Settings pending** means saved launch settings differ from the last successful launch.
The indicator survives an Innkeeper restart and clears if edits are reverted or a launch
successfully applies them. Use **Relaunch** on a running session or **Start** on a stopped
session to apply saved settings. Relaunch disconnects the desktop and closes running
applications. Save edits before relaunching. The container, installed software, home
directory, connection tokens, and port are retained. A failed launch retains saved settings
for retry through Stop and Start. Settings cannot be saved during preparation or failure;
stop a failed session before editing it.

The authenticated API accepts `PUT /api/sessions/{id}/settings` with all four fields:
`name`, `screen_size`, `kiosk`, and `startup_command`. Use `null` for dynamic screen sizing,
`false` to disable kiosk mode, and an empty string to clear the startup command.
Unknown or missing fields are rejected. `POST /api/sessions/{id}/relaunch` relaunches a
running session using saved settings. Session responses include `settings_pending`.

## Release versions

The release workflow runs on `vX.Y.Z` tags, checks that the tag identifies the checked-out
commit, and passes `X.Y.Z` as `INNKEEPER_VERSION` to both package builds. Arch and Debian
packages use `X.Y.Z-1`, and their binaries report `X.Y.Z`. Cargo metadata stays at `0.0.0`.
The workflow builds in Debian and Arch job containers with a Rust cache. It publishes
both packages and a Linux x86_64 tarball after verifying the installed Debian package and
running its authenticated API check on Debian Trixie, Ubuntu 24.04, and the latest Ubuntu image.

After the package jobs succeed, the workflow builds the Dockerfile's `final` image for `linux/amd64`
with the same `INNKEEPER_VERSION` and pushes it to Docker Hub as `X.Y.Z` and `latest`. It creates the
GitHub release after the image push succeeds. Docker build records are not attached to the release.

Create a Docker Hub repository named `elsewhere-innkeeper` and configure these GitHub Actions settings:

| Setting | Type | Value |
| --- | --- | --- |
| `DOCKERHUB_IMAGE` | Repository variable | `<namespace>/elsewhere-innkeeper` |
| `DOCKERHUB_USERNAME` | Repository variable | Docker Hub login with access to that repository |
| `DOCKERHUB_TOKEN` | Repository secret | Docker Hub access token with read and write access |

Every tagged release updates `latest` without comparing versions. Branch and pull-request builds do
not publish images. If publishing fails, rerun the failed jobs. An image can already be available on
Docker Hub when GitHub release creation fails; rerun the failed release job to finish publication.

Local packaging uses the same `cargo-deb` and `makepkg` commands as the release workflow.
On Debian, install `cargo-deb` and the source build dependencies, then run:

```sh
make web
INNKEEPER_VERSION=0.0.0 cargo deb -p elsewhere-innkeeper --locked --deb-version 0.0.0-1
```

The Debian package appears in `target/debian/`. For a release build, use the tag's `X.Y.Z`
for both the environment variable and `--deb-version X.Y.Z-1`.
On Arch, install the PKGBUILD's dependencies and build the checkout:

```sh
cd packaging/arch
makepkg -f --noconfirm
```

The Arch package appears in `packaging/arch/` and uses its `pkgver`, which defaults to
`0.0.0`. Direct source builds report `0.0.0-dev` unless the version variable is set.
Rust tests and formatting checks run in the separate Docker check workflow on pushes
and pull requests. Release checks compare each binary's version with the tag. The Debian
installation check verifies the service files, conffile, disabled initial service, and an
authenticated response from a running Innkeeper instance using temporary state.

The tarball contains the binary, session scripts, README, and license. Extract it and run
from its directory, pointing Innkeeper at the included session assets and a writable data directory:

```sh
INNKEEPER_ASSETS_DIR="$PWD" INNKEEPER_DATA_DIR="$PWD/data" ./elsewhere-innkeeper
```

Docker must be installed and accessible to the account running Innkeeper.

The pinned Elsewhere `0.5.0` release requires an explicit RTC address behind the proxy. Hostname fallback with the assigned UDP port requires an Elsewhere build containing the `--rtc-port` advertisement fix; use the local package workflow above until that fix is released.

## Proxy verification

Run the checks in Docker:

```sh
docker build --target check -t innkeeper-proxy-check .
docker build --target proxy-rig -t innkeeper-proxy-rig .
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  --entrypoint python3 \
  innkeeper-proxy-rig /check-proxy.py
```

The proxy fixture creates two disposable containers and checks TLS, UUID routing, ownership, authorization, a large upload, an unbuffered stream longer than eight seconds, WebSocket binary/ping/close frames, and restart routing. It selects two ports in `19500`–`19999` that are not published by running Docker containers. Set `PROXY_TEST_HTTP=1` to check the plaintext listener used behind an HTTPS gateway. Set `PROXY_TEST_TIMEOUTS=1` to check a stalled backend and an active upload longer than the response-header idle timeout. Repeat on a custom bridge by adding `--network NETWORK -e PROXY_TEST_NETWORK=NETWORK`, or check native mode with `--network host -e INNKEEPER_IN_DOCKER=0`.

`scripts/check-session-refresh.py` checks session upgrades, settings, and Docker options
with disposable Arch and Debian containers. Run it in `proxy-rig` with the Docker socket
and the checkout mounted at `/src`, using `python3 /src/scripts/check-session-refresh.py`.
The Docker options browser check uses the built frontend and a fixture API:

```sh
docker build --target proxy-browser -t innkeeper-proxy-browser .
docker run --rm --entrypoint node \
  -v "$PWD/scripts/check-docker-options-browser.mjs:/src/scripts/check-docker-options-browser.mjs:ro" \
  innkeeper-proxy-browser /src/scripts/check-docker-options-browser.mjs
```

`scripts/check-proxy-desktops.py` checks fresh real Arch and Debian packages through the production creation and launch flow. Mount the script at `/check.py`; `proxy-rig` includes its SQLite fixture helper. Run it in `proxy-rig` with the Docker socket, the session scripts, a writable directory at `/work`, and a local package manifest and artifacts at `/local`. Mount `/dev/dri` to exercise the host GPU. Publish `127.0.0.1:29301:29301` for a local browser rig. Leave `INNKEEPER_RTC_ADDR` unset to check hostname fallback, or set it to check an explicit override. It reserves ports used by unrelated Docker containers and removes only its own sessions.

For browser checks, set `PROXY_WAIT_BROWSER=1` on that desktop rig, build the `proxy-browser` target, and run `node /src/scripts/check-proxy-browser.mjs` with host networking and the same `/work` directory after `/work/browser.json` appears. Set `PROXY_BROWSER_ORIGIN=https://localhost:29301` to exercise hostname resolution. This covers simultaneous desktops, Open and token isolation, decoded frames, file transfers, MCP, terminals, viewer access, direct WebRTC and WebSocket fallback. The browser writes `/work/browser-done` so the desktop rig can clean up.
