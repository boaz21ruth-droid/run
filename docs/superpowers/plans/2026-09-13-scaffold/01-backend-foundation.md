# WeRun 脚手架 · Part 01：后端基础（Task 1–4）

> 全局约束、依赖版本、跨任务契约（C1–C16）见 `00-overview.md`，本文件所有任务都默认遵守。

本部分完成后：Go 模块、配置、日志、错误码与三语文案、数据库连接与迁移、测试数据库工具、HTTP 中间件、`werun` 命令行（`serve` / `migrate` / `healthcheck`）全部可用，`GET /api/healthz` 与 `GET /api/readyz` 能在真实数据库上跑通。

执行前提：本机已安装 Go 1.26、Docker（集成测试用 testcontainers 启动 PostgreSQL）、git；当前目录为仓库根目录 `/Users/boazchen/projects/run`（下文所有命令都从仓库根目录出发，除非写明 `cd api`）。

---

### Task 1: Go 模块、配置、日志、金额与根目录工具文件

**Files:**
- Create: `api/go.mod`、`api/go.sum`（命令生成）
- Create: `api/internal/platform/config/config.go`
- Test: `api/internal/platform/config/config_test.go`
- Create: `api/internal/platform/logx/logx.go`
- Test: `api/internal/platform/logx/logx_test.go`
- Create: `api/internal/platform/money/money.go`
- Test: `api/internal/platform/money/money_test.go`
- Create: `.env.example`
- Create: `Makefile`
- Create: `api/.golangci.yml`

**Interfaces:**
- Consumes: 无（第一个任务）
- Produces:
  - `config.Config`（字段见 C1）、`config.Load() (config.Config, error)`、`(config.Config).IsProd() bool`
  - 额外：`(config.Config).PIIKeyBytes() ([]byte, error)`——返回解码后的 32 字节密钥，后续加密个人信息时使用
  - `logx.New(level string, w io.Writer) *slog.Logger`
  - `money.Cents`、`(money.Cents).String() string`
  - Makefile 目标 `help`、`setup`、`lint`、`lint-api`、`test`、`test-api`

- [ ] **Step 1: 初始化 Go 模块并锁定依赖与工具版本**

```bash
mkdir -p api
cd api
go mod init werun/api
go mod edit -go=1.26
go get \
  github.com/gin-gonic/gin@v1.12.0 \
  github.com/jackc/pgx/v5@v5.11.0 \
  github.com/pressly/goose/v3@v3.28.0 \
  github.com/riverqueue/river@v0.47.0 \
  github.com/riverqueue/river/riverdriver/riverpgxv5@v0.47.0 \
  github.com/oapi-codegen/runtime@v1.7.0 \
  github.com/getkin/kin-openapi@v0.149.0 \
  github.com/caarlos0/env/v11@v11.4.1 \
  golang.org/x/crypto@v0.57.0 \
  github.com/testcontainers/testcontainers-go@v0.44.0 \
  github.com/testcontainers/testcontainers-go/modules/postgres@v0.44.0 \
  github.com/stretchr/testify@v1.12.1
go get -tool github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1
go get -tool github.com/pressly/goose/v3/cmd/goose@v3.28.0
go get -tool github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.8.0
go get -tool github.com/air-verse/air@v1.67.4
go get -tool github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2
go tool sqlc version
cd ..
```

Expected：最后一条输出 `v1.31.1`。

注意：在 Task 5 之前**不要**执行 `go mod tidy`，否则尚未被代码导入的依赖会被移除；后续任务导入这些包后它们会自然保留。

- [ ] **Step 2: 写配置的失败测试**

`api/internal/platform/config/config_test.go`：

```go
package config_test

import (
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/config"
)

// base64("dev-only-pii-key-32-bytes-000000")，解码后正好 32 字节
const validPIIKey = "ZGV2LW9ubHktcGlpLWtleS0zMi1ieXRlcy0wMDAwMDA="

// unset 让变量在本测试内处于"未设置"状态，测试结束后自动恢复原值。
func unset(t *testing.T, keys ...string) {
	t.Helper()
	for _, k := range keys {
		t.Setenv(k, "")
		require.NoError(t, os.Unsetenv(k))
	}
}

func setRequired(t *testing.T) {
	t.Helper()
	unset(t, "WERUN_ENV", "WERUN_HTTP_ADDR", "WERUN_FILES_DIR", "WERUN_LOG_LEVEL")
	t.Setenv("WERUN_DATABASE_URL", "postgres://werun:werun@localhost:55432/werun?sslmode=disable")
	t.Setenv("WERUN_SESSION_SECRET", strings.Repeat("s", 32))
	t.Setenv("WERUN_PII_KEY", validPIIKey)
}

func TestLoadAppliesDefaults(t *testing.T) {
	setRequired(t)

	cfg, err := config.Load()

	require.NoError(t, err)
	assert.Equal(t, "dev", cfg.Env)
	assert.Equal(t, ":8080", cfg.HTTPAddr)
	assert.Equal(t, "./data/files", cfg.FilesDir)
	assert.Equal(t, "info", cfg.LogLevel)
	assert.False(t, cfg.IsProd())
}

func TestLoadProd(t *testing.T) {
	setRequired(t)
	t.Setenv("WERUN_ENV", "prod")

	cfg, err := config.Load()

	require.NoError(t, err)
	assert.True(t, cfg.IsProd())
}

func TestLoadReportsEveryInvalidVariable(t *testing.T) {
	unset(t, "WERUN_DATABASE_URL", "WERUN_HTTP_ADDR", "WERUN_FILES_DIR", "WERUN_LOG_LEVEL")
	t.Setenv("WERUN_ENV", "staging")
	t.Setenv("WERUN_SESSION_SECRET", "too-short")
	t.Setenv("WERUN_PII_KEY", "not base64 !!")

	_, err := config.Load()

	require.Error(t, err)
	for _, name := range []string{"WERUN_DATABASE_URL", "WERUN_ENV", "WERUN_SESSION_SECRET", "WERUN_PII_KEY"} {
		assert.Contains(t, err.Error(), name)
	}
}

func TestLoadRejectsPIIKeyOfWrongLength(t *testing.T) {
	setRequired(t)
	t.Setenv("WERUN_PII_KEY", "c2hvcnQta2V5LTE2LWJ5dGU=") // base64("short-key-16-byte")

	_, err := config.Load()

	require.Error(t, err)
	assert.Contains(t, err.Error(), "WERUN_PII_KEY")
}

func TestPIIKeyBytes(t *testing.T) {
	setRequired(t)
	cfg, err := config.Load()
	require.NoError(t, err)

	key, err := cfg.PIIKeyBytes()

	require.NoError(t, err)
	assert.Len(t, key, 32)
}
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `cd api && go test ./internal/platform/config/... ; cd ..`
Expected: FAIL，编译错误，提示 `werun/api/internal/platform/config` 包不存在（或 `config.Load` 未定义）。

- [ ] **Step 4: 实现配置**

`api/internal/platform/config/config.go`：

```go
// Package config 从环境变量读取运行配置。所有变量以 WERUN_ 为前缀。
package config

import (
	"encoding/base64"
	"errors"
	"fmt"

	"github.com/caarlos0/env/v11"
)

// Config 是 werun 进程的全部运行配置。
type Config struct {
	Env           string `env:"WERUN_ENV" envDefault:"dev"`
	HTTPAddr      string `env:"WERUN_HTTP_ADDR" envDefault:":8080"`
	DatabaseURL   string `env:"WERUN_DATABASE_URL,required"`
	SessionSecret string `env:"WERUN_SESSION_SECRET,required"`
	PIIKey        string `env:"WERUN_PII_KEY,required"`
	FilesDir      string `env:"WERUN_FILES_DIR" envDefault:"./data/files"`
	LogLevel      string `env:"WERUN_LOG_LEVEL" envDefault:"info"`
}

// Load 解析并校验环境变量。返回的错误会列出所有不合法的变量，而不是只报第一个。
func Load() (Config, error) {
	cfg, err := env.ParseAs[Config]()

	var errs []error
	if err != nil {
		errs = append(errs, err)
	}
	if cfg.Env != "dev" && cfg.Env != "prod" {
		errs = append(errs, fmt.Errorf("WERUN_ENV must be dev or prod, got %q", cfg.Env))
	}
	if cfg.SessionSecret != "" && len(cfg.SessionSecret) < 32 {
		errs = append(errs, errors.New("WERUN_SESSION_SECRET must be at least 32 bytes"))
	}
	if cfg.PIIKey != "" {
		if _, keyErr := cfg.PIIKeyBytes(); keyErr != nil {
			errs = append(errs, keyErr)
		}
	}
	if len(errs) > 0 {
		return Config{}, errors.Join(errs...)
	}
	return cfg, nil
}

// IsProd 表示是否运行在生产环境。
func (c Config) IsProd() bool {
	return c.Env == "prod"
}

