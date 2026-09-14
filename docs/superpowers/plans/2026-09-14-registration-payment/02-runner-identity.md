# 第 2 段：跑者身份（Task 7–10）

> 本段每个任务都受 `00-overview.md` 的 Global Constraints 与「跨任务契约」约束：名字、签名、operationId、错误码、审计 action、testid、路由、sessionStorage 键、文案命名空间一律照抄，不得改名。Task 1–6（`01-platform-and-admin-config.md`）视为已按 overview 完成：`storage`、`piicrypt`、`idgen`、`settings`、配置字段（含 `TelegramBotToken`、`TelegramBotUsername`、`AppBaseURL`）、`jobs.Deps`、`App.PII`、迁移 0010（`disclaimer_versions.purpose` 与 `registration_consents`）、`money.ts` 均已存在。
>
> 数据库测试需要 Docker；本机为 colima 时，所有 `go test` 命令前加 `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true`（下文命令里写作 `$COLIMA_ENV`，执行前先 `export COLIMA_ENV='DOCKER_HOST=unix://'$HOME'/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true'`，然后用 `env $COLIMA_ENV go test …`；不是 colima 时直接 `go test …`）。

## 契约补充

overview 没写到、但本段实现必须确定的内容。后续段落按这里的约定使用：

1. **`runner.BearerToken(r *http.Request) string`**（Task 7）：从 `Authorization: Bearer <token>` 取令牌（scheme 大小写不敏感），取不到返回空串。`AuthMiddleware` 与 `AppLogout` 共用，避免两处各写一份解析。
2. **`runner.SessionTTL = 24 * time.Hour`**（Task 7）：跑者令牌有效期常量。
3. **停用账号登录**（Task 7）：`users.status = 'DISABLED'` 时 `LoginTelegram` 返回 403 `FORBIDDEN`，整个事务回滚，不建会话、不写审计。overview 只规定了 `Authenticate` 要求 `ACTIVE`，登录时的行为在这里定下来。
4. **`werun dev-initdata` 输出**（Task 7）：只包含 `auth_date`、`user`、`hash` 三个字段；`--name` 整体写进 `user.first_name`；`--lang` 默认 `en`。
5. **`runner.NormalizeProfile(p ProfileData) ProfileData`**（Task 8）：规范化规则见 Task 8。`ValidateProfile` 先规范化再校验；`CreateProfile`、`UpdateProfile`、`CreateProfileTx` 存的是规范化后的值；`LoadProfileForOrder` 返回的也是规范化后的值。Task 12 写 `registrations` 资料快照前应先调用它。
6. **OpenAPI 组件名**（Task 7–9）：`AppLoginRequest`、`AppSession`、`AppUser`、`RunnerProfile`、`RunnerProfileList`、`ProfileInput`、`Gender`、`IdType`、`TShirtSize`、`ConsentVersion`、`ConsentItem`。Task 12、14、22 复用 `Gender`、`IdType`、`TShirtSize`、`ProfileInput`，不要另建同义 schema。
7. **重复发布同意书**（Task 9）：主键约束 `disclaimer_versions_pkey` 冲突映射为 422 `VALIDATION_FAILED`，字段 `version` → `field.invalid`，做法与 `staff_username_key` 相同，不新增错误码。
8. **`CurrentConsent` 的「今天」**（Task 9）：按柬埔寨时间（固定 UTC+7，柬埔寨不实行夏令时）计算。语言回退顺序为「请求语言 → en → zh」。`purpose` 不是 `COMMUNITY` / `REGISTRATION` 时返回 `VALIDATION_FAILED`，字段为 `purpose`。`appGetConsent` 的 `purpose` 参数枚举只有 `REGISTRATION`。
9. **`werun publish-consent --items` 的 JSON 格式**（Task 9）：一个数组，元素形如 `{"k":"rules","t":"标题","d":"说明"}`（`d` 可省略），与 `disclaimer_versions.items` 列的格式一致；出现未知字段时报错。Task 23 的 `seed-consent.sh` 按这个格式传参。
10. **用户端构建变量 `VITE_TELEGRAM_BOT_USERNAME`**（Task 10）：
    - 类型声明放在 `web/user/src/vite-env.d.ts`；
    - 本地开发取 `web/user/.env.development`（值 `werun_bot`，并在 `.gitignore` 里为这个文件加例外）；
    - `deploy/web.Dockerfile` 用 `ARG`/`ENV` 引入，默认 `werun_bot`；
    - `deploy/compose.yaml` 的 caddy 构建参数取 `${WERUN_TELEGRAM_BOT_USERNAME:-werun_bot}`，CI 的 `.env` 里是 `werun_e2e_bot`，所以端到端镜像会带上它；
    - CI frontend 任务的 `pnpm build` 设为 `werun_e2e_bot`；
    - CI images 任务取 `${{ vars.WERUN_TELEGRAM_BOT_USERNAME || 'werun_bot' }}`。
11. **用户端装配拆分**（Task 10）：
    - 新增 `web/user/src/bootstrap.tsx`，导出 `createUserApp({ router, baseUrl?, retry?, resolveInitData? })`，`main.tsx` 与测试的 `renderApp` 共用；
    - 新增 `web/user/src/auth/controller.ts`，导出 `AuthController`；
    - `AuthProvider.tsx` 导出 `useAuth()`；
    - `renderApp(path, handler, { initData })` 增加第三个参数，Task 14 及以后需要登录的页面测试都用它。
12. **开发登录参数只在开发构建里生效**（Task 10）：`?devInitData=` 与 `werun.devInitData` 两个来源都放在 `import.meta.env.DEV` 分支里。后者本来就只会在 DEV 下写入，所以行为与 overview 一致，生产构建会把整段代码去掉。
13. **`telegram.ts` 两处调整**（Task 10）：`TelegramWebApp` 增加 `initData: string`；`loadTelegramSdk()` 并发调用时复用同一个 `<script>` 元素，不会重复插入。
14. **参赛人表单复用**（Task 10）：
    - `web/user/src/profiles/ProfileFields.tsx` 接受 `testIdPrefix`，生成 `<prefix>-fullName`、`<prefix>-gender` 等 testid，每个字段的错误文案 testid 为 `<prefix>-<field>-error`；
    - `ProfilesPage` 传 `profile`，Task 14 第 2 步传 `participant-<i>`，正好得到 overview 表里的 testid；
    - `showIsSelf` 控制是否显示「这是我本人」勾选框；
    - `web/user/src/profiles/validate.ts` 导出 `validateProfileForm`、`toProfileInput`、`profileToForm`、`emptyProfileForm`，Task 14 复用。
15. **ProfilesPage 的 testid**（不在端到端契约里，仅供组件测试与后续使用）：
    - 页面：`profile-create`、`profile-item-<id>`、`profile-edit-<id>`、`profile-delete-<id>`、`profile-delete-confirm-<id>`、`profile-delete-cancel-<id>`；
    - 表单：`profile-submit`、`profile-cancel`、`form-error`。
16. **同意书用途常量**（Task 9）：`runner.PurposeCommunity = "COMMUNITY"`、`runner.PurposeRegistration = "REGISTRATION"`。Task 12、22 调 `SignConsent` 前用它们判断或拼接，不要手写字符串。

---

### Task 7: Telegram 登录与跑者鉴权

**Files:**
- Create: `api/db/queries/runner.sql`
- Modify: `api/sqlc.yaml`（新增 runner 段）
- Create（生成）: `api/internal/runner/store/`（`db.go`、`models.go`、`runner.sql.go`）
- Create: `api/internal/runner/model.go`
- Create: `api/internal/runner/initdata.go`
- Test: `api/internal/runner/initdata_test.go`
- Create: `api/internal/runner/context.go`
- Create: `api/internal/runner/service.go`
- Test: `api/internal/runner/service_test.go`
- Create: `api/internal/runner/handlers.go`
- Modify: `api/internal/platform/apperr/apperr.go`、`api/internal/platform/apperr/apperr_test.go`
- Modify: `api/internal/platform/i18n/messages.zh.json`、`messages.en.json`、`messages.km.json`
- Modify: `api/internal/httpapi/cmd/permgen/main.go`
- Test: `api/internal/httpapi/cmd/permgen/main_test.go`
- Modify: `api/openapi/openapi.yaml`
- Modify（生成）: `api/internal/httpapi/apigen/api.gen.go`、`api/internal/httpapi/apigen/permissions.gen.go`、`packages/api-client/src/schema.d.ts`
- Modify: `api/internal/httpapi/auth.go`
- Test: `api/internal/httpapi/auth_test.go`
- Modify: `api/internal/httpapi/router.go`、`api/internal/httpapi/server.go`
- Test: `api/internal/httpapi/runner_http_test.go`
- Modify: `api/cmd/werun/app.go`、`api/cmd/werun/router.go`、`api/cmd/werun/main.go`
- Create: `api/cmd/werun/devinitdata.go`
- Test: `api/cmd/werun/devinitdata_test.go`

**Interfaces:**
- Consumes:
  - Task 1：`piicrypt.Cipher`、`piicrypt.New(key []byte) (*Cipher, error)`；`config.Config.TelegramBotToken`；`App.PII *piicrypt.Cipher`
  - 脚手架：`db.InTx(ctx, pool, func(pgx.Tx) error) error`、`audit.Record(ctx, tx, audit.Entry)`、`httpx.Meta`、`httpx.MetaOf(ctx)`、`httpx.Gin(ctx)`、`apperr.New/As/FromPG`、`iam.Service`、`iam.CookieName`、`iam.WithStaff/StaffFrom`、`iam.Allowed`、`dbtest.NewPool`
- Produces（与 overview 一致）:
  ```go
  type User struct {
  	ID               int64
  	TelegramUserID   int64
  	TelegramUsername string
  	DisplayName      string
  	Locale           string // zh | en | km
  }
  type Session struct { Token string; ExpiresAt time.Time; User User }
  type TelegramUser struct { ID int64; FirstName, LastName, Username, LanguageCode string }

  func NewService(pool *pgxpool.Pool, sessionSecret []byte, botToken string, pii *piicrypt.Cipher, now func() time.Time) *Service
  func VerifyInitData(initData, botToken string, now time.Time) (TelegramUser, error) // 失败返回 apperr TELEGRAM_AUTH_INVALID(401)
  func SignInitData(botToken string, u TelegramUser, authDate time.Time) string
  func (s *Service) LoginTelegram(ctx context.Context, initData string, meta httpx.Meta) (Session, error)
  func (s *Service) Authenticate(ctx context.Context, token string) (User, error)
  func (s *Service) Logout(ctx context.Context, token string) error
  func WithUser(c *gin.Context, u User)
  func UserFrom(ctx context.Context) (User, bool)

  // httpapi
  type RunnerAuthenticator interface {
  	Authenticate(ctx context.Context, token string) (runner.User, error)
  }
  func AuthMiddleware(staff *iam.Service, runners RunnerAuthenticator, auths map[string]apigen.OperationAuth, log *slog.Logger) apigen.StrictMiddlewareFunc
  ```
  - 契约补充：`runner.BearerToken(r *http.Request) string`、`runner.SessionTTL`、`runner.Handlers`、`runner.NewHandlers(svc *Service) *Handlers`
  - `apigen.AuthApp`；`httpapi.RunnerHandlers = runner.Handlers`；`httpapi.RouterDeps.Runner *runner.Service`；`main.App.Runner *runner.Service`
  - `apperr.CodeTelegramAuthInvalid = "TELEGRAM_AUTH_INVALID"`（401）；审计 action `runner.login`
  - operationId：`appLoginTelegram`（`POST /app/auth/telegram`，`x-auth: none`）、`appLogout`（`POST /app/auth/logout`，`x-auth: app`）、`appGetMe`（`GET /app/me`，`x-auth: app`）
  - 命令：`werun dev-initdata --telegram-id <id> --name <显示名> [--lang zh|en|km]`

- [ ] **Step 1: 写 permgen 的失败测试**

用下面内容整体替换 `api/internal/httpapi/cmd/permgen/main_test.go`：

```go
package main

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const validSpec = `
openapi: 3.0.3
info: {title: t, version: "1"}
paths:
  /healthz:
    get:
      operationId: getHealthz
      responses: {"200": {description: ok}}
  /admin/auth/login:
    post:
      operationId: adminLogin
      x-auth: none
      responses: {"200": {description: ok}}
  /admin/me:
    get:
      operationId: adminGetMe
      x-auth: session
      responses: {"200": {description: ok}}
  /admin/events:
    post:
      operationId: adminCreateEvent
      x-permission: event_config
      x-access: write
      responses: {"201": {description: ok}}
  /app/auth/telegram:
    post:
      operationId: appLoginTelegram
      x-auth: none
      responses: {"200": {description: ok}}
  /app/me:
    get:
      operationId: appGetMe
      x-auth: app
      responses: {"200": {description: ok}}
`

func TestBuildValidSpec(t *testing.T) {
	rules, err := build([]byte(validSpec))
	require.NoError(t, err)
	assert.Equal(t, map[string]rule{
		"GetHealthz":       {Kind: "AuthNone"},
		"AdminLogin":       {Kind: "AuthNone"},
		"AdminGetMe":       {Kind: "AuthSession"},
		"AdminCreateEvent": {Kind: "AuthPermission", Permission: "event_config", Access: "write"},
		"AppLoginTelegram": {Kind: "AuthNone"},
		"AppGetMe":         {Kind: "AuthApp"},
	}, rules)
}

func specWithOp(path, extensions string) string {
	return `
openapi: 3.0.3
info: {title: t, version: "1"}
paths:
  ` + path + `:
    post:
      operationId: doThing
` + extensions + `
      responses: {"200": {description: ok}}
`
}

func specWithAdminOp(extensions string) string {
	return specWithOp("/admin/things", extensions)
}

func TestBuildRejectsInvalidExtensions(t *testing.T) {
	cases := []struct {
		name       string
		spec       string
		wantSubstr string
	}{
		{"admin op without extensions", specWithAdminOp(""), "后台接口必须声明 x-auth"},
		{"permission without access", specWithAdminOp("      x-permission: event_config"), "缺少 x-access"},
		{"invalid access", specWithAdminOp("      x-permission: event_config\n      x-access: admin"), "x-access 只能是 read 或 write"},
		{"invalid x-auth", specWithAdminOp("      x-auth: maybe"), "x-auth 只能是 none 或 session"},
		{"x-auth with permission", specWithAdminOp("      x-auth: session\n      x-permission: event_config\n      x-access: read"), "不能与 x-permission"},
		{"admin op with x-auth app", specWithAdminOp("      x-auth: app"), "x-auth: app 只能用于 /app/ 下的接口"},
		{"app op without x-auth", specWithOp("/app/things", ""), "跑者接口必须声明 x-auth"},
		{"app op with session", specWithOp("/app/things", "      x-auth: session"), "跑者接口的 x-auth 只能是 none 或 app"},
		{"app op with permission", specWithOp("/app/things", "      x-auth: app\n      x-permission: event_config\n      x-access: read"), "跑者接口不能声明 x-permission / x-access"},
		{"app op with access only", specWithOp("/app/things", "      x-access: read"), "跑者接口不能声明 x-permission / x-access"},
		{"public op with permission", `
openapi: 3.0.3
info: {title: t, version: "1"}
paths:
  /events:
    get:
      operationId: listPublicEvents
      x-permission: event_config
      x-access: read
      responses: {"200": {description: ok}}
`, "公开接口不能声明"},
		{"public op with x-auth app", specWithOp("/files/things", "      x-auth: app"), "公开接口不能声明"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := build([]byte(tc.spec))
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.wantSubstr)
		})
	}
}

func TestBuildReportsOperationID(t *testing.T) {
	_, err := build([]byte(specWithAdminOp("")))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "doThing")
	assert.Contains(t, err.Error(), "POST /admin/things")
}

func TestStrictName(t *testing.T) {
	assert.Equal(t, "AdminLogin", strictName("adminLogin"))
	assert.Equal(t, "GetHealthz", strictName("getHealthz"))
	assert.Equal(t, "AdminPublishEvent", strictName("admin-publish_event"))
	assert.Equal(t, "AppLoginTelegram", strictName("appLoginTelegram"))
}

func TestRenderIsDeterministicAndFormatted(t *testing.T) {
	rules, err := build([]byte(validSpec))
	require.NoError(t, err)

	first, err := render(rules)
	require.NoError(t, err)
	second, err := render(rules)
	require.NoError(t, err)
	assert.Equal(t, string(first), string(second))

	src := string(first)
	assert.True(t, strings.HasPrefix(src, "// Code generated by permgen"))
	assert.Contains(t, src, "package apigen")
	assert.Contains(t, src, `AuthApp        AuthKind = "app"`)
	assert.Contains(t, src, `{Kind: AuthPermission, Permission: "event_config", Access: "write"}`)
	assert.Contains(t, src, `{Kind: AuthSession}`)
	assert.Contains(t, src, `"AppGetMe":         {Kind: AuthApp}`)
	assert.Less(t, strings.Index(src, `"AdminCreateEvent"`), strings.Index(src, `"GetHealthz"`))
}
```

- [ ] **Step 2: 运行 permgen 测试，确认失败**

```bash
cd api && go test ./internal/httpapi/cmd/permgen/
```

Expected：FAIL。`TestBuildValidSpec` 报 `/app/auth/telegram (appLoginTelegram): 公开接口不能声明 x-auth / x-permission / x-access`；带 `app op` 的用例找不到期望文案；`TestRenderIsDeterministicAndFormatted` 找不到 `AuthApp`。

- [ ] **Step 3: 修改 permgen**

`api/internal/httpapi/cmd/permgen/main.go` 需要改四处。

（1）把文件顶部的包注释整体替换为：

```go
// Command permgen 读取 openapi.yaml，生成「接口 → 鉴权规则」映射表 apigen/permissions.gen.go。
//
// 规则：
//   - 路径以 /admin/ 开头的操作必须声明 x-auth（none | session），或同时声明 x-permission 与 x-access（read | write）；x-auth: app 在这里非法；
//   - 路径以 /app/ 开头的操作必须声明 x-auth（none | app），映射为 AuthNone / AuthApp，不得声明 x-permission / x-access；
//   - 其它（公开）操作不得声明这三个扩展字段，映射为 AuthNone；
//   - 映射表的键是 strict 中间件收到的 operationID：oapi-codegen 把 operationId 转成首字母大写的驼峰（adminLogin → AdminLogin）。
```

（2）常量与 `rule` 注释：

旧：

```go
const adminPrefix = "/admin/"

type rule struct {
	Kind       string // Go 常量名：AuthNone / AuthSession / AuthPermission
```

新：

```go
const (
	adminPrefix = "/admin/"
	appPrefix   = "/app/"
)

type rule struct {
	Kind       string // Go 常量名：AuthNone / AuthSession / AuthPermission / AuthApp
```

（3）用下面的函数整体替换 `ruleFor`：

```go
func ruleFor(path string, ext map[string]any) (rule, error) {
	auth, hasAuth, errAuth := stringExt(ext, "x-auth")
	perm, hasPerm, errPerm := stringExt(ext, "x-permission")
	access, hasAccess, errAccess := stringExt(ext, "x-access")
	if err := errors.Join(errAuth, errPerm, errAccess); err != nil {
		return rule{}, err
	}

	if strings.HasPrefix(path, appPrefix) {
		if hasPerm || hasAccess {
			return rule{}, errors.New("跑者接口不能声明 x-permission / x-access")
		}
		if !hasAuth {
			return rule{}, errors.New("跑者接口必须声明 x-auth（none 或 app）")
		}
		switch auth {
		case "none":
			return rule{Kind: "AuthNone"}, nil
		case "app":
			return rule{Kind: "AuthApp"}, nil
		default:
			return rule{}, fmt.Errorf("跑者接口的 x-auth 只能是 none 或 app，实际为 %q", auth)
		}
	}

	if !strings.HasPrefix(path, adminPrefix) {
		if hasAuth || hasPerm || hasAccess {
			return rule{}, errors.New("公开接口不能声明 x-auth / x-permission / x-access")
		}
		return rule{Kind: "AuthNone"}, nil
	}

	switch {
	case hasAuth && (hasPerm || hasAccess):
		return rule{}, errors.New("x-auth 不能与 x-permission / x-access 同时声明")
	case hasAuth:
		switch auth {
		case "none":
			return rule{Kind: "AuthNone"}, nil
		case "session":
			return rule{Kind: "AuthSession"}, nil
		case "app":
			return rule{}, errors.New("x-auth: app 只能用于 /app/ 下的接口")
		default:
			return rule{}, fmt.Errorf("x-auth 只能是 none 或 session，实际为 %q", auth)
		}
	case hasPerm:
		if perm == "" {
			return rule{}, errors.New("x-permission 不能为空")
		}
		if !hasAccess {
			return rule{}, errors.New("声明了 x-permission 但缺少 x-access")
		}
		if access != "read" && access != "write" {
			return rule{}, fmt.Errorf("x-access 只能是 read 或 write，实际为 %q", access)
		}
		return rule{Kind: "AuthPermission", Permission: perm, Access: access}, nil
	default:
		return rule{}, errors.New("后台接口必须声明 x-auth，或同时声明 x-permission 与 x-access")
	}
}
```

（4）模板里的常量块：

旧：

```go
const (
	AuthNone       AuthKind = "none"
	AuthSession    AuthKind = "session"
	AuthPermission AuthKind = "permission"
)
```

新：

```go
const (
	AuthNone       AuthKind = "none"
	AuthSession    AuthKind = "session"
	AuthPermission AuthKind = "permission"
	AuthApp        AuthKind = "app"
)
```

- [ ] **Step 4: 运行 permgen 测试，确认通过**

```bash
cd api && go test ./internal/httpapi/cmd/permgen/
```

Expected：`ok  werun/api/internal/httpapi/cmd/permgen`。

- [ ] **Step 5: 新增错误码 TELEGRAM_AUTH_INVALID（先改测试）**

在 `api/internal/platform/apperr/apperr_test.go` 的 `TestAllCodesAreUnique` 中，把 `assert.Len(t, apperr.AllCodes, N)` 的 N 加 1。Task 1–6 完成后 N 为 21，这里改为：

```go
	assert.Len(t, apperr.AllCodes, 22)
```

运行：

```bash
cd api && go test ./internal/platform/apperr/
```

Expected：FAIL，`"[...]" should have 22 item(s), but has 21`。

在 `api/internal/platform/apperr/apperr.go` 的错误码常量块末尾追加：

```go
	CodeTelegramAuthInvalid = "TELEGRAM_AUTH_INVALID"
```

在 `AllCodes` 末尾追加：

```go
	CodeTelegramAuthInvalid,
```

三份文案文件各在 `"field.required"` 之前加一行（保持错误码在前、字段文案在后的顺序）：

`api/internal/platform/i18n/messages.zh.json`：

```json
  "TELEGRAM_AUTH_INVALID": "无法确认你的 Telegram 登录，请关闭后在 Telegram 中重新打开小程序。",
```

`api/internal/platform/i18n/messages.en.json`：

```json
  "TELEGRAM_AUTH_INVALID": "We couldn't verify your Telegram sign-in. Close the mini app and open it again in Telegram.",
```

`api/internal/platform/i18n/messages.km.json`：

```json
  "TELEGRAM_AUTH_INVALID": "មិនអាចផ្ទៀងផ្ទាត់ការចូលពី Telegram បានទេ។ សូមបិទ ហើយបើកកម្មវិធីខ្នាតតូចឡើងវិញក្នុង Telegram។",
```

运行：

```bash
cd api && go test ./internal/platform/apperr/ ./internal/platform/i18n/
```

Expected：两个包都 `ok`（`TestEmbeddedCatalogCoversAllCodesAndFieldKeys` 会检查新错误码的三语文案）。

- [ ] **Step 6: 写 initData 验签的失败测试**

创建 `api/internal/runner/initdata_test.go`：

```go
package runner_test

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/runner"
)

const initBotToken = "123456:initdata-test-token"

var initNow = time.Date(2026, 9, 14, 3, 0, 0, 0, time.UTC)

func sampleTelegramUser() runner.TelegramUser {
	return runner.TelegramUser{ID: 10001, FirstName: "Dara", LastName: "Sok", Username: "darasok", LanguageCode: "km"}
}

func requireTelegramAuthInvalid(t *testing.T, err error) {
	t.Helper()
	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	assert.Equal(t, apperr.CodeTelegramAuthInvalid, ae.Code)
	assert.Equal(t, http.StatusUnauthorized, ae.Status)
}

// referenceHash 按 Telegram 文档独立实现一遍签名算法，避免 SignInitData 与 VerifyInitData 同时写错却互相通过。
func referenceHash(botToken string, values url.Values) string {
	keys := make([]string, 0, len(values))
	for k := range values {
		if k != "hash" {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	lines := make([]string, 0, len(keys))
	for _, k := range keys {
		lines = append(lines, k+"="+values.Get(k))
	}
	secret := hmac.New(sha256.New, []byte("WebAppData"))
	_, _ = secret.Write([]byte(botToken))
	mac := hmac.New(sha256.New, secret.Sum(nil))
	_, _ = mac.Write([]byte(strings.Join(lines, "\n")))
	return hex.EncodeToString(mac.Sum(nil))
}

func signedValues(t *testing.T, authDate time.Time) url.Values {
	t.Helper()
	values, err := url.ParseQuery(runner.SignInitData(initBotToken, sampleTelegramUser(), authDate))
	require.NoError(t, err)
	return values
}

func TestVerifyInitDataAcceptsDataSignedByTelegramAlgorithm(t *testing.T) {
	values := url.Values{}
	values.Set("query_id", "AAHdF6IQAAAAAN0XohDhrOrc")
	values.Set("user", `{"id":10002,"first_name":"សុខា","last_name":"Chan","username":"sokha_c","language_code":"zh-hans","allows_write_to_pm":true}`)
	values.Set("auth_date", strconv.FormatInt(initNow.Add(-time.Hour).Unix(), 10))
	values.Set("signature", "ZmFrZS1zaWduYXR1cmU")
	values.Set("hash", referenceHash(initBotToken, values))

	got, err := runner.VerifyInitData(values.Encode(), initBotToken, initNow)

	require.NoError(t, err)
	assert.Equal(t, runner.TelegramUser{ID: 10002, FirstName: "សុខា", LastName: "Chan", Username: "sokha_c", LanguageCode: "zh-hans"}, got)
}

func TestSignInitDataRoundTrip(t *testing.T) {
	initData := runner.SignInitData(initBotToken, sampleTelegramUser(), initNow.Add(-time.Minute))

	values, err := url.ParseQuery(initData)
	require.NoError(t, err)
	assert.ElementsMatch(t, []string{"auth_date", "user", "hash"}, keysOf(values))
	assert.Equal(t, referenceHash(initBotToken, values), values.Get("hash"))

	got, err := runner.VerifyInitData(initData, initBotToken, initNow)
	require.NoError(t, err)
	assert.Equal(t, sampleTelegramUser(), got)
}

func keysOf(values url.Values) []string {
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	return keys
}

func TestVerifyInitDataRejectsTamperedFields(t *testing.T) {
	cases := map[string]func(url.Values){
		"user changed":      func(v url.Values) { v.Set("user", strings.Replace(v.Get("user"), "10001", "10009", 1)) },
		"auth_date changed": func(v url.Values) { v.Set("auth_date", strconv.FormatInt(initNow.Unix(), 10)) },
		"field added":       func(v url.Values) { v.Set("query_id", "AAH-injected") },
		"field removed":     func(v url.Values) { v.Del("user") },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			values := signedValues(t, initNow.Add(-time.Minute))
			mutate(values)

			_, err := runner.VerifyInitData(values.Encode(), initBotToken, initNow)

			requireTelegramAuthInvalid(t, err)
		})
	}
}

func TestVerifyInitDataRejectsExpiredAuthDate(t *testing.T) {
	exactly24h := runner.SignInitData(initBotToken, sampleTelegramUser(), initNow.Add(-24*time.Hour))
	_, err := runner.VerifyInitData(exactly24h, initBotToken, initNow)
	require.NoError(t, err, "距今正好 24 小时仍然有效")

	expired := runner.SignInitData(initBotToken, sampleTelegramUser(), initNow.Add(-24*time.Hour-time.Second))
	_, err = runner.VerifyInitData(expired, initBotToken, initNow)
	requireTelegramAuthInvalid(t, err)
}

func TestVerifyInitDataRejectsMissingOrMalformedHash(t *testing.T) {
	cases := map[string]func(url.Values){
		"missing hash":   func(v url.Values) { v.Del("hash") },
		"empty hash":     func(v url.Values) { v.Set("hash", "") },
		"non hex hash":   func(v url.Values) { v.Set("hash", "zz"+v.Get("hash")[2:]) },
		"duplicate hash": func(v url.Values) { v.Add("hash", v.Get("hash")) },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			values := signedValues(t, initNow.Add(-time.Minute))
			mutate(values)

			_, err := runner.VerifyInitData(values.Encode(), initBotToken, initNow)

			requireTelegramAuthInvalid(t, err)
		})
	}

	for _, raw := range []string{"", "%zz", "not-a-query"} {
		_, err := runner.VerifyInitData(raw, initBotToken, initNow)
		requireTelegramAuthInvalid(t, err)
	}
}

func TestVerifyInitDataRejectsWrongBotToken(t *testing.T) {
	initData := runner.SignInitData("654321:other-bot-token", sampleTelegramUser(), initNow.Add(-time.Minute))

	_, err := runner.VerifyInitData(initData, initBotToken, initNow)
	requireTelegramAuthInvalid(t, err)

	_, err = runner.VerifyInitData(runner.SignInitData("", sampleTelegramUser(), initNow), "", initNow)
	requireTelegramAuthInvalid(t, err)
}

func TestVerifyInitDataRejectsInvalidUser(t *testing.T) {
	for name, user := range map[string]string{
		"not json":    `{"id":`,
		"missing id":  `{"first_name":"Dara"}`,
		"zero id":     `{"id":0,"first_name":"Dara"}`,
		"string id":   `{"id":"10001","first_name":"Dara"}`,
		"json array":  `[10001]`,
	} {
		t.Run(name, func(t *testing.T) {
			values := url.Values{}
			values.Set("user", user)
			values.Set("auth_date", strconv.FormatInt(initNow.Unix(), 10))
			values.Set("hash", referenceHash(initBotToken, values))

			_, err := runner.VerifyInitData(values.Encode(), initBotToken, initNow)

			requireTelegramAuthInvalid(t, err)
		})
	}
}
```

- [ ] **Step 7: 运行 initData 测试，确认失败**

```bash
cd api && go test ./internal/runner/
```

Expected：FAIL，编译错误 `no non-test Go files in .../internal/runner` 或 `undefined: runner.SignInitData`。

- [ ] **Step 8: 实现模型与 initData 验签**

创建 `api/internal/runner/model.go`：

```go
// Package runner 是跑者模块：Telegram 登录与会话、常用参赛人、报名同意书。
package runner

import "time"

// User 是已登录的跑者。
type User struct {
	ID               int64
	TelegramUserID   int64
	TelegramUsername string
	DisplayName      string
	Locale           string // zh | en | km
}

// Session 是登录成功后返回给小程序的令牌。
type Session struct {
	Token     string
	ExpiresAt time.Time
	User      User
}

// TelegramUser 是 initData 里 user 字段中本系统使用的部分。
type TelegramUser struct {
	ID                                          int64
	FirstName, LastName, Username, LanguageCode string
}
```

创建 `api/internal/runner/initdata.go`：

```go
package runner

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"werun/api/internal/platform/apperr"
)

// initDataMaxAge：auth_date 距今超过这个时长即视为过期（Global Constraints）。
const initDataMaxAge = 24 * time.Hour

type telegramUserJSON struct {
	ID           int64  `json:"id"`
	FirstName    string `json:"first_name"`
	LastName     string `json:"last_name,omitempty"`
	Username     string `json:"username,omitempty"`
	LanguageCode string `json:"language_code,omitempty"`
}

// VerifyInitData 按 Telegram Mini App 规则校验 initData：
// secret = HMAC_SHA256(key="WebAppData", msg=botToken)；
// hash = hex(HMAC_SHA256(key=secret, msg=data_check_string))；
// data_check_string 为除 hash 外所有字段按键名排序后以 \n 连接的 key=value（值为 URL 解码后的原文）。
func VerifyInitData(initData, botToken string, now time.Time) (TelegramUser, error) {
	if botToken == "" {
		return TelegramUser{}, telegramAuthInvalid("bot token is empty")
	}
	values, err := url.ParseQuery(initData)
	if err != nil {
		return TelegramUser{}, telegramAuthInvalid("parse init data: %v", err)
	}
	for key, v := range values {
		if len(v) != 1 {
			return TelegramUser{}, telegramAuthInvalid("field %q appears %d times", key, len(v))
		}
	}
	gotHex := values.Get("hash")
	if gotHex == "" {
		return TelegramUser{}, telegramAuthInvalid("missing hash")
	}
	got, err := hex.DecodeString(gotHex)
	if err != nil {
		return TelegramUser{}, telegramAuthInvalid("hash is not hex: %v", err)
	}
	if !hmac.Equal(got, initDataHash(botToken, dataCheckString(values))) {
		return TelegramUser{}, telegramAuthInvalid("hash mismatch")
	}

	authUnix, err := strconv.ParseInt(values.Get("auth_date"), 10, 64)
	if err != nil {
		return TelegramUser{}, telegramAuthInvalid("invalid auth_date %q", values.Get("auth_date"))
	}
	if now.Sub(time.Unix(authUnix, 0)) > initDataMaxAge {
		return TelegramUser{}, telegramAuthInvalid("auth_date %d expired", authUnix)
	}

	var u telegramUserJSON
	if err := json.Unmarshal([]byte(values.Get("user")), &u); err != nil {
		return TelegramUser{}, telegramAuthInvalid("decode user: %v", err)
	}
	if u.ID <= 0 {
		return TelegramUser{}, telegramAuthInvalid("user id missing")
	}
	return TelegramUser{
		ID:           u.ID,
		FirstName:    u.FirstName,
		LastName:     u.LastName,
		Username:     u.Username,
		LanguageCode: u.LanguageCode,
	}, nil
}

// SignInitData 生成含 auth_date、user、hash 的 initData 查询串。只用于 dev-initdata 与测试。
func SignInitData(botToken string, u TelegramUser, authDate time.Time) string {
	// 字段都是字符串和整数，json.Marshal 不会失败
	userJSON, _ := json.Marshal(telegramUserJSON{
		ID:           u.ID,
		FirstName:    u.FirstName,
		LastName:     u.LastName,
		Username:     u.Username,
		LanguageCode: u.LanguageCode,
	})
	values := url.Values{}
	values.Set("auth_date", strconv.FormatInt(authDate.Unix(), 10))
	values.Set("user", string(userJSON))
	values.Set("hash", hex.EncodeToString(initDataHash(botToken, dataCheckString(values))))
	return values.Encode()
}

func dataCheckString(values url.Values) string {
	keys := make([]string, 0, len(values))
	for key := range values {
		if key != "hash" {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	lines := make([]string, len(keys))
	for i, key := range keys {
		lines[i] = key + "=" + values.Get(key)
	}
	return strings.Join(lines, "\n")
}

func initDataHash(botToken, checkString string) []byte {
	secret := hmac.New(sha256.New, []byte("WebAppData"))
	_, _ = secret.Write([]byte(botToken))
	mac := hmac.New(sha256.New, secret.Sum(nil))
	_, _ = mac.Write([]byte(checkString))
	return mac.Sum(nil)
}

// telegramAuthInvalid 返回 401 TELEGRAM_AUTH_INVALID；具体原因只进日志，不返回给前端。
func telegramAuthInvalid(format string, args ...any) *apperr.Error {
	return apperr.New(http.StatusUnauthorized, apperr.CodeTelegramAuthInvalid).
		Wrap(fmt.Errorf("runner: init data invalid: "+format, args...))
}
```

- [ ] **Step 9: 运行 initData 测试，确认通过**

```bash
cd api && go test -run 'InitData' ./internal/runner/
```

Expected：`ok  werun/api/internal/runner`。

- [ ] **Step 10: 写跑者查询并生成 sqlc 代码**

创建 `api/db/queries/runner.sql`：

```sql
-- name: UpsertTelegramUser :one
-- 首次登录创建跑者；再次登录只更新用户名、显示名与最近登录时间，不覆盖 locale。
INSERT INTO users (telegram_user_id, telegram_username, display_name, locale, last_login_at)
VALUES (@telegram_user_id::bigint, @telegram_username, @display_name, @locale, @last_login_at::timestamptz)
ON CONFLICT (telegram_user_id) DO UPDATE
SET telegram_username = EXCLUDED.telegram_username,
    display_name      = EXCLUDED.display_name,
    last_login_at     = EXCLUDED.last_login_at
RETURNING id, telegram_user_id, telegram_username, display_name, locale, status;

-- name: InsertUserSession :exec
INSERT INTO sessions (subject_type, subject_id, token_hash, expires_at, ip, user_agent, created_at)
VALUES ('USER', @user_id, @token_hash, @expires_at, @ip, @user_agent, @created_at);

-- name: GetUserSession :one
SELECT s.expires_at,
       s.revoked_at,
       u.id AS user_id,
       u.telegram_user_id,
       u.telegram_username,
       u.display_name,
       u.locale,
       u.status
FROM sessions s
JOIN users u ON u.id = s.subject_id
WHERE s.subject_type = 'USER'
  AND s.token_hash = @token_hash;

-- name: RevokeUserSession :exec
UPDATE sessions SET revoked_at = @revoked_at::timestamptz
WHERE subject_type = 'USER' AND token_hash = @token_hash AND revoked_at IS NULL;
```

在 `api/sqlc.yaml` 的 `sql:` 列表末尾追加（与 iam、event 段完全相同，只改 `queries` 与 `out`）：

```yaml
  - engine: postgresql
    schema: db/migrations
    queries: db/queries/runner.sql
    gen:
      go:
        package: store
        out: internal/runner/store
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

运行：

```bash
cd api && go tool sqlc generate && ls internal/runner/store
```

Expected：输出 `db.go  models.go  runner.sql.go`；`runner.sql.go` 中有 `UpsertTelegramUserParams{TelegramUserID int64; TelegramUsername *string; DisplayName *string; Locale string; LastLoginAt time.Time}`、`GetUserSessionRow{ExpiresAt time.Time; RevokedAt *time.Time; UserID int64; TelegramUserID *int64; TelegramUsername *string; DisplayName *string; Locale string; Status string}`。

- [ ] **Step 11: 写登录、认证、退出的数据库失败测试**

创建 `api/internal/runner/service_test.go`：

```go
package runner_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/piicrypt"
	"werun/api/internal/runner"
)

