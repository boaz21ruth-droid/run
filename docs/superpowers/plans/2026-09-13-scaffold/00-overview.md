# WeRun 脚手架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭出 WeRun 的 monorepo 骨架，并打通"后台 OPS 登录 → 新建并发布赛事 → 用户端看到赛事"这条端到端链路。

**Architecture:** Go 单二进制（Gin + oapi-codegen strict server + pgx/sqlc + goose + River）提供 `/api`；两个 Vite + React 前端由 Caddy 分发；OpenAPI 规范是前后端唯一契约。按业务模块分包（`iam`、`event`），平台能力放 `internal/platform`。

**Tech Stack:** Go 1.26 · Gin · pgx/v5 · sqlc · goose · River · oapi-codegen · testcontainers-go · React 19 · TypeScript 5.9 · Vite 7 · React Router 7 · TanStack Query 5 · Ant Design 5 · react-i18next · openapi-fetch · Vitest 4 · Playwright · Caddy 2 · Docker Compose · GitHub Actions

**Spec:** `docs/superpowers/specs/2026-09-13-scaffold-design.md`

计划分为 6 个文件，按顺序执行：

| 文件 | 任务 |
|---|---|
| `00-overview.md` | 全局约束、版本、跨任务契约（本文件） |
| `01-backend-foundation.md` | Task 1–4：Go 模块与配置、错误与三语、数据库与迁移、命令行与 HTTP 骨架 |
| `02-api-contract-and-iam.md` | Task 5–8：OpenAPI 与代码生成、权限矩阵与密码、会话与登录服务、后台认证接口与 create-staff |
| `03-worker-and-events.md` | Task 9–10：River 任务与会话清理、赛事模块 |
| `04-frontend.md` | Task 11–15：pnpm 工作区与设计令牌、i18n 包、api-client 包、用户端、后台 |
| `05-deploy-e2e-ci.md` | Task 16–18：镜像与 compose 与本地开发、Playwright、GitHub Actions |

---

## Global Constraints

以下内容对每个任务都生效，数值取自 spec，不得改动。

- Go `1.26`；Go 模块路径 `werun/api`（位于 `api/`）。
- Node：CI 与镜像使用 Node `24`（LTS）；包管理 pnpm `10.34.5`，通过 corepack 启用（根 `package.json` 的 `"packageManager": "pnpm@10.34.5"`）。
- PostgreSQL `16`（镜像 `postgres:16-alpine`）。
- 语言只有 `zh` / `en` / `km`，默认 `km`；后端解析顺序 `?lang=` → `Accept-Language` → `km`；文本回退顺序 请求语言 → `en` → `zh`。
- 前端语言存 localStorage 键 `werun.lang`；切换语言时设置 `document.documentElement.lang`；高棉文时根元素 `data-script="khmer"`。
- 后台接口前缀 `/api/admin/`；后台会话 Cookie 名 `werun_admin_session`，`HttpOnly`、`SameSite=Lax`、`Path=/api/admin`，`WERUN_ENV=prod` 时 `Secure`。
- `/api/admin/*` 的非 GET 请求必须带请求头 `X-WeRun-Client: admin`，否则 403 `CSRF_HEADER_MISSING`。
- 会话：32 字节随机令牌；库里存 HMAC-SHA256；空闲 8 小时、绝对 7 天；续期写库节流 1 分钟。
- 密码 argon2id：m=64MB（65536 KiB）、t=3、p=2、盐 16 字节、密钥 32 字节。
- 登录限流：同一 IP 每分钟 20 次；同一用户名 15 分钟内连续失败 5 次锁定 15 分钟。
- 审计 action：`staff.login`、`staff.login_failed`、`event.create`、`event.publish`。
- 本地域名 `werun.localhost`（用户端）、`admin.werun.localhost`（后台）；端口：Go `8080`，用户端 Vite `5173`，后台 Vite `5174`，本地 Caddy `80`，本地 compose 的 Postgres 映射到宿主 `55432`。
- 生产运行镜像 `gcr.io/distroless/static-debian12:nonroot`，`CGO_ENABLED=0`，平台 `linux/arm64,linux/amd64`；镜像名 `werun-api`、`werun-web`，推送 `ghcr.io/<owner>/werun-api` / `ghcr.io/<owner>/werun-web`，标签 `<sha>` 与 `main`。
- 用户端布局：基准宽度 390px，桌面断点 1024px，内容最大宽度 1184px。
- 后台主题主色 `#0F66AE`。
- 生成代码提交进仓库；CI 执行 `make gen` 后 `git diff --exit-code` 必须为空。
- 每个任务结束都提交一次 commit，提交信息末尾带：

```
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
```

### 与 spec 的一处实现调整

spec §5.5 写"River 表通过一个 goose 迁移创建（内容来自 River 官方迁移 SQL）"。本计划改为：`werun migrate up` 先执行 goose 业务迁移，再调用 `rivermigrate` 执行 River 自带迁移。原因：复制 SQL 会让每次升级 River 都要手工同步迁移文件；`rivermigrate` 自带版本记录表，结果等价。Task 3 同步修改 spec 这一句。

---

## 依赖版本（锁定）

### Go（`api/go.mod`）

| 模块 | 版本 | 用途 |
|---|---|---|
| `github.com/gin-gonic/gin` | `v1.12.0` | HTTP |
| `github.com/jackc/pgx/v5` | `v5.11.0` | PostgreSQL 驱动、连接池 |
| `github.com/pressly/goose/v3` | `v3.28.0` | 业务迁移（Provider API） |
| `github.com/riverqueue/river` | `v0.47.0` | 任务队列 |
| `github.com/riverqueue/river/riverdriver/riverpgxv5` | `v0.47.0` | River pgx 驱动 |
| `github.com/oapi-codegen/runtime` | `v1.7.0` | 生成代码运行时 |
| `github.com/getkin/kin-openapi` | `v0.149.0` | 权限映射生成器读取 openapi.yaml |
| `github.com/caarlos0/env/v11` | `v11.4.1` | 环境变量配置 |
| `golang.org/x/crypto` | `v0.57.0` | argon2id |
| `github.com/testcontainers/testcontainers-go` | `v0.44.0` | 集成测试 |
| `github.com/testcontainers/testcontainers-go/modules/postgres` | `v0.44.0` | 集成测试 |
| `github.com/stretchr/testify` | `v1.12.1` | 断言 |