// PIIKeyBytes 返回解码后的 32 字节个人信息加密密钥。
func (c Config) PIIKeyBytes() ([]byte, error) {
	key, err := base64.StdEncoding.DecodeString(c.PIIKey)
	if err != nil {
		return nil, fmt.Errorf("WERUN_PII_KEY must be standard base64: %w", err)
	}
	if len(key) != 32 {
		return nil, fmt.Errorf("WERUN_PII_KEY must decode to 32 bytes, got %d", len(key))
	}
	return key, nil
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `cd api && go test ./internal/platform/config/... ; cd ..`
Expected: `ok  	werun/api/internal/platform/config`

- [ ] **Step 6: 写日志与金额的失败测试**

`api/internal/platform/logx/logx_test.go`：

```go
package logx_test

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/logx"
)

func TestInfoLevelDropsDebugAndWritesJSON(t *testing.T) {
	var buf bytes.Buffer
	log := logx.New("info", &buf)

	log.Debug("hidden")
	log.Info("visible", "request_id", "req-1")

	lines := bytes.Split(bytes.TrimSpace(buf.Bytes()), []byte("\n"))
	require.Len(t, lines, 1)
	var entry map[string]any
	require.NoError(t, json.Unmarshal(lines[0], &entry))
	assert.Equal(t, "visible", entry["msg"])
	assert.Equal(t, "req-1", entry["request_id"])
}

func TestDebugLevelWritesDebug(t *testing.T) {
	var buf bytes.Buffer
	logx.New("debug", &buf).Debug("shown")

	assert.Contains(t, buf.String(), `"msg":"shown"`)
}

func TestUnknownLevelFallsBackToInfo(t *testing.T) {
	var buf bytes.Buffer
	log := logx.New("verbose", &buf)

	log.Debug("hidden")
	log.Info("shown")

	assert.NotContains(t, buf.String(), "hidden")
	assert.Contains(t, buf.String(), "shown")
}
```

`api/internal/platform/money/money_test.go`：

```go
package money_test

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"werun/api/internal/platform/money"
)

func TestCentsString(t *testing.T) {
	cases := map[money.Cents]string{
		0:      "$0.00",
		5:      "$0.05",
		2193:   "$21.93",
		100000: "$1000.00",
		-500:   "-$5.00",
		-7:     "-$0.07",
	}
	for cents, want := range cases {
		assert.Equal(t, want, cents.String(), "cents=%d", int64(cents))
	}
}
```

- [ ] **Step 7: 运行测试，确认失败**

Run: `cd api && go test ./internal/platform/logx/... ./internal/platform/money/... ; cd ..`
Expected: FAIL，编译错误，`logx.New`、`money.Cents` 未定义。

- [ ] **Step 8: 实现日志与金额**

`api/internal/platform/logx/logx.go`：

```go
// Package logx 创建结构化 JSON 日志器。
package logx

import (
	"io"
	"log/slog"
	"strings"
)

// New 返回写入 w 的 JSON 日志器。level 可取 debug、info、warn、error，其他值按 info 处理。
func New(level string, w io.Writer) *slog.Logger {
	var lvl slog.Level
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "debug":
		lvl = slog.LevelDebug
	case "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}
	return slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{Level: lvl}))
}
```

`api/internal/platform/money/money.go`：

```go
// Package money 提供以最小货币单位（分）表示的金额类型。
package money

import "fmt"

// Cents 是以分为单位的金额，数据库中对应 *_cents bigint 列。
type Cents int64

// String 以美元格式输出，例如 2193 → "$21.93"，-500 → "-$5.00"。
func (c Cents) String() string {
	sign := ""
	v := int64(c)
	if v < 0 {
		sign = "-"
		v = -v
	}
	return fmt.Sprintf("%s$%d.%02d", sign, v/100, v%100)
}
```

- [ ] **Step 9: 运行测试，确认通过**

Run: `cd api && go test ./internal/platform/... ; cd ..`
Expected: `config`、`logx`、`money` 三个包都是 `ok`。

- [ ] **Step 10: 添加 `.env.example`、`Makefile`、`api/.golangci.yml`**

`.env.example`：

```dotenv
# WeRun 本地开发配置。make setup 会复制为 .env（.env 已被 .gitignore 排除）。
# 生产环境的值存放在 AWS SSM Parameter Store，部署时渲染为 .env。

# dev | prod；dev 下后台会话 Cookie 不设置 Secure
WERUN_ENV=dev
WERUN_HTTP_ADDR=:8080
WERUN_LOG_LEVEL=debug

# 本地 compose 的 PostgreSQL 映射在宿主 55432 端口
WERUN_DATABASE_URL=postgres://werun:werun@localhost:55432/werun?sslmode=disable

# 会话令牌 HMAC 密钥，至少 32 字节。生产环境必须替换为随机值：openssl rand -base64 48
WERUN_SESSION_SECRET=dev-only-session-secret-change-me-0123456789

# 个人信息 AES-GCM 密钥，base64 编码的 32 字节。生产环境必须替换：openssl rand -base64 32
WERUN_PII_KEY=ZGV2LW9ubHktcGlpLWtleS0zMi1ieXRlcy0wMDAwMDA=

WERUN_FILES_DIR=./data/files

# 以下两个变量只给 Caddy 使用（站点地址），Go 进程不读取
WERUN_USER_HOST=http://werun.localhost
WERUN_ADMIN_HOST=http://admin.werun.localhost
```

`Makefile`（缩进必须是 Tab）：

```makefile
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
```

`api/.golangci.yml`：

```yaml
version: "2"

run:
  timeout: 5m

linters:
  default: standard
  enable:
    - bodyclose
    - errorlint
    - misspell
    - noctx
    - unconvert
  exclusions:
    generated: lax
    presets:
      - std-error-handling
    paths:
      - internal/httpapi/apigen
      - internal/.*/store

formatters:
  enable:
    - gofmt
    - goimports
```

- [ ] **Step 11: 运行 lint 与测试**

Run: `make lint && make test`
Expected: golangci-lint 输出 `0 issues.`；`go test` 全部 `ok`。

- [ ] **Step 12: 提交**

```bash
git add api/go.mod api/go.sum api/.golangci.yml api/internal/platform/config api/internal/platform/logx api/internal/platform/money .env.example Makefile
git commit -F - <<'EOF'
feat(api): init Go module with config, logging and money types

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
```

---
### Task 2: 错误码、三语文案与错误响应渲染

**Files:**
- Create: `api/internal/platform/apperr/apperr.go`
- Create: `api/internal/platform/apperr/pg.go`
- Test: `api/internal/platform/apperr/apperr_test.go`
- Test: `api/internal/platform/apperr/pg_test.go`
- Create: `api/internal/platform/i18n/i18n.go`
- Create: `api/internal/platform/i18n/catalog.go`
- Create: `api/internal/platform/i18n/messages.zh.json`
- Create: `api/internal/platform/i18n/messages.en.json`
- Create: `api/internal/platform/i18n/messages.km.json`
- Test: `api/internal/platform/i18n/i18n_test.go`
- Test: `api/internal/platform/i18n/catalog_test.go`
- Create: `api/internal/platform/httpx/ctx.go`
- Create: `api/internal/platform/httpx/errors.go`
- Test: `api/internal/platform/httpx/errors_test.go`

**Interfaces:**
- Consumes: 无
- Produces:
  - C3 全部：`apperr.Error`、`apperr.FieldError`、`apperr.New`、`WithField`、`WithParams`、`Wrap`、`apperr.As`、`apperr.RegisterConstraint`、`apperr.FromPG`、16 个 `Code…` 常量
  - 额外：`apperr.AllCodes []string`——全部错误码，供文案完整性测试使用
  - C4 全部：`i18n.Lang`、`i18n.ZH/EN/KM/Default`、`i18n.Parse`、`i18n.FromRequest`、`i18n.Text`、`(i18n.Text).In`、`i18n.Catalog`、`i18n.LoadCatalog`、`(*i18n.Catalog).T`
  - C5 中属于 Task 2 的部分：`httpx.ErrorBody`、`httpx.ErrorPayload`、`httpx.WriteError`
  - 说明：`httpx.LangOf` 与 `httpx.RequestIDOf` 契约上归 Task 4，但 `WriteError` 需要它们，因此提前在本任务的 `ctx.go` 中实现，Task 4 直接复用，不再重复定义。gin 上下文键 `"werun.request_id"`、`"werun.lang"` 在本任务定义为未导出常量。

- [ ] **Step 1: 写 apperr 的失败测试**

`api/internal/platform/apperr/apperr_test.go`：

```go
package apperr_test

import (
	"errors"
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
)

func TestNewAndError(t *testing.T) {
	e := apperr.New(http.StatusConflict, apperr.CodeEventSlugTaken)

	assert.Equal(t, "EVENT_SLUG_TAKEN", e.Code)
	assert.Equal(t, http.StatusConflict, e.Status)
	assert.Equal(t, "EVENT_SLUG_TAKEN", e.Error())
}

func TestWithFieldReturnsCopy(t *testing.T) {
	base := apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)

	withSlug := base.WithField("slug", "field.required", nil)
	withBoth := withSlug.WithField("city", "field.too_long", map[string]any{"max": 80})

	assert.Empty(t, base.Fields)
	assert.Len(t, withSlug.Fields, 1)
	assert.Len(t, withBoth.Fields, 2)
	assert.Equal(t, apperr.FieldError{Key: "field.too_long", Params: map[string]any{"max": 80}}, withBoth.Fields["city"])
}

func TestWithParamsReturnsCopy(t *testing.T) {
	base := apperr.New(http.StatusUnprocessableEntity, apperr.CodeEventCategoryIncomplete)

	withParams := base.WithParams(map[string]any{"missing": "cutoffAt"})

	assert.Nil(t, base.Params)
	assert.Equal(t, "cutoffAt", withParams.Params["missing"])
}

func TestWrapKeepsCauseAndDoesNotMutate(t *testing.T) {
	cause := errors.New("duplicate key")
	base := apperr.New(http.StatusConflict, apperr.CodeEventSlugTaken)

	wrapped := base.Wrap(cause)

	assert.Nil(t, base.Err)
	assert.ErrorIs(t, wrapped, cause)
	assert.Equal(t, "EVENT_SLUG_TAKEN: duplicate key", wrapped.Error())
}

func TestAsFindsErrorThroughWrapping(t *testing.T) {
	inner := apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
	err := fmt.Errorf("load event: %w", inner)

	got, ok := apperr.As(err)

	require.True(t, ok)
	assert.Same(t, inner, got)

	_, ok = apperr.As(errors.New("plain"))
	assert.False(t, ok)
}

func TestAllCodesAreUnique(t *testing.T) {
	seen := map[string]bool{}
	for _, c := range apperr.AllCodes {
		assert.False(t, seen[c], "duplicate code %s", c)
		seen[c] = true
	}
	assert.Len(t, apperr.AllCodes, 16)
}
```

`api/internal/platform/apperr/pg_test.go`：

```go
package apperr_test

import (
	"errors"
	"fmt"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
)

func TestFromPG(t *testing.T) {
	apperr.RegisterConstraint("test_things_slug_key", func() *apperr.Error {
		return apperr.New(http.StatusConflict, apperr.CodeEventSlugTaken).WithField("slug", "field.invalid", nil)
	})

	t.Run("nil stays nil", func(t *testing.T) {
		assert.NoError(t, apperr.FromPG(nil))
	})

	t.Run("non pg error is returned unchanged", func(t *testing.T) {
		plain := errors.New("plain")
		assert.Same(t, plain, apperr.FromPG(plain))
	})

	t.Run("unregistered constraint is returned unchanged", func(t *testing.T) {
		pgErr := &pgconn.PgError{Code: "23505", ConstraintName: "other_key"}
		assert.Same(t, pgErr, apperr.FromPG(pgErr))
	})

	t.Run("registered constraint maps to business error", func(t *testing.T) {
		pgErr := &pgconn.PgError{Code: "23505", ConstraintName: "test_things_slug_key"}

		err := apperr.FromPG(fmt.Errorf("insert: %w", pgErr))

		ae, ok := apperr.As(err)
		require.True(t, ok)
		assert.Equal(t, apperr.CodeEventSlugTaken, ae.Code)
		assert.Contains(t, ae.Fields, "slug")
		var gotPG *pgconn.PgError
		assert.True(t, errors.As(err, &gotPG))
	})
}
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd api && go test ./internal/platform/apperr/... ; cd ..`
Expected: FAIL，编译错误，`apperr.New` 等未定义。

- [ ] **Step 3: 实现 apperr**

`api/internal/platform/apperr/apperr.go`：

```go
// Package apperr 定义带错误码的业务错误。service 与 handler 只返回 *Error，
// 由 httpx.WriteError 统一转换为 HTTP 响应与三语文案。
package apperr

import (
	"errors"
	"maps"
)

// 错误码。每个错误码在 i18n/messages.{zh,en,km}.json 中都有同名文案。
const (
	CodeInternal                = "INTERNAL"
	CodeBadRequest              = "BAD_REQUEST"
	CodeValidation              = "VALIDATION_FAILED"
	CodeUnauthenticated         = "UNAUTHENTICATED"
	CodeForbidden               = "FORBIDDEN"
	CodeCSRF                    = "CSRF_HEADER_MISSING"
	CodeNotFound                = "NOT_FOUND"
	CodeRateLimited             = "RATE_LIMITED"
	CodeInvalidCredentials      = "INVALID_CREDENTIALS"
	CodeAccountLocked           = "ACCOUNT_LOCKED"
	CodeEventNotFound           = "EVENT_NOT_FOUND"
	CodeEventSlugTaken          = "EVENT_SLUG_TAKEN"
	CodeEventCategoryCodeTaken  = "EVENT_CATEGORY_CODE_TAKEN"
	CodeEventAlreadyPublished   = "EVENT_ALREADY_PUBLISHED"
	CodeEventNoCategory         = "EVENT_NO_CATEGORY"
	CodeEventCategoryIncomplete = "EVENT_CATEGORY_INCOMPLETE"
)

// AllCodes 列出全部错误码，供文案完整性测试使用。新增错误码时必须同时加到这里。
var AllCodes = []string{
	CodeInternal,
	CodeBadRequest,
	CodeValidation,
	CodeUnauthenticated,
	CodeForbidden,
	CodeCSRF,
	CodeNotFound,
	CodeRateLimited,
	CodeInvalidCredentials,
	CodeAccountLocked,
	CodeEventNotFound,
	CodeEventSlugTaken,
	CodeEventCategoryCodeTaken,
	CodeEventAlreadyPublished,
	CodeEventNoCategory,
	CodeEventCategoryIncomplete,
}

// FieldError 描述某个字段的错误：文案 key 与参数。
type FieldError struct {
	Key    string
	Params map[string]any
}

// Error 是带错误码与 HTTP 状态的业务错误。
type Error struct {
	Code   string
	Status int
	Fields map[string]FieldError
	Params map[string]any
	Err    error
}

// New 创建错误。status 为 HTTP 状态码，code 取本包 Code… 常量。
func New(status int, code string) *Error {
	return &Error{Code: code, Status: status}
}

func (e *Error) Error() string {
	if e.Err != nil {
		return e.Code + ": " + e.Err.Error()
	}
	return e.Code
}

func (e *Error) Unwrap() error {
	return e.Err
}

func (e *Error) clone() *Error {
	c := *e
	c.Fields = maps.Clone(e.Fields)
	c.Params = maps.Clone(e.Params)
	return &c
}

// WithField 返回附加了字段错误的副本，原错误不变。
func (e *Error) WithField(field, key string, params map[string]any) *Error {
	c := e.clone()
	if c.Fields == nil {
		c.Fields = map[string]FieldError{}
	}
	c.Fields[field] = FieldError{Key: key, Params: params}
	return c
}

// WithParams 返回替换了顶层文案参数的副本，原错误不变。
func (e *Error) WithParams(params map[string]any) *Error {
	c := e.clone()
	c.Params = maps.Clone(params)
	return c
}

// Wrap 返回记录了原始错误的副本。原始错误只进日志，不返回给前端。
func (e *Error) Wrap(err error) *Error {
	c := e.clone()
	c.Err = err
	return c
}

// As 在错误链中查找 *Error。
func As(err error) (*Error, bool) {
	var ae *Error
	if errors.As(err, &ae) {
		return ae, true
	}
	return nil, false
}
```

`api/internal/platform/apperr/pg.go`：

```go
package apperr

import (
	"errors"
	"sync"

	"github.com/jackc/pgx/v5/pgconn"
)

var (
	constraintsMu sync.RWMutex
	constraints   = map[string]func() *Error{}
)

// RegisterConstraint 把数据库约束名映射为业务错误。各模块在 init() 中注册自己的约束。
func RegisterConstraint(constraint string, build func() *Error) {
	constraintsMu.Lock()
	defer constraintsMu.Unlock()
	constraints[constraint] = build
}

// FromPG 把已注册约束触发的 PostgreSQL 错误转换为业务错误（并保留原错误）。
// 非 PostgreSQL 错误、没有约束名或约束未注册时，原样返回。
func FromPG(err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.ConstraintName == "" {
		return err
	}
	constraintsMu.RLock()
	build, ok := constraints[pgErr.ConstraintName]
	constraintsMu.RUnlock()
	if !ok {
		return err
	}
	return build().Wrap(err)
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd api && go test ./internal/platform/apperr/... ; cd ..`
Expected: `ok  	werun/api/internal/platform/apperr`

- [ ] **Step 5: 写 i18n 的失败测试**

`api/internal/platform/i18n/i18n_test.go`：

```go
package i18n

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestParse(t *testing.T) {
	cases := []struct {
		in   string
		want Lang
		ok   bool
	}{
		{"zh", ZH, true},
		{"EN", EN, true},
		{"km-KH", KM, true},
		{"zh_CN", ZH, true},
		{" en-US ", EN, true},
		{"fr", "", false},
		{"", "", false},
	}
	for _, c := range cases {
		got, ok := Parse(c.in)
		assert.Equal(t, c.ok, ok, "input %q", c.in)
		assert.Equal(t, c.want, got, "input %q", c.in)
	}
}

func TestFromRequest(t *testing.T) {
	assert.Equal(t, ZH, FromRequest("zh", "en-US,en;q=0.9"), "query wins")
	assert.Equal(t, EN, FromRequest("fr", "fr-FR,en;q=0.8,km;q=0.5"), "first supported Accept-Language")
	assert.Equal(t, KM, FromRequest("", "km-KH"))
	assert.Equal(t, Default, FromRequest("", "fr-FR,de"))
	assert.Equal(t, Default, FromRequest("", ""))
	assert.Equal(t, KM, Default)
}

func TestTextIn(t *testing.T) {
	full := Text{ZH: "金边半马", EN: "Phnom Penh Half", KM: "ពាក់កណ្តាលម៉ារ៉ាតុងភ្នំពេញ"}
	assert.Equal(t, "ពាក់កណ្តាលម៉ារ៉ាតុងភ្នំពេញ", full.In(KM))

	noKM := Text{ZH: "金边半马", EN: "Phnom Penh Half"}
	assert.Equal(t, "Phnom Penh Half", noKM.In(KM), "falls back to en")

	zhOnly := Text{ZH: "金边半马", EN: ""}
	assert.Equal(t, "金边半马", zhOnly.In(KM), "falls back to zh when en empty")

	assert.Equal(t, "", Text{}.In(ZH))
}
```

`api/internal/platform/i18n/catalog_test.go`：

```go
package i18n

import (
	"testing"
	"testing/fstest"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
)

func mapFS(zh, en, km string) fstest.MapFS {
	return fstest.MapFS{
		"messages.zh.json": {Data: []byte(zh)},
		"messages.en.json": {Data: []byte(en)},
		"messages.km.json": {Data: []byte(km)},
	}
}

func TestLoadCatalogRejectsMismatchedKeys(t *testing.T) {
	fsys := mapFS(
		`{"A":"甲","B":"乙"}`,
		`{"A":"a","B":"b"}`,
		`{"A":"ក"}`,
	)

	_, err := loadCatalog(fsys)

	require.Error(t, err)
	assert.Contains(t, err.Error(), `km missing "B"`)
}

func TestTFallbackAndParams(t *testing.T) {
	cat, err := loadCatalog(mapFS(
		`{"greet":"你好 {name}","only_zh":"只有中文","empty_km":"中文"}`,
		`{"greet":"Hello {name}","only_zh":"","empty_km":"English"}`,
		`{"greet":"សួស្តី {name}","only_zh":"","empty_km":""}`,
	))
	require.NoError(t, err)

	assert.Equal(t, "Hello Dara", cat.T(EN, "greet", map[string]any{"name": "Dara"}))
	assert.Equal(t, "សួស្តី Dara", cat.T(KM, "greet", map[string]any{"name": "Dara"}))
	assert.Equal(t, "English", cat.T(KM, "empty_km", nil), "empty km falls back to en")
	assert.Equal(t, "只有中文", cat.T(KM, "only_zh", nil), "falls back to zh")
	assert.Equal(t, "no.such.key", cat.T(ZH, "no.such.key", nil), "unknown key returns key")
}

func TestEmbeddedCatalogCoversAllCodesAndFieldKeys(t *testing.T) {
	cat, err := LoadCatalog()
	require.NoError(t, err)

	keys := append([]string{}, apperr.AllCodes...)
	keys = append(keys,
		"field.required",
		"field.invalid",
		"field.too_long",
		"field.slug_format",
		"field.category_code_format",
		"field.must_be_positive",
		"field.cutoff_before_start",
		"field.category_incomplete",
	)
	for _, key := range keys {
		for _, l := range []Lang{ZH, EN, KM} {
			assert.NotEqual(t, key, cat.T(l, key, nil), "missing %s for %s", key, l)
		}
	}
	assert.Equal(t, "Must be at most 60 characters.", cat.T(EN, "field.too_long", map[string]any{"max": 60}))
}
```

- [ ] **Step 6: 运行测试，确认失败**

Run: `cd api && go test ./internal/platform/i18n/... ; cd ..`
Expected: FAIL，编译错误，`Parse`、`loadCatalog` 等未定义。

- [ ] **Step 7: 实现 i18n 与三语文案**

`api/internal/platform/i18n/i18n.go`：

```go
// Package i18n 提供中文、英文、高棉文三语支持：语言解析、多语言文本与错误文案目录。
package i18n

import "strings"

// Lang 是受支持的语言代码。
type Lang string

const (
	ZH      Lang = "zh"
	EN      Lang = "en"
	KM      Lang = "km"
	Default      = KM
)

var allLangs = []Lang{ZH, EN, KM}

// Parse 解析语言代码，大小写不敏感，接受 zh-CN、km_KH 这类带地区的写法。
func Parse(s string) (Lang, bool) {
	s = strings.ToLower(strings.TrimSpace(s))
	if i := strings.IndexAny(s, "-_"); i >= 0 {
		s = s[:i]
	}
	switch l := Lang(s); l {
	case ZH, EN, KM:
		return l, true
	}
	return "", false
}

// FromRequest 按 ?lang= → Accept-Language（按出现顺序取第一个受支持的）→ Default 的顺序确定语言。
func FromRequest(queryLang, acceptLanguage string) Lang {
	if l, ok := Parse(queryLang); ok {
		return l
	}
	for _, part := range strings.Split(acceptLanguage, ",") {
		tag, _, _ := strings.Cut(part, ";")
		if l, ok := Parse(tag); ok {
			return l
		}
	}
	return Default
}

// Text 是一段三语文本，JSON 形如 {"zh":"…","en":"…","km":"…"}。
type Text map[Lang]string

// In 返回指定语言的文本；为空时依次回退到英文、中文，都没有时返回空字符串。
func (t Text) In(l Lang) string {
	for _, candidate := range []Lang{l, EN, ZH} {
		if v := t[candidate]; v != "" {
			return v
		}
	}
	return ""
}
```

`api/internal/platform/i18n/catalog.go`：

```go
package i18n

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"slices"
	"strings"
)

//go:embed messages.zh.json messages.en.json messages.km.json
var messagesFS embed.FS

// Catalog 是错误文案目录。
type Catalog struct {
	msgs map[Lang]map[string]string
}

// LoadCatalog 读取内置的三语文案；三份文件 key 集合不一致时返回错误。
func LoadCatalog() (*Catalog, error) {
	return loadCatalog(messagesFS)
}

func loadCatalog(fsys fs.FS) (*Catalog, error) {
	c := &Catalog{msgs: make(map[Lang]map[string]string, len(allLangs))}
	union := map[string]struct{}{}
	for _, l := range allLangs {
		data, err := fs.ReadFile(fsys, "messages."+string(l)+".json")
		if err != nil {
			return nil, fmt.Errorf("i18n: read %s messages: %w", l, err)
		}
		m := map[string]string{}
		if err := json.Unmarshal(data, &m); err != nil {
			return nil, fmt.Errorf("i18n: parse %s messages: %w", l, err)
		}
		c.msgs[l] = m
		for k := range m {
			union[k] = struct{}{}
		}
	}

	keys := make([]string, 0, len(union))
	for k := range union {
		keys = append(keys, k)
	}
	slices.Sort(keys)

	var problems []string
	for _, k := range keys {
		for _, l := range allLangs {
			if _, ok := c.msgs[l][k]; !ok {
				problems = append(problems, fmt.Sprintf("%s missing %q", l, k))
			}
		}
	}
	if len(problems) > 0 {
		return nil, fmt.Errorf("i18n: message key sets differ: %s", strings.Join(problems, "; "))
	}
	return c, nil
}

// T 返回文案。依次尝试 l、英文、中文，均无（或为空）时返回 key 本身；
// 文案中的 {name} 会被 params["name"] 替换。
func (c *Catalog) T(l Lang, key string, params map[string]any) string {
	msg := key
	for _, candidate := range []Lang{l, EN, ZH} {
		if v := c.msgs[candidate][key]; v != "" {
			msg = v
			break
		}
	}
	for name, value := range params {
		msg = strings.ReplaceAll(msg, "{"+name+"}", fmt.Sprint(value))
	}
	return msg
}
```

`api/internal/platform/i18n/messages.zh.json`：

```json
{
  "INTERNAL": "服务器出错了，请稍后再试。",
  "BAD_REQUEST": "请求格式不正确。",
  "VALIDATION_FAILED": "请检查标出的字段。",
  "UNAUTHENTICATED": "请先登录。",
  "FORBIDDEN": "你没有执行这个操作的权限。",
  "CSRF_HEADER_MISSING": "请求缺少客户端标识，请刷新页面后重试。",
  "NOT_FOUND": "找不到请求的内容。",
  "RATE_LIMITED": "操作太频繁，请稍后再试。",
  "INVALID_CREDENTIALS": "用户名或密码不正确。",
  "ACCOUNT_LOCKED": "登录失败次数过多，账号已锁定 15 分钟。",
  "EVENT_NOT_FOUND": "找不到这场赛事。",
  "EVENT_SLUG_TAKEN": "这个网址标识已被其他赛事使用。",
  "EVENT_CATEGORY_CODE_TAKEN": "同一赛事里的组别代码不能重复。",
  "EVENT_ALREADY_PUBLISHED": "这场赛事已经发布过了。",
  "EVENT_NO_CATEGORY": "至少添加一个组别后才能发布。",
  "EVENT_CATEGORY_INCOMPLETE": "有组别信息不完整，补全后才能发布。",
  "field.required": "必填。",
  "field.invalid": "格式不正确。",
  "field.too_long": "不能超过 {max} 个字符。",
  "field.slug_format": "只能使用小写字母、数字和连字符，例如 phnom-penh-half-2026。",
  "field.category_code_format": "只能使用大写字母和数字，最多 10 位，例如 21K。",
  "field.must_be_positive": "必须大于 0。",
  "field.cutoff_before_start": "关门时间必须晚于发枪时间。",
  "field.category_incomplete": "缺少：{missing}。"
}
```

`api/internal/platform/i18n/messages.en.json`：

```json
{
  "INTERNAL": "Something went wrong on our side. Please try again later.",
  "BAD_REQUEST": "The request is malformed.",
  "VALIDATION_FAILED": "Please check the highlighted fields.",
  "UNAUTHENTICATED": "Please sign in first.",
  "FORBIDDEN": "You don't have permission to do this.",
  "CSRF_HEADER_MISSING": "The request is missing the client header. Refresh the page and try again.",
  "NOT_FOUND": "The requested resource was not found.",
  "RATE_LIMITED": "Too many attempts. Please wait a moment and try again.",
  "INVALID_CREDENTIALS": "Incorrect username or password.",
  "ACCOUNT_LOCKED": "Too many failed sign-in attempts. This account is locked for 15 minutes.",
  "EVENT_NOT_FOUND": "This event could not be found.",
  "EVENT_SLUG_TAKEN": "This URL slug is already used by another event.",
  "EVENT_CATEGORY_CODE_TAKEN": "Category codes must be unique within an event.",
  "EVENT_ALREADY_PUBLISHED": "This event has already been published.",
  "EVENT_NO_CATEGORY": "Add at least one category before publishing.",
  "EVENT_CATEGORY_INCOMPLETE": "Some categories are incomplete. Complete them before publishing.",
  "field.required": "Required.",
  "field.invalid": "Invalid value.",
  "field.too_long": "Must be at most {max} characters.",
  "field.slug_format": "Use lowercase letters, numbers and hyphens, e.g. phnom-penh-half-2026.",
  "field.category_code_format": "Use up to 10 uppercase letters or digits, e.g. 21K.",
  "field.must_be_positive": "Must be greater than 0.",
  "field.cutoff_before_start": "Cut-off time must be after the start time.",
  "field.category_incomplete": "Missing: {missing}."
}
```

`api/internal/platform/i18n/messages.km.json`（高棉文为初稿，合并前需请柬埔寨本地同事校对；校对只改文案，不改 key）：

```json
{
  "INTERNAL": "មានបញ្ហានៅលើប្រព័ន្ធ។ សូមព្យាយាមម្តងទៀតនៅពេលក្រោយ។",
  "BAD_REQUEST": "សំណើមិនត្រឹមត្រូវ។",
  "VALIDATION_FAILED": "សូមពិនិត្យវាលដែលបានសម្គាល់។",
  "UNAUTHENTICATED": "សូមចូលគណនីជាមុនសិន។",
  "FORBIDDEN": "អ្នកមិនមានសិទ្ធិធ្វើសកម្មភាពនេះទេ។",
  "CSRF_HEADER_MISSING": "សំណើខ្វះព័ត៌មានកម្មវិធី។ សូមផ្ទុកទំព័រឡើងវិញ ហើយព្យាយាមម្តងទៀត។",
  "NOT_FOUND": "រកមិនឃើញអ្វីដែលអ្នកស្នើសុំទេ។",
  "RATE_LIMITED": "ព្យាយាមញឹកញាប់ពេក។ សូមរង់ចាំបន្តិច ហើយព្យាយាមម្តងទៀត។",
  "INVALID_CREDENTIALS": "ឈ្មោះអ្នកប្រើ ឬពាក្យសម្ងាត់មិនត្រឹមត្រូវ។",
  "ACCOUNT_LOCKED": "ចូលគណនីបរាជ័យច្រើនដងពេក។ គណនីនេះត្រូវបានចាក់សោរយៈពេល 15 នាទី។",
  "EVENT_NOT_FOUND": "រកមិនឃើញព្រឹត្តិការណ៍នេះទេ។",
  "EVENT_SLUG_TAKEN": "ស្លាក URL នេះត្រូវបានប្រើដោយព្រឹត្តិការណ៍ផ្សេងរួចហើយ។",
  "EVENT_CATEGORY_CODE_TAKEN": "លេខកូដប្រភេទមិនអាចស្ទួនគ្នាក្នុងព្រឹត្តិការណ៍តែមួយបានទេ។",
  "EVENT_ALREADY_PUBLISHED": "ព្រឹត្តិការណ៍នេះត្រូវបានផ្សព្វផ្សាយរួចហើយ។",
  "EVENT_NO_CATEGORY": "សូមបន្ថែមប្រភេទយ៉ាងហោចណាស់មួយ មុនពេលផ្សព្វផ្សាយ។",
  "EVENT_CATEGORY_INCOMPLETE": "ប្រភេទមួយចំនួនមិនទាន់ពេញលេញ។ សូមបំពេញមុនពេលផ្សព្វផ្សាយ។",
  "field.required": "ត្រូវតែបំពេញ។",
  "field.invalid": "តម្លៃមិនត្រឹមត្រូវ។",
  "field.too_long": "មិនអាចលើសពី {max} តួអក្សរ។",
  "field.slug_format": "ប្រើតែអក្សរតូច លេខ និងសញ្ញា - ឧទាហរណ៍ phnom-penh-half-2026។",
  "field.category_code_format": "ប្រើអក្សរធំ ឬលេខ មិនលើស 10 តួ ឧទាហរណ៍ 21K។",
  "field.must_be_positive": "ត្រូវតែធំជាង 0។",
  "field.cutoff_before_start": "ម៉ោងបិទត្រូវតែក្រោយម៉ោងចាប់ផ្តើម។",
  "field.category_incomplete": "ខ្វះ៖ {missing}។"
}
```

- [ ] **Step 8: 运行测试，确认通过**

Run: `cd api && go test ./internal/platform/i18n/... ; cd ..`
Expected: `ok  	werun/api/internal/platform/i18n`

- [ ] **Step 9: 写错误响应渲染的失败测试**

`api/internal/platform/httpx/errors_test.go`：

```go
package httpx_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
)

func serveError(t *testing.T, lang i18n.Lang, handlerErr error) (*httptest.ResponseRecorder, *bytes.Buffer) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	cat, err := i18n.LoadCatalog()
	require.NoError(t, err)
	var logBuf bytes.Buffer
	log := slog.New(slog.NewJSONHandler(&logBuf, nil))

	r := gin.New()
	r.GET("/x", func(c *gin.Context) {
		c.Set("werun.lang", lang)
		c.Set("werun.request_id", "req-1")
		httpx.WriteError(c, cat, log, handlerErr)
	})
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x", nil))
	return rec, &logBuf
}

func decode(t *testing.T, rec *httptest.ResponseRecorder) httpx.ErrorBody {
	t.Helper()
	var body httpx.ErrorBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	return body
}

func TestWriteErrorRendersLocalizedFields(t *testing.T) {
	err := apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation).
		WithField("slug", "field.too_long", map[string]any{"max": 60})

	rec, _ := serveError(t, i18n.ZH, err)

	assert.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	body := decode(t, rec)
	assert.Equal(t, "VALIDATION_FAILED", body.Error.Code)
	assert.Equal(t, "请检查标出的字段。", body.Error.Message)
	assert.Equal(t, map[string]string{"slug": "不能超过 60 个字符。"}, body.Error.Fields)
}

func TestWriteErrorFindsWrappedAppError(t *testing.T) {
	err := fmt.Errorf("create event: %w", apperr.New(http.StatusConflict, apperr.CodeEventSlugTaken))

	rec, _ := serveError(t, i18n.EN, err)

	assert.Equal(t, http.StatusConflict, rec.Code)
	body := decode(t, rec)
	assert.Equal(t, "EVENT_SLUG_TAKEN", body.Error.Code)
	assert.Equal(t, "This URL slug is already used by another event.", body.Error.Message)
	assert.Nil(t, body.Error.Fields)
}

func TestWriteErrorHidesUnknownErrors(t *testing.T) {
	rec, logBuf := serveError(t, i18n.EN, errors.New("boom: connection refused"))

	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	body := decode(t, rec)
	assert.Equal(t, "INTERNAL", body.Error.Code)
	assert.NotContains(t, rec.Body.String(), "connection refused")
	assert.Contains(t, logBuf.String(), "connection refused")
	assert.Contains(t, logBuf.String(), "req-1")
}
```

- [ ] **Step 10: 运行测试，确认失败**

Run: `cd api && go test ./internal/platform/httpx/... ; cd ..`
Expected: FAIL，编译错误，`httpx.WriteError`、`httpx.ErrorBody` 未定义。

- [ ] **Step 11: 实现 ctx 取值与错误渲染**

`api/internal/platform/httpx/ctx.go`：

```go
// Package httpx 提供 HTTP 层的公共能力：中间件、请求上下文取值与错误响应渲染。
package httpx

import (
	"context"

	"werun/api/internal/platform/i18n"
)

// gin 上下文键。gin.Context.Value 对字符串键会读取 c.Get 的值。
const (
	keyRequestID = "werun.request_id"
	keyLang      = "werun.lang"
)

// LangOf 返回当前请求的语言；没有设置时返回 i18n.Default。
func LangOf(ctx context.Context) i18n.Lang {
	if ctx != nil {
		if l, ok := ctx.Value(keyLang).(i18n.Lang); ok {
			return l
		}
	}
	return i18n.Default
}

// RequestIDOf 返回当前请求的请求 ID；没有设置时返回空字符串。
func RequestIDOf(ctx context.Context) string {
	if ctx != nil {
		if id, ok := ctx.Value(keyRequestID).(string); ok {
			return id
		}
	}
	return ""
}
```

`api/internal/platform/httpx/errors.go`：

```go
package httpx

import (
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/i18n"
)

// ErrorBody 是所有错误响应的 JSON 结构。
type ErrorBody struct {
	Error ErrorPayload `json:"error"`
}

// ErrorPayload 是错误详情。Message 与 Fields 的值均已按请求语言本地化。
type ErrorPayload struct {
	Code    string            `json:"code"`
	Message string            `json:"message"`
	Fields  map[string]string `json:"fields,omitempty"`
}

// WriteError 把错误写成 JSON 响应并中止请求。
// *apperr.Error 使用自身的状态码与文案；其它错误一律返回 500 INTERNAL，
// 原始错误只写日志，不暴露给前端。
func WriteError(c *gin.Context, cat *i18n.Catalog, log *slog.Logger, err error) {
	ae, ok := apperr.As(err)
	switch {
	case !ok:
		log.ErrorContext(c, "unhandled error",
			"error", err, "request_id", RequestIDOf(c), "path", c.Request.URL.Path)
		ae = apperr.New(http.StatusInternalServerError, apperr.CodeInternal)
	case ae.Status >= http.StatusInternalServerError:
		log.ErrorContext(c, "server error",
			"error", err, "code", ae.Code, "request_id", RequestIDOf(c), "path", c.Request.URL.Path)
	}

	lang := LangOf(c)
	body := ErrorBody{Error: ErrorPayload{
		Code:    ae.Code,
		Message: cat.T(lang, ae.Code, ae.Params),
	}}
	if len(ae.Fields) > 0 {
		body.Error.Fields = make(map[string]string, len(ae.Fields))
		for field, fe := range ae.Fields {
			body.Error.Fields[field] = cat.T(lang, fe.Key, fe.Params)
		}
	}
	c.AbortWithStatusJSON(ae.Status, body)
}
```

- [ ] **Step 12: 运行测试，确认通过**

Run: `cd api && go test ./internal/platform/... ; cd ..`
Expected: `apperr`、`config`、`httpx`、`i18n`、`logx`、`money` 全部 `ok`。

- [ ] **Step 13: lint 并提交**

Run: `make lint-api`
Expected: `0 issues.`

```bash
git add api/internal/platform/apperr api/internal/platform/i18n api/internal/platform/httpx
git commit -F - <<'EOF'
feat(api): add error codes, trilingual messages and error rendering

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
```

---
### Task 3: 数据库连接、迁移与测试数据库

**Files:**
- Move: `docs/database/migrations/` → `api/db/migrations/`（git mv）
- Move: `docs/database/tests/` → `api/db/tests/`（git mv）
- Modify: `api/db/migrations/0001_foundation.sql`、`0003_registration.sql`、`0006_refunds.sql`（给 plpgsql 函数加 goose 语句块注解）
- Create: `api/db/embed.go`
- Test: `api/db/invariants_test.go`
- Create: `api/internal/platform/db/db.go`
- Test: `api/internal/platform/db/db_test.go`
- Create: `api/internal/platform/migrate/migrate.go`
- Test: `api/internal/platform/migrate/migrate_test.go`
- Create: `api/internal/platform/dbtest/dbtest.go`
- Modify: `docs/database/db-design.html`（第 170 行迁移路径）
- Modify: `docs/superpowers/specs/2026-09-13-scaffold-design.md`（第 50 行、第 190 行 River 迁移说明）

**Interfaces:**
- Consumes: 无（只依赖第三方库）
- Produces:
  - `werun/api/db`：`db.Migrations embed.FS`、`db.InvariantsSQL string`
  - `werun/api/internal/platform/db`：`db.Open(ctx, url) (*pgxpool.Pool, error)`、`db.InTx(ctx, pool, func(pgx.Tx) error) error`
  - `migrate.Up(ctx, pool, log) error`、`migrate.Down(ctx, pool, log) error`、`migrate.Status(ctx, pool) ([]string, error)`
  - `dbtest.NewPool(t testing.TB) *pgxpool.Pool`
- 与契约 C6 的一处差异：模板库名为 `werun_template_<进程号>` 而不是固定的 `werun_template`。原因：多个测试包是并行的独立进程，当设置了 `WERUN_TEST_DATABASE_URL`（多个进程共用同一个实例）时，固定名字会让不同进程互相删除对方的模板库。

背景知识（给没用过这些库的实现者）：
- goose 按分号切分 SQL 语句。plpgsql 函数体内部也有分号，必须用 `-- +goose StatementBegin` / `-- +goose StatementEnd` 包起来，否则会报 `unterminated dollar-quoted string`。数据库设计阶段是用 psql 执行的，所以原文件没有这些注解。
- 迁移文件只有 `-- +goose Up`，没有 Down 段。`migrate down` 只会把最新版本从 `goose_db_version` 中删掉，**不会**删表；本地要回退结构请直接重建数据库。
- `stdlib.OpenDBFromPool` 返回的 `*sql.DB` 关闭时不会关闭底层连接池。
- pgx 的 `Exec` 在没有参数时使用 simple protocol，可以一次执行包含多条语句的脚本（约束测试脚本就是这样执行的）。
- 集成测试依赖 testcontainers 启动 `postgres:16-alpine`，本机需要运行 Docker。容器在测试进程退出后由 testcontainers 的 Ryuk 容器自动清理。

- [ ] **Step 1: 移动迁移文件与约束测试脚本**

```bash
mkdir -p api/db
git mv docs/database/migrations api/db/migrations
git mv docs/database/tests api/db/tests
ls api/db/migrations api/db/tests
```

Expected：`api/db/migrations` 下 9 个 `000N_*.sql`，`api/db/tests` 下 `invariants_test.sql`。

- [ ] **Step 2: 写全部失败测试**

`api/internal/platform/db/db_test.go`：

```go
package db_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/db"
	"werun/api/internal/platform/dbtest"
)

func countSetting(t *testing.T, pool *pgxpool.Pool, key string) int {
	t.Helper()
	var n int
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT count(*) FROM system_settings WHERE key = $1`, key).Scan(&n))
	return n
}