const testBotToken = "123456:runner-test-token"

var (
	testSessionSecret = []byte(strings.Repeat("s", 32))
	baseNow           = time.Date(2026, 9, 14, 3, 0, 0, 0, time.UTC)
	testMeta          = httpx.Meta{RequestID: "req-runner", IP: "203.0.113.7", UserAgent: "runner-test"}
)

type testClock struct{ t time.Time }

func (c *testClock) Now() time.Time { return c.t }

type fixture struct {
	pool  *pgxpool.Pool
	svc   *runner.Service
	clock *testClock
	pii   *piicrypt.Cipher
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	pool := dbtest.NewPool(t)
	pii, err := piicrypt.New([]byte(strings.Repeat("p", 32)))
	require.NoError(t, err)
	clock := &testClock{t: baseNow}
	return fixture{
		pool:  pool,
		svc:   runner.NewService(pool, testSessionSecret, testBotToken, pii, clock.Now),
		clock: clock,
		pii:   pii,
	}
}

func (f fixture) login(t *testing.T, tg runner.TelegramUser) runner.Session {
	t.Helper()
	initData := runner.SignInitData(testBotToken, tg, f.clock.t.Add(-time.Minute))
	sess, err := f.svc.LoginTelegram(context.Background(), initData, testMeta)
	require.NoError(t, err)
	return sess
}

func countRows(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	require.NoError(t, pool.QueryRow(context.Background(), sql, args...).Scan(&n))
	return n
}

func requireAppError(t *testing.T, err error, status int, code string) *apperr.Error {
	t.Helper()
	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	require.Equal(t, code, ae.Code)
	require.Equal(t, status, ae.Status)
	return ae
}

func fieldKeys(t *testing.T, err error) map[string]string {
	t.Helper()
	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	keys := map[string]string{}
	for name, fe := range ae.Fields {
		keys[name] = fe.Key
	}
	return keys
}

func TestLoginTelegramCreatesUserSessionAndAudit(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()

	sess := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara", LastName: "Sok", Username: "darasok", LanguageCode: "zh-hans"})

	assert.Len(t, sess.Token, 43, "32 字节 Base64 URL 无填充")
	assert.True(t, sess.ExpiresAt.Equal(baseNow.Add(runner.SessionTTL)))
	assert.NotZero(t, sess.User.ID)
	assert.Equal(t, int64(10001), sess.User.TelegramUserID)
	assert.Equal(t, "darasok", sess.User.TelegramUsername)
	assert.Equal(t, "Dara Sok", sess.User.DisplayName)
	assert.Equal(t, "zh", sess.User.Locale)

	var locale string
	var lastLogin time.Time
	require.NoError(t, f.pool.QueryRow(ctx,
		`SELECT locale, last_login_at FROM users WHERE id = $1`, sess.User.ID).Scan(&locale, &lastLogin))
	assert.Equal(t, "zh", locale)
	assert.True(t, lastLogin.Equal(baseNow))
	assert.Equal(t, 1, countRows(t, f.pool,
		`SELECT count(*) FROM sessions
		 WHERE subject_type = 'USER' AND subject_id = $1 AND expires_at = $2
		   AND host(ip) = '203.0.113.7' AND user_agent = 'runner-test' AND revoked_at IS NULL`,
		sess.User.ID, baseNow.Add(24*time.Hour)))
	assert.Equal(t, 0, countRows(t, f.pool,
		`SELECT count(*) FROM sessions WHERE token_hash = convert_to($1, 'UTF8')`, sess.Token),
		"数据库里只存令牌的 HMAC")
	assert.Equal(t, 1, countRows(t, f.pool,
		`SELECT count(*) FROM audit_logs
		 WHERE action = 'runner.login' AND actor_type = 'USER' AND actor_id = $1
		   AND entity_type = 'user' AND entity_id = $1 AND NOT is_financial AND request_id = 'req-runner'`,
		sess.User.ID))
}

func TestLoginTelegramUpdatesExistingUserButKeepsLocale(t *testing.T) {
	f := newFixture(t)

	first := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara", Username: "darasok", LanguageCode: "km"})
	f.clock.t = baseNow.Add(time.Hour)
	second := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara", LastName: "Sok", Username: "dara_new", LanguageCode: "en"})

	assert.Equal(t, first.User.ID, second.User.ID)
	assert.Equal(t, "km", second.User.Locale, "只有首次创建时写 locale")
	assert.Equal(t, "dara_new", second.User.TelegramUsername)
	assert.Equal(t, "Dara Sok", second.User.DisplayName)
	assert.NotEqual(t, first.Token, second.Token)
	assert.Equal(t, 1, countRows(t, f.pool, `SELECT count(*) FROM users WHERE telegram_user_id = 10001`))
	assert.Equal(t, 2, countRows(t, f.pool, `SELECT count(*) FROM sessions WHERE subject_type = 'USER' AND subject_id = $1`, first.User.ID))
	assert.Equal(t, 1, countRows(t, f.pool,
		`SELECT count(*) FROM users WHERE id = $1 AND last_login_at = $2`, first.User.ID, baseNow.Add(time.Hour)))
}

func TestLoginTelegramLocaleMapping(t *testing.T) {
	f := newFixture(t)
	cases := []struct {
		languageCode string
		want         string
	}{
		{"zh", "zh"},
		{"zh-hans", "zh"},
		{"zh-TW", "zh"},
		{"km", "km"},
		{"en", "en"},
		{"ru", "en"},
		{"", "en"},
	}
	for i, tc := range cases {
		sess := f.login(t, runner.TelegramUser{ID: int64(20001 + i), FirstName: "Runner", LanguageCode: tc.languageCode})
		assert.Equal(t, tc.want, sess.User.Locale, "language_code=%q", tc.languageCode)
	}
}

func TestLoginTelegramDisplayNameFallsBackToUsername(t *testing.T) {
	f := newFixture(t)

	sess := f.login(t, runner.TelegramUser{ID: 30001, Username: "only_username"})

	assert.Equal(t, "only_username", sess.User.DisplayName)
}

func TestLoginTelegramRejectsInvalidInitData(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()

	_, err := f.svc.LoginTelegram(ctx, "user=%7B%22id%22%3A1%7D&auth_date=1&hash=00", testMeta)
	requireAppError(t, err, http.StatusUnauthorized, apperr.CodeTelegramAuthInvalid)

	otherBot := runner.SignInitData("999:other", runner.TelegramUser{ID: 10001, FirstName: "Dara"}, baseNow)
	_, err = f.svc.LoginTelegram(ctx, otherBot, testMeta)
	requireAppError(t, err, http.StatusUnauthorized, apperr.CodeTelegramAuthInvalid)

	expired := runner.SignInitData(testBotToken, runner.TelegramUser{ID: 10001, FirstName: "Dara"}, baseNow.Add(-25*time.Hour))
	_, err = f.svc.LoginTelegram(ctx, expired, testMeta)
	requireAppError(t, err, http.StatusUnauthorized, apperr.CodeTelegramAuthInvalid)

	assert.Equal(t, 0, countRows(t, f.pool, `SELECT count(*) FROM users`))
	assert.Equal(t, 0, countRows(t, f.pool, `SELECT count(*) FROM sessions`))
}

func TestLoginTelegramRejectsDisabledUser(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	sess := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"})
	_, err := f.pool.Exec(ctx, `UPDATE users SET status = 'DISABLED' WHERE id = $1`, sess.User.ID)
	require.NoError(t, err)

	initData := runner.SignInitData(testBotToken, runner.TelegramUser{ID: 10001, FirstName: "Dara"}, baseNow)
	_, err = f.svc.LoginTelegram(ctx, initData, testMeta)

	requireAppError(t, err, http.StatusForbidden, apperr.CodeForbidden)
	assert.Equal(t, 1, countRows(t, f.pool, `SELECT count(*) FROM sessions WHERE subject_type = 'USER'`))
	assert.Equal(t, 1, countRows(t, f.pool, `SELECT count(*) FROM audit_logs WHERE action = 'runner.login'`))
}

func TestAuthenticateChecksExpiryRevocationAndStatus(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	sess := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara", LanguageCode: "km"})

	got, err := f.svc.Authenticate(ctx, sess.Token)
	require.NoError(t, err)
	assert.Equal(t, sess.User, got)

	f.clock.t = baseNow.Add(runner.SessionTTL - time.Second)
	_, err = f.svc.Authenticate(ctx, sess.Token)
	require.NoError(t, err, "到期前 1 秒仍有效，且不续期")

	f.clock.t = baseNow.Add(runner.SessionTTL)
	_, err = f.svc.Authenticate(ctx, sess.Token)
	requireAppError(t, err, http.StatusUnauthorized, apperr.CodeUnauthenticated)
	assert.Equal(t, 1, countRows(t, f.pool,
		`SELECT count(*) FROM sessions WHERE subject_id = $1 AND expires_at = $2`, sess.User.ID, baseNow.Add(runner.SessionTTL)),
		"Authenticate 不修改 expires_at")

	f.clock.t = baseNow
	for _, bad := range []string{"", "not-base64!", "c2hvcnQ", strings.Repeat("A", 43)} {
		_, err = f.svc.Authenticate(ctx, bad)
		requireAppError(t, err, http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}

	_, err = f.pool.Exec(ctx, `UPDATE users SET status = 'DISABLED' WHERE id = $1`, sess.User.ID)
	require.NoError(t, err)
	_, err = f.svc.Authenticate(ctx, sess.Token)
	requireAppError(t, err, http.StatusUnauthorized, apperr.CodeUnauthenticated)
}

func TestAuthenticateIgnoresStaffSessions(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	sess := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"})
	_, err := f.pool.Exec(ctx, `UPDATE sessions SET subject_type = 'STAFF' WHERE subject_id = $1`, sess.User.ID)
	require.NoError(t, err)

	_, err = f.svc.Authenticate(ctx, sess.Token)

	requireAppError(t, err, http.StatusUnauthorized, apperr.CodeUnauthenticated)
}

func TestLogoutRevokesOnlyThatSession(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	first := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"})
	second := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"})

	require.NoError(t, f.svc.Logout(ctx, first.Token))

	_, err := f.svc.Authenticate(ctx, first.Token)
	requireAppError(t, err, http.StatusUnauthorized, apperr.CodeUnauthenticated)
	_, err = f.svc.Authenticate(ctx, second.Token)
	require.NoError(t, err)
	assert.Equal(t, 1, countRows(t, f.pool,
		`SELECT count(*) FROM sessions WHERE subject_type = 'USER' AND revoked_at = $1`, baseNow))

	require.NoError(t, f.svc.Logout(ctx, "not-a-token"))
	require.NoError(t, f.svc.Logout(ctx, first.Token), "重复退出不报错")
}
```

- [ ] **Step 12: 运行数据库测试，确认失败**

```bash
cd api && env $COLIMA_ENV go test ./internal/runner/
```

Expected：FAIL，编译错误 `undefined: runner.NewService`、`undefined: runner.SessionTTL`。

- [ ] **Step 13: 实现会话服务与请求上下文**

创建 `api/internal/runner/context.go`：

```go
package runner

import (
	"context"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// userContextKey 是 gin 上下文键；gin.Context.Value 对字符串键会查 c.Get。
const userContextKey = "werun.runner"

// WithUser 由认证中间件调用，把当前跑者放进请求上下文。
func WithUser(c *gin.Context, u User) {
	c.Set(userContextKey, u)
}

// UserFrom 取出当前跑者；ctx 为 *gin.Context 或其派生。
func UserFrom(ctx context.Context) (User, bool) {
	if ctx == nil {
		return User{}, false
	}
	u, ok := ctx.Value(userContextKey).(User)
	return u, ok
}

// BearerToken 读取 Authorization: Bearer <token>，scheme 大小写不敏感；取不到时返回空串。
func BearerToken(r *http.Request) string {
	if r == nil {
		return ""
	}
	scheme, token, ok := strings.Cut(r.Header.Get("Authorization"), " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return ""
	}
	return strings.TrimSpace(token)
}
```

创建 `api/internal/runner/service.go`：

```go
package runner

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"werun/api/internal/audit"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/piicrypt"
	"werun/api/internal/runner/store"
)

const (
	// SessionTTL 是跑者令牌的固定有效期，不续期。
	SessionTTL = 24 * time.Hour

	tokenBytes   = 32
	statusActive = "ACTIVE"
)

// Service 负责跑者登录与会话、常用参赛人、同意书。
type Service struct {
	pool     *pgxpool.Pool
	q        *store.Queries
	secret   []byte
	botToken string
	pii      *piicrypt.Cipher
	now      func() time.Time
}

// NewService：sessionSecret 与员工会话共用 WERUN_SESSION_SECRET；now 在测试中注入。
func NewService(pool *pgxpool.Pool, sessionSecret []byte, botToken string, pii *piicrypt.Cipher, now func() time.Time) *Service {
	return &Service{
		pool:     pool,
		q:        store.New(pool),
		secret:   sessionSecret,
		botToken: botToken,
		pii:      pii,
		now:      now,
	}
}

// LoginTelegram 校验 initData，按 telegram_user_id 创建或更新跑者，建 24 小时会话并写审计 runner.login。
func (s *Service) LoginTelegram(ctx context.Context, initData string, meta httpx.Meta) (Session, error) {
	now := s.now()
	tg, err := VerifyInitData(initData, s.botToken, now)
	if err != nil {
		return Session{}, err
	}
	raw := make([]byte, tokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return Session{}, fmt.Errorf("runner: generate session token: %w", err)
	}
	expiresAt := now.Add(SessionTTL)

	var user User
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		row, err := q.UpsertTelegramUser(ctx, store.UpsertTelegramUserParams{
			TelegramUserID:   tg.ID,
			TelegramUsername: optionalString(tg.Username),
			DisplayName:      optionalString(displayName(tg)),
			Locale:           localeFor(tg.LanguageCode),
			LastLoginAt:      now,
		})
		if err != nil {
			return fmt.Errorf("runner: upsert telegram user %d: %w", tg.ID, err)
		}
		if row.Status != statusActive {
			return apperr.New(http.StatusForbidden, apperr.CodeForbidden).
				Wrap(fmt.Errorf("runner: user %d is %s", row.ID, row.Status))
		}
		user = userFromColumns(row.ID, row.TelegramUserID, row.TelegramUsername, row.DisplayName, row.Locale)

		if err := q.InsertUserSession(ctx, store.InsertUserSessionParams{
			UserID:    user.ID,
			TokenHash: s.hashToken(raw),
			ExpiresAt: expiresAt,
			Ip:        parseIP(meta.IP),
			UserAgent: optionalString(meta.UserAgent),
			CreatedAt: now,
		}); err != nil {
			return fmt.Errorf("runner: insert session for user %d: %w", user.ID, err)
		}
		actorID := user.ID
		return audit.Record(ctx, tx, audit.Entry{
			ActorType:  "USER",
			ActorID:    &actorID,
			Action:     "runner.login",
			EntityType: "user",
			EntityID:   user.ID,
			Summary:    fmt.Sprintf("跑者 %s（Telegram %d）登录", user.DisplayName, user.TelegramUserID),
			Meta:       meta,
		})
	})
	if err != nil {
		return Session{}, err
	}
	return Session{
		Token:     base64.RawURLEncoding.EncodeToString(raw),
		ExpiresAt: expiresAt,
		User:      user,
	}, nil
}

// Authenticate 校验跑者令牌：会话属于 USER、未吊销、未过期，且跑者为 ACTIVE。不续期。
func (s *Service) Authenticate(ctx context.Context, token string) (User, error) {
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) != tokenBytes {
		return User{}, unauthenticated()
	}
	row, err := s.q.GetUserSession(ctx, s.hashToken(raw))
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, unauthenticated()
	}
	if err != nil {
		return User{}, fmt.Errorf("runner: load session: %w", err)
	}
	if row.RevokedAt != nil || !s.now().Before(row.ExpiresAt) || row.Status != statusActive {
		return User{}, unauthenticated()
	}
	return userFromColumns(row.UserID, row.TelegramUserID, row.TelegramUsername, row.DisplayName, row.Locale), nil
}

// Logout 吊销令牌对应的跑者会话；令牌格式不对时什么也不做。
func (s *Service) Logout(ctx context.Context, token string) error {
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) != tokenBytes {
		return nil
	}
	if err := s.q.RevokeUserSession(ctx, store.RevokeUserSessionParams{
		RevokedAt: s.now(),
		TokenHash: s.hashToken(raw),
	}); err != nil {
		return fmt.Errorf("runner: revoke session: %w", err)
	}
	return nil
}

// hashToken 与员工会话使用同一算法：HMAC-SHA256(WERUN_SESSION_SECRET, 原始令牌字节)。
func (s *Service) hashToken(raw []byte) []byte {
	mac := hmac.New(sha256.New, s.secret)
	_, _ = mac.Write(raw)
	return mac.Sum(nil)
}

// localeFor：language_code 以 zh 开头 → zh；等于 km → km；其余 → en。
func localeFor(languageCode string) string {
	code := strings.ToLower(strings.TrimSpace(languageCode))
	switch {
	case strings.HasPrefix(code, "zh"):
		return "zh"
	case code == "km":
		return "km"
	default:
		return "en"
	}
}

func displayName(u TelegramUser) string {
	name := strings.TrimSpace(strings.TrimSpace(u.FirstName) + " " + strings.TrimSpace(u.LastName))
	if name == "" {
		return strings.TrimSpace(u.Username)
	}
	return name
}

func userFromColumns(id int64, telegramUserID *int64, telegramUsername, name *string, locale string) User {
	u := User{
		ID:               id,
		TelegramUsername: derefString(telegramUsername),
		DisplayName:      derefString(name),
		Locale:           locale,
	}
	if telegramUserID != nil {
		u.TelegramUserID = *telegramUserID
	}
	return u
}

func unauthenticated() *apperr.Error {
	return apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
}

func parseIP(s string) *netip.Addr {
	addr, err := netip.ParseAddr(s)
	if err != nil {
		return nil
	}
	return &addr
}

