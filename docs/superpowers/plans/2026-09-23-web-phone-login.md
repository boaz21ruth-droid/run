# 网页端手机号登录 实施计划（第 1 批）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 跑者在普通浏览器用手机号加 Telegram Gateway 送达的验证码登录 suosdey.top，之后的报名、付款、订单流程与 Telegram 小程序完全一致。

**Architecture:** 后端在现有 `internal/runner` 包里加验证码生命周期、发送器抽象（Gateway / log / fixed）与进程内限流，两个新接口签发与 Telegram 登录同构的 24 小时令牌；前端在 `web/user` 里加登录页，未登录守卫在浏览器内跳登录页、在 Telegram 内保持自动登录，令牌在浏览器内改存 localStorage。

**Tech Stack:** Go 1.26 + Gin + pgx + sqlc + goose；OpenAPI 3 + oapi-codegen（strict server）；React 19 + Vite + TanStack Query + react-router 7 + i18next；Vitest；Playwright；Docker compose。

**Spec:** `docs/superpowers/specs/2026-09-23-web-login-and-notifications-design.md`（§4、§5、§6、§10、§11、§12 登录部分、§13、§15 第 1 批）

## Global Constraints

- 手机号只接受 E.164：`^\+[1-9][0-9]{6,14}$`；前端默认国家码 `+855`。
- 验证码 6 位数字，有效期 5 分钟，错 5 次作废；同号码 60 秒冷却、每小时 5 条；同 IP 每小时 20 条。
- 验证码哈希：`HMAC-SHA256(WERUN_SESSION_SECRET, phone + ":" + code)`。
- 会话复用 `sessions` 表与 `runner.SessionTTL = 24h`，令牌格式不变。
- `WERUN_OTP_SENDER ∈ {telegram, log, fixed}`；留空时 prod 视为 `telegram`，其余视为 `fixed`；prod 拒绝 `log`/`fixed`；`telegram` 要求 `WERUN_TELEGRAM_GATEWAY_TOKEN` 非空。`fixed` 固定验证码 `123456`。
- 错误码：`OTP_PHONE_INVALID`(422)、`OTP_PHONE_NOT_ON_TELEGRAM`(422)、`OTP_SEND_FAILED`(502)、`OTP_INVALID`(422, fields.attemptsLeft)、`OTP_EXPIRED`(422)、`OTP_ATTEMPTS_EXCEEDED`(422)、`RATE_LIMITED`(429, fields.retryAfterSeconds)。新错误码必须加进 `apperr.AllCodes` 且三种语言 `messages.*.json` 都有文案（`TestEmbeddedCatalogCoversAllCodesAndFieldKeys` 会检查）。
- 所有新增前端文案在 `packages/i18n/locales/{zh,en,km}/user.json` 三份同时添加（`pnpm i18n:check` 会检查键一致）。
- 改 `api/openapi/openapi.yaml` 或 `api/db/queries/*.sql` 后必须运行 `make gen`（生成 `apigen`、`permissions.gen.go`、sqlc、`packages/api-client` 的 schema），CI 会校验生成物无 diff。
- Go 代码风格：注释中文，`golangci-lint`（`make lint-api`）零告警。
- 每个任务结束提交一次；提交信息格式与仓库一致（`feat(api): …`、`feat(web): …`、`test(e2e): …`）。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `api/internal/platform/config/config.go` | 新增 `OTPSender`、`TelegramGatewayToken` 与校验 |
| `api/db/migrations/0011_web_login.sql` | `auth_otps.provider_request_id` |
| `api/db/queries/runner.sql` | OTP 与手机号用户查询 |
| `api/internal/runner/limiter.go` | `OTPLimiter`：号码冷却/每小时上限、IP 每小时上限 |
| `api/internal/runner/otpsender.go` | `OTPSender` 接口、`ErrPhoneUnreachable`、`LogOTPSender`、`FixedOTPSender` |
| `api/internal/runner/gateway.go` | `GatewaySender`：Telegram Gateway HTTP 客户端 |
| `api/internal/runner/otp.go` | `RequestPhoneCode`、`VerifyPhoneCode`、`UpdateMe` |
| `api/internal/runner/handlers.go` | 三个新 handler |
| `api/internal/runner/model.go` | `User.Phone`、`CodeRequest` 返回体 |
| `api/openapi/openapi.yaml` | 新接口、`AppUser` 变更、`PATCH /app/me` |
| `api/internal/platform/apperr/apperr.go`、`api/internal/platform/i18n/messages.*.json` | 错误码与文案 |
| `api/cmd/werun/app.go`、`api/internal/httpapi/router.go` | 装配发送器与限流器 |
| `web/user/src/auth/session.ts` | 按环境选 storage |
| `web/user/src/auth/controller.ts` | `loginWithPhone`、浏览器内 401 行为 |
| `web/user/src/auth/RequireRunner.tsx` | 浏览器内跳 `/login` |
| `web/user/src/pages/LoginPage.tsx`（+ `.module.css`、`.test.tsx`） | 登录页 |
| `web/user/src/pages/MePage.tsx`（+ `.test.tsx`） | 显示名、语言、退出 |
| `web/user/src/components/Layout.tsx` | 顶栏用户区 |
| `web/user/src/routes.tsx`、`web/user/src/bootstrap.tsx` | 路由与依赖注入 |
| `packages/i18n/locales/*/user.json` | 文案 |
| `e2e/tests/web-login.spec.ts` | 端到端 |
| `.env.example`、`deploy/compose.yaml`、`.github/workflows/ci.yml` | 配置 |

---

### Task 1: 配置项 `WERUN_OTP_SENDER` 与 `WERUN_TELEGRAM_GATEWAY_TOKEN`

**Files:**
- Modify: `api/internal/platform/config/config.go`
- Test: `api/internal/platform/config/config_test.go`
- Modify: `.env.example`、`deploy/compose.yaml`（`x-api-env`）、`.github/workflows/ci.yml`（e2e 的 `.env` 生成步骤）

**Interfaces:**
- Produces: `Config.OTPSender string`（解析后恒为 `telegram|log|fixed`）、`Config.TelegramGatewayToken string`、`func (c Config) OTPSenderKind() string`

- [ ] **Step 1: 写失败测试**

在 `config_test.go` 末尾追加（`setRequired` 是文件里已有的 helper）：

```go
func TestLoadOTPSenderDefaults(t *testing.T) {
	setRequired(t)
	unset(t, "WERUN_OTP_SENDER", "WERUN_TELEGRAM_GATEWAY_TOKEN")

	cfg, err := config.Load()
	require.NoError(t, err)
	assert.Equal(t, "fixed", cfg.OTPSenderKind(), "dev 默认 fixed")
}

func TestLoadOTPSenderProd(t *testing.T) {
	cases := []struct {
		name, sender, token string
		wantErr             string
	}{
		{name: "prod 默认 telegram 但缺 token", wantErr: "WERUN_TELEGRAM_GATEWAY_TOKEN"},
		{name: "prod 拒绝 fixed", sender: "fixed", token: "gw", wantErr: "WERUN_OTP_SENDER"},
		{name: "prod 拒绝 log", sender: "log", token: "gw", wantErr: "WERUN_OTP_SENDER"},
		{name: "prod telegram 有 token", sender: "telegram", token: "gw"},
		{name: "非法值", sender: "sms", token: "gw", wantErr: "WERUN_OTP_SENDER"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			setRequired(t)
			unset(t, "WERUN_OTP_SENDER", "WERUN_TELEGRAM_GATEWAY_TOKEN")
			t.Setenv("WERUN_ENV", "prod")
			t.Setenv("WERUN_APP_BASE_URL", "https://suosdey.top")
			if tc.sender != "" {
				t.Setenv("WERUN_OTP_SENDER", tc.sender)
			}
			if tc.token != "" {
				t.Setenv("WERUN_TELEGRAM_GATEWAY_TOKEN", tc.token)
			}
			cfg, err := config.Load()
			if tc.wantErr == "" {
				require.NoError(t, err)
				assert.Equal(t, "telegram", cfg.OTPSenderKind())
				return
			}
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.wantErr)
		})
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd api && go test ./internal/platform/config/ -run 'TestLoadOTPSender' -v`
Expected: 编译错误 `cfg.OTPSenderKind undefined`

- [ ] **Step 3: 实现**

`config.go` 的 `Config` 结构体加两个字段：

```go
	OTPSender           string `env:"WERUN_OTP_SENDER"`           // "" | telegram | log | fixed
	TelegramGatewayToken string `env:"WERUN_TELEGRAM_GATEWAY_TOKEN"`
```

`Load()` 里 `if len(errs) > 0` 之前加：

```go
	cfg.OTPSender = strings.TrimSpace(cfg.OTPSender)
	cfg.TelegramGatewayToken = strings.TrimSpace(cfg.TelegramGatewayToken)
	switch cfg.OTPSender {
	case "", "telegram", "log", "fixed":
	default:
		errs = append(errs, fmt.Errorf("WERUN_OTP_SENDER must be telegram, log, fixed or empty, got %q", cfg.OTPSender))
	}
	if cfg.IsProd() && (cfg.OTPSender == "log" || cfg.OTPSender == "fixed") {
		errs = append(errs, fmt.Errorf("WERUN_OTP_SENDER=%s is not allowed when WERUN_ENV=prod", cfg.OTPSender))
	}
	if cfg.OTPSenderKind() == "telegram" && cfg.TelegramGatewayToken == "" {
		errs = append(errs, errors.New("WERUN_TELEGRAM_GATEWAY_TOKEN must be set when the OTP sender is telegram"))
	}
```

新增方法：

```go
// OTPSenderKind 返回生效的验证码发送器：显式设置优先；未设置时 prod 用 telegram，其余用 fixed。
func (c Config) OTPSenderKind() string {
	if c.OTPSender != "" {
		return c.OTPSender
	}
	if c.IsProd() {
		return "telegram"
	}
	return "fixed"
}
```

`.env.example` 在 Telegram 段后加：

```
# 手机号验证码发送器：telegram | log | fixed；留空时 prod 视为 telegram，其余视为 fixed（固定码 123456）
WERUN_OTP_SENDER=fixed
# Telegram Gateway（gateway.telegram.org）访问令牌，WERUN_OTP_SENDER=telegram 时必填
WERUN_TELEGRAM_GATEWAY_TOKEN=
```

`deploy/compose.yaml` 的 `x-api-env` 加两行：

```yaml
  WERUN_OTP_SENDER: ${WERUN_OTP_SENDER:-}
  WERUN_TELEGRAM_GATEWAY_TOKEN: ${WERUN_TELEGRAM_GATEWAY_TOKEN:-}
```

`.github/workflows/ci.yml` 生成 `.env` 的 heredoc 里加 `echo "WERUN_OTP_SENDER=fixed"`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd api && go test ./internal/platform/config/ -v`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add api/internal/platform/config .env.example deploy/compose.yaml .github/workflows/ci.yml
git commit -m "feat(api): add OTP sender and Telegram Gateway token settings"
```

---

### Task 2: 迁移与 sqlc 查询

**Files:**
- Create: `api/db/migrations/0011_web_login.sql`
- Modify: `api/db/queries/runner.sql`
- Generated: `api/internal/runner/store/*.go`（`make gen`）
- Test: `api/db/invariants_test.go`（已有的迁移可回滚/幂等测试会自动覆盖新迁移；无需新增）