func insertSetting(ctx context.Context, tx pgx.Tx, key string) error {
	_, err := tx.Exec(ctx, `INSERT INTO system_settings (key, value) VALUES ($1, '1')`, key)
	return err
}

func TestOpenFailsForUnreachableDatabase(t *testing.T) {
	_, err := db.Open(context.Background(), "postgres://nobody:nobody@127.0.0.1:1/none?connect_timeout=1&sslmode=disable")

	assert.Error(t, err)
}

func TestInTxCommits(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()

	err := db.InTx(ctx, pool, func(tx pgx.Tx) error {
		return insertSetting(ctx, tx, "test.commit")
	})

	require.NoError(t, err)
	assert.Equal(t, 1, countSetting(t, pool, "test.commit"))
}

func TestInTxRollsBackOnError(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()
	stop := errors.New("stop")

	err := db.InTx(ctx, pool, func(tx pgx.Tx) error {
		if err := insertSetting(ctx, tx, "test.error"); err != nil {
			return err
		}
		return stop
	})

	assert.ErrorIs(t, err, stop)
	assert.Equal(t, 0, countSetting(t, pool, "test.error"))
}

func TestInTxRollsBackOnPanic(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()

	assert.PanicsWithValue(t, "boom", func() {
		_ = db.InTx(ctx, pool, func(tx pgx.Tx) error {
			if err := insertSetting(ctx, tx, "test.panic"); err != nil {
				return err
			}
			panic("boom")
		})
	})
	assert.Equal(t, 0, countSetting(t, pool, "test.panic"))
}
```

`api/internal/platform/migrate/migrate_test.go`：

```go
package migrate_test