func optionalString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func derefString(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
```

- [ ] **Step 14: 运行 runner 包测试，确认通过**

```bash
cd api && env $COLIMA_ENV go test ./internal/runner/
```

Expected：`ok  werun/api/internal/runner`。

- [ ] **Step 15: 在 OpenAPI 中加入跑者登录接口并生成代码**

在 `api/openapi/openapi.yaml` 的 `components:` 行之前（即 `paths` 的最后一个操作之后）插入：

```yaml
  /app/auth/telegram:
    post:
      operationId: appLoginTelegram
      tags: [app-auth]
      summary: 用 Telegram 小程序 initData 登录，返回跑者令牌
      x-auth: none
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/AppLoginRequest'
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
  /app/auth/logout:
    post:
      operationId: appLogout
      tags: [app-auth]
      summary: 吊销当前跑者令牌
      x-auth: app
      responses:
        '204':
          description: 已退出
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
  /app/me:
    get:
      operationId: appGetMe
      tags: [app-auth]
      summary: 当前跑者
      x-auth: app
      responses:
        '200':
          description: 当前跑者
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

在 `components.schemas` 末尾追加：

```yaml
    AppLoginRequest:
      type: object
      required: [initData]
      properties:
        initData:
          type: string
          minLength: 1
          maxLength: 4096
    AppUser:
      type: object
      required: [id, telegramUserId, telegramUsername, displayName, locale]
      properties:
        id:
          type: integer
          format: int64
        telegramUserId:
          type: integer
          format: int64
        telegramUsername:
          type: string
        displayName:
          type: string
        locale:
          type: string
          enum: [zh, en, km]
    AppSession:
      type: object
      required: [token, expiresAt, user]
      properties:
        token:
          type: string
        expiresAt:
          type: string
          format: date-time
        user:
          $ref: '#/components/schemas/AppUser'
```

运行：

```bash
make gen
```

Expected：`api/internal/httpapi/apigen/api.gen.go` 出现 `AppLoginTelegramRequestObject{Body *AppLoginTelegramJSONRequestBody}`、`AppLoginTelegram200JSONResponse`、`AppLogout204Response`、`AppGetMe200JSONResponse`、`AppUserLocale`；`permissions.gen.go` 出现 `AuthApp AuthKind = "app"`、`"AppGetMe": {Kind: AuthApp}`、`"AppLoginTelegram": {Kind: AuthNone}`、`"AppLogout": {Kind: AuthApp}`；`packages/api-client/src/schema.d.ts` 出现 `"/app/auth/telegram"`。

- [ ] **Step 16: 写认证中间件与跑者接口的失败测试**

修改 `api/internal/httpapi/auth_test.go`。

（1）import 增加 `"fmt"` 与 `"werun/api/internal/runner"`。

（2）`TestAuthMiddlewarePermissions` 中的调用：

旧：

```go
	mw := AuthMiddleware(f.svc, auths, logx.New("error", io.Discard))
```

新：

```go
	mw := AuthMiddleware(f.svc, nil, auths, logx.New("error", io.Discard))
```

（3）文件末尾追加：

```go
// fakeRunners 按令牌返回跑者，代替 runner.Service 的 Authenticate。
type fakeRunners map[string]runner.User

func (f fakeRunners) Authenticate(_ context.Context, token string) (runner.User, error) {
	u, ok := f[token]
	if !ok {
		return runner.User{}, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	return u, nil
}

func TestAuthMiddlewareSeparatesRunnerTokenAndStaffCookie(t *testing.T) {
	f := newAuthFixture(t)
	staffToken, _, err := f.svc.Login(context.Background(), "ops.chan", "correct-horse-1", httpx.Meta{IP: "198.51.100.11"})
	require.NoError(t, err)
	runners := fakeRunners{"runner-token-1": {ID: 7, TelegramUserID: 10001, DisplayName: "Dara Sok", Locale: "km"}}
	auths := map[string]apigen.OperationAuth{
		"AppOp":   {Kind: apigen.AuthApp},
		"StaffOp": {Kind: apigen.AuthSession},
		"PermOp":  {Kind: apigen.AuthPermission, Permission: string(iam.PermEventConfig), Access: string(iam.AccessRead)},
	}
	mw := AuthMiddleware(f.svc, runners, auths, logx.New("error", io.Discard))
	next := func(c *gin.Context, _ any) (any, error) {
		if u, ok := runner.UserFrom(c); ok {
			return fmt.Sprintf("runner:%d", u.ID), nil
		}
		if s, ok := iam.StaffFrom(c); ok {
			return "staff:" + s.Username, nil
		}
		return "anonymous", nil
	}

	cases := []struct {
		name          string
		operation     string
		authorization string
		cookie        string
		want          string
		wantCode      string
	}{
		{name: "app op with bearer token", operation: "AppOp", authorization: "Bearer runner-token-1", want: "runner:7"},
		{name: "app op accepts lowercase scheme", operation: "AppOp", authorization: "bearer runner-token-1", want: "runner:7"},
		{name: "app op without token", operation: "AppOp", wantCode: apperr.CodeUnauthenticated},
		{name: "app op with unknown token", operation: "AppOp", authorization: "Bearer nope", wantCode: apperr.CodeUnauthenticated},
		{name: "app op with other scheme", operation: "AppOp", authorization: "Basic runner-token-1", wantCode: apperr.CodeUnauthenticated},
		{name: "app op with staff cookie only", operation: "AppOp", cookie: staffToken, wantCode: apperr.CodeUnauthenticated},
		{name: "app op ignores staff cookie when bearer is valid", operation: "AppOp", authorization: "Bearer runner-token-1", cookie: staffToken, want: "runner:7"},
		{name: "session op with bearer only", operation: "StaffOp", authorization: "Bearer runner-token-1", wantCode: apperr.CodeUnauthenticated},
		{name: "permission op with bearer only", operation: "PermOp", authorization: "Bearer runner-token-1", wantCode: apperr.CodeUnauthenticated},
		{name: "session op with staff cookie", operation: "StaffOp", cookie: staffToken, want: "staff:ops.chan"},
		{name: "permission op with staff cookie", operation: "PermOp", cookie: staffToken, want: "staff:ops.chan"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/fake", nil)
			if tc.authorization != "" {
				c.Request.Header.Set("Authorization", tc.authorization)
			}
			if tc.cookie != "" {
				c.Request.AddCookie(&http.Cookie{Name: iam.CookieName, Value: tc.cookie})
			}

			got, err := mw(next, tc.operation)(c, nil)

			if tc.wantCode != "" {
				appErr, ok := apperr.As(err)
				require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
				assert.Equal(t, tc.wantCode, appErr.Code)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tc.want, got)
		})
	}
}
```

创建 `api/internal/httpapi/runner_http_test.go`：

```go
package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/httpapi"
	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/logx"
	"werun/api/internal/platform/piicrypt"
	"werun/api/internal/runner"
)

const runnerBotToken = "123456:http-test-token"

type runnerEnv struct {
	router  http.Handler
	iam     *iam.Service
	catalog *i18n.Catalog
}

func newRunnerEnv(t *testing.T) runnerEnv {
	t.Helper()
	gin.SetMode(gin.TestMode)
	pool := dbtest.NewPool(t)
	catalog, err := i18n.LoadCatalog()
	require.NoError(t, err)
	pii, err := piicrypt.New([]byte(strings.Repeat("p", 32)))
	require.NoError(t, err)
	secret := []byte(strings.Repeat("k", 32))
	iamSvc := iam.NewService(pool, secret, iam.NewLoginLimiter(time.Now), time.Now)
	router := httpapi.NewRouter(httpapi.RouterDeps{
		Log:     logx.New("error", io.Discard),
		Catalog: catalog,
		Pool:    pool,
		IAM:     iamSvc,
		Runner:  runner.NewService(pool, secret, runnerBotToken, pii, time.Now),
		Env:     "dev",
	})
	return runnerEnv{router: router, iam: iamSvc, catalog: catalog}
}

func (e runnerEnv) do(t *testing.T, method, path string, body any, header http.Header) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		require.NoError(t, err)
		reader = bytes.NewReader(raw)
	}
	req := httptest.NewRequestWithContext(context.Background(), method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, values := range header {
		for _, v := range values {
			req.Header.Add(k, v)
		}
	}
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	return rec
}

func bearer(token string) http.Header {
	return http.Header{"Authorization": []string{"Bearer " + token}}
}

func (e runnerEnv) loginRunner(t *testing.T, telegramID int64, name string) apigen.AppSession {
	t.Helper()
	initData := runner.SignInitData(runnerBotToken, runner.TelegramUser{ID: telegramID, FirstName: name, LanguageCode: "en"}, time.Now())
	rec := e.do(t, http.MethodPost, "/api/app/auth/telegram", map[string]string{"initData": initData}, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var sess apigen.AppSession
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &sess))
	return sess
}

func decodeRunnerError(t *testing.T, rec *httptest.ResponseRecorder) apigen.ErrorResponse {
	t.Helper()
	var body apigen.ErrorResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body), rec.Body.String())
	return body
}

func TestAppLoginTelegramReturnsTokenAndMe(t *testing.T) {
	e := newRunnerEnv(t)
	before := time.Now()

	sess := e.loginRunner(t, 10001, "Dara Sok")

	assert.NotEmpty(t, sess.Token)
	assert.WithinDuration(t, before.Add(24*time.Hour), sess.ExpiresAt, time.Minute)
	assert.Equal(t, int64(10001), sess.User.TelegramUserId)
	assert.Equal(t, "Dara Sok", sess.User.DisplayName)
	assert.Equal(t, apigen.AppUserLocale("en"), sess.User.Locale)

	rec := e.do(t, http.MethodGet, "/api/app/me", nil, bearer(sess.Token))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var me apigen.AppUser
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &me))
	assert.Equal(t, sess.User, me)
}

func TestAppLoginTelegramRejectsTamperedInitData(t *testing.T) {
	e := newRunnerEnv(t)
	values, err := url.ParseQuery(runner.SignInitData(runnerBotToken, runner.TelegramUser{ID: 10001, FirstName: "Dara"}, time.Now()))
	require.NoError(t, err)
	values.Set("user", `{"id":10002,"first_name":"Dara"}`)

	rec := e.do(t, http.MethodPost, "/api/app/auth/telegram?lang=zh", map[string]string{"initData": values.Encode()}, nil)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	body := decodeRunnerError(t, rec)
	assert.Equal(t, apperr.CodeTelegramAuthInvalid, body.Error.Code)
	assert.Equal(t, e.catalog.T(i18n.ZH, apperr.CodeTelegramAuthInvalid, nil), body.Error.Message)
}

func TestAppMeRejectsMissingTokenAndStaffCookie(t *testing.T) {
	e := newRunnerEnv(t)
	ctx := context.Background()
	_, err := e.iam.CreateStaff(ctx, "ops.runner", "Ops Runner", iam.RoleOps, "Correct-Horse-Battery-9")
	require.NoError(t, err)
	staffToken, _, err := e.iam.Login(ctx, "ops.runner", "Correct-Horse-Battery-9", httpx.Meta{IP: "127.0.0.1"})
	require.NoError(t, err)

	rec := e.do(t, http.MethodGet, "/api/app/me", nil, nil)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Equal(t, apperr.CodeUnauthenticated, decodeRunnerError(t, rec).Error.Code)

	rec = e.do(t, http.MethodGet, "/api/app/me", nil, http.Header{"Cookie": []string{iam.CookieName + "=" + staffToken}})
	assert.Equal(t, http.StatusUnauthorized, rec.Code, "员工 Cookie 不能访问跑者接口")

	rec = e.do(t, http.MethodGet, "/api/app/me", nil, bearer("not-a-real-token"))
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestAdminMeRejectsRunnerBearerToken(t *testing.T) {
	e := newRunnerEnv(t)
	sess := e.loginRunner(t, 10001, "Dara Sok")

	rec := e.do(t, http.MethodGet, "/api/admin/me", nil, bearer(sess.Token))

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Equal(t, apperr.CodeUnauthenticated, decodeRunnerError(t, rec).Error.Code)
}

func TestAppLogoutRevokesToken(t *testing.T) {
	e := newRunnerEnv(t)
	sess := e.loginRunner(t, 10001, "Dara Sok")

	rec := e.do(t, http.MethodPost, "/api/app/auth/logout", nil, bearer(sess.Token))
	require.Equal(t, http.StatusNoContent, rec.Code, rec.Body.String())

	rec = e.do(t, http.MethodGet, "/api/app/me", nil, bearer(sess.Token))
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}
```

- [ ] **Step 17: 运行 httpapi 测试，确认失败**

```bash
cd api && env $COLIMA_ENV go test ./internal/httpapi/
```

Expected：FAIL，编译错误：`too many arguments in call to AuthMiddleware`、`*Server does not implement apigen.StrictServerInterface (missing method AppGetMe)`、`unknown field Runner in struct literal of type httpapi.RouterDeps`。

- [ ] **Step 18: 实现跑者 handler、中间件与装配**

创建 `api/internal/runner/handlers.go`：

```go
package runner

import (
	"context"
	"net/http"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
)

// Handlers 实现 apigen.StrictServerInterface 中的跑者接口。
type Handlers struct {
	svc *Service
}

// NewHandlers 创建跑者 handler。
func NewHandlers(svc *Service) *Handlers {
	return &Handlers{svc: svc}
}

func (h *Handlers) AppLoginTelegram(ctx context.Context, req apigen.AppLoginTelegramRequestObject) (apigen.AppLoginTelegramResponseObject, error) {
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	sess, err := h.svc.LoginTelegram(ctx, req.Body.InitData, httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AppLoginTelegram200JSONResponse{
		Token:     sess.Token,
		ExpiresAt: sess.ExpiresAt,
		User:      toAppUser(sess.User),
	}, nil
}

func (h *Handlers) AppLogout(ctx context.Context, _ apigen.AppLogoutRequestObject) (apigen.AppLogoutResponseObject, error) {
	if c, ok := httpx.Gin(ctx); ok {
		if token := BearerToken(c.Request); token != "" {
			if err := h.svc.Logout(ctx, token); err != nil {
				return nil, err
			}
		}
	}
	return apigen.AppLogout204Response{}, nil
}

func (h *Handlers) AppGetMe(ctx context.Context, _ apigen.AppGetMeRequestObject) (apigen.AppGetMeResponseObject, error) {
	u, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	return apigen.AppGetMe200JSONResponse(toAppUser(u)), nil
}

// currentUser 取认证中间件放入的跑者；取不到说明接口没有声明 x-auth: app。
func currentUser(ctx context.Context) (User, error) {
	u, ok := UserFrom(ctx)
	if !ok {
		return User{}, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	return u, nil
}

func toAppUser(u User) apigen.AppUser {
	return apigen.AppUser{
		Id:               u.ID,
		TelegramUserId:   u.TelegramUserID,
		TelegramUsername: u.TelegramUsername,
		DisplayName:      u.DisplayName,
		Locale:           apigen.AppUserLocale(u.Locale),
	}
}
```

`api/internal/httpapi/auth.go`：import 增加 `"context"` 与 `"werun/api/internal/runner"`，并用下面内容整体替换 `AuthMiddleware` 函数及其注释：

```go
// RunnerAuthenticator 校验跑者令牌，由 runner.Service 实现。
type RunnerAuthenticator interface {
	Authenticate(ctx context.Context, token string) (runner.User, error)
}

// AuthMiddleware 按 apigen.OperationAuths 做认证与权限校验：
//   - AuthApp 只认 Authorization: Bearer 跑者令牌，员工 Cookie 无效；
//   - AuthSession / AuthPermission 只认员工 Cookie，跑者令牌无效。
//
// 映射表里查不到的接口一律拒绝（说明忘了执行 make gen-api），并打一条 Warn 日志方便定位
// 是哪个接口、该跑哪条命令，而不是只在响应里看到一个不说明原因的 403。
func AuthMiddleware(staff *iam.Service, runners RunnerAuthenticator, auths map[string]apigen.OperationAuth, log *slog.Logger) apigen.StrictMiddlewareFunc {
	return func(next apigen.StrictHandlerFunc, operationID string) apigen.StrictHandlerFunc {
		rule, known := auths[operationID]
		if known && rule.Kind == apigen.AuthNone {
			return next
		}
		if known && rule.Kind == apigen.AuthApp {
			return func(c *gin.Context, request any) (any, error) {
				token := runner.BearerToken(c.Request)
				if token == "" {
					return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
				}
				user, err := runners.Authenticate(c, token)
				if err != nil {
					return nil, err
				}
				runner.WithUser(c, user)
				return next(c, request)
			}
		}
		return func(c *gin.Context, request any) (any, error) {
			if !known {
				log.WarnContext(c, "operation is missing from OperationAuths; run make gen-api",
					"operation", operationID)
				return nil, apperr.New(http.StatusForbidden, apperr.CodeForbidden).
					Wrap(fmt.Errorf("operation %s is missing from OperationAuths; run make gen-api", operationID))
			}
			token, err := c.Cookie(iam.CookieName)
			if err != nil || token == "" {
				return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
			}
			member, err := staff.Authenticate(c, token)
			if err != nil {
				return nil, err
			}
			iam.WithStaff(c, member)
			if rule.Kind == apigen.AuthPermission &&
				!iam.Allowed(member.Role, iam.Permission(rule.Permission), iam.Access(rule.Access)) {
				return nil, apperr.New(http.StatusForbidden, apperr.CodeForbidden)
			}
			// TODO(spec §5.1 step 7，赛事范围校验): 目前到这里为止只做了会话认证
			// 与按 x-permission 的角色权限校验；对 PHOTOGRAPHER / RACE_SUPERVISOR /
			// RACE_STAFF 这三个角色，spec 还要求当接口带赛事 ID 时，进一步校验该员工
			// 是否被指派到该赛事（`staff_event_assignments` 表，见
			// api/db/migrations/0002_events.sql）。本次 controller 决定暂不实现这一步，
			// 由后续任务在此处补一个中间件钩子：在放行 next(c, request) 之前，解析请求
			// 中的赛事 ID，查 staff_event_assignments 确认该员工在有效期内被指派到该
			// 赛事，否则返回 FORBIDDEN。在补齐之前，绝不能给这三个角色开放任何按赛事 ID
			// 访问的路由，否则他们将能访问未被指派的赛事数据。
			return next(c, request)
		}
	}
}
```

`api/internal/httpapi/router.go`：

（1）import 增加 `"werun/api/internal/runner"`。

（2）`RouterDeps` 在 `IAM *iam.Service` 这一行之后增加字段：

```go
	Runner  *runner.Service // 跑者登录与会话、常用参赛人、同意书
```

（3）中间件列表：

旧：

```go
		AuthMiddleware(d.IAM, apigen.OperationAuths, d.Log),
```

新：

```go
		AuthMiddleware(d.IAM, d.Runner, apigen.OperationAuths, d.Log),
```

`api/internal/httpapi/server.go`：

（1）import 增加 `"werun/api/internal/runner"`。

（2）类型别名块追加一行：

```go
	RunnerHandlers = runner.Handlers
```

（3）`Server` 结构体在已有嵌入字段之后追加：

```go
	*RunnerHandlers
```

（4）`NewServer` 返回的字面量在已有字段之后追加：

```go
		RunnerHandlers: runner.NewHandlers(d.Runner),
```

`api/cmd/werun/app.go`：

（1）import 增加 `"werun/api/internal/runner"`。

（2）`App` 结构体追加字段：

```go
	Runner *runner.Service
```

（3）在 `Bootstrap` 中 Task 1 给 `app.PII` 赋值的语句之后追加：

```go
	app.Runner = runner.NewService(app.Pool, []byte(app.Cfg.SessionSecret), app.Cfg.TelegramBotToken, app.PII, time.Now)
```

`api/cmd/werun/router.go`：`httpapi.RouterDeps{…}` 字面量在 `IAM: app.IAM,` 之后追加：

```go
		Runner:  app.Runner,
```

- [ ] **Step 19: 运行 httpapi 与 runner 测试，确认通过**

```bash
cd api && env $COLIMA_ENV go test ./internal/httpapi/... ./internal/runner/
```

Expected：全部 `ok`；`TestOperationAuthsCoversEveryStrictServerInterfaceMethod` 同时覆盖了三个新接口。

- [ ] **Step 20: 写 dev-initdata 命令的失败测试**

创建 `api/cmd/werun/devinitdata_test.go`：

```go
package main

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/runner"
)

const devTestBotToken = "123456:dev-initdata-test-token"

// setDevConfigEnv 设置 config.Load 需要的全部变量；dev-initdata 不连接数据库。
func setDevConfigEnv(t *testing.T) {
	t.Helper()
	t.Setenv("WERUN_ENV", "dev")
	t.Setenv("WERUN_DATABASE_URL", "postgres://werun:werun@localhost:55432/werun?sslmode=disable")
	t.Setenv("WERUN_SESSION_SECRET", strings.Repeat("s", 32))
	t.Setenv("WERUN_PII_KEY", "ZGV2LW9ubHktcGlpLWtleS0zMi1ieXRlcy0wMDAwMDA=")
	t.Setenv("WERUN_TELEGRAM_BOT_TOKEN", devTestBotToken)
	t.Setenv("WERUN_TELEGRAM_BOT_USERNAME", "werun_e2e_bot")
	t.Setenv("WERUN_TELEGRAM_SEND", "off")
	t.Setenv("WERUN_APP_BASE_URL", "http://werun.localhost")
}

func TestDevInitDataPrintsVerifiableInitData(t *testing.T) {
	setDevConfigEnv(t)

	code, stdout, stderr := runCmd("dev-initdata", "--telegram-id", "10001", "--name", "Sokha Chan", "--lang", "km")

	require.Equal(t, 0, code, stderr)
	got, err := runner.VerifyInitData(strings.TrimSpace(stdout), devTestBotToken, time.Now())
	require.NoError(t, err)
	assert.Equal(t, runner.TelegramUser{ID: 10001, FirstName: "Sokha Chan", LanguageCode: "km"}, got)
}

func TestDevInitDataDefaultsLangToEnglish(t *testing.T) {
	setDevConfigEnv(t)

	code, stdout, stderr := runCmd("dev-initdata", "--telegram-id", "10002", "--name", "Dara")

	require.Equal(t, 0, code, stderr)
	got, err := runner.VerifyInitData(strings.TrimSpace(stdout), devTestBotToken, time.Now())
	require.NoError(t, err)
	assert.Equal(t, "en", got.LanguageCode)
}

func TestDevInitDataRefusesInProd(t *testing.T) {
	setDevConfigEnv(t)
	t.Setenv("WERUN_ENV", "prod")

	code, stdout, stderr := runCmd("dev-initdata", "--telegram-id", "10001", "--name", "Dara")

	assert.Equal(t, 1, code)
	assert.Empty(t, stdout)
	assert.Contains(t, stderr, "WERUN_ENV=prod")
}

func TestDevInitDataValidatesFlags(t *testing.T) {
	setDevConfigEnv(t)
	cases := map[string]struct {
		args []string
		want string
	}{
		"missing telegram id": {[]string{"--name", "Dara"}, "--telegram-id"},
		"negative telegram id": {[]string{"--telegram-id", "-5", "--name", "Dara"}, "--telegram-id"},
		"missing name":        {[]string{"--telegram-id", "10001"}, "--name"},
		"blank name":          {[]string{"--telegram-id", "10001", "--name", "   "}, "--name"},
		"unknown lang":        {[]string{"--telegram-id", "10001", "--name", "Dara", "--lang", "fr"}, "--lang"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			code, stdout, stderr := runCmd(append([]string{"dev-initdata"}, tc.args...)...)
			assert.Equal(t, 1, code)
			assert.Empty(t, stdout)
			assert.Contains(t, stderr, tc.want)
		})
	}
}
```

运行：

```bash
cd api && go test -run DevInitData ./cmd/werun/
```

Expected：FAIL，`TestDevInitDataPrintsVerifiableInitData` 退出码为 2，stderr 为 `unknown command "dev-initdata"`。

- [ ] **Step 21: 实现 dev-initdata 命令**

创建 `api/cmd/werun/devinitdata.go`：

```go
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"
	"time"

	"werun/api/internal/platform/config"
	"werun/api/internal/runner"
)

var (
	devInitDataLangs     = []string{"zh", "en", "km"}
	errDevInitDataInProd = errors.New("WERUN_ENV=prod 时禁止生成开发登录参数")
)

// runDevInitData 实现 `werun dev-initdata`：用配置里的机器人 token 生成签名正确的 initData 并打印一行。
func runDevInitData(args []string, stdout, stderr io.Writer) error {
	// 先看原始环境变量：生产环境即使配置不全也必须拒绝
	if os.Getenv("WERUN_ENV") == "prod" {
		return errDevInitDataInProd
	}
	fs := flag.NewFlagSet("dev-initdata", flag.ContinueOnError)
	fs.SetOutput(stderr)
	telegramID := fs.Int64("telegram-id", 0, "Telegram 用户 ID（正整数）")
	name := fs.String("name", "", "显示名，写入 user.first_name")
	lang := fs.String("lang", "en", "language_code："+strings.Join(devInitDataLangs, " | "))
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *telegramID <= 0 {
		return errors.New("--telegram-id 必须是正整数")
	}
	displayName := strings.TrimSpace(*name)
	if displayName == "" {
		return errors.New("--name 不能为空")
	}
	if !slices.Contains(devInitDataLangs, *lang) {
		return fmt.Errorf("--lang 只能是 %s", strings.Join(devInitDataLangs, "、"))
	}

	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	if cfg.IsProd() {
		return errDevInitDataInProd
	}
	initData := runner.SignInitData(cfg.TelegramBotToken, runner.TelegramUser{
		ID:           *telegramID,
		FirstName:    displayName,
		LanguageCode: *lang,
	}, time.Now())
	_, err = fmt.Fprintln(stdout, initData)
	return err
}
```

`api/cmd/werun/main.go`：

（1）`usage` 常量中 `create-staff` 行之后追加：

```
  dev-initdata 生成开发与测试用的 Telegram 登录参数：--telegram-id --name [--lang zh|en|km]（WERUN_ENV=prod 时拒绝）
```

（2）`switch` 中 `case "create-staff":` 分支之后追加：

```go
	case "dev-initdata":
		if err := runDevInitData(args[1:], stdout, stderr); err != nil {
			fmt.Fprintf(stderr, "dev-initdata: %v\n", err)
			return 1
		}
		return 0
```

运行：

```bash
cd api && go test -run DevInitData ./cmd/werun/
```

Expected：`ok  werun/api/cmd/werun`。

- [ ] **Step 22: 全量检查**

```bash
make gen && git status --porcelain api/internal/httpapi/apigen packages/api-client/src/schema.d.ts api/internal/runner/store
cd api && env $COLIMA_ENV go test ./...
cd api && go tool golangci-lint run ./...
pnpm --filter @werun/api-client typecheck
```

Expected：`make gen` 之后再没有新的差异（生成文件已是最新）；`go test ./...` 全部 `ok`；golangci-lint 输出 `0 issues.`；api-client 类型检查通过。

- [ ] **Step 23: 提交**

```bash
git add api/db/queries/runner.sql api/sqlc.yaml api/internal/runner \
  api/internal/platform/apperr/apperr.go api/internal/platform/apperr/apperr_test.go \
  api/internal/platform/i18n/messages.zh.json api/internal/platform/i18n/messages.en.json api/internal/platform/i18n/messages.km.json \
  api/internal/httpapi/cmd/permgen/main.go api/internal/httpapi/cmd/permgen/main_test.go \
  api/openapi/openapi.yaml api/internal/httpapi/apigen/api.gen.go api/internal/httpapi/apigen/permissions.gen.go \
  packages/api-client/src/schema.d.ts \
  api/internal/httpapi/auth.go api/internal/httpapi/auth_test.go api/internal/httpapi/router.go api/internal/httpapi/server.go \
  api/internal/httpapi/runner_http_test.go \
  api/cmd/werun/app.go api/cmd/werun/router.go api/cmd/werun/main.go api/cmd/werun/devinitdata.go api/cmd/werun/devinitdata_test.go
git commit -m "$(cat <<'EOF'
feat(api): Telegram runner login, bearer auth and dev-initdata

- runner package: initData verification, USER sessions (24h, no renewal), runner.login audit
- permgen: /app/ operations use x-auth none|app (AuthApp)
- AuthMiddleware keeps runner bearer tokens and staff cookies separate
- appLoginTelegram / appLogout / appGetMe, TELEGRAM_AUTH_INVALID
- werun dev-initdata (refuses when WERUN_ENV=prod)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
)"
```

---
### Task 8: 常用参赛人

**Files:**
- Modify: `api/db/queries/runner.sql`（追加参赛人查询）
- Modify（生成）: `api/internal/runner/store/`
- Modify: `api/internal/runner/model.go`（追加 `ProfileData`、`Profile`）
- Create: `api/internal/runner/profiles.go`
- Test: `api/internal/runner/profiles_validate_test.go`
- Test: `api/internal/runner/profiles_test.go`
- Modify: `api/internal/runner/handlers.go`（追加四个接口）
- Modify: `api/openapi/openapi.yaml`
- Modify（生成）: `api/internal/httpapi/apigen/api.gen.go`、`api/internal/httpapi/apigen/permissions.gen.go`、`packages/api-client/src/schema.d.ts`
- Test: `api/internal/httpapi/runner_http_test.go`（追加）

**Interfaces:**
- Consumes:
  - Task 1：`piicrypt.NormalizeIDNo(s string) string`、`(*Cipher).Encrypt(plain string) ([]byte, error)`、`(*Cipher).Decrypt(sealed []byte) (string, error)`、`(*Cipher).Hash(normalized string) []byte`、`piicrypt.MaskIDNo(normalized string) string`
  - Task 7：`runner.Service`、`runner.User`、`currentUser(ctx)`、`optionalString`、`derefString`、测试辅助 `newFixture`、`fixture.login`、`countRows`、`requireAppError`、`fieldKeys`、`newRunnerEnv`、`runnerEnv.do`、`runnerEnv.loginRunner`、`bearer`、`decodeRunnerError`
- Produces（与 overview 一致）:
  ```go
  type ProfileData struct {
  	FullName, Gender string          // Gender: M | F | X
  	BirthDate        time.Time       // 日期，UTC 零点
  	Nationality      string          // ISO 3166-1 alpha-2 大写
  	IDType, IDNo     string          // NATIONAL_ID | PASSPORT | OTHER；IDNo 为原始输入
  	Phone, Email     string          // Phone 为 E.164；Email 可空
  	EmergencyName, EmergencyPhone string
  	TShirtSize       string          // XS | S | M | L | XL | XXL
  }
  type Profile struct { ID int64; Data ProfileData; IDNoMasked string; IsSelf bool } // Data.IDNo 为空串
  func ValidateProfile(p ProfileData, fieldPrefix string) error
  func (s *Service) ListProfiles(ctx context.Context, u User) ([]Profile, error)
  func (s *Service) CreateProfile(ctx context.Context, u User, p ProfileData, isSelf bool) (Profile, error)
  func (s *Service) UpdateProfile(ctx context.Context, u User, id int64, p ProfileData, isSelf bool) (Profile, error) // IDNo 为空串时保留原证件号
  func (s *Service) DeleteProfile(ctx context.Context, u User, id int64) error
  func (s *Service) CreateProfileTx(ctx context.Context, tx pgx.Tx, u User, p ProfileData) (int64, error)
  func (s *Service) LoadProfileForOrder(ctx context.Context, tx pgx.Tx, u User, id int64, fieldPrefix string) (ProfileData, error)
  func (s *Service) PII() *piicrypt.Cipher
  ```
  - 契约补充：`func NormalizeProfile(p ProfileData) ProfileData`
  - operationId：`appListProfiles`（`GET /app/profiles`）、`appCreateProfile`（`POST /app/profiles`）、`appUpdateProfile`（`PUT /app/profiles/{id}`）、`appDeleteProfile`（`DELETE /app/profiles/{id}`），均为 `x-auth: app`
  - OpenAPI 组件：`Gender`、`IdType`、`TShirtSize`、`ProfileInput`、`RunnerProfile`、`RunnerProfileList`

**校验规则**（`ValidateProfile`；字段名前面加 `fieldPrefix`；只用 `field.required` 与 `field.invalid`）：

| 字段 | 规范化 | required | invalid |
|---|---|---|---|
| `fullName` | 去首尾空白 | 为空 | 超过 100 个字符（按 rune 计） |
| `gender` | 去空白、转大写 | 为空 | 不是 `M` / `F` / `X` |
| `birthDate` | 取日期部分，转成 UTC 零点 | 零值 | 早于 1900-01-01，或晚于柬埔寨时间（UTC+7）的今天 |
| `nationality` | 去空白、转大写 | 为空 | 不匹配 `^[A-Z]{2}$` |
| `idType` | 去空白、转大写 | 为空 | 不是 `NATIONAL_ID` / `PASSPORT` / `OTHER` |
| `idNo` | `piicrypt.NormalizeIDNo` | 为空（更新时为空表示保留原号，不报错） | 规范化后不匹配 `^[A-Z0-9]{4,32}$` |
| `phone`、`emergencyPhone` | 去掉所有空白与 `-` | 为空 | 不匹配 `^\+[1-9][0-9]{7,14}$` |
| `email` | 去首尾空白 | 可空 | 非空时：超过 254 字节，或不匹配 `^[^\s@]+@[^\s@]+\.[^\s@]+$`，或 `net/mail.ParseAddress` 解析失败，或解析出的地址与原文不同 |
| `emergencyName` | 去首尾空白 | 为空 | 超过 100 个字符 |
| `tshirtSize` | 去空白、转大写 | 为空 | 不是 `XS` / `S` / `M` / `L` / `XL` / `XXL` |

- [ ] **Step 1: 写资料校验的失败测试**

创建 `api/internal/runner/profiles_validate_test.go`：

```go
package runner_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/runner"
)

// validProfile 是一份合法但未规范化的原始输入。
func validProfile() runner.ProfileData {
	return runner.ProfileData{
		FullName:       "  Sok Dara ",
		Gender:         "m",
		BirthDate:      time.Date(1990, 5, 1, 0, 0, 0, 0, time.UTC),
		Nationality:    "kh",
		IDType:         "NATIONAL_ID",
		IDNo:           "n0 1234-5678",
		Phone:          "+855 12 345 678",
		Email:          " dara@example.com ",
		EmergencyName:  "Sok Chenda",
		EmergencyPhone: "+85598765432",
		TShirtSize:     "m",
	}
}

func TestValidateProfileAcceptsValidInput(t *testing.T) {
	require.NoError(t, runner.ValidateProfile(validProfile(), "participants[1]."))
}

func TestValidateProfileFieldRules(t *testing.T) {
	const prefix = "participants[1]."
	future := time.Now().UTC().AddDate(0, 0, 2)
	cases := []struct {
		name   string
		mutate func(p *runner.ProfileData)
		want   map[string]string
	}{
		{"blank full name", func(p *runner.ProfileData) { p.FullName = "   " }, map[string]string{prefix + "fullName": "field.required"}},
		{"full name too long", func(p *runner.ProfileData) { p.FullName = strings.Repeat("a", 101) }, map[string]string{prefix + "fullName": "field.invalid"}},
		{"khmer full name of 100 runes", func(p *runner.ProfileData) { p.FullName = strings.Repeat("ក", 100) }, nil},
		{"missing gender", func(p *runner.ProfileData) { p.Gender = "" }, map[string]string{prefix + "gender": "field.required"}},
		{"unknown gender", func(p *runner.ProfileData) { p.Gender = "Z" }, map[string]string{prefix + "gender": "field.invalid"}},
		{"lowercase gender", func(p *runner.ProfileData) { p.Gender = "f" }, nil},
		{"missing birth date", func(p *runner.ProfileData) { p.BirthDate = time.Time{} }, map[string]string{prefix + "birthDate": "field.required"}},
		{"birth date before 1900", func(p *runner.ProfileData) { p.BirthDate = time.Date(1899, 12, 31, 0, 0, 0, 0, time.UTC) }, map[string]string{prefix + "birthDate": "field.invalid"}},
		{"birth date on 1900-01-01", func(p *runner.ProfileData) { p.BirthDate = time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC) }, nil},
		{"birth date in the future", func(p *runner.ProfileData) { p.BirthDate = future }, map[string]string{prefix + "birthDate": "field.invalid"}},
		{"missing nationality", func(p *runner.ProfileData) { p.Nationality = "" }, map[string]string{prefix + "nationality": "field.required"}},
		{"three letter nationality", func(p *runner.ProfileData) { p.Nationality = "KHM" }, map[string]string{prefix + "nationality": "field.invalid"}},
		{"nationality with digit", func(p *runner.ProfileData) { p.Nationality = "K1" }, map[string]string{prefix + "nationality": "field.invalid"}},
		{"missing id type", func(p *runner.ProfileData) { p.IDType = "" }, map[string]string{prefix + "idType": "field.required"}},
		{"unknown id type", func(p *runner.ProfileData) { p.IDType = "DRIVER_LICENSE" }, map[string]string{prefix + "idType": "field.invalid"}},
		{"lowercase id type", func(p *runner.ProfileData) { p.IDType = "passport" }, nil},
		{"missing id number", func(p *runner.ProfileData) { p.IDNo = " - " }, map[string]string{prefix + "idNo": "field.required"}},
		{"id number too short", func(p *runner.ProfileData) { p.IDNo = "12-3" }, map[string]string{prefix + "idNo": "field.invalid"}},
		{"id number too long", func(p *runner.ProfileData) { p.IDNo = strings.Repeat("A", 33) }, map[string]string{prefix + "idNo": "field.invalid"}},
		{"id number with symbol", func(p *runner.ProfileData) { p.IDNo = "AB#1234" }, map[string]string{prefix + "idNo": "field.invalid"}},
		{"id number with spaces and hyphens", func(p *runner.ProfileData) { p.IDNo = "ab 12-34" }, nil},
		{"missing phone", func(p *runner.ProfileData) { p.Phone = "" }, map[string]string{prefix + "phone": "field.required"}},
		{"phone without plus", func(p *runner.ProfileData) { p.Phone = "012345678" }, map[string]string{prefix + "phone": "field.invalid"}},
		{"phone starting with zero", func(p *runner.ProfileData) { p.Phone = "+0123456789" }, map[string]string{prefix + "phone": "field.invalid"}},
		{"phone too short", func(p *runner.ProfileData) { p.Phone = "+8551234" }, map[string]string{prefix + "phone": "field.invalid"}},
		{"phone too long", func(p *runner.ProfileData) { p.Phone = "+1234567890123456" }, map[string]string{prefix + "phone": "field.invalid"}},
		{"empty email", func(p *runner.ProfileData) { p.Email = "  " }, nil},
		{"email without domain dot", func(p *runner.ProfileData) { p.Email = "dara@example" }, map[string]string{prefix + "email": "field.invalid"}},
		{"email with display name", func(p *runner.ProfileData) { p.Email = "Dara <dara@example.com>" }, map[string]string{prefix + "email": "field.invalid"}},
		{"email too long", func(p *runner.ProfileData) { p.Email = strings.Repeat("a", 250) + "@example.com" }, map[string]string{prefix + "email": "field.invalid"}},
		{"missing emergency name", func(p *runner.ProfileData) { p.EmergencyName = "" }, map[string]string{prefix + "emergencyName": "field.required"}},
		{"emergency name too long", func(p *runner.ProfileData) { p.EmergencyName = strings.Repeat("b", 101) }, map[string]string{prefix + "emergencyName": "field.invalid"}},
		{"invalid emergency phone", func(p *runner.ProfileData) { p.EmergencyPhone = "12345" }, map[string]string{prefix + "emergencyPhone": "field.invalid"}},
		{"unknown tshirt size", func(p *runner.ProfileData) { p.TShirtSize = "XXXL" }, map[string]string{prefix + "tshirtSize": "field.invalid"}},
		{"lowercase tshirt size", func(p *runner.ProfileData) { p.TShirtSize = "xl" }, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := validProfile()
			tc.mutate(&p)

			err := runner.ValidateProfile(p, prefix)

			if tc.want == nil {
				require.NoError(t, err)
				return
			}
			requireAppError(t, err, http.StatusUnprocessableEntity, apperr.CodeValidation)
			assert.Equal(t, tc.want, fieldKeys(t, err))
		})
	}
}

func TestValidateProfileReportsEveryMissingField(t *testing.T) {
	err := runner.ValidateProfile(runner.ProfileData{}, "")

	assert.Equal(t, map[string]string{
		"fullName":       "field.required",
		"gender":         "field.required",
		"birthDate":      "field.required",
		"nationality":    "field.required",
		"idType":         "field.required",
		"idNo":           "field.required",
		"phone":          "field.required",
		"emergencyName":  "field.required",
		"emergencyPhone": "field.required",
		"tshirtSize":     "field.required",
	}, fieldKeys(t, err))
}

func TestNormalizeProfile(t *testing.T) {
	ict := time.FixedZone("ICT", 7*60*60)

	got := runner.NormalizeProfile(runner.ProfileData{
		FullName:       "  Sok Dara ",
		Gender:         " f ",
		BirthDate:      time.Date(1990, 5, 1, 23, 30, 0, 0, ict),
		Nationality:    " kh",
		IDType:         "passport",
		IDNo:           "n0 1234-5678",
		Phone:          "+855 12-345-678",
		Email:          " dara@example.com ",
		EmergencyName:  " Sok Chenda ",
		EmergencyPhone: "+855 98 765 432",
		TShirtSize:     " xl ",
	})

	assert.Equal(t, runner.ProfileData{
		FullName:       "Sok Dara",
		Gender:         "F",
		BirthDate:      time.Date(1990, 5, 1, 0, 0, 0, 0, time.UTC),
		Nationality:    "KH",
		IDType:         "PASSPORT",
		IDNo:           "N012345678",
		Phone:          "+85512345678",
		Email:          "dara@example.com",
		EmergencyName:  "Sok Chenda",
		EmergencyPhone: "+85598765432",
		TShirtSize:     "XL",
	}, got)
}
```

- [ ] **Step 2: 运行校验测试，确认失败**

```bash
cd api && go test -run 'ValidateProfile|NormalizeProfile' ./internal/runner/
```

Expected：FAIL，编译错误 `undefined: runner.ProfileData`、`undefined: runner.ValidateProfile`。

- [ ] **Step 3: 实现资料模型、规范化与校验**

在 `api/internal/runner/model.go` 末尾追加：

```go
// ProfileData 是一位参赛人的资料。
type ProfileData struct {
	FullName, Gender              string    // Gender: M | F | X
	BirthDate                     time.Time // 日期，UTC 零点
	Nationality                   string    // ISO 3166-1 alpha-2 大写
	IDType, IDNo                  string    // NATIONAL_ID | PASSPORT | OTHER；IDNo 为原始输入
	Phone, Email                  string    // Phone 为 E.164；Email 可空
	EmergencyName, EmergencyPhone string
	TShirtSize                    string // XS | S | M | L | XL | XXL
}

// Profile 是常用参赛人。Data.IDNo 恒为空串，只通过 IDNoMasked 展示后 4 位。
type Profile struct {
	ID         int64
	Data       ProfileData
	IDNoMasked string
	IsSelf     bool
}
```

创建 `api/internal/runner/profiles.go`（本步只写规范化与校验，服务方法在 Step 7 追加）：

```go
package runner

import (
	"net/http"
	"net/mail"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/piicrypt"
)

const (
	maxProfileNameLen = 100
	maxEmailLen       = 254
)

var (
	nationalityPattern = regexp.MustCompile(`^[A-Z]{2}$`)
	idNoPattern        = regexp.MustCompile(`^[A-Z0-9]{4,32}$`)
	phonePattern       = regexp.MustCompile(`^\+[1-9][0-9]{7,14}$`)
	emailPattern       = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

	profileGenders     = []string{"M", "F", "X"}
	profileIDTypes     = []string{"NATIONAL_ID", "PASSPORT", "OTHER"}
	profileTShirtSizes = []string{"XS", "S", "M", "L", "XL", "XXL"}

	minBirthDate = time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC)

	// platformZone：平台所在地柬埔寨，固定 UTC+7，不实行夏令时。用于「今天」这类按日期的判断。
	platformZone = time.FixedZone("Asia/Phnom_Penh", 7*60*60)
)

// NormalizeProfile 去掉首尾空白，统一大小写，证件号去空白与连字符，手机号去空白与连字符，出生日期取日期部分。
func NormalizeProfile(p ProfileData) ProfileData {
	p.FullName = strings.TrimSpace(p.FullName)
	p.Gender = strings.ToUpper(strings.TrimSpace(p.Gender))
	if !p.BirthDate.IsZero() {
		p.BirthDate = dateOnly(p.BirthDate)
	}
	p.Nationality = strings.ToUpper(strings.TrimSpace(p.Nationality))
	p.IDType = strings.ToUpper(strings.TrimSpace(p.IDType))
	p.IDNo = piicrypt.NormalizeIDNo(p.IDNo)
	p.Phone = normalizePhone(p.Phone)
	p.Email = strings.TrimSpace(p.Email)
	p.EmergencyName = strings.TrimSpace(p.EmergencyName)
	p.EmergencyPhone = normalizePhone(p.EmergencyPhone)
	p.TShirtSize = strings.ToUpper(strings.TrimSpace(p.TShirtSize))
	return p
}

// ValidateProfile 规范化后校验全部字段，返回 VALIDATION_FAILED；字段名前缀由 fieldPrefix 给出（如 "participants[0]."）。
func ValidateProfile(p ProfileData, fieldPrefix string) error {
	return validateProfile(NormalizeProfile(p), fieldPrefix, true, time.Now())
}

// validateProfile 校验已规范化的资料；requireIDNo 为 false 时证件号可以为空（更新时保留原号）。
func validateProfile(p ProfileData, fieldPrefix string, requireIDNo bool, now time.Time) error {
	verr := apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)
	invalid := false
	add := func(field, key string) {
		verr = verr.WithField(fieldPrefix+field, key, nil)
		invalid = true
	}
	checkName := func(field, value string) {
		switch {
		case value == "":
			add(field, "field.required")
		case utf8.RuneCountInString(value) > maxProfileNameLen:
			add(field, "field.invalid")
		}
	}
	checkEnum := func(field, value string, allowed []string) {
		switch {
		case value == "":
			add(field, "field.required")
		case !slices.Contains(allowed, value):
			add(field, "field.invalid")
		}
	}
	checkPattern := func(field, value string, pattern *regexp.Regexp) {
		switch {
		case value == "":
			add(field, "field.required")
		case !pattern.MatchString(value):
			add(field, "field.invalid")
		}
	}

	checkName("fullName", p.FullName)
	checkEnum("gender", p.Gender, profileGenders)
	today := dateOnly(now.In(platformZone))
	switch {
	case p.BirthDate.IsZero():
		add("birthDate", "field.required")
	case p.BirthDate.Before(minBirthDate) || p.BirthDate.After(today):
		add("birthDate", "field.invalid")
	}
	checkPattern("nationality", p.Nationality, nationalityPattern)
	checkEnum("idType", p.IDType, profileIDTypes)
	if p.IDNo != "" || requireIDNo {
		checkPattern("idNo", p.IDNo, idNoPattern)
	}
	checkPattern("phone", p.Phone, phonePattern)
	if p.Email != "" && !validEmail(p.Email) {
		add("email", "field.invalid")
	}
	checkName("emergencyName", p.EmergencyName)
	checkPattern("emergencyPhone", p.EmergencyPhone, phonePattern)
	checkEnum("tshirtSize", p.TShirtSize, profileTShirtSizes)

	if invalid {
		return verr
	}
	return nil
}

func validEmail(s string) bool {
	if len(s) > maxEmailLen || !emailPattern.MatchString(s) {
		return false
	}
	addr, err := mail.ParseAddress(s)
	return err == nil && addr.Address == s
}

func normalizePhone(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) || r == '-' {
			return -1
		}
		return r
	}, s)
}

// dateOnly 取 t 在其自身时区里的年月日，返回该日期的 UTC 零点。
func dateOnly(t time.Time) time.Time {
	y, m, d := t.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}
```

- [ ] **Step 4: 运行校验测试，确认通过**

```bash
cd api && go test -run 'ValidateProfile|NormalizeProfile' ./internal/runner/
```

Expected：`ok  werun/api/internal/runner`。

- [ ] **Step 5: 追加参赛人查询并生成代码**

在 `api/db/queries/runner.sql` 末尾追加：

```sql
-- name: LockUser :one
SELECT id FROM users WHERE id = @id FOR UPDATE;

-- name: ListProfiles :many
SELECT * FROM runner_profiles
WHERE user_id = @user_id
ORDER BY is_self DESC, id;

-- name: GetProfile :one
SELECT * FROM runner_profiles
WHERE id = @id AND user_id = @user_id;

-- name: GetProfileForUpdate :one
SELECT * FROM runner_profiles
WHERE id = @id AND user_id = @user_id
FOR UPDATE;

-- name: InsertProfile :one
INSERT INTO runner_profiles (
  user_id, full_name, gender, birth_date, nationality, id_type, id_no_enc, id_no_hash,
  phone_e164, email, emergency_name, emergency_phone, tshirt_size, is_self
) VALUES (
  @user_id, @full_name, @gender, @birth_date, @nationality, @id_type::text, @id_no_enc::bytea, @id_no_hash::bytea,
  @phone_e164::text, sqlc.narg(email), @emergency_name::text, @emergency_phone::text, @tshirt_size::text, @is_self
)
RETURNING *;

-- name: UpdateProfile :one
UPDATE runner_profiles
SET full_name       = @full_name,
    gender          = @gender,
    birth_date      = @birth_date,
    nationality     = @nationality,
    id_type         = @id_type::text,
    id_no_enc       = @id_no_enc::bytea,
    id_no_hash      = @id_no_hash::bytea,
    phone_e164      = @phone_e164::text,
    email           = sqlc.narg(email),
    emergency_name  = @emergency_name::text,
    emergency_phone = @emergency_phone::text,
    tshirt_size     = @tshirt_size::text,
    is_self         = @is_self
WHERE id = @id AND user_id = @user_id
RETURNING *;

-- name: ClearSelfProfiles :exec
UPDATE runner_profiles SET is_self = false
WHERE user_id = @user_id AND is_self AND id <> @except_id;

-- name: DeleteProfile :execrows
DELETE FROM runner_profiles WHERE id = @id AND user_id = @user_id;
```

运行：

```bash
cd api && go tool sqlc generate && grep -n "type RunnerProfile struct" -A18 internal/runner/store/models.go
```

Expected：`RunnerProfile` 含 `ID int64`、`UserID int64`、`FullName string`、`Gender string`、`BirthDate time.Time`、`Nationality string`、`IDType *string`、`IDNoEnc []byte`、`IDNoHash []byte`、`PhoneE164 *string`、`Email *string`、`EmergencyName *string`、`EmergencyPhone *string`、`TshirtSize *string`、`IsSelf bool`、`CreatedAt`、`UpdatedAt`；`InsertProfileParams` 的 `IDType`、`PhoneE164`、`EmergencyName`、`EmergencyPhone`、`TshirtSize` 为 `string`，`Email` 为 `*string`。

- [ ] **Step 6: 写参赛人服务的数据库失败测试**

创建 `api/internal/runner/profiles_test.go`：

```go
package runner_test

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/runner"
)

func selfProfileIDs(t *testing.T, pool *pgxpool.Pool, userID int64) []int64 {
	t.Helper()
	rows, err := pool.Query(context.Background(),
		`SELECT id FROM runner_profiles WHERE user_id = $1 AND is_self ORDER BY id`, userID)
	require.NoError(t, err)
	ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	require.NoError(t, err)
	return ids
}

func storedIDNo(t *testing.T, pool *pgxpool.Pool, profileID int64) (enc, hash []byte) {
	t.Helper()
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT id_no_enc, id_no_hash FROM runner_profiles WHERE id = $1`, profileID).Scan(&enc, &hash))
	return enc, hash
}

func TestCreateProfileEncryptsIDNoAndMasksOutput(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	u := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"}).User

	created, err := f.svc.CreateProfile(ctx, u, validProfile(), true)

	require.NoError(t, err)
	assert.NotZero(t, created.ID)
	assert.True(t, created.IsSelf)
	assert.Equal(t, "******5678", created.IDNoMasked)
	assert.Equal(t, runner.ProfileData{
		FullName:       "Sok Dara",
		Gender:         "M",
		BirthDate:      time.Date(1990, 5, 1, 0, 0, 0, 0, time.UTC),
		Nationality:    "KH",
		IDType:         "NATIONAL_ID",
		IDNo:           "",
		Phone:          "+85512345678",
		Email:          "dara@example.com",
		EmergencyName:  "Sok Chenda",
		EmergencyPhone: "+85598765432",
		TShirtSize:     "M",
	}, created.Data)

	enc, hash := storedIDNo(t, f.pool, created.ID)
	assert.NotContains(t, string(enc), "N012345678")
	assert.Equal(t, f.pii.Hash("N012345678"), hash)
	plain, err := f.svc.PII().Decrypt(enc)
	require.NoError(t, err)
	assert.Equal(t, "N012345678", plain)
	assert.Equal(t, 1, countRows(t, f.pool, `SELECT count(*) FROM runner_profiles WHERE user_id = $1`, u.ID))
}

