SHELL := /bin/bash
.DEFAULT_GOAL := help

.PHONY: help setup lint lint-api test test-api

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