**Interfaces:**
- Produces（sqlc 生成，包 `store`）：
  - `InsertOTP(ctx, InsertOTPParams{PhoneE164 string, CodeHash []byte, ExpiresAt time.Time, Ip *netip.Addr, CreatedAt time.Time}) (int64, error)`
  - `ConsumeActiveOTPs(ctx, ConsumeActiveOTPsParams{PhoneE164 string, ConsumedAt time.Time}) error`
  - `SetOTPProviderRequestID(ctx, SetOTPProviderRequestIDParams{ID int64, ProviderRequestID *string}) error`
  - `GetActiveOTPForUpdate(ctx, phone string) (GetActiveOTPForUpdateRow{ID int64, CodeHash []byte, Attempts int16, ExpiresAt time.Time}, error)`
  - `IncrementOTPAttempts(ctx, id int64) (int16, error)`
  - `ConsumeOTP(ctx, ConsumeOTPParams{ID int64, ConsumedAt time.Time}) error`
  - `UpsertPhoneUser(ctx, UpsertPhoneUserParams{PhoneE164 *string, Locale string, LastLoginAt time.Time}) (UpsertPhoneUserRow{ID int64, PhoneE164 *string, TelegramUserID *int64, TelegramUsername *string, DisplayName *string, Locale string, Status string}, error)`
  - `UpdateUserProfile(ctx, UpdateUserProfileParams{ID int64, DisplayName *string, Locale string}) (UpdateUserProfileRow, error)`
  - `GetUserSession` 与 `UpsertTelegramUser` 的返回行新增 `PhoneE164 *string`

- [ ] **Step 1: 写迁移**

```sql
-- +goose Up
ALTER TABLE auth_otps ADD COLUMN provider_request_id text;

-- +goose Down
ALTER TABLE auth_otps DROP COLUMN provider_request_id;
```

- [ ] **Step 2: 加查询**

`runner.sql` 里 `UpsertTelegramUser` 的 `RETURNING` 改为 `RETURNING id, phone_e164, telegram_user_id, telegram_username, display_name, locale, status;`；`GetUserSession` 的 SELECT 在 `u.telegram_user_id,` 前加一行 `u.phone_e164,`。文件末尾追加：

```sql
-- name: InsertOTP :one
INSERT INTO auth_otps (phone_e164, code_hash, purpose, expires_at, ip, created_at)
VALUES (@phone_e164, @code_hash, 'LOGIN', @expires_at::timestamptz, @ip, @created_at::timestamptz)
RETURNING id;

-- name: ConsumeActiveOTPs :exec
-- 同一号码同时只保留一条有效验证码：新码写入前把旧的全部标记消费。
UPDATE auth_otps SET consumed_at = @consumed_at::timestamptz
WHERE phone_e164 = @phone_e164 AND purpose = 'LOGIN' AND consumed_at IS NULL;

-- name: SetOTPProviderRequestID :exec
UPDATE auth_otps SET provider_request_id = @provider_request_id WHERE id = @id;

-- name: GetActiveOTPForUpdate :one
SELECT id, code_hash, attempts, expires_at
FROM auth_otps
WHERE phone_e164 = @phone_e164 AND purpose = 'LOGIN' AND consumed_at IS NULL
ORDER BY created_at DESC
LIMIT 1
FOR UPDATE;

-- name: IncrementOTPAttempts :one
UPDATE auth_otps SET attempts = attempts + 1 WHERE id = @id RETURNING attempts;

-- name: ConsumeOTP :exec
UPDATE auth_otps SET consumed_at = @consumed_at::timestamptz WHERE id = @id;

-- name: UpsertPhoneUser :one
-- 首次手机号登录创建跑者；再次登录只更新最近登录时间，不覆盖 locale 与显示名。
INSERT INTO users (phone_e164, locale, last_login_at)
VALUES (@phone_e164, @locale, @last_login_at::timestamptz)
ON CONFLICT (phone_e164) DO UPDATE
SET last_login_at = EXCLUDED.last_login_at
RETURNING id, phone_e164, telegram_user_id, telegram_username, display_name, locale, status;

-- name: UpdateUserProfile :one
UPDATE users SET display_name = @display_name, locale = @locale
WHERE id = @id
RETURNING id, phone_e164, telegram_user_id, telegram_username, display_name, locale, status;
```

- [ ] **Step 3: 生成并编译**

Run: `make gen && cd api && go build ./... && go vet ./internal/runner/...`
Expected: 生成成功；`go build` 报 `userFromColumns` 参数不匹配之类的编译错误是**预期的**（下一任务修）。若只有这一类错误，继续。

- [ ] **Step 4: 修最小编译**

`api/internal/runner/service.go` 里 `userFromColumns` 改签名为：

```go
func userFromColumns(id int64, phone *string, telegramUserID *int64, telegramUsername, name *string, locale string) User {
	u := User{ID: id, Phone: derefString(phone), TelegramUsername: derefString(telegramUsername), DisplayName: derefString(name), Locale: locale}
	if telegramUserID != nil {
		u.TelegramUserID = *telegramUserID
	}
	return u
}
```

（保留原函数体里对 `TelegramUserID` 的处理方式，只是多传 `phone`。）`model.go` 的 `User` 加字段 `Phone string // E.164，可空`。`LoginTelegram` 与 `Authenticate` 的调用处补上 `row.PhoneE164`。

Run: `cd api && go build ./... && go test ./db/... ./internal/runner/...`
Expected: 通过（`db` 测试需要本机 Docker）

- [ ] **Step 5: 提交**

```bash
git add api/db api/internal/runner
git commit -m "feat(api): OTP and phone-user queries, provider_request_id column"
```

---

### Task 3: `OTPLimiter`

**Files:**
- Create: `api/internal/runner/limiter.go`
- Test: `api/internal/runner/limiter_test.go`

**Interfaces:**
- Produces: `type OTPLimiter struct`、`func NewOTPLimiter(clock func() time.Time) *OTPLimiter`、`func (l *OTPLimiter) Allow(phone, ip string) (retryAfter time.Duration, ok bool)`（ok=false 时 `retryAfter` 是最早可再试的等待时长，向上取整到秒）

- [ ] **Step 1: 写失败测试**

```go
package runner_test

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"

	"werun/api/internal/runner"
)

func TestOTPLimiterPhoneCooldown(t *testing.T) {
	clock := &testClock{t: baseNow}
	l := runner.NewOTPLimiter(clock.Now)

	_, ok := l.Allow("+85512345678", "203.0.113.1")
	assert.True(t, ok)

	wait, ok := l.Allow("+85512345678", "203.0.113.1")
	assert.False(t, ok, "60 秒内不能重发")
	assert.Equal(t, 60*time.Second, wait)

	clock.t = clock.t.Add(60 * time.Second)
	_, ok = l.Allow("+85512345678", "203.0.113.1")
	assert.True(t, ok)
}

func TestOTPLimiterPhoneHourlyCap(t *testing.T) {
	clock := &testClock{t: baseNow}
	l := runner.NewOTPLimiter(clock.Now)
	for i := 0; i < 5; i++ {
		_, ok := l.Allow("+85512345678", "203.0.113.1")
		assert.True(t, ok, "第 %d 条", i+1)
		clock.t = clock.t.Add(61 * time.Second)
	}
	wait, ok := l.Allow("+85512345678", "203.0.113.1")
	assert.False(t, ok, "一小时内第 6 条被拒")
	assert.Greater(t, wait, 50*time.Minute)
}

func TestOTPLimiterIPHourlyCap(t *testing.T) {
	clock := &testClock{t: baseNow}
	l := runner.NewOTPLimiter(clock.Now)
	for i := 0; i < 20; i++ {
		_, ok := l.Allow("+8551000"+string(rune('0'+i%10))+string(rune('0'+i/10)), "203.0.113.9")
		assert.True(t, ok, "第 %d 个号码", i+1)
	}
	_, ok := l.Allow("+85519999999", "203.0.113.9")
	assert.False(t, ok, "同 IP 一小时第 21 条被拒")
	_, ok = l.Allow("+85519999999", "203.0.113.10")
	assert.True(t, ok, "另一个 IP 不受影响")
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd api && go test ./internal/runner/ -run TestOTPLimiter -v`
Expected: 编译错误 `undefined: runner.NewOTPLimiter`

- [ ] **Step 3: 实现**

```go
package runner

import (
	"sync"
	"time"
)

// 限流参数取自 spec §2。
const (
	otpPhoneCooldown = 60 * time.Second
	otpPhoneWindow   = time.Hour
	otpPhoneMax      = 5
	otpIPWindow      = time.Hour
	otpIPMax         = 20
	otpSweepEvery    = 64
)

// OTPLimiter 在内存里按号码与 IP 计数（单实例部署，重启清零）。
type OTPLimiter struct {
	mu    sync.Mutex
	clock func() time.Time
	phone map[string][]time.Time
	ip    map[string][]time.Time
	calls uint64
}

func NewOTPLimiter(clock func() time.Time) *OTPLimiter {
	return &OTPLimiter{clock: clock, phone: map[string][]time.Time{}, ip: map[string][]time.Time{}}
}

// Allow 判断是否可以给 phone 发一条验证码并记一次；被拒时返回最早可再试的等待时长（向上取整到秒）。
func (l *OTPLimiter) Allow(phone, ip string) (time.Duration, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.clock()
	l.maybeSweep(now)

	ipHits := pruneOTP(l.ip[ip], now.Add(-otpIPWindow))
	if len(ipHits) >= otpIPMax {
		l.ip[ip] = ipHits
		return ceilSeconds(ipHits[0].Add(otpIPWindow).Sub(now)), false
	}
	phoneHits := pruneOTP(l.phone[phone], now.Add(-otpPhoneWindow))
	if n := len(phoneHits); n > 0 {
		if wait := phoneHits[n-1].Add(otpPhoneCooldown).Sub(now); wait > 0 {
			l.phone[phone] = phoneHits
			return ceilSeconds(wait), false
		}
		if n >= otpPhoneMax {
			l.phone[phone] = phoneHits
			return ceilSeconds(phoneHits[0].Add(otpPhoneWindow).Sub(now)), false
		}
	}
	l.ip[ip] = append(ipHits, now)
	l.phone[phone] = append(phoneHits, now)
	return 0, true
}

func (l *OTPLimiter) maybeSweep(now time.Time) {
	l.calls++
	if l.calls%otpSweepEvery != 0 {
		return
	}
	for k, ts := range l.ip {
		if ts = pruneOTP(ts, now.Add(-otpIPWindow)); len(ts) == 0 {
			delete(l.ip, k)
		} else {
			l.ip[k] = ts
		}
	}
	for k, ts := range l.phone {
		if ts = pruneOTP(ts, now.Add(-otpPhoneWindow)); len(ts) == 0 {
			delete(l.phone, k)
		} else {
			l.phone[k] = ts
		}
	}
}

func pruneOTP(ts []time.Time, cutoff time.Time) []time.Time {
	i := 0
	for i < len(ts) && !ts[i].After(cutoff) {
		i++
	}
	return ts[i:]
}

func ceilSeconds(d time.Duration) time.Duration {
	if d <= 0 {
		return 0
	}
	return ((d + time.Second - 1) / time.Second) * time.Second
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd api && go test ./internal/runner/ -run TestOTPLimiter -v`
Expected: 3 个 PASS

- [ ] **Step 5: 提交**

```bash
git add api/internal/runner/limiter.go api/internal/runner/limiter_test.go
git commit -m "feat(api): in-memory OTP rate limiter"
```

---

### Task 4: 发送器接口与 Telegram Gateway 客户端

**Files:**
- Create: `api/internal/runner/otpsender.go`
- Create: `api/internal/runner/gateway.go`
- Test: `api/internal/runner/gateway_test.go`

