.PHONY: all build web test

all: build

build: web
	cargo build --release --locked

web:
	cd web && npm ci --no-audit --no-fund && npm run build

test: web
	cargo test --locked

.PHONY: elsewhere-local run-local elsewhere-local-reset
elsewhere-local:
	python3 scripts/elsewhere-local.py build

run-local:
	python3 scripts/elsewhere-local.py run

elsewhere-local-reset:
	python3 scripts/elsewhere-local.py reset