func TestCreateProfileRejectsInvalidDataWithoutWriting(t *testing.T) {
	f := newFixture(t)
	u := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"}).User
	p := validProfile()
	p.Phone = "012345678"
	p.IDNo = ""

	_, err := f.svc.CreateProfile(context.Background(), u, p, false)

	requireAppError(t, err, http.StatusUnprocessableEntity, apperr.CodeValidation)
	assert.Equal(t, map[string]string{"phone": "field.invalid", "idNo": "field.required"}, fieldKeys(t, err))
	assert.Equal(t, 0, countRows(t, f.pool, `SELECT count(*) FROM runner_profiles`))
}

func TestOnlyOneSelfProfilePerUser(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	u := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"}).User
	other := f.login(t, runner.TelegramUser{ID: 10002, FirstName: "Sokha"}).User

	a, err := f.svc.CreateProfile(ctx, u, validProfile(), true)
	require.NoError(t, err)
	otherSelf, err := f.svc.CreateProfile(ctx, other, validProfile(), true)
	require.NoError(t, err)

	second := validProfile()
	second.FullName = "Sok Chenda"
	second.IDNo = "P9876543"
	b, err := f.svc.CreateProfile(ctx, u, second, true)
	require.NoError(t, err)
	assert.Equal(t, []int64{b.ID}, selfProfileIDs(t, f.pool, u.ID))

	keep := validProfile()
	keep.IDNo = ""
	updated, err := f.svc.UpdateProfile(ctx, u, a.ID, keep, true)
	require.NoError(t, err)
	assert.True(t, updated.IsSelf)
	assert.Equal(t, []int64{a.ID}, selfProfileIDs(t, f.pool, u.ID))
	assert.Equal(t, []int64{otherSelf.ID}, selfProfileIDs(t, f.pool, other.ID), "不影响其他跑者")

	list, err := f.svc.ListProfiles(ctx, u)
	require.NoError(t, err)
	require.Len(t, list, 2)
	assert.Equal(t, a.ID, list[0].ID, "本人排在最前")
	assert.Equal(t, b.ID, list[1].ID)
	assert.Equal(t, "****6543", list[1].IDNoMasked)
	assert.Empty(t, list[0].Data.IDNo)
	assert.Empty(t, list[1].Data.IDNo)
}

func TestUpdateProfileKeepsIDNoWhenEmpty(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	u := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"}).User
	created, err := f.svc.CreateProfile(ctx, u, validProfile(), false)
	require.NoError(t, err)
	_, hashBefore := storedIDNo(t, f.pool, created.ID)

	in := validProfile()
	in.IDNo = ""
	in.FullName = "Sok Dara Jr"
	in.Email = ""
	updated, err := f.svc.UpdateProfile(ctx, u, created.ID, in, false)

	require.NoError(t, err)
	assert.Equal(t, "Sok Dara Jr", updated.Data.FullName)
	assert.Empty(t, updated.Data.Email)
	assert.Equal(t, "******5678", updated.IDNoMasked)
	_, hashAfter := storedIDNo(t, f.pool, created.ID)
	assert.Equal(t, hashBefore, hashAfter)
	assert.Equal(t, 1, countRows(t, f.pool, `SELECT count(*) FROM runner_profiles WHERE id = $1 AND email IS NULL`, created.ID))

	in.IDNo = "p 7777-8888"
	updated, err = f.svc.UpdateProfile(ctx, u, created.ID, in, false)
	require.NoError(t, err)
	assert.Equal(t, "*****8888", updated.IDNoMasked)
	_, hashChanged := storedIDNo(t, f.pool, created.ID)
	assert.Equal(t, f.pii.Hash("P77778888"), hashChanged)
}

func TestUpdateProfileValidatesInput(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	u := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"}).User
	created, err := f.svc.CreateProfile(ctx, u, validProfile(), false)
	require.NoError(t, err)

	in := validProfile()
	in.IDNo = "12"
	in.TShirtSize = "XXXL"
	_, err = f.svc.UpdateProfile(ctx, u, created.ID, in, false)

	requireAppError(t, err, http.StatusUnprocessableEntity, apperr.CodeValidation)
	assert.Equal(t, map[string]string{"idNo": "field.invalid", "tshirtSize": "field.invalid"}, fieldKeys(t, err))
}

func TestProfilesAreScopedToOwner(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	owner := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"}).User
	other := f.login(t, runner.TelegramUser{ID: 10002, FirstName: "Sokha"}).User
	created, err := f.svc.CreateProfile(ctx, owner, validProfile(), false)
	require.NoError(t, err)

	_, err = f.svc.UpdateProfile(ctx, other, created.ID, validProfile(), true)
	requireAppError(t, err, http.StatusNotFound, apperr.CodeNotFound)

	err = f.svc.DeleteProfile(ctx, other, created.ID)
	requireAppError(t, err, http.StatusNotFound, apperr.CodeNotFound)

	list, err := f.svc.ListProfiles(ctx, other)
	require.NoError(t, err)
	assert.Empty(t, list)

	err = db.InTx(ctx, f.pool, func(tx pgx.Tx) error {
		_, err := f.svc.LoadProfileForOrder(ctx, tx, other, created.ID, "participants[0].")
		return err
	})
	requireAppError(t, err, http.StatusUnprocessableEntity, apperr.CodeValidation)
	assert.Equal(t, map[string]string{"participants[0].profileId": "field.invalid"}, fieldKeys(t, err))

	ownerList, err := f.svc.ListProfiles(ctx, owner)
	require.NoError(t, err)
	require.Len(t, ownerList, 1)
	assert.Equal(t, "Sok Dara", ownerList[0].Data.FullName)
}

func TestDeleteProfile(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	u := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"}).User
	created, err := f.svc.CreateProfile(ctx, u, validProfile(), true)
	require.NoError(t, err)

	require.NoError(t, f.svc.DeleteProfile(ctx, u, created.ID))

	list, err := f.svc.ListProfiles(ctx, u)
	require.NoError(t, err)
	assert.Empty(t, list)
	err = f.svc.DeleteProfile(ctx, u, created.ID)
	requireAppError(t, err, http.StatusNotFound, apperr.CodeNotFound)
}

func TestLoadProfileForOrderReturnsFullIDNo(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	u := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"}).User
	created, err := f.svc.CreateProfile(ctx, u, validProfile(), false)
	require.NoError(t, err)

	var got runner.ProfileData
	err = db.InTx(ctx, f.pool, func(tx pgx.Tx) error {
		var err error
		got, err = f.svc.LoadProfileForOrder(ctx, tx, u, created.ID, "participants[0].")
		return err
	})

	require.NoError(t, err)
	want := created.Data
	want.IDNo = "N012345678"
	assert.Equal(t, want, got)
}

func TestCreateProfileTxUsesCallerTransaction(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	u := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"}).User
	stop := errors.New("stop")

	var rolledBackID int64
	err := db.InTx(ctx, f.pool, func(tx pgx.Tx) error {
		id, err := f.svc.CreateProfileTx(ctx, tx, u, validProfile())
		require.NoError(t, err)
		rolledBackID = id
		return stop
	})
	require.ErrorIs(t, err, stop)
	assert.NotZero(t, rolledBackID)
	assert.Equal(t, 0, countRows(t, f.pool, `SELECT count(*) FROM runner_profiles`))

	var id int64
	err = db.InTx(ctx, f.pool, func(tx pgx.Tx) error {
		var err error
		id, err = f.svc.CreateProfileTx(ctx, tx, u, validProfile())
		return err
	})
	require.NoError(t, err)
	assert.Equal(t, 1, countRows(t, f.pool,
		`SELECT count(*) FROM runner_profiles WHERE id = $1 AND user_id = $2 AND NOT is_self AND nationality = 'KH'`, id, u.ID))

	err = db.InTx(ctx, f.pool, func(tx pgx.Tx) error {
		_, err := f.svc.CreateProfileTx(ctx, tx, u, runner.ProfileData{})
		return err
	})
	requireAppError(t, err, http.StatusUnprocessableEntity, apperr.CodeValidation)
}
```

- [ ] **Step 7: 运行数据库测试，确认失败**

```bash
cd api && env $COLIMA_ENV go test ./internal/runner/
```

Expected：FAIL，编译错误 `f.svc.CreateProfile undefined`、`f.svc.PII undefined` 等。

- [ ] **Step 8: 实现参赛人服务方法**

`api/internal/runner/profiles.go` 的 import 块替换为：

```go
import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/mail"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/piicrypt"
	"werun/api/internal/runner/store"
)
```

并在文件末尾追加：

```go
// PII 返回证件号加解密器，供 registration 写报名快照时复用。
func (s *Service) PII() *piicrypt.Cipher {
	return s.pii
}

// ListProfiles 列出当前跑者的常用参赛人，本人排在最前。
func (s *Service) ListProfiles(ctx context.Context, u User) ([]Profile, error) {
	rows, err := s.q.ListProfiles(ctx, u.ID)
	if err != nil {
		return nil, fmt.Errorf("runner: list profiles of user %d: %w", u.ID, err)
	}
	out := make([]Profile, 0, len(rows))
	for _, row := range rows {
		p, err := s.toProfile(row)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, nil
}

// CreateProfile 校验并保存常用参赛人；isSelf 为 true 时同一事务内清掉该跑者其它资料的本人标记。
func (s *Service) CreateProfile(ctx context.Context, u User, p ProfileData, isSelf bool) (Profile, error) {
	p = NormalizeProfile(p)
	if err := validateProfile(p, "", true, s.now()); err != nil {
		return Profile{}, err
	}
	var out Profile
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		row, err := s.insertProfile(ctx, s.q.WithTx(tx), u, p, isSelf)
		if err != nil {
			return err
		}
		out, err = s.toProfile(row)
		return err
	})
	if err != nil {
		return Profile{}, err
	}
	return out, nil
}

// UpdateProfile 修改常用参赛人；p.IDNo 为空串时保留原证件号。资料不属于该跑者返回 NOT_FOUND。
func (s *Service) UpdateProfile(ctx context.Context, u User, id int64, p ProfileData, isSelf bool) (Profile, error) {
	p = NormalizeProfile(p)
	keepIDNo := p.IDNo == ""
	if err := validateProfile(p, "", !keepIDNo, s.now()); err != nil {
		return Profile{}, err
	}
	var out Profile
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		if isSelf {
			if _, err := q.LockUser(ctx, u.ID); err != nil {
				return fmt.Errorf("runner: lock user %d: %w", u.ID, err)
			}
		}
		existing, err := q.GetProfileForUpdate(ctx, store.GetProfileForUpdateParams{ID: id, UserID: u.ID})
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeNotFound)
		}
		if err != nil {
			return fmt.Errorf("runner: lock profile %d: %w", id, err)
		}

		enc, hash := existing.IDNoEnc, existing.IDNoHash
		if keepIDNo {
			if len(enc) == 0 {
				return apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation).
					WithField("idNo", "field.required", nil)
			}
		} else {
			enc, err = s.pii.Encrypt(p.IDNo)
			if err != nil {
				return fmt.Errorf("runner: encrypt id number: %w", err)
			}
			hash = s.pii.Hash(p.IDNo)
		}
		if isSelf {
			if err := q.ClearSelfProfiles(ctx, store.ClearSelfProfilesParams{UserID: u.ID, ExceptID: id}); err != nil {
				return fmt.Errorf("runner: clear self flag of user %d: %w", u.ID, err)
			}
		}
		row, err := q.UpdateProfile(ctx, store.UpdateProfileParams{
			FullName:       p.FullName,
			Gender:         p.Gender,
			BirthDate:      p.BirthDate,
			Nationality:    p.Nationality,
			IDType:         p.IDType,
			IDNoEnc:        enc,
			IDNoHash:       hash,
			PhoneE164:      p.Phone,
			Email:          optionalString(p.Email),
			EmergencyName:  p.EmergencyName,
			EmergencyPhone: p.EmergencyPhone,
			TshirtSize:     p.TShirtSize,
			IsSelf:         isSelf,
			ID:             id,
			UserID:         u.ID,
		})
		if err != nil {
			return fmt.Errorf("runner: update profile %d: %w", id, err)
		}
		out, err = s.toProfile(row)
		return err
	})
	if err != nil {
		return Profile{}, err
	}
	return out, nil
}

// DeleteProfile 删除常用参赛人；资料不属于该跑者返回 NOT_FOUND。已报名的快照在 registrations 里，不受影响。
func (s *Service) DeleteProfile(ctx context.Context, u User, id int64) error {
	n, err := s.q.DeleteProfile(ctx, store.DeleteProfileParams{ID: id, UserID: u.ID})
	if err != nil {
		return fmt.Errorf("runner: delete profile %d: %w", id, err)
	}
	if n == 0 {
		return apperr.New(http.StatusNotFound, apperr.CodeNotFound)
	}
	return nil
}

// CreateProfileTx 在调用方事务里保存常用参赛人（下单时勾选「保存为常用参赛人」），不设本人标记。
func (s *Service) CreateProfileTx(ctx context.Context, tx pgx.Tx, u User, p ProfileData) (int64, error) {
	p = NormalizeProfile(p)
	if err := validateProfile(p, "", true, s.now()); err != nil {
		return 0, err
	}
	row, err := s.insertProfile(ctx, s.q.WithTx(tx), u, p, false)
	if err != nil {
		return 0, err
	}
	return row.ID, nil
}

// LoadProfileForOrder 返回解密后的完整资料（含证件号）；资料不属于该跑者返回 VALIDATION_FAILED（字段 fieldPrefix+"profileId"）。
func (s *Service) LoadProfileForOrder(ctx context.Context, tx pgx.Tx, u User, id int64, fieldPrefix string) (ProfileData, error) {
	row, err := s.q.WithTx(tx).GetProfile(ctx, store.GetProfileParams{ID: id, UserID: u.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return ProfileData{}, apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation).
			WithField(fieldPrefix+"profileId", "field.invalid", nil)
	}
	if err != nil {
		return ProfileData{}, fmt.Errorf("runner: load profile %d: %w", id, err)
	}
	return s.profileData(row)
}

// insertProfile 写入已校验的资料；isSelf 时先锁跑者行再清掉其它本人标记，避免并发产生两个本人。
func (s *Service) insertProfile(ctx context.Context, q *store.Queries, u User, p ProfileData, isSelf bool) (store.RunnerProfile, error) {
	enc, err := s.pii.Encrypt(p.IDNo)
	if err != nil {
		return store.RunnerProfile{}, fmt.Errorf("runner: encrypt id number: %w", err)
	}
	if isSelf {
		if _, err := q.LockUser(ctx, u.ID); err != nil {
			return store.RunnerProfile{}, fmt.Errorf("runner: lock user %d: %w", u.ID, err)
		}
		if err := q.ClearSelfProfiles(ctx, store.ClearSelfProfilesParams{UserID: u.ID, ExceptID: 0}); err != nil {
			return store.RunnerProfile{}, fmt.Errorf("runner: clear self flag of user %d: %w", u.ID, err)
		}
	}
	row, err := q.InsertProfile(ctx, store.InsertProfileParams{
		UserID:         u.ID,
		FullName:       p.FullName,
		Gender:         p.Gender,
		BirthDate:      p.BirthDate,
		Nationality:    p.Nationality,
		IDType:         p.IDType,
		IDNoEnc:        enc,
		IDNoHash:       s.pii.Hash(p.IDNo),
		PhoneE164:      p.Phone,
		Email:          optionalString(p.Email),
		EmergencyName:  p.EmergencyName,
		EmergencyPhone: p.EmergencyPhone,
		TshirtSize:     p.TShirtSize,
		IsSelf:         isSelf,
	})
	if err != nil {
		return store.RunnerProfile{}, fmt.Errorf("runner: insert profile for user %d: %w", u.ID, err)
	}
	return row, nil
}

func (s *Service) toProfile(row store.RunnerProfile) (Profile, error) {
	data, err := s.profileData(row)
	if err != nil {
		return Profile{}, err
	}
	masked := piicrypt.MaskIDNo(data.IDNo)
	data.IDNo = ""
	return Profile{ID: row.ID, Data: data, IDNoMasked: masked, IsSelf: row.IsSelf}, nil
}

func (s *Service) profileData(row store.RunnerProfile) (ProfileData, error) {
	idNo := ""
	if len(row.IDNoEnc) > 0 {
		plain, err := s.pii.Decrypt(row.IDNoEnc)
		if err != nil {
			return ProfileData{}, fmt.Errorf("runner: decrypt id number of profile %d: %w", row.ID, err)
		}
		idNo = plain
	}
	return ProfileData{
		FullName:       row.FullName,
		Gender:         row.Gender,
		BirthDate:      row.BirthDate,
		Nationality:    row.Nationality,
		IDType:         derefString(row.IDType),
		IDNo:           idNo,
		Phone:          derefString(row.PhoneE164),
		Email:          derefString(row.Email),
		EmergencyName:  derefString(row.EmergencyName),
		EmergencyPhone: derefString(row.EmergencyPhone),
		TShirtSize:     derefString(row.TshirtSize),
	}, nil
}
```

- [ ] **Step 9: 运行 runner 包测试，确认通过**

```bash
cd api && env $COLIMA_ENV go test ./internal/runner/
```

Expected：`ok  werun/api/internal/runner`。

- [ ] **Step 10: 在 OpenAPI 中加入参赛人接口并生成代码**

在 `api/openapi/openapi.yaml` 的 `components:` 行之前插入：

```yaml
  /app/profiles:
    get:
      operationId: appListProfiles
      tags: [app-profiles]
      summary: 当前跑者的常用参赛人（证件号只返回后 4 位）
      x-auth: app
      responses:
        '200':
          description: 常用参赛人列表，本人排在最前
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/RunnerProfileList'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
    post:
      operationId: appCreateProfile
      tags: [app-profiles]
      summary: 新增常用参赛人
      x-auth: app
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ProfileInput'
      responses:
        '201':
          description: 已创建
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/RunnerProfile'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
  /app/profiles/{id}:
    put:
      operationId: appUpdateProfile
      tags: [app-profiles]
      summary: 修改常用参赛人；idNo 省略或为空串时保留原证件号
      x-auth: app
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: integer
            format: int64
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ProfileInput'
      responses:
        '200':
          description: 已修改
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/RunnerProfile'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
    delete:
      operationId: appDeleteProfile
      tags: [app-profiles]
      summary: 删除常用参赛人
      x-auth: app
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: integer
            format: int64
      responses:
        '204':
          description: 已删除
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
```

在 `components.schemas` 末尾追加：

```yaml
    Gender:
      type: string
      enum: [M, F, X]
    IdType:
      type: string
      enum: [NATIONAL_ID, PASSPORT, OTHER]
    TShirtSize:
      type: string
      enum: [XS, S, M, L, XL, XXL]
    ProfileInput:
      type: object
      required: [fullName, gender, birthDate, nationality, idType, phone, emergencyName, emergencyPhone, tshirtSize]
      properties:
        fullName:
          type: string
        gender:
          $ref: '#/components/schemas/Gender'
        birthDate:
          type: string
          format: date
        nationality:
          type: string
          description: ISO 3166-1 alpha-2，如 KH
        idType:
          $ref: '#/components/schemas/IdType'
        idNo:
          type: string
          description: 新建时必填；修改时省略或为空串表示保留原证件号
        phone:
          type: string
          description: E.164，如 +85512345678
        email:
          type: string
        emergencyName:
          type: string
        emergencyPhone:
          type: string
        tshirtSize:
          $ref: '#/components/schemas/TShirtSize'
        isSelf:
          type: boolean
          default: false
    RunnerProfile:
      type: object
      required: [id, fullName, gender, birthDate, nationality, idType, idNoMasked, phone, email, emergencyName, emergencyPhone, tshirtSize, isSelf]
      properties:
        id:
          type: integer
          format: int64
        fullName:
          type: string
        gender:
          $ref: '#/components/schemas/Gender'
        birthDate:
          type: string
          format: date
        nationality:
          type: string
        idType:
          $ref: '#/components/schemas/IdType'
        idNoMasked:
          type: string
          description: 只保留后 4 位，其余为 *
        phone:
          type: string
        email:
          type: string
          description: 未填写时为空串
        emergencyName:
          type: string
        emergencyPhone:
          type: string
        tshirtSize:
          $ref: '#/components/schemas/TShirtSize'
        isSelf:
          type: boolean
    RunnerProfileList:
      type: object
      required: [items]
      properties:
        items:
          type: array
          items:
            $ref: '#/components/schemas/RunnerProfile'
```

运行：

```bash
make gen
```

Expected：`api.gen.go` 出现 `ProfileInput{BirthDate openapi_types.Date; Email *string; …; IdNo *string; IsSelf *bool; …; TshirtSize TShirtSize}`、`RunnerProfile`、`AppUpdateProfileRequestObject{Id int64; Body *AppUpdateProfileJSONRequestBody}`、`AppDeleteProfile204Response`；`permissions.gen.go` 中四个新操作均为 `{Kind: AuthApp}`。

- [ ] **Step 11: 写参赛人接口的失败测试**

在 `api/internal/httpapi/runner_http_test.go` 的 import 块增加 `"fmt"`，并在文件末尾追加：

```go
func profileBody() map[string]any {
	return map[string]any{
		"fullName":       "Sok Dara",
		"gender":         "M",
		"birthDate":      "1990-05-01",
		"nationality":    "KH",
		"idType":         "NATIONAL_ID",
		"idNo":           "N0 1234-5678",
		"phone":          "+85512345678",
		"email":          "dara@example.com",
		"emergencyName":  "Sok Chenda",
		"emergencyPhone": "+85598765432",
		"tshirtSize":     "M",
		"isSelf":         true,
	}
}

func assertNoFullIDNo(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	body := rec.Body.String()
	assert.NotContains(t, body, "N012345678")
	assert.NotContains(t, body, "N0 1234-5678")
	assert.NotContains(t, body, "1234-5678")
}

func TestAppProfilesCRUDNeverReturnsFullIDNo(t *testing.T) {
	e := newRunnerEnv(t)
	auth := bearer(e.loginRunner(t, 10001, "Dara Sok").Token)

	rec := e.do(t, http.MethodPost, "/api/app/profiles", profileBody(), auth)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	assertNoFullIDNo(t, rec)
	var created apigen.RunnerProfile
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &created))
	assert.Equal(t, "******5678", created.IdNoMasked)
	assert.True(t, created.IsSelf)
	assert.Equal(t, "1990-05-01", created.BirthDate.Time.Format(time.DateOnly))
	assert.Equal(t, apigen.TShirtSize("M"), created.TshirtSize)

	rec = e.do(t, http.MethodGet, "/api/app/profiles", nil, auth)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assertNoFullIDNo(t, rec)
	var list apigen.RunnerProfileList
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &list))
	require.Len(t, list.Items, 1)
	assert.Equal(t, created.Id, list.Items[0].Id)

	update := profileBody()
	delete(update, "idNo")
	update["fullName"] = "Sok Dara Jr"
	rec = e.do(t, http.MethodPut, fmt.Sprintf("/api/app/profiles/%d", created.Id), update, auth)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assertNoFullIDNo(t, rec)
	var updated apigen.RunnerProfile
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &updated))
	assert.Equal(t, "Sok Dara Jr", updated.FullName)
	assert.Equal(t, "******5678", updated.IdNoMasked)

	rec = e.do(t, http.MethodDelete, fmt.Sprintf("/api/app/profiles/%d", created.Id), nil, auth)
	require.Equal(t, http.StatusNoContent, rec.Code, rec.Body.String())

	rec = e.do(t, http.MethodGet, "/api/app/profiles", nil, auth)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"items":[]}`, rec.Body.String())
}

func TestAppProfilesOfAnotherRunnerReturn404(t *testing.T) {
	e := newRunnerEnv(t)
	owner := bearer(e.loginRunner(t, 10001, "Dara Sok").Token)
	other := bearer(e.loginRunner(t, 10002, "Sokha Chan").Token)
	rec := e.do(t, http.MethodPost, "/api/app/profiles", profileBody(), owner)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var created apigen.RunnerProfile
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &created))
	path := fmt.Sprintf("/api/app/profiles/%d", created.Id)

	rec = e.do(t, http.MethodPut, path, profileBody(), other)
	assert.Equal(t, http.StatusNotFound, rec.Code)
	assert.Equal(t, apperr.CodeNotFound, decodeRunnerError(t, rec).Error.Code)

	rec = e.do(t, http.MethodDelete, path, nil, other)
	assert.Equal(t, http.StatusNotFound, rec.Code)
	assert.Equal(t, apperr.CodeNotFound, decodeRunnerError(t, rec).Error.Code)

	rec = e.do(t, http.MethodGet, "/api/app/profiles", nil, other)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"items":[]}`, rec.Body.String())

	rec = e.do(t, http.MethodGet, "/api/app/profiles", nil, owner)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"fullName":"Sok Dara"`)
}

func TestAppCreateProfileReturnsLocalizedFieldErrors(t *testing.T) {
	e := newRunnerEnv(t)
	auth := bearer(e.loginRunner(t, 10001, "Dara Sok").Token)
	body := profileBody()
	body["phone"] = "012345678"
	body["fullName"] = "   "
	delete(body, "idNo")

	rec := e.do(t, http.MethodPost, "/api/app/profiles?lang=en", body, auth)

	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	resp := decodeRunnerError(t, rec)
	assert.Equal(t, apperr.CodeValidation, resp.Error.Code)
	require.NotNil(t, resp.Error.Fields)
	assert.Equal(t, map[string]string{
		"phone":    e.catalog.T(i18n.EN, "field.invalid", nil),
		"fullName": e.catalog.T(i18n.EN, "field.required", nil),
		"idNo":     e.catalog.T(i18n.EN, "field.required", nil),
	}, *resp.Error.Fields)
}

func TestAppProfilesRequireRunnerToken(t *testing.T) {
	e := newRunnerEnv(t)

	rec := e.do(t, http.MethodGet, "/api/app/profiles", nil, nil)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Equal(t, apperr.CodeUnauthenticated, decodeRunnerError(t, rec).Error.Code)
}
```

运行：

```bash
cd api && env $COLIMA_ENV go test ./internal/httpapi/
```

Expected：FAIL，编译错误 `*Server does not implement apigen.StrictServerInterface (missing method AppCreateProfile)`。

- [ ] **Step 12: 实现参赛人 handler**

`api/internal/runner/handlers.go` 的 import 块替换为：

```go
import (
	"context"
	"net/http"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
)
```

在文件末尾追加：

```go
func (h *Handlers) AppListProfiles(ctx context.Context, _ apigen.AppListProfilesRequestObject) (apigen.AppListProfilesResponseObject, error) {
	u, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	profiles, err := h.svc.ListProfiles(ctx, u)
	if err != nil {
		return nil, err
	}
	items := make([]apigen.RunnerProfile, 0, len(profiles))
	for _, p := range profiles {
		items = append(items, toRunnerProfile(p))
	}
	return apigen.AppListProfiles200JSONResponse{Items: items}, nil
}

func (h *Handlers) AppCreateProfile(ctx context.Context, req apigen.AppCreateProfileRequestObject) (apigen.AppCreateProfileResponseObject, error) {
	u, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	data, isSelf := profileInputFromAPI(*req.Body)
	p, err := h.svc.CreateProfile(ctx, u, data, isSelf)
	if err != nil {
		return nil, err
	}
	return apigen.AppCreateProfile201JSONResponse(toRunnerProfile(p)), nil
}

func (h *Handlers) AppUpdateProfile(ctx context.Context, req apigen.AppUpdateProfileRequestObject) (apigen.AppUpdateProfileResponseObject, error) {
	u, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	data, isSelf := profileInputFromAPI(*req.Body)
	p, err := h.svc.UpdateProfile(ctx, u, req.Id, data, isSelf)
	if err != nil {
		return nil, err
	}
	return apigen.AppUpdateProfile200JSONResponse(toRunnerProfile(p)), nil
}

func (h *Handlers) AppDeleteProfile(ctx context.Context, req apigen.AppDeleteProfileRequestObject) (apigen.AppDeleteProfileResponseObject, error) {
	u, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	if err := h.svc.DeleteProfile(ctx, u, req.Id); err != nil {
		return nil, err
	}
	return apigen.AppDeleteProfile204Response{}, nil
}

func profileInputFromAPI(b apigen.ProfileInput) (ProfileData, bool) {
	data := ProfileData{
		FullName:       b.FullName,
		Gender:         string(b.Gender),
		BirthDate:      b.BirthDate.Time,
		Nationality:    b.Nationality,
		IDType:         string(b.IdType),
		IDNo:           derefString(b.IdNo),
		Phone:          b.Phone,
		Email:          derefString(b.Email),
		EmergencyName:  b.EmergencyName,
		EmergencyPhone: b.EmergencyPhone,
		TShirtSize:     string(b.TshirtSize),
	}
	return data, b.IsSelf != nil && *b.IsSelf
}

// toRunnerProfile 只输出掩码后的证件号。
func toRunnerProfile(p Profile) apigen.RunnerProfile {
	return apigen.RunnerProfile{
		Id:             p.ID,
		FullName:       p.Data.FullName,
		Gender:         apigen.Gender(p.Data.Gender),
		BirthDate:      openapi_types.Date{Time: p.Data.BirthDate},
		Nationality:    p.Data.Nationality,
		IdType:         apigen.IdType(p.Data.IDType),
		IdNoMasked:     p.IDNoMasked,
		Phone:          p.Data.Phone,
		Email:          p.Data.Email,
		EmergencyName:  p.Data.EmergencyName,
		EmergencyPhone: p.Data.EmergencyPhone,
		TshirtSize:     apigen.TShirtSize(p.Data.TShirtSize),
		IsSelf:         p.IsSelf,
	}
}
```

运行：

```bash
cd api && env $COLIMA_ENV go test ./internal/httpapi/ ./internal/runner/
```

Expected：两个包都 `ok`。

- [ ] **Step 13: 全量检查**

```bash
make gen && git status --porcelain api/internal/httpapi/apigen packages/api-client/src/schema.d.ts api/internal/runner/store
cd api && env $COLIMA_ENV go test ./...
cd api && go tool golangci-lint run ./...
pnpm --filter @werun/api-client typecheck
```

Expected：`make gen` 后没有新差异；测试全部 `ok`；lint `0 issues.`（如报 gofmt 对齐问题，执行 `cd api && gofmt -w internal/runner internal/httpapi cmd/werun` 后重跑）；类型检查通过。

- [ ] **Step 14: 提交**

```bash
git add api/db/queries/runner.sql api/internal/runner \
  api/openapi/openapi.yaml api/internal/httpapi/apigen/api.gen.go api/internal/httpapi/apigen/permissions.gen.go \
  packages/api-client/src/schema.d.ts api/internal/httpapi/runner_http_test.go
git commit -m "$(cat <<'EOF'
feat(api): saved runner profiles with encrypted ID numbers

- ProfileData normalization and field validation (field.required / field.invalid)
- ID numbers AES-GCM encrypted + HMAC hashed, responses only carry the masked number
- one is_self profile per user, empty idNo on update keeps the stored number
- CreateProfileTx / LoadProfileForOrder for the order flow
- appListProfiles / appCreateProfile / appUpdateProfile / appDeleteProfile

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
)"
```

---

### Task 9: 同意书

**Files:**
- Modify: `api/internal/platform/apperr/apperr.go`、`api/internal/platform/apperr/apperr_test.go`
- Modify: `api/internal/platform/i18n/messages.zh.json`、`messages.en.json`、`messages.km.json`
- Modify: `api/db/queries/runner.sql`（追加同意书查询）
- Modify（生成）: `api/internal/runner/store/`
- Modify: `api/internal/runner/model.go`（追加同意书类型）
- Create: `api/internal/runner/consents.go`
- Test: `api/internal/runner/consents_test.go`
- Create: `api/cmd/werun/publishconsent.go`
- Test: `api/cmd/werun/publishconsent_test.go`
- Modify: `api/cmd/werun/main.go`
- Modify: `api/openapi/openapi.yaml`
- Modify（生成）: `api/internal/httpapi/apigen/api.gen.go`、`api/internal/httpapi/apigen/permissions.gen.go`、`packages/api-client/src/schema.d.ts`
- Modify: `api/internal/runner/handlers.go`（追加 `AppGetConsent`）
- Test: `api/internal/httpapi/runner_http_test.go`（`runnerEnv` 增加 `runners` 字段，追加同意书测试）

**Interfaces:**
- Consumes:
  - Task 2：迁移 0010 的 `disclaimer_versions.purpose`、`registration_consents`（`CHECK (num_nonnulls(reg_order_id, free_signup_id) = 1)`）
  - Task 7：`runner.Service`、`User`、`parseIP`、`optionalString`、测试辅助 `newFixture`、`fixture.login`、`testMeta`、`baseNow`、`countRows`、`requireAppError`、`fieldKeys`
  - Task 8：`platformZone`、`dateOnly`
  - 脚手架：`audit.Record`、`db.InTx`、`i18n.Lang`、`i18n.Parse`、`describeError`、`Bootstrap`
- Produces（与 overview 一致）:
  ```go
  type ConsentItem struct { Key, Title, Description string }
  type ConsentVersion struct { Version, Lang string; EffectiveDate time.Time; FullText string; Items []ConsentItem }
  type ConsentAcceptance struct { Version, Lang string; CheckedItems []string }
  type ConsentLink struct { RegOrderID, FreeSignupID *int64 } // 恰好一个非空
  type PublishConsentInput struct { Purpose, Version, Lang string; EffectiveDate time.Time; FullText string; Items []ConsentItem }
  func (s *Service) PublishConsent(ctx context.Context, in PublishConsentInput) error
  func (s *Service) CurrentConsent(ctx context.Context, purpose string, lang i18n.Lang) (ConsentVersion, error)
  func (s *Service) SignConsent(ctx context.Context, tx pgx.Tx, u User, acc ConsentAcceptance, meta httpx.Meta, link ConsentLink) error
  ```
  - 常量 `runner.PurposeCommunity = "COMMUNITY"`、`runner.PurposeRegistration = "REGISTRATION"`
  - `apperr.CodeConsentInvalid = "CONSENT_INVALID"`（422）；审计 action `consent.publish`（`EntityType = "disclaimer_version"`，`EntityID = 0`，`ActorType = "SYSTEM"`）
  - operationId `appGetConsent`（`GET /app/consents?purpose=REGISTRATION&lang=`，`x-auth: app`）；OpenAPI 组件 `ConsentVersion`、`ConsentItem`
  - 命令：`werun publish-consent --purpose --version --lang --effective-date --file <path|-> --items '<json>'`（`--items` 格式见契约补充第 9 条）

**SignConsent 的错误**：
- `ConsentLink` 不是恰好一个非空：返回普通 error（这是调用方的编程错误），不写任何数据。
- 以下情况一律返回 422 `CONSENT_INVALID`：版本 `(version, lang)` 不存在；`purpose` 不是 `REGISTRATION`；`CheckedItems` 有重复、缺项或多出版本里没有的 key。
- `disclaimer_signatures.checked_items` 按版本中勾选项的顺序写入 key 数组。

- [ ] **Step 1: 新增错误码 CONSENT_INVALID**

`api/internal/platform/apperr/apperr_test.go`：

旧：

```go
	assert.Len(t, apperr.AllCodes, 22)
```

新：

```go
	assert.Len(t, apperr.AllCodes, 23)
```

运行 `cd api && go test ./internal/platform/apperr/`，Expected：FAIL，`should have 23 item(s), but has 22`。

`api/internal/platform/apperr/apperr.go` 常量块末尾追加 `CodeConsentInvalid = "CONSENT_INVALID"`，`AllCodes` 末尾追加 `CodeConsentInvalid,`。

三份文案文件各在 `"field.required"` 之前加一行：

`messages.zh.json`：

```json
  "CONSENT_INVALID": "同意书已更新或还有条款没有勾选，请刷新后重新确认。",
```

`messages.en.json`：

```json
  "CONSENT_INVALID": "The consent form has changed or not every item is checked. Refresh and confirm again.",
```

`messages.km.json`：

```json
  "CONSENT_INVALID": "កិច្ចព្រមព្រៀងត្រូវបានកែប្រែ ឬអ្នកមិនទាន់គូសធីកគ្រប់ចំណុច។ សូមផ្ទុកទំព័រឡើងវិញ ហើយបញ្ជាក់ម្តងទៀត។",
```

运行：