**Interfaces:**
- Produces:
  - `type OTPSender interface { Send(ctx context.Context, phone, code string) error }`
  - `var ErrPhoneUnreachable = errors.New("runner: phone unreachable")`
  - `type LogOTPSender struct{ Log *slog.Logger }`；`type FixedOTPSender struct{}`；`const FixedOTPCode = "123456"`
  - `func NewGatewaySender(token, baseURL string, client *http.Client) *GatewaySender`；`const DefaultGatewayBaseURL = "https://gatewayapi.telegram.org"`
  - `GatewaySender.Send` 成功后把 `request_id` 存在返回值里：为了让 Service 记录它，接口改为 `Send(ctx, phone, code string) (providerRequestID string, err error)`（三种实现都遵守；log/fixed 返回空串）

- [ ] **Step 1: 写失败测试**

```go
package runner_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/runner"
)

func gatewayServer(t *testing.T, status int, body string, capture *map[string]any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/sendVerificationMessage", r.URL.Path)
		assert.Equal(t, "Bearer gw-token", r.Header.Get("Authorization"))
		if capture != nil {
			require.NoError(t, json.NewDecoder(r.Body).Decode(capture))
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
}

func TestGatewaySenderSuccess(t *testing.T) {
	var got map[string]any
	srv := gatewayServer(t, 200, `{"ok":true,"result":{"request_id":"req-1","delivery_status":{"status":"sent"}}}`, &got)
	defer srv.Close()
	s := runner.NewGatewaySender("gw-token", srv.URL, srv.Client())

	id, err := s.Send(context.Background(), "+85512345678", "482910")

	require.NoError(t, err)
	assert.Equal(t, "req-1", id)
	assert.Equal(t, "+85512345678", got["phone_number"])
	assert.Equal(t, "482910", got["code"])
	assert.Equal(t, float64(300), got["ttl"])
}

func TestGatewaySenderPhoneUnreachable(t *testing.T) {
	srv := gatewayServer(t, 200, `{"ok":false,"error":"PHONE_NUMBER_INVALID"}`, nil)
	defer srv.Close()
	s := runner.NewGatewaySender("gw-token", srv.URL, srv.Client())

	_, err := s.Send(context.Background(), "+85512345678", "482910")

	assert.True(t, errors.Is(err, runner.ErrPhoneUnreachable))
}

func TestGatewaySenderServerError(t *testing.T) {
	srv := gatewayServer(t, 502, `bad gateway`, nil)
	defer srv.Close()
	s := runner.NewGatewaySender("gw-token", srv.URL, srv.Client())

	_, err := s.Send(context.Background(), "+85512345678", "482910")

	require.Error(t, err)
	assert.False(t, errors.Is(err, runner.ErrPhoneUnreachable))
	assert.NotContains(t, err.Error(), "gw-token", "错误里不能带 token")
	assert.NotContains(t, err.Error(), "12345678", "错误里不能带完整手机号")
}

func TestGatewaySenderTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
	}))
	defer srv.Close()
	s := runner.NewGatewaySender("gw-token", srv.URL, &http.Client{Timeout: 50 * time.Millisecond})

	_, err := s.Send(context.Background(), "+85512345678", "482910")

	require.Error(t, err)
}

func TestFixedAndLogSenders(t *testing.T) {
	id, err := runner.FixedOTPSender{}.Send(context.Background(), "+85512345678", "123456")
	require.NoError(t, err)
	assert.Empty(t, id)
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd api && go test ./internal/runner/ -run 'TestGateway|TestFixedAndLog' -v`
Expected: 编译错误 `undefined: runner.NewGatewaySender`

- [ ] **Step 3: 实现 `otpsender.go`**

```go
package runner

import (
	"context"
	"errors"
	"log/slog"
)

// OTPSender 把验证码送到手机号。返回的 providerRequestID 用于对账，可为空。
// 返回 ErrPhoneUnreachable 表示号码不可达（例如未注册 Telegram），其余错误视为通道故障。
type OTPSender interface {
	Send(ctx context.Context, phone, code string) (providerRequestID string, err error)
}

// ErrPhoneUnreachable 表示号码不可达。
var ErrPhoneUnreachable = errors.New("runner: phone unreachable")

// FixedOTPCode 是 FixedOTPSender 生效时的固定验证码，只用于本地开发与端到端测试。
const FixedOTPCode = "123456"

// LogOTPSender 只把验证码写进日志。
type LogOTPSender struct{ Log *slog.Logger }

func (s LogOTPSender) Send(ctx context.Context, phone, code string) (string, error) {
	s.Log.InfoContext(ctx, "otp code (log sender)", "phone", maskPhone(phone), "code", code)
	return "", nil
}

// FixedOTPSender 不发送任何东西；Service 在它生效时把验证码固定为 FixedOTPCode。
type FixedOTPSender struct{}

func (FixedOTPSender) Send(context.Context, string, string) (string, error) { return "", nil }

// maskPhone 保留国家码与后 3 位：+855********678 → 日志与错误信息里使用。
func maskPhone(phone string) string {
	if len(phone) <= 7 {
		return "***"
	}
	return phone[:4] + "***" + phone[len(phone)-3:]
}
```

- [ ] **Step 4: 实现 `gateway.go`**

```go
package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// DefaultGatewayBaseURL 是 Telegram Gateway 的正式地址。
const DefaultGatewayBaseURL = "https://gatewayapi.telegram.org"

// otpTTLSeconds 与 spec §2 的 5 分钟一致；Gateway 端到期后消息作废。
const otpTTLSeconds = 300

// GatewaySender 通过 Telegram Gateway 的 sendVerificationMessage 发送本系统生成的验证码。
type GatewaySender struct {
	token   string
	baseURL string
	client  *http.Client
}

func NewGatewaySender(token, baseURL string, client *http.Client) *GatewaySender {
	return &GatewaySender{token: token, baseURL: strings.TrimRight(baseURL, "/"), client: client}
}

type gatewayRequest struct {
	PhoneNumber string `json:"phone_number"`
	Code        string `json:"code"`
	TTL         int    `json:"ttl"`
}

type gatewayResponse struct {
	OK     bool   `json:"ok"`
	Error  string `json:"error"`
	Result struct {
		RequestID string `json:"request_id"`
	} `json:"result"`
}

// 号码类错误码：Gateway 明确表示这个号码收不到消息。
var gatewayPhoneErrors = map[string]bool{
	"PHONE_NUMBER_INVALID":  true,
	"PHONE_NUMBER_NOT_FOUND": true,
	"USER_NOT_FOUND":        true,
	"PHONE_NUMBER_BANNED":   true,
}

func (s *GatewaySender) Send(ctx context.Context, phone, code string) (string, error) {
	body, _ := json.Marshal(gatewayRequest{PhoneNumber: phone, Code: code, TTL: otpTTLSeconds})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.baseURL+"/sendVerificationMessage", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("runner: gateway request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+s.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return "", s.redact(fmt.Errorf("runner: gateway send to %s: %w", maskPhone(phone), err))
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("runner: gateway send to %s: HTTP %d", maskPhone(phone), resp.StatusCode)
	}
	var out gatewayResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("runner: gateway send to %s: decode: %w", maskPhone(phone), err)
	}
	if !out.OK {
		if gatewayPhoneErrors[out.Error] {
			return "", fmt.Errorf("%w: %s", ErrPhoneUnreachable, out.Error)
		}
		return "", fmt.Errorf("runner: gateway send to %s: %s", maskPhone(phone), out.Error)
	}
	return out.Result.RequestID, nil
}

// redact 把错误文本里可能出现的 token 抹掉（net/http 的错误会带完整 URL，这里 URL 不含 token，但保持与 notify 一致的防御）。
func (s *GatewaySender) redact(err error) error {
	if s.token == "" {
		return err
	}
	return fmt.Errorf("%s", strings.ReplaceAll(err.Error(), s.token, "***"))
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd api && go test ./internal/runner/ -run 'TestGateway|TestFixedAndLog' -v && go tool golangci-lint run ./internal/runner/...`
Expected: 全部 PASS，lint 无告警（若 lint 抱怨 `redact` 丢失了 error 链，改用 `errors.New` 并保留原样即可）

- [ ] **Step 6: 提交**

```bash
git add api/internal/runner/otpsender.go api/internal/runner/gateway.go api/internal/runner/gateway_test.go
git commit -m "feat(api): OTP sender abstraction with Telegram Gateway client"
```

---

### Task 5: `RequestPhoneCode` / `VerifyPhoneCode` / `UpdateMe`

**Files:**
- Create: `api/internal/runner/otp.go`
- Modify: `api/internal/runner/service.go`（`Service` 结构体与 `NewService`）
- Modify: `api/internal/runner/model.go`
- Modify: `api/internal/platform/apperr/apperr.go`（错误码 + `AllCodes`）
- Modify: `api/internal/platform/i18n/messages.{zh,en,km}.json`
- Test: `api/internal/runner/otp_test.go`

**Interfaces:**
- Consumes: Task 2 的 store 方法、Task 3 的 `OTPLimiter`、Task 4 的 `OTPSender`
- Produces:
  - `NewService(pool, sessionSecret []byte, botToken string, pii *piicrypt.Cipher, now func() time.Time, otp OTPSender, limiter *OTPLimiter) *Service`（**签名变更**，所有调用处一起改：`app.go`、`runner/service_test.go` 的 `newFixture`、`httpapi` 各测试的装配处）
  - `type CodeRequest struct { ExpiresIn, ResendAfter time.Duration; Channel string }`
  - `func (s *Service) RequestPhoneCode(ctx, phone string, meta httpx.Meta) (CodeRequest, error)`
  - `func (s *Service) VerifyPhoneCode(ctx, phone, code, locale string, meta httpx.Meta) (Session, error)`
  - `func (s *Service) UpdateMe(ctx, userID int64, displayName *string, locale *string, meta httpx.Meta) (User, error)`
  - `func ValidE164(phone string) bool`
  - 错误码常量：`apperr.CodeOTPPhoneInvalid`、`CodeOTPPhoneNotOnTelegram`、`CodeOTPSendFailed`、`CodeOTPInvalid`、`CodeOTPExpired`、`CodeOTPAttemptsExceeded`

- [ ] **Step 1: 错误码与文案**

`apperr.go` 常量块末尾加：

```go
	CodeOTPPhoneInvalid       = "OTP_PHONE_INVALID"
	CodeOTPPhoneNotOnTelegram = "OTP_PHONE_NOT_ON_TELEGRAM"
	CodeOTPSendFailed         = "OTP_SEND_FAILED"
	CodeOTPInvalid            = "OTP_INVALID"
	CodeOTPExpired            = "OTP_EXPIRED"
	CodeOTPAttemptsExceeded   = "OTP_ATTEMPTS_EXCEEDED"
```

并加入 `AllCodes`。三份 `messages.*.json` 各加六条：