import (
	"context"
	"log/slog"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/migrate"
)

func TestUpCreatesBusinessAndRiverTables(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()

	var business int
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT count(*) FROM information_schema.tables
		WHERE table_schema = 'public'
		  AND table_type = 'BASE TABLE'
		  AND table_name NOT LIKE 'river\_%'
		  AND table_name <> 'goose_db_version'`).Scan(&business))
	assert.Equal(t, 69, business)

	var hasRiverJob bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT to_regclass('public.river_job') IS NOT NULL`).Scan(&hasRiverJob))
	assert.True(t, hasRiverJob)
}

func TestStatusListsEveryMigrationAsApplied(t *testing.T) {
	pool := dbtest.NewPool(t)

	lines, err := migrate.Status(context.Background(), pool)

	require.NoError(t, err)
	require.Len(t, lines, 9)
	assert.Equal(t, "0001_foundation.sql applied", lines[0])
	for _, line := range lines {
		assert.True(t, strings.HasSuffix(line, " applied"), line)
	}
}

func TestUpIsIdempotent(t *testing.T) {
	pool := dbtest.NewPool(t)

	err := migrate.Up(context.Background(), pool, slog.New(slog.DiscardHandler))

	assert.NoError(t, err)
}

func TestDownUnmarksLatestVersion(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()

	require.NoError(t, migrate.Down(ctx, pool, slog.New(slog.DiscardHandler)))

	lines, err := migrate.Status(ctx, pool)
	require.NoError(t, err)
	assert.Equal(t, "0009_content_community.sql pending", lines[len(lines)-1])
	assert.Equal(t, "0008_results_photos.sql applied", lines[len(lines)-2])
}
```

`api/db/invariants_test.go`：

```go
package db_test

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/db"
	"werun/api/internal/platform/dbtest"
)

