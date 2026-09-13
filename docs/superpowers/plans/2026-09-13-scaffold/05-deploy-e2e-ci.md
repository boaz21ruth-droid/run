# Part 05：镜像、compose、本地开发、端到端测试与 CI（Task 16–18）

> 全局约束、依赖版本和跨任务契约见 `00-overview.md`，本文件所有任务都默认遵守。前置：Task 1–15 已完成。

本部分用到的外部版本（2026-09-13 核对）：

| 项 | 版本 |
|---|---|
| `actions/checkout` | `v7`（最新 v7.0.1） |
| `actions/setup-go` | `v7`（最新 v7.0.0） |
| `actions/setup-node` | `v7`（最新 v7.0.0） |
| `actions/upload-artifact` | `v7`（最新 v7.0.1） |
| `docker/setup-qemu-action` | `v4`（最新 v4.3.0） |
| `docker/setup-buildx-action` | `v4`（最新 v4.3.0） |
| `docker/login-action` | `v4`（最新 v4.6.0） |
| `docker/build-push-action` | `v7`（最新 v7.3.0） |
| actionlint 镜像 | `rhysd/actionlint:1.7.12` |
| `@types/node` | `24.13.4` |
| air 配置键 | `entrypoint`（数组）、`include_ext`、`exclude_dir`、`send_interrupt`、`kill_delay`、`clean_on_exit`（v1.67.4 源码核对） |

---

### Task 16：镜像、Caddy、compose 与本地开发

**Files:**
- Create: `.dockerignore`
- Create: `api/Dockerfile`
- Create: `deploy/web.Dockerfile`
- Create: `deploy/Caddyfile`
- Create: `deploy/Caddyfile.dev`
- Create: `deploy/compose.yaml`
- Create: `deploy/compose.dev.yaml`
- Create: `api/.air.toml`
- Modify: `Makefile`（追加 `dev`、`dev-down`、`dev-api`、`dev-user`、`dev-admin`、`compose-up`、`compose-down`、`build-images`）

**Interfaces:**
- Consumes：
  - `werun` 二进制子命令：`serve --with-worker [--auto-migrate]`、`migrate up`、`healthcheck`（默认请求 `http://127.0.0.1:8080/api/readyz`，非 200 退出码为 1）。
  - 环境变量（C1）：`WERUN_ENV`、`WERUN_HTTP_ADDR`、`WERUN_DATABASE_URL`、`WERUN_SESSION_SECRET`、`WERUN_PII_KEY`、`WERUN_FILES_DIR`、`WERUN_LOG_LEVEL`；Caddy 专用 `WERUN_USER_HOST`、`WERUN_ADMIN_HOST`。
  - 根 `.env`（`make setup` 由 `.env.example` 复制）；本地开发时其中 `WERUN_DATABASE_URL=postgres://werun:werun@localhost:55432/werun?sslmode=disable`。
  - pnpm 工作区（Task 11）：`pnpm-workspace.yaml` 包含 `packages/*`、`web/*`、`e2e`；`@werun/user`、`@werun/admin` 都有 `build` 与 `dev` 脚本，构建产物分别在 `web/user/dist`、`web/admin/dist`。
- Produces：
  - 镜像 `werun-api:local`（入口 `/werun`，默认命令 `serve --with-worker`，端口 8080）与 `werun-web:local`（Caddy，内含 `/srv/user`、`/srv/admin`、`/etc/caddy/Caddyfile`）。
  - compose 服务名 `postgres`、`migrate`、`api`、`caddy`（Task 17 的种子脚本和 Task 18 的 CI 依赖这些名字）；数据库名、用户名均为 `werun`，密码取 `POSTGRES_PASSWORD`，默认 `werun`。
  - Make 目标：`dev`、`dev-down`、`dev-api`、`dev-user`、`dev-admin`、`compose-up`、`compose-down`、`build-images`。

> 说明：API 容器以 distroless 的 nonroot 用户（UID 65532）运行。镜像里预先建好属主为 65532 的 `/data/files/public`，Docker 第一次挂载空的命名卷时会把这个目录的属主一起复制过去，API 才能写文件。Caddy 容器把同一个卷只读挂在 `/srv/files`，避免和 Caddy 自己的 `/data`（证书目录）重叠。

- [ ] **Step 1：写 `.dockerignore`**

构建上下文是仓库根目录，先排除依赖、构建产物和密钥，避免把 `.env`、`requirements/` 的大文件发给 Docker。

```gitignore
.git
**/node_modules
**/dist
**/coverage
e2e/playwright-report
e2e/test-results
api/tmp
api/bin
deploy/data
requirements
docs
.env
.env.*
!.env.example
**/.vercel
**/.DS_Store
```