| 键 | zh | en | km |
| --- | --- | --- | --- |
| OTP_PHONE_INVALID | 手机号格式不正确，请带国家码，例如 +85512345678。 | Enter a valid phone number with country code, e.g. +85512345678. | សូមបញ្ចូលលេខទូរស័ព្ទត្រឹមត្រូវ រួមទាំងលេខកូដប្រទេស ឧ. +85512345678។ |
| OTP_PHONE_NOT_ON_TELEGRAM | 这个手机号没有注册 Telegram，无法接收验证码。请换一个号码，或在 Telegram 中打开 WeRun 小程序。 | This number isn't registered on Telegram, so we can't deliver the code. Use another number or open WeRun inside Telegram. | លេខនេះមិនបានចុះឈ្មោះក្នុង Telegram ទេ ដូច្នេះមិនអាចទទួលកូដបានទេ។ សូមប្រើលេខផ្សេង ឬបើក WeRun ក្នុង Telegram។ |
| OTP_SEND_FAILED | 验证码暂时发不出去，请稍后再试。 | We couldn't send the code right now. Please try again shortly. | មិនអាចផ្ញើកូដបានឥឡូវនេះទេ។ សូមព្យាយាមម្តងទៀតបន្តិចក្រោយមក។ |
| OTP_INVALID | 验证码不正确。 | The code is incorrect. | កូដមិនត្រឹមត្រូវទេ។ |
| OTP_EXPIRED | 验证码已过期或不存在，请重新获取。 | The code has expired or doesn't exist. Request a new one. | កូដផុតកំណត់ ឬមិនមានទេ។ សូមស្នើសុំកូដថ្មី។ |
| OTP_ATTEMPTS_EXCEEDED | 错误次数过多，请重新获取验证码。 | Too many wrong attempts. Request a new code. | ព្យាយាមខុសច្រើនដងពេក។ សូមស្នើសុំកូដថ្មី។ |

Run: `cd api && go test ./internal/platform/i18n/ ./internal/platform/apperr/`
Expected: PASS（文案完整性测试通过）

- [ ] **Step 2: 写失败测试**

`otp_test.go`（`newFixture` 会在 Step 4 改为注入假发送器；这里先写测试）：

```go
package runner_test

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/runner"
)

// fakeSender 记录最近一次发送的验证码；err 非空时返回它。
type fakeSender struct {
	mu    sync.Mutex
	codes map[string]string
	err   error
}

func (f *fakeSender) Send(_ context.Context, phone, code string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return "", f.err
	}
	if f.codes == nil {
		f.codes = map[string]string{}
	}
	f.codes[phone] = code
	return "req-" + code, nil
}

func (f *fakeSender) last(phone string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.codes[phone]
}

const phoneA = "+85512345678"

func TestRequestPhoneCodeRejectsBadPhone(t *testing.T) {
	f := newFixture(t)
	_, err := f.svc.RequestPhoneCode(context.Background(), "012345678", testMeta)
	requireAppError(t, err, http.StatusUnprocessableEntity, apperr.CodeOTPPhoneInvalid)
}

func TestRequestPhoneCodeStoresHashAndInvalidatesOld(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()

	res, err := f.svc.RequestPhoneCode(ctx, phoneA, testMeta)
	require.NoError(t, err)
	assert.Equal(t, 5*time.Minute, res.ExpiresIn)
	assert.Equal(t, 60*time.Second, res.ResendAfter)
	first := f.sender.last(phoneA)
	require.Len(t, first, 6)

	f.clock.t = f.clock.t.Add(61 * time.Second)
	_, err = f.svc.RequestPhoneCode(ctx, phoneA, testMeta)
	require.NoError(t, err)
	assert.Equal(t, 1, countRows(t, f.pool, "SELECT count(*) FROM auth_otps WHERE phone_e164=$1 AND consumed_at IS NULL", phoneA))
	assert.Equal(t, 2, countRows(t, f.pool, "SELECT count(*) FROM auth_otps WHERE phone_e164=$1", phoneA))
	assert.Equal(t, 2, countRows(t, f.pool, "SELECT count(*) FROM auth_otps WHERE provider_request_id LIKE 'req-%'"), "两条都应带 request_id")
}

func TestRequestPhoneCodeCooldown(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	_, err := f.svc.RequestPhoneCode(ctx, phoneA, testMeta)
	require.NoError(t, err)

	_, err = f.svc.RequestPhoneCode(ctx, phoneA, testMeta)

	requireAppError(t, err, http.StatusTooManyRequests, apperr.CodeRateLimited)
	appErr, _ := apperr.As(err)
	assert.Equal(t, "60", appErr.Fields["retryAfterSeconds"])
}

func TestRequestPhoneCodeSendFailures(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"号码不可达", runner.ErrPhoneUnreachable, 422, apperr.CodeOTPPhoneNotOnTelegram},
		{"通道故障", errors.New("boom"), 502, apperr.CodeOTPSendFailed},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			f.sender.err = tc.err
			_, err := f.svc.RequestPhoneCode(context.Background(), phoneA, testMeta)
			requireAppError(t, err, tc.status, tc.code)
			assert.Equal(t, 0, countRows(t, f.pool, "SELECT count(*) FROM auth_otps WHERE phone_e164=$1 AND consumed_at IS NULL", phoneA), "发送失败的验证码必须作废")
		})
	}
}

func TestVerifyPhoneCodeHappyPath(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	_, err := f.svc.RequestPhoneCode(ctx, phoneA, testMeta)
	require.NoError(t, err)

	sess, err := f.svc.VerifyPhoneCode(ctx, phoneA, f.sender.last(phoneA), "km", testMeta)

	require.NoError(t, err)
	assert.Equal(t, phoneA, sess.User.Phone)
	assert.Zero(t, sess.User.TelegramUserID)
	assert.Equal(t, "km", sess.User.Locale)
	assert.Equal(t, f.clock.t.Add(runner.SessionTTL), sess.ExpiresAt)
	u, err := f.svc.Authenticate(ctx, sess.Token)
	require.NoError(t, err)
	assert.Equal(t, sess.User.ID, u.ID)
	assert.Equal(t, 1, countRows(t, f.pool, "SELECT count(*) FROM audit_logs WHERE action='runner.login' AND entity_id=$1", u.ID))

	// 同一验证码不能用第二次
	_, err = f.svc.VerifyPhoneCode(ctx, phoneA, f.sender.last(phoneA), "km", testMeta)
	requireAppError(t, err, 422, apperr.CodeOTPExpired)
}

func TestVerifyPhoneCodeSecondLoginKeepsLocale(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	_, _ = f.svc.RequestPhoneCode(ctx, phoneA, testMeta)
	first, err := f.svc.VerifyPhoneCode(ctx, phoneA, f.sender.last(phoneA), "km", testMeta)
	require.NoError(t, err)

	f.clock.t = f.clock.t.Add(2 * time.Minute)
	_, _ = f.svc.RequestPhoneCode(ctx, phoneA, testMeta)
	second, err := f.svc.VerifyPhoneCode(ctx, phoneA, f.sender.last(phoneA), "en", testMeta)

	require.NoError(t, err)
	assert.Equal(t, first.User.ID, second.User.ID)
	assert.Equal(t, "km", second.User.Locale, "再次登录不覆盖 locale")
}

func TestVerifyPhoneCodeWrongAndExceeded(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	_, _ = f.svc.RequestPhoneCode(ctx, phoneA, testMeta)

	for i := 4; i >= 1; i-- {
		_, err := f.svc.VerifyPhoneCode(ctx, phoneA, "000000", "zh", testMeta)
		requireAppError(t, err, 422, apperr.CodeOTPInvalid)
		appErr, _ := apperr.As(err)
		assert.Equal(t, string(rune('0'+i)), appErr.Fields["attemptsLeft"])
	}
	_, err := f.svc.VerifyPhoneCode(ctx, phoneA, "000000", "zh", testMeta)
	requireAppError(t, err, 422, apperr.CodeOTPInvalid)
	_, err = f.svc.VerifyPhoneCode(ctx, phoneA, f.sender.last(phoneA), "zh", testMeta)
	requireAppError(t, err, 422, apperr.CodeOTPAttemptsExceeded)
}

func TestVerifyPhoneCodeExpired(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	_, _ = f.svc.RequestPhoneCode(ctx, phoneA, testMeta)
	f.clock.t = f.clock.t.Add(5*time.Minute + time.Second)

	_, err := f.svc.VerifyPhoneCode(ctx, phoneA, f.sender.last(phoneA), "zh", testMeta)

	requireAppError(t, err, 422, apperr.CodeOTPExpired)
}

func TestVerifyPhoneCodeDisabledUser(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	_, _ = f.svc.RequestPhoneCode(ctx, phoneA, testMeta)
	_, err := f.svc.VerifyPhoneCode(ctx, phoneA, f.sender.last(phoneA), "zh", testMeta)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, "UPDATE users SET status='DISABLED' WHERE phone_e164=$1", phoneA)
	require.NoError(t, err)

	f.clock.t = f.clock.t.Add(2 * time.Minute)
	_, _ = f.svc.RequestPhoneCode(ctx, phoneA, testMeta)
	_, err = f.svc.VerifyPhoneCode(ctx, phoneA, f.sender.last(phoneA), "zh", testMeta)

	requireAppError(t, err, http.StatusForbidden, apperr.CodeForbidden)
}

func TestUpdateMe(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	_, _ = f.svc.RequestPhoneCode(ctx, phoneA, testMeta)
	sess, err := f.svc.VerifyPhoneCode(ctx, phoneA, f.sender.last(phoneA), "zh", testMeta)
	require.NoError(t, err)

	name := "Sok Dara"
	lang := "en"
	u, err := f.svc.UpdateMe(ctx, sess.User.ID, &name, &lang, testMeta)
	require.NoError(t, err)
	assert.Equal(t, "Sok Dara", u.DisplayName)
	assert.Equal(t, "en", u.Locale)

	tooLong := string(make([]rune, 65))
	_, err = f.svc.UpdateMe(ctx, sess.User.ID, &tooLong, nil, testMeta)
	requireAppError(t, err, 422, apperr.CodeValidation)
	bad := "fr"
	_, err = f.svc.UpdateMe(ctx, sess.User.ID, nil, &bad, testMeta)
	requireAppError(t, err, 422, apperr.CodeValidation)
}

func TestFixedSenderUsesFixedCode(t *testing.T) {
	f := newFixtureWithSender(t, runner.FixedOTPSender{})
	ctx := context.Background()
	_, err := f.svc.RequestPhoneCode(ctx, phoneA, testMeta)
	require.NoError(t, err)
	_, err = f.svc.VerifyPhoneCode(ctx, phoneA, runner.FixedOTPCode, "zh", testMeta)
	require.NoError(t, err)
}
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd api && go test ./internal/runner/ -run 'TestRequestPhoneCode|TestVerifyPhoneCode|TestUpdateMe|TestFixedSender' -v`
Expected: 编译错误（`f.sender`、`RequestPhoneCode` 未定义）

- [ ] **Step 4: 改 `Service` 与测试夹具**

`service.go`：

```go
type Service struct {
	pool     *pgxpool.Pool
	q        *store.Queries
	secret   []byte
	botToken string
	pii      *piicrypt.Cipher
	now      func() time.Time
	otp      OTPSender
	limiter  *OTPLimiter
}

// NewService：sessionSecret 与员工会话共用 WERUN_SESSION_SECRET；now 在测试中注入；
// otp 为 FixedOTPSender 时验证码固定为 FixedOTPCode。
func NewService(pool *pgxpool.Pool, sessionSecret []byte, botToken string, pii *piicrypt.Cipher, now func() time.Time, otp OTPSender, limiter *OTPLimiter) *Service {
	return &Service{pool: pool, q: store.New(pool), secret: sessionSecret, botToken: botToken, pii: pii, now: now, otp: otp, limiter: limiter}
}
```

`service_test.go` 的 `fixture` 加字段 `sender *fakeSender`；`newFixture` 改为调用 `newFixtureWithSender(t, &fakeSender{})`，并新增：

