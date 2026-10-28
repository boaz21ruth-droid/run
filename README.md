# WeRun

柬埔寨跑步赛事平台：赛事报名、KHQR 收款凭证审核、免费活动、成绩与照片。用户端同时作为 Telegram Mini App 运行，另有一个运营后台。

## 仓库结构

| 目录 | 内容 |
|---|---|
| `api/` | Go 后端：Gin、pgx + sqlc、goose 迁移、River 任务队列。接口以 `api/openapi/openapi.yaml` 为准，权限写在每个接口的 `x-permission` 上 |
| `web/user/` | 用户端 / Telegram Mini App：React 19、Vite、React Router、TanStack Query、CSS Modules |
| `web/admin/` | 运营后台：React 19、Ant Design 5 |
| `packages/tokens/` | 设计令牌（颜色、圆角、字体） |
| `packages/i18n/` | 中文 / 高棉文 / 英文文案，`pnpm i18n:check` 保证三语 key 一致 |
| `packages/api-client/` | 由 OpenAPI 生成的前端客户端 |
| `e2e/` | Playwright 端到端测试 |
| `deploy/` | docker compose 与 Caddy 配置 |
| `docs/` | 数据库设计与各阶段的设计文档、计划 |
| `requirements/run/` | 早期的静态需求原型（仅作参考，不参与构建） |

## 本地开发

需要 Node 24 以上、Go（版本见 `api/go.mod`）、Docker。

```bash
make setup      # 装 pnpm 依赖与 Go 模块，并从 .env.example 生成 .env
make migrate-up # 建表
make dev        # compose 起 postgres 与 caddy，并行跑 Go API 与两个 Vite
```

Node 25 起不再自带 corepack，`make setup` 会改用 `npm i -g pnpm@10.34.5`。

启动后访问：

- 用户端：http://werun.localhost
- 运营后台：http://admin.werun.localhost

后台账号用命令行创建，密码从标准输入读：

```bash
echo 'a-strong-password' | make create-staff ARGS="--username ops.demo --full-name 'OPS Demo' --role OPS --password-stdin"
```

## 常用命令

`make help` 列出全部目标。最常用的几个：

| 命令 | 作用 |
|---|---|
| `make test` | Go 测试（需要 Docker，跑 testcontainers）+ 前端 typecheck、测试与 i18n 检查 |
| `make lint` | golangci-lint + ESLint |
| `make gen` | 改了 `openapi.yaml` 或 SQL 之后重新生成服务端、权限表、sqlc 与前端客户端；CI 会检查生成结果是否已提交 |
| `make compose-up` | 以生产形态起完整环境（CI 的 e2e 也用它） |
| `make e2e-seed && make e2e` | 端到端测试 |

## 配置

全部配置走环境变量，说明写在 `.env.example` 里。生产环境的值存放在 AWS SSM，部署时渲染成 `.env`。几条要注意的：

- `WERUN_ENV` 必须显式设置为 `dev` 或 `prod`，不设置进程不会启动。
- 生产环境会拒绝 `.env.example` 里的开发用 `WERUN_SESSION_SECRET` 和 `WERUN_PII_KEY`。
- `WERUN_OTP_FIXED_CODE` 是接入 Telegram Gateway 之前的过渡方案：设置后所有手机号共用一个验证码，进程会持续打 Error 日志提醒。接入 Gateway 后请立即移除。

## 提交代码

推送前先 `git pull --no-rebase` 把远程合进来，用 merge 不用 rebase。改了接口或 SQL 记得 `make gen` 并一起提交。