- [ ] **Step 2：写 `api/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7

# ---- 构建阶段：在构建机本地架构上交叉编译，避免 QEMU 模拟编译 ----
FROM --platform=$BUILDPLATFORM golang:1.26 AS build
WORKDIR /src

COPY api/go.mod api/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

COPY api/ ./

ARG TARGETOS
ARG TARGETARCH
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /out/werun ./cmd/werun

# 文件目录预先建好，属主为 distroless nonroot（65532）
RUN mkdir -p /out/data/files/public

# ---- 运行阶段 ----
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/werun /werun
COPY --from=build --chown=65532:65532 /out/data /data
ENV WERUN_HTTP_ADDR=:8080 \
    WERUN_FILES_DIR=/data/files
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/werun"]
CMD ["serve", "--with-worker"]
```

- [ ] **Step 3：写 `deploy/web.Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7

# ---- 构建阶段：两个前端的静态产物与 CPU 架构无关，固定在构建机本地架构上构建 ----
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable

# 先只复制清单文件，依赖安装层可以被缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/tokens/package.json packages/tokens/
COPY packages/i18n/package.json packages/i18n/
COPY packages/api-client/package.json packages/api-client/
COPY web/user/package.json web/user/
COPY web/admin/package.json web/admin/
COPY e2e/package.json e2e/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

COPY tsconfig.base.json ./
COPY packages ./packages
COPY web ./web
RUN pnpm --filter @werun/user --filter @werun/admin run build

# ---- 运行阶段 ----
FROM caddy:2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/web/user/dist /srv/user
COPY --from=build /repo/web/admin/dist /srv/admin
```

- [ ] **Step 4：写 `deploy/Caddyfile`**

站点地址直接取环境变量：本地和 CI 用 `http://werun.localhost`（带 `http://` 时 Caddy 不申请证书），生产用 `werun.com.kh`（自动 HTTPS）。Vite 构建的带哈希资源都在 `/assets/` 下，给一年缓存；其余路径（含 `index.html` 的 SPA 回退）一律 `no-cache`。

```caddyfile
{
	admin off
}

# 单页应用：先找真实文件，找不到回退 index.html
(spa) {
	root * {args[0]}
	encode zstd gzip

	@hashed path /assets/*
	header @hashed Cache-Control "public, max-age=31536000, immutable"

	@unhashed not path /assets/*
	header @unhashed Cache-Control "no-cache"

	try_files {path} /index.html
	file_server
}

{$WERUN_USER_HOST} {
	handle /api/* {
		reverse_proxy api:8080
	}

	handle_path /files/public/* {
		root * /srv/files/public
		header Cache-Control "public, max-age=86400"
		file_server
	}

	handle {
		import spa /srv/user
	}
}

{$WERUN_ADMIN_HOST} {
	handle /api/* {
		reverse_proxy api:8080
	}

	handle {
		import spa /srv/admin
	}
}
```

- [ ] **Step 5：写 `deploy/compose.yaml`**

`migrate` 与 `api` 共用 `werun-api` 镜像，两处都写同样的 `build`（第二次构建完全命中缓存）。数据库地址在 compose 里用服务名覆盖 `.env` 中给本地开发用的 `localhost:55432`。Caddy 只拿站点地址两个变量，不接触其它密钥。

```yaml
name: werun

x-api-build: &api-build
  context: ..
  dockerfile: api/Dockerfile

x-api-env: &api-env
  WERUN_DATABASE_URL: postgres://werun:${POSTGRES_PASSWORD:-werun}@postgres:5432/werun?sslmode=disable
  WERUN_HTTP_ADDR: ":8080"
  WERUN_FILES_DIR: /data/files

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: werun
      POSTGRES_USER: werun
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-werun}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U werun -d werun"]
      interval: 5s
      timeout: 3s
      retries: 30
    restart: unless-stopped

  migrate:
    image: ${WERUN_API_IMAGE:-werun-api:local}
    build: *api-build
    command: ["migrate", "up"]
    env_file: ../.env
    environment: *api-env
    depends_on:
      postgres:
        condition: service_healthy
    restart: "no"

  api:
    image: ${WERUN_API_IMAGE:-werun-api:local}
    build: *api-build
    command: ["serve", "--with-worker"]
    env_file: ../.env
    environment: *api-env
    volumes:
      - files:/data/files
    depends_on:
      postgres:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    healthcheck:
      test: ["CMD", "/werun", "healthcheck"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 10s
    restart: unless-stopped

  caddy:
    image: ${WERUN_WEB_IMAGE:-werun-web:local}
    build:
      context: ..
      dockerfile: deploy/web.Dockerfile
    environment:
      WERUN_USER_HOST: ${WERUN_USER_HOST:?WERUN_USER_HOST is required}
      WERUN_ADMIN_HOST: ${WERUN_ADMIN_HOST:?WERUN_ADMIN_HOST is required}
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - caddy_data:/data
      - caddy_config:/config
      - files:/srv/files:ro
    depends_on:
      api:
        condition: service_healthy
    restart: unless-stopped

volumes:
  pgdata:
  files:
  caddy_data:
  caddy_config:
```

