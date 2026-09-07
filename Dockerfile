# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS web
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM rust:1-trixie AS build
WORKDIR /src
COPY . .
ARG INNKEEPER_VERSION
COPY --from=web /src/web/dist web/dist
RUN if [ -z "$INNKEEPER_VERSION" ]; then unset INNKEEPER_VERSION; fi; cargo build --release --locked
FROM build AS check
RUN if [ -z "$INNKEEPER_VERSION" ]; then unset INNKEEPER_VERSION; fi; \
    rustup component add rustfmt && cargo test --locked && cargo fmt --check && \
    test "$(target/release/elsewhere-innkeeper --version)" = "elsewhere-innkeeper ${INNKEEPER_VERSION:-0.0.0-dev}"

RUN useradd --create-home local-check && runuser -u local-check -- python3 scripts/check-elsewhere-local.py

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends docker-cli curl ca-certificates tini && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/elsewhere-innkeeper /usr/bin/elsewhere-innkeeper
COPY sessions/ /usr/share/elsewhere-innkeeper/sessions/
COPY LICENSE /usr/share/licenses/elsewhere-innkeeper/LICENSE
ENV INNKEEPER_LISTEN=0.0.0.0:19300 INNKEEPER_DOCKER_HOST=host.docker.internal INNKEEPER_SESSION_BIND=0.0.0.0
EXPOSE 19300
VOLUME /var/lib/elsewhere-innkeeper
ENTRYPOINT ["/usr/bin/tini", "--", "elsewhere-innkeeper"]
