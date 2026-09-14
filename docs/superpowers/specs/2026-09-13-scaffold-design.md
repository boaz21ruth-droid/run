# WeRun 项目脚手架设计

- 日期：2026-09-13
- 状态：待评审
- 范围：仓库骨架 + 一条端到端样例（后台 OPS 新建并发布赛事 → 用户端看到赛事列表）
- 相关文档：`docs/database/db-design.html`（数据库设计）、`requirements/run/`（Demo）

## 1. 目标与不做的事

### 1.1 目标

搭出一个可以直接在上面开发业务功能的仓库，并用一条最小链路证明以下部件全部接通：
Go 后端、PostgreSQL 迁移、sqlc、OpenAPI 代码生成、员工登录与角色权限、两个 React 前端、三语切换、Caddy、docker compose、GitHub Actions。

### 1.2 本次不做

- 跑者（用户端）登录、Telegram `initData` 服务端校验
- 报名、收款凭证、退款等业务模块
- 文件上传
- EC2 部署流水线、Terraform
- 员工双重验证（`staff.totp_secret_enc` 字段已预留）
- 分享卡片 OG 标签注入

## 2. 已定技术选型

| 部分 | 选型 |
|---|---|
| 后端 | Go 1.26、Gin、pgx/v5 + sqlc、goose、River（PostgreSQL 任务队列）、slog |
| 接口 | OpenAPI 3（`api/openapi/openapi.yaml`）规范优先；oapi-codegen 生成 Gin 服务端，openapi-typescript + openapi-fetch 生成前端客户端 |
| 前端 | React 19、TypeScript strict、Vite、React Router、TanStack Query、react-i18next |
| 用户端样式 | v7 设计令牌（CSS 变量）+ CSS Modules |
| 后台 UI | Ant Design 5 |
| 包管理 | pnpm workspace（通过 corepack 启用）；Go 工具用 `go.mod` 的 `tool` 指令锁定版本 |
| 运行 | docker compose：postgres、migrate、api、caddy |
| CI | GitHub Actions，镜像推送 GHCR |
| Node | CI 与镜像用 Node 24 LTS |

## 3. 仓库结构

```
werun/
├─ api/
│  ├─ cmd/werun/               子命令：serve [--with-worker] [--auto-migrate] / worker / migrate up|down|status / create-staff / healthcheck
│  ├─ internal/
│  │  ├─ platform/             config、log、db（连接池、InTx）、river、middleware、apperr、i18n、money
│  │  ├─ iam/                  员工登录、会话、权限矩阵、赛事指派范围
│  │  ├─ audit/                审计写入（在调用方事务内）
│  │  ├─ event/                赛事模块：handler / service / store
│  │  └─ httpapi/              oapi-codegen 生成代码、x-permission 映射表、路由装配
│  ├─ db/migrations/           goose 迁移（由 docs/database/migrations 移入）
│  ├─ db/queries/              sqlc 查询 SQL
│  ├─ db/tests/                数据库约束测试（由 docs/database/tests 移入）
│  ├─ openapi/openapi.yaml
│  ├─ sqlc.yaml
│  ├─ Dockerfile
│  └─ go.mod
├─ web/
│  ├─ user/                    用户端（官网 / H5 / Telegram MiniApp 共用）
│  └─ admin/                   后台
├─ packages/
│  ├─ api-client/              @werun/api-client
│  ├─ i18n/                    @werun/i18n
│  └─ tokens/                  @werun/tokens
├─ e2e/                        Playwright 端到端测试
├─ deploy/
│  ├─ compose.yaml
│  ├─ compose.dev.yaml
│  ├─ Caddyfile
│  ├─ Caddyfile.dev
│  └─ web.Dockerfile
├─ .github/workflows/ci.yml
├─ .env.example
├─ Makefile
├─ package.json
├─ pnpm-workspace.yaml
├─ docs/
└─ requirements/
```

约定：