- [ ] **Step 6：写本地开发用的 `deploy/compose.dev.yaml` 与 `deploy/Caddyfile.dev`**

本地开发只用 compose 起 Postgres 和 Caddy；Go 与两个 Vite 在宿主机运行。项目名用 `werun-dev`，数据卷与生产 compose 分开。

`deploy/compose.dev.yaml`：

```yaml
name: werun-dev

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: werun
      POSTGRES_USER: werun
      POSTGRES_PASSWORD: werun
    ports:
      - "55432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U werun -d werun"]
      interval: 3s
      timeout: 3s
      retries: 30

  caddy:
    image: caddy:2-alpine
    ports:
      - "80:80"
    volumes:
      - ./Caddyfile.dev:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
    extra_hosts:
      - "host.docker.internal:host-gateway"

volumes:
  pgdata:
  caddy_data:
```

`deploy/Caddyfile.dev`（`reverse_proxy` 原生支持 WebSocket，Vite 的热更新连接可以直接穿过 Caddy）：

```caddyfile
{
	admin off
	auto_https off
}

http://werun.localhost {
	handle /api/* {
		reverse_proxy host.docker.internal:8080
	}
	handle {
		reverse_proxy host.docker.internal:5173
	}
}

http://admin.werun.localhost {
	handle /api/* {
		reverse_proxy host.docker.internal:8080
	}
	handle {
		reverse_proxy host.docker.internal:5174
	}
}
```

- [ ] **Step 7：写 `api/.air.toml`**

```toml
root = "."
tmp_dir = "tmp"

[build]
  cmd = "go build -o ./tmp/werun ./cmd/werun"
  entrypoint = ["./tmp/werun", "serve", "--with-worker", "--auto-migrate"]
  include_ext = ["go", "sql", "json", "yaml"]
  exclude_dir = ["tmp", "bin"]
  delay = 500
  send_interrupt = true
  kill_delay = "5s"

[log]
  time = false

[misc]
  clean_on_exit = true
```

- [ ] **Step 8：在 `Makefile` 末尾追加目标**

Vite 必须监听 `0.0.0.0`，Caddy 容器经 `host.docker.internal` 才能连到它（colima、Linux Docker 不会转发到宿主的 127.0.0.1）。命令行参数直接传给 `vite`，不依赖各应用的 `vite.config.ts`。配方行必须用 Tab 缩进。

```make
COMPOSE_DEV := docker compose -f deploy/compose.dev.yaml
COMPOSE     := docker compose -f deploy/compose.yaml --env-file .env

.PHONY: dev dev-down dev-api dev-user dev-admin compose-up compose-down build-images

## 本地开发：compose 起 postgres 与 caddy，宿主机并行跑 Go（air 热重载）和两个 Vite
dev:
	$(COMPOSE_DEV) up -d --wait postgres caddy
	$(MAKE) -j3 dev-api dev-user dev-admin

dev-down:
	$(COMPOSE_DEV) down

dev-api:
	set -a; . ./.env; set +a; cd api && go tool air -c .air.toml

dev-user:
	pnpm --filter @werun/user dev --host 0.0.0.0 --port 5173 --strictPort

dev-admin:
	pnpm --filter @werun/admin dev --host 0.0.0.0 --port 5174 --strictPort

## 生产形态的完整环境（本地验证、CI 端到端测试共用）
compose-up:
	$(COMPOSE) up -d --build --wait

compose-down:
	$(COMPOSE) down

build-images:
	docker build -f api/Dockerfile -t werun-api:local .
	docker build -f deploy/web.Dockerfile -t werun-web:local .
```

- [ ] **Step 9：构建两个镜像**

Run: `make build-images`
Expected: 两次构建都以 `naming to docker.io/library/werun-api:local`、`naming to docker.io/library/werun-web:local` 结束，无报错。

Run: `docker image inspect werun-api:local --format '{{.Config.Entrypoint}} {{.Config.Cmd}} {{.Config.User}}'`
Expected: `[/werun] [serve --with-worker] nonroot:nonroot`

- [ ] **Step 10：用 compose 起完整环境并验证**

Run:

```bash
WERUN_USER_HOST=http://werun.localhost WERUN_ADMIN_HOST=http://admin.werun.localhost \
  docker compose -f deploy/compose.yaml --env-file .env up -d --build --wait
docker compose -f deploy/compose.yaml --env-file .env ps -a --format '{{.Service}} {{.State}} {{.Status}}'
```

Expected：`up` 以 `✔ Container werun-caddy-1 Healthy/Started` 结束；`ps` 输出中 `migrate exited Exited (0)`，`postgres`、`api` 为 `running … (healthy)`，`caddy` 为 `running`。