Go 工具（`go.mod` 中 `tool` 指令，用 `go get -tool <pkg>@<ver>` 添加，用 `go tool <name>` 运行）：

| 工具包 | 版本 |
|---|---|
| `github.com/sqlc-dev/sqlc/cmd/sqlc` | `v1.31.1` |
| `github.com/pressly/goose/v3/cmd/goose` | `v3.28.0` |
| `github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen` | `v2.8.0` |
| `github.com/air-verse/air` | `v1.67.4` |
| `github.com/golangci/golangci-lint/v2/cmd/golangci-lint` | `v2.13.2` |

已核对的第三方接口（v0.47.0 / v2.8.0 / v3.28.0 / v0.44.0 源码）：

- River：`river.NewClient[TTx](driver, *river.Config)`；`Config{Queues map[string]river.QueueConfig, Workers *river.Workers, PeriodicJobs []*river.PeriodicJob, Logger *slog.Logger}`；`river.QueueConfig{MaxWorkers int}`；`river.QueueDefault`；`river.NewWorkers()`、`river.AddWorker(workers, worker)`；worker 嵌入 `river.WorkerDefaults[T]` 并实现 `Work(ctx, *river.Job[T]) error`；`river.NewPeriodicJob(schedule river.PeriodicSchedule, constructor river.PeriodicJobConstructor, *river.PeriodicJobOpts{ID string, RunOnStart bool})`；`PeriodicSchedule` 接口只有 `Next(time.Time) time.Time`；`riverpgxv5.New(*pgxpool.Pool)`；`rivermigrate.New(driver, *rivermigrate.Config)`、`migrator.Migrate(ctx, rivermigrate.DirectionUp, nil)`。
- oapi-codegen 生成（`gin-server: true` + `strict-server: true`）：`type StrictHandlerFunc func(ctx *gin.Context, request any) (any, error)`；`type StrictMiddlewareFunc func(f StrictHandlerFunc, operationID string) StrictHandlerFunc`；`NewStrictHandlerWithOptions(ssi StrictServerInterface, middlewares []StrictMiddlewareFunc, StrictGinServerOptions{RequestErrorHandlerFunc, HandlerErrorFunc, ResponseErrorHandlerFunc func(*gin.Context, error)})`；`RegisterHandlersWithOptions(router gin.IRouter, si ServerInterface, GinServerOptions{BaseURL string, Middlewares []MiddlewareFunc, ErrorHandler func(*gin.Context, error, int)})`。strict 接口方法的 `ctx context.Context` 实参就是 `*gin.Context`。
- goose：`goose.NewProvider(goose.DialectPostgres, *sql.DB, fs.FS)`，`(*Provider).Up/Down/Status(ctx)`。
- testcontainers postgres：`postgres.Run(ctx, "postgres:16-alpine", postgres.WithDatabase(..), postgres.WithUsername(..), postgres.WithPassword(..), postgres.BasicWaitStrategies())`，`(*PostgresContainer).ConnectionString(ctx, "sslmode=disable")`。

### npm

故意停在团队熟悉的大版本（TypeScript 7、Vite 8、React Router 8、Ant Design 6、Vitest 5、ESLint 10、pnpm 12 已发布，升级另开任务；spec 规定 Ant Design 5）。

| 包 | 版本 |
|---|---|
| `react` / `react-dom` | `19.3.0` |
| `typescript` | `5.9.3` |
| `vite` | `7.3.6` |
| `@vitejs/plugin-react` | `5.2.0` |
| `react-router` | `7.18.3` |
| `@tanstack/react-query` | `5.102.8` |
| `antd` | `5.29.3` |
| `@ant-design/icons` | `5.6.1` |
| `openapi-typescript` | `7.13.0` |
| `openapi-fetch` | `0.17.0` |
| `i18next` | `25.10.10` |
| `react-i18next` | `15.7.4` |
| `vitest` | `4.1.11` |
| `@testing-library/react` | `16.3.3` |
| `@testing-library/jest-dom` | `6.10.0` |
| `@testing-library/user-event` | `14.6.7` |
| `jsdom` | `26.1.0` |
| `@playwright/test` | `1.63.0` |
| `eslint` / `@eslint/js` | `9.39.5` |
| `typescript-eslint` | `8.70.0` |
| `eslint-plugin-react-hooks` | `5.2.0` |
| `@fontsource/inter` / `@fontsource/noto-sans-khmer` | `5.3.0` |
| `dayjs` | `1.11.23` |

---

## 最终文件结构