// stripPsqlMeta 去掉 psql 元命令（以 \ 开头的行），pgx 不认识这些命令。
func stripPsqlMeta(script string) string {
	lines := strings.Split(script, "\n")
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), `\`) {
			continue
		}
		kept = append(kept, line)
	}
	return strings.Join(kept, "\n")
}

// TestInvariants 执行 db/tests/invariants_test.sql。脚本在事务里构造数据、
// 逐条触发数据库约束并 ROLLBACK，用 RAISE NOTICE 输出 PASS / FAIL。
// 脚本新增用例时同步修改期望的 PASS 数量。
func TestInvariants(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()

	var mu sync.Mutex
	var notices []string
	cfg := pool.Config().ConnConfig.Copy()
	cfg.OnNotice = func(_ *pgconn.PgConn, n *pgconn.Notice) {
		mu.Lock()
		defer mu.Unlock()
		notices = append(notices, n.Message)
	}
	conn, err := pgx.ConnectConfig(ctx, cfg)
	require.NoError(t, err)
	defer conn.Close(ctx)

	_, err = conn.Exec(ctx, stripPsqlMeta(db.InvariantsSQL))
	require.NoError(t, err)

	mu.Lock()
	defer mu.Unlock()
	var passed int
	var failed []string
	for _, msg := range notices {
		switch {
		case strings.HasPrefix(msg, "PASS"):
			passed++
		case strings.HasPrefix(msg, "FAIL"):
			failed = append(failed, msg)
		}
	}
	assert.Empty(t, failed)
	assert.Equal(t, 23, passed)
}
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `cd api && go test ./db/... ./internal/platform/db/... ./internal/platform/migrate/... ; cd ..`
Expected: FAIL，编译错误：`werun/api/internal/platform/dbtest` 包不存在、`db.InvariantsSQL`、`migrate.Status` 等未定义。

- [ ] **Step 4: 实现 embed、连接、迁移与测试数据库工具**

`api/db/embed.go`：

```go
// Package db 内嵌数据库迁移文件与约束测试脚本，供迁移命令和测试使用。
package db

import "embed"

// Migrations 包含 migrations/*.sql（goose 格式）。
//
//go:embed migrations/*.sql
var Migrations embed.FS

// InvariantsSQL 是数据库约束测试脚本（为 psql 编写，首行含 psql 元命令）。
//
//go:embed tests/invariants_test.sql
var InvariantsSQL string
```

`api/internal/platform/db/db.go`：

```go
// Package db 提供 PostgreSQL 连接池与事务工具。
package db

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Open 创建连接池并立即 Ping，确保数据库可用。
func Open(ctx context.Context, url string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse database url: %w", err)
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return pool, nil
}

// InTx 在事务中执行 fn。fn 返回错误或 panic 时回滚（panic 会继续向上抛出），否则提交。
// 审计记录与 River 任务都应在同一个 fn 内写入，与业务数据一起提交或回滚。
func InTx(ctx context.Context, pool *pgxpool.Pool, fn func(tx pgx.Tx) error) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	// 回滚不受调用方 ctx 取消的影响，避免连接带着未结束的事务回到连接池。
	rollbackCtx := context.WithoutCancel(ctx)

	defer func() {
		if p := recover(); p != nil {
			_ = tx.Rollback(rollbackCtx)
			panic(p)
		}
	}()

	if err := fn(tx); err != nil {
		if rbErr := tx.Rollback(rollbackCtx); rbErr != nil && !errors.Is(rbErr, pgx.ErrTxClosed) {
			return errors.Join(err, fmt.Errorf("rollback: %w", rbErr))
		}
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit tx: %w", err)
	}
	return nil
}
```

`api/internal/platform/migrate/migrate.go`：

```go
// Package migrate 执行数据库迁移：先执行 goose 业务迁移（db/migrations），再执行 River 自带迁移。
package migrate

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"log/slog"
	"path/filepath"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivermigrate"

	"werun/api/db"
)

func newProvider(pool *pgxpool.Pool, log *slog.Logger) (*goose.Provider, *sql.DB, error) {
	migrations, err := fs.Sub(db.Migrations, "migrations")
	if err != nil {
		return nil, nil, fmt.Errorf("open embedded migrations: %w", err)
	}
	sqlDB := stdlib.OpenDBFromPool(pool)
	provider, err := goose.NewProvider(goose.DialectPostgres, sqlDB, migrations, goose.WithSlog(log))
	if err != nil {
		_ = sqlDB.Close()
		return nil, nil, fmt.Errorf("create goose provider: %w", err)
	}
	return provider, sqlDB, nil
}