Run: `curl -s http://werun.localhost/api/healthz`
Expected: `{"status":"ok"}`

Run: `curl -s http://werun.localhost/api/readyz`
Expected: `{"status":"ok"}`

Run: `curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://admin.werun.localhost/`
Expected: `200 text/html; charset=utf-8`

Run: `curl -s http://werun.localhost/events/some-slug | head -c 15`
Expected: `<!doctype html>`（SPA 回退到用户端 `index.html`；大小写以 Vite 模板为准）

Run: `curl -sI http://werun.localhost/ | grep -i '^cache-control'`
Expected: `Cache-Control: no-cache`

Run: `curl -sI "http://werun.localhost$(curl -s http://werun.localhost/ | grep -o '/assets/[^"]*\.js' | head -1)" | grep -i '^cache-control'`
Expected: `Cache-Control: public, max-age=31536000, immutable`

- [ ] **Step 11：关停并清理**

Run: `docker compose -f deploy/compose.yaml --env-file .env down -v`
Expected: 四个容器和 `pgdata`、`files`、`caddy_data`、`caddy_config` 卷全部 `Removed`。

- [ ] **Step 12：验证本地开发模式**

Run: `make dev`（前台运行，另开终端做下面的检查）
Expected：compose 输出 `✔ Container werun-dev-postgres-1 Healthy`；随后 air 打印构建成功并启动 `serve`，两个 Vite 分别打印 `Local: http://localhost:5173/`、`http://localhost:5174/`。

Run: `curl -s http://werun.localhost/api/healthz && curl -s -o /dev/null -w '%{http_code}\n' http://admin.werun.localhost/`
Expected:

```
{"status":"ok"}200
```

结束：在 `make dev` 终端按 Ctrl+C，然后执行 `make dev-down`，Expected：`werun-dev-postgres-1`、`werun-dev-caddy-1` 均 `Removed`。

- [ ] **Step 13：提交**

```bash
git add .dockerignore api/Dockerfile api/.air.toml deploy/ Makefile
git commit -F - <<'EOF'
build: add container images, Caddy config and compose environments

- api/Dockerfile: cross-compiled static binary on distroless nonroot
- deploy/web.Dockerfile: builds user and admin SPAs into a Caddy image
- deploy/compose.yaml: postgres, one-shot migrate, api, caddy
- deploy/compose.dev.yaml + Caddyfile.dev: local postgres and *.localhost proxy
- Makefile: dev, compose-up/down, build-images

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
```

---

### Task 17：Playwright 端到端测试

**Files:**
- Create: `e2e/package.json`
- Create: `e2e/tsconfig.json`
- Create: `e2e/playwright.config.ts`
- Create: `e2e/tests/env.ts`
- Create: `e2e/tests/helpers.ts`
- Create: `e2e/tests/publish-event.spec.ts`
- Create: `e2e/scripts/seed-staff.sh`
- Modify: `Makefile`（追加 `e2e-seed`；`e2e` 目标按 C14 定义）
- Modify: `pnpm-lock.yaml`（`pnpm install` 自动更新）

**Interfaces:**
- Consumes：
  - Task 16 的 compose 服务 `api`、`postgres`（数据库 `werun`，用户 `werun`），`api` 容器内二进制 `/werun`。
  - `werun create-staff --username --full-name --role --password-stdin`（Task 8；从标准输入读取一行作为密码）。
  - C16 的 data-testid：`lang-switch-zh` / `lang-switch-en` / `lang-switch-km`、`event-card`、`login-username` / `login-password` / `login-submit`、`event-create-button`、`event-form-submit`、`event-publish-<slug>`。
  - 本任务额外依赖 Task 15 新建赛事表单的 antd 表单项 id（表单 `name="event"`，见下方"表单项 id"）。表单默认已带一个空组别，不需要点"添加组别"。
  - 接口：`POST /api/admin/events`（`x-permission: event_config`，`x-access: write`），ADMIN 角色调用返回 403 `FORBIDDEN`，`message` 按 `Accept-Language` 返回。
  - 语言存储键 `werun.lang`（C15），默认语言 `km`。
- Produces：
  - pnpm 包 `@werun/e2e`，脚本 `test`、`typecheck`、`seed`。
  - 种子账号 `ops.e2e`（OPS）、`admin.e2e`（ADMIN），密码取 `E2E_OPS_PASSWORD` / `E2E_ADMIN_PASSWORD`，默认 `e2e-Ops-Password-1` / `e2e-Admin-Password-1`。
  - Make 目标 `e2e-seed`、`e2e`。

表单项 id（由 Task 15 的 antd `Form name="event"` 自动生成，定位时用 `#id`）：