```
.
├─ Makefile                                  Task 1 建立，Task 5/11/16 追加目标
├─ package.json  pnpm-workspace.yaml         Task 11
├─ tsconfig.base.json  eslint.config.js      Task 11
├─ .env.example                              Task 1
├─ api/
│  ├─ go.mod  go.sum                         Task 1
│  ├─ .golangci.yml                          Task 1
│  ├─ .air.toml                              Task 16
│  ├─ Dockerfile                             Task 16
│  ├─ sqlc.yaml                              Task 7 建立（iam），Task 10 追加（event）
│  ├─ db/
│  │  ├─ embed.go                            Task 3   package db：Migrations、InvariantsSQL
│  │  ├─ migrations/0001…0009_*.sql          Task 3   由 docs/database/migrations git mv
│  │  ├─ tests/invariants_test.sql           Task 3   由 docs/database/tests git mv
│  │  └─ queries/iam.sql  event.sql          Task 7 / Task 10
│  ├─ openapi/
│  │  ├─ openapi.yaml                        Task 5（Task 8、10 补充操作）
│  │  └─ oapi-codegen.yaml                   Task 5
│  ├─ cmd/werun/
│  │  ├─ main.go                             Task 4   子命令分发
│  │  ├─ app.go                              Task 4   Bootstrap 装配（Task 8、9、10 扩充）
│  │  ├─ serve.go  migrate.go  healthcheck.go Task 4
│  │  └─ createstaff.go                      Task 8
│  └─ internal/
│     ├─ platform/
│     │  ├─ config/config.go                 Task 1
│     │  ├─ logx/logx.go                     Task 1
│     │  ├─ money/money.go                   Task 1
│     │  ├─ apperr/apperr.go  pg.go          Task 2
│     │  ├─ i18n/i18n.go  messages.{zh,en,km}.json   Task 2
│     │  ├─ httpx/middleware.go  errors.go  ctx.go    Task 2（错误渲染）/ Task 4（中间件）
│     │  ├─ db/db.go                         Task 3
│     │  ├─ migrate/migrate.go               Task 3
│     │  └─ dbtest/dbtest.go                 Task 3
│     ├─ audit/audit.go                      Task 7
│     ├─ iam/
│     │  ├─ roles.go  matrix.go              Task 6
│     │  ├─ password.go                      Task 6
│     │  ├─ limiter.go                       Task 7
│     │  ├─ service.go                       Task 7
│     │  ├─ context.go                       Task 8
│     │  ├─ handlers.go                      Task 8
│     │  └─ store/（sqlc 生成）              Task 7
│     ├─ event/
│     │  ├─ model.go  validate.go  service.go  handlers.go   Task 10
│     │  └─ store/（sqlc 生成）              Task 10
│     ├─ jobs/jobs.go  schedule.go           Task 9
│     └─ httpapi/
│        ├─ apigen/api.gen.go                Task 5（生成，package apigen）
│        ├─ apigen/permissions.gen.go        Task 5（生成，package apigen）
│        ├─ cmd/permgen/main.go  main_test.go Task 5
│        ├─ router.go                        Task 4 建立，Task 5 改为挂载生成的 strict handler
│        ├─ server.go                        Task 5（Task 8、10 扩充）
│        ├─ health.go                        Task 5
│        └─ auth.go                          Task 8
├─ packages/
│  ├─ tokens/                                Task 11
│  ├─ i18n/                                  Task 12
│  └─ api-client/                            Task 13
├─ web/
│  ├─ user/                                  Task 14
│  └─ admin/                                 Task 15
├─ e2e/                                      Task 17
├─ deploy/
│  ├─ compose.yaml  compose.dev.yaml         Task 16
│  ├─ Caddyfile  Caddyfile.dev               Task 16
│  └─ web.Dockerfile                         Task 16
└─ .github/workflows/ci.yml                  Task 18
```

---

## 跨任务契约

每个任务的实现者只看得到自己的任务。下面的名称、签名、字符串是各任务之间的约定，**必须原样使用**。

### C1 环境变量（`api/internal/platform/config`，Task 1）

```go
package config

type Config struct {
	Env           string `env:"WERUN_ENV" envDefault:"dev"`             // dev | prod
	HTTPAddr      string `env:"WERUN_HTTP_ADDR" envDefault:":8080"`
	DatabaseURL   string `env:"WERUN_DATABASE_URL,required"`
	SessionSecret string `env:"WERUN_SESSION_SECRET,required"`          // 至少 32 字节
	PIIKey        string `env:"WERUN_PII_KEY,required"`                 // base64，解码后 32 字节
	FilesDir      string `env:"WERUN_FILES_DIR" envDefault:"./data/files"`
	LogLevel      string `env:"WERUN_LOG_LEVEL" envDefault:"info"`      // debug | info | warn | error
}

func Load() (Config, error)          // 解析并校验；错误信息列出所有不合法的变量名
func (c Config) IsProd() bool
```

`WERUN_USER_HOST` / `WERUN_ADMIN_HOST` 只由 Caddy 使用（值为 Caddy 站点地址，如 `http://werun.localhost` 或 `werun.com.kh`），Go 不读取。

### C2 日志与金额（Task 1）

```go
package logx
func New(level string, w io.Writer) *slog.Logger   // JSON handler；未知 level 按 info

package money
type Cents int64
func (c Cents) String() string                     // 2193 → "$21.93"；-500 → "-$5.00"
```

### C3 错误（`api/internal/platform/apperr`，Task 2）

```go
package apperr

type Error struct {
	Code   string
	Status int
	Fields map[string]FieldError   // 字段名 → 文案 key 与参数
	Params map[string]any          // 顶层文案参数
	Err    error                   // 原始错误，只进日志
}
type FieldError struct {
	Key    string
	Params map[string]any
}

func New(status int, code string) *Error
func (e *Error) Error() string
func (e *Error) Unwrap() error
func (e *Error) WithField(field, key string, params map[string]any) *Error   // 返回副本
func (e *Error) WithParams(params map[string]any) *Error                     // 返回副本
func (e *Error) Wrap(err error) *Error                                       // 返回副本
func As(err error) (*Error, bool)

// 数据库约束 → 业务错误
func RegisterConstraint(constraint string, build func() *Error)
func FromPG(err error) error    // 非 *pgconn.PgError 原样返回；已注册约束返回对应 *Error（Wrap 原错误）；未注册返回原错误
```

错误码与 HTTP 状态（常量名 `Code…`，全部定义在 `apperr.go`）：

| 常量 | Code | Status |
|---|---|---|
| `CodeInternal` | `INTERNAL` | 500 |
| `CodeBadRequest` | `BAD_REQUEST` | 400 |
| `CodeValidation` | `VALIDATION_FAILED` | 422 |
| `CodeUnauthenticated` | `UNAUTHENTICATED` | 401 |
| `CodeForbidden` | `FORBIDDEN` | 403 |
| `CodeCSRF` | `CSRF_HEADER_MISSING` | 403 |
| `CodeNotFound` | `NOT_FOUND` | 404 |
| `CodeRateLimited` | `RATE_LIMITED` | 429 |
| `CodeInvalidCredentials` | `INVALID_CREDENTIALS` | 401 |
| `CodeAccountLocked` | `ACCOUNT_LOCKED` | 423 |
| `CodeEventNotFound` | `EVENT_NOT_FOUND` | 404 |
| `CodeEventSlugTaken` | `EVENT_SLUG_TAKEN` | 409 |
| `CodeEventCategoryCodeTaken` | `EVENT_CATEGORY_CODE_TAKEN` | 409 |
| `CodeEventAlreadyPublished` | `EVENT_ALREADY_PUBLISHED` | 409 |
| `CodeEventNoCategory` | `EVENT_NO_CATEGORY` | 422 |
| `CodeEventCategoryIncomplete` | `EVENT_CATEGORY_INCOMPLETE` | 422 |