```go
func newFixtureWithSender(t *testing.T, sender runner.OTPSender) fixture {
	t.Helper()
	pool := dbtest.NewPool(t)
	pii, err := piicrypt.New([]byte(strings.Repeat("p", 32)))
	require.NoError(t, err)
	clock := &testClock{t: baseNow}
	f := fixture{pool: pool, clock: clock, pii: pii}
	if fs, ok := sender.(*fakeSender); ok {
		f.sender = fs
	}
	f.svc = runner.NewService(pool, testSessionSecret, testBotToken, pii, clock.Now, sender, runner.NewOTPLimiter(clock.Now))
	return f
}
```

`grep -rn "runner.NewService(" api/` 找到所有其他调用处（`app.go`、`httpapi` 测试），补上 `, runner.FixedOTPSender{}, runner.NewOTPLimiter(time.Now)`（app.go 的装配在 Task 7 再换成按配置选择）。

- [ ] **Step 5: 实现 `otp.go`**

```go
package runner

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"regexp"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/audit"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/runner/store"
)

const (
	otpTTL         = 5 * time.Minute
	otpResendAfter = 60 * time.Second
	otpMaxAttempts = 5
	otpLength      = 6
	displayNameMax = 64
)

var e164 = regexp.MustCompile(`^\+[1-9][0-9]{6,14}$`)

// ValidE164 判断手机号是否为 E.164 格式。
func ValidE164(phone string) bool { return e164.MatchString(phone) }

// CodeRequest 是请求验证码成功后的响应。
type CodeRequest struct {
	ExpiresIn   time.Duration
	ResendAfter time.Duration
	Channel     string
}

// RequestPhoneCode 生成验证码、写入 auth_otps（作废旧码）、事务提交后交给发送器；
// 发送失败时作废刚写入的记录并按失败类型返回错误。
func (s *Service) RequestPhoneCode(ctx context.Context, phone string, meta httpx.Meta) (CodeRequest, error) {
	if !ValidE164(phone) {
		return CodeRequest{}, apperr.New(http.StatusUnprocessableEntity, apperr.CodeOTPPhoneInvalid)
	}
	if wait, ok := s.limiter.Allow(phone, meta.IP); !ok {
		return CodeRequest{}, apperr.New(http.StatusTooManyRequests, apperr.CodeRateLimited).
			WithField("retryAfterSeconds", strconv.Itoa(int(wait/time.Second)), nil)
	}
	code, err := s.newCode()
	if err != nil {
		return CodeRequest{}, err
	}
	now := s.now()
	var id int64
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		if err := q.ConsumeActiveOTPs(ctx, store.ConsumeActiveOTPsParams{PhoneE164: phone, ConsumedAt: now}); err != nil {
			return fmt.Errorf("runner: consume old otps: %w", err)
		}
		id, err = q.InsertOTP(ctx, store.InsertOTPParams{
			PhoneE164: phone, CodeHash: s.hashCode(phone, code), ExpiresAt: now.Add(otpTTL), Ip: parseIP(meta.IP), CreatedAt: now,
		})
		if err != nil {
			return fmt.Errorf("runner: insert otp: %w", err)
		}
		return nil
	})
	if err != nil {
		return CodeRequest{}, err
	}
	requestID, sendErr := s.otp.Send(ctx, phone, code)
	if sendErr != nil {
		_ = s.q.ConsumeOTP(ctx, store.ConsumeOTPParams{ID: id, ConsumedAt: s.now()})
		if errors.Is(sendErr, ErrPhoneUnreachable) {
			return CodeRequest{}, apperr.New(http.StatusUnprocessableEntity, apperr.CodeOTPPhoneNotOnTelegram).Wrap(sendErr)
		}
		return CodeRequest{}, apperr.New(http.StatusBadGateway, apperr.CodeOTPSendFailed).Wrap(sendErr)
	}
	if requestID != "" {
		if err := s.q.SetOTPProviderRequestID(ctx, store.SetOTPProviderRequestIDParams{ID: id, ProviderRequestID: &requestID}); err != nil {
			return CodeRequest{}, fmt.Errorf("runner: store provider request id: %w", err)
		}
	}
	return CodeRequest{ExpiresIn: otpTTL, ResendAfter: otpResendAfter, Channel: "telegram"}, nil
}

// VerifyPhoneCode 校验验证码，按手机号创建或找到跑者，签发会话并写审计 runner.login。
func (s *Service) VerifyPhoneCode(ctx context.Context, phone, code, locale string, meta httpx.Meta) (Session, error) {
	if !ValidE164(phone) {
		return Session{}, apperr.New(http.StatusUnprocessableEntity, apperr.CodeOTPPhoneInvalid)
	}
	if _, ok := i18n.Parse(locale); !ok {
		locale = "km"
	}
	raw := make([]byte, tokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return Session{}, fmt.Errorf("runner: generate session token: %w", err)
	}
	now := s.now()
	expiresAt := now.Add(SessionTTL)
	var user User
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		otp, err := q.GetActiveOTPForUpdate(ctx, phone)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && !now.Before(otp.ExpiresAt)) {
			return apperr.New(http.StatusUnprocessableEntity, apperr.CodeOTPExpired)
		}
		if err != nil {
			return fmt.Errorf("runner: load otp: %w", err)
		}
		if otp.Attempts >= otpMaxAttempts {
			_ = q.ConsumeOTP(ctx, store.ConsumeOTPParams{ID: otp.ID, ConsumedAt: now})
			return apperr.New(http.StatusUnprocessableEntity, apperr.CodeOTPAttemptsExceeded)
		}
		if subtle.ConstantTimeCompare(otp.CodeHash, s.hashCode(phone, code)) != 1 {
			attempts, err := q.IncrementOTPAttempts(ctx, otp.ID)
			if err != nil {
				return fmt.Errorf("runner: bump otp attempts: %w", err)
			}
			left := otpMaxAttempts - int(attempts)
			if left <= 0 {
				_ = q.ConsumeOTP(ctx, store.ConsumeOTPParams{ID: otp.ID, ConsumedAt: now})
			}
			return apperr.New(http.StatusUnprocessableEntity, apperr.CodeOTPInvalid).
				WithField("attemptsLeft", strconv.Itoa(max(left, 0)), nil)
		}
		if err := q.ConsumeOTP(ctx, store.ConsumeOTPParams{ID: otp.ID, ConsumedAt: now}); err != nil {
			return fmt.Errorf("runner: consume otp: %w", err)
		}
		row, err := q.UpsertPhoneUser(ctx, store.UpsertPhoneUserParams{PhoneE164: &phone, Locale: locale, LastLoginAt: now})
		if err != nil {
			return fmt.Errorf("runner: upsert phone user: %w", err)
		}
		if row.Status != statusActive {
			return apperr.New(http.StatusForbidden, apperr.CodeForbidden).Wrap(fmt.Errorf("runner: user %d is %s", row.ID, row.Status))
		}
		user = userFromColumns(row.ID, row.PhoneE164, row.TelegramUserID, row.TelegramUsername, row.DisplayName, row.Locale)
		if err := q.InsertUserSession(ctx, store.InsertUserSessionParams{
			UserID: user.ID, TokenHash: s.hashToken(raw), ExpiresAt: expiresAt, Ip: parseIP(meta.IP), UserAgent: optionalString(meta.UserAgent), CreatedAt: now,
		}); err != nil {
			return fmt.Errorf("runner: insert session for user %d: %w", user.ID, err)
		}
		actorID := user.ID
		return audit.Record(ctx, tx, audit.Entry{
			ActorType: "USER", ActorID: &actorID, Action: "runner.login", EntityType: "user", EntityID: user.ID,
			Summary: fmt.Sprintf("跑者 %s（手机号 %s）登录", user.DisplayName, maskPhone(phone)), Meta: meta,
		})
	})
	if err != nil {
		return Session{}, err
	}
	return Session{Token: base64.RawURLEncoding.EncodeToString(raw), ExpiresAt: expiresAt, User: user}, nil
}

// UpdateMe 修改显示名与语言；nil 表示不改。
func (s *Service) UpdateMe(ctx context.Context, userID int64, displayName, locale *string, meta httpx.Meta) (User, error) {
	if displayName != nil && (utf8.RuneCountInString(*displayName) == 0 || utf8.RuneCountInString(*displayName) > displayNameMax) {
		return User{}, apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation).WithField("displayName", "field.too_long", nil)
	}
	if locale != nil {
		if _, ok := i18n.Parse(*locale); !ok {
			return User{}, apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation).WithField("locale", "field.invalid", nil)
		}
	}
	var user User
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		cur, err := q.GetUserByID(ctx, userID) // 见下方：需要在 runner.sql 补一条查询
		if err != nil {
			return fmt.Errorf("runner: load user %d: %w", userID, err)
		}
		name, lang := cur.DisplayName, cur.Locale
		if displayName != nil {
			name = displayName
		}
		if locale != nil {
			lang = *locale
		}
		row, err := q.UpdateUserProfile(ctx, store.UpdateUserProfileParams{ID: userID, DisplayName: name, Locale: lang})
		if err != nil {
			return fmt.Errorf("runner: update user %d: %w", userID, err)
		}
		user = userFromColumns(row.ID, row.PhoneE164, row.TelegramUserID, row.TelegramUsername, row.DisplayName, row.Locale)
		actorID := userID
		return audit.Record(ctx, tx, audit.Entry{ActorType: "USER", ActorID: &actorID, Action: "runner.profile_update", EntityType: "user", EntityID: userID, Summary: "跑者修改显示名或语言", Meta: meta})
	})
	return user, err
}

func (s *Service) newCode() (string, error) {
	if _, fixed := s.otp.(FixedOTPSender); fixed {
		return FixedOTPCode, nil
	}
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return "", fmt.Errorf("runner: generate otp: %w", err)
	}
	return fmt.Sprintf("%0*d", otpLength, n.Int64()), nil
}

// hashCode = HMAC-SHA256(sessionSecret, phone + ":" + code)
func (s *Service) hashCode(phone, code string) []byte {
	mac := hmac.New(sha256.New, s.secret)
	_, _ = mac.Write([]byte(phone + ":" + code))
	return mac.Sum(nil)
}
```

在 `runner.sql` 补：

```sql
-- name: GetUserByID :one
SELECT id, phone_e164, telegram_user_id, telegram_username, display_name, locale, status FROM users WHERE id = @id;
```

然后 `make gen`。如果 `i18n.Parse` 不存在同名函数，用 `notify/service.go` 里同样的调用方式替换（该文件第 48 行已在用 `i18n.Parse(recipient.Locale)`）。

- [ ] **Step 6: 跑测试确认通过**

Run: `cd api && go test ./internal/runner/... -v -run 'TestRequestPhoneCode|TestVerifyPhoneCode|TestUpdateMe|TestFixedSender|TestOTPLimiter|TestGateway' && go test ./internal/runner/... && go tool golangci-lint run ./internal/runner/...`
Expected: 全部 PASS，lint 无告警

- [ ] **Step 7: 提交**

```bash
git add api/internal/runner api/internal/platform/apperr api/internal/platform/i18n api/db/queries
git commit -m "feat(api): phone OTP request/verify and runner profile update"
```

---

### Task 6: OpenAPI 接口、handler 与 HTTP 测试

**Files:**
- Modify: `api/openapi/openapi.yaml`
- Modify: `api/internal/runner/handlers.go`
- Generated: `api/internal/httpapi/apigen/*`、`packages/api-client/src/schema.ts`（`make gen`）
- Test: `api/internal/httpapi/runner_http_test.go`（追加）