| id | 控件 |
|---|---|
| `event_slug` | slug 输入框 |
| `event_name_zh` / `event_name_en` / `event_name_km` | 赛事名称三语输入框 |
| `event_city` | 城市输入框 |
| `event_raceDate` | 比赛日期 DatePicker 输入框（格式 `YYYY-MM-DD`） |
| `event_categories_0_code` | 第 1 个组别代码 |
| `event_categories_0_name_zh` / `event_categories_0_name_en` / `event_categories_0_name_km` | 第 1 个组别名称三语 |
| `event_categories_0_distanceM` | 第 1 个组别距离（米） |
| `event_categories_0_capacity` | 第 1 个组别名额 |
| `event_categories_0_startAt` / `event_categories_0_cutoffAt` | 第 1 个组别发枪 / 关门时间 DatePicker 输入框（格式 `YYYY-MM-DD HH:mm`） |

> 说明：禁止接口的那一步没有用 Playwright 的 `request`（运行在 Node 里），而是在已登录的后台页面里用 `page.evaluate` 发 `fetch`。原因：Node 在 macOS 上不会把 `*.localhost` 解析到本机，本地跑会失败；浏览器会自动解析，并且天然带上该页面的会话 Cookie，和真实前端请求完全同路径。

- [ ] **Step 1：写 `e2e/package.json`、`e2e/tsconfig.json`、`e2e/playwright.config.ts`**

`e2e/package.json`：

```json
{
  "name": "@werun/e2e",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "playwright test",
    "typecheck": "tsc --noEmit",
    "seed": "bash scripts/seed-staff.sh"
  },
  "devDependencies": {
    "@playwright/test": "1.63.0",
    "@types/node": "24.13.4",
    "typescript": "5.9.3"
  }
}
```

`e2e/tsconfig.json`：

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "types": ["node"],
    "noEmit": true
  },
  "include": ["playwright.config.ts", "tests/**/*.ts"]
}
```

`e2e/playwright.config.ts`：

```ts
import { defineConfig, devices } from "@playwright/test";

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: isCI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]] : [["list"]],
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
```

Run: `pnpm install`
Expected: 输出含 `+ @playwright/test 1.63.0`，`pnpm-lock.yaml` 新增 `e2e` importer。

Run: `pnpm --filter @werun/e2e exec playwright install chromium`
Expected: 下载完成，输出 `Chromium … downloaded to …`（已下载过则无输出、退出码 0）。

- [ ] **Step 2：写种子脚本 `e2e/scripts/seed-staff.sh`**

幂等方式：先查 `staff` 表，已存在就跳过，不依赖 `create-staff` 对重复用户名返回什么错误。默认密码与 `tests/env.ts` 中的默认值必须一致。

```bash
#!/usr/bin/env bash
# 在已启动的 deploy/compose.yaml 环境里创建端到端测试账号。可重复执行。
set -euo pipefail

cd "$(dirname "$0")/../.."

COMPOSE=(docker compose -f deploy/compose.yaml --env-file .env)
OPS_PASSWORD="${E2E_OPS_PASSWORD:-e2e-Ops-Password-1}"
ADMIN_PASSWORD="${E2E_ADMIN_PASSWORD:-e2e-Admin-Password-1}"

staff_exists() {
  local username="$1"
  "${COMPOSE[@]}" exec -T postgres \
    psql -U werun -d werun -tAc "SELECT 1 FROM staff WHERE username = '${username}'" | grep -q '^1$'
}

create_staff() {
  local username="$1" full_name="$2" role="$3" password="$4"
  if staff_exists "$username"; then
    echo "skip ${username}: already exists"
    return
  fi
  printf '%s\n' "$password" | "${COMPOSE[@]}" exec -T api /werun create-staff \
    --username "$username" --full-name "$full_name" --role "$role" --password-stdin
  echo "created ${username} (${role})"
}

create_staff ops.e2e "OPS E2E" OPS "$OPS_PASSWORD"
create_staff admin.e2e "ADMIN E2E" ADMIN "$ADMIN_PASSWORD"
```

Run: `chmod +x e2e/scripts/seed-staff.sh`
Expected: 无输出。

- [ ] **Step 3：写测试环境常量与辅助函数**

`e2e/tests/env.ts`：

```ts
export const USER_URL = process.env.E2E_USER_URL ?? "http://werun.localhost";
export const ADMIN_URL = process.env.E2E_ADMIN_URL ?? "http://admin.werun.localhost";

export const OPS = {
  username: "ops.e2e",
  password: process.env.E2E_OPS_PASSWORD ?? "e2e-Ops-Password-1",
};

export const ADMIN = {
  username: "admin.e2e",
  password: process.env.E2E_ADMIN_PASSWORD ?? "e2e-Admin-Password-1",
};
```

`e2e/tests/helpers.ts`：

```ts
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { ADMIN_URL } from "./env";

/** 在页面脚本执行前写入语言，保证每个上下文的初始语言确定 */
export async function presetLanguage(context: BrowserContext, lang: "zh" | "en" | "km"): Promise<void> {
  await context.addInitScript((value) => {
    window.localStorage.setItem("werun.lang", value);
  }, lang);
}

