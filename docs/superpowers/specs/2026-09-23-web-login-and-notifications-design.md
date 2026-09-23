# WeRun 网页端手机号登录与站内通知设计

- 日期：2026-09-23
- 前置：报名与收款凭证审核（`docs/superpowers/specs/2026-09-14-registration-payment-design.md`）已合并并上线（suosdey.top）。
- 本文是下一份实施计划的唯一依据；与旧设计冲突时以本文的「已定决定」为准。

## 1. 目标与不做的事

### 1.1 目标

跑者在普通浏览器打开 suosdey.top，用手机号加验证码登录，完成与 Telegram 小程序完全相同的报名、付款截图上传、查看订单流程。验证码经 Telegram Gateway 送达。审核结果、付款期限提醒等通知对网页用户以站内通知送达，对 Telegram 用户在原有机器人推送之外同样写站内通知。

### 1.2 本迭代包含

- 手机号验证码登录（请求验证码、校验验证码、签发与现有 Telegram 登录同构的会话）
- 验证码发送器抽象与 Telegram Gateway 实现；开发与测试环境的日志/固定码实现
- 用户显示名与语言设置（`PATCH /app/me`）
- 站内通知：登记、列表、未读数、标记已读；现有四种推送模板全部双写
- 跑者端网页登录页、登录守卫、顶栏用户区、通知页
- 与之前遗留项合并的四批交付计划（见 §15）

### 1.3 本迭代不做

- Telegram 账号与手机号账号的合并或互相绑定（同一个人可能有两条 `users` 记录，各自独立）
- WhatsApp、短信通道（发送器接口预留，不实现）
- 网页用户的 Telegram 推送（Gateway 只能发验证码，不能发业务消息）
- 游客下单、账号认领（`auth_otps.purpose = CLAIM_ACCOUNT` 本迭代不用）
- 邮件

## 2. 已定决定

| 事项 | 决定 |
| --- | --- |
| 网页登录方式 | 手机号 + 6 位验证码 |
| 验证码通道 | Telegram Gateway（`gatewayapi.telegram.org`），验证码由本系统生成并本地校验，Gateway 只负责送达 |
| 号码未注册 Telegram | 返回明确错误码，页面提示改用 Telegram 小程序或换号码；不回退到其他通道 |
| 手机号格式 | 后端只接受 E.164（`^\+[1-9][0-9]{6,14}$`）；前端拼国家码，默认 `+855`；不引入号码库 |
| 验证码有效期 | 5 分钟 |
| 错误次数 | 同一条验证码错 5 次作废 |
| 重发限制 | 同一号码 60 秒内不重发；同一号码每小时最多 5 条；同一 IP 每小时最多 20 条 |
| 会话 | 复用 `sessions` 表与 24 小时固定有效期令牌，登录方式不影响令牌格式 |
| 令牌存储 | 浏览器内 `localStorage`；Telegram 内维持 `sessionStorage` |
| 新用户显示名 | 为空时界面显示脱敏手机号（`+855 12 *** 678`），用户可在「我的」里设置 |
| 网页用户通知 | 站内通知 |
| Telegram 用户通知 | 机器人推送不变，另加站内通知 |
| 发送器选择 | `WERUN_OTP_SENDER = telegram | log | fixed`；`fixed` 固定码 `123456`，`WERUN_ENV=prod` 时拒绝 `fixed` |
| 未登录守卫 | Telegram 内自动登录；浏览器内跳转 `/login?next=<来源>` |
| 401 处理 | Telegram 内静默重登一次；浏览器内清令牌并跳登录页 |

## 3. 后端模块

不新增包。改动集中在两个现有包，写法沿用 `service.go` + `store/`（sqlc）：

| 包 | 新增文件 | 负责 |
| --- | --- | --- |
| `internal/runner` | `otp.go`、`otpsender.go`、`gateway.go`、`limiter.go` | 验证码生命周期、发送器接口与三个实现、Gateway 客户端、限流 |
| `internal/notify` | `inapp.go` | 站内通知登记与查询 |