**Interfaces:**
- Produces（HTTP）：
  - `POST /api/app/auth/phone/request` body `{ phone }` → 200 `{ expiresInSeconds, resendAfterSeconds, channel }`
  - `POST /api/app/auth/phone/verify` body `{ phone, code }` → 200 `AppSession`
  - `PATCH /api/app/me` body `{ displayName?, locale? }` → 200 `AppUser`
  - `AppUser` 变更：`telegramUserId`、`telegramUsername` 变为 `nullable: true`（仍在 required 里，值可为 null）；新增 `phoneMasked: string, nullable`

- [ ] **Step 1: 改 OpenAPI**

在 `/app/auth/telegram:` 之后加：

```yaml
  /app/auth/phone/request:
    post:
      operationId: appRequestPhoneCode
      tags: [app-auth]
      summary: 向手机号发送登录验证码（经 Telegram Gateway）
      x-auth: none
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/PhoneCodeRequest'
      responses:
        '200':
          description: 已发送
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/PhoneCodeSent'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
  /app/auth/phone/verify:
    post:
      operationId: appVerifyPhoneCode
      tags: [app-auth]
      summary: 校验验证码并签发跑者令牌
      x-auth: none
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/PhoneCodeVerify'
      responses:
        '200':
          description: 登录成功
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AppSession'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
```

`/app/me:` 下 `get:` 之后加：

```yaml
    patch:
      operationId: appUpdateMe
      tags: [app-auth]
      summary: 修改显示名或语言
      x-auth: app
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/UpdateMeRequest'
      responses:
        '200':
          description: 已更新
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AppUser'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
```

schemas：

```yaml
    PhoneCodeRequest:
      type: object
      required: [phone]
      properties:
        phone:
          type: string
          description: E.164，例如 +85512345678
          minLength: 8
          maxLength: 16
    PhoneCodeSent:
      type: object
      required: [expiresInSeconds, resendAfterSeconds, channel]
      properties:
        expiresInSeconds:
          type: integer
        resendAfterSeconds:
          type: integer
        channel:
          type: string
          enum: [telegram]
    PhoneCodeVerify:
      type: object
      required: [phone, code]
      properties:
        phone:
          type: string
          minLength: 8
          maxLength: 16
        code:
          type: string
          minLength: 6
          maxLength: 6
    UpdateMeRequest:
      type: object
      properties:
        displayName:
          type: string
          minLength: 1
          maxLength: 64
        locale:
          type: string
          enum: [zh, en, km]
```

`AppUser` 改为：

```yaml
    AppUser:
      type: object
      required: [id, telegramUserId, telegramUsername, phoneMasked, displayName, locale]
      properties:
        id:
          type: integer
          format: int64
        telegramUserId:
          type: integer
          format: int64
          nullable: true
        telegramUsername:
          type: string
          nullable: true
        phoneMasked:
          type: string
          nullable: true
          description: 形如 +855***678；没有手机号时为 null
        displayName:
          type: string
        locale:
          type: string
          enum: [zh, en, km]
```

Run: `make gen && cd api && go build ./...`
Expected: 编译错误 `*Server does not implement apigen.StrictServerInterface (missing method AppRequestPhoneCode …)`——预期

- [ ] **Step 2: 写失败 HTTP 测试**

在 `runner_http_test.go` 末尾追加（该文件已有构造路由与登录的 helper，沿用其命名；下面以 `newRouter(t, nil)` 与 `postJSON(router, path, body)` 指代文件内已有的等价 helper，执行时按实际名字替换）：

```go
func TestPhoneLoginFlowHTTP(t *testing.T) {
	router := newRouter(t, nil) // 使用 FixedOTPSender，验证码恒为 123456

	rec := postJSON(router, "/api/app/auth/phone/request", map[string]any{"phone": "+85512345678"})
	require.Equal(t, 200, rec.Code, rec.Body.String())
	var sent struct{ ExpiresInSeconds, ResendAfterSeconds int; Channel string }
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &sent))
	assert.Equal(t, 300, sent.ExpiresInSeconds)
	assert.Equal(t, 60, sent.ResendAfterSeconds)

	rec = postJSON(router, "/api/app/auth/phone/verify", map[string]any{"phone": "+85512345678", "code": "000000"})
	require.Equal(t, 422, rec.Code)
	assert.Contains(t, rec.Body.String(), `"OTP_INVALID"`)
	assert.Contains(t, rec.Body.String(), `"attemptsLeft":"4"`)

	rec = postJSON(router, "/api/app/auth/phone/verify", map[string]any{"phone": "+85512345678", "code": "123456"})
	require.Equal(t, 200, rec.Code, rec.Body.String())
	var sess struct {
		Token string
		User  struct {
			TelegramUserId *int64
			PhoneMasked    *string
		}
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &sess))
	assert.Nil(t, sess.User.TelegramUserId)
	require.NotNil(t, sess.User.PhoneMasked)
	assert.Equal(t, "+855***678", *sess.User.PhoneMasked)

	req := httptest.NewRequest(http.MethodPatch, "/api/app/me", strings.NewReader(`{"displayName":"Dara","locale":"en"}`))
	req.Header.Set("Authorization", "Bearer "+sess.Token)
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), `"displayName":"Dara"`)
}

func TestPhoneRequestRejectsBadPhoneHTTP(t *testing.T) {
	router := newRouter(t, nil)
	rec := postJSON(router, "/api/app/auth/phone/request", map[string]any{"phone": "012345678"})
	assert.Equal(t, 422, rec.Code)
	assert.Contains(t, rec.Body.String(), `"OTP_PHONE_INVALID"`)
}
```

- [ ] **Step 3: 实现 handler**

`handlers.go` 追加：

```go
func (h *Handlers) AppRequestPhoneCode(ctx context.Context, req apigen.AppRequestPhoneCodeRequestObject) (apigen.AppRequestPhoneCodeResponseObject, error) {
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	res, err := h.svc.RequestPhoneCode(ctx, strings.TrimSpace(req.Body.Phone), httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AppRequestPhoneCode200JSONResponse{
		ExpiresInSeconds:   int(res.ExpiresIn / time.Second),
		ResendAfterSeconds: int(res.ResendAfter / time.Second),
		Channel:            apigen.PhoneCodeSentChannel(res.Channel),
	}, nil
}

func (h *Handlers) AppVerifyPhoneCode(ctx context.Context, req apigen.AppVerifyPhoneCodeRequestObject) (apigen.AppVerifyPhoneCodeResponseObject, error) {
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	sess, err := h.svc.VerifyPhoneCode(ctx, strings.TrimSpace(req.Body.Phone), strings.TrimSpace(req.Body.Code), string(i18n.LangOf(ctx)), httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AppVerifyPhoneCode200JSONResponse{Token: sess.Token, ExpiresAt: sess.ExpiresAt, User: toAppUser(sess.User)}, nil
}

func (h *Handlers) AppUpdateMe(ctx context.Context, req apigen.AppUpdateMeRequestObject) (apigen.AppUpdateMeResponseObject, error) {
	u, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	var locale *string
	if req.Body.Locale != nil {
		l := string(*req.Body.Locale)
		locale = &l
	}
	updated, err := h.svc.UpdateMe(ctx, u.ID, req.Body.DisplayName, locale, httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AppUpdateMe200JSONResponse(toAppUser(updated)), nil
}
```

`toAppUser` 改为：

```go
func toAppUser(u User) apigen.AppUser {
	out := apigen.AppUser{ID: u.ID, DisplayName: u.DisplayName, Locale: apigen.AppUserLocale(u.Locale)}
	if u.TelegramUserID != 0 {
		id := u.TelegramUserID
		out.TelegramUserId = &id
		name := u.TelegramUsername
		out.TelegramUsername = &name
	}
	if u.Phone != "" {
		m := maskPhone(u.Phone)
		out.PhoneMasked = &m
	}
	return out
}
```

`i18n.LangOf(ctx)`：如果 `platform/i18n` 里取请求语言的函数不叫这个名字，用 `httpx`/`i18n` 中现有的"从 ctx 取 Accept-Language 解析结果"的函数（`grep -rn "Accept-Language" api/internal/platform` 找到它）。生成代码里 `ID` 字段可能叫 `Id`，以 `apigen` 实际为准。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd api && go test ./internal/httpapi/ -run 'TestPhone' -v && go test ./... && go tool golangci-lint run ./...`
Expected: 全部 PASS；`make gen` 后 `git status --porcelain` 只含本任务预期改动

- [ ] **Step 5: 提交**

```bash
git add api/openapi api/internal packages/api-client/src/schema.ts
git commit -m "feat(api): phone login endpoints and PATCH /app/me"
```

---

### Task 7: 装配发送器与限流器

**Files:**
- Modify: `api/cmd/werun/app.go`
- Test: `api/cmd/werun/app_notify_test.go` 旁新建 `api/cmd/werun/app_otp_test.go`

**Interfaces:**
- Consumes: `config.OTPSenderKind()`、`runner.NewGatewaySender`、`runner.LogOTPSender`、`runner.FixedOTPSender`
- Produces: `func newOTPSender(cfg config.Config, log *slog.Logger) runner.OTPSender`

- [ ] **Step 1: 写失败测试**

```go
package main

import (
	"log/slog"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"

	"werun/api/internal/platform/config"
	"werun/api/internal/runner"
)