export async function loginAdmin(page: Page, username: string, password: string): Promise<void> {
  await page.goto(`${ADMIN_URL}/login`);
  await page.getByTestId("login-username").fill(username);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(`${ADMIN_URL}/events`);
}

/** AntD DatePicker：输入文本后回车确认。selector 形如 "#event_raceDate" */
export async function fillDate(page: Page, selector: string, value: string): Promise<void> {
  const input = page.locator(selector);
  await input.click();
  await input.fill(value);
  await input.press("Enter");
}
```

- [ ] **Step 4：写端到端用例 `e2e/tests/publish-event.spec.ts`**

```ts
import { expect, test } from "@playwright/test";
import { ADMIN, ADMIN_URL, OPS, USER_URL } from "./env";
import { fillDate, loginAdmin, presetLanguage } from "./helpers";

const runId = Date.now().toString(36);
const slug = `e2e-${runId}`;
const name = {
  zh: `端到端测试赛 ${runId}`,
  en: `E2E Test Run ${runId}`,
  km: `ការរត់សាកល្បង ${runId}`,
};

test.describe.configure({ mode: "serial" });

test("OPS 新建并发布赛事", async ({ browser }) => {
  const context = await browser.newContext();
  await presetLanguage(context, "zh");
  const page = await context.newPage();

  await loginAdmin(page, OPS.username, OPS.password);

  await page.getByTestId("event-create-button").click();
  await expect(page).toHaveURL(`${ADMIN_URL}/events/new`);

  await page.locator("#event_slug").fill(slug);
  await page.locator("#event_name_zh").fill(name.zh);
  await page.locator("#event_name_en").fill(name.en);
  await page.locator("#event_name_km").fill(name.km);
  await page.locator("#event_city").fill("Phnom Penh");
  await fillDate(page, "#event_raceDate", "2027-01-17");

  // 表单默认已带一个空组别
  await page.locator("#event_categories_0_code").fill("10K");
  await page.locator("#event_categories_0_name_zh").fill("欢乐 10K");
  await page.locator("#event_categories_0_name_en").fill("Fun 10K");
  await page.locator("#event_categories_0_name_km").fill("រត់ 10K");
  await page.locator("#event_categories_0_distanceM").fill("10000");
  await page.locator("#event_categories_0_capacity").fill("500");
  await fillDate(page, "#event_categories_0_startAt", "2027-01-17 06:00");
  await fillDate(page, "#event_categories_0_cutoffAt", "2027-01-17 09:00");

  await page.getByTestId("event-form-submit").click();
  await expect(page).toHaveURL(`${ADMIN_URL}/events`);

  const publish = page.getByTestId(`event-publish-${slug}`);
  await expect(publish).toBeVisible();
  await publish.click();
  await expect(publish).toBeHidden();

  await context.close();
});

test("用户端能看到赛事，切换高棉文后显示高棉文名称", async ({ browser }) => {
  const context = await browser.newContext();
  await presetLanguage(context, "en");
  const page = await context.newPage();

  await page.goto(`${USER_URL}/events`);
  await expect(page.getByTestId("event-card").filter({ hasText: name.en })).toBeVisible();

  await page.getByTestId("lang-switch-km").click();
  await expect(page.getByTestId("event-card").filter({ hasText: name.km })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "km");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "km");
  await expect(page.getByTestId("event-card").filter({ hasText: name.km })).toBeVisible();

  await context.close();
});

