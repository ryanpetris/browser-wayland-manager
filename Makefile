.PHONY: all build web test

all: build

build: web
	cargo build --release --locked

web:
	cd web && npm ci --no-audit --no-fund && npm run build

test: web
	cargo test --locked