```bash
cd api && go test ./internal/platform/apperr/ ./internal/platform/i18n/
```

Expected：两个包都 `ok`。

- [ ] **Step 2: 追加同意书查询并生成代码**

在 `api/db/queries/runner.sql` 末尾追加：

```sql
-- name: InsertConsentVersion :exec
INSERT INTO disclaimer_versions (version, lang, effective_date, full_text, items, text_sha256, purpose)
VALUES (@version, @lang, @effective_date, @full_text, @items, @text_sha256, @purpose);

-- name: GetCurrentConsent :one
SELECT version, lang, effective_date, full_text, items
FROM disclaimer_versions
WHERE purpose = @purpose
  AND lang = @lang
  AND effective_date <= @today::date
ORDER BY effective_date DESC, created_at DESC, version DESC
LIMIT 1;

-- name: GetConsentVersion :one
SELECT version, lang, purpose, items, text_sha256
FROM disclaimer_versions
WHERE version = @version AND lang = @lang;

-- name: InsertConsentSignature :one
INSERT INTO disclaimer_signatures (version, lang, text_sha256, user_id, checked_items, signed_at, ip, user_agent)
VALUES (@version, @lang, @text_sha256, @user_id, @checked_items, @signed_at, @ip, @user_agent)
RETURNING id;

-- name: InsertRegistrationConsent :exec
INSERT INTO registration_consents (signature_id, reg_order_id, free_signup_id)
VALUES (@signature_id, sqlc.narg(reg_order_id), sqlc.narg(free_signup_id));
```

运行：

```bash
cd api && go tool sqlc generate && grep -n "type InsertConsentSignatureParams" -A10 internal/runner/store/runner.sql.go
```

Expected：`InsertConsentSignatureParams{Version string; Lang string; TextSha256 []byte; UserID int64; CheckedItems []byte; SignedAt time.Time; Ip *netip.Addr; UserAgent *string}`；`GetCurrentConsentParams{Purpose string; Lang string; Today time.Time}`；`InsertRegistrationConsentParams{SignatureID int64; RegOrderID *int64; FreeSignupID *int64}`。

- [ ] **Step 3: 写同意书的数据库失败测试**

创建 `api/internal/runner/consents_test.go`：

```go
package runner_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/runner"
)

func day(y int, m time.Month, d int) time.Time {
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

func registrationConsent(version, lang string, effective time.Time) runner.PublishConsentInput {
	return runner.PublishConsentInput{
		Purpose:       runner.PurposeRegistration,
		Version:       version,
		Lang:          lang,
		EffectiveDate: effective,
		FullText:      "# WeRun 报名同意书\n\n参赛者确认身体状况适合参赛。\n\n版本 " + version + " / " + lang + "\n",
		Items: []runner.ConsentItem{
			{Key: "rules", Title: "我已阅读并遵守赛事规则", Description: "包括关门时间与赛道规定"},
			{Key: "health", Title: "我的身体状况适合参赛"},
			{Key: "terms", Title: "我同意平台服务条款"},
		},
	}
}

// insertFreeSignup 建一场免费活动、一个组别和一条免费报名，返回报名 ID，给签署记录挂关联用。
func insertFreeSignup(t *testing.T, pool *pgxpool.Pool, userID int64) int64 {
	t.Helper()
	ctx := context.Background()
	var eventID, categoryID, signupID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO events (slug, event_type, organizer_type, name, city, race_date)
		 VALUES ('consent-fun-run', 'FREE_ACTIVITY', 'OFFICIAL', '{"en":"Consent fun run"}', 'Phnom Penh', '2026-10-01')
		 RETURNING id`).Scan(&eventID))
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO event_categories (event_id, code, name, distance_m, capacity)
		 VALUES ($1, '5K', '{"en":"5K"}', 5000, 100)
		 RETURNING id`, eventID).Scan(&categoryID))
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO free_signups (signup_no, event_id, category_id, user_id, full_name, phone_e164, source)
		 VALUES ('FS0000CONS', $1, $2, $3, 'Sok Dara', '+85512345678', 'TELEGRAM')
		 RETURNING id`, eventID, categoryID, userID).Scan(&signupID))
	return signupID
}

func TestPublishConsentStoresHashItemsAndAudit(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	in := registrationConsent("REG-v1", "zh", day(2026, 9, 1))

	require.NoError(t, f.svc.PublishConsent(ctx, in))

	var purpose, fullText string
	var effective time.Time
	var items, hash []byte
	require.NoError(t, f.pool.QueryRow(ctx,
		`SELECT purpose, effective_date, full_text, items, text_sha256
		 FROM disclaimer_versions WHERE version = 'REG-v1' AND lang = 'zh'`).
		Scan(&purpose, &effective, &fullText, &items, &hash))
	assert.Equal(t, runner.PurposeRegistration, purpose)
	assert.True(t, effective.Equal(day(2026, 9, 1)))
	assert.Equal(t, in.FullText, fullText)
	sum := sha256.Sum256([]byte(in.FullText))
	assert.Equal(t, sum[:], hash)
	assert.JSONEq(t, `[
		{"k":"rules","t":"我已阅读并遵守赛事规则","d":"包括关门时间与赛道规定"},
		{"k":"health","t":"我的身体状况适合参赛"},
		{"k":"terms","t":"我同意平台服务条款"}
	]`, string(items))
	assert.Equal(t, 1, countRows(t, f.pool,
		`SELECT count(*) FROM audit_logs
		 WHERE action = 'consent.publish' AND actor_type = 'SYSTEM' AND entity_type = 'disclaimer_version'
		   AND entity_id = 0 AND after_data->>'version' = 'REG-v1' AND after_data->>'lang' = 'zh'`))
}

func TestPublishConsentVersionIsImmutable(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	require.NoError(t, f.svc.PublishConsent(ctx, registrationConsent("REG-v1", "en", day(2026, 9, 1))))

	changed := registrationConsent("REG-v1", "en", day(2026, 9, 2))
	changed.FullText = "different text"
	err := f.svc.PublishConsent(ctx, changed)

	requireAppError(t, err, http.StatusUnprocessableEntity, apperr.CodeValidation)
	assert.Equal(t, map[string]string{"version": "field.invalid"}, fieldKeys(t, err))
	assert.Equal(t, 1, countRows(t, f.pool, `SELECT count(*) FROM disclaimer_versions WHERE version = 'REG-v1'`))
	assert.Equal(t, 1, countRows(t, f.pool, `SELECT count(*) FROM audit_logs WHERE action = 'consent.publish'`))

	require.NoError(t, f.svc.PublishConsent(ctx, registrationConsent("REG-v1", "km", day(2026, 9, 1))), "同一版本的另一种语言可以发布")
	assert.Equal(t, 2, countRows(t, f.pool, `SELECT count(*) FROM disclaimer_versions WHERE version = 'REG-v1'`))

	_, err = f.pool.Exec(ctx, `UPDATE disclaimer_versions SET full_text = 'tampered' WHERE version = 'REG-v1'`)
	require.Error(t, err, "迁移里的 forbid_mutation 触发器禁止修改已发布版本")
}

func TestPublishConsentValidatesInput(t *testing.T) {
	f := newFixture(t)
	cases := []struct {
		name   string
		mutate func(in *runner.PublishConsentInput)
		want   map[string]string
	}{
		{"unknown purpose", func(in *runner.PublishConsentInput) { in.Purpose = "MARKETING" }, map[string]string{"purpose": "field.invalid"}},
		{"missing purpose", func(in *runner.PublishConsentInput) { in.Purpose = "" }, map[string]string{"purpose": "field.required"}},
		{"version with space", func(in *runner.PublishConsentInput) { in.Version = "REG v1" }, map[string]string{"version": "field.invalid"}},
		{"missing version", func(in *runner.PublishConsentInput) { in.Version = "" }, map[string]string{"version": "field.required"}},
		{"unsupported lang", func(in *runner.PublishConsentInput) { in.Lang = "fr" }, map[string]string{"lang": "field.invalid"}},
		{"missing effective date", func(in *runner.PublishConsentInput) { in.EffectiveDate = time.Time{} }, map[string]string{"effectiveDate": "field.required"}},
		{"blank full text", func(in *runner.PublishConsentInput) { in.FullText = " \n " }, map[string]string{"fullText": "field.required"}},
		{"no items", func(in *runner.PublishConsentInput) { in.Items = nil }, map[string]string{"items": "field.required"}},
		{"duplicate key", func(in *runner.PublishConsentInput) { in.Items[1].Key = "rules" }, map[string]string{"items[1].key": "field.invalid"}},
		{"bad key", func(in *runner.PublishConsentInput) { in.Items[0].Key = "Rules!" }, map[string]string{"items[0].key": "field.invalid"}},
		{"missing key", func(in *runner.PublishConsentInput) { in.Items[2].Key = "" }, map[string]string{"items[2].key": "field.required"}},
		{"blank title", func(in *runner.PublishConsentInput) { in.Items[0].Title = "  " }, map[string]string{"items[0].title": "field.required"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := registrationConsent("REG-v1", "en", day(2026, 9, 1))
			tc.mutate(&in)

			err := f.svc.PublishConsent(context.Background(), in)

			requireAppError(t, err, http.StatusUnprocessableEntity, apperr.CodeValidation)
			assert.Equal(t, tc.want, fieldKeys(t, err))
		})
	}
	assert.Equal(t, 0, countRows(t, f.pool, `SELECT count(*) FROM disclaimer_versions`))
}

func TestCurrentConsentPicksLatestEffectiveVersionAndFallsBack(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	for _, in := range []runner.PublishConsentInput{
		registrationConsent("REG-v1", "en", day(2026, 1, 1)),
		registrationConsent("REG-v2", "en", day(2026, 9, 14)),
		registrationConsent("REG-v3", "en", day(2026, 12, 1)),
		registrationConsent("REG-v2", "zh", day(2026, 9, 1)),
		{
			Purpose: runner.PurposeCommunity, Version: "UGC-v9", Lang: "en", EffectiveDate: day(2026, 9, 10),
			FullText: "Community disclaimer", Items: []runner.ConsentItem{{Key: "safety", Title: "I run at my own risk"}},
		},
	} {
		require.NoError(t, f.svc.PublishConsent(ctx, in))
	}
	f.clock.t = time.Date(2026, 9, 14, 3, 0, 0, 0, time.UTC) // 金边 10:00

	got, err := f.svc.CurrentConsent(ctx, runner.PurposeRegistration, i18n.EN)
	require.NoError(t, err)
	assert.Equal(t, "REG-v2", got.Version)
	assert.Equal(t, "en", got.Lang)
	assert.True(t, got.EffectiveDate.Equal(day(2026, 9, 14)))
	assert.Equal(t, registrationConsent("REG-v2", "en", day(2026, 9, 14)).FullText, got.FullText)
	assert.Equal(t, []runner.ConsentItem{
		{Key: "rules", Title: "我已阅读并遵守赛事规则", Description: "包括关门时间与赛道规定"},
		{Key: "health", Title: "我的身体状况适合参赛"},
		{Key: "terms", Title: "我同意平台服务条款"},
	}, got.Items)

	got, err = f.svc.CurrentConsent(ctx, runner.PurposeRegistration, i18n.KM)
	require.NoError(t, err)
	assert.Equal(t, "REG-v2", got.Version)
	assert.Equal(t, "en", got.Lang, "没有高棉文版本时回退到英文")

	got, err = f.svc.CurrentConsent(ctx, runner.PurposeRegistration, i18n.ZH)
	require.NoError(t, err)
	assert.Equal(t, "zh", got.Lang)

	got, err = f.svc.CurrentConsent(ctx, runner.PurposeCommunity, i18n.EN)
	require.NoError(t, err)
	assert.Equal(t, "UGC-v9", got.Version, "不同 purpose 互不影响")

	f.clock.t = time.Date(2026, 9, 13, 16, 59, 59, 0, time.UTC) // 金边 9 月 13 日 23:59:59
	got, err = f.svc.CurrentConsent(ctx, runner.PurposeRegistration, i18n.EN)
	require.NoError(t, err)
	assert.Equal(t, "REG-v1", got.Version)

	f.clock.t = time.Date(2026, 9, 13, 17, 0, 0, 0, time.UTC) // 金边 9 月 14 日 00:00
	got, err = f.svc.CurrentConsent(ctx, runner.PurposeRegistration, i18n.EN)
	require.NoError(t, err)
	assert.Equal(t, "REG-v2", got.Version)
}

func TestCurrentConsentNotFoundAndInvalidPurpose(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()

	_, err := f.svc.CurrentConsent(ctx, runner.PurposeRegistration, i18n.ZH)
	requireAppError(t, err, http.StatusNotFound, apperr.CodeNotFound)

	require.NoError(t, f.svc.PublishConsent(ctx, registrationConsent("REG-v1", "en", day(2026, 12, 1))))
	_, err = f.svc.CurrentConsent(ctx, runner.PurposeRegistration, i18n.EN)
	requireAppError(t, err, http.StatusNotFound, apperr.CodeNotFound)

	_, err = f.svc.CurrentConsent(ctx, "MARKETING", i18n.EN)
	requireAppError(t, err, http.StatusUnprocessableEntity, apperr.CodeValidation)
	assert.Equal(t, map[string]string{"purpose": "field.invalid"}, fieldKeys(t, err))
}

func TestSignConsentWritesSignatureAndLink(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	in := registrationConsent("REG-v1", "km", day(2026, 9, 1))
	require.NoError(t, f.svc.PublishConsent(ctx, in))
	u := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"}).User
	signupID := insertFreeSignup(t, f.pool, u.ID)
	acc := runner.ConsentAcceptance{Version: "REG-v1", Lang: "km", CheckedItems: []string{"terms", "rules", "health"}}
	link := runner.ConsentLink{FreeSignupID: &signupID}

	stop := errors.New("stop")
	err := db.InTx(ctx, f.pool, func(tx pgx.Tx) error {
		require.NoError(t, f.svc.SignConsent(ctx, tx, u, acc, testMeta, link))
		return stop
	})
	require.ErrorIs(t, err, stop)
	assert.Equal(t, 0, countRows(t, f.pool, `SELECT count(*) FROM disclaimer_signatures`), "随调用方事务回滚")

	err = db.InTx(ctx, f.pool, func(tx pgx.Tx) error {
		return f.svc.SignConsent(ctx, tx, u, acc, testMeta, link)
	})
	require.NoError(t, err)

	var signatureID int64
	var checked, hash []byte
	var signedAt time.Time
	var ip, userAgent string
	require.NoError(t, f.pool.QueryRow(ctx,
		`SELECT id, checked_items, text_sha256, signed_at, host(ip), user_agent
		 FROM disclaimer_signatures WHERE user_id = $1 AND version = 'REG-v1' AND lang = 'km'`, u.ID).
		Scan(&signatureID, &checked, &hash, &signedAt, &ip, &userAgent))
	assert.JSONEq(t, `["rules","health","terms"]`, string(checked), "按版本中的顺序记录")
	sum := sha256.Sum256([]byte(in.FullText))
	assert.Equal(t, sum[:], hash)
	assert.True(t, signedAt.Equal(baseNow))
	assert.Equal(t, "203.0.113.7", ip)
	assert.Equal(t, "runner-test", userAgent)
	assert.Equal(t, 1, countRows(t, f.pool,
		`SELECT count(*) FROM registration_consents
		 WHERE signature_id = $1 AND free_signup_id = $2 AND reg_order_id IS NULL`, signatureID, signupID))
}

func TestSignConsentRejectsInvalidAcceptance(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	require.NoError(t, f.svc.PublishConsent(ctx, registrationConsent("REG-v1", "en", day(2026, 9, 1))))
	require.NoError(t, f.svc.PublishConsent(ctx, runner.PublishConsentInput{
		Purpose: runner.PurposeCommunity, Version: "UGC-v1", Lang: "en", EffectiveDate: day(2026, 9, 1),
		FullText: "Community disclaimer", Items: []runner.ConsentItem{{Key: "safety", Title: "I run at my own risk"}},
	}))
	u := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"}).User
	signupID := insertFreeSignup(t, f.pool, u.ID)

	cases := map[string]runner.ConsentAcceptance{
		"incomplete items":  {Version: "REG-v1", Lang: "en", CheckedItems: []string{"rules", "health"}},
		"no items":          {Version: "REG-v1", Lang: "en"},
		"extra item":        {Version: "REG-v1", Lang: "en", CheckedItems: []string{"rules", "health", "terms", "marketing"}},
		"duplicate item":    {Version: "REG-v1", Lang: "en", CheckedItems: []string{"rules", "health", "health"}},
		"unknown version":   {Version: "REG-v404", Lang: "en", CheckedItems: []string{"rules", "health", "terms"}},
		"missing language":  {Version: "REG-v1", Lang: "zh", CheckedItems: []string{"rules", "health", "terms"}},
		"community version": {Version: "UGC-v1", Lang: "en", CheckedItems: []string{"safety"}},
	}
	for name, acc := range cases {
		t.Run(name, func(t *testing.T) {
			err := db.InTx(ctx, f.pool, func(tx pgx.Tx) error {
				return f.svc.SignConsent(ctx, tx, u, acc, testMeta, runner.ConsentLink{FreeSignupID: &signupID})
			})
			requireAppError(t, err, http.StatusUnprocessableEntity, apperr.CodeConsentInvalid)
		})
	}
	assert.Equal(t, 0, countRows(t, f.pool, `SELECT count(*) FROM disclaimer_signatures`))
	assert.Equal(t, 0, countRows(t, f.pool, `SELECT count(*) FROM registration_consents`))
}

func TestSignConsentRequiresExactlyOneLink(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	require.NoError(t, f.svc.PublishConsent(ctx, registrationConsent("REG-v1", "en", day(2026, 9, 1))))
	u := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"}).User
	acc := runner.ConsentAcceptance{Version: "REG-v1", Lang: "en", CheckedItems: []string{"rules", "health", "terms"}}
	orderID, signupID := int64(1), int64(2)

	for name, link := range map[string]runner.ConsentLink{
		"neither": {},
		"both":    {RegOrderID: &orderID, FreeSignupID: &signupID},
	} {
		t.Run(name, func(t *testing.T) {
			err := db.InTx(ctx, f.pool, func(tx pgx.Tx) error {
				return f.svc.SignConsent(ctx, tx, u, acc, testMeta, link)
			})
			require.Error(t, err)
			_, isAppErr := apperr.As(err)
			assert.False(t, isAppErr, "关联写错是调用方的编程错误，不是业务错误")
		})
	}
	assert.Equal(t, 0, countRows(t, f.pool, `SELECT count(*) FROM disclaimer_signatures`))

	// 数据库兜底：registration_consents 的 CHECK 约束拒绝两个关联都为空的行
	var signatureID int64
	require.NoError(t, f.pool.QueryRow(ctx,
		`INSERT INTO disclaimer_signatures (version, lang, text_sha256, user_id, checked_items)
		 VALUES ('REG-v1', 'en', $1, $2, '[]') RETURNING id`, []byte{0x01}, u.ID).Scan(&signatureID))
	_, err := f.pool.Exec(ctx, `INSERT INTO registration_consents (signature_id) VALUES ($1)`, signatureID)
	var pgErr *pgconn.PgError
	require.ErrorAs(t, err, &pgErr)
	assert.Equal(t, "23514", pgErr.Code, "check_violation")
}
```

- [ ] **Step 4: 运行同意书测试，确认失败**

```bash
cd api && env $COLIMA_ENV go test -run 'Consent' ./internal/runner/
```

Expected：FAIL，编译错误 `undefined: runner.PublishConsentInput`、`undefined: runner.PurposeRegistration`。

- [ ] **Step 5: 实现同意书模型与服务**

在 `api/internal/runner/model.go` 末尾追加：

```go
// ConsentItem 是同意书里需要逐项勾选的一条。
type ConsentItem struct {
	Key, Title, Description string
}

// ConsentVersion 是一版已发布的同意书。
type ConsentVersion struct {
	Version, Lang string
	EffectiveDate time.Time
	FullText      string
	Items         []ConsentItem
}

// ConsentAcceptance 是跑者提交的签署内容。
type ConsentAcceptance struct {
	Version, Lang string
	CheckedItems  []string
}

// ConsentLink 指明签署记录关联的订单或免费报名，恰好一个非空。
type ConsentLink struct {
	RegOrderID, FreeSignupID *int64
}

// PublishConsentInput 是 werun publish-consent 的输入。
type PublishConsentInput struct {
	Purpose, Version, Lang string
	EffectiveDate          time.Time
	FullText               string
	Items                  []ConsentItem
}
```

创建 `api/internal/runner/consents.go`：

```go
package runner

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strings"
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

// 同意书用途，对应 disclaimer_versions.purpose。
const (
	PurposeCommunity    = "COMMUNITY"
	PurposeRegistration = "REGISTRATION"

	maxConsentItems              = 20
	maxConsentItemTitleLen       = 200
	maxConsentItemDescriptionLen = 1000
)

var (
	consentVersionPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
	consentItemKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)
	consentLangs          = []string{string(i18n.ZH), string(i18n.EN), string(i18n.KM)}
)

func init() {
	// 版本发布后不可修改：同一 (version, lang) 再次发布时撞主键
	apperr.RegisterConstraint("disclaimer_versions_pkey", func() *apperr.Error {
		return apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation).
			WithField("version", "field.invalid", nil)
	})
}

// consentItemJSON 是 disclaimer_versions.items 列中每个元素的格式。
type consentItemJSON struct {
	K string `json:"k"`
	T string `json:"t"`
	D string `json:"d,omitempty"`
}

// PublishConsent 发布一版同意书（text_sha256 = SHA-256(full_text)），写审计 consent.publish。
func (s *Service) PublishConsent(ctx context.Context, in PublishConsentInput) error {
	if err := validatePublishConsent(in); err != nil {
		return err
	}
	stored := make([]consentItemJSON, len(in.Items))
	keys := make([]string, len(in.Items))
	for i, item := range in.Items {
		stored[i] = consentItemJSON{K: item.Key, T: strings.TrimSpace(item.Title), D: strings.TrimSpace(item.Description)}
		keys[i] = item.Key
	}
	itemsJSON, err := json.Marshal(stored)
	if err != nil {
		return fmt.Errorf("runner: encode consent items: %w", err)
	}
	sum := sha256.Sum256([]byte(in.FullText))
	effective := dateOnly(in.EffectiveDate)

	return db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		if err := s.q.WithTx(tx).InsertConsentVersion(ctx, store.InsertConsentVersionParams{
			Version:       in.Version,
			Lang:          in.Lang,
			EffectiveDate: effective,
			FullText:      in.FullText,
			Items:         itemsJSON,
			TextSha256:    sum[:],
			Purpose:       in.Purpose,
		}); err != nil {
			return apperr.FromPG(err)
		}
		return audit.Record(ctx, tx, audit.Entry{
			ActorType:  "SYSTEM",
			Action:     "consent.publish",
			EntityType: "disclaimer_version",
			EntityID:   0,
			Summary: fmt.Sprintf("发布同意书 %s（%s，%s，%s 生效）",
				in.Version, in.Lang, in.Purpose, effective.Format(time.DateOnly)),
			After: map[string]any{
				"purpose":       in.Purpose,
				"version":       in.Version,
				"lang":          in.Lang,
				"effectiveDate": effective.Format(time.DateOnly),
				"textSha256":    hex.EncodeToString(sum[:]),
				"itemKeys":      keys,
			},
		})
	})
}

func validatePublishConsent(in PublishConsentInput) error {
	verr := apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)
	invalid := false
	add := func(field, key string) {
		verr = verr.WithField(field, key, nil)
		invalid = true
	}

	switch {
	case in.Purpose == "":
		add("purpose", "field.required")
	case in.Purpose != PurposeCommunity && in.Purpose != PurposeRegistration:
		add("purpose", "field.invalid")
	}
	switch {
	case in.Version == "":
		add("version", "field.required")
	case !consentVersionPattern.MatchString(in.Version):
		add("version", "field.invalid")
	}
	switch {
	case in.Lang == "":
		add("lang", "field.required")
	case !slices.Contains(consentLangs, in.Lang):
		add("lang", "field.invalid")
	}
	if in.EffectiveDate.IsZero() {
		add("effectiveDate", "field.required")
	}
	if strings.TrimSpace(in.FullText) == "" {
		add("fullText", "field.required")
	}
	switch {
	case len(in.Items) == 0:
		add("items", "field.required")
	case len(in.Items) > maxConsentItems:
		add("items", "field.invalid")
	}
	seen := make(map[string]bool, len(in.Items))
	for i, item := range in.Items {
		prefix := fmt.Sprintf("items[%d].", i)
		switch {
		case item.Key == "":
			add(prefix+"key", "field.required")
		case !consentItemKeyPattern.MatchString(item.Key) || seen[item.Key]:
			add(prefix+"key", "field.invalid")
		}
		seen[item.Key] = true
		title := strings.TrimSpace(item.Title)
		switch {
		case title == "":
			add(prefix+"title", "field.required")
		case utf8.RuneCountInString(title) > maxConsentItemTitleLen:
			add(prefix+"title", "field.invalid")
		}
		if utf8.RuneCountInString(strings.TrimSpace(item.Description)) > maxConsentItemDescriptionLen {
			add(prefix+"description", "field.invalid")
		}
	}

	if invalid {
		return verr
	}
	return nil
}

// CurrentConsent 取 effective_date <= 今天（柬埔寨时间）中最新的一版；请求语言没有时依次回退到英文、中文；都没有返回 NOT_FOUND。
func (s *Service) CurrentConsent(ctx context.Context, purpose string, lang i18n.Lang) (ConsentVersion, error) {
	if purpose != PurposeCommunity && purpose != PurposeRegistration {
		return ConsentVersion{}, apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation).
			WithField("purpose", "field.invalid", nil)
	}
	today := dateOnly(s.now().In(platformZone))
	for _, l := range consentLangOrder(lang) {
		row, err := s.q.GetCurrentConsent(ctx, store.GetCurrentConsentParams{
			Purpose: purpose,
			Lang:    string(l),
			Today:   today,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return ConsentVersion{}, fmt.Errorf("runner: load current %s consent in %s: %w", purpose, l, err)
		}
		items, err := decodeConsentItems(row.Items)
		if err != nil {
			return ConsentVersion{}, fmt.Errorf("runner: consent %s/%s: %w", row.Version, row.Lang, err)
		}
		return ConsentVersion{
			Version:       row.Version,
			Lang:          row.Lang,
			EffectiveDate: row.EffectiveDate,
			FullText:      row.FullText,
			Items:         items,
		}, nil
	}
	return ConsentVersion{}, apperr.New(http.StatusNotFound, apperr.CodeNotFound)
}

// SignConsent 在调用方事务里写 disclaimer_signatures 与 registration_consents。
func (s *Service) SignConsent(ctx context.Context, tx pgx.Tx, u User, acc ConsentAcceptance, meta httpx.Meta, link ConsentLink) error {
	if (link.RegOrderID == nil) == (link.FreeSignupID == nil) {
		return errors.New("runner: ConsentLink must set exactly one of RegOrderID and FreeSignupID")
	}
	q := s.q.WithTx(tx)
	row, err := q.GetConsentVersion(ctx, store.GetConsentVersionParams{Version: acc.Version, Lang: acc.Lang})
	if errors.Is(err, pgx.ErrNoRows) {
		return consentInvalid("version %q in %q not found", acc.Version, acc.Lang)
	}
	if err != nil {
		return fmt.Errorf("runner: load consent %s/%s: %w", acc.Version, acc.Lang, err)
	}
	if row.Purpose != PurposeRegistration {
		return consentInvalid("version %s/%s has purpose %s", row.Version, row.Lang, row.Purpose)
	}
	items, err := decodeConsentItems(row.Items)
	if err != nil {
		return fmt.Errorf("runner: consent %s/%s: %w", row.Version, row.Lang, err)
	}
	checked, ok := orderedCheckedItems(items, acc.CheckedItems)
	if !ok {
		return consentInvalid("checked items %v do not match version %s/%s", acc.CheckedItems, row.Version, row.Lang)
	}
	checkedJSON, err := json.Marshal(checked)
	if err != nil {
		return fmt.Errorf("runner: encode checked items: %w", err)
	}

	signatureID, err := q.InsertConsentSignature(ctx, store.InsertConsentSignatureParams{
		Version:      row.Version,
		Lang:         row.Lang,
		TextSha256:   row.TextSha256,
		UserID:       u.ID,
		CheckedItems: checkedJSON,
		SignedAt:     s.now(),
		Ip:           parseIP(meta.IP),
		UserAgent:    optionalString(meta.UserAgent),
	})
	if err != nil {
		return fmt.Errorf("runner: insert consent signature for user %d: %w", u.ID, err)
	}
	if err := q.InsertRegistrationConsent(ctx, store.InsertRegistrationConsentParams{
		SignatureID:  signatureID,
		RegOrderID:   link.RegOrderID,
		FreeSignupID: link.FreeSignupID,
	}); err != nil {
		return fmt.Errorf("runner: link consent signature %d: %w", signatureID, err)
	}
	return nil
}

func consentLangOrder(l i18n.Lang) []i18n.Lang {
	order := []i18n.Lang{l}
	for _, fallback := range []i18n.Lang{i18n.EN, i18n.ZH} {
		if !slices.Contains(order, fallback) {
			order = append(order, fallback)
		}
	}
	return order
}

func decodeConsentItems(raw []byte) ([]ConsentItem, error) {
	var stored []consentItemJSON
	if err := json.Unmarshal(raw, &stored); err != nil {
		return nil, fmt.Errorf("decode consent items: %w", err)
	}
	items := make([]ConsentItem, len(stored))
	for i, item := range stored {
		items[i] = ConsentItem{Key: item.K, Title: item.T, Description: item.D}
	}
	return items, nil
}

// orderedCheckedItems 要求 checked 恰好等于版本的全部 key（顺序无关、不得重复），返回按版本顺序排列的 key。
func orderedCheckedItems(items []ConsentItem, checked []string) ([]string, bool) {
	if len(checked) != len(items) {
		return nil, false
	}
	set := make(map[string]bool, len(checked))
	for _, key := range checked {
		if set[key] {
			return nil, false
		}
		set[key] = true
	}
	ordered := make([]string, 0, len(items))
	for _, item := range items {
		if !set[item.Key] {
			return nil, false
		}
		ordered = append(ordered, item.Key)
	}
	return ordered, true
}

// consentInvalid 返回 422 CONSENT_INVALID；具体原因只进日志。
func consentInvalid(format string, args ...any) *apperr.Error {
	return apperr.New(http.StatusUnprocessableEntity, apperr.CodeConsentInvalid).
		Wrap(fmt.Errorf("runner: consent invalid: "+format, args...))
}
```

- [ ] **Step 6: 运行 runner 包测试，确认通过**

```bash
cd api && env $COLIMA_ENV go test ./internal/runner/
```

Expected：`ok  werun/api/internal/runner`。

- [ ] **Step 7: 写 publish-consent 命令的失败测试**

创建 `api/cmd/werun/publishconsent_test.go`：

```go
package main

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/runner"
)

const consentItemsArg = `[{"k":"rules","t":"我已阅读并遵守赛事规则","d":"包括关门时间"},{"k":"health","t":"我的身体状况适合参赛"}]`

func consentArgs(file string, extra ...string) []string {
	args := []string{
		"--purpose", "REGISTRATION",
		"--version", "REG-v1",
		"--lang", "zh",
		"--effective-date", "2026-09-01",
		"--file", file,
		"--items", consentItemsArg,
	}
	return append(args, extra...)
}

func TestParsePublishConsentArgsReadsFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "consent.md")
	require.NoError(t, os.WriteFile(path, []byte("# 报名同意书\n\n正文\n"), 0o600))

	in, err := parsePublishConsentArgs(consentArgs(path), strings.NewReader("ignored"), io.Discard)

	require.NoError(t, err)
	assert.Equal(t, runner.PublishConsentInput{
		Purpose:       "REGISTRATION",
		Version:       "REG-v1",
		Lang:          "zh",
		EffectiveDate: time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC),
		FullText:      "# 报名同意书\n\n正文\n",
		Items: []runner.ConsentItem{
			{Key: "rules", Title: "我已阅读并遵守赛事规则", Description: "包括关门时间"},
			{Key: "health", Title: "我的身体状况适合参赛"},
		},
	}, in)
}

func TestParsePublishConsentArgsReadsStdin(t *testing.T) {
	in, err := parsePublishConsentArgs(consentArgs("-"), strings.NewReader("Consent body from stdin\n"), io.Discard)

	require.NoError(t, err)
	assert.Equal(t, "Consent body from stdin\n", in.FullText)
}

func TestParsePublishConsentArgsRejectsBadInput(t *testing.T) {
	path := filepath.Join(t.TempDir(), "consent.md")
	require.NoError(t, os.WriteFile(path, []byte("body"), 0o600))
	replace := func(flag, value string) []string {
		args := consentArgs(path)
		for i := range args {
			if args[i] == flag {
				args[i+1] = value
			}
		}
		return args
	}
	cases := map[string]struct {
		args []string
		want string
	}{
		"missing purpose":    {replace("--purpose", ""), "缺少 --purpose"},
		"missing version":    {replace("--version", ""), "缺少 --version"},
		"missing file":       {replace("--file", ""), "缺少 --file"},
		"missing items":      {replace("--items", ""), "缺少 --items"},
		"bad date":           {replace("--effective-date", "2026/09/01"), "--effective-date"},
		"items not an array": {replace("--items", `{"k":"rules","t":"x"}`), "--items"},
		"items unknown key":  {replace("--items", `[{"key":"rules","title":"x"}]`), "--items"},
		"items trailing":     {replace("--items", `[] []`), "--items"},
		"file not found":     {replace("--file", filepath.Join(t.TempDir(), "missing.md")), "读取同意书正文失败"},
		"extra argument":     {consentArgs(path, "leftover"), "多余的参数"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := parsePublishConsentArgs(tc.args, strings.NewReader(""), io.Discard)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.want)
		})
	}
}

func TestPublishConsentCommandFailsBeforeConnecting(t *testing.T) {
	code, stdout, stderr := runCmd("publish-consent", "--version", "REG-v1")

	assert.Equal(t, 1, code)
	assert.Empty(t, stdout)
	assert.Contains(t, stderr, "publish-consent: 缺少 --purpose")
}
```

运行：

```bash
cd api && go test -run 'PublishConsent' ./cmd/werun/
```

Expected：FAIL，编译错误 `undefined: parsePublishConsentArgs`。

- [ ] **Step 8: 实现 publish-consent 命令**

创建 `api/cmd/werun/publishconsent.go`：

```go
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"werun/api/internal/runner"
)

// consentItemArg 是 --items 数组元素的格式，与 disclaimer_versions.items 列一致。
type consentItemArg struct {
	K string `json:"k"`
	T string `json:"t"`
	D string `json:"d"`
}

// runPublishConsent 实现 `werun publish-consent`。参数校验在连接数据库之前完成。
func runPublishConsent(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	in, err := parsePublishConsentArgs(args, stdin, stderr)
	if err != nil {
		return err
	}
	app, err := Bootstrap(ctx)
	if err != nil {
		return err
	}
	defer app.Close()

	if err := app.Runner.PublishConsent(ctx, in); err != nil {
		return describeError(app.Catalog, err)
	}
	_, err = fmt.Fprintf(stdout, "已发布同意书 purpose=%s version=%s lang=%s effective-date=%s items=%d\n",
		in.Purpose, in.Version, in.Lang, in.EffectiveDate.Format(time.DateOnly), len(in.Items))
	return err
}