每个 Code 在三语文案文件中都有同名 key。字段级文案 key：`field.required`、`field.invalid`、`field.too_long`（参数 `max`）、`field.slug_format`、`field.category_code_format`、`field.must_be_positive`、`field.cutoff_before_start`、`field.category_incomplete`（参数 `missing`）。

### C4 三语（`api/internal/platform/i18n`，Task 2）

```go
package i18n

type Lang string
const (
	ZH Lang = "zh"
	EN Lang = "en"
	KM Lang = "km"
	Default = KM
)
func Parse(s string) (Lang, bool)                       // 只接受 zh/en/km（大小写不敏感，接受 zh-CN、km-KH 这类带地区的写法）
func FromRequest(queryLang, acceptLanguage string) Lang // ?lang= 优先，其次 Accept-Language 中第一个支持的，否则 Default

type Text map[Lang]string                              // JSON 形如 {"zh":"…","en":"…","km":"…"}
func (t Text) In(l Lang) string                         // l → en → zh → ""

type Catalog struct{ /* 未导出 */ }
func LoadCatalog() (*Catalog, error)                    // 读取 embed 的 messages.{zh,en,km}.json；三份 key 集合不一致时返回错误
func (c *Catalog) T(l Lang, key string, params map[string]any) string   // 缺失时回退 en → zh → key；"{name}" 形式替换参数
```

### C5 HTTP 平台（`api/internal/platform/httpx`）

```go
package httpx

// Task 2
type ErrorBody struct {
	Error ErrorPayload `json:"error"`
}
type ErrorPayload struct {
	Code    string            `json:"code"`
	Message string            `json:"message"`
	Fields  map[string]string `json:"fields,omitempty"`
}
func WriteError(c *gin.Context, cat *i18n.Catalog, log *slog.Logger, err error)
// *apperr.Error → 对应状态与文案；其它错误 → 500 INTERNAL，并以 error 级别记录原始错误与 request_id

// Task 4
const (
	HeaderRequestID = "X-Request-ID"
	HeaderClient    = "X-WeRun-Client"
)
func RequestID() gin.HandlerFunc
func AccessLog(log *slog.Logger) gin.HandlerFunc
func Recover(cat *i18n.Catalog, log *slog.Logger) gin.HandlerFunc
func Locale() gin.HandlerFunc
func LangOf(ctx context.Context) i18n.Lang              // ctx 为 *gin.Context 或其派生；无值时返回 i18n.Default
func RequestIDOf(ctx context.Context) string
type Meta struct{ RequestID, IP, UserAgent string }
func MetaOf(ctx context.Context) Meta
func Gin(ctx context.Context) (*gin.Context, bool)      // strict handler 中取回 *gin.Context
```

gin 上下文键（字符串，`gin.Context.Value` 可读）：`"werun.request_id"`、`"werun.lang"`、`"werun.staff"`。

### C6 数据库（Task 3）

```go
package db   // 路径 werun/api/db（文件 api/db/embed.go）
var Migrations embed.FS      // //go:embed migrations/*.sql
var InvariantsSQL string     // //go:embed tests/invariants_test.sql
// 注意：该脚本第一行是 psql 元命令 `\set ON_ERROR_STOP 1`，pgx 不认识。在 Go 里执行前必须去掉所有以 `\` 开头的行；
// 脚本用 RAISE NOTICE 输出 PASS/FAIL，需通过 pgconn.Config.OnNotice 收集，期望 23 条 PASS、0 条 FAIL。

package db   // 路径 werun/api/internal/platform/db
func Open(ctx context.Context, url string) (*pgxpool.Pool, error)          // 创建后 Ping
func InTx(ctx context.Context, pool *pgxpool.Pool, fn func(tx pgx.Tx) error) error   // fn 返回错误或 panic 时回滚

package migrate
func Up(ctx context.Context, pool *pgxpool.Pool, log *slog.Logger) error    // goose Up，然后 rivermigrate Up
func Down(ctx context.Context, pool *pgxpool.Pool, log *slog.Logger) error  // goose 回退一步（不动 River）
func Status(ctx context.Context, pool *pgxpool.Pool) ([]string, error)      // 每行 "0001_foundation.sql applied|pending"

package dbtest
func NewPool(t testing.TB) *pgxpool.Pool
// 同一测试进程只启动一个 postgres:16-alpine 容器；首次调用时建库 werun_template 并执行 migrate.Up；
// 每次调用 CREATE DATABASE <随机名> TEMPLATE werun_template，返回连到新库的连接池，t.Cleanup 关闭连接池并删库。
// 环境变量 WERUN_TEST_DATABASE_URL 存在时不启动容器，直接用该地址所在的实例（CI 可选）。
```

### C7 OpenAPI（Task 5 建立；Task 8、10 补充）

- 文件 `api/openapi/openapi.yaml`，`openapi: 3.0.3`，`servers: [{url: /api}]`，路径不含 `/api` 前缀。
- 生成配置 `api/openapi/oapi-codegen.yaml`：`package: apigen`，`generate: {gin-server: true, strict-server: true, models: true, embedded-spec: false}`，`output: ../internal/httpapi/apigen/api.gen.go`。
- 生成代码单独放在 `werun/api/internal/httpapi/apigen`，是为了避免循环依赖：`iam`、`event` 的 handler 要用生成的请求/响应类型（导入 `apigen`），而 `httpapi` 要装配这些 handler（导入 `iam`、`event`）。`apigen` 只依赖 gin 与 oapi-codegen runtime。
- 路由注册：`apigen.RegisterHandlersWithOptions(engine, apigen.NewStrictHandlerWithOptions(server, middlewares, opts), apigen.GinServerOptions{BaseURL: "/api"})`。
- 权限扩展字段（每个 `/admin/` 下的操作必须二选一，否则 permgen 失败）：
  - `x-auth: none`（仅登录）或 `x-auth: session`（登录即可，如 me、logout）
  - `x-permission: <iam 权限名>` + `x-access: read | write`