- Go 模块路径暂用 `werun/api`；GitHub 仓库建好后统一替换为 `github.com/<org>/werun/api`。
- 按业务模块分包，每个模块内部分 handler / service / store；模块之间只通过 service 接口调用，不直接访问对方的 store。
- 生成代码提交进仓库。`make gen` 重新生成全部代码；CI 执行 `make gen` 后要求 `git diff --exit-code` 为空。
- 迁移文件移入 `api/db/migrations`，`docs/database/db-design.html` 里的路径同步更新。

## 4. 运行与部署

### 4.1 域名与路由

| 域名 | Caddy 行为 |
|---|---|
| `werun.com.kh` | 提供 `web/user` 构建产物（SPA 回退到 `index.html`）；`/api/*` → api:8080；`/files/public/*` → 数据盘静态文件 |
| `admin.werun.com.kh` | 提供 `web/admin` 构建产物；`/api/*` → api:8080 |

- 域名由 `WERUN_USER_HOST`、`WERUN_ADMIN_HOST` 配置，`werun.com.kh` 为占位值。
- 后台接口统一前缀 `/api/admin/`。后台会话 Cookie 只设在后台域名上，与用户端隔离。

### 4.2 compose 服务

| 服务 | 说明 |
|---|---|
| `postgres` | `postgres:16-alpine`，数据卷 `pgdata` |
| `migrate` | 执行 `werun migrate up`，退出码为 0 后 `api` 才启动（`depends_on: condition: service_completed_successfully`） |
| `api` | `werun serve --with-worker`；容器健康检查执行 `werun healthcheck`（distroless 镜像没有 curl，由二进制自己请求 `/api/readyz`） |
| `caddy` | `werun-web` 镜像；`api` 健康后启动 |

### 4.3 镜像

- `werun-api`：多阶段构建，运行镜像 `gcr.io/distroless/static-debian12:nonroot`，`CGO_ENABLED=0`，linux/arm64 + linux/amd64。
- `werun-web`：Node 24 阶段构建两个前端，运行阶段为 `caddy:2-alpine`，带入两个 `dist` 和 `Caddyfile`。

### 4.4 配置

全部为环境变量，`.env.example` 列出全部键：

| 变量 | 用途 |
|---|---|
| `WERUN_DATABASE_URL` | PostgreSQL 连接串 |
| `WERUN_HTTP_ADDR` | 默认 `:8080` |
| `WERUN_SESSION_SECRET` | 会话令牌 HMAC 密钥 |
| `WERUN_PII_KEY` | 个人信息 AES-GCM 密钥（base64，32 字节） |
| `WERUN_FILES_DIR` | 文件根目录 |
| `WERUN_USER_HOST` / `WERUN_ADMIN_HOST` | 两个站点域名 |
| `WERUN_ENV` | `dev` / `prod`；`dev` 下 Cookie 不强制 Secure |
| `WERUN_LOG_LEVEL` | 默认 `info` |

生产环境的值存 SSM Parameter Store，部署时渲染为 `.env`（部署流水线不在本次范围）。

### 4.5 本地开发

- `make setup`：`corepack enable`、`pnpm install`、`go mod download`、复制 `.env.example` 为 `.env`。
- `make dev`：
  - compose（`compose.dev.yaml`）启动 `postgres` 与 `caddy`；caddy 使用 `Caddyfile.dev`，端口 80。
  - Go 由 `go tool air` 热重载，执行 `werun serve --with-worker --auto-migrate`，监听本机 `:8080`。`--auto-migrate` 只在本地使用，生产由 `migrate` 服务执行迁移。
  - `pnpm --filter user dev`（5173）、`pnpm --filter admin dev`（5174）。
  - `Caddyfile.dev`：`werun.localhost` → 5173，`admin.werun.localhost` → 5174，两者的 `/api/*` → `host.docker.internal:8080`。
- 浏览器会把 `*.localhost` 解析到本机，无需修改 hosts。

## 5. Go 后端

### 5.1 中间件顺序