func parsePublishConsentArgs(args []string, stdin io.Reader, stderr io.Writer) (runner.PublishConsentInput, error) {
	fs := flag.NewFlagSet("publish-consent", flag.ContinueOnError)
	fs.SetOutput(stderr)
	purpose := fs.String("purpose", "", "REGISTRATION | COMMUNITY")
	version := fs.String("version", "", "版本号，如 REG-v1；发布后不可修改")
	lang := fs.String("lang", "", "zh | en | km")
	effective := fs.String("effective-date", "", "生效日期 YYYY-MM-DD")
	file := fs.String("file", "", "正文文件路径；- 表示从标准输入读取")
	items := fs.String("items", "", `勾选项 JSON 数组，如 [{"k":"rules","t":"我已阅读赛事规则","d":"说明，可省略"}]`)
	if err := fs.Parse(args); err != nil {
		return runner.PublishConsentInput{}, err
	}
	if fs.NArg() > 0 {
		return runner.PublishConsentInput{}, fmt.Errorf("多余的参数：%s", strings.Join(fs.Args(), " "))
	}
	for _, required := range []struct{ name, value string }{
		{"--purpose", *purpose},
		{"--version", *version},
		{"--lang", *lang},
		{"--effective-date", *effective},
		{"--file", *file},
		{"--items", *items},
	} {
		if strings.TrimSpace(required.value) == "" {
			return runner.PublishConsentInput{}, fmt.Errorf("缺少 %s", required.name)
		}
	}

	date, err := time.Parse(time.DateOnly, *effective)
	if err != nil {
		return runner.PublishConsentInput{}, fmt.Errorf("--effective-date 必须是 YYYY-MM-DD：%w", err)
	}
	parsedItems, err := parseConsentItems(*items)
	if err != nil {
		return runner.PublishConsentInput{}, err
	}
	text, err := readConsentText(*file, stdin)
	if err != nil {
		return runner.PublishConsentInput{}, err
	}
	return runner.PublishConsentInput{
		Purpose:       *purpose,
		Version:       *version,
		Lang:          *lang,
		EffectiveDate: date,
		FullText:      text,
		Items:         parsedItems,
	}, nil
}

func readConsentText(path string, stdin io.Reader) (string, error) {
	var data []byte
	var err error
	if path == "-" {
		data, err = io.ReadAll(stdin)
	} else {
		data, err = os.ReadFile(path)
	}
	if err != nil {
		return "", fmt.Errorf("读取同意书正文失败：%w", err)
	}
	return string(data), nil
}

func parseConsentItems(raw string) ([]runner.ConsentItem, error) {
	const hint = `--items 必须是一个 JSON 数组，元素形如 {"k":"rules","t":"标题","d":"说明"}`
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	var parsed []consentItemArg
	if err := dec.Decode(&parsed); err != nil {
		return nil, fmt.Errorf("%s：%w", hint, err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New(hint + "：数组之后还有多余内容")
	}
	items := make([]runner.ConsentItem, len(parsed))
	for i, item := range parsed {
		items[i] = runner.ConsentItem{Key: item.K, Title: item.T, Description: item.D}
	}
	return items, nil
}
```

`api/cmd/werun/main.go`：

（1）`usage` 中 `dev-initdata` 行之后追加：

```
  publish-consent 发布同意书版本：--purpose --version --lang --effective-date --file <路径|-> --items '<JSON>'
```

（2）`switch` 中 `case "dev-initdata":` 分支之后追加：

```go
	case "publish-consent":
		if err := runPublishConsent(ctx, args[1:], os.Stdin, stdout, stderr); err != nil {
			fmt.Fprintf(stderr, "publish-consent: %v\n", err)
			return 1
		}
		return 0
```

（3）import 增加 `"os"`。

运行：

```bash
cd api && go test -run 'PublishConsent' ./cmd/werun/
```

Expected：`ok  werun/api/cmd/werun`。

- [ ] **Step 9: 在 OpenAPI 中加入同意书查询接口并生成代码**

在 `api/openapi/openapi.yaml` 的 `components:` 行之前插入：

```yaml
  /app/consents:
    get:
      operationId: appGetConsent
      tags: [app-consents]
      summary: 当前生效的同意书版本；所请求语言没有时依次回退到英文、中文
      x-auth: app
      parameters:
        - name: purpose
          in: query
          required: true
          schema:
            type: string
            enum: [REGISTRATION]
        - name: lang
          in: query
          required: false
          schema:
            type: string
            enum: [zh, en, km]
      responses:
        '200':
          description: 当前生效的同意书
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ConsentVersion'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
```

在 `components.schemas` 末尾追加：

```yaml
    ConsentItem:
      type: object
      required: [key, title, description]
      properties:
        key:
          type: string
        title:
          type: string
        description:
          type: string
          description: 没有说明时为空串
    ConsentVersion:
      type: object
      required: [version, lang, effectiveDate, fullText, items]
      properties:
        version:
          type: string
        lang:
          type: string
          description: 实际返回的语言，可能是回退后的 en 或 zh；签署时原样提交
        effectiveDate:
          type: string
          format: date
        fullText:
          type: string
        items:
          type: array
          items:
            $ref: '#/components/schemas/ConsentItem'
```

运行：

```bash
make gen
```

Expected：`api.gen.go` 出现 `AppGetConsentParams{Purpose AppGetConsentParamsPurpose; Lang *AppGetConsentParamsLang}`、`AppGetConsent200JSONResponse`；`permissions.gen.go` 出现 `"AppGetConsent": {Kind: AuthApp}`。

- [ ] **Step 10: 写同意书查询接口的失败测试**

`api/internal/httpapi/runner_http_test.go` 改两处：

（1）`runnerEnv` 增加字段：

旧：

```go
type runnerEnv struct {
	router  http.Handler
	iam     *iam.Service
	catalog *i18n.Catalog
}
```

新：

```go
type runnerEnv struct {
	router  http.Handler
	iam     *iam.Service
	runners *runner.Service
	catalog *i18n.Catalog
}
```

（2）`newRunnerEnv` 的装配：

旧：

```go
	router := httpapi.NewRouter(httpapi.RouterDeps{
		Log:     logx.New("error", io.Discard),
		Catalog: catalog,
		Pool:    pool,
		IAM:     iamSvc,
		Runner:  runner.NewService(pool, secret, runnerBotToken, pii, time.Now),
		Env:     "dev",
	})
	return runnerEnv{router: router, iam: iamSvc, catalog: catalog}
```

新：

```go
	runners := runner.NewService(pool, secret, runnerBotToken, pii, time.Now)
	router := httpapi.NewRouter(httpapi.RouterDeps{
		Log:     logx.New("error", io.Discard),
		Catalog: catalog,
		Pool:    pool,
		IAM:     iamSvc,
		Runner:  runners,
		Env:     "dev",
	})
	return runnerEnv{router: router, iam: iamSvc, runners: runners, catalog: catalog}
```

在文件末尾追加：

```go
func TestAppGetConsent(t *testing.T) {
	e := newRunnerEnv(t)
	ctx := context.Background()
	auth := bearer(e.loginRunner(t, 10001, "Dara Sok").Token)

	rec := e.do(t, http.MethodGet, "/api/app/consents?purpose=REGISTRATION&lang=km", nil, auth)
	assert.Equal(t, http.StatusNotFound, rec.Code, "还没有发布任何版本")
	assert.Equal(t, apperr.CodeNotFound, decodeRunnerError(t, rec).Error.Code)

	effective := time.Now().AddDate(0, 0, -2)
	require.NoError(t, e.runners.PublishConsent(ctx, runner.PublishConsentInput{
		Purpose:       runner.PurposeRegistration,
		Version:       "REG-HTTP-v1",
		Lang:          "en",
		EffectiveDate: effective,
		FullText:      "Registration consent body",
		Items: []runner.ConsentItem{
			{Key: "rules", Title: "I follow the race rules", Description: "Cut-off times apply"},
			{Key: "health", Title: "I am fit to run"},
		},
	}))

	rec = e.do(t, http.MethodGet, "/api/app/consents?purpose=REGISTRATION&lang=km", nil, auth)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var got apigen.ConsentVersion
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	assert.Equal(t, "REG-HTTP-v1", got.Version)
	assert.Equal(t, "en", got.Lang, "高棉文缺失时回退到英文")
	assert.Equal(t, effective.Format(time.DateOnly), got.EffectiveDate.Time.Format(time.DateOnly))
	assert.Equal(t, "Registration consent body", got.FullText)
	assert.Equal(t, []apigen.ConsentItem{
		{Key: "rules", Title: "I follow the race rules", Description: "Cut-off times apply"},
		{Key: "health", Title: "I am fit to run", Description: ""},
	}, got.Items)

	rec = e.do(t, http.MethodGet, "/api/app/consents?purpose=COMMUNITY", nil, auth)
	assert.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	assert.Equal(t, apperr.CodeValidation, decodeRunnerError(t, rec).Error.Code)

	rec = e.do(t, http.MethodGet, "/api/app/consents", nil, auth)
	assert.Equal(t, http.StatusBadRequest, rec.Code, "purpose 必填")

	rec = e.do(t, http.MethodGet, "/api/app/consents?purpose=REGISTRATION", nil, nil)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}
```

运行：

```bash
cd api && env $COLIMA_ENV go test -run TestAppGetConsent ./internal/httpapi/
```

Expected：FAIL，编译错误 `*Server does not implement apigen.StrictServerInterface (missing method AppGetConsent)`。

- [ ] **Step 11: 实现同意书查询 handler**

`api/internal/runner/handlers.go` 的 import 块增加 `"werun/api/internal/platform/i18n"`，文件末尾追加：

```go
func (h *Handlers) AppGetConsent(ctx context.Context, req apigen.AppGetConsentRequestObject) (apigen.AppGetConsentResponseObject, error) {
	if string(req.Params.Purpose) != PurposeRegistration {
		return nil, apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation).
			WithField("purpose", "field.invalid", nil)
	}
	lang := httpx.LangOf(ctx)
	if req.Params.Lang != nil {
		if l, ok := i18n.Parse(string(*req.Params.Lang)); ok {
			lang = l
		}
	}
	v, err := h.svc.CurrentConsent(ctx, PurposeRegistration, lang)
	if err != nil {
		return nil, err
	}
	items := make([]apigen.ConsentItem, 0, len(v.Items))
	for _, item := range v.Items {
		items = append(items, apigen.ConsentItem{Key: item.Key, Title: item.Title, Description: item.Description})
	}
	return apigen.AppGetConsent200JSONResponse{
		Version:       v.Version,
		Lang:          v.Lang,
		EffectiveDate: openapi_types.Date{Time: v.EffectiveDate},
		FullText:      v.FullText,
		Items:         items,
	}, nil
}
```

运行：

```bash
cd api && env $COLIMA_ENV go test ./internal/httpapi/ ./internal/runner/ ./cmd/werun/
```

Expected：三个包都 `ok`。

- [ ] **Step 12: 用真实数据库验证命令（手动）**

```bash
make dev-down; docker compose -f deploy/compose.dev.yaml up -d --wait postgres
make migrate-up
printf '# 报名同意书\n\n参赛者确认身体状况适合参赛。\n' | (set -a; . ./.env; set +a; cd api && go run ./cmd/werun publish-consent \
  --purpose REGISTRATION --version REG-DEV-v1 --lang zh --effective-date 2026-09-01 --file - \
  --items '[{"k":"rules","t":"我已阅读并遵守赛事规则"},{"k":"health","t":"我的身体状况适合参赛"},{"k":"terms","t":"我同意平台服务条款"}]')
```

Expected：输出 `已发布同意书 purpose=REGISTRATION version=REG-DEV-v1 lang=zh effective-date=2026-09-01 items=3`。再执行一次同样的命令，退出码为 1，stderr 为 `publish-consent: 请检查标出的字段。（version: 格式不正确。）`。

- [ ] **Step 13: 全量检查**

```bash
make gen && git status --porcelain api/internal/httpapi/apigen packages/api-client/src/schema.d.ts api/internal/runner/store
cd api && env $COLIMA_ENV go test ./...
cd api && go tool golangci-lint run ./...
pnpm --filter @werun/api-client typecheck
```

Expected：`make gen` 后没有新差异；测试全部 `ok`；lint `0 issues.`；类型检查通过。

- [ ] **Step 14: 提交**

```bash
git add api/internal/platform/apperr/apperr.go api/internal/platform/apperr/apperr_test.go \
  api/internal/platform/i18n/messages.zh.json api/internal/platform/i18n/messages.en.json api/internal/platform/i18n/messages.km.json \
  api/db/queries/runner.sql api/internal/runner \
  api/cmd/werun/publishconsent.go api/cmd/werun/publishconsent_test.go api/cmd/werun/main.go \
  api/openapi/openapi.yaml api/internal/httpapi/apigen/api.gen.go api/internal/httpapi/apigen/permissions.gen.go \
  packages/api-client/src/schema.d.ts api/internal/httpapi/runner_http_test.go
git commit -m "$(cat <<'EOF'
feat(api): registration consent versions, signing and publish-consent

- PublishConsent stores text_sha256 and [{k,t,d}] items; versions are immutable
- CurrentConsent picks the latest effective version (Cambodia date) with en -> zh fallback
- SignConsent writes disclaimer_signatures + registration_consents in the caller tx, CONSENT_INVALID
- werun publish-consent --file <path|-> --items '<json>', audit consent.publish
- appGetConsent

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
)"
```

---

### Task 10: 用户端登录与参赛人页面

**Files:**
- Modify: `packages/api-client/src/client.ts`
- Test: `packages/api-client/src/client.test.ts`
- Modify: `web/user/src/telegram/telegram.ts`
- Test: `web/user/src/telegram/telegram.test.ts`
- Create: `web/user/src/auth/session.ts`
- Test: `web/user/src/auth/session.test.ts`
- Create: `web/user/src/auth/controller.ts`
- Test: `web/user/src/auth/controller.test.ts`
- Create: `web/user/src/auth/AuthProvider.tsx`
- Create: `web/user/src/auth/RequireRunner.tsx`、`web/user/src/auth/RequireRunner.module.css`
- Test: `web/user/src/auth/RequireRunner.test.tsx`
- Create: `web/user/src/bootstrap.tsx`
- Modify: `web/user/src/main.tsx`、`web/user/src/routes.tsx`、`web/user/src/queries.ts`、`web/user/src/components/Layout.tsx`
- Modify: `web/user/src/test/renderApp.tsx`、`web/user/src/test/setup.ts`、`web/user/src/test/fixtures.ts`
- Create: `web/user/src/vite-env.d.ts`、`web/user/.env.development`
- Create: `web/user/src/profiles/validate.ts`
- Test: `web/user/src/profiles/validate.test.ts`
- Create: `web/user/src/profiles/ProfileFields.tsx`、`web/user/src/profiles/ProfileFields.module.css`
- Create: `web/user/src/pages/ProfilesPage.tsx`、`web/user/src/pages/ProfilesPage.module.css`
- Test: `web/user/src/pages/ProfilesPage.test.tsx`
- Modify: `packages/i18n/locales/zh/user.json`、`packages/i18n/locales/en/user.json`、`packages/i18n/locales/km/user.json`
- Modify: `.gitignore`、`deploy/web.Dockerfile`、`deploy/compose.yaml`、`.github/workflows/ci.yml`

**Interfaces:**
- Consumes:
  - Task 7–8 接口：`POST /app/auth/telegram` → `Schemas["AppSession"]`；`GET /app/me` → `Schemas["AppUser"]`；`POST /app/auth/logout` → 204；`GET /app/profiles` → `Schemas["RunnerProfileList"]`；`POST /app/profiles`、`PUT /app/profiles/{id}` 请求体 `Schemas["ProfileInput"]` → `Schemas["RunnerProfile"]`；`DELETE /app/profiles/{id}` → 204；错误 `UNAUTHENTICATED`（401）、`TELEGRAM_AUTH_INVALID`（401）、`VALIDATION_FAILED`（422，`fields` 已按语言翻译）、`NOT_FOUND`（404）
  - 脚手架：`createApiClient`、`unwrap`、`ApiError`、`Schemas`、`initI18n`、`currentLang`、`useLang`、`isTelegram`、`loadTelegramSdk`、`initTelegram`、`QueryState`、`Page.module.css`、`renderApp`、`jsonResponse`
- Produces:
  - api-client（overview）：`ApiClientOptions.getAuthToken?: () => string | null`，返回非空串时设置 `Authorization: Bearer <token>`
  - `web/user/src/auth/session.ts`：`TOKEN_KEY = "werun.appToken"`、`TOKEN_EXPIRES_KEY = "werun.appTokenExpiresAt"`、`DEV_INIT_DATA_KEY = "werun.devInitData"`、`readToken(now?: number): string | null`、`saveToken(token: string, expiresAt: string): void`、`clearToken(): void`、`resolveInitData(location?: LocationLike): Promise<string | null>`
  - `web/user/src/auth/controller.ts`：`class AuthController`（`getState`、`subscribe`、`start()`、`relogin()`、`handleUnauthorized()`、`lastRelogin()`、`logout()`）、`type AuthStatus = "idle" | "loading" | "authenticated" | "unauthenticated"`、`interface AuthState`、`interface AuthControllerDeps`
  - `web/user/src/auth/AuthProvider.tsx`：`AuthProvider({ controller, children })`、`useAuth(): { status; user; relogin; logout }`
  - `web/user/src/auth/RequireRunner.tsx`：`RequireRunner({ children? })`（未登录渲染 `data-testid="open-in-telegram"`）、`OpenInTelegram`
  - `web/user/src/bootstrap.tsx`：`createUserApp(options: UserAppOptions): { element; api; auth; queryClient }`、`isUnauthorized(error: unknown): boolean`
  - `renderApp(path, handler, options?: { initData?: string | null })`
  - `web/user/src/profiles/validate.ts`：`ProfileFormValues`、`ProfileField`、`emptyProfileForm`、`validateProfileForm(values, options?)`、`toProfileInput(values)`、`profileToForm(profile)`、`pickProfileFieldErrors(fields)`、`GENDERS`、`ID_TYPES`、`TSHIRT_SIZES`
  - `web/user/src/profiles/ProfileFields.tsx`：`ProfileFields({ values, errors, onChange, testIdPrefix, idNoHint?, showIsSelf? })`
  - `web/user/src/queries.ts`：`PROFILES_KEY`、`useProfiles()`、`useCreateProfile()`、`useUpdateProfile()`、`useDeleteProfile()`
  - 路由 `/profiles`（在 `RequireRunner` 内）；文案 `user.auth.*`、`user.profiles.*`
  - 构建变量 `VITE_TELEGRAM_BOT_USERNAME`（契约补充第 10 条）

**401 与重试的完整流程**（实现与测试都以此为准）：

1. api-client 中间件在每个请求上调用 `getAuthToken()`，也就是 `readToken()`：`sessionStorage` 里有令牌且 `werun.appTokenExpiresAt` 晚于「现在 + 30 秒」时返回令牌，否则返回 `null`，这时不带 `Authorization` 头。
2. 任意响应为 401 时，中间件调用 `onUnauthorized()`，即 `auth.handleUnauthorized()`：
   - 先 `clearToken()`；
   - 再调用 `relogin()`，并把返回的 Promise 记为 `lastRelogin`。
3. `relogin()` 是单飞的：已有进行中的登录（包括启动时的 `start()`）就直接返回同一个 Promise，否则用 `resolveInitData()` 取 `initData` 调 `POST /app/auth/telegram`。
   - 成功：`saveToken`，状态保持或变为 `authenticated`；
   - 失败或取不到 `initData`：清令牌，状态变为 `unauthenticated`。
   - 从 `authenticated` 发起的后台重登录不会先把状态改成 `loading`，所以页面不会被卸载，表单里已填的内容不会丢。
4. 查询（TanStack Query）：
   - `retry` 对 401 返回 `false`，其它错误按 `retry` 次数重试（生产 1 次，测试 0 次）。
   - `QueryCache.onError` 收到 401 时：如果这个查询的 `queryHash` 已在「已重登录重试」集合里，就移出集合、放弃，页面显示错误；否则把 `queryHash` 加入集合，等 `auth.lastRelogin()`（即第 2 步为这次 401 发起的那次登录）结束。
   - 登录成功就 `queryClient.resetQueries({ queryKey, exact: true })`：查询回到 pending 状态并用新令牌重新请求，只重试一次。登录失败则把 `queryHash` 移出集合，`RequireRunner` 此时已显示 `open-in-telegram`。
   - `QueryCache.onSuccess` 把该 `queryHash` 移出集合。
5. 修改类请求（mutation）不自动重发：第 2 步已换好新令牌，页面显示错误，用户再点一次即可。
6. `logout()` 期间收到的 401 不触发重登录。

- [ ] **Step 1: api-client 支持跑者令牌（先写测试）**

在 `packages/api-client/src/client.test.ts` 的 `describe("createApiClient", …)` 中，`"收到 401 时调用 onUnauthorized"` 用例之前追加：

```ts
  it("getAuthToken 返回非空令牌时带 Authorization: Bearer，每次请求重新读取", async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, { items: [] }));
    let token: string | null = "runner-token-1";
    const client = createApiClient({
      client: "user",
      baseUrl: BASE_URL,
      getLang: () => "en",
      getAuthToken: () => token,
    });

    await client.GET("/events");
    token = null;
    await client.GET("/events");
    token = "";
    await client.GET("/events");

    expect(fetchMock.mock.calls[0]![0].headers.get("Authorization")).toBe("Bearer runner-token-1");
    expect(fetchMock.mock.calls[1]![0].headers.get("Authorization")).toBeNull();
    expect(fetchMock.mock.calls[2]![0].headers.get("Authorization")).toBeNull();
  });

  it("没有 getAuthToken 时不带 Authorization", async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, { items: [] }));
    const client = createApiClient({ client: "admin", baseUrl: BASE_URL, getLang: () => "en" });

    await client.GET("/admin/events");

    expect(firstRequest(fetchMock).headers.get("Authorization")).toBeNull();
  });
```

运行：

```bash
pnpm --filter @werun/api-client test
```

Expected：FAIL，第一个新用例的 `Authorization` 为 `null`；`pnpm --filter @werun/api-client typecheck` 报 `Object literal may only specify known properties, and 'getAuthToken' does not exist`。

用下面内容整体替换 `packages/api-client/src/client.ts`：

```ts
import createClient, { type Client, type Middleware } from "openapi-fetch";
import type { paths } from "./schema";

export type ApiClient = Client<paths>;

export interface ApiClientOptions {
  client: "user" | "admin";
  baseUrl?: string;
  getLang: () => string;
  /** 跑者令牌；返回非空串时设置 Authorization: Bearer <token> */
  getAuthToken?: () => string | null;
  onUnauthorized?: () => void;
}

function werunMiddleware(options: ApiClientOptions): Middleware {
  return {
    onRequest({ request }) {
      request.headers.set("Accept-Language", options.getLang());
      if (options.client === "admin") {
        request.headers.set("X-WeRun-Client", "admin");
      }
      const token = options.getAuthToken?.();
      if (token) {
        request.headers.set("Authorization", `Bearer ${token}`);
      }
      return request;
    },
    onResponse({ response }) {
      if (response.status === 401) {
        options.onUnauthorized?.();
      }
      return undefined;
    },
  };
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const client = createClient<paths>({
    baseUrl: options.baseUrl ?? "/api",
    credentials: "include",
  });
  client.use(werunMiddleware(options));
  return client;
}
```

运行：

```bash
pnpm --filter @werun/api-client test && pnpm --filter @werun/api-client typecheck
```

Expected：全部通过。

- [ ] **Step 2: telegram.ts 暴露 initData 并复用 SDK 脚本（先写测试）**

在 `web/user/src/telegram/telegram.test.ts` 顶部 import 改为：

```ts
import {
  TELEGRAM_SDK_URL,
  applyTelegramTheme,
  initTelegram,
  isTelegram,
  loadTelegramSdk,
  type RouterLike,
  type TelegramWebApp,
} from "./telegram";
```

`fakeWebApp()` 返回的对象里加一行 `initData: "user=%7B%7D&auth_date=1&hash=abc",`，并在文件末尾追加：

```ts
describe("loadTelegramSdk", () => {
  it("并发调用只插入一个 script，加载完成后都拿到 WebApp", async () => {
    const first = loadTelegramSdk();
    const second = loadTelegramSdk();

    const scripts = document.querySelectorAll(`script[src="${TELEGRAM_SDK_URL}"]`);
    expect(scripts).toHaveLength(1);

    const webApp = fakeWebApp();
    window.Telegram = { WebApp: webApp };
    scripts[0]!.dispatchEvent(new Event("load"));

    await expect(first).resolves.toBe(webApp);
    await expect(second).resolves.toBe(webApp);
  });

  it("脚本加载失败时拒绝", async () => {
    const pending = loadTelegramSdk();
    document.querySelector(`script[src="${TELEGRAM_SDK_URL}"]`)!.dispatchEvent(new Event("error"));
    await expect(pending).rejects.toThrow(TELEGRAM_SDK_URL);
  });
});
```

运行：

```bash
pnpm --filter @werun/user test -- src/telegram
```

Expected：FAIL，并发用例找到 2 个 `script`；typecheck 报 `initData` 不在 `TelegramWebApp` 上。

修改 `web/user/src/telegram/telegram.ts`：

（1）`TelegramWebApp` 接口第一行加入：

```ts
  /** 原样传给 POST /api/app/auth/telegram 的签名查询串；不在 Telegram 中打开时为空串 */
  initData: string;
```

（2）用下面的函数整体替换 `loadTelegramSdk`：

```ts
export function loadTelegramSdk(): Promise<TelegramWebApp> {
  if (window.Telegram?.WebApp) {
    return Promise.resolve(window.Telegram.WebApp);
  }
  return new Promise((resolve, reject) => {
    // 主题适配与登录会同时等待 SDK：复用已插入的 script，只下载一次
    let script = document.querySelector<HTMLScriptElement>(`script[src="${TELEGRAM_SDK_URL}"]`);
    if (!script) {
      script = document.createElement("script");
      script.src = TELEGRAM_SDK_URL;
      script.async = true;
      document.head.appendChild(script);
    }
    script.addEventListener("load", () => {
      if (window.Telegram?.WebApp) {
        resolve(window.Telegram.WebApp);
      } else {
        reject(new Error("Telegram SDK 已加载，但 window.Telegram.WebApp 不存在"));
      }
    });
    script.addEventListener("error", () => reject(new Error(`无法加载 ${TELEGRAM_SDK_URL}`)));
  });
}
```

运行：

```bash
pnpm --filter @werun/user test -- src/telegram
```

Expected：`telegram.test.ts` 全部通过。

- [ ] **Step 3: 会话存储与 initData 来源（先写测试）**

创建 `web/user/src/vite-env.d.ts`：

```ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 「在 Telegram 中打开」链接里的机器人用户名，构建时注入 */
  readonly VITE_TELEGRAM_BOT_USERNAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

用下面内容整体替换 `web/user/src/test/setup.ts`：

```ts
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  window.localStorage.clear();
  window.sessionStorage.clear();
  delete window.Telegram;
  // resolveInitData 可能插入 Telegram SDK 的 script，清掉以免下一个用例复用已触发过 load 的元素
  document.head.querySelectorAll("script").forEach((script) => script.remove());
  window.history.replaceState(null, "", "/");
});
```

创建 `web/user/src/auth/session.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import type { TelegramWebApp } from "../telegram/telegram";
import {
  DEV_INIT_DATA_KEY,
  TOKEN_EXPIRES_KEY,
  TOKEN_KEY,
  clearToken,
  readToken,
  resolveInitData,
  saveToken,
} from "./session";

const NOW = Date.parse("2026-09-14T03:00:00Z");

describe("令牌存储", () => {
  it("使用约定的 sessionStorage 键", () => {
    expect(TOKEN_KEY).toBe("werun.appToken");
    expect(TOKEN_EXPIRES_KEY).toBe("werun.appTokenExpiresAt");
    expect(DEV_INIT_DATA_KEY).toBe("werun.devInitData");
  });

  it("未过期时返回令牌", () => {
    saveToken("tok-1", "2026-09-15T03:00:00Z");
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBe("tok-1");
    expect(window.sessionStorage.getItem(TOKEN_EXPIRES_KEY)).toBe("2026-09-15T03:00:00Z");
    expect(readToken(NOW)).toBe("tok-1");
  });

  it("过期、即将在 30 秒内过期、时间无法解析或缺少时返回 null", () => {
    saveToken("tok-1", "2026-09-14T03:00:20Z");
    expect(readToken(NOW)).toBeNull();

    saveToken("tok-1", "not-a-date");
    expect(readToken(NOW)).toBeNull();

    window.sessionStorage.removeItem(TOKEN_EXPIRES_KEY);
    expect(readToken(NOW)).toBeNull();
  });

  it("clearToken 删除令牌与过期时间", () => {
    saveToken("tok-1", "2026-09-15T03:00:00Z");
    clearToken();
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(TOKEN_EXPIRES_KEY)).toBeNull();
  });
});

describe("resolveInitData", () => {
  const plainBrowser = { hash: "", search: "" };

  it("优先使用 Telegram WebApp 的 initData", async () => {
    window.Telegram = { WebApp: { initData: "tg-init-data" } as TelegramWebApp };
    window.sessionStorage.setItem(DEV_INIT_DATA_KEY, "stored-dev");

    await expect(resolveInitData({ hash: "", search: "?devInitData=query-dev" })).resolves.toBe("tg-init-data");
  });

  it("地址带 tgWebAppData 时等待 SDK 加载后读取", async () => {
    const pending = resolveInitData({ hash: "#tgWebAppData=abc", search: "" });
    window.Telegram = { WebApp: { initData: "from-sdk" } as TelegramWebApp };
    document.querySelector('script[src="https://telegram.org/js/telegram-web-app.js"]')!.dispatchEvent(new Event("load"));

    await expect(pending).resolves.toBe("from-sdk");
  });

  it("开发构建读取 ?devInitData= 并存入 sessionStorage", async () => {
    const value = "user=%7B%22id%22%3A1%7D&auth_date=1&hash=ab";
    await expect(resolveInitData({ hash: "", search: `?devInitData=${encodeURIComponent(value)}` })).resolves.toBe(value);
    expect(window.sessionStorage.getItem(DEV_INIT_DATA_KEY)).toBe(value);
  });

  it("开发构建在地址没有参数时读取 werun.devInitData", async () => {
    window.sessionStorage.setItem(DEV_INIT_DATA_KEY, "stored-dev");
    await expect(resolveInitData(plainBrowser)).resolves.toBe("stored-dev");
  });

  it("生产构建忽略开发登录参数", async () => {
    vi.stubEnv("DEV", false);
    window.sessionStorage.setItem(DEV_INIT_DATA_KEY, "stored-dev");
    await expect(resolveInitData({ hash: "", search: "?devInitData=query-dev" })).resolves.toBeNull();
  });

  it("什么都没有时返回 null", async () => {
    await expect(resolveInitData(plainBrowser)).resolves.toBeNull();
  });
});
```

运行：

```bash
pnpm --filter @werun/user test -- src/auth/session
```

Expected：FAIL，`Failed to resolve import "./session"`。

创建 `web/user/src/auth/session.ts`：

```ts
import { isTelegram, loadTelegramSdk } from "../telegram/telegram";

export const TOKEN_KEY = "werun.appToken";
export const TOKEN_EXPIRES_KEY = "werun.appTokenExpiresAt";
export const DEV_INIT_DATA_KEY = "werun.devInitData";

/** 离过期不足这个时长的令牌当作已过期，避免请求途中失效 */
const EXPIRY_SKEW_MS = 30_000;

export type LocationLike = Pick<Location, "hash" | "search">;

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    // 隐私模式等场景禁用存储时，令牌只保存在内存之外，每次都用 initData 重新登录
    return null;
  }
}

export function readToken(now: number = Date.now()): string | null {
  const store = storage();
  const token = store?.getItem(TOKEN_KEY);
  const expiresAt = store?.getItem(TOKEN_EXPIRES_KEY);
  if (!token || !expiresAt) {
    return null;
  }
  const expiresMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresMs) || expiresMs <= now + EXPIRY_SKEW_MS) {
    return null;
  }
  return token;
}

export function saveToken(token: string, expiresAt: string): void {
  const store = storage();
  store?.setItem(TOKEN_KEY, token);
  store?.setItem(TOKEN_EXPIRES_KEY, expiresAt);
}

export function clearToken(): void {
  const store = storage();
  store?.removeItem(TOKEN_KEY);
  store?.removeItem(TOKEN_EXPIRES_KEY);
}

async function telegramInitData(location: LocationLike): Promise<string> {
  const loaded = window.Telegram?.WebApp?.initData;
  if (loaded) {
    return loaded;
  }
  if (!isTelegram(location)) {
    return "";
  }
  try {
    return (await loadTelegramSdk()).initData ?? "";
  } catch {
    return "";
  }
}

/**
 * initData 来源顺序：Telegram WebApp → 开发构建的 ?devInitData=（读到后存入 sessionStorage）→ 开发构建存下的 werun.devInitData。
 * 开发登录参数整段放在 import.meta.env.DEV 分支里，生产构建不包含。
 */
export async function resolveInitData(location: LocationLike = window.location): Promise<string | null> {
  const fromTelegram = await telegramInitData(location);
  if (fromTelegram) {
    return fromTelegram;
  }
  if (import.meta.env.DEV) {
    const fromQuery = new URLSearchParams(location.search).get("devInitData");
    if (fromQuery) {
      storage()?.setItem(DEV_INIT_DATA_KEY, fromQuery);
      return fromQuery;
    }
    const stored = storage()?.getItem(DEV_INIT_DATA_KEY);
    if (stored) {
      return stored;
    }
  }
  return null;
}
```

运行：

```bash
pnpm --filter @werun/user test -- src/auth/session
```

Expected：`session.test.ts` 全部通过。

- [ ] **Step 4: 登录状态控制器（先写测试）**

创建 `web/user/src/auth/controller.test.ts`：

```ts
import type { Schemas } from "@werun/api-client";
import { describe, expect, it, vi } from "vitest";
import { AuthController, type AuthControllerDeps } from "./controller";
import { TOKEN_KEY, saveToken } from "./session";

const runner: Schemas["AppUser"] = {
  id: 1,
  telegramUserId: 10001,
  telegramUsername: "darasok",
  displayName: "Sok Dara",
  locale: "en",
};

function session(token: string): Schemas["AppSession"] {
  return { token, expiresAt: "2099-01-01T00:00:00Z", user: runner };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeDeps(initData: string | null = "signed-init-data") {
  const deps = {
    resolveInitData: vi.fn<AuthControllerDeps["resolveInitData"]>(async () => initData),
    login: vi.fn<AuthControllerDeps["login"]>(async () => session("tok-1")),
    me: vi.fn<AuthControllerDeps["me"]>(async () => runner),
    logout: vi.fn<AuthControllerDeps["logout"]>(async () => undefined),
  };
  return deps;
}

describe("AuthController", () => {
  it("没有 initData 时变为 unauthenticated，不发登录请求", async () => {
    const deps = makeDeps(null);
    const auth = new AuthController(deps);

    await expect(auth.start()).resolves.toBe(false);

    expect(auth.getState()).toEqual({ status: "unauthenticated", user: null });
    expect(deps.login).not.toHaveBeenCalled();
  });

  it("用 initData 登录，保存令牌并通知订阅者", async () => {
    const deps = makeDeps();
    const auth = new AuthController(deps);
    const listener = vi.fn();
    auth.subscribe(listener);

    const started = auth.start();
    expect(auth.getState().status).toBe("loading");
    await expect(started).resolves.toBe(true);

    expect(deps.login).toHaveBeenCalledWith("signed-init-data");
    expect(auth.getState()).toEqual({ status: "authenticated", user: runner });
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBe("tok-1");
    expect(listener).toHaveBeenCalled();
  });

  it("已有有效令牌时只调用 me", async () => {
    saveToken("stored-token", "2099-01-01T00:00:00Z");
    const deps = makeDeps();
    const auth = new AuthController(deps);

    await expect(auth.start()).resolves.toBe(true);

    expect(deps.me).toHaveBeenCalledOnce();
    expect(deps.login).not.toHaveBeenCalled();
    expect(auth.getState().user).toEqual(runner);
  });

  it("已有令牌但 me 失败时改用 initData 登录", async () => {
    saveToken("revoked-token", "2099-01-01T00:00:00Z");
    const deps = makeDeps();
    deps.me.mockRejectedValue(new Error("401"));
    deps.login.mockResolvedValue(session("tok-2"));
    const auth = new AuthController(deps);

    await expect(auth.start()).resolves.toBe(true);

    expect(deps.login).toHaveBeenCalledOnce();
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBe("tok-2");
  });

  it("start 与 relogin 并发时只登录一次，重复 start 不再请求", async () => {
    const deps = makeDeps();
    const auth = new AuthController(deps);

    const results = await Promise.all([auth.start(), auth.start(), auth.relogin()]);
    await auth.start();

    expect(results).toEqual([true, true, true]);
    expect(deps.login).toHaveBeenCalledOnce();
  });

  it("handleUnauthorized 清掉令牌并在后台重新登录一次，期间保持已登录状态", async () => {
    const deps = makeDeps();
    const auth = new AuthController(deps);
    await auth.start();
    const second = deferred<Schemas["AppSession"]>();
    deps.login.mockReturnValueOnce(second.promise);

    auth.handleUnauthorized();
    auth.handleUnauthorized();

    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(auth.getState().status).toBe("authenticated");
    second.resolve(session("tok-2"));
    await expect(auth.lastRelogin()).resolves.toBe(true);
    expect(deps.login).toHaveBeenCalledTimes(2);
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBe("tok-2");
  });

  it("重新登录失败时变为 unauthenticated", async () => {
    const deps = makeDeps();
    const auth = new AuthController(deps);
    await auth.start();
    deps.login.mockRejectedValueOnce(new Error("TELEGRAM_AUTH_INVALID"));

    auth.handleUnauthorized();

    await expect(auth.lastRelogin()).resolves.toBe(false);
    expect(auth.getState()).toEqual({ status: "unauthenticated", user: null });
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("还没有收到过 401 时 lastRelogin 为 false", async () => {
    const auth = new AuthController(makeDeps());
    await expect(auth.lastRelogin()).resolves.toBe(false);
  });

  it("logout 吊销令牌，期间的 401 不触发重新登录", async () => {
    const deps = makeDeps();
    const auth = new AuthController(deps);
    await auth.start();
    deps.logout.mockImplementationOnce(async () => {
      auth.handleUnauthorized();
      throw new Error("401");
    });

    await auth.logout();

    expect(deps.logout).toHaveBeenCalledOnce();
    expect(deps.login).toHaveBeenCalledOnce();
    expect(auth.getState()).toEqual({ status: "unauthenticated", user: null });
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });
});
```