- 公开路径（不在 `/admin/` 下）不需要扩展字段，映射表中记为 `AuthNone`。

operationId 一览：

| operationId | 方法 路径 | 扩展字段 | 所属任务 |
|---|---|---|---|
| `getHealthz` | GET `/healthz` | — | 5 |
| `getReadyz` | GET `/readyz` | — | 5 |
| `adminLogin` | POST `/admin/auth/login` | `x-auth: none` | 8 |
| `adminLogout` | POST `/admin/auth/logout` | `x-auth: session` | 8 |
| `adminGetMe` | GET `/admin/me` | `x-auth: session` | 8 |
| `listPublicEvents` | GET `/events` | — | 10 |
| `getPublicEvent` | GET `/events/{slug}` | — | 10 |
| `adminListEvents` | GET `/admin/events` | `x-permission: event_config`，`x-access: read` | 10 |
| `adminCreateEvent` | POST `/admin/events` | `x-permission: event_config`，`x-access: write` | 10 |
| `adminPublishEvent` | POST `/admin/events/{id}/publish` | `x-permission: event_publish`，`x-access: write` | 10 |

每个操作都声明 `default` 响应引用 `ErrorResponse`；handler 出错时直接返回 `error`，由 `HandlerErrorFunc` 交给 `httpx.WriteError`。

组件 schema（名称固定，字段 camelCase）：

| Schema | 字段 |
|---|---|
| `ErrorResponse` | `error: {code: string, message: string, fields?: map<string,string>}`（全部必填，fields 除外） |
| `Health` | `status: string` |
| `LocalizedText` | `zh?: string`，`en?: string`，`km?: string`，`additionalProperties: false` |
| `Role` | enum `ADMIN, OPS, FINANCE, SUPPORT, RACE_SUPERVISOR, RACE_STAFF, PHOTOGRAPHER` |
| `Access` | enum `read, write` |
| `Staff` | `id: int64`，`username`，`fullName`，`role: Role` |
| `Me` | `staff: Staff`，`permissions: map<string, Access>` |
| `LoginRequest` | `username: string (1..64)`，`password: string (1..256)` |
| `PublicCategory` | `code`，`name: string`，`distanceM: int32`，`capacity: int32`，`startAt: date-time`，`cutoffAt: date-time` |
| `PublicEvent` | `slug`，`name: string`，`city`，`raceDate: date`，`categories: PublicCategory[]` |
| `PublicEventList` | `items: PublicEvent[]` |
| `AdminCategory` | `id: int64`，`code`，`name: LocalizedText`，`distanceM: int32`，`capacity: int32`，`startAt: date-time nullable`，`cutoffAt: date-time nullable` |
| `AdminEvent` | `id: int64`，`slug`，`eventType: enum RACE, FREE_ACTIVITY`，`organizerType: enum OFFICIAL, PARTNER`，`name: LocalizedText`，`city`，`raceDate: date`，`status: enum DRAFT, PUBLISHED`，`publicVisible: boolean`，`publishedAt: date-time nullable`，`categories: AdminCategory[]` |
| `AdminEventList` | `items: AdminEvent[]` |
| `CreateCategoryRequest` | `code`，`name: LocalizedText`，`distanceM: int32`，`capacity: int32`，`startAt?: date-time nullable`，`cutoffAt?: date-time nullable` |
| `CreateEventRequest` | `slug`，`eventType`，`organizerType`，`name: LocalizedText`，`city`，`raceDate: date`，`categories: CreateCategoryRequest[]` |

响应：`getHealthz` → 200 `Health{status:"ok"}`；`getReadyz` → 数据库 Ping 成功 200 `Health{status:"ok"}`，失败 503 `Health{status:"unavailable"}`（yaml 同时声明 200 与 503，handler 返回 `apigen.GetReadyz503JSONResponse`）；`adminLogin` → 200 `Me`；`adminLogout` → 204；`adminGetMe` → 200 `Me`；`listPublicEvents` → 200 `PublicEventList`；`getPublicEvent` → 200 `PublicEvent`；`adminListEvents` → 200 `AdminEventList`；`adminCreateEvent` → 201 `AdminEvent`；`adminPublishEvent` → 200 `AdminEvent`。

### C8 权限映射（Task 5 生成器；Task 6 矩阵）

```go
package apigen    // permissions.gen.go 由 go run ./internal/httpapi/cmd/permgen 生成
type AuthKind string
const (
	AuthNone       AuthKind = "none"
	AuthSession    AuthKind = "session"
	AuthPermission AuthKind = "permission"
)
type OperationAuth struct {
	Kind       AuthKind
	Permission string   // Kind == AuthPermission 时非空，值为 iam 权限名
	Access     string   // "read" | "write"
}
var OperationAuths = map[string]OperationAuth{ /* key 为 strict 中间件收到的 operationID，即首字母大写的 Go 方法名，如 "AdminLogin"；permgen 负责转换 */ }

package iam
type Role string          // RoleAdmin="ADMIN" RoleOps="OPS" RoleFinance="FINANCE" RoleSupport="SUPPORT" RoleRaceSupervisor="RACE_SUPERVISOR" RoleRaceStaff="RACE_STAFF" RolePhotographer="PHOTOGRAPHER"
func ParseRole(s string) (Role, bool)
var AllRoles = []Role{...7 个，按上面顺序}
type Access string        // AccessRead="read" AccessWrite="write"
type Permission string    // 32 个，常量名 Perm + 驼峰，例 PermEventConfig="event_config"
var AllPermissions []Permission
func Allowed(role Role, p Permission, need Access) bool        // need=read：W 或 R 均可；need=write：只有 W
func PermissionsOf(role Role) map[Permission]Access            // 只含该角色有 R 或 W 的权限
```

矩阵内容逐格照抄 `requirements/run/admin.html` 第 753–789 行 `PERM`（`"W"`→`AccessWrite`，`"R"`→`AccessRead`，`""`→不写入）。

### C9 身份与会话（Task 7、8）

