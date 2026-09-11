# syntax=docker/dockerfile:1
# Node.js 24 on Debian 12.
FROM node:24-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS web
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# Rust 1 on Debian 13.
FROM rust:1@sha256:bf5a9aa29062a6cb03c49bd59a46eb55e3cc770caf598a221a7866e500be3082 AS build
WORKDIR /src
COPY . .
ARG INNKEEPER_VERSION
COPY --from=web /src/web/dist web/dist
RUN if [ -z "$INNKEEPER_VERSION" ]; then unset INNKEEPER_VERSION; fi; cargo build --release --locked
FROM build AS check
RUN if [ -z "$INNKEEPER_VERSION" ]; then unset INNKEEPER_VERSION; fi; \
    rustup component add rustfmt && cargo test --locked && cargo fmt --check && \
    test "$(target/release/elsewhere-innkeeper --version)" = "elsewhere-innkeeper ${INNKEEPER_VERSION:-0.0.0-dev}"

RUN INNKEEPER_BINARY=/src/target/release/elsewhere-innkeeper python3 scripts/check-accounts.py && \
    INNKEEPER_BINARY=/src/target/release/elsewhere-innkeeper python3 scripts/check-token-sync.py

RUN useradd --create-home local-check && runuser -u local-check -- python3 scripts/check-elsewhere-local.py
RUN runuser -u local-check -- env INNKEEPER_BINARY=/src/target/release/elsewhere-innkeeper python3 scripts/check-tls.py

FROM debian:13-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends docker-cli docker-buildx curl ca-certificates tini && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/elsewhere-innkeeper /usr/bin/elsewhere-innkeeper
COPY sessions/ /usr/share/elsewhere-innkeeper/sessions/
COPY LICENSE /usr/share/licenses/elsewhere-innkeeper/LICENSE
ENV INNKEEPER_LISTEN=0.0.0.0:19300 INNKEEPER_IN_DOCKER=1
EXPOSE 19300
VOLUME /var/lib/elsewhere-innkeeper
ENTRYPOINT ["/usr/bin/tini", "--", "elsewhere-innkeeper"]

FROM runtime AS proxy-rig
RUN apt-get update && apt-get install -y --no-install-recommends python3 openssl zstd \
    && rm -rf /var/lib/apt/lists/* && useradd -m elsewhere
COPY --chmod=755 scripts/check-proxy.py /check-proxy.py
COPY scripts/sqlite_fixture.py scripts/auth_fixture.py /
COPY scripts/check-glx32.c /check-glx32.c
RUN ln -s /check-proxy.py /usr/local/bin/elsewhere

FROM web AS proxy-browser
RUN apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/check-proxy-browser.mjs /src/scripts/check-proxy-browser.mjs

FROM runtime AS final