// Up 执行全部未执行的业务迁移，然后执行 River 迁移。重复执行是安全的。
func Up(ctx context.Context, pool *pgxpool.Pool, log *slog.Logger) error {
	provider, sqlDB, err := newProvider(pool, log)
	if err != nil {
		return err
	}
	defer sqlDB.Close()

	results, err := provider.Up(ctx)
	if err != nil {
		return fmt.Errorf("goose up: %w", err)
	}
	for _, r := range results {
		log.InfoContext(ctx, "migration applied", "file", filepath.Base(r.Source.Path), "duration", r.Duration)
	}

	migrator, err := rivermigrate.New(riverpgxv5.New(pool), &rivermigrate.Config{Logger: log})
	if err != nil {
		return fmt.Errorf("create river migrator: %w", err)
	}
	res, err := migrator.Migrate(ctx, rivermigrate.DirectionUp, nil)
	if err != nil {
		return fmt.Errorf("river migrate up: %w", err)
	}
	for _, v := range res.Versions {
		log.InfoContext(ctx, "river migration applied", "version", v.Version, "name", v.Name)
	}
	return nil
}

// Down 把最新的业务迁移标记为未执行。迁移文件没有 Down 段，因此不会删除任何表；
// 本地需要回退结构时请重建数据库。River 迁移不受影响。
func Down(ctx context.Context, pool *pgxpool.Pool, log *slog.Logger) error {
	provider, sqlDB, err := newProvider(pool, log)
	if err != nil {
		return err
	}
	defer sqlDB.Close()

	result, err := provider.Down(ctx)
	if err != nil {
		return fmt.Errorf("goose down: %w", err)
	}
	log.InfoContext(ctx, "migration rolled back", "file", filepath.Base(result.Source.Path))
	return nil
}

// Status 返回每个业务迁移的状态，每行形如 "0001_foundation.sql applied"。
func Status(ctx context.Context, pool *pgxpool.Pool) ([]string, error) {
	provider, sqlDB, err := newProvider(pool, slog.New(slog.DiscardHandler))
	if err != nil {
		return nil, err
	}
	defer sqlDB.Close()

	statuses, err := provider.Status(ctx)
	if err != nil {
		return nil, fmt.Errorf("goose status: %w", err)
	}
	lines := make([]string, 0, len(statuses))
	for _, s := range statuses {
		lines = append(lines, fmt.Sprintf("%s %s", filepath.Base(s.Source.Path), s.State))
	}
	return lines, nil
}
```

`api/internal/platform/dbtest/dbtest.go`：

```go
// Package dbtest 为集成测试提供彼此隔离、已执行全部迁移的 PostgreSQL 数据库。
//
// 同一测试进程只启动一个 postgres:16-alpine 容器，首次调用时建模板库并执行迁移；
// 之后每次 NewPool 都从模板库复制出一个新库，测试结束时删除。
// 设置 WERUN_TEST_DATABASE_URL（指向实例的维护库，如 postgres://u:p@host:5432/postgres）时不启动容器。
package dbtest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	"werun/api/internal/platform/db"
	"werun/api/internal/platform/migrate"
)

var (
	setupOnce    sync.Once
	adminURL     string
	templateName string
	setupErr     error
)

// NewPool 返回连接到一个全新测试库的连接池，测试结束时自动关闭并删库。
func NewPool(t testing.TB) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()

	setupOnce.Do(func() {
		adminURL, templateName, setupErr = setup(ctx)
	})
	if setupErr != nil {
		t.Fatalf("dbtest: set up postgres: %v", setupErr)
	}

	name := "werun_test_" + randomSuffix()
	if err := execAdmin(ctx, adminURL, "CREATE DATABASE "+name+" TEMPLATE "+templateName); err != nil {
		t.Fatalf("dbtest: create database %s: %v", name, err)
	}
	dbURL, err := withDatabase(adminURL, name)
	if err != nil {
		t.Fatalf("dbtest: build url: %v", err)
	}
	pool, err := db.Open(ctx, dbURL)
	if err != nil {
		t.Fatalf("dbtest: open %s: %v", name, err)
	}
	t.Cleanup(func() {
		pool.Close()
		if err := execAdmin(context.Background(), adminURL, "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)"); err != nil {
			t.Logf("dbtest: drop database %s: %v", name, err)
		}
	})
	return pool
}

func setup(ctx context.Context) (string, string, error) {
	baseURL := os.Getenv("WERUN_TEST_DATABASE_URL")
	if baseURL == "" {
		container, err := postgres.Run(ctx, "postgres:16-alpine",
			postgres.WithDatabase("postgres"),
			postgres.WithUsername("werun"),
			postgres.WithPassword("werun"),
			postgres.BasicWaitStrategies(),
		)
		if err != nil {
			return "", "", fmt.Errorf("start postgres container: %w", err)
		}
		baseURL, err = container.ConnectionString(ctx, "sslmode=disable")
		if err != nil {
			return "", "", fmt.Errorf("container connection string: %w", err)
		}
	}

	template := fmt.Sprintf("werun_template_%d", os.Getpid())
	if err := execAdmin(ctx, baseURL, "DROP DATABASE IF EXISTS "+template+" WITH (FORCE)"); err != nil {
		return "", "", fmt.Errorf("drop old template: %w", err)
	}
	if err := execAdmin(ctx, baseURL, "CREATE DATABASE "+template); err != nil {
		return "", "", fmt.Errorf("create template: %w", err)
	}
	templateURL, err := withDatabase(baseURL, template)
	if err != nil {
		return "", "", err
	}
	pool, err := db.Open(ctx, templateURL)
	if err != nil {
		return "", "", fmt.Errorf("open template: %w", err)
	}
	// 必须在复制前关闭：有连接连着模板库时 CREATE DATABASE ... TEMPLATE 会失败。
	defer pool.Close()
	if err := migrate.Up(ctx, pool, slog.New(slog.DiscardHandler)); err != nil {
		return "", "", fmt.Errorf("migrate template: %w", err)
	}
	return baseURL, template, nil
}

func execAdmin(ctx context.Context, connURL, statement string) error {
	conn, err := pgx.Connect(ctx, connURL)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	_, err = conn.Exec(ctx, statement)
	return err
}

func withDatabase(connURL, name string) (string, error) {
	u, err := url.Parse(connURL)
	if err != nil {
		return "", fmt.Errorf("parse database url: %w", err)
	}
	u.Path = "/" + name
	return u.String(), nil
}

func randomSuffix() string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
```

- [ ] **Step 5: 运行测试，确认因 goose 切分函数体而失败**

Run: `cd api && go test ./internal/platform/migrate/... ; cd ..`
Expected: FAIL，`dbtest: set up postgres: migrate template: goose up: ...`，错误信息包含 `unterminated dollar-quoted string`（goose 在 `set_updated_at` 函数体中的分号处切断了语句）。

- [ ] **Step 6: 给 5 个 plpgsql 函数加 goose 语句块注解**

```bash
perl -0pi -e 's/^(CREATE OR REPLACE FUNCTION )/-- +goose StatementBegin\n$1/mg; s/^(END \$\$ LANGUAGE plpgsql;)$/$1\n-- +goose StatementEnd/mg' \
  api/db/migrations/0001_foundation.sql \
  api/db/migrations/0003_registration.sql \
  api/db/migrations/0006_refunds.sql
grep -c "+goose StatementBegin" api/db/migrations/0001_foundation.sql api/db/migrations/0003_registration.sql api/db/migrations/0006_refunds.sql
grep -c "+goose StatementEnd" api/db/migrations/0001_foundation.sql api/db/migrations/0003_registration.sql api/db/migrations/0006_refunds.sql
```

Expected：两次 grep 输出都是 `0001_foundation.sql:2`、`0003_registration.sql:2`、`0006_refunds.sql:1`。修改后 `0001_foundation.sql` 开头的函数形如：

```sql
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
-- +goose StatementEnd
```

- [ ] **Step 7: 运行测试，确认通过**

Run: `cd api && go test ./db/... ./internal/platform/... ; cd ..`
Expected: 全部 `ok`，其中 `werun/api/db`（约束测试 23 条 PASS）、`internal/platform/db`、`internal/platform/migrate` 需要数十秒拉起容器。

- [ ] **Step 8: 同步文档中的路径与 River 迁移说明**

```bash
perl -pi -e 's{<code>docs/database/migrations/0001…0009_\*\.sql</code>}{<code>api/db/migrations/0001…0009_*.sql</code>}' docs/database/db-design.html
perl -pi -e 's{goose 迁移（由 docs/database/migrations 移入）\+ River 表迁移}{goose 迁移（由 docs/database/migrations 移入）}' docs/superpowers/specs/2026-09-13-scaffold-design.md
perl -pi -e 's{^- River 表通过一个 goose 迁移创建（内容来自 River 官方迁移 SQL），版本号排在业务迁移之后。$}{- `werun migrate up` 先执行 goose 业务迁移，再调用 `rivermigrate` 执行 River 自带迁移（River 用自己的 `river_migration` 表记录版本，升级 River 时无需手工同步 SQL）。}' docs/superpowers/specs/2026-09-13-scaffold-design.md
grep -n "api/db/migrations" docs/database/db-design.html
grep -n "rivermigrate" docs/superpowers/specs/2026-09-13-scaffold-design.md
```

Expected：第一个 grep 命中第 170 行；第二个 grep 命中 §5.5 那一行。

- [ ] **Step 9: lint 并提交**

Run: `make lint-api`
Expected: `0 issues.`

```bash
git add api/db api/internal/platform/db api/internal/platform/migrate api/internal/platform/dbtest docs/database docs/superpowers/specs/2026-09-13-scaffold-design.md
git commit -F - <<'EOF'
feat(api): add database pool, migrations runner and test database helper

- move migrations and invariant tests under api/db and embed them
- wrap plpgsql functions in goose StatementBegin/End blocks
- run River migrations via rivermigrate after goose

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
```

---
### Task 4: HTTP 中间件、健康检查路由与 werun 命令行

**Files:**
- Create: `api/internal/platform/httpx/middleware.go`
- Modify: `api/internal/platform/httpx/ctx.go`（追加 `Meta`、`MetaOf`、`Gin`）
- Test: `api/internal/platform/httpx/middleware_test.go`
- Create: `api/internal/httpapi/router.go`
- Test: `api/internal/httpapi/router_test.go`
- Create: `api/cmd/werun/main.go`
- Create: `api/cmd/werun/app.go`
- Create: `api/cmd/werun/serve.go`
- Create: `api/cmd/werun/migrate.go`
- Create: `api/cmd/werun/healthcheck.go`
- Test: `api/cmd/werun/main_test.go`
- Modify: `Makefile`（新增 `migrate-up`、`migrate-status`）

**Interfaces:**
- Consumes:
  - Task 1：`config.Load`、`logx.New`
  - Task 2：`apperr.New`、`apperr.CodeInternal`、`apperr.CodeNotFound`、`i18n.LoadCatalog`、`i18n.FromRequest`、`httpx.WriteError`、`httpx.LangOf`、`httpx.RequestIDOf`（以及 `ctx.go` 中的未导出常量 `keyRequestID`、`keyLang`）
  - Task 3：`db.Open`、`migrate.Up/Down/Status`、`dbtest.NewPool`
- Produces:
  - C5 Task 4 部分：`httpx.HeaderRequestID`、`httpx.HeaderClient`、`httpx.RequestID()`、`httpx.AccessLog(log)`、`httpx.Recover(cat, log)`、`httpx.Locale()`、`httpx.Meta`、`httpx.MetaOf(ctx)`、`httpx.Gin(ctx)`
  - C12 Task 4 形态：`httpapi.RouterDeps{Log, Catalog, Pool}`、`httpapi.NewRouter(RouterDeps) *gin.Engine`（手写 `GET /api/healthz`、`GET /api/readyz`，未匹配路由返回 404 `NOT_FOUND`）
  - `main.App{Cfg, Log, Catalog, Pool}`、`main.Bootstrap(ctx)`、`(*App).Close()`
  - 命令：`werun serve [--auto-migrate]`、`werun migrate up|down|status`、`werun healthcheck [--url]`；函数 `run(ctx, args, stdout, stderr) int`（Task 8、9 在其 `switch` 中追加 `create-staff`、`worker`）
  - Makefile 目标：`migrate-up`、`migrate-status`

- [ ] **Step 1: 写中间件的失败测试**

`api/internal/platform/httpx/middleware_test.go`：

```go
package httpx_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
)