```go
package iam

const (
	CookieName      = "werun_admin_session"
	CookiePath      = "/api/admin"
	IdleTimeout     = 8 * time.Hour
	AbsoluteTimeout = 7 * 24 * time.Hour
	TouchInterval   = time.Minute
)

type Staff struct {
	ID       int64
	Username string
	FullName string
	Role     Role
}

type Clock func() time.Time

type LoginLimiter struct{ /* 未导出，互斥锁保护 */ }
func NewLoginLimiter(clock Clock) *LoginLimiter
func (l *LoginLimiter) AllowIP(ip string) bool          // 每 IP 每分钟 20 次（滑动一分钟窗口），超出返回 false
func (l *LoginLimiter) Locked(username string) bool
func (l *LoginLimiter) Failure(username string)         // 15 分钟内第 5 次失败时锁 15 分钟
func (l *LoginLimiter) Success(username string)

type Service struct{ /* 未导出 */ }
func NewService(pool *pgxpool.Pool, sessionSecret []byte, limiter *LoginLimiter, clock Clock) *Service
func (s *Service) CreateStaff(ctx context.Context, username, fullName string, role Role, password string) (Staff, error)
func (s *Service) Login(ctx context.Context, username, password string, meta httpx.Meta) (token string, staff Staff, err error)
// 错误：IP 超限 → CodeRateLimited；用户名被锁 → CodeAccountLocked；账号不存在/停用/密码错 → CodeInvalidCredentials
// 成功：写 sessions，写审计 staff.login；失败且用户存在：写审计 staff.login_failed；用户不存在：slog Warn
func (s *Service) Authenticate(ctx context.Context, token string) (Staff, error)
// 无效/过期/吊销 → CodeUnauthenticated；距上次续期超过 TouchInterval 时把 expires_at 更新为 min(now+IdleTimeout, created_at+AbsoluteTimeout)
func (s *Service) Logout(ctx context.Context, token string) error
func (s *Service) DeleteExpiredSessions(ctx context.Context, olderThan time.Duration) (int64, error)
// 删除 expires_at < now-olderThan 或 revoked_at < now-olderThan 的会话

func WithStaff(c *gin.Context, s Staff)                 // Task 8，写入键 "werun.staff"
func StaffFrom(ctx context.Context) (Staff, bool)       // Task 8
```

sessions 表没有"最后活跃时间"列：空闲过期通过滑动更新 `expires_at` 实现；"距上次续期"按 `expires_at` 推算为 `min(now+IdleTimeout, created_at+AbsoluteTimeout) - expires_at >= TouchInterval`。

### C10 审计（Task 7）

```go
package audit
type Entry struct {
	ActorType   string   // "USER" | "STAFF" | "SYSTEM"
	ActorID     *int64
	ActorRole   *string
	Action      string
	EntityType  string
	EntityID    int64
	EventID     *int64
	IsFinancial bool
	Summary     string
	Before      any      // 非 nil 时 JSON 编码写 before_data
	After       any
	Meta        httpx.Meta
}
func Record(ctx context.Context, tx pgx.Tx, e Entry) error
```

### C11 赛事模块（Task 10）

```go
package event

type Category struct {
	ID        int64
	Code      string
	Name      i18n.Text
	DistanceM int32
	Capacity  int32
	StartAt   *time.Time
	CutoffAt  *time.Time
}
type Event struct {
	ID            int64
	Slug          string
	EventType     string
	OrganizerType string
	Name          i18n.Text
	City          string
	RaceDate      time.Time   // 日期，UTC 零点
	Status        string      // "DRAFT" | "PUBLISHED"
	PublicVisible bool
	PublishedAt   *time.Time
	Categories    []Category
}
type CategoryInput struct {
	Code      string
	Name      i18n.Text
	DistanceM int32
	Capacity  int32
	StartAt   *time.Time
	CutoffAt  *time.Time
}
type CreateInput struct {
	Slug          string
	EventType     string
	OrganizerType string
	Name          i18n.Text
	City          string
	RaceDate      time.Time
	Categories    []CategoryInput
}

func ValidateCreate(in CreateInput) error      // 返回 *apperr.Error(CodeValidation) 带字段
func ValidateForPublish(e Event) error         // CodeEventAlreadyPublished / CodeEventNoCategory / CodeEventCategoryIncomplete

type Service struct{ /* 未导出 */ }
func NewService(pool *pgxpool.Pool) *Service
func (s *Service) Create(ctx context.Context, actor iam.Staff, in CreateInput) (Event, error)
func (s *Service) Publish(ctx context.Context, actor iam.Staff, id int64) (Event, error)
func (s *Service) ListAll(ctx context.Context) ([]Event, error)
func (s *Service) ListPublic(ctx context.Context) ([]Event, error)
func (s *Service) GetPublic(ctx context.Context, slug string) (Event, error)

type Handlers struct{ /* 未导出 */ }
func NewHandlers(svc *Service) *Handlers
// 实现 strict 接口的 ListPublicEvents / GetPublicEvent / AdminListEvents / AdminCreateEvent / AdminPublishEvent
```

约束映射（在 `event` 包 `init()` 中注册）：`events_slug_key` → `CodeEventSlugTaken` 字段 `slug`；`event_categories_event_id_code_key` → `CodeEventCategoryCodeTaken`。

### C12 服务装配（Task 4 建立，Task 5/8/9/10 扩充）

