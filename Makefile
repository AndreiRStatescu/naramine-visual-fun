.PHONY: install setup up build test check

install:
	pnpm install --frozen-lockfile

setup: install
	@node scripts/check-dev-port.mjs
	@test -e .env || cp .env.example .env
	pnpm data:prepare
	pnpm db:generate
	pnpm db:deploy

up: setup
	pnpm dev

build:
	pnpm build

test:
	pnpm test

check:
	pnpm format:check
	pnpm lint
	pnpm typecheck
	pnpm test
	pnpm build