运行：

```bash
pnpm --filter @werun/user test -- src/auth/controller
```

Expected：FAIL，`Failed to resolve import "./controller"`。

创建 `web/user/src/auth/controller.ts`：

```ts
import type { Schemas } from "@werun/api-client";
import { clearToken, readToken, saveToken } from "./session";

export type AuthStatus = "idle" | "loading" | "authenticated" | "unauthenticated";

export interface AuthState {
  status: AuthStatus;
  user: Schemas["AppUser"] | null;
}

export interface AuthControllerDeps {
  resolveInitData: () => Promise<string | null>;
  login: (initData: string) => Promise<Schemas["AppSession"]>;
  me: () => Promise<Schemas["AppUser"]>;
  logout: () => Promise<void>;
}

/**
 * 跑者登录状态。不依赖 React，api-client 的 onUnauthorized 与 QueryCache 都直接调用它；
 * React 组件通过 useSyncExternalStore(subscribe, getState) 读取。
 */
export class AuthController {
  private state: AuthState = { status: "idle", user: null };
  private readonly listeners = new Set<() => void>();
  private readonly deps: AuthControllerDeps;
  private pending: Promise<boolean> | null = null;
  private last: Promise<boolean> | null = null;
  private loggingOut = false;

  constructor(deps: AuthControllerDeps) {
    this.deps = deps;
  }

  readonly getState = (): AuthState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 应用启动时调用：有有效令牌就取当前跑者，否则用 initData 登录。重复调用不会重复请求。 */
  start(): Promise<boolean> {
    if (this.pending) {
      return this.pending;
    }
    if (this.state.status !== "idle") {
      return Promise.resolve(this.state.status === "authenticated");
    }
    this.set({ status: "loading", user: null });
    return this.track(this.restore());
  }

  /** 用 initData 重新登录；已有进行中的登录时返回同一个 Promise。 */
  relogin(): Promise<boolean> {
    if (this.pending) {
      return this.pending;
    }
    return this.track(this.loginWithInitData());
  }

  /** api-client 收到 401 时调用：清掉令牌并重新登录一次。 */
  handleUnauthorized(): void {
    if (this.loggingOut) {
      return;
    }
    clearToken();
    this.last = this.relogin();
  }

  /** 最近一次由 401 触发的重新登录；QueryCache 等它结束后决定是否重试查询。 */
  lastRelogin(): Promise<boolean> {
    return this.last ?? Promise.resolve(false);
  }

  async logout(): Promise<void> {
    this.loggingOut = true;
    try {
      if (readToken()) {
        await this.deps.logout();
      }
    } catch {
      // 令牌已经失效时服务端返回 401，本地照样视为已退出
    } finally {
      this.loggingOut = false;
      clearToken();
      this.set({ status: "unauthenticated", user: null });
    }
  }

  private track(work: Promise<boolean>): Promise<boolean> {
    const tracked: Promise<boolean> = work.finally(() => {
      if (this.pending === tracked) {
        this.pending = null;
      }
    });
    this.pending = tracked;
    return tracked;
  }

  private async restore(): Promise<boolean> {
    if (readToken()) {
      try {
        const user = await this.deps.me();
        this.set({ status: "authenticated", user });
        return true;
      } catch {
        // 令牌被吊销或已过期：继续用 initData 登录
      }
    }
    return this.loginWithInitData();
  }

  private async loginWithInitData(): Promise<boolean> {
    const initData = await this.deps.resolveInitData().catch(() => null);
    if (!initData) {
      this.fail();
      return false;
    }
    try {
      const session = await this.deps.login(initData);
      saveToken(session.token, session.expiresAt);
      this.set({ status: "authenticated", user: session.user });
      return true;
    } catch {
      this.fail();
      return false;
    }
  }

  private fail(): void {
    clearToken();
    this.set({ status: "unauthenticated", user: null });
  }

  private set(next: AuthState): void {
    this.state = next;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
```

运行：

```bash
pnpm --filter @werun/user test -- src/auth/controller
```

Expected：`controller.test.ts` 全部通过。

- [ ] **Step 5: 加入 user.auth.* 与 user.profiles.* 三语文案**

用下面内容整体替换 `packages/i18n/locales/zh/user.json`：

```json
{
  "home": { "title": "近期赛事", "viewAll": "查看全部赛事" },
  "events": { "title": "全部赛事", "empty": "暂时没有开放的赛事" },
  "event": {
    "date": "比赛日期",
    "city": "城市",
    "categories": "组别",
    "distance": "距离",
    "km": "{{km}} 公里",
    "capacity": "名额",
    "start": "发枪",
    "cutoff": "关门"
  },
  "notFound": { "title": "页面不存在", "body": "链接可能已经失效。", "home": "回到首页" },
  "auth": {
    "checking": "正在确认身份…",
    "openInTelegram": {
      "title": "请在 Telegram 中打开",
      "body": "报名和管理常用参赛人需要在 WeRun 的 Telegram 小程序里登录。普通浏览器仍可以浏览赛事。",
      "action": "打开 Telegram"
    }
  },
  "profiles": {
    "nav": "常用参赛人",
    "title": "常用参赛人",
    "empty": "还没有常用参赛人。保存在这里的资料，报名时可以直接选择。",
    "create": "添加参赛人",
    "createTitle": "添加参赛人",
    "editTitle": "编辑参赛人",
    "edit": "编辑",
    "delete": "删除",
    "deleteConfirm": "确定删除 {{name}}？",
    "confirmDelete": "确认删除",
    "cancel": "取消",
    "save": "保存",
    "saving": "正在保存…",
    "self": "本人",
    "idNoLabel": "证件号",
    "phoneLabel": "手机",
    "idNoKeepHint": "当前证件号 {{masked}}，留空则不修改。",
    "choose": "请选择",
    "fields": {
      "fullName": "姓名（与证件一致）",
      "gender": "性别",
      "birthDate": "出生日期",
      "nationality": "国籍",
      "nationalityHint": "两位国家代码，例如 KH、CN",
      "idType": "证件类型",
      "idNo": "证件号",
      "phone": "手机号",
      "phoneHint": "带国家码，例如 +85512345678",
      "email": "邮箱（选填）",
      "emergencyName": "紧急联系人姓名",
      "emergencyPhone": "紧急联系人电话",
      "tshirtSize": "T 恤尺码",
      "isSelf": "这是我本人"
    },
    "gender": { "M": "男", "F": "女", "X": "其他" },
    "idType": { "NATIONAL_ID": "身份证", "PASSPORT": "护照", "OTHER": "其他证件" },
    "errors": {
      "required": "必填。",
      "invalid": "格式不正确。",
      "form": "请检查标出的字段。",
      "save": "保存失败，请稍后再试。",
      "delete": "删除失败，请稍后再试。"
    }
  }
}
```

用下面内容整体替换 `packages/i18n/locales/en/user.json`：

```json
{
  "home": { "title": "Upcoming races", "viewAll": "See all events" },
  "events": { "title": "All events", "empty": "No events are open right now" },
  "event": {
    "date": "Race day",
    "city": "City",
    "categories": "Categories",
    "distance": "Distance",
    "km": "{{km}} km",
    "capacity": "Spots",
    "start": "Start",
    "cutoff": "Cut-off"
  },
  "notFound": { "title": "Page not found", "body": "The link may be out of date.", "home": "Back to home" },
  "auth": {
    "checking": "Checking your sign-in…",
    "openInTelegram": {
      "title": "Open in Telegram",
      "body": "Registration and saved runners are available in the WeRun mini app on Telegram. You can still browse events here.",
      "action": "Open Telegram"
    }
  },
  "profiles": {
    "nav": "Saved runners",
    "title": "Saved runners",
    "empty": "No saved runners yet. Runners saved here can be picked when you register.",
    "create": "Add runner",
    "createTitle": "Add runner",
    "editTitle": "Edit runner",
    "edit": "Edit",
    "delete": "Delete",
    "deleteConfirm": "Delete {{name}}?",
    "confirmDelete": "Delete",
    "cancel": "Cancel",
    "save": "Save",
    "saving": "Saving…",
    "self": "Myself",
    "idNoLabel": "ID",
    "phoneLabel": "Phone",
    "idNoKeepHint": "Current ID number {{masked}}. Leave blank to keep it.",
    "choose": "Select…",
    "fields": {
      "fullName": "Full name (as on ID)",
      "gender": "Gender",
      "birthDate": "Date of birth",
      "nationality": "Nationality",
      "nationalityHint": "Two-letter country code, e.g. KH or CN",
      "idType": "ID type",
      "idNo": "ID number",
      "phone": "Mobile number",
      "phoneHint": "Include the country code, e.g. +85512345678",
      "email": "Email (optional)",
      "emergencyName": "Emergency contact name",
      "emergencyPhone": "Emergency contact number",
      "tshirtSize": "T-shirt size",
      "isSelf": "This is me"
    },
    "gender": { "M": "Male", "F": "Female", "X": "Other" },
    "idType": { "NATIONAL_ID": "National ID", "PASSPORT": "Passport", "OTHER": "Other ID" },
    "errors": {
      "required": "Required.",
      "invalid": "Invalid format.",
      "form": "Please check the highlighted fields.",
      "save": "Couldn't save. Please try again.",
      "delete": "Couldn't delete. Please try again."
    }
  }
}
```

用下面内容整体替换 `packages/i18n/locales/km/user.json`：

```json
{
  "home": { "title": "ការរត់ខាងមុខ", "viewAll": "មើលព្រឹត្តិការណ៍ទាំងអស់" },
  "events": { "title": "ព្រឹត្តិការណ៍ទាំងអស់", "empty": "មិនទាន់មានព្រឹត្តិការណ៍បើកទេ" },
  "event": {
    "date": "ថ្ងៃប្រកួត",
    "city": "ទីក្រុង",
    "categories": "ប្រភេទ",
    "distance": "ចម្ងាយ",
    "km": "{{km}} គ.ម",
    "capacity": "ចំនួនកន្លែង",
    "start": "ចាប់ផ្ដើម",
    "cutoff": "ពេលបិទ"
  },
  "notFound": { "title": "រកមិនឃើញទំព័រ", "body": "តំណនេះប្រហែលជាហួសសុពលភាពហើយ។", "home": "ត្រឡប់ទៅទំព័រដើម" },
  "auth": {
    "checking": "កំពុងផ្ទៀងផ្ទាត់ការចូល…",
    "openInTelegram": {
      "title": "សូមបើកក្នុង Telegram",
      "body": "ការចុះឈ្មោះ និងការគ្រប់គ្រងអ្នករត់ដែលបានរក្សាទុក ត្រូវចូលតាមកម្មវិធីខ្នាតតូច WeRun ក្នុង Telegram។ អ្នកនៅតែអាចមើលព្រឹត្តិការណ៍នៅទីនេះបាន។",
      "action": "បើក Telegram"
    }
  },
  "profiles": {
    "nav": "អ្នករត់ដែលបានរក្សាទុក",
    "title": "អ្នករត់ដែលបានរក្សាទុក",
    "empty": "មិនទាន់មានអ្នករត់ដែលបានរក្សាទុកទេ។ ពេលចុះឈ្មោះ អ្នកអាចជ្រើសរើសព័ត៌មានដែលបានរក្សាទុកនៅទីនេះ។",
    "create": "បន្ថែមអ្នករត់",
    "createTitle": "បន្ថែមអ្នករត់",
    "editTitle": "កែសម្រួលអ្នករត់",
    "edit": "កែសម្រួល",
    "delete": "លុប",
    "deleteConfirm": "លុប {{name}} មែនទេ?",
    "confirmDelete": "បញ្ជាក់ការលុប",
    "cancel": "បោះបង់",
    "save": "រក្សាទុក",
    "saving": "កំពុងរក្សាទុក…",
    "self": "ខ្លួនឯង",
    "idNoLabel": "លេខឯកសារ",
    "phoneLabel": "ទូរស័ព្ទ",
    "idNoKeepHint": "លេខឯកសារបច្ចុប្បន្ន {{masked}}។ ទុកទំនេរ ប្រសិនបើមិនចង់ផ្លាស់ប្ដូរ។",
    "choose": "សូមជ្រើសរើស",
    "fields": {
      "fullName": "ឈ្មោះពេញ (ដូចក្នុងឯកសារ)",
      "gender": "ភេទ",
      "birthDate": "ថ្ងៃខែឆ្នាំកំណើត",
      "nationality": "សញ្ជាតិ",
      "nationalityHint": "លេខកូដប្រទេសពីរតួ ឧទាហរណ៍ KH ឬ CN",
      "idType": "ប្រភេទឯកសារ",
      "idNo": "លេខឯកសារ",
      "phone": "លេខទូរស័ព្ទ",
      "phoneHint": "រួមទាំងលេខកូដប្រទេស ឧទាហរណ៍ +85512345678",
      "email": "អ៊ីមែល (មិនបង្ខំ)",
      "emergencyName": "ឈ្មោះអ្នកទំនាក់ទំនងបន្ទាន់",
      "emergencyPhone": "លេខទូរស័ព្ទបន្ទាន់",
      "tshirtSize": "ទំហំអាវ",
      "isSelf": "នេះជាខ្ញុំ"
    },
    "gender": { "M": "ប្រុស", "F": "ស្រី", "X": "ផ្សេងៗ" },
    "idType": { "NATIONAL_ID": "អត្តសញ្ញាណប័ណ្ណ", "PASSPORT": "លិខិតឆ្លងដែន", "OTHER": "ឯកសារផ្សេងទៀត" },
    "errors": {
      "required": "ត្រូវតែបំពេញ។",
      "invalid": "តម្លៃមិនត្រឹមត្រូវ។",
      "form": "សូមពិនិត្យវាលដែលបានសម្គាល់។",
      "save": "រក្សាទុកមិនបានទេ។ សូមព្យាយាមម្តងទៀត។",
      "delete": "លុបមិនបានទេ។ សូមព្យាយាមម្តងទៀត។"
    }
  }
}
```

运行：

```bash
pnpm i18n:check && pnpm --filter @werun/i18n test
```

Expected：`i18n 检查通过：3 个命名空间，三种语言 key 一致`；i18n 包测试通过。

- [ ] **Step 6: AuthProvider、RequireRunner 与应用装配（先写测试）**

用下面内容整体替换 `web/user/src/test/renderApp.tsx`：

```tsx
import { render } from "@testing-library/react";
import { createMemoryRouter, type RouteObject } from "react-router";
import { vi } from "vitest";
import { createUserApp } from "../bootstrap";
import { routes } from "../routes";

export type FetchHandler = (request: Request) => Promise<Response>;

export interface RenderAppOptions {
  /** 模拟 Telegram 提供的 initData；为空时跑者处于未登录状态 */
  initData?: string | null;
}

/** 用给定路由表渲染完整应用；fetch 被替换为 handler，返回收到的请求列表 */
export function renderRoutes(routeObjects: RouteObject[], path: string, handler: FetchHandler, options: RenderAppOptions = {}) {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      requests.push(request);
      return handler(request);
    }),
  );
  const router = createMemoryRouter(routeObjects, { initialEntries: [path] });
  const app = createUserApp({
    router,
    baseUrl: "http://localhost/api",
    retry: 0,
    resolveInitData: async () => options.initData ?? null,
  });
  const view = render(app.element);
  return { ...view, router, requests, queryClient: app.queryClient, auth: app.auth };
}

/** 用真实路由表渲染应用 */
export function renderApp(path: string, handler: FetchHandler, options: RenderAppOptions = {}) {
  return renderRoutes(routes, path, handler, options);
}
```

在 `web/user/src/test/fixtures.ts` 末尾追加：

```ts
export function runnerSession(token = "tok-1"): Schemas["AppSession"] {
  return {
    token,
    expiresAt: "2099-01-01T00:00:00Z",
    user: { id: 1, telegramUserId: 10001, telegramUsername: "darasok", displayName: "Sok Dara", locale: "en" },
  };
}

export const daraProfile: Schemas["RunnerProfile"] = {
  id: 7,
  fullName: "Sok Dara",
  gender: "M",
  birthDate: "1990-05-01",
  nationality: "KH",
  idType: "NATIONAL_ID",
  idNoMasked: "******5678",
  phone: "+85512345678",
  email: "dara@example.com",
  emergencyName: "Sok Chenda",
  emergencyPhone: "+85598765432",
  tshirtSize: "M",
  isSelf: true,
};

type RouteHandler = (request: Request) => Response | Promise<Response>;

/** 按 "METHOD /api/path" 分发的假接口；遇到表里没有的请求直接抛错，便于发现多余请求 */
export function apiRoutes(table: Record<string, RouteHandler>): (request: Request) => Promise<Response> {
  return async (request) => {
    const key = `${request.method} ${new URL(request.url).pathname}`;
    const handle = table[key];
    if (!handle) {
      throw new Error(`未预期的请求 ${key}`);
    }
    return handle(request);
  };
}
```

创建 `web/user/src/auth/RequireRunner.test.tsx`：

```tsx
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { apiRoutes, jsonResponse, runnerSession } from "../test/fixtures";
import { renderRoutes } from "../test/renderApp";
import { RequireRunner } from "./RequireRunner";

const guarded = [{ path: "/", element: <RequireRunner><p>runner only</p></RequireRunner> }];

describe("RequireRunner", () => {
  it("没有 initData 时显示在 Telegram 中打开，链接指向机器人，不发请求", async () => {
    window.localStorage.setItem("werun.lang", "en");
    vi.stubEnv("VITE_TELEGRAM_BOT_USERNAME", "werun_test_bot");

    const { requests } = renderRoutes(guarded, "/", apiRoutes({}), { initData: null });

    const panel = await screen.findByTestId("open-in-telegram");
    expect(panel).toHaveTextContent("Open in Telegram");
    expect(screen.getByRole("link", { name: "Open Telegram" })).toHaveAttribute("href", "https://t.me/werun_test_bot");
    expect(screen.queryByText("runner only")).not.toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });

  it("没有配置机器人用户名时不显示链接", async () => {
    window.localStorage.setItem("werun.lang", "en");
    vi.stubEnv("VITE_TELEGRAM_BOT_USERNAME", "");

    renderRoutes(guarded, "/", apiRoutes({}), { initData: null });

    await screen.findByTestId("open-in-telegram");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("登录成功后渲染受保护内容并保存令牌", async () => {
    window.localStorage.setItem("werun.lang", "en");
    const { requests } = renderRoutes(
      guarded,
      "/",
      apiRoutes({ "POST /api/app/auth/telegram": () => jsonResponse(200, runnerSession("tok-1")) }),
      { initData: "signed-init-data" },
    );

    expect(screen.getByRole("status")).toHaveTextContent("Checking your sign-in…");
    expect(await screen.findByText("runner only")).toBeInTheDocument();
    expect(await requests[0]!.clone().json()).toEqual({ initData: "signed-init-data" });
    expect(requests[0]!.headers.get("X-WeRun-Client")).toBeNull();
    expect(window.sessionStorage.getItem("werun.appToken")).toBe("tok-1");
    expect(window.sessionStorage.getItem("werun.appTokenExpiresAt")).toBe("2099-01-01T00:00:00Z");
  });

  it("initData 校验失败时显示在 Telegram 中打开", async () => {
    window.localStorage.setItem("werun.lang", "en");
    renderRoutes(
      guarded,
      "/",
      apiRoutes({
        "POST /api/app/auth/telegram": () =>
          jsonResponse(401, { error: { code: "TELEGRAM_AUTH_INVALID", message: "We couldn't verify your Telegram sign-in." } }),
      }),
      { initData: "expired-init-data" },
    );

    expect(await screen.findByTestId("open-in-telegram")).toBeInTheDocument();
    await waitFor(() => expect(window.sessionStorage.getItem("werun.appToken")).toBeNull());
  });

  it("已有有效令牌时用 me 恢复登录", async () => {
    window.localStorage.setItem("werun.lang", "en");
    window.sessionStorage.setItem("werun.appToken", "stored-token");
    window.sessionStorage.setItem("werun.appTokenExpiresAt", "2099-01-01T00:00:00Z");

    const { requests } = renderRoutes(
      guarded,
      "/",
      apiRoutes({ "GET /api/app/me": () => jsonResponse(200, runnerSession().user) }),
      { initData: "signed-init-data" },
    );

    expect(await screen.findByText("runner only")).toBeInTheDocument();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get("Authorization")).toBe("Bearer stored-token");
  });
});
```

运行：

```bash
pnpm --filter @werun/user test -- src/auth/RequireRunner
```

Expected：FAIL，`Failed to resolve import "./RequireRunner"` 与 `"../bootstrap"`。

创建 `web/user/src/auth/AuthProvider.tsx`：

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import type { AuthController, AuthState } from "./controller";

const AuthContext = createContext<AuthController | null>(null);

/** 挂载时启动登录：有有效令牌取当前跑者，否则用 initData 登录；取不到 initData 时为未登录。 */
export function AuthProvider({ controller, children }: { controller: AuthController; children: ReactNode }) {
  useEffect(() => {
    void controller.start();
  }, [controller]);
  return <AuthContext.Provider value={controller}>{children}</AuthContext.Provider>;
}

function useAuthController(): AuthController {
  const controller = useContext(AuthContext);
  if (!controller) {
    throw new Error("useAuth 必须在 AuthProvider 内使用");
  }
  return controller;
}

export interface UseAuthResult extends AuthState {
  relogin: () => Promise<boolean>;
  logout: () => Promise<void>;
}

export function useAuth(): UseAuthResult {
  const controller = useAuthController();
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const queryClient = useQueryClient();
  return {
    status: state.status,
    user: state.user,
    relogin: () => controller.relogin(),
    logout: async () => {
      await controller.logout();
      // 清掉上一位跑者的缓存数据
      queryClient.clear();
    },
  };
}
```

创建 `web/user/src/auth/RequireRunner.tsx`：

```tsx
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Outlet } from "react-router";
import pageStyles from "../pages/Page.module.css";
import { useAuth } from "./AuthProvider";
import styles from "./RequireRunner.module.css";

/** 构建时注入的机器人用户名生成 t.me 链接；没有配置时返回 null */
export function telegramBotLink(username: string | undefined = import.meta.env.VITE_TELEGRAM_BOT_USERNAME): string | null {
  const name = username?.trim().replace(/^@/, "");
  return name ? `https://t.me/${encodeURIComponent(name)}` : null;
}

export function OpenInTelegram() {
  const { t } = useTranslation("user");
  const link = telegramBotLink();
  return (
    <section className={styles.card} data-testid="open-in-telegram">
      <h1 className={pageStyles.title}>{t("auth.openInTelegram.title")}</h1>
      <p className={styles.body}>{t("auth.openInTelegram.body")}</p>
      {link && (
        <a className={styles.action} href={link} target="_blank" rel="noreferrer">
          {t("auth.openInTelegram.action")}
        </a>
      )}
    </section>
  );
}

/** 需要跑者登录的页面包在里面；作为布局路由使用时渲染子路由。 */
export function RequireRunner({ children }: { children?: ReactNode }) {
  const { status } = useAuth();
  const { t } = useTranslation("user");

  if (status === "idle" || status === "loading") {
    return (
      <p className={pageStyles.muted} role="status">
        {t("auth.checking")}
      </p>
    );
  }
  if (status === "unauthenticated") {
    return <OpenInTelegram />;
  }
  return <>{children ?? <Outlet />}</>;
}
```

创建 `web/user/src/auth/RequireRunner.module.css`：

```css
.card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  max-width: 480px;
  margin: 32px auto;
  padding: 24px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--r);
  box-shadow: var(--shadow);
}

.body {
  color: var(--ink-mid);
}

.action {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0 20px;
  border-radius: 100px;
  background: var(--brand);
  color: var(--card);
  font-weight: 600;
}

.action:hover {
  color: var(--card);
  background: var(--brand-deep);
}
```

创建 `web/user/src/bootstrap.tsx`：

```tsx
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, createApiClient, unwrap, type ApiClient } from "@werun/api-client";
import { currentLang, initI18n } from "@werun/i18n";
import type { ReactElement } from "react";
import { I18nextProvider } from "react-i18next";
import { RouterProvider, type createMemoryRouter } from "react-router";
import { ApiProvider } from "./api";
import { AuthProvider } from "./auth/AuthProvider";
import { AuthController } from "./auth/controller";
import { readToken, resolveInitData } from "./auth/session";

/** createBrowserRouter 与 createMemoryRouter 返回同一类型 */
type DataRouter = ReturnType<typeof createMemoryRouter>;

export interface UserAppOptions {
  router: DataRouter;
  baseUrl?: string;
  /** 非 401 错误的查询重试次数，默认 1；测试传 0 */
  retry?: number;
  /** 默认按 Telegram → 开发登录参数的顺序取 initData */
  resolveInitData?: () => Promise<string | null>;
}

export interface UserApp {
  element: ReactElement;
  api: ApiClient;
  auth: AuthController;
  queryClient: QueryClient;
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/** 组装用户端：接口客户端、登录状态、查询缓存与 Provider。main.tsx 与测试共用。 */
export function createUserApp(options: UserAppOptions): UserApp {
  const i18n = initI18n("user");

  const auth = new AuthController({
    resolveInitData: options.resolveInitData ?? (() => resolveInitData()),
    login: async (initData) => unwrap(await api.POST("/app/auth/telegram", { body: { initData } })),
    me: async () => unwrap(await api.GET("/app/me")),
    logout: async () => {
      unwrap(await api.POST("/app/auth/logout"));
    },
  });

  const api = createApiClient({
    client: "user",
    baseUrl: options.baseUrl,
    getLang: currentLang,
    getAuthToken: () => readToken(),
    onUnauthorized: () => auth.handleUnauthorized(),
  });

  // 401 的查询：等这次 401 触发的重新登录结束，成功就重置并重新请求一次；同一查询再次 401 时放弃。
  const retriedAfterRelogin = new Set<string>();
  const maxRetries = options.retry ?? 1;
  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (!isUnauthorized(error)) {
          return;
        }
        if (retriedAfterRelogin.has(query.queryHash)) {
          retriedAfterRelogin.delete(query.queryHash);
          return;
        }
        retriedAfterRelogin.add(query.queryHash);
        void auth.lastRelogin().then((ok) => {
          if (ok) {
            void queryClient.resetQueries({ queryKey: query.queryKey, exact: true });
          } else {
            retriedAfterRelogin.delete(query.queryHash);
          }
        });
      },
      onSuccess: (_data, query) => {
        retriedAfterRelogin.delete(query.queryHash);
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        retry: (failureCount, error) => !isUnauthorized(error) && failureCount < maxRetries,
      },
    },
  });

  const element = (
    <I18nextProvider i18n={i18n}>
      <ApiProvider client={api}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider controller={auth}>
            <RouterProvider router={options.router} />
          </AuthProvider>
        </QueryClientProvider>
      </ApiProvider>
    </I18nextProvider>
  );
  return { element, api, auth, queryClient };
}
```

用下面内容整体替换 `web/user/src/main.tsx`：

```tsx
import "@werun/tokens/tokens.css";
import "@werun/tokens/fonts.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter } from "react-router";
import { createUserApp } from "./bootstrap";
import { routes } from "./routes";
import { initTelegram } from "./telegram/telegram";

const router = createBrowserRouter(routes);
const app = createUserApp({ router });