```go
package httpapi
// 各模块 handler 类型同名（Handlers），用导出的类型别名嵌入，避免字段重名
type IAMHandlers = iam.Handlers       // Task 8
type EventHandlers = event.Handlers   // Task 10
type Server struct {                  // 实现 apigen.StrictServerInterface
	*HealthHandlers                   // Task 5
	*IAMHandlers                      // Task 8
	*EventHandlers                    // Task 10
}
func NewHealthHandlers(pool *pgxpool.Pool) *HealthHandlers   // Task 5
func NewServer(d RouterDeps) *Server                         // Task 5 建立，Task 8、10 扩充
type RouterDeps struct {
	Log     *slog.Logger
	Catalog *i18n.Catalog
	Pool    *pgxpool.Pool
	IAM     *iam.Service     // Task 8
	Events  *event.Service   // Task 10
	Server  *Server          // 可选；nil 时 NewRouter 调用 NewServer(d)
	Env     string           // Task 8
}
func CSRFGuard(cat *i18n.Catalog, log *slog.Logger) gin.HandlerFunc   // Task 8：gin 中间件，/api/admin/ 下非 GET/HEAD（含登录）必须带 X-WeRun-Client: admin
func AuthMiddleware(svc *iam.Service, auths map[string]apigen.OperationAuth) apigen.StrictMiddlewareFunc   // Task 8

package iam
func NewHandlers(svc *Service, secureCookie bool) *Handlers   // Task 8
func NewRouter(d RouterDeps) *gin.Engine
// 中间件顺序：httpx.RequestID → httpx.AccessLog → httpx.Recover → httpx.Locale；
// gin 中间件 CSRFGuard（Task 8 加入，排在 Locale 之后）；strict 中间件：AuthMiddleware(d.IAM, apigen.OperationAuths)（Task 8 加入）
// gin 引擎 SetTrustedProxies 为 127.0.0.1/32、::1/128、10.0.0.0/8、172.16.0.0/12、192.168.0.0/16（Task 4 起），c.ClientIP() 取 Caddy 转发的真实客户端 IP
//
// 逐步演进（每个任务只加自己的字段）：
// - Task 4：RouterDeps 只有 Log、Catalog、Pool；NewRouter 手写 GET /api/healthz 与 GET /api/readyz（行为与最终一致），供命令行与测试先跑通。
// - Task 5：新增 Server 字段；删除手写路由，改为挂载 apigen 生成的 strict handler，原有测试保持通过。
// - Task 8：新增 IAM、Env 字段与 CSRFGuard、AuthMiddleware；Server 嵌入 *IAMHandlers。
// - Task 10：RouterDeps 新增 Events；Server 嵌入 *EventHandlers。
// - Task 9 在 cmd/werun/router.go 提供 newRouter(app *App) *gin.Engine，serve 命令用它装配路由。

package main
type App struct {
	Cfg     config.Config
	Log     *slog.Logger
	Catalog *i18n.Catalog
	Pool    *pgxpool.Pool
	IAM     *iam.Service      // Task 8
	Events  *event.Service    // Task 10
}
func Bootstrap(ctx context.Context) (*App, error)
func (a *App) Close()
```

命令行（`api/cmd/werun`）：

| 子命令 | 参数 | 任务 |
|---|---|---|
| `werun serve` | `--auto-migrate`（Task 4）、`--with-worker`（Task 9 加入） | 4 / 9 |
| `werun worker` | — | 9 |

命令函数签名（Task 4 确立）：`func run(ctx context.Context, args []string, stdout, stderr io.Writer) int`；`runServe(ctx, args, stderr) int`、`runWorker(ctx, args, stderr) int`（各自用 `signal.NotifyContext` 监听 SIGINT/SIGTERM）；`runMigrate`/`runHealthcheck(ctx, args, stdout, stderr) int`；`runCreateStaff(ctx, args) error`（由 `run` 包装成退出码）。
| `werun migrate up|down|status` | — | 4 |
| `werun healthcheck` | `--url`（默认 `http://127.0.0.1:8080/api/readyz`） | 4 |
| `werun create-staff` | `--username`、`--full-name`、`--role`、`--password-stdin` | 8 |

### C13 任务（Task 9）

```go
package jobs
type SessionCleanupArgs struct{}
func (SessionCleanupArgs) Kind() string                  // "session_cleanup"
type SessionCleaner interface {
	DeleteExpiredSessions(ctx context.Context, olderThan time.Duration) (int64, error)
}
type SessionCleanupWorker struct {
	river.WorkerDefaults[SessionCleanupArgs]
	Sessions SessionCleaner
	Log      *slog.Logger
}
type DailyAt struct {
	Hour, Minute int
	Loc          *time.Location
}
func (d DailyAt) Next(current time.Time) time.Time
func NewClient(pool *pgxpool.Pool, log *slog.Logger, sessions SessionCleaner) (*river.Client[pgx.Tx], error)
// 注册 SessionCleanupWorker；周期任务 DailyAt{3, 0, Asia/Phnom_Penh}，olderThan = 7 * 24h，队列 default MaxWorkers 10
```

### C13b sqlc 公共设置（Task 7 建立，Task 10 复用）

`api/sqlc.yaml`（`version: "2"`），每个模块一个 `sql` 块，公共设置一致：

```yaml
- engine: postgresql
  schema: db/migrations
  queries: db/queries/<模块>.sql
  gen:
    go:
      package: store
      out: internal/<模块>/store
      sql_package: pgx/v5
      emit_pointers_for_null_types: true
      overrides:
        - db_type: timestamptz
          go_type: time.Time
        - db_type: timestamptz
          nullable: true
          go_type:
            type: time.Time
            pointer: true
        - db_type: date
          go_type: time.Time
        - db_type: inet
          nullable: true
          go_type:
            import: net/netip
            type: Addr
            pointer: true
```

`jsonb` 保持 sqlc 默认的 `[]byte`，由模块自己 `json.Unmarshal` 成 `i18n.Text`。

### C14 Makefile 目标（根目录）

| 目标 | 行为 | 任务 |
|---|---|---|
| `setup` | `corepack enable`，`pnpm install`，`cd api && go mod download`，`.env` 不存在时复制 `.env.example` | 1 建立，11 补 pnpm |
| `gen` | `gen-api` + `gen-client` | 5 建立，13 补 gen-client |
| `gen-api` | oapi-codegen、permgen、sqlc | 5（sqlc 在 7 加入） |
| `gen-client` | `pnpm --filter @werun/api-client gen` | 13 |
| `lint` | `lint-api` + `pnpm lint` | 1 / 11 |
| `lint-api` | `cd api && go tool golangci-lint run ./...` | 1 |
| `test` | `test-api` + `test-web` | 1 / 11 |
| `test-api` | `cd api && go test ./...` | 1 |
| `test-web` | `pnpm typecheck && pnpm test && pnpm i18n:check` | 11 |
| `migrate-up` / `migrate-status` | `cd api && go run ./cmd/werun migrate up|status`（读取根 `.env`） | 4 |
| `create-staff` | `cd api && go run ./cmd/werun create-staff $(ARGS)` | 8 |
| `dev` | 起 compose.dev 的 postgres 与 caddy，并行运行 `dev-api`、`dev-user`、`dev-admin` | 16 |
| `e2e` | `pnpm --filter @werun/e2e test` | 17 |