func TestNewOTPSenderByConfig(t *testing.T) {
	log := slog.New(slog.NewTextHandler(os.Stdout, nil))
	assert.IsType(t, runner.FixedOTPSender{}, newOTPSender(config.Config{Env: "dev"}, log))
	assert.IsType(t, runner.LogOTPSender{}, newOTPSender(config.Config{Env: "dev", OTPSender: "log"}, log))
	assert.IsType(t, &runner.GatewaySender{}, newOTPSender(config.Config{Env: "prod", TelegramGatewayToken: "x"}, log))
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd api && go test ./cmd/werun/ -run TestNewOTPSenderByConfig -v`
Expected: `undefined: newOTPSender`

- [ ] **Step 3: 实现**

`app.go` 中把 `app.Runner = runner.NewService(...)` 改为：

```go
	app.Runner = runner.NewService(app.Pool, []byte(app.Cfg.SessionSecret), app.Cfg.TelegramBotToken, app.PII, time.Now,
		newOTPSender(app.Cfg, app.Log), runner.NewOTPLimiter(time.Now))
```

并在 `newNotifySender` 旁加：

```go
// newOTPSender 按 WERUN_OTP_SENDER 选择验证码发送器（config.Load 已保证 prod 只能是 telegram）。
func newOTPSender(cfg config.Config, log *slog.Logger) runner.OTPSender {
	switch cfg.OTPSenderKind() {
	case "telegram":
		return runner.NewGatewaySender(cfg.TelegramGatewayToken, runner.DefaultGatewayBaseURL, &http.Client{Timeout: 10 * time.Second})
	case "log":
		return runner.LogOTPSender{Log: log}
	default:
		return runner.FixedOTPSender{}
	}
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd api && go test ./cmd/werun/ && go build ./...`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add api/cmd/werun
git commit -m "feat(api): wire OTP sender and limiter into the app"
```

---

### Task 8: 前端令牌存储与 `AuthController`

**Files:**
- Modify: `web/user/src/auth/session.ts`
- Modify: `web/user/src/auth/controller.ts`
- Modify: `web/user/src/bootstrap.tsx`
- Test: `web/user/src/auth/session.test.ts`（若不存在则新建）、`web/user/src/auth/controller.test.ts`（追加）

**Interfaces:**
- Produces:
  - `session.ts`：`storage()` 在 `isTelegram()` 为真时用 `sessionStorage`，否则 `localStorage`；导出 `export function isBrowserMode(): boolean`（`!isTelegram()`）
  - `AuthControllerDeps` 新增 `requestCode: (phone: string) => Promise<Schemas["PhoneCodeSent"]>`、`verifyCode: (phone: string, code: string) => Promise<Schemas["AppSession"]>`、`browserMode: () => boolean`
  - `AuthController.requestCode(phone)`、`AuthController.loginWithPhone(phone, code): Promise<void>`（失败抛 `ApiError`）
  - 浏览器模式下 `handleUnauthorized()` 只清令牌并置 `unauthenticated`；`restore()` 无 initData 时置 `unauthenticated`

- [ ] **Step 1: 写失败测试**

`session.test.ts`：

```ts
import { afterEach, describe, expect, it } from "vitest";
import { clearToken, readToken, saveToken, TOKEN_KEY } from "./session";

describe("session storage by environment", () => {
  afterEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.location.hash = "";
  });

  it("浏览器模式写 localStorage", () => {
    saveToken("tok", "2099-01-01T00:00:00Z");
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe("tok");
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(readToken()).toBe("tok");
    clearToken();
    expect(readToken()).toBeNull();
  });

  it("Telegram 模式写 sessionStorage", () => {
    window.location.hash = "#tgWebAppData=x";
    saveToken("tok", "2099-01-01T00:00:00Z");
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBe("tok");
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
  });
});
```

`controller.test.ts` 的 `makeDeps` 增加三个 mock：`requestCode: vi.fn(async () => ({ expiresInSeconds: 300, resendAfterSeconds: 60, channel: "telegram" as const }))`、`verifyCode: vi.fn(async () => session("tok-phone"))`、`browserMode: vi.fn(() => false)`；`runner` 常量补 `phoneMasked: null`。追加用例：

```ts
  it("loginWithPhone 成功后保存令牌并进入 authenticated", async () => {
    const deps = makeDeps(null);
    const controller = new AuthController(deps);
    await controller.start();
    expect(controller.getState().status).toBe("unauthenticated");

    await controller.loginWithPhone("+85512345678", "123456");

    expect(deps.verifyCode).toHaveBeenCalledWith("+85512345678", "123456");
    expect(controller.getState().status).toBe("authenticated");
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe("tok-phone");
  });

  it("浏览器模式下 401 只清令牌，不重登", async () => {
    const deps = makeDeps(null);
    deps.browserMode.mockReturnValue(true);
    saveToken("tok-old", "2099-01-01T00:00:00Z");
    const controller = new AuthController(deps);
    await controller.start();
    expect(controller.getState().status).toBe("authenticated");

    controller.handleUnauthorized();
    await controller.lastRelogin();

    expect(deps.login).not.toHaveBeenCalled();
    expect(controller.getState().status).toBe("unauthenticated");
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @werun/user test -- src/auth`
Expected: FAIL（`loginWithPhone` 不存在；localStorage 为空）

- [ ] **Step 3: 实现 `session.ts`**

```ts
export function isBrowserMode(location: LocationLike = window.location): boolean {
  return !isTelegram(location);
}

function storage(): Storage | null {
  try {
    return isTelegram() ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 实现 `controller.ts`**

`AuthControllerDeps` 加三个成员；类里加：

```ts
  /** 浏览器模式：发送验证码 */
  requestCode(phone: string): Promise<Schemas["PhoneCodeSent"]> {
    return this.deps.requestCode(phone);
  }

  /** 浏览器模式：校验验证码并登录；失败时抛出 ApiError，状态保持不变 */
  async loginWithPhone(phone: string, code: string): Promise<void> {
    const session = await this.deps.verifyCode(phone, code);
    saveToken(session.token, session.expiresAt);
    this.set({ status: "authenticated", user: session.user });
  }
```

`handleUnauthorized()` 改为：

```ts
  handleUnauthorized(): void {
    if (this.loggingOut) {
      return;
    }
    clearToken();
    if (this.deps.browserMode()) {
      this.set({ status: "unauthenticated", user: null });
      this.last = Promise.resolve(false);
      return;
    }
    this.last = this.relogin();
  }
```

`restore()` 里 catch 分支后：浏览器模式下直接 `this.fail(); return false;`，Telegram 模式维持 `loginWithInitData()`。

`bootstrap.tsx` 的 `new AuthController({...})` 补：

```ts
    requestCode: async (phone) => unwrap(await api.POST("/app/auth/phone/request", { body: { phone } })),
    verifyCode: async (phone, code) => unwrap(await api.POST("/app/auth/phone/verify", { body: { phone, code } })),
    browserMode: () => isBrowserMode(),
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @werun/user test -- src/auth && pnpm --filter @werun/user typecheck`
Expected: PASS；typecheck 可能报其他文件对 `telegramUserId` 非空的假设（下一任务修），若只是这类错误则继续

- [ ] **Step 6: 提交**

```bash
git add web/user/src/auth web/user/src/bootstrap.tsx
git commit -m "feat(web): phone login in AuthController and browser-mode token storage"
```

---

### Task 9: 登录页、路由与守卫

**Files:**
- Create: `web/user/src/pages/LoginPage.tsx`、`web/user/src/pages/LoginPage.module.css`
- Test: `web/user/src/pages/LoginPage.test.tsx`、`web/user/src/auth/RequireRunner.test.tsx`（追加）
- Modify: `web/user/src/auth/RequireRunner.tsx`、`web/user/src/routes.tsx`
- Modify: `packages/i18n/locales/{zh,en,km}/user.json`

**Interfaces:**
- Consumes: `useAuth()` 增加 `requestCode`、`loginWithPhone`（在 `AuthProvider.tsx` 的 `useAuth` 返回值里透传 controller 的同名方法）
- Produces: 路由 `/login`；`RequireRunner` 在浏览器模式未登录时 `<Navigate to={`/login?next=${encodeURIComponent(pathname+search)}`} replace />`

- [ ] **Step 1: 文案**

三份 `user.json` 的 `auth` 下加 `phone` 节点（zh 示例，en/km 对应翻译）：

```json
"phone": {
  "title": "手机号登录",
  "intro": "验证码会通过 Telegram 发送到这个手机号绑定的账号。",
  "countryCode": "国家码",
  "number": "手机号",
  "numberPlaceholder": "12 345 678",
  "sendCode": "发送验证码",
  "sending": "正在发送…",
  "resendIn": "{{seconds}} 秒后可重新发送",
  "resend": "重新发送",
  "code": "验证码",
  "codeHint": "6 位数字，5 分钟内有效",
  "verify": "登录",
  "verifying": "正在登录…",
  "sentTo": "验证码已发送到 {{phone}}",
  "changeNumber": "换个号码",
  "orTelegram": "也可以在 Telegram 中打开 WeRun 小程序，无需验证码。"
},
"login": "登录",
"logout": "退出登录"
```

`auth.openInTelegram.body` 追加一句"也可以用手机号登录。"，并新增 `auth.openInTelegram.phoneLogin: "用手机号登录"`。

- [ ] **Step 2: 写失败测试**

`LoginPage.test.tsx`（沿用 `ProfilesPage.test.tsx` 里 `createUserApp` + `createMemoryRouter` 的渲染方式；此处 `renderAt(path, deps)` 指代该文件里的等价 helper）：

```tsx
import { ApiError } from "@werun/api-client";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

describe("LoginPage", () => {
  it("发码后出现验证码输入并倒计时；验证成功后跳转 next", async () => {
    const { user, deps, router } = renderAt("/login?next=%2Forders", {
      requestCode: vi.fn(async () => ({ expiresInSeconds: 300, resendAfterSeconds: 60, channel: "telegram" as const })),
      verifyCode: vi.fn(async () => session("tok")),
    });
    await user.type(screen.getByTestId("login-phone"), "12345678");
    await user.click(screen.getByTestId("login-send"));

    expect(deps.requestCode).toHaveBeenCalledWith("+85512345678");
    await screen.findByTestId("login-code");
    expect(screen.getByTestId("login-resend")).toBeDisabled();

    await user.type(screen.getByTestId("login-code"), "123456");
    await user.click(screen.getByTestId("login-verify"));

    expect(deps.verifyCode).toHaveBeenCalledWith("+85512345678", "123456");
    await waitFor(() => expect(router.state.location.pathname).toBe("/orders"));
  });

  it("显示服务端错误文案", async () => {
    const { user } = renderAt("/login", {
      requestCode: vi.fn(async () => {
        throw new ApiError(422, "OTP_PHONE_NOT_ON_TELEGRAM", "这个手机号没有注册 Telegram");
      }),
    });
    await user.type(screen.getByTestId("login-phone"), "12345678");
    await user.click(screen.getByTestId("login-send"));
    expect(await screen.findByRole("alert")).toHaveTextContent("没有注册 Telegram");
  });
});
```

`RequireRunner.test.tsx` 追加：

```tsx
  it("浏览器模式未登录时跳到 /login 并带 next", async () => {
    const { router } = renderAt("/orders", { resolveInitData: async () => null });
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(router.state.location.search).toBe("?next=%2Forders");
  });
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @werun/user test -- LoginPage RequireRunner`
Expected: FAIL（没有 `/login` 路由、`login-phone` 不存在）

- [ ] **Step 4: 实现 `LoginPage.tsx`**

```tsx
import { ApiError } from "@werun/api-client";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import styles from "./LoginPage.module.css";
import pageStyles from "./Page.module.css";

const COUNTRY_CODES = ["+855", "+86", "+65", "+66", "+84", "+1", "+44", "+61"];

function safeNext(raw: string | null): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

export function LoginPage() {
  const { t } = useTranslation("user");
  const { status, requestCode, loginWithPhone } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));

  const [countryCode, setCountryCode] = useState("+855");
  const [local, setLocal] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (resendIn <= 0) return;
    const id = window.setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => window.clearTimeout(id);
  }, [resendIn]);

  if (status === "authenticated") {
    return <Navigate to={next} replace />;
  }

  const phone = countryCode + local.replace(/\D/g, "").replace(/^0+/, "");

  async function send(e?: FormEvent) {
    e?.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await requestCode(phone);
      setSentTo(phone);
      setResendIn(res.resendAfterSeconds);
      setCode("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("auth.phone.sendFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await loginWithPhone(sentTo ?? phone, code);
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("auth.phone.verifyFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.card}>
      <h1 className={pageStyles.title}>{t("auth.phone.title")}</h1>
      <p className={pageStyles.muted}>{t("auth.phone.intro")}</p>
      {sentTo === null ? (
        <form onSubmit={send} className={styles.form}>
          <label className={styles.row}>
            <span>{t("auth.phone.countryCode")}</span>
            <input list="country-codes" value={countryCode} onChange={(e) => setCountryCode(e.target.value.trim())} data-testid="login-country" />
            <datalist id="country-codes">{COUNTRY_CODES.map((c) => <option key={c} value={c} />)}</datalist>
          </label>
          <label className={styles.row}>
            <span>{t("auth.phone.number")}</span>
            <input inputMode="tel" autoComplete="tel-national" placeholder={t("auth.phone.numberPlaceholder")} value={local} onChange={(e) => setLocal(e.target.value)} data-testid="login-phone" />
          </label>
          <button type="submit" disabled={busy || local.replace(/\D/g, "").length < 6} data-testid="login-send">
            {busy ? t("auth.phone.sending") : t("auth.phone.sendCode")}
          </button>
        </form>
      ) : (
        <form onSubmit={verify} className={styles.form}>
          <p role="status">{t("auth.phone.sentTo", { phone: sentTo })}</p>
          <label className={styles.row}>
            <span>{t("auth.phone.code")}</span>
            <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} data-testid="login-code" />
            <small>{t("auth.phone.codeHint")}</small>
          </label>
          <button type="submit" disabled={busy || code.length !== 6} data-testid="login-verify">
            {busy ? t("auth.phone.verifying") : t("auth.phone.verify")}
          </button>
          <div className={styles.actions}>
            <button type="button" onClick={() => void send()} disabled={busy || resendIn > 0} data-testid="login-resend">
              {resendIn > 0 ? t("auth.phone.resendIn", { seconds: resendIn }) : t("auth.phone.resend")}
            </button>
            <button type="button" className={styles.link} onClick={() => { setSentTo(null); setError(null); }}>
              {t("auth.phone.changeNumber")}
            </button>
          </div>
        </form>
      )}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <p className={pageStyles.muted}>{t("auth.phone.orTelegram")}</p>
    </section>
  );
}
```

`user.json` 再补 `auth.phone.sendFailed`（"发送失败，请稍后再试"）与 `auth.phone.verifyFailed`（"登录失败，请重试"）三种语言。`LoginPage.module.css` 复用 `RequireRunner.module.css` 里 `card` 的样式并加 `.form`（`display:grid; gap:12px`）、`.row`（`display:grid; gap:4px`）、`.actions`（`display:flex; gap:12px`）、`.link`（无边框按钮）、`.error`（错误色，用 `var(--color-danger)` 或 tokens 里现有的等价变量）。

`AuthProvider.tsx` 的 `UseAuthResult` 与 `useAuth` 返回值加：

```ts
  requestCode: (phone: string) => Promise<Schemas["PhoneCodeSent"]>;
  loginWithPhone: (phone: string, code: string) => Promise<void>;
  // …
    requestCode: (phone) => controller.requestCode(phone),
    loginWithPhone: (phone, code) => controller.loginWithPhone(phone, code),