test("ADMIN 只读：能看列表，没有新建按钮，直接调用新建接口返回 403", async ({ browser }) => {
  const context = await browser.newContext();
  await presetLanguage(context, "zh");
  const page = await context.newPage();

  await loginAdmin(page, ADMIN.username, ADMIN.password);

  await expect(page.getByText(name.zh)).toBeVisible();
  await expect(page.getByTestId("event-create-button")).toHaveCount(0);
  await expect(page.getByTestId(`event-publish-${slug}`)).toHaveCount(0);

  const result = await page.evaluate(async (body) => {
    const res = await fetch("/api/admin/events", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "Accept-Language": "zh",
        "X-WeRun-Client": "admin",
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }, {
    slug: `${slug}-forbidden`,
    eventType: "RACE",
    organizerType: "OFFICIAL",
    name: { zh: "不应创建", en: "Should not be created", km: "មិនគួរបង្កើត" },
    city: "Phnom Penh",
    raceDate: "2027-01-17",
    categories: [],
  });

  expect(result.status).toBe(403);
  expect(result.json.error.code).toBe("FORBIDDEN");
  expect(result.json.error.message).toMatch(/[一-鿿]/);

  await context.close();
});
```

- [ ] **Step 5：在 `Makefile` 追加 e2e 目标**

```make
.PHONY: e2e e2e-seed

e2e-seed:
	bash e2e/scripts/seed-staff.sh

e2e:
	pnpm --filter @werun/e2e test
```

- [ ] **Step 6：类型检查**

Run: `pnpm --filter @werun/e2e typecheck`
Expected: 无输出，退出码 0。

- [ ] **Step 7：先确认用例能发现失败（错误密码）**

启动完整环境（本地需要 `/etc/hosts` 不做修改也可，浏览器自行解析 `*.localhost`）：

Run: `WERUN_USER_HOST=http://werun.localhost WERUN_ADMIN_HOST=http://admin.werun.localhost make compose-up && make e2e-seed`
Expected: `created ops.e2e (OPS)`、`created admin.e2e (ADMIN)`。

Run: `E2E_OPS_PASSWORD=wrong-password-000 make e2e`
Expected: FAIL，第一个用例在 `loginAdmin` 的 `toHaveURL(".../events")` 超时，汇总 `1 failed`，后两个用例因串行模式标记为 `2 did not run`。

- [ ] **Step 8：正常运行**

Run: `make e2e`
Expected: PASS，汇总 `3 passed`。

Run: `make e2e-seed`
Expected: 幂等，输出 `skip ops.e2e: already exists`、`skip admin.e2e: already exists`，退出码 0。

Run: `make compose-down`
Expected: 容器全部 `Removed`。

- [ ] **Step 9：提交**

```bash
git add e2e/ Makefile pnpm-lock.yaml
git commit -F - <<'EOF'
test(e2e): add Playwright flow for publishing an event

- ops.e2e creates and publishes an event from the admin UI
- user site lists it and switches to Khmer with html lang=km
- read-only ADMIN has no create button and gets 403 FORBIDDEN
- seed-staff.sh creates test accounts idempotently

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
```

---

### Task 18：GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes：
  - Make 目标：`gen`（Task 5/13，需要 Go 与 pnpm 依赖）。
  - 根 pnpm 脚本：`typecheck`、`lint`、`test`、`i18n:check`、`build`（Task 11）。
  - `api/go.mod`（setup-go 读取 Go 版本）、`.env.example`（Task 1）。
  - Task 16 的 `deploy/compose.yaml`、`api/Dockerfile`、`deploy/web.Dockerfile`；Task 17 的 `e2e/scripts/seed-staff.sh` 与 `@werun/e2e`。
- Produces：四个 job：`backend`、`frontend`、`e2e`、`images`；`main` 分支推送后在 GHCR 发布 `werun-api`、`werun-web` 的 `<sha>` 与 `main` 标签。

> 说明：
> - GHCR 的镜像路径必须小写，`github.repository_owner` 可能带大写，所以先在 shell 里转成小写再拼镜像名。
> - e2e 环境通过 `http://` 访问，`WERUN_ENV` 必须保持 `dev`；设为 `prod` 会给 Cookie 加 `Secure`，浏览器在 http 下不会回传，登录后就会一直 401。
> - `.env` 由 `.env.example` 复制后在末尾追加随机密钥；compose 的 env 文件和 shell 的 `. ./.env` 对重复的键都是后出现的生效。

- [ ] **Step 1：写 `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

env:
  NODE_VERSION: "24"

jobs:
  backend:
    name: Backend
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-go@v7
        with:
          go-version-file: api/go.mod
          cache-dependency-path: api/go.sum

      - uses: actions/setup-node@v7
        with:
          node-version: ${{ env.NODE_VERSION }}

      - name: Enable pnpm via corepack
        run: corepack enable

      - name: Install JS dependencies (needed by make gen)
        run: pnpm install --frozen-lockfile

      - name: Lint Go
        working-directory: api
        run: go tool golangci-lint run ./...

      - name: Generated code is up to date
        run: |
          make gen
          git diff --exit-code

      - name: Go tests (testcontainers + database invariants)
        working-directory: api
        run: go test ./...

  frontend:
    name: Frontend
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-node@v7
        with:
          node-version: ${{ env.NODE_VERSION }}

      - name: Enable pnpm via corepack
        run: corepack enable

      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
      - run: pnpm i18n:check
      - run: pnpm build

  e2e:
    name: End-to-end
    needs: [backend, frontend]
    runs-on: ubuntu-latest
    env:
      WERUN_USER_HOST: http://werun.localhost
      WERUN_ADMIN_HOST: http://admin.werun.localhost
      E2E_USER_URL: http://werun.localhost
      E2E_ADMIN_URL: http://admin.werun.localhost
    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-node@v7
        with:
          node-version: ${{ env.NODE_VERSION }}

      - name: Enable pnpm via corepack
        run: corepack enable

      - run: pnpm install --frozen-lockfile

      - name: Map local hostnames
        run: echo "127.0.0.1 werun.localhost admin.werun.localhost" | sudo tee -a /etc/hosts

      - name: Create .env with generated secrets
        run: |
          cp .env.example .env
          {
            echo "WERUN_ENV=dev"
            echo "WERUN_SESSION_SECRET=$(openssl rand -hex 32)"
            echo "WERUN_PII_KEY=$(openssl rand -base64 32)"
            echo "WERUN_USER_HOST=${WERUN_USER_HOST}"
            echo "WERUN_ADMIN_HOST=${WERUN_ADMIN_HOST}"
            echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)"
          } >> .env

      - name: Start stack
        run: docker compose -f deploy/compose.yaml --env-file .env up -d --build --wait

      - name: Seed test staff
        run: bash e2e/scripts/seed-staff.sh

      - name: Install Playwright browser
        run: pnpm --filter @werun/e2e exec playwright install --with-deps chromium

      - name: Run Playwright
        run: pnpm --filter @werun/e2e test

      - name: Upload Playwright report
        if: failure()
        uses: actions/upload-artifact@v7
        with:
          name: playwright-report
          path: e2e/playwright-report
          retention-days: 7

      - name: Dump compose logs
        if: failure()
        run: docker compose -f deploy/compose.yaml --env-file .env logs --no-color

      - name: Stop stack
        if: always()
        run: docker compose -f deploy/compose.yaml --env-file .env down -v

  images:
    name: Images
    needs: [e2e]
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v7

      - uses: docker/setup-qemu-action@v4
      - uses: docker/setup-buildx-action@v4

      - uses: docker/login-action@v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Compute image names
        id: names
        run: |
          owner="${GITHUB_REPOSITORY_OWNER,,}"
          echo "api=ghcr.io/${owner}/werun-api" >> "$GITHUB_OUTPUT"
          echo "web=ghcr.io/${owner}/werun-web" >> "$GITHUB_OUTPUT"

      - name: Build and push werun-api
        uses: docker/build-push-action@v7
        with:
          context: .
          file: api/Dockerfile
          platforms: linux/amd64,linux/arm64
          push: true
          tags: |
            ${{ steps.names.outputs.api }}:${{ github.sha }}
            ${{ steps.names.outputs.api }}:main
          cache-from: type=gha,scope=werun-api
          cache-to: type=gha,mode=max,scope=werun-api

      - name: Build and push werun-web
        uses: docker/build-push-action@v7
        with:
          context: .
          file: deploy/web.Dockerfile
          platforms: linux/amd64,linux/arm64
          push: true
          tags: |
            ${{ steps.names.outputs.web }}:${{ github.sha }}
            ${{ steps.names.outputs.web }}:main
          cache-from: type=gha,scope=werun-web
          cache-to: type=gha,mode=max,scope=werun-web
```

- [ ] **Step 2：本地用 actionlint 校验**

Run: `docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:1.7.12 -color`
Expected: 无输出，退出码 0。

若报 `shellcheck` 类提示，按提示修改对应 `run:` 脚本后重跑，直到无输出。

- [ ] **Step 3：本地演练 e2e job 的关键步骤**

在干净的工作区（无 `.env`）按 CI 的顺序执行，确认脚本本身没有问题：

Run:

```bash
cp .env.example .env
{
  echo "WERUN_ENV=dev"
  echo "WERUN_SESSION_SECRET=$(openssl rand -hex 32)"
  echo "WERUN_PII_KEY=$(openssl rand -base64 32)"
  echo "WERUN_USER_HOST=http://werun.localhost"
  echo "WERUN_ADMIN_HOST=http://admin.werun.localhost"
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)"
} >> .env
docker compose -f deploy/compose.yaml --env-file .env up -d --build --wait
bash e2e/scripts/seed-staff.sh
pnpm --filter @werun/e2e test
docker compose -f deploy/compose.yaml --env-file .env down -v
```

Expected：`up` 全部 Healthy/Started；种子脚本输出两行 `created …`；Playwright 汇总 `3 passed`；`down -v` 全部 `Removed`。

- [ ] **Step 4：提交**

```bash
git add .github/workflows/ci.yml
git commit -F - <<'EOF'
ci: add GitHub Actions pipeline

- backend: golangci-lint, generated-code drift check, go test
- frontend: typecheck, lint, vitest, i18n key check, build
- e2e: compose stack + Playwright, report uploaded on failure
- images: multi-arch werun-api and werun-web pushed to GHCR on main

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
```

- [ ] **Step 5：推送后在 GitHub 上确认**

仓库建好并推送后：

Run: `gh run watch --exit-status`
Expected：PR 触发时 `Backend`、`Frontend`、`End-to-end` 三个 job 通过，`Images` 显示 skipped；推送到 `main` 时四个 job 全部通过，`gh api /users/<owner>/packages/container/werun-api/versions --jq '.[0].metadata.container.tags'` 包含 `main` 和当次提交的 SHA。
