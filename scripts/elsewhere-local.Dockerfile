FROM node:24-bookworm-slim AS node

FROM rust:1-trixie AS debian
RUN apt-get update && apt-get install -y --no-install-recommends \
    make git pkg-config cmake libavcodec-dev libavutil-dev libavfilter-dev \
    libswscale-dev libswresample-dev libavformat-dev libavdevice-dev libva-dev \
    libpipewire-0.3-dev libclang-dev libgbm-dev libegl-dev libxkbcommon-dev \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && cargo install cargo-deb --locked
ARG BUILDER_UID=1000
ARG BUILDER_GID=1000
RUN (getent group "$BUILDER_GID" >/dev/null || groupadd --gid "$BUILDER_GID" builder) \
    && useradd -m --uid "$BUILDER_UID" --gid "$BUILDER_GID" builder
USER builder
ENV HOME=/home/builder CARGO_HOME=/cargo-cache

FROM archlinux:base-devel AS arch
RUN pacman-key --init && pacman-key --populate archlinux \
    && pacman -Sy --noconfirm archlinux-keyring \
    && pacman -Syu --noconfirm --needed cargo nodejs npm ffmpeg libva \
    mesa libxkbcommon libpipewire clang git \
    && rm -rf /var/cache/pacman/pkg/*
ARG BUILDER_UID=1000
ARG BUILDER_GID=1000
RUN (getent group "$BUILDER_GID" >/dev/null || groupadd --gid "$BUILDER_GID" builder) \
    && useradd -m --uid "$BUILDER_UID" --gid "$BUILDER_GID" builder
USER builder
ENV HOME=/home/builder CARGO_HOME=/cargo-cache