```

`routes.tsx` 在 `events/:slug` 后加 `{ path: "login", element: <LoginPage /> }`。

`RequireRunner.tsx` 的 `unauthenticated` 分支：

```tsx
  if (status === "unauthenticated") {
    if (isBrowserMode()) {
      const next = encodeURIComponent(location.pathname + location.search);
      return <Navigate to={`/login?next=${next}`} replace />;
    }
    return <OpenInTelegram />;
  }
```

（`const location = useLocation()` 放在组件顶部；`OpenInTelegram` 里加一个指向 `/login` 的 `<Link>`，文案 `auth.openInTelegram.phoneLogin`。）

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @werun/user test && pnpm --filter @werun/user typecheck && pnpm lint && pnpm i18n:check`
Expected: 全部通过。若 typecheck 报 `telegramUserId` 可能为 null 的错误，修改对应组件改用 `displayName`/`phoneMasked` 展示。

- [ ] **Step 6: 提交**

```bash
git add web/user/src packages/i18n/locales
git commit -m "feat(web): phone login page and browser-mode auth guard"
```

---

### Task 10: 顶栏用户区与「我的」页

**Files:**
- Modify: `web/user/src/components/Layout.tsx`、`Layout.module.css`
- Create: `web/user/src/pages/MePage.tsx`、`MePage.test.tsx`
- Modify: `web/user/src/routes.tsx`
- Modify: `packages/i18n/locales/*/user.json`

**Interfaces:**
- Consumes: `useAuth()`（`status`、`user`、`logout`）、`useApi()`、`PATCH /app/me`
- Produces: 路由 `/me`（在 `RequireRunner` 下）；顶栏在 `unauthenticated` 且浏览器模式时显示 `login` 链接，`authenticated` 时显示 `user.displayName || user.phoneMasked` 链接到 `/me`

- [ ] **Step 1: 文案**

`user.json` 加：

```json
"me": {
  "nav": "我的",
  "title": "我的账号",
  "displayName": "显示名",
  "displayNameHint": "用于页面问候与通知，不影响参赛人资料",
  "locale": "语言",
  "phone": "手机号",
  "telegram": "Telegram",
  "save": "保存",
  "saved": "已保存",
  "logout": "退出登录"
}
```

- [ ] **Step 2: 写失败测试**

```tsx
describe("MePage", () => {
  it("保存显示名并调用 PATCH /app/me", async () => {
    const patch = vi.fn(async () => ({ ...runner, displayName: "Dara" }));
    const { user } = renderAt("/me", { token: "tok", me: async () => runner, patchMe: patch });
    await user.clear(screen.getByTestId("me-display-name"));
    await user.type(screen.getByTestId("me-display-name"), "Dara");
    await user.click(screen.getByTestId("me-save"));
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ displayName: "Dara", locale: "en" }));
    expect(await screen.findByRole("status")).toHaveTextContent("已保存");
  });
});
```

（`renderAt` 用 `msw` 或 `api` 客户端 mock 的方式与 `ProfilesPage.test.tsx` 保持一致；`patchMe` 拦截 `PATCH /app/me`。）

- [ ] **Step 3: 实现**

`MePage.tsx`：表单两个字段（显示名输入、语言 `<select>`），提交调用 `useApi().PATCH("/app/me", { body })`，成功后 `useAuth().refresh?` 不存在则直接 `queryClient.invalidateQueries` 并把返回值写回表单，显示 `role="status"` 的「已保存」；底部「退出登录」按钮调用 `logout()` 后 `navigate("/")`。`Layout.tsx` 在 `<LanguageSwitch />` 前加：

```tsx
<UserMenu />
```

```tsx
function UserMenu() {
  const { status, user } = useAuth();
  const { t } = useTranslation("user");
  if (status === "authenticated" && user) {
    return <NavLink to="/me" className={styles.userLink} data-testid="nav-me">{user.displayName || user.phoneMasked || t("me.nav")}</NavLink>;
  }
  if (status === "unauthenticated" && isBrowserMode()) {
    return <NavLink to="/login" className={styles.userLink} data-testid="nav-login">{t("auth.login")}</NavLink>;
  }
  return null;
}
```

`routes.tsx` 的 `RequireRunner` children 加 `{ path: "me", element: <MePage /> }`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @werun/user test && pnpm typecheck && pnpm lint && pnpm i18n:check`
Expected: 全部通过

- [ ] **Step 5: 提交**

```bash
git add web/user/src packages/i18n/locales
git commit -m "feat(web): account page and header user menu"
```

---

### Task 11: 端到端测试与 CI

**Files:**
- Create: `e2e/tests/web-login.spec.ts`
- Modify: `.github/workflows/ci.yml`（Task 1 已加 `WERUN_OTP_SENDER=fixed`；此处确认）
- Modify: `e2e/tests/runner.ts`（新增 `loginByPhone` helper）

**Interfaces:**
- Produces: `export async function loginByPhone(page: Page, localNumber: string): Promise<void>`（在登录页完成发码与固定码校验）

- [ ] **Step 1: helper**

`runner.ts` 追加：

```ts
/** 浏览器模式：在登录页用固定验证码 123456 登录（compose 环境 WERUN_OTP_SENDER=fixed） */
export async function loginByPhone(page: Page, localNumber: string): Promise<void> {
  await page.getByTestId("login-phone").fill(localNumber);
  await page.getByTestId("login-send").click();
  await page.getByTestId("login-code").fill("123456");
  await page.getByTestId("login-verify").click();
}
```

- [ ] **Step 2: 写用例**

```ts
import { expect, test } from "@playwright/test";
import { OPS, USER_URL } from "./env";
import { adminSession, createAndPublishEvent, openEventDetail, openRegistration, presetLanguage } from "./helpers";
import { loginByPhone } from "./runner";

const runId = Date.now().toString(36);
const slug = `e2e-web-${runId}`;
// 每次运行用不同号码，避免上一轮的 60 秒冷却
const localNumber = `9${String(Date.now()).slice(-7)}`;

test.describe.configure({ mode: "serial" });

test("后台建免费活动并开放报名", async ({ browser }) => {
  const { context, page } = await adminSession(browser, OPS.username, OPS.password);
  await createAndPublishEvent(page, {
    slug,
    name: { zh: `网页登录测试 ${runId}`, en: `Web login ${runId}`, km: `Web ${runId}` },
    eventType: "FREE_ACTIVITY",
    capacity: 10,
  });
  const { id } = await openEventDetail(page, slug);
  await openRegistration(page, id);
  await context.close();
});

test("浏览器打开报名页被送到登录页，手机号登录后回到报名页", async ({ browser }) => {
  const context = await browser.newContext();
  await presetLanguage(context, "zh");
  const page = await context.newPage();

  await page.goto(`${USER_URL}/events/${slug}/free-signup`);
  await expect(page).toHaveURL(new RegExp(`/login\\?next=%2Fevents%2F${slug}%2Ffree-signup$`));

  await loginByPhone(page, localNumber);

  await expect(page).toHaveURL(`${USER_URL}/events/${slug}/free-signup`);
  await expect(page.getByTestId("nav-me")).toContainText("+855");

  // 令牌在 localStorage：新标签页仍是登录态
  const other = await context.newPage();
  await other.goto(`${USER_URL}/orders`);
  await expect(other).toHaveURL(`${USER_URL}/orders`);
  await context.close();
});

test("验证码错误提示剩余次数", async ({ browser }) => {
  const context = await browser.newContext();
  await presetLanguage(context, "zh");
  const page = await context.newPage();
  await page.goto(`${USER_URL}/login`);
  await page.getByTestId("login-phone").fill(`8${String(Date.now()).slice(-7)}`);
  await page.getByTestId("login-send").click();
  await page.getByTestId("login-code").fill("000000");
  await page.getByTestId("login-verify").click();
  await expect(page.getByRole("alert")).toContainText("验证码不正确");
  await context.close();
});
```

- [ ] **Step 3: 本地跑完整环境验证**

```bash
cp .env.example .env   # 若已有 .env，确认里面 WERUN_OTP_SENDER=fixed
make compose-up && make e2e-seed
pnpm --filter @werun/e2e e2e -- web-login
make compose-down
```

Expected: 3 个用例通过

- [ ] **Step 4: 全量验证**

Run: `make lint && make test`（后端测试需要 Docker）
Expected: 全部通过；`make gen && git status --porcelain` 无生成物 diff

- [ ] **Step 5: 提交并推送**

```bash
git add e2e .github/workflows/ci.yml
git commit -m "test(e2e): browser phone login flow"
git push origin main
```

CI 全绿后，用 Images job 产出的新 sha 更新 VM 上 `/opt/werun/.env` 的两个镜像标签，并加 `WERUN_OTP_SENDER=telegram`、`WERUN_TELEGRAM_GATEWAY_TOKEN=<真实值>`，然后 `docker compose pull && up -d --wait`。

---

## 自审结果

- **规格覆盖**：§4.1/4.2 → Task 5、6；§4.3 → Task 3；§4.4 → Task 4；§5 → Task 4；§6 → Task 2、5、6；§10 → Task 1、7；§11 → Task 5；§12.1 登录部分 → Task 8、9、10；§13.1–13.4 → 各任务的测试步骤与 Task 11。§7（站内通知）与 §12.1 通知部分属于第 2 批，不在本计划。
- **类型一致性**：`OTPSender.Send` 统一为 `(providerRequestID string, err error)`；`NewService` 七参签名在 Task 5 定义、Task 7 使用；`AppUser.phoneMasked` 在 Task 6 定义、Task 9/10 使用；`isBrowserMode` 在 Task 8 定义、Task 9/10 使用。
- **已知需执行者按实际代码调整的点**：`apigen` 字段名（`ID` vs `Id`）、`i18n` 取请求语言的函数名、各测试文件里已有 helper 的名字（`newRouter`/`postJSON`/`renderAt`）。这些都在对应步骤里写明了查找方法。