1. 请求 ID（`X-Request-ID`，缺失时生成）
2. slog JSON 访问日志
3. panic 恢复，返回 `INTERNAL` 错误
4. 语言识别：`?lang=` → `Accept-Language` → 默认 `km`；只接受 `zh` / `en` / `km`
5. 会话认证（仅 `/api/admin/*`，登录接口除外）
6. 权限校验：按 `x-permission` 映射表
7. 赛事范围校验：仅对 `PHOTOGRAPHER` / `RACE_SUPERVISOR` / `RACE_STAFF`，且接口带赛事 ID 时生效

### 5.2 权限

- `openapi.yaml` 中每个后台操作声明 `x-permission: <操作>` 和 `x-access: read | write`。
- 代码生成步骤产出 `operationId → {permission, access}` 映射表。未声明 `x-permission` 的后台操作在生成时报错。
- `iam` 包内以 Go 代码保存 Demo（`admin.html` PERM 表）的权限矩阵：`permission × role → W | R | 无`。`x-access: write` 需要 W；`read` 需要 W 或 R。
- `GET /api/admin/me` 返回当前员工、角色和其全部权限（W/R），供前端过滤菜单与按钮。

样例涉及的矩阵行（与 Demo 一致）：

| 操作 | ADMIN | OPS | FINANCE | SUPPORT | RACE_SUPERVISOR | RACE_STAFF | PHOTOGRAPHER |
|---|---|---|---|---|---|---|---|
| `event_config` | R | W | R | — | — | — | — |
| `event_publish` | R | W | — | R | — | — | — |

Demo 权限矩阵的全部 32 个操作一次性写入，供后续模块直接使用；人工审核收款新增的操作在收款迭代中补充。

### 5.3 错误

- 业务代码返回 `apperr.Error{Code, Status, Fields, Params}`。
- HTTP 响应：`{"error":{"code":"EVENT_SLUG_TAKEN","message":"<按语言>","fields":{"slug":"<按语言>"}}}`。
- 文案文件：`internal/platform/i18n/messages.{zh,en,km}.json`；单元测试校验三个文件 key 一致。
- PostgreSQL 错误映射：唯一约束（23505）、CHECK（23514）、外键（23503）按约束名映射为业务错误码；未映射的返回 `INTERNAL` 并记录日志，不向前端暴露 SQL 细节。

### 5.4 登录与会话

- 密码：argon2id（m=64MB、t=3、p=2）。
- 登录限流：同一 IP 每分钟 20 次，同一用户名每 15 分钟连续失败 5 次后锁定 15 分钟；内存计数（一期单实例）。
- 登录成功写 `audit_logs`（`action=staff.login`）。登录失败时，用户名存在则写 `audit_logs`（`action=staff.login_failed`，`entity` 为该员工，`actor_type=SYSTEM`）；用户名不存在只写 slog 警告日志，因为 `audit_logs.entity_id` 必填。
- 会话：32 字节随机令牌，Cookie 名 `werun_admin_session`，`HttpOnly`、`SameSite=Lax`、`Path=/api/admin`、生产环境 `Secure`；`sessions.token_hash` 存 HMAC-SHA256。
- 过期：空闲 8 小时，绝对 7 天；每次请求刷新空闲时间，写库节流为最多 1 分钟一次。
- CSRF：`/api/admin/*` 的非 GET 请求必须带 `X-WeRun-Client: admin`，否则 403。
- `werun create-staff --username <u> --full-name <n> --role <ROLE>`：默认交互输入两次密码；加 `--password-stdin` 时从标准输入读取，供 CI 与脚本使用。

### 5.5 数据库、事务与任务

