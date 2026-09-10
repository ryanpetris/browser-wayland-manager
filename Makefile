.PHONY: all build web test

all: build

build: web
	cargo build --release --locked

web:
	cd web && npm ci --no-audit --no-fund && npm run build

test: web
	cargo test --locked

.PHONY: local elsewhere-local-reset
local:
	python3 scripts/elsewhere-local.py local

elsewhere-local-reset:
	python3 scripts/elsewhere-local.py reset