initTelegram(router).catch((error: unknown) => {
  // SDK 加载失败不影响网页本身可用
  console.error(error);
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("index.html 缺少 #root 节点");
}

createRoot(rootElement).render(<StrictMode>{app.element}</StrictMode>);
```

运行：

```bash
pnpm --filter @werun/user test && pnpm --filter @werun/user typecheck
```

Expected：`RequireRunner.test.tsx` 与原有的 `EventsPage`、`EventDetailPage`、`telegram`、`format`、`session`、`controller` 测试全部通过（原有页面测试不传 `initData`，登录状态为未登录，不会多出请求）；类型检查通过。

- [ ] **Step 7: 构建变量 VITE_TELEGRAM_BOT_USERNAME**

创建 `web/user/.env.development`：

```
# 本地开发时「在 Telegram 中打开」链接使用的机器人用户名；生产与 CI 通过构建参数注入
VITE_TELEGRAM_BOT_USERNAME=werun_bot
```

`.gitignore` 的 secrets 段：

旧：

```
.env
.env.*
!.env.example
```

新：

```
.env
.env.*
!.env.example
!web/user/.env.development
```

`deploy/web.Dockerfile`：

旧：

```dockerfile
COPY tsconfig.base.json ./
COPY packages ./packages
COPY web ./web
RUN pnpm --filter @werun/user --filter @werun/admin run build
```

新：

```dockerfile
COPY tsconfig.base.json ./
COPY packages ./packages
COPY web ./web
# 用户端「在 Telegram 中打开」链接里的机器人用户名，Vite 构建时写入产物
ARG VITE_TELEGRAM_BOT_USERNAME=werun_bot
ENV VITE_TELEGRAM_BOT_USERNAME=${VITE_TELEGRAM_BOT_USERNAME}
RUN pnpm --filter @werun/user --filter @werun/admin run build
```

`deploy/compose.yaml` 的 `caddy.build`：

旧：

```yaml
    build:
      context: ..
      dockerfile: deploy/web.Dockerfile
```

新：

```yaml
    build:
      context: ..
      dockerfile: deploy/web.Dockerfile
      args:
        VITE_TELEGRAM_BOT_USERNAME: ${WERUN_TELEGRAM_BOT_USERNAME:-werun_bot}
```

`.github/workflows/ci.yml`：

（1）frontend 任务：

旧：

```yaml
      - run: pnpm build
```

新：

```yaml
      - run: pnpm build
        env:
          VITE_TELEGRAM_BOT_USERNAME: werun_e2e_bot
```

（2）images 任务的 `Build and push werun-web` 步骤，在 `push: true` 之后加：

```yaml
          build-args: |
            VITE_TELEGRAM_BOT_USERNAME=${{ vars.WERUN_TELEGRAM_BOT_USERNAME || 'werun_bot' }}
```

验证：

```bash
git check-ignore -v web/user/.env.development; echo "exit=$?"
docker compose -f deploy/compose.yaml --env-file .env.example config | grep -A2 'args:'
VITE_TELEGRAM_BOT_USERNAME=werun_e2e_bot pnpm --filter @werun/user build && grep -rl 't.me' web/user/dist/assets | head -1 && grep -l 'werun_e2e_bot' web/user/dist/assets/*.js
```

Expected：`git check-ignore` 没有输出且 `exit=1`（文件不再被忽略）；compose 配置里出现 `VITE_TELEGRAM_BOT_USERNAME: werun_e2e_bot`（`.env.example` 中 Task 1 写入的值）；构建产物的 JS 中包含 `werun_e2e_bot`。

- [ ] **Step 8: 参赛人表单的前端校验（先写测试）**

前端规则与 Task 8 后端一致，只是为了在提交前就能提示；最终以服务端返回的字段错误为准。

创建 `web/user/src/profiles/validate.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { daraProfile } from "../test/fixtures";
import {
  emptyProfileForm,
  pickProfileFieldErrors,
  profileToForm,
  toProfileInput,
  validateProfileForm,
  type ProfileFormValues,
} from "./validate";

const NOW = new Date(2026, 8, 14, 10, 0, 0);

function validForm(): ProfileFormValues {
  return {
    fullName: " Chan Sreymom ",
    gender: "F",
    birthDate: "1995-02-28",
    nationality: "kh",
    idType: "PASSPORT",
    idNo: "n0 1234-9999",
    phone: "+855 11 222 333",
    email: "",
    emergencyName: "Chan Dara",
    emergencyPhone: "+85599888777",
    tshirtSize: "S",
    isSelf: false,
  };
}

describe("validateProfileForm", () => {
  it("合法输入没有错误", () => {
    expect(validateProfileForm(validForm(), { now: NOW })).toEqual({});
  });

  it("空表单列出全部必填项，邮箱除外", () => {
    expect(validateProfileForm(emptyProfileForm, { now: NOW })).toEqual({
      fullName: "required",
      gender: "required",
      birthDate: "required",
      nationality: "required",
      idType: "required",
      idNo: "required",
      phone: "required",
      emergencyName: "required",
      emergencyPhone: "required",
      tshirtSize: "required",
    });
  });

  it("编辑时证件号可以留空", () => {
    expect(validateProfileForm({ ...validForm(), idNo: "" }, { now: NOW, idNoOptional: true })).toEqual({});
  });

  it.each([
    ["fullName", "a".repeat(101)],
    ["gender", "Z"],
    ["birthDate", "1899-12-31"],
    ["birthDate", "2026-09-15"],
    ["birthDate", "1995/02/28"],
    ["nationality", "KHM"],
    ["idType", "DRIVER"],
    ["idNo", "12-3"],
    ["idNo", "AB#1234"],
    ["phone", "012345678"],
    ["phone", "+0123456789"],
    ["email", "dara@example"],
    ["emergencyName", "b".repeat(101)],
    ["emergencyPhone", "12345"],
    ["tshirtSize", "XXXL"],
  ] as const)("%s = %s 格式不正确", (field, value) => {
    expect(validateProfileForm({ ...validForm(), [field]: value }, { now: NOW })).toEqual({ [field]: "invalid" });
  });

  it("出生日期可以是今天，姓名按字符计 100 个高棉文字符合法", () => {
    expect(validateProfileForm({ ...validForm(), birthDate: "2026-09-14", fullName: "ក".repeat(100) }, { now: NOW })).toEqual({});
  });
});

describe("toProfileInput", () => {
  it("规范化并省略空的证件号与邮箱", () => {
    expect(toProfileInput(validForm())).toEqual({
      fullName: "Chan Sreymom",
      gender: "F",
      birthDate: "1995-02-28",
      nationality: "KH",
      idType: "PASSPORT",
      idNo: "N012349999",
      phone: "+85511222333",
      emergencyName: "Chan Dara",
      emergencyPhone: "+85599888777",
      tshirtSize: "S",
      isSelf: false,
    });
    const withoutIdNo = toProfileInput({ ...validForm(), idNo: " ", email: " dara@example.com " });
    expect("idNo" in withoutIdNo).toBe(false);
    expect(withoutIdNo.email).toBe("dara@example.com");
  });
});

describe("profileToForm", () => {
  it("证件号留空，其余字段带入", () => {
    expect(profileToForm(daraProfile)).toEqual({
      fullName: "Sok Dara",
      gender: "M",
      birthDate: "1990-05-01",
      nationality: "KH",
      idType: "NATIONAL_ID",
      idNo: "",
      phone: "+85512345678",
      email: "dara@example.com",
      emergencyName: "Sok Chenda",
      emergencyPhone: "+85598765432",
      tshirtSize: "M",
      isSelf: true,
    });
  });
});

describe("pickProfileFieldErrors", () => {
  it("只保留表单里存在的字段", () => {
    expect(pickProfileFieldErrors({ phone: "Invalid format.", profileId: "x", "participants[0].idNo": "y" })).toEqual({
      phone: "Invalid format.",
    });
  });
});
```

运行：

```bash
pnpm --filter @werun/user test -- src/profiles
```

Expected：FAIL，`Failed to resolve import "./validate"`。

创建 `web/user/src/profiles/validate.ts`：

```ts
import type { Schemas } from "@werun/api-client";

export const GENDERS = ["M", "F", "X"] as const;
export const ID_TYPES = ["NATIONAL_ID", "PASSPORT", "OTHER"] as const;
export const TSHIRT_SIZES = ["XS", "S", "M", "L", "XL", "XXL"] as const;

/** 表单里的原始输入，select 未选择时为空串 */
export interface ProfileFormValues {
  fullName: string;
  gender: string;
  birthDate: string;
  nationality: string;
  idType: string;
  idNo: string;
  phone: string;
  email: string;
  emergencyName: string;
  emergencyPhone: string;
  tshirtSize: string;
  isSelf: boolean;
}

export type ProfileField = Exclude<keyof ProfileFormValues, "isSelf">;
export type ProfileErrorKey = "required" | "invalid";

export const PROFILE_FIELDS: readonly ProfileField[] = [
  "fullName",
  "gender",
  "birthDate",
  "nationality",
  "idType",
  "idNo",
  "phone",
  "email",
  "emergencyName",
  "emergencyPhone",
  "tshirtSize",
];

export const emptyProfileForm: ProfileFormValues = {
  fullName: "",
  gender: "",
  birthDate: "",
  nationality: "",
  idType: "",
  idNo: "",
  phone: "",
  email: "",
  emergencyName: "",
  emergencyPhone: "",
  tshirtSize: "",
  isSelf: false,
};

const MAX_NAME_LENGTH = 100;
const MAX_EMAIL_LENGTH = 254;
const MIN_BIRTH_DATE = "1900-01-01";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const NATIONALITY = /^[A-Z]{2}$/;
const ID_NO = /^[A-Z0-9]{4,32}$/;
const PHONE = /^\+[1-9][0-9]{7,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeIdNo(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

export function normalizePhone(value: string): string {
  return value.replace(/[\s-]/g, "");
}

function localIsoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function isIn(values: readonly string[], value: string): boolean {
  return values.includes(value);
}

export interface ValidateOptions {
  /** 编辑已有资料时证件号可以留空（保留原号） */
  idNoOptional?: boolean;
  now?: Date;
}

export function validateProfileForm(values: ProfileFormValues, options: ValidateOptions = {}): Partial<Record<ProfileField, ProfileErrorKey>> {
  const errors: Partial<Record<ProfileField, ProfileErrorKey>> = {};
  const check = (field: ProfileField, value: string, valid: (v: string) => boolean) => {
    if (value === "") {
      errors[field] = "required";
    } else if (!valid(value)) {
      errors[field] = "invalid";
    }
  };
  const nameValid = (v: string) => [...v].length <= MAX_NAME_LENGTH;
  const today = localIsoDate(options.now ?? new Date());

  check("fullName", values.fullName.trim(), nameValid);
  check("gender", values.gender, (v) => isIn(GENDERS, v));
  check("birthDate", values.birthDate, (v) => ISO_DATE.test(v) && v >= MIN_BIRTH_DATE && v <= today);
  check("nationality", values.nationality.trim().toUpperCase(), (v) => NATIONALITY.test(v));
  check("idType", values.idType, (v) => isIn(ID_TYPES, v));
  const idNo = normalizeIdNo(values.idNo);
  if (idNo !== "" || !options.idNoOptional) {
    check("idNo", idNo, (v) => ID_NO.test(v));
  }
  check("phone", normalizePhone(values.phone), (v) => PHONE.test(v));
  const email = values.email.trim();
  if (email !== "" && (email.length > MAX_EMAIL_LENGTH || !EMAIL.test(email))) {
    errors.email = "invalid";
  }
  check("emergencyName", values.emergencyName.trim(), nameValid);
  check("emergencyPhone", normalizePhone(values.emergencyPhone), (v) => PHONE.test(v));
  check("tshirtSize", values.tshirtSize, (v) => isIn(TSHIRT_SIZES, v));
  return errors;
}

/** 转为接口请求体；调用前已通过 validateProfileForm，枚举字段可以直接断言类型。 */
export function toProfileInput(values: ProfileFormValues): Schemas["ProfileInput"] {
  const idNo = normalizeIdNo(values.idNo);
  const email = values.email.trim();
  return {
    fullName: values.fullName.trim(),
    gender: values.gender as Schemas["Gender"],
    birthDate: values.birthDate,
    nationality: values.nationality.trim().toUpperCase(),
    idType: values.idType as Schemas["IdType"],
    ...(idNo ? { idNo } : {}),
    phone: normalizePhone(values.phone),
    ...(email ? { email } : {}),
    emergencyName: values.emergencyName.trim(),
    emergencyPhone: normalizePhone(values.emergencyPhone),
    tshirtSize: values.tshirtSize as Schemas["TShirtSize"],
    isSelf: values.isSelf,
  };
}

/** 编辑时回填；接口不返回完整证件号，证件号留空表示保留。 */
export function profileToForm(profile: Schemas["RunnerProfile"]): ProfileFormValues {
  return {
    fullName: profile.fullName,
    gender: profile.gender,
    birthDate: profile.birthDate,
    nationality: profile.nationality,
    idType: profile.idType,
    idNo: "",
    phone: profile.phone,
    email: profile.email,
    emergencyName: profile.emergencyName,
    emergencyPhone: profile.emergencyPhone,
    tshirtSize: profile.tshirtSize,
    isSelf: profile.isSelf,
  };
}

/** 从 ApiError.fields（已翻译的文案）中挑出本表单的字段 */
export function pickProfileFieldErrors(fields: Record<string, string>): Partial<Record<ProfileField, string>> {
  const picked: Partial<Record<ProfileField, string>> = {};
  for (const field of PROFILE_FIELDS) {
    const message = fields[field];
    if (message) {
      picked[field] = message;
    }
  }
  return picked;
}
```

运行：

```bash
pnpm --filter @werun/user test -- src/profiles && pnpm --filter @werun/user typecheck
```

Expected：`validate.test.ts` 全部通过；类型检查通过。

- [ ] **Step 9: 常用参赛人页面的失败测试**

创建 `web/user/src/pages/ProfilesPage.test.tsx`：

```tsx
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Schemas } from "@werun/api-client";
import { beforeEach, describe, expect, it } from "vitest";
import { apiRoutes, daraProfile, jsonResponse, runnerSession } from "../test/fixtures";
import { renderApp } from "../test/renderApp";

type User = ReturnType<typeof userEvent.setup>;

const pathOf = (request: Request) => new URL(request.url).pathname;
const unauthorized = () => jsonResponse(401, { error: { code: "UNAUTHENTICATED", message: "Please sign in." } });

async function fillValidProfile(user: User) {
  await user.type(screen.getByTestId("profile-fullName"), "Chan Sreymom");
  await user.selectOptions(screen.getByTestId("profile-gender"), "F");
  fireEvent.change(screen.getByTestId("profile-birthDate"), { target: { value: "1995-02-28" } });
  await user.type(screen.getByTestId("profile-nationality"), "kh");
  await user.selectOptions(screen.getByTestId("profile-idType"), "PASSPORT");
  await user.type(screen.getByTestId("profile-idNo"), "n0 1234-9999");
  await user.type(screen.getByTestId("profile-phone"), "+855 11 222 333");
  await user.type(screen.getByTestId("profile-emergencyName"), "Chan Dara");
  await user.type(screen.getByTestId("profile-emergencyPhone"), "+85599888777");
  await user.selectOptions(screen.getByTestId("profile-tshirtSize"), "S");
}

beforeEach(() => {
  window.localStorage.setItem("werun.lang", "en");
});

describe("ProfilesPage", () => {
  it("登录后列出常用参赛人，证件号只显示后 4 位，请求带跑者令牌", async () => {
    const { requests } = renderApp(
      "/profiles",
      apiRoutes({
        "POST /api/app/auth/telegram": () => jsonResponse(200, runnerSession("tok-1")),
        "GET /api/app/profiles": () => jsonResponse(200, { items: [daraProfile] }),
      }),
      { initData: "signed-init-data" },
    );

    const item = await screen.findByTestId("profile-item-7");
    expect(item).toHaveTextContent("Sok Dara");
    expect(item).toHaveTextContent("******5678");
    expect(item).toHaveTextContent("+85512345678");
    expect(item).toHaveTextContent("Myself");
    expect(screen.getByRole("heading", { name: "Saved runners" })).toBeInTheDocument();
    const list = requests.find((r) => pathOf(r) === "/api/app/profiles")!;
    expect(list.headers.get("Authorization")).toBe("Bearer tok-1");
  });

  it("没有资料时显示空状态", async () => {
    renderApp(
      "/profiles",
      apiRoutes({
        "POST /api/app/auth/telegram": () => jsonResponse(200, runnerSession()),
        "GET /api/app/profiles": () => jsonResponse(200, { items: [] }),
      }),
      { initData: "signed-init-data" },
    );

    expect(await screen.findByText(/No saved runners yet/)).toBeInTheDocument();
  });

  it("不在 Telegram 中时显示 open-in-telegram，不请求参赛人", async () => {
    const { requests } = renderApp("/profiles", apiRoutes({}), { initData: null });

    expect(await screen.findByTestId("open-in-telegram")).toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });

  it("提交空表单时逐项提示必填，不发请求", async () => {
    const user = userEvent.setup();
    const { requests } = renderApp(
      "/profiles",
      apiRoutes({
        "POST /api/app/auth/telegram": () => jsonResponse(200, runnerSession()),
        "GET /api/app/profiles": () => jsonResponse(200, { items: [] }),
      }),
      { initData: "signed-init-data" },
    );

    await user.click(await screen.findByTestId("profile-create"));
    await user.click(screen.getByTestId("profile-submit"));

    expect(screen.getByTestId("form-error")).toHaveTextContent("Please check the highlighted fields.");
    expect(screen.getByTestId("profile-fullName-error")).toHaveTextContent("Required.");
    expect(screen.getByTestId("profile-idNo-error")).toHaveTextContent("Required.");
    expect(screen.getByTestId("profile-tshirtSize-error")).toHaveTextContent("Required.");
    expect(screen.queryByTestId("profile-email-error")).not.toBeInTheDocument();
    expect(screen.getByTestId("profile-fullName")).toHaveAttribute("aria-invalid", "true");
    expect(requests.some((r) => r.method === "POST" && pathOf(r) === "/api/app/profiles")).toBe(false);
  });

  it("新建成功后回到列表并显示新资料", async () => {
    const user = userEvent.setup();
    let items: Schemas["RunnerProfile"][] = [];
    let posted: unknown;
    renderApp(
      "/profiles",
      apiRoutes({
        "POST /api/app/auth/telegram": () => jsonResponse(200, runnerSession()),
        "GET /api/app/profiles": () => jsonResponse(200, { items }),
        "POST /api/app/profiles": async (request) => {
          posted = await request.clone().json();
          const created: Schemas["RunnerProfile"] = {
            ...daraProfile,
            id: 8,
            fullName: "Chan Sreymom",
            gender: "F",
            idType: "PASSPORT",
            idNoMasked: "******9999",
            isSelf: false,
          };
          items = [created];
          return jsonResponse(201, created);
        },
      }),
      { initData: "signed-init-data" },
    );

    await user.click(await screen.findByTestId("profile-create"));
    await fillValidProfile(user);
    await user.click(screen.getByTestId("profile-submit"));

    expect(await screen.findByTestId("profile-item-8")).toHaveTextContent("******9999");
    expect(screen.queryByTestId("profile-submit")).not.toBeInTheDocument();
    expect(posted).toEqual({
      fullName: "Chan Sreymom",
      gender: "F",
      birthDate: "1995-02-28",
      nationality: "KH",
      idType: "PASSPORT",
      idNo: "N012349999",
      phone: "+85511222333",
      emergencyName: "Chan Dara",
      emergencyPhone: "+85599888777",
      tshirtSize: "S",
      isSelf: false,
    });
  });

  it("编辑时证件号留空，请求体不带 idNo", async () => {
    const user = userEvent.setup();
    let put: { path: string; body: Record<string, unknown> } | undefined;
    renderApp(
      "/profiles",
      apiRoutes({
        "POST /api/app/auth/telegram": () => jsonResponse(200, runnerSession()),
        "GET /api/app/profiles": () => jsonResponse(200, { items: [daraProfile] }),
        "PUT /api/app/profiles/7": async (request) => {
          put = { path: pathOf(request), body: (await request.clone().json()) as Record<string, unknown> };
          return jsonResponse(200, { ...daraProfile, fullName: "Sok Dara Jr" });
        },
      }),
      { initData: "signed-init-data" },
    );

    await user.click(await screen.findByTestId("profile-edit-7"));
    const fullName = screen.getByTestId("profile-fullName");
    expect(fullName).toHaveValue("Sok Dara");
    expect(screen.getByTestId("profile-idNo")).toHaveValue("");
    expect(screen.getByText("Current ID number ******5678. Leave blank to keep it.")).toBeInTheDocument();
    expect(screen.getByTestId("profile-isSelf")).toBeChecked();
    await user.clear(fullName);
    await user.type(fullName, "Sok Dara Jr");
    await user.click(screen.getByTestId("profile-submit"));

    await waitFor(() => expect(put).toBeDefined());
    expect(put!.path).toBe("/api/app/profiles/7");
    expect(put!.body.fullName).toBe("Sok Dara Jr");
    expect("idNo" in put!.body).toBe(false);
    expect(put!.body.isSelf).toBe(true);
    expect(await screen.findByTestId("profile-item-7")).toBeInTheDocument();
  });

  it("服务端字段错误显示在对应字段下", async () => {
    const user = userEvent.setup();
    renderApp(
      "/profiles",
      apiRoutes({
        "POST /api/app/auth/telegram": () => jsonResponse(200, runnerSession()),
        "GET /api/app/profiles": () => jsonResponse(200, { items: [] }),
        "POST /api/app/profiles": () =>
          jsonResponse(422, {
            error: {
              code: "VALIDATION_FAILED",
              message: "Please check the highlighted fields.",
              fields: { phone: "Invalid format." },
            },
          }),
      }),
      { initData: "signed-init-data" },
    );

    await user.click(await screen.findByTestId("profile-create"));
    await fillValidProfile(user);
    await user.click(screen.getByTestId("profile-submit"));

    expect(await screen.findByTestId("profile-phone-error")).toHaveTextContent("Invalid format.");
    expect(screen.getByTestId("form-error")).toHaveTextContent("Please check the highlighted fields.");
    expect(screen.getByTestId("profile-submit")).toBeEnabled();
  });

  it("取消编辑回到列表，不发请求", async () => {
    const user = userEvent.setup();
    const { requests } = renderApp(
      "/profiles",
      apiRoutes({
        "POST /api/app/auth/telegram": () => jsonResponse(200, runnerSession()),
        "GET /api/app/profiles": () => jsonResponse(200, { items: [daraProfile] }),
      }),
      { initData: "signed-init-data" },
    );

    await user.click(await screen.findByTestId("profile-edit-7"));
    await user.click(screen.getByTestId("profile-cancel"));

    expect(await screen.findByTestId("profile-item-7")).toBeInTheDocument();
    expect(requests.filter((r) => r.method !== "GET" && pathOf(r) !== "/api/app/auth/telegram")).toHaveLength(0);
  });

  it("删除需要二次确认", async () => {
    const user = userEvent.setup();
    let items: Schemas["RunnerProfile"][] = [daraProfile];
    const deleted: string[] = [];
    renderApp(
      "/profiles",
      apiRoutes({
        "POST /api/app/auth/telegram": () => jsonResponse(200, runnerSession()),
        "GET /api/app/profiles": () => jsonResponse(200, { items }),
        "DELETE /api/app/profiles/7": (request) => {
          deleted.push(pathOf(request));
          items = [];
          return new Response(null, { status: 204 });
        },
      }),
      { initData: "signed-init-data" },
    );

    await user.click(await screen.findByTestId("profile-delete-7"));
    expect(screen.getByText("Delete Sok Dara?")).toBeInTheDocument();
    expect(deleted).toHaveLength(0);

    await user.click(screen.getByTestId("profile-delete-cancel-7"));
    expect(screen.queryByTestId("profile-delete-confirm-7")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("profile-delete-7"));
    await user.click(screen.getByTestId("profile-delete-confirm-7"));

    expect(await screen.findByText(/No saved runners yet/)).toBeInTheDocument();
    expect(deleted).toEqual(["/api/app/profiles/7"]);
  });

  it("令牌失效时用 initData 重新登录一次并重试查询", async () => {
    let logins = 0;
    const listAuth: (string | null)[] = [];
    renderApp(
      "/profiles",
      apiRoutes({
        "POST /api/app/auth/telegram": () => {
          logins += 1;
          return jsonResponse(200, runnerSession(`tok-${logins}`));
        },
        "GET /api/app/profiles": (request) => {
          const authorization = request.headers.get("Authorization");
          listAuth.push(authorization);
          return authorization === "Bearer tok-1" ? unauthorized() : jsonResponse(200, { items: [daraProfile] });
        },
      }),
      { initData: "signed-init-data" },
    );

    expect(await screen.findByTestId("profile-item-7")).toBeInTheDocument();
    expect(logins).toBe(2);
    expect(listAuth).toEqual(["Bearer tok-1", "Bearer tok-2"]);
    expect(window.sessionStorage.getItem("werun.appToken")).toBe("tok-2");
  });

  it("重新登录后仍然 401 时只重试一次", async () => {
    let logins = 0;
    let listCalls = 0;
    renderApp(
      "/profiles",
      apiRoutes({
        "POST /api/app/auth/telegram": () => {
          logins += 1;
          return jsonResponse(200, runnerSession(`tok-${logins}`));
        },
        "GET /api/app/profiles": () => {
          listCalls += 1;
          return unauthorized();
        },
      }),
      { initData: "signed-init-data" },
    );

    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
    await waitFor(() => expect(logins).toBe(3));
    expect(listCalls).toBe(2);
  });

  it("重新登录失败时显示 open-in-telegram", async () => {
    let logins = 0;
    renderApp(
      "/profiles",
      apiRoutes({
        "POST /api/app/auth/telegram": () => {
          logins += 1;
          return logins === 1
            ? jsonResponse(200, runnerSession("tok-1"))
            : jsonResponse(401, { error: { code: "TELEGRAM_AUTH_INVALID", message: "Open the mini app again." } });
        },
        "GET /api/app/profiles": unauthorized,
      }),
      { initData: "signed-init-data" },
    );

    expect(await screen.findByTestId("open-in-telegram")).toBeInTheDocument();
    expect(logins).toBe(2);
    expect(window.sessionStorage.getItem("werun.appToken")).toBeNull();
  });
});
```

说明「只重试一次」用例里 `logins` 为 3 的原因：启动登录 1 次；第一次 401 触发重登录 1 次，查询随后重试；重试又得到 401，中间件再触发 1 次重登录，但 `QueryCache` 发现这个查询已经重试过，于是放弃并显示错误和「Retry」按钮。

运行：

```bash
pnpm --filter @werun/user test -- src/pages/ProfilesPage
```

Expected：FAIL。`/profiles` 路由还不存在，页面渲染 404，`findByTestId("profile-item-7")` 等超时。

- [ ] **Step 10: 实现常用参赛人页面**

在 `web/user/src/queries.ts` 中把第一行 import 改为：

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@werun/api-client";
```

并在文件末尾追加：

```ts
/** 常用参赛人接口不按语言返回文案，查询 key 不带语言 */
export const PROFILES_KEY = ["profiles"] as const;

export function useProfiles() {
  const api = useApi();
  return useQuery({
    queryKey: PROFILES_KEY,
    queryFn: async () => unwrap(await api.GET("/app/profiles")).items,
  });
}

export function useCreateProfile() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: Schemas["ProfileInput"]) => unwrap(await api.POST("/app/profiles", { body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PROFILES_KEY }),
  });
}

export function useUpdateProfile() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id: number; body: Schemas["ProfileInput"] }) =>
      unwrap(await api.PUT("/app/profiles/{id}", { params: { path: { id } }, body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PROFILES_KEY }),
  });
}

export function useDeleteProfile() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      unwrap(await api.DELETE("/app/profiles/{id}", { params: { path: { id } } }));
    },
    // 404（已被删除）时同样刷新列表
    onSettled: () => queryClient.invalidateQueries({ queryKey: PROFILES_KEY }),
  });
}
```

创建 `web/user/src/profiles/ProfileFields.tsx`：

```tsx
import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import styles from "./ProfileFields.module.css";
import { GENDERS, ID_TYPES, TSHIRT_SIZES, type ProfileField, type ProfileFormValues } from "./validate";

export interface ProfileFieldsProps {
  values: ProfileFormValues;
  /** 已翻译的字段错误文案 */
  errors: Partial<Record<ProfileField, string>>;
  onChange: (patch: Partial<ProfileFormValues>) => void;
  /** testid 前缀：常用参赛人页为 profile，报名向导第 2 步为 participant-<i> */
  testIdPrefix: string;
  /** 证件号下方的提示，编辑时说明留空保留原号 */
  idNoHint?: string;
  showIsSelf?: boolean;
}

/** 一位参赛人的资料字段，全部为原生表单元素，每个元素带 `<prefix>-<field>` testid。 */
export function ProfileFields({ values, errors, onChange, testIdPrefix, idNoHint, showIsSelf = false }: ProfileFieldsProps) {
  const { t } = useTranslation("user");
  const baseId = useId();
  const idFor = (name: string) => `${baseId}-${name}`;
  const set = (field: ProfileField, value: string) => onChange({ [field]: value } as Partial<ProfileFormValues>);

  const controlProps = (field: ProfileField) => ({
    id: idFor(field),
    name: field,
    "data-testid": `${testIdPrefix}-${field}`,
    "aria-invalid": errors[field] ? true : undefined,
    "aria-describedby": errors[field] ? idFor(`${field}-error`) : undefined,
    className: styles.control,
  });

  const input = (field: ProfileField, extra: InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input {...controlProps(field)} {...extra} value={values[field]} onChange={(event) => set(field, event.target.value)} />
  );

  const select = (field: ProfileField, options: readonly string[], label: (value: string) => string) => (
    <select {...controlProps(field)} value={values[field]} onChange={(event) => set(field, event.target.value)}>
      <option value="">{t("profiles.choose")}</option>
      {options.map((option) => (
        <option key={option} value={option}>
          {label(option)}
        </option>
      ))}
    </select>
  );

  const row = (field: ProfileField, control: ReactNode, hint?: string) => (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={idFor(field)}>
        {t(`profiles.fields.${field}`)}
      </label>
      {control}
      {hint && <p className={styles.hint}>{hint}</p>}
      {errors[field] && (
        <p id={idFor(`${field}-error`)} className={styles.error} data-testid={`${testIdPrefix}-${field}-error`}>
          {errors[field]}
        </p>
      )}
    </div>
  );

  return (
    <div className={styles.grid}>
      {row("fullName", input("fullName", { autoComplete: "name", maxLength: 100 }))}
      {row("gender", select("gender", GENDERS, (value) => t(`profiles.gender.${value}`)))}
      {row("birthDate", input("birthDate", { type: "date", min: "1900-01-01" }))}
      {row("nationality", input("nationality", { maxLength: 2, autoCapitalize: "characters" }), t("profiles.fields.nationalityHint"))}
      {row("idType", select("idType", ID_TYPES, (value) => t(`profiles.idType.${value}`)))}
      {row("idNo", input("idNo", { autoComplete: "off", maxLength: 40 }), idNoHint)}
      {row("phone", input("phone", { type: "tel", autoComplete: "tel", inputMode: "tel" }), t("profiles.fields.phoneHint"))}
      {row("email", input("email", { type: "email", autoComplete: "email" }))}
      {row("emergencyName", input("emergencyName", { maxLength: 100 }))}
      {row("emergencyPhone", input("emergencyPhone", { type: "tel", inputMode: "tel" }))}
      {row("tshirtSize", select("tshirtSize", TSHIRT_SIZES, (value) => value))}
      {showIsSelf && (
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            name="isSelf"
            data-testid={`${testIdPrefix}-isSelf`}
            checked={values.isSelf}
            onChange={(event) => onChange({ isSelf: event.target.checked })}
          />
          {t("profiles.fields.isSelf")}
        </label>
      )}
    </div>
  );
}
```

创建 `web/user/src/profiles/ProfileFields.module.css`：

```css
.grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 14px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.label {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
}

.control {
  min-height: 44px;
  padding: 0 12px;
  border: 1px solid var(--line-hard);
  border-radius: 10px;
  background: var(--card);
  color: var(--ink);
  font: inherit;
}

.control:focus {
  outline: 2px solid var(--brand);
  outline-offset: 1px;
}

.control[aria-invalid="true"] {
  border-color: var(--stop);
}

.hint {
  font-size: 12px;
  color: var(--ink-mute);
}

.error {
  font-size: 13px;
  color: var(--stop);
}

.checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  font-weight: 600;
}

.checkbox input {
  width: 20px;
  height: 20px;
  accent-color: var(--brand);
}

@media (min-width: 768px) {
  .grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .checkbox {
    grid-column: 1 / -1;
  }
}
```

创建 `web/user/src/pages/ProfilesPage.tsx`：

```tsx
import { ApiError, type Schemas } from "@werun/api-client";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { QueryState } from "../components/QueryState";
import { ProfileFields } from "../profiles/ProfileFields";
import {
  PROFILE_FIELDS,
  emptyProfileForm,
  pickProfileFieldErrors,
  profileToForm,
  toProfileInput,
  validateProfileForm,
  type ProfileField,
  type ProfileFormValues,
} from "../profiles/validate";
import { useCreateProfile, useDeleteProfile, useProfiles, useUpdateProfile } from "../queries";
import pageStyles from "./Page.module.css";
import styles from "./ProfilesPage.module.css";

type Profile = Schemas["RunnerProfile"];
type Mode = { kind: "list" } | { kind: "create" } | { kind: "edit"; profile: Profile };

export function ProfilesPage() {
  const { t } = useTranslation("user");
  const profiles = useProfiles();
  const [mode, setMode] = useState<Mode>({ kind: "list" });

  if (mode.kind !== "list") {
    const profile = mode.kind === "edit" ? mode.profile : null;
    return <ProfileEditor key={profile?.id ?? "new"} profile={profile} onDone={() => setMode({ kind: "list" })} />;
  }

  return (
    <section>
      <div className={styles.head}>
        <h1 className={pageStyles.title}>{t("profiles.title")}</h1>
        <button type="button" className={styles.primary} data-testid="profile-create" onClick={() => setMode({ kind: "create" })}>
          {t("profiles.create")}
        </button>
      </div>
      <QueryState query={profiles}>
        {(items) =>
          items.length === 0 ? (
            <p className={pageStyles.muted}>{t("profiles.empty")}</p>
          ) : (
            <ul className={styles.list}>
              {items.map((profile) => (
                <ProfileItem key={profile.id} profile={profile} onEdit={() => setMode({ kind: "edit", profile })} />
              ))}
            </ul>
          )
        }
      </QueryState>
    </section>
  );
}

function ProfileItem({ profile, onEdit }: { profile: Profile; onEdit: () => void }) {
  const { t } = useTranslation("user");
  const remove = useDeleteProfile();
  const [confirming, setConfirming] = useState(false);

  return (
    <li className={styles.item} data-testid={`profile-item-${profile.id}`}>
      <div className={styles.itemHead}>
        <span className={styles.name}>{profile.fullName}</span>
        {profile.isSelf && <span className={styles.badge}>{t("profiles.self")}</span>}
      </div>
      <dl className={styles.meta}>
        <div>
          <dt>{t("profiles.idNoLabel")}</dt>
          <dd className={styles.mono}>{profile.idNoMasked}</dd>
        </div>
        <div>
          <dt>{t("profiles.phoneLabel")}</dt>
          <dd className={styles.mono}>{profile.phone}</dd>
        </div>
      </dl>
      {confirming ? (
        <div className={styles.confirm}>
          <p>{t("profiles.deleteConfirm", { name: profile.fullName })}</p>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.danger}
              data-testid={`profile-delete-confirm-${profile.id}`}
              disabled={remove.isPending}
              onClick={() => remove.mutate(profile.id)}
            >
              {t("profiles.confirmDelete")}
            </button>
            <button
              type="button"
              className={styles.secondary}
              data-testid={`profile-delete-cancel-${profile.id}`}
              onClick={() => setConfirming(false)}
            >
              {t("profiles.cancel")}
            </button>
          </div>
          {remove.isError && (
            <p role="alert">{remove.error instanceof ApiError ? remove.error.message : t("profiles.errors.delete")}</p>
          )}
        </div>
      ) : (
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} data-testid={`profile-edit-${profile.id}`} onClick={onEdit}>
            {t("profiles.edit")}
          </button>
          <button type="button" className={styles.secondary} data-testid={`profile-delete-${profile.id}`} onClick={() => setConfirming(true)}>
            {t("profiles.delete")}
          </button>
        </div>
      )}
    </li>
  );
}

function ProfileEditor({ profile, onDone }: { profile: Profile | null; onDone: () => void }) {
  const { t } = useTranslation("user");
  const create = useCreateProfile();
  const update = useUpdateProfile();
  const [values, setValues] = useState<ProfileFormValues>(() => (profile ? profileToForm(profile) : emptyProfileForm));
  const [errors, setErrors] = useState<Partial<Record<ProfileField, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const saving = create.isPending || update.isPending;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found = validateProfileForm(values, { idNoOptional: profile !== null });
    const messages: Partial<Record<ProfileField, string>> = {};
    for (const field of PROFILE_FIELDS) {
      const key = found[field];
      if (key) {
        messages[field] = t(`profiles.errors.${key}`);
      }
    }
    setErrors(messages);
    if (Object.keys(messages).length > 0) {
      setFormError(t("profiles.errors.form"));
      return;
    }
    setFormError(null);

    const body = toProfileInput(values);
    try {
      if (profile) {
        await update.mutateAsync({ id: profile.id, body });
      } else {
        await create.mutateAsync(body);
      }
      onDone();
    } catch (error) {
      if (error instanceof ApiError) {
        setErrors(pickProfileFieldErrors(error.fields));
        setFormError(error.message);
      } else {
        setFormError(t("profiles.errors.save"));
      }
    }
  };

  return (
    <section>
      <h1 className={pageStyles.title}>{t(profile ? "profiles.editTitle" : "profiles.createTitle")}</h1>
      <form className={styles.form} noValidate onSubmit={(event) => void submit(event)}>
        {formError && (
          <p className={styles.formError} role="alert" data-testid="form-error">
            {formError}
          </p>
        )}
        <ProfileFields
          values={values}
          errors={errors}
          onChange={(patch) => setValues((current) => ({ ...current, ...patch }))}
          testIdPrefix="profile"
          idNoHint={profile ? t("profiles.idNoKeepHint", { masked: profile.idNoMasked }) : undefined}
          showIsSelf
        />
        <div className={styles.actions}>
          <button type="submit" className={styles.primary} data-testid="profile-submit" disabled={saving}>
            {saving ? t("profiles.saving") : t("profiles.save")}
          </button>
          <button type="button" className={styles.secondary} data-testid="profile-cancel" onClick={onDone}>
            {t("profiles.cancel")}
          </button>
        </div>
      </form>
    </section>
  );
}
```

创建 `web/user/src/pages/ProfilesPage.module.css`：

```css
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}

.head h1 {
  margin-bottom: 0;
}

.list {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.item {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--r);
  box-shadow: var(--shadow);
}

.itemHead {
  display: flex;
  align-items: center;
  gap: 8px;
}

.name {
  font-size: 17px;
  font-weight: 700;
}

.badge {
  padding: 2px 8px;
  border-radius: 100px;
  background: var(--brand-tint);
  color: var(--brand);
  font-size: 12px;
  font-weight: 600;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 20px;
  margin: 0;
  font-size: 14px;
  color: var(--ink-mid);
}

.meta div {
  display: flex;
  gap: 6px;
}

.meta dd {
  margin: 0;
}

.mono {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.primary,
.secondary,
.danger {
  min-height: 44px;
  padding: 0 18px;
  border-radius: 100px;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.primary {
  border: 1px solid var(--brand);
  background: var(--brand);
  color: var(--card);
}

.secondary {
  border: 1px solid var(--line-hard);
  background: var(--card);
  color: var(--ink);
}

.danger {
  border: 1px solid var(--stop);
  background: var(--stop);
  color: var(--card);
}

.primary:disabled,
.danger:disabled {
  opacity: 0.6;
  cursor: default;
}

.confirm {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: 10px;
  background: var(--stop-tint);
  color: var(--stop);
}

.form {
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 720px;
}

.formError {
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--stop-tint);
  color: var(--stop);
}

@media (min-width: 1024px) {
  .list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
```

用下面内容整体替换 `web/user/src/routes.tsx`：

```tsx
import type { RouteObject } from "react-router";
import { RequireRunner } from "./auth/RequireRunner";
import { Layout } from "./components/Layout";
import { EventDetailPage } from "./pages/EventDetailPage";
import { EventsPage } from "./pages/EventsPage";
import { HomePage } from "./pages/HomePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { ProfilesPage } from "./pages/ProfilesPage";

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "events", element: <EventsPage /> },
      { path: "events/:slug", element: <EventDetailPage /> },
      {
        // 需要跑者登录的页面；Task 14、18、22 的页面也加在这里
        element: <RequireRunner />,
        children: [{ path: "profiles", element: <ProfilesPage /> }],
      },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];
```

`web/user/src/components/Layout.tsx` 的导航：

旧：

```tsx
            <NavLink to="/events" className={navClass}>
              {t("common:nav.events")}
            </NavLink>
```

新：

```tsx
            <NavLink to="/events" className={navClass}>
              {t("common:nav.events")}
            </NavLink>
            <NavLink to="/profiles" className={navClass}>
              {t("profiles.nav")}
            </NavLink>
```

运行：

```bash
pnpm --filter @werun/user test && pnpm --filter @werun/user typecheck
```

Expected：`ProfilesPage.test.tsx` 全部通过，其余测试不受影响；类型检查通过。

- [ ] **Step 11: 全量检查**

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm i18n:check
VITE_TELEGRAM_BOT_USERNAME=werun_e2e_bot pnpm build
```

Expected：五条命令全部成功；`pnpm test` 中 api-client、i18n、user、admin 各包测试通过。

- [ ] **Step 12: 本地手动验证登录与参赛人页面**

```bash
make dev
```

另开终端：

```bash
INIT_DATA=$(set -a; . ./.env; set +a; cd api && go run ./cmd/werun dev-initdata --telegram-id 10001 --name "Sok Dara" --lang km)
node -e 'console.log("http://werun.localhost/profiles?devInitData=" + encodeURIComponent(process.argv[1]))' "$INIT_DATA"
```

Expected：
- 在浏览器打开输出的地址后，页面显示「អ្នករត់ដែលបានរក្សាទុក」空状态；开发者工具 Application → Session Storage 中出现 `werun.appToken`、`werun.appTokenExpiresAt`、`werun.devInitData`；
- 新建一位参赛人后，列表只显示证件号后 4 位；
- 刷新页面（地址不带 `devInitData`）后，仍然用存下的令牌恢复登录；
- 手动删除 `werun.appToken` 并刷新，会用 `werun.devInitData` 重新登录；
- 在无痕窗口直接打开 `http://werun.localhost/profiles`，显示 `open-in-telegram` 面板，按钮指向 `https://t.me/werun_bot`。

- [ ] **Step 13: 提交**

```bash
git add packages/api-client/src/client.ts packages/api-client/src/client.test.ts \
  packages/i18n/locales/zh/user.json packages/i18n/locales/en/user.json packages/i18n/locales/km/user.json \
  web/user/src/telegram/telegram.ts web/user/src/telegram/telegram.test.ts \
  web/user/src/auth web/user/src/bootstrap.tsx web/user/src/main.tsx web/user/src/routes.tsx \
  web/user/src/queries.ts web/user/src/components/Layout.tsx \
  web/user/src/test/renderApp.tsx web/user/src/test/setup.ts web/user/src/test/fixtures.ts \
  web/user/src/vite-env.d.ts web/user/.env.development \
  web/user/src/profiles web/user/src/pages/ProfilesPage.tsx web/user/src/pages/ProfilesPage.module.css web/user/src/pages/ProfilesPage.test.tsx \
  .gitignore deploy/web.Dockerfile deploy/compose.yaml .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
feat(user): Telegram sign-in, runner session handling and saved runners page

- api-client getAuthToken sends Authorization: Bearer
- AuthController: initData login, sessionStorage token, single relogin on 401
- QueryCache retries a 401 query once after the relogin settles
- RequireRunner shows open-in-telegram with a t.me link (VITE_TELEGRAM_BOT_USERNAME)
- /profiles: list, create, edit (blank ID keeps the stored number), delete with confirm
- user.auth.* / user.profiles.* in zh, en, km

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
)"
```