Makefile 中读取根 `.env` 的方式：`set -a; . ./.env; set +a;` 前缀于命令之前。

### C15 前端包（Task 11–15）

```ts
// @werun/tokens（Task 11）
import "@werun/tokens/tokens.css";   // CSS 变量
import "@werun/tokens/fonts.css";    // fontsource 字重
export const brand: { primary: "#0F66AE"; primaryDeep: "#0A4D85"; ink: "#101820"; paper: "#F6F8FA"; radius: 14 };

// @werun/i18n（Task 12）
export type Lang = "zh" | "en" | "km";
export const LANGS: readonly Lang[];                  // ["zh", "en", "km"]
export const DEFAULT_LANG: Lang;                      // "km"
export const STORAGE_KEY = "werun.lang";
export function initI18n(app: "user" | "admin"): i18n; // 命名空间 common + app；语言取 localStorage，否则 DEFAULT_LANG
export function setLanguage(lang: Lang): Promise<void>;
export function currentLang(): Lang;
export function applyDocumentLang(lang: Lang): void;  // html[lang] 与 data-script
// 文案文件 packages/i18n/locales/{zh,en,km}/{common,user,admin}.json；脚本 pnpm --filter @werun/i18n check

// @werun/api-client（Task 13）
export type { paths, components } from "./schema";   // openapi-typescript 生成 src/schema.d.ts
export type Schemas = components["schemas"];
export class ApiError extends Error { status: number; code: string; fields: Record<string, string>; }
export interface ApiClientOptions {
  client: "user" | "admin";
  baseUrl?: string;                                   // 默认 "/api"
  getLang: () => string;
  onUnauthorized?: () => void;
}
export function createApiClient(opts: ApiClientOptions): Client<paths>;   // openapi-fetch Client
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T;  // 非 2xx 抛 ApiError
```

pnpm 包名：`@werun/tokens`、`@werun/i18n`、`@werun/api-client`、`@werun/user`、`@werun/admin`、`@werun/e2e`。根脚本：`typecheck`、`lint`、`test`、`build`、`i18n:check`。

后台 query key：`["me"]`、`["admin","events"]`；用户端：`["events", lang]`、`["event", slug, lang]`（接口按语言返回名称，切换语言要重新请求）。

### C16 前端测试 ID（Task 14、15、17 共用）

| data-testid | 位置 |
|---|---|
| `lang-switch-zh` / `lang-switch-en` / `lang-switch-km` | 两端语言切换按钮 |
| `event-card` | 用户端赛事卡片（含赛事名） |
| `login-username` / `login-password` / `login-submit` | 后台登录页 |
| `event-create-button` | 后台赛事列表"新建赛事"按钮 |
| `event-form-submit` | 后台新建赛事表单提交 |
| `event-publish-<slug>` | 后台赛事列表每行的发布按钮 |
| `forbidden-page` | 后台 403 页 |

后台新建赛事表单是 antd `Form name="event"`，端到端测试用自动生成的 id 定位：`#event_slug`、`#event_name_{zh,en,km}`、`#event_city`、`#event_raceDate`、`#event_categories_0_{code,distanceM,capacity,startAt,cutoffAt}`、`#event_categories_0_name_{zh,en,km}`。表单默认带一个空组别。

---

### C17 分册核对后的补充（与各分册一致，冲突时以本节为准）

1. **迁移文件改动**：goose 不识别 `$$`，Task 3 给迁移里的 5 个 PL/pgSQL 函数包上 `-- +goose StatementBegin` / `-- +goose StatementEnd`。
2. **dbtest 模板库名**为 `werun_template_<pid>`，避免多个测试进程共用 `WERUN_TEST_DATABASE_URL` 时互删模板库。
3. **`httpx.LangOf`、`httpx.RequestIDOf`** 在 Task 2 的 `httpx/ctx.go` 定义（`WriteError` 要用），Task 4 补齐其余中间件与 `MetaOf`、`Gin`。
4. **契约外新增的导出**：`Config.PIIKeyBytes()`（Task 1）、`apperr.AllCodes`（Task 2，文案覆盖测试用）。
5. **`werun migrate down`** 只回退 goose 版本记录：迁移文件没有 Down 段，不会删表。
6. **oapi-codegen 配置**加 `compatibility.always-prefix-enum-values: true`，枚举常量形如 `apigen.RoleOPS`、`apigen.AccessWrite`。
7. **员工用户名重复**（约束 `staff_username_key`）映射为 `VALIDATION_FAILED`，字段 `username`；密码过短用 `field.invalid`。
8. **Go 依赖追加** `golang.org/x/term v0.46.0`（create-staff 交互输入密码）。Task 1 一次性加入全部依赖，后续任务不要提前执行 `go mod tidy`。
9. **表单字段错误的 key 格式**是请求 JSON 的字段路径：`slug`、`name.km`、`categories[0].code`（前端也接受 `categories.0.code`）。
10. **npm 追加依赖**：`@types/node 24.13.4`、`@types/react 19.3.0`、`@types/react-dom 19.3.0`、`@testing-library/dom 10.4.1`、`globals 16.5.0`、`@ant-design/v5-patch-for-react-19 1.0.3`（antd 5 在 React 19 下必须引入）。
11. **前端包追加导出**：`@werun/i18n` 的 `isLang`、`LANG_LABELS`、`useLang()`；`@werun/api-client` 的 `type ApiClient`、`ErrorBody`、`UNEXPECTED_RESPONSE`。
12. **Vite 开发服务器**由 Makefile 以 `--host 0.0.0.0 --port 517x --strictPort` 启动，`vite.config.ts` 设置 `allowedHosts` 与 `hmr.clientPort: 80`，经本地 Caddy 访问。
13. **`--password-stdin`** 读取一行并去掉结尾换行。

## 任务依赖

```
T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10
                         T5 → T13（需要 openapi.yaml）
T11 → T12 → T13 → T14
                  T13 → T15（需要 T8、T10 的接口已在 yaml 中）
T10、T14、T15 → T16 → T17 → T18
```
