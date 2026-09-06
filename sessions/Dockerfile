# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS web
WORKDIR /src/web
COPY --from=upstream /web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY --from=upstream /web/ ./
COPY --from=upstream /LICENSE /src/LICENSE
RUN npm run build

FROM archlinux:base AS arch-build
RUN pacman -Syu --noconfirm --needed rust pkgconf clang git base-devel libpipewire gstreamer gst-plugins-base mesa libxkbcommon
WORKDIR /src
COPY --from=upstream / ./
COPY --from=web /src/web/dist web/dist
RUN cargo build --release --locked

FROM rust:1-trixie AS debian-build
RUN apt-get update && apt-get install -y --no-install-recommends clang pkg-config git libpipewire-0.3-dev libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev libgbm-dev libegl-dev libgles-dev libxkbcommon-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY --from=upstream / ./
COPY --from=web /src/web/dist web/dist
RUN cargo build --release --locked

FROM archlinux:base AS arch
COPY sessions/setup-arch.sh /opt/bwm/setup.sh
RUN sh /opt/bwm/setup.sh dependencies
COPY --from=arch-build /src/target/release/browser-wayland /opt/bwm/browser-wayland
COPY --from=web /src/web/dist/THIRD_PARTY.txt /opt/bwm/THIRD_PARTY.txt
COPY sessions/entrypoint.sh sessions/start.sh sessions/packages.sh /opt/bwm/
RUN ldd /opt/bwm/browser-wayland > /opt/bwm/libraries.txt && ! grep 'not found' /opt/bwm/libraries.txt
ENTRYPOINT ["sh", "/opt/bwm/entrypoint.sh"]

FROM debian:trixie-slim AS debian
COPY sessions/setup-debian.sh /opt/bwm/setup.sh
RUN sh /opt/bwm/setup.sh dependencies
COPY --from=debian-build /src/target/release/browser-wayland /opt/bwm/browser-wayland
COPY --from=web /src/web/dist/THIRD_PARTY.txt /opt/bwm/THIRD_PARTY.txt
COPY sessions/entrypoint.sh sessions/start.sh sessions/packages.sh /opt/bwm/
RUN ldd /opt/bwm/browser-wayland > /opt/bwm/libraries.txt && ! grep 'not found' /opt/bwm/libraries.txt
ENTRYPOINT ["sh", "/opt/bwm/entrypoint.sh"]
