# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS node
FROM rust:1-trixie AS debian
RUN apt-get update && apt-get install -y --no-install-recommends debhelper binutils build-essential && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/ /usr/local/
WORKDIR /src
COPY . .
RUN cp -r packaging/debian debian && dpkg-buildpackage -d -us -uc -b
RUN mkdir /packages && cp /browser-wayland-manager_*.deb /packages/

FROM archlinux:base AS arch
RUN pacman -Syu --noconfirm --needed base-devel rust nodejs npm git docker docker-buildx && useradd -m builder
COPY . /source/browser-wayland-manager-0.1.0/
RUN mkdir /build && tar -C /source -czf /build/browser-wayland-manager-0.1.0.tar.gz browser-wayland-manager-0.1.0 && cp /source/browser-wayland-manager-0.1.0/packaging/PKGBUILD /build/ && chown -R builder:builder /build
WORKDIR /build
USER builder
RUN makepkg --noconfirm
USER root
RUN mkdir /packages && cp /build/*.pkg.tar.zst /packages/
