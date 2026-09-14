SHELL := /bin/bash
.DEFAULT_GOAL := help

.PHONY: help setup lint lint-api test test-api migrate-up migrate-status

help: ## 列出可用目标
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-16s %s\n", $$1, $$2}'

setup: ## 下载依赖；.env 不存在时从 .env.example 复制
	cd api && go mod download
	@test -f .env || cp .env.example .env

lint: lint-api ## 全部静态检查

lint-api: ## Go 静态检查
	cd api && go tool golangci-lint run ./...

test: test-api ## 全部测试

test-api: ## Go 测试（集成测试需要本机 Docker）
	cd api && go test ./...

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