`internal/platform/config` 增加两个变量（§10）。`cmd/werun/app.go` 按配置装配发送器。

## 4. 手机号登录

### 4.1 请求验证码 `POST /api/app/auth/phone/request`

输入 `{ phone }`。步骤，单个事务：

1. 校验 E.164；不合法返回 `OTP_PHONE_INVALID`（422）。
2. 限流（§4.3）；超限返回 `RATE_LIMITED`（429），响应 `fields.retryAfterSeconds`。
3. 生成 6 位随机数字（`crypto/rand`），`HMAC-SHA256(sessionSecret, phone + ":" + code)` 写入 `auth_otps`：`purpose = LOGIN`，`expires_at = now + 5m`，`ip`。同一号码此前未消费、未过期的记录全部标记 `consumed_at = now`（一个号码同时只有一条有效验证码）。
4. 事务提交后调用发送器。发送失败时把该记录 `consumed_at = now` 并返回错误：Gateway 报号码不可达时 `OTP_PHONE_NOT_ON_TELEGRAM`（422），其他错误 `OTP_SEND_FAILED`（502），错误详情只进日志。
5. 返回 `{ expiresInSeconds: 300, resendAfterSeconds: 60, channel: "telegram" }`。

不返回任何能区分「号码是否已注册本系统」的信息。

### 4.2 校验验证码 `POST /api/app/auth/phone/verify`

输入 `{ phone, code }`。单个事务：

1. 取该号码最新一条 `purpose = LOGIN`、未消费的记录，`FOR UPDATE`。没有或已过期返回 `OTP_EXPIRED`（422）。
2. `attempts >= 5` 返回 `OTP_ATTEMPTS_EXCEEDED`（422），并标记消费。
3. 比对哈希（常量时间）。不符：`attempts + 1`，返回 `OTP_INVALID`（422），响应 `fields.attemptsLeft`。
4. 相符：标记消费；`UpsertPhoneUser`（按 `phone_e164` 查找，不存在则创建，`locale` 取请求的 `Accept-Language`，`last_login_at = now`）；`status != ACTIVE` 返回 403。
5. 写 `sessions`（与 `LoginTelegram` 相同），审计 `runner.login`，`Summary` 注明「手机号」。
6. 返回 `AppSession`，结构与 Telegram 登录相同。

### 4.3 限流

进程内实现，仿 `iam.LoginLimiter`：`OTPLimiter` 维护每号码与每 IP 的时间戳滑动窗口。单实例部署，不做跨进程共享；重启即清零，可接受。

### 4.4 发送器

```go
type OTPSender interface {
    // Send 把验证码送到 phone。返回 ErrPhoneUnreachable 表示号码不可达（Gateway 报 PHONE_NUMBER_INVALID / USER_NOT_FOUND 一类）。
    Send(ctx context.Context, phone, code string, lang i18n.Lang) error
}
```

| 实现 | 行为 |
| --- | --- |
| `GatewaySender` | §5 |
| `LogSender` | 只写 `slog.Info("otp code", phone, code)`，返回 nil |
| `FixedSender` | 不发送；`otp.go` 生成验证码时若发送器为 fixed，验证码固定为 `123456` |

## 5. Telegram Gateway 客户端

- 端点：`POST https://gatewayapi.telegram.org/sendVerificationMessage`，`Authorization: Bearer <WERUN_TELEGRAM_GATEWAY_TOKEN>`，JSON 体：`phone_number`（E.164）、`code`（本系统生成）、`ttl`（300）、`payload`（`auth_otps.id`）。不使用 `checkVerificationStatus`，因为验证码本地校验。
- 响应 `{ ok, result: { request_id, delivery_status: { status } }, error }`。`ok = false` 且 `error` 为号码类错误码时映射为 `ErrPhoneUnreachable`，其余包装为普通错误。`request_id` 写回 `auth_otps.provider_request_id`。
- 超时 10 秒；不重试（重试会重复计费，由用户点「重新发送」决定）。
- 日志里脱敏 token 与手机号中段；错误信息经 `redact` 过滤，与 `notify.TelegramSender` 相同处理。