func newTestEngine(t *testing.T, logBuf *bytes.Buffer) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	cat, err := i18n.LoadCatalog()
	require.NoError(t, err)
	log := slog.New(slog.NewJSONHandler(logBuf, nil))
	r := gin.New()
	r.Use(httpx.RequestID(), httpx.AccessLog(log), httpx.Recover(cat, log), httpx.Locale())
	return r
}

func TestRequestIDGeneratedWhenMissing(t *testing.T) {
	var logBuf bytes.Buffer
	r := newTestEngine(t, &logBuf)
	var seen string
	r.GET("/x", func(c *gin.Context) { seen = httpx.RequestIDOf(c) })

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x", nil))

	assert.Regexp(t, regexp.MustCompile(`^[0-9a-f]{16}$`), seen)
	assert.Equal(t, seen, rec.Header().Get(httpx.HeaderRequestID))
}

func TestRequestIDKeepsValidIncomingAndReplacesInvalid(t *testing.T) {
	var logBuf bytes.Buffer
	r := newTestEngine(t, &logBuf)
	var seen string
	r.GET("/x", func(c *gin.Context) { seen = httpx.RequestIDOf(c) })

	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set(httpx.HeaderRequestID, "abc-123_XYZ")
	r.ServeHTTP(httptest.NewRecorder(), req)
	assert.Equal(t, "abc-123_XYZ", seen)

	bad := httptest.NewRequest(http.MethodGet, "/x", nil)
	bad.Header.Set(httpx.HeaderRequestID, "bad id!")
	r.ServeHTTP(httptest.NewRecorder(), bad)
	assert.NotEqual(t, "bad id!", seen)
	assert.Len(t, seen, 16)
}

func TestLocale(t *testing.T) {
	var logBuf bytes.Buffer
	r := newTestEngine(t, &logBuf)
	var seen i18n.Lang
	r.GET("/x", func(c *gin.Context) { seen = httpx.LangOf(c) })

	cases := []struct {
		target, acceptLanguage string
		want                   i18n.Lang
	}{
		{"/x?lang=zh", "en-US", i18n.ZH},
		{"/x", "en-US,km;q=0.5", i18n.EN},
		{"/x", "", i18n.KM},
	}
	for _, c := range cases {
		req := httptest.NewRequest(http.MethodGet, c.target, nil)
		if c.acceptLanguage != "" {
			req.Header.Set("Accept-Language", c.acceptLanguage)
		}
		r.ServeHTTP(httptest.NewRecorder(), req)
		assert.Equal(t, c.want, seen, "target=%s accept=%s", c.target, c.acceptLanguage)
	}
}

func TestRecoverRendersInternalError(t *testing.T) {
	var logBuf bytes.Buffer
	r := newTestEngine(t, &logBuf)
	r.GET("/panic", func(c *gin.Context) { panic("kaboom") })

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/panic?lang=en", nil))

	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	var body httpx.ErrorBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "INTERNAL", body.Error.Code)
	assert.Contains(t, logBuf.String(), "panic recovered")
	assert.Contains(t, logBuf.String(), "kaboom")
}

func TestAccessLogWritesRequestLine(t *testing.T) {
	var logBuf bytes.Buffer
	r := newTestEngine(t, &logBuf)
	r.GET("/teapot", func(c *gin.Context) { c.Status(http.StatusTeapot) })

	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/teapot", nil))

	assert.Contains(t, logBuf.String(), `"msg":"http request"`)
	assert.Contains(t, logBuf.String(), `"path":"/teapot"`)
	assert.Contains(t, logBuf.String(), `"status":418`)
}

func TestMetaOfAndGin(t *testing.T) {
	var logBuf bytes.Buffer
	r := newTestEngine(t, &logBuf)
	var meta httpx.Meta
	var fromGin bool
	r.GET("/x", func(c *gin.Context) {
		meta = httpx.MetaOf(c)
		_, fromGin = httpx.Gin(c)
	})

	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("User-Agent", "werun-test")
	req.Header.Set(httpx.HeaderRequestID, "req-meta")
	r.ServeHTTP(httptest.NewRecorder(), req)

	assert.True(t, fromGin)
	assert.Equal(t, httpx.Meta{RequestID: "req-meta", IP: "192.0.2.1", UserAgent: "werun-test"}, meta)

	_, ok := httpx.Gin(context.Background())
	assert.False(t, ok)
	assert.Equal(t, httpx.Meta{}, httpx.MetaOf(context.Background()))
}
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd api && go test ./internal/platform/httpx/... ; cd ..`
Expected: FAIL，编译错误，`httpx.RequestID`、`httpx.Meta` 等未定义。

- [ ] **Step 3: 实现中间件与上下文取值**

`api/internal/platform/httpx/middleware.go`：

```go
package httpx

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"runtime/debug"
	"time"

	"github.com/gin-gonic/gin"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/i18n"
)

// 请求头。
const (
	HeaderRequestID = "X-Request-ID"
	HeaderClient    = "X-WeRun-Client"
)

// RequestID 读取合法的 X-Request-ID（1–64 位字母、数字、- 或 _），否则生成 16 位十六进制 ID；
// 写入上下文并回写到响应头。
func RequestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.GetHeader(HeaderRequestID)
		if !validRequestID(id) {
			id = newRequestID()
		}
		c.Set(keyRequestID, id)
		c.Header(HeaderRequestID, id)
		c.Next()
	}
}

func validRequestID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}

func newRequestID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// AccessLog 在请求结束后写一条访问日志。
func AccessLog(log *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		log.InfoContext(c, "http request",
			"method", c.Request.Method,
			"path", c.Request.URL.Path,
			"status", c.Writer.Status(),
			"duration_ms", time.Since(start).Milliseconds(),
			"request_id", RequestIDOf(c),
			"ip", c.ClientIP(),
		)
	}
}

// Recover 捕获 handler 中的 panic，记录堆栈并返回 500 INTERNAL。
func Recover(cat *i18n.Catalog, log *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			p := recover()
			if p == nil {
				return
			}
			if err, ok := p.(error); ok && errors.Is(err, http.ErrAbortHandler) {
				panic(p)
			}
			log.ErrorContext(c, "panic recovered",
				"panic", fmt.Sprint(p),
				"stack", string(debug.Stack()),
				"request_id", RequestIDOf(c),
			)
			WriteError(c, cat, log, apperr.New(http.StatusInternalServerError, apperr.CodeInternal).
				Wrap(fmt.Errorf("panic: %v", p)))
		}()
		c.Next()
	}
}

// Locale 按 ?lang= → Accept-Language → km 确定语言并写入上下文。
func Locale() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Set(keyLang, i18n.FromRequest(c.Query("lang"), c.GetHeader("Accept-Language")))
		c.Next()
	}
}
```

在 `api/internal/platform/httpx/ctx.go` 末尾追加（同时把文件顶部 import 改为同时导入 `github.com/gin-gonic/gin`）：

```go
// Meta 是写审计记录时需要的请求信息。
type Meta struct {
	RequestID string
	IP        string
	UserAgent string
}

// MetaOf 从请求上下文中取出请求 ID、客户端 IP 与 User-Agent；不是 gin 请求时只返回能取到的部分。
func MetaOf(ctx context.Context) Meta {
	m := Meta{RequestID: RequestIDOf(ctx)}
	if c, ok := Gin(ctx); ok && c.Request != nil {
		m.IP = c.ClientIP()
		m.UserAgent = c.Request.UserAgent()
	}
	return m
}

// Gin 取回 *gin.Context。oapi-codegen strict handler 收到的 ctx 实参就是 *gin.Context。
func Gin(ctx context.Context) (*gin.Context, bool) {
	if ctx == nil {
		return nil, false
	}
	if c, ok := ctx.(*gin.Context); ok {
		return c, true
	}
	if c, ok := ctx.Value(gin.ContextKey).(*gin.Context); ok {
		return c, true
	}
	return nil, false
}
```

修改后 `ctx.go` 的 import 块为：

```go
import (
	"context"

	"github.com/gin-gonic/gin"

	"werun/api/internal/platform/i18n"
)
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd api && go test ./internal/platform/httpx/... ; cd ..`
Expected: `ok  	werun/api/internal/platform/httpx`

- [ ] **Step 5: 写路由的失败测试**

`api/internal/httpapi/router_test.go`：

```go
package httpapi_test

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/httpapi"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
)

func newRouter(t *testing.T, pool *pgxpool.Pool) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	cat, err := i18n.LoadCatalog()
	require.NoError(t, err)
	return httpapi.NewRouter(httpapi.RouterDeps{
		Log:     slog.New(slog.DiscardHandler),
		Catalog: cat,
		Pool:    pool,
	})
}

func get(r http.Handler, target string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
	return rec
}

func TestHealthz(t *testing.T) {
	rec := get(newRouter(t, nil), "/api/healthz")

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"status":"ok"}`, rec.Body.String())
	assert.NotEmpty(t, rec.Header().Get(httpx.HeaderRequestID))
}

func TestReadyzWithDatabase(t *testing.T) {
	rec := get(newRouter(t, dbtest.NewPool(t)), "/api/readyz")

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"status":"ok"}`, rec.Body.String())
}

func TestReadyzWhenDatabaseUnavailable(t *testing.T) {
	pool := dbtest.NewPool(t)
	pool.Close()

	rec := get(newRouter(t, pool), "/api/readyz")

	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
	assert.JSONEq(t, `{"status":"unavailable"}`, rec.Body.String())
}

func TestUnknownRouteReturnsLocalizedNotFound(t *testing.T) {
	rec := get(newRouter(t, nil), "/api/nope?lang=zh")

	assert.Equal(t, http.StatusNotFound, rec.Code)
	var body httpx.ErrorBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "NOT_FOUND", body.Error.Code)
	assert.Equal(t, "找不到请求的内容。", body.Error.Message)
}

func TestClientIPTrustsOnlyPrivateProxies(t *testing.T) {
	r := newRouter(t, nil)
	r.GET("/test/client-ip", func(c *gin.Context) {
		c.String(http.StatusOK, httpx.MetaOf(c).IP)
	})
	clientIP := func(remoteAddr string) string {
		req := httptest.NewRequest(http.MethodGet, "/test/client-ip", nil)
		req.RemoteAddr = remoteAddr
		req.Header.Set("X-Forwarded-For", "203.0.113.9")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec.Body.String()
	}

	// 来自 compose 网络里的 Caddy：取 X-Forwarded-For 中的真实客户端
	assert.Equal(t, "203.0.113.9", clientIP("172.18.0.5:41234"))
	// 来自公网的直连请求：伪造的 X-Forwarded-For 不被采信
	assert.Equal(t, "198.51.100.7", clientIP("198.51.100.7:41234"))
}
```

- [ ] **Step 6: 运行测试，确认失败**

Run: `cd api && go test ./internal/httpapi/... ; cd ..`
Expected: FAIL，编译错误，`httpapi.NewRouter`、`httpapi.RouterDeps` 未定义。

- [ ] **Step 7: 实现路由（Task 4 形态）**

`api/internal/httpapi/router.go`：

```go
// Package httpapi 装配 HTTP 路由：公共中间件、各模块 handler 与错误处理。
package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
)