- `db.InTx(ctx, func(tx pgx.Tx) error) error`：统一事务入口；sqlc 的 `Queries.WithTx(tx)`。
- `audit.Record(ctx, tx, entry)` 必须传事务。
- River 任务通过 `InsertTx` 在同一事务内入队。
- `werun migrate up` 先执行 goose 业务迁移，再调用 `rivermigrate` 执行 River 自带迁移（River 用自己的 `river_migration` 表记录版本，升级 River 时无需手工同步 SQL）。
- 样例定时任务 `session_cleanup`：每天 03:00（金边时间）删除过期超过 7 天的会话。
- `money.Cents`（int64）用于全部金额；时间以 UTC 存储，展示时转换为 `Asia/Phnom_Penh`。
- 优雅退出：收到 SIGTERM 后停止接收请求，等待进行中的请求与任务最多 30 秒。

### 5.6 测试

- service 层：单元测试。
- store 与 HTTP handler：集成测试，testcontainers-go 启动 `postgres:16-alpine` 并执行全部迁移。
- 数据库约束测试 `api/db/tests/invariants_test.sql`：由 Go 测试加载执行，要求输出中无 `FAIL`。

## 6. 前端

### 6.1 共用包

**@werun/api-client**
- `openapi-typescript` 生成 `schema.d.ts`，`openapi-fetch` 创建客户端。
- 统一：`credentials: "include"`、`X-WeRun-Client`、`Accept-Language` 取当前语言。
- 非 2xx 响应转换为 `ApiError { status, code, message, fields }`。
- 暴露 `onUnauthorized` 回调，由各端注册。

**@werun/i18n**
- `locales/{zh,en,km}/{common,user,admin}.json`。
- `setLanguage(lang)`：切换 i18next、写 `document.documentElement.lang`、存 localStorage 键 `werun.lang`。
- 高棉文时根元素加 `data-script="khmer"`，令牌中对应调整字号与行高。
- `pnpm i18n:check`：三语 key 集合必须一致，CI 执行。

**@werun/tokens**
- `tokens.css`：v7 的颜色、圆角、阴影、字体变量（取自 `requirements/run/design-v7/build.mjs`）。
- 自托管字体：Inter 400/600/700/800 与 Noto Sans Khmer 400/600/700，每个字重是独立文件；`unicode-range` 分包。

### 6.2 用户端 `web/user`

- 路由：`/`（首页近期赛事）、`/events`、`/events/:slug`、`*`（404）。
- 手机优先，基准宽度 390px，桌面断点 1024px，内容最大宽度 1184px（v7 `.shell`）。
- 头部：品牌 + 语言切换（中 / EN / ខ្មែរ）。
- Telegram 适配：URL 含 `tgWebAppData` 时才动态加载 `telegram-web-app.js`，调用 `ready()`、`expand()`，同步 `themeParams` 与 `viewportStableHeight` 到 CSS 变量，`BackButton` 与路由历史联动。

### 6.3 后台 `web/admin`

- Ant Design 5，`ConfigProvider` 主题主色 `#0F66AE`，语言包随 i18n 切换（`zh_CN` / `en_US` / `km_KH`）。
- 启动时请求 `/api/admin/me`：401 跳 `/login`；成功后存入 Query 缓存。
- 布局：侧边菜单 + 顶栏（当前员工、角色、语言切换、退出）。菜单项声明所需权限，无权限不显示。
- 路由守卫：无权限的路由显示 403 页。
- 页面：`/login`、`/events`（列表：名称、日期、城市、状态、操作）、`/events/new`（名称三语、slug、城市、比赛日期、组别列表：代码、名称三语、距离、名额、发枪时间、关门时间）。
- 按钮级权限：无 `event_config` W 时隐藏"新建赛事"；无 `event_publish` W 时隐藏"发布"。

### 6.4 前端测试

- Vitest + Testing Library：i18n 切换、权限过滤菜单、ApiError 展示。
- Playwright（`e2e/`）：见 7.3。

## 7. 端到端样例

### 7.1 接口