## 6. 用户与会话

- `runner.User` 增加 `Phone string`（E.164，可空）。`userFromColumns` 与 `UpsertTelegramUser` 相应补列。
- `AppUser`：`telegramUserId`、`telegramUsername` 改为 `nullable`；新增 `phoneMasked`（string，可空）。`displayName` 为空时后端不填充，脱敏由前端做。
- `PATCH /api/app/me`：`{ displayName?, locale? }`，`displayName` 1–64 个字符，`locale ∈ {zh,en,km}`。返回 `AppUser`。审计 `runner.profile_update`。
- 现有 `Authenticate`、`Logout` 不变。

## 7. 站内通知

### 7.1 数据

新表 `user_notifications`（§9）。`notify.Enqueue` 改为：

1. 取收件人 `telegram_user_id, locale`（现有查询）。
2. 按 locale 渲染标题、正文、按钮文案（现有模板与文案 key 复用；新增 `notify.<template>.title` 三种语言）。
3. `INSERT user_notifications`，`dedupe_key` 冲突时整个 Enqueue 返回 nil（沿用现有幂等语义）。
4. 有 `telegram_user_id` 时按现有流程登记 `notification_logs` 并入队 River 任务；没有时到此结束。

`link_path` 取自现有 `Button` 的相对路径（去掉 `appBaseURL` 前缀），例如 `/orders/{orderNo}`。

### 7.2 接口

| 接口 | 说明 |
| --- | --- |
| `GET /api/app/notifications?cursor=&limit=` | 当前跑者的通知，按 `created_at` 倒序，游标分页，默认 20 条；每条 `{ id, template, title, body, linkPath, readAt, createdAt }` |
| `GET /api/app/notifications/unread-count` | `{ count }` |
| `POST /api/app/notifications/{id}/read` | 标记已读；不属于当前用户返回 404 |
| `POST /api/app/notifications/read-all` | 全部标记已读 |

## 8. 接口清单

| 方法与路径 | 认证 | 说明 |
| --- | --- | --- |
| `POST /api/app/auth/phone/request` | 无 | §4.1 |
| `POST /api/app/auth/phone/verify` | 无 | §4.2 |
| `PATCH /api/app/me` | 跑者令牌 | §6 |
| `GET /api/app/notifications` | 跑者令牌 | §7.2 |
| `GET /api/app/notifications/unread-count` | 跑者令牌 | §7.2 |
| `POST /api/app/notifications/{id}/read` | 跑者令牌 | §7.2 |
| `POST /api/app/notifications/read-all` | 跑者令牌 | §7.2 |

现有接口不变。`AppUser` 结构变更见 §6。

## 9. 数据库变更（迁移 `0011_web_login.sql`）

```sql
ALTER TABLE auth_otps ADD COLUMN provider_request_id text;

CREATE TABLE user_notifications (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id),
  template    text   NOT NULL,
  locale      text   NOT NULL CHECK (locale IN ('zh','en','km')),
  title       text   NOT NULL,
  body        text   NOT NULL,
  link_path   text,
  entity_type text,
  entity_id   bigint,
  dedupe_key  text   NOT NULL UNIQUE,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_notifications_user_idx ON user_notifications (user_id, created_at DESC);
CREATE INDEX user_notifications_unread_idx ON user_notifications (user_id) WHERE read_at IS NULL;
```

## 10. 配置

| 变量 | 说明 |
| --- | --- |
| `WERUN_OTP_SENDER` | `telegram`、`log`、`fixed`；留空时 `prod` 视为 `telegram`，其余视为 `fixed` |
| `WERUN_TELEGRAM_GATEWAY_TOKEN` | Gateway 访问令牌；`WERUN_OTP_SENDER=telegram` 时必填且非空 |

