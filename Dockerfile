# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS web
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM rust:1-trixie AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock* ./
COPY src/ src/
COPY sessions/revision sessions/recipe-version sessions/
COPY --from=web /src/web/dist web/dist
RUN cargo build --release --locked
FROM build AS check
RUN rustup component add rustfmt && cargo test --locked && cargo fmt --check

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends docker-cli docker-buildx git ca-certificates tini && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/browser-wayland-manager /usr/bin/browser-wayland-manager
COPY sessions/ /usr/share/browser-wayland-manager/sessions/
COPY scripts/build-sessions /usr/share/browser-wayland-manager/scripts/build-sessions
COPY LICENSE /usr/share/licenses/browser-wayland-manager/LICENSE
COPY .dockerignore /usr/share/browser-wayland-manager/.dockerignore
ENV BWM_LISTEN=0.0.0.0:19300 BWM_DOCKER_HOST=host.docker.internal BWM_SESSION_BIND=0.0.0.0
EXPOSE 19300
VOLUME /var/lib/browser-wayland-manager
ENTRYPOINT ["/usr/bin/tini", "--", "browser-wayland-manager"]
