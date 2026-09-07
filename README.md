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
| `INNKEEPER_ASSETS_DIR` | `/usr/share/elsewhere-innkeeper` | Session setup scripts |

The native application and session ports bind all IPv4 interfaces by default. Compose publishes Innkeeper's port on the addresses supported by the Docker daemon. Desktop links use the hostname or IP address in the browser's Innkeeper URL, with the session's HTTPS port. Set `INNKEEPER_PUBLIC_HOST` to override that hostname. When a reverse proxy runs on another machine, set it to the Docker host's browser-reachable address unless the proxy also forwards the session ports. IPv6 literal overrides must include brackets, for example `[2001:db8::1]`; IPv6 links also require Docker to publish the session ports over IPv6. Compose uses `host.docker.internal:host-gateway` for backend access, independently of browser links. Use an HTTPS reverse proxy to protect management traffic on untrusted networks. To restrict management access to the local machine, change the Compose port mapping to `127.0.0.1:19300:19300`, or set `INNKEEPER_LISTEN=127.0.0.1:19300` for a native installation. For a native installation, `INNKEEPER_SESSION_BIND=127.0.0.1` also restricts desktop ports to loopback. Forward both TCP and UDP session ports when using NAT. One Innkeeper controls one local Linux Docker daemon; remote Docker daemons and rootless Docker are not currently supported.

After changing Compose configuration, rebuild and recreate Innkeeper with `docker compose up -d --build`.

Management access grants Docker control. Treat the administrator token and Docker socket as host-administrator credentials. Elsewhere owns session credentials in each session home volume. Innkeeper retrieves them on demand and does not store copies in `state.json`. Back up the complete Innkeeper data directory together with session volumes. The frontend retains the administrator token only in the tab's session storage. No cross-origin API access is enabled.

## Session lifecycle

Creation validates package names, records the session, downloads a release package if it is not cached, and prepares a stock base image. It creates a labeled volume and container, then copies the setup scripts and package into the stopped container through the Docker API. This also works when Innkeeper runs inside Docker; the source files are read from Innkeeper's filesystem.

Inside the session container, setup installs runtime services, prepares the user and runtime directories, and installs Elsewhere with `apt` or `pacman`. The package manager resolves the package's declared dependencies, including Debian recommendations. A separate script installs requested extra packages before Elsewhere starts. Elsewhere generates its own credentials on first launch. Innkeeper runs `elsewhere token` and `elsewhere token --viewer` as the desktop user when credentials are needed. Session packages must provide these commands. Innkeeper treats their output as opaque text. The session stays preparing until both commands succeed and an authenticated readiness request succeeds. Setup and installation markers allow stopped sessions to restart without reinstalling packages.

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
Docker must be running. Enable Innkeeper explicitly:

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
before retrying Upgrade. Start selects a normal launch and never retries an interrupted
upgrade automatically. An interrupted package-manager transaction may need repair before
the installed application can run. Installation success requires a successful maintenance
exit and verification of the installed version.

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