校验：`WERUN_ENV=prod` 且发送器为 `fixed` 或 `log` 时拒绝启动。`.env.example`、`deploy/compose.yaml` 的 `x-api-env`、CI 的 `.env` 生成步骤同步加上。

## 11. 错误码

| 代码 | HTTP | 场景 |
| --- | --- | --- |
| `OTP_PHONE_INVALID` | 422 | 不是 E.164 |
| `OTP_PHONE_NOT_ON_TELEGRAM` | 422 | Gateway 报号码不可达 |
| `OTP_SEND_FAILED` | 502 | Gateway 其他错误或超时 |
| `OTP_INVALID` | 422 | 验证码不符，`fields.attemptsLeft` |
| `OTP_EXPIRED` | 422 | 没有有效验证码或已过期 |
| `OTP_ATTEMPTS_EXCEEDED` | 422 | 错误次数用尽 |
| `RATE_LIMITED` | 429 | 复用现有码，`fields.retryAfterSeconds` |

三种语言文案加入 `packages/i18n` 的错误码表与后端 `i18n` 目录。

## 12. 前端

### 12.1 跑者端 `web/user`

- 路由：新增 `/login`（`LoginPage`）、`/notifications`（`NotificationsPage`）、`/me`（`MePage`：显示名、语言、退出登录）。`/notifications` 与 `/me` 放在 `RequireRunner` 下。
- `LoginPage`：国家码下拉（默认 +855，提供 +86、+65、+66、+84 等常用项，也可手输）+ 本地号码；「发送验证码」后显示验证码输入与 60 秒倒计时；验证成功后 `navigate(next ?? "/")`。已登录访问 `/login` 直接跳转。
- `AuthController`：`deps` 增加 `requestCode(phone)`、`verifyCode(phone, code)`；新增 `loginWithPhone(phone, code)`；`restore()` 在无 initData 时置 `unauthenticated` 而非失败；`handleUnauthorized()` 在非 Telegram 环境下只清令牌并置 `unauthenticated`，由守卫跳登录页。
- `session.ts`：`storage()` 在 `isTelegram()` 为真时返回 `sessionStorage`，否则 `localStorage`。
- `RequireRunner`：`unauthenticated` 且非 Telegram 环境时 `<Navigate to="/login?next=…" replace />`；Telegram 环境维持 `OpenInTelegram`。
- `Layout` 顶栏：未登录显示「登录」；已登录显示显示名或脱敏手机号、通知铃铛（未读数徽标，`useQuery` 每 60 秒刷新）、「我的」。
- `OpenInTelegram` 组件文案调整为「也可以用手机号登录」并给出 `/login` 链接。
- 文案：`packages/i18n/locales/{zh,en,km}/user.json` 新增 `auth.phone.*`、`notifications.*`、`me.*`。

### 12.2 后台 `web/admin`

本迭代无改动。

## 13. 测试

### 13.1 后端单元测试

- `otp_test.go`：验证码生成长度与随机性、fixed 模式固定值、哈希比对常量时间。
- `gateway_test.go`：`httptest.Server` 模拟成功、号码不可达、5xx、超时四种响应的映射；请求体字段与 Bearer 头正确；日志脱敏。
- `limiter_test.go`：号码 60 秒冷却、每小时 5 条、IP 每小时 20 条、窗口滑动。
- `config_test.go`：prod 下 `fixed`/`log` 被拒；`telegram` 缺 token 被拒。

### 13.2 后端数据库测试

- 请求验证码使旧记录失效；校验成功消费记录并创建用户；重复校验返回 `OTP_EXPIRED`；错 5 次后 `OTP_ATTEMPTS_EXCEEDED`；同号码并发请求只留一条有效。
- `UpsertPhoneUser` 幂等；`DISABLED` 用户 403。
- `notify.Enqueue` 对无 Telegram 用户只写 `user_notifications`；对 Telegram 用户双写；`dedupe_key` 冲突不重复。
- 通知列表分页、未读数、标记已读的归属校验。

