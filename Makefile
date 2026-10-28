SHELL := /bin/bash
.DEFAULT_GOAL := help

.PHONY: help setup lint lint-api test test-api test-web migrate-up migrate-status

help: ## 列出可用目标
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-16s %s\n", $$1, $$2}'

setup: ## 安装依赖并生成 .env（Node 25+ 不带 corepack 时自动用 npm 装 pnpm 10.34.5）
	@if command -v corepack >/dev/null 2>&1; then corepack enable; \
	elif ! command -v pnpm >/dev/null 2>&1; then echo "corepack not found, installing pnpm@10.34.5 via npm"; npm i -g pnpm@10.34.5; fi
	pnpm install
	cd api && go mod download
	test -f .env || cp .env.example .env

lint: lint-api ## 全部静态检查（Go + ESLint）
	pnpm lint

lint-api: ## Go 静态检查
	cd api && go tool golangci-lint run ./...

test: test-api test-web ## 全部测试（Go + 前端 + i18n）

test-api: ## Go 测试（集成测试需要本机 Docker）
	cd api && go test ./...

test-web: ## 前端 typecheck、测试与 i18n 键检查
	pnpm typecheck
	pnpm test
	pnpm i18n:check

migrate-up: ## 执行数据库迁移（读取根目录 .env）
	set -a; . ./.env; set +a; cd api && go run ./cmd/werun migrate up

migrate-status: ## 查看迁移状态（读取根目录 .env）
	set -a; . ./.env; set +a; cd api && go run ./cmd/werun migrate status

.PHONY: gen gen-api gen-client

gen: gen-api gen-client ## 重新生成 OpenAPI 服务端、权限表、sqlc 与前端客户端

gen-api: ## 只生成后端代码
	mkdir -p api/internal/httpapi/apigen
	cd api/openapi && go tool oapi-codegen -config oapi-codegen.yaml openapi.yaml
	cd api && go run ./internal/httpapi/cmd/permgen -spec openapi/openapi.yaml -out internal/httpapi/apigen/permissions.gen.go
	cd api && go tool sqlc generate

gen-client: ## 只生成前端 API 客户端
	pnpm --filter @werun/api-client gen

.PHONY: create-staff

create-staff: ## 创建后台员工账号，参数用 ARGS 传入
	set -a; . ./.env; set +a; cd api && go run ./cmd/werun create-staff $(ARGS)

COMPOSE_DEV := docker compose -f deploy/compose.dev.yaml
COMPOSE     := docker compose -f deploy/compose.yaml --env-file .env

.PHONY: dev dev-down dev-api dev-user dev-admin compose-up compose-down build-images

## 本地开发：compose 起 postgres 与 caddy，宿主机并行跑 Go（air 热重载）和两个 Vite
dev: ## 本地开发：compose 起 postgres 与 caddy，并行跑 Go 与两个 Vite
	$(COMPOSE_DEV) up -d --wait postgres caddy
	$(MAKE) -j3 dev-api dev-user dev-admin

dev-down: ## 停掉本地开发的 compose 服务
	$(COMPOSE_DEV) down

dev-api: ## 只跑 Go API（air 热重载）
	set -a; . ./.env; set +a; cd api && go tool air -c .air.toml

dev-user: ## 只跑用户端 Vite（5173）
	pnpm --filter @werun/user dev --host 0.0.0.0 --port 5173 --strictPort

dev-admin: ## 只跑后台 Vite（5174）
	pnpm --filter @werun/admin dev --host 0.0.0.0 --port 5174 --strictPort

## 生产形态的完整环境（本地验证、CI 端到端测试共用）
compose-up: ## 以生产形态起完整环境
	$(COMPOSE) up -d --build --wait

compose-down: ## 停掉生产形态环境
	$(COMPOSE) down

build-images: ## 本地构建 api 与 web 镜像
	docker build -f api/Dockerfile -t werun-api:local .
	docker build -f deploy/web.Dockerfile -t werun-web:local .

.PHONY: e2e e2e-seed

e2e-seed: ## 写入 e2e 所需员工与同意书
	bash e2e/scripts/seed-staff.sh
	bash e2e/scripts/seed-consent.sh

e2e: ## 跑 Playwright 端到端测试
	pnpm --filter @werun/e2e e2e
