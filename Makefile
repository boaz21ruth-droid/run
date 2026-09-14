SHELL := /bin/bash
.DEFAULT_GOAL := help

.PHONY: help setup lint lint-api test test-api test-web migrate-up migrate-status

help: ## 列出可用目标
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-16s %s\n", $$1, $$2}'

setup:
	@command -v corepack >/dev/null 2>&1 && corepack enable || echo "corepack not found: install pnpm 10.34.5 manually (e.g. npx -y pnpm@10.34.5)"
	pnpm install
	cd api && go mod download
	test -f .env || cp .env.example .env

lint: lint-api
	pnpm lint

lint-api: ## Go 静态检查
	cd api && go tool golangci-lint run ./...

test: test-api test-web

test-api: ## Go 测试（集成测试需要本机 Docker）
	cd api && go test ./...

test-web:
	pnpm typecheck
	pnpm test
	pnpm i18n:check

migrate-up: ## 执行数据库迁移（读取根目录 .env）
	set -a; . ./.env; set +a; cd api && go run ./cmd/werun migrate up

migrate-status: ## 查看迁移状态（读取根目录 .env）
	set -a; . ./.env; set +a; cd api && go run ./cmd/werun migrate status

.PHONY: gen gen-api

gen: gen-api

gen-api:
	mkdir -p api/internal/httpapi/apigen
	cd api/openapi && go tool oapi-codegen -config oapi-codegen.yaml openapi.yaml
	cd api && go run ./internal/httpapi/cmd/permgen -spec openapi/openapi.yaml -out internal/httpapi/apigen/permissions.gen.go
	cd api && go tool sqlc generate

.PHONY: create-staff

create-staff:
	set -a; . ./.env; set +a; cd api && go run ./cmd/werun create-staff $(ARGS)