### 13.3 前端组件测试

- `LoginPage`：发码后出现验证码输入与倒计时；错误码渲染对应文案；成功后跳转 `next`。
- `AuthController`：浏览器环境 401 后状态为 `unauthenticated`；`loginWithPhone` 成功保存令牌到 `localStorage`。
- `RequireRunner`：非 Telegram 未登录跳 `/login`。

### 13.4 端到端测试

新增 `web-login.spec.ts`：浏览器打开赛事详情 → 点报名 → 跳登录页 → 输手机号发码（`fixed`）→ 输 `123456` → 回到报名页 → 完成下单与上传截图 → 财务驳回 → 通知页出现驳回通知且未读数为 1 → 标记已读。现有 Telegram 用例不变。CI 的 `.env` 加 `WERUN_OTP_SENDER=fixed`。

## 14. 验收标准

- 浏览器登录、报名、付款截图、查看订单全流程可用，与 Telegram 内行为一致。
- Gateway 送达的验证码可登录；号码未注册 Telegram 时得到明确提示。
- 限流与错误次数按 §2 生效，且响应里给出可读的等待时间。
- 审核通过/驳回/期限提醒/过期四种事件对网页用户生成站内通知，对 Telegram 用户机器人推送与站内通知都有。
- 生产配置缺 Gateway token 时进程拒绝启动。
- CI 全绿，含新增端到端用例。

## 15. 交付顺序（含遗留项）

每批可独立合并上线。

### 第 1 批：网页登录

§4、§5、§6、§10、§11、§12 中登录相关部分。

### 第 2 批：站内通知

§7、§12 中通知相关部分。

### 第 3 批：功能补漏

| 事项 | 做法 |
| --- | --- |
| 签署同意书不校验是否当前版本 | 下单与免费报名时校验 `version` 等于该语言当前生效版本，否则 `CONSENT_INVALID` 并在 `fields.version` 给出当前版本 |
| 4xx 错误原因不进日志 | `httpx.WriteError` 对 4xx 以 `Info` 级别记录 code 与 fields，不记录请求体 |
| 本人重传同一张截图被标「重复」 | sha256 重复检测排除同一订单自己的历史凭证 |
| 后台详情对客服暴露参赛码 | `AdminOrderDetail` 里的参赛码字段按 `order_view` 权限之外的新权限 `ticket_code_view` 输出，SUPPORT 无此权限 |
| 后台订单状态时间线 | 旧规格 §13.2：订单详情页按 `audit_logs` 与凭证历史合成时间线 |
| 草稿赛事与组别不能编辑 | 新增 `PUT /api/admin/events/{id}`（含组别整体替换），仅 `DRAFT` 状态可用；后台赛事表单支持编辑 |

### 第 4 批：运维补齐

| 事项 | 做法 |
| --- | --- |
| Telegram 真实 token、Gateway token | 写入 VM 的 `/opt/werun/.env`，`WERUN_TELEGRAM_SEND=on` |
| 镜像里的机器人用户名 | GitHub 仓库变量 `WERUN_TELEGRAM_BOT_USERNAME` 设为真实用户名后重建镜像 |
| 备份 | VM 上 cron：每日 `pg_dump` 与 `files` 卷打包，`gsutil rsync` 到 Cloud Storage 桶，保留 30 天 |
| www 跳转 | `deploy/Caddyfile` 增加 `www.{host}` 到主域名的 301 |
| 一键部署 | `deploy/deploy.sh <git-sha>`：SSH 到 VM 改 `.env` 镜像标签、`compose pull`、`up -d --wait`、健康检查、失败回滚到上一个标签 |
| 磁盘 | 扩到 30 GB |

识别分在同价位并发超过 50 单时撞金额的问题属于规格层面，本迭代不处理，报名量接近时另行立项。