| 方法与路径 | x-permission / 访问 | 说明 |
|---|---|---|
| `GET /api/healthz` | 公开 | 200 `{"status":"ok"}` |
| `GET /api/readyz` | 公开 | 数据库 ping 成功 200，否则 503 |
| `GET /api/events` | 公开 | `status=PUBLISHED AND public_visible`，按 `race_date` 升序；名称按请求语言返回，缺失时回退 `en` → `zh` |
| `GET /api/events/{slug}` | 公开 | 同上条件；含组别；不存在返回 404 `EVENT_NOT_FOUND` |
| `POST /api/admin/auth/login` | 公开 | 用户名 + 密码；成功设置 Cookie，返回同 `me` |
| `POST /api/admin/auth/logout` | 登录 | 吊销会话，清除 Cookie |
| `GET /api/admin/me` | 登录 | 员工、角色、权限 |
| `GET /api/admin/events` | `event_config` / read | 全部赛事，名称返回三语对象 |
| `POST /api/admin/events` | `event_config` / write | 创建 `DRAFT` 赛事及组别，写审计 `event.create` |
| `POST /api/admin/events/{id}/publish` | `event_publish` / write | 校验后置为 `PUBLISHED`、`public_visible=true`，写审计 `event.publish` |

### 7.2 发布校验（样例版）

- 赛事当前为 `DRAFT`，否则 409 `EVENT_ALREADY_PUBLISHED`。
- 至少一个组别，否则 422 `EVENT_NO_CATEGORY`。
- 每个组别 `capacity > 0` 且 `start_at`、`cutoff_at` 非空、`cutoff_at > start_at`，否则 422 `EVENT_CATEGORY_INCOMPLETE`，`fields` 指出组别代码与缺失项。
- Demo 的完整规则还要求每个组别配置价格档，在报名迭代中加入。

### 7.3 Playwright 流程

1. 通过 `werun create-staff --password-stdin` 在测试环境创建 `ops.e2e`（OPS）与 `admin.e2e`（ADMIN）。
2. `ops.e2e` 登录后台 → 新建赛事（含一个组别）→ 发布。
3. 打开用户端 `/events`，能看到该赛事；切换到 ខ្មែរ 后显示高棉文名称且 `<html lang="km">`。
4. `admin.e2e` 登录后台：赛事列表可见，"新建赛事"按钮不存在；直接 `POST /api/admin/events` 返回 403，`message` 为当前语言。

## 8. CI（`.github/workflows/ci.yml`）

| Job | 步骤 | 依赖 |
|---|---|---|
| `backend` | setup-go → `go tool golangci-lint run` → `make gen` + `git diff --exit-code` → `go test ./...`（含 testcontainers 与约束测试） | — |
| `frontend` | corepack + pnpm（`--frozen-lockfile`）→ `pnpm typecheck` → `pnpm lint` → `pnpm test` → `pnpm i18n:check` → `pnpm build` | — |
| `e2e` | `docker compose -f deploy/compose.yaml up -d --build --wait` → 创建测试员工 → `pnpm --filter e2e test` → 失败时上传 Playwright 报告 | `backend`、`frontend` |
| `images` | 仅 `main` 分支 push：buildx 构建 `linux/arm64,linux/amd64` 的 `werun-api`、`werun-web`，推送 `ghcr.io/<owner>/werun-api:<sha>` 与 `:main` | `e2e` |

触发：`pull_request` 与 `push` 到 `main`。

## 9. 验收标准

1. 新克隆仓库执行 `make setup && make dev`，`http://werun.localhost` 与 `http://admin.werun.localhost` 均可打开。
2. `make test` 全部通过（需要本机 Docker，用于 testcontainers）。
3. CI 四个 job 全部通过。
4. 第 7.3 节 Playwright 流程通过。
5. 语言切换后当前页面文案与 `<html lang>` 同步变化；刷新后保持所选语言。

## 10. Git 与安全

- 根目录执行 `git init -b main`。
- `.gitignore` 排除 `.env`、`.env.*`（保留 `.env.example`）、`.vercel/`、`node_modules/`、`dist/`、测试报告与本地数据目录。
- 首次提交前检查暂存区，确认不包含 `requirements/run/.env.local`、`requirements/run/.vercel/`。