// RouterDeps 是构建路由所需的依赖。后续任务会追加 Server、IAM、Env 字段。
type RouterDeps struct {
	Log     *slog.Logger
	Catalog *i18n.Catalog
	Pool    *pgxpool.Pool
}

type healthBody struct {
	Status string `json:"status"`
}

// trustedProxies：只信任本机与私有网段（compose 网络里的 Caddy）转发的 X-Forwarded-For，
// 这样 c.ClientIP() 才是真实客户端 IP，登录限流按人计算。以后在 Caddy 前面加 Cloudflare 时，由 Caddy 的 trusted_proxies 处理。
var trustedProxies = []string{"127.0.0.1/32", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"}

// NewRouter 创建 gin 引擎。Task 5 会把下面手写的健康检查路由换成 OpenAPI 生成的 strict handler。
func NewRouter(d RouterDeps) *gin.Engine {
	r := gin.New()
	if err := r.SetTrustedProxies(trustedProxies); err != nil {
		panic(err) // 列表是常量，出错说明代码写错了
	}
	r.Use(
		httpx.RequestID(),
		httpx.AccessLog(d.Log),
		httpx.Recover(d.Catalog, d.Log),
		httpx.Locale(),
	)

	api := r.Group("/api")
	api.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, healthBody{Status: "ok"})
	})
	api.GET("/readyz", func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c, 2*time.Second)
		defer cancel()
		if err := d.Pool.Ping(ctx); err != nil {
			d.Log.WarnContext(c, "readiness check failed", "error", err)
			c.JSON(http.StatusServiceUnavailable, healthBody{Status: "unavailable"})
			return
		}
		c.JSON(http.StatusOK, healthBody{Status: "ok"})
	})

	r.NoRoute(func(c *gin.Context) {
		httpx.WriteError(c, d.Catalog, d.Log, apperr.New(http.StatusNotFound, apperr.CodeNotFound))
	})
	return r
}
```

- [ ] **Step 8: 运行测试，确认通过**

Run: `cd api && go test ./internal/httpapi/... ; cd ..`
Expected: `ok  	werun/api/internal/httpapi`

- [ ] **Step 9: 写命令行的失败测试**

`api/cmd/werun/main_test.go`：

```go
package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
)

func runCmd(args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := run(context.Background(), args, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func TestRunWithoutArgsPrintsUsage(t *testing.T) {
	code, _, stderr := runCmd()

	assert.Equal(t, 2, code)
	assert.Contains(t, stderr, "Commands:")
}

func TestRunUnknownCommand(t *testing.T) {
	code, _, stderr := runCmd("fly")

	assert.Equal(t, 2, code)
	assert.Contains(t, stderr, `unknown command "fly"`)
}

func TestMigrateRejectsUnknownSubcommandBeforeConnecting(t *testing.T) {
	code, _, stderr := runCmd("migrate", "sideways")

	assert.Equal(t, 2, code)
	assert.Contains(t, stderr, "usage: werun migrate up|down|status")
}

func TestHealthcheck(t *testing.T) {
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer ok.Close()
	unavailable := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer unavailable.Close()

	code, stdout, _ := runCmd("healthcheck", "--url", ok.URL)
	assert.Equal(t, 0, code)
	assert.Equal(t, "ok\n", stdout)

	code, _, stderr := runCmd("healthcheck", "--url", unavailable.URL)
	assert.Equal(t, 1, code)
	assert.Contains(t, stderr, "status 503")

	code, _, _ = runCmd("healthcheck", "--url", "http://127.0.0.1:1/api/readyz")
	assert.Equal(t, 1, code)
}
```

- [ ] **Step 10: 运行测试，确认失败**

Run: `cd api && go test ./cmd/werun/... ; cd ..`
Expected: FAIL，编译错误，`run` 未定义。

- [ ] **Step 11: 实现命令行**

`api/cmd/werun/main.go`：

```go
// Command werun 是 WeRun 后端的唯一二进制：HTTP 服务、迁移、健康检查等子命令。
package main

import (
	"context"
	"fmt"
	"io"
	"os"
)

const usage = `werun <command> [flags]

Commands:
  serve        启动 HTTP 服务（--auto-migrate：启动前执行迁移，只用于本地开发）
  migrate      数据库迁移：werun migrate up | down | status
  healthcheck  请求就绪接口，返回 200 时退出码为 0（--url 指定地址）
`

func main() {
	os.Exit(run(context.Background(), os.Args[1:], os.Stdout, os.Stderr))
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, usage)
		return 2
	}
	switch args[0] {
	case "serve":
		return runServe(ctx, args[1:], stderr)
	case "migrate":
		return runMigrate(ctx, args[1:], stdout, stderr)
	case "healthcheck":
		return runHealthcheck(ctx, args[1:], stdout, stderr)
	case "help", "-h", "--help":
		fmt.Fprint(stdout, usage)
		return 0
	default:
		fmt.Fprintf(stderr, "unknown command %q\n\n%s", args[0], usage)
		return 2
	}
}
```

`api/cmd/werun/app.go`：

```go
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"

	"werun/api/internal/platform/config"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/logx"
)

// App 持有进程级依赖。后续任务会追加 IAM、Events 等字段。
type App struct {
	Cfg     config.Config
	Log     *slog.Logger
	Catalog *i18n.Catalog
	Pool    *pgxpool.Pool
}

// Bootstrap 读取配置、创建日志器、加载文案并连接数据库。
func Bootstrap(ctx context.Context) (*App, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, fmt.Errorf("load config: %w", err)
	}
	log := logx.New(cfg.LogLevel, os.Stdout)
	cat, err := i18n.LoadCatalog()
	if err != nil {
		return nil, fmt.Errorf("load messages: %w", err)
	}
	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	return &App{Cfg: cfg, Log: log, Catalog: cat, Pool: pool}, nil
}

// Close 释放进程级资源。
func (a *App) Close() {
	a.Pool.Close()
}
```

`api/cmd/werun/serve.go`：

```go
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"

	"werun/api/internal/httpapi"
	"werun/api/internal/platform/migrate"
)

const shutdownTimeout = 30 * time.Second

func runServe(ctx context.Context, args []string, stderr io.Writer) int {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	flags.SetOutput(stderr)
	autoMigrate := flags.Bool("auto-migrate", false, "启动前执行数据库迁移（只用于本地开发）")
	if err := flags.Parse(args); err != nil {
		return 2
	}

	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	app, err := Bootstrap(ctx)
	if err != nil {
		fmt.Fprintf(stderr, "bootstrap: %v\n", err)
		return 1
	}
	defer app.Close()

	if *autoMigrate {
		if err := migrate.Up(ctx, app.Pool, app.Log); err != nil {
			app.Log.Error("auto migrate failed", "error", err)
			return 1
		}
	}

	if app.Cfg.IsProd() {
		gin.SetMode(gin.ReleaseMode)
	}
	srv := &http.Server{
		Addr: app.Cfg.HTTPAddr,
		Handler: httpapi.NewRouter(httpapi.RouterDeps{
			Log:     app.Log,
			Catalog: app.Catalog,
			Pool:    app.Pool,
		}),
		ReadHeaderTimeout: 10 * time.Second,
	}

	serveErr := make(chan error, 1)
	go func() {
		app.Log.Info("http server listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
		}
		close(serveErr)
	}()

	select {
	case err := <-serveErr:
		if err != nil {
			app.Log.Error("http server failed", "error", err)
			return 1
		}
		return 0
	case <-ctx.Done():
	}

	app.Log.Info("shutting down", "timeout", shutdownTimeout.String())
	shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		app.Log.Error("graceful shutdown failed", "error", err)
		return 1
	}
	return 0
}
```

`api/cmd/werun/migrate.go`：

```go
package main

import (
	"context"
	"fmt"
	"io"

	"werun/api/internal/platform/migrate"
)

const migrateUsage = "usage: werun migrate up|down|status"

func runMigrate(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	if len(args) != 1 || (args[0] != "up" && args[0] != "down" && args[0] != "status") {
		fmt.Fprintln(stderr, migrateUsage)
		return 2
	}

	app, err := Bootstrap(ctx)
	if err != nil {
		fmt.Fprintf(stderr, "bootstrap: %v\n", err)
		return 1
	}
	defer app.Close()

	switch args[0] {
	case "up":
		err = migrate.Up(ctx, app.Pool, app.Log)
	case "down":
		err = migrate.Down(ctx, app.Pool, app.Log)
	case "status":
		var lines []string
		lines, err = migrate.Status(ctx, app.Pool)
		for _, line := range lines {
			fmt.Fprintln(stdout, line)
		}
	}
	if err != nil {
		fmt.Fprintf(stderr, "migrate %s: %v\n", args[0], err)
		return 1
	}
	return 0
}
```

`api/cmd/werun/healthcheck.go`：

```go
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"net/http"
	"time"
)

// runHealthcheck 供容器健康检查使用：distroless 镜像里没有 curl。
func runHealthcheck(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("healthcheck", flag.ContinueOnError)
	flags.SetOutput(stderr)
	target := flags.String("url", "http://127.0.0.1:8080/api/readyz", "就绪检查地址")
	if err := flags.Parse(args); err != nil {
		return 2
	}

	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, *target, nil)
	if err != nil {
		fmt.Fprintf(stderr, "healthcheck: %v\n", err)
		return 1
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		fmt.Fprintf(stderr, "healthcheck: %v\n", err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(stderr, "healthcheck: status %d\n", resp.StatusCode)
		return 1
	}
	fmt.Fprintln(stdout, "ok")
	return 0
}
```

- [ ] **Step 12: 运行测试，确认通过**

Run: `cd api && go test ./cmd/werun/... ; cd ..`
Expected: `ok  	werun/api/cmd/werun`

- [ ] **Step 13: 在 Makefile 中加入迁移目标**

把 `Makefile` 中的

```makefile
.PHONY: help setup lint lint-api test test-api
```

改为

```makefile
.PHONY: help setup lint lint-api test test-api migrate-up migrate-status
```

并在文件末尾追加（缩进为 Tab）：

```makefile

migrate-up: ## 执行数据库迁移（读取根目录 .env）
	set -a; . ./.env; set +a; cd api && go run ./cmd/werun migrate up

migrate-status: ## 查看迁移状态（读取根目录 .env）
	set -a; . ./.env; set +a; cd api && go run ./cmd/werun migrate status
```

- [ ] **Step 14: 用真实数据库手动验证命令行**

本地 compose 在 Task 16 才建立，这里临时用一个容器验证，验证完删除：

```bash
docker run -d --name werun-task4-pg -e POSTGRES_USER=werun -e POSTGRES_PASSWORD=werun -e POSTGRES_DB=werun -p 55432:5432 postgres:16-alpine
test -f .env || cp .env.example .env
until docker exec werun-task4-pg pg_isready -h 127.0.0.1 -U werun >/dev/null 2>&1; do sleep 1; done
make migrate-up
make migrate-status
(set -a; . ./.env; set +a; cd api && go run ./cmd/werun serve) &
SERVE_PID=$!
until curl -fsS http://127.0.0.1:8080/api/healthz >/dev/null 2>&1; do sleep 1; done
curl -s http://127.0.0.1:8080/api/readyz
(cd api && go run ./cmd/werun healthcheck); echo "exit=$?"
kill -TERM $SERVE_PID; wait $SERVE_PID
docker rm -f werun-task4-pg
```

Expected：
- `make migrate-status` 输出 9 行，全部以 ` applied` 结尾
- `curl` 输出 `{"status":"ok"}`
- healthcheck 输出 `ok` 与 `exit=0`
- `kill -TERM` 后日志出现 `"msg":"shutting down"`，进程正常退出

- [ ] **Step 15: 全量测试、lint 并提交**

Run: `make lint && make test`
Expected: `0 issues.`；全部测试 `ok`。

```bash
git add api/internal/platform/httpx api/internal/httpapi api/cmd/werun Makefile
git commit -F - <<'EOF'
feat(api): add HTTP middleware, health routes and werun CLI

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
```
