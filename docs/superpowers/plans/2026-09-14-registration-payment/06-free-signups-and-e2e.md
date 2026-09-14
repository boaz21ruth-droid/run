# 第 6 段：免费报名与端到端（Task 22–23）

> 本文件的每个任务都受 `00-overview.md` 的 Global Constraints 与「跨任务契约」约束：名字、签名、operationId、错误码、审计 action、data-testid（§10）、路由、环境变量与种子约定（§11）以及实现调整 #5（Playwright 替换 Telegram SDK）、#6（`publish-consent` 参数）一律照用。Task 1–21 视为已按总览完成。

## 契约补充

以下是总览没有写明、本段需要依赖或新增的约定。只增不改，后续任务按此执行。

1. **`runner.ContactFields` 与 `runner.ValidateContactFields`（Task 22 新增导出）**。总览只导出了整份资料的 `ValidateProfile`，免费报名只有姓名、手机、紧急联系人、可选性别与出生日期。为了与 `ValidateProfile` 规则完全一致而不复制规则，新函数把这几个字段放进一份占位完整的 `ProfileData` 调用 `ValidateProfile`，只保留这六个字段的错误：

   ```go
   type ContactFields struct {
   	FullName, Phone, EmergencyName, EmergencyPhone string
   	Gender    *string    // nil = 未填写
   	BirthDate *time.Time // nil = 未填写
   }
   func ValidateContactFields(in ContactFields, fieldPrefix string) error // 返回 apperr VALIDATION_FAILED 或 nil
   ```

   依赖 `ValidateProfile` 的字段键为 `<fieldPrefix>fullName`、`gender`、`birthDate`、`phone`、`emergencyName`、`emergencyPhone`（与 OpenAPI 小驼峰一致）；Task 22 Step 1 的测试直接验证这一点。
2. **`registration.Service` 的未导出字段**：`pool *pgxpool.Pool`、`runners *runner.Service`、`now func() time.Time`（与 `event.Service` 写法一致，Task 12 建立）；`registration.Handlers` 持有 `svc *Service`。`free.go` / `free_handlers.go` 直接使用这些字段。
3. **免费报名的 sqlc 查询**（追加到 `api/db/queries/registration.sql`）：`FreeSignupLockEvent`、`FreeSignupGetCategory`、`FreeSignupTakeSeat`（`:execrows`）、`InsertFreeSignup`。约束名映射：`free_signups_signup_no_key` 交给 `idgen.Retry` 重试；`free_signups_one_active` 在 `registration` 的 `init()` 注册为 409 `ALREADY_REGISTERED`，字段 `fullName` → `field.already_registered`。重试在 savepoint（`tx.Begin`）里做，避免唯一冲突让外层事务失效。
4. **写入顺序**：spec 6.7 先写「签署同意书」，但 `registration_consents.free_signup_id` 外键要求报名行先存在，所以事务内顺序为：锁赛事 → 校验组别与年龄 → 占名额 → 写 `free_signups` → `SignConsent`（`ConsentLink{FreeSignupID}`）→ 审计。任一步失败整笔回滚，业务结果与 spec 相同。
5. **OpenAPI 组件名**：`FreeSignupConsent`（`version`、`lang`、`checkedItems`）、`FreeSignupRequest`（请求体字段 `consents` 为单个 `FreeSignupConsent` 对象）、`FreeSignup`（响应）。独立命名，避免与 Task 12 下单请求里的同意书组件重名。
6. **同意书数据形状**：`appGetConsent` 响应字段为 `version`、`lang`、`effectiveDate`、`fullText`、`items[]{key,title,description}`；`werun publish-consent --items` 的 JSON 数组元素字段沿用第 2 段契约补充第 9 条的 `k`、`t`、`d`（与 `disclaimer_versions.items` 列一致，命令遇到未知字段会报错）；接口响应里再映射成 `key`、`title`、`description`。
7. **用户端**：`RequireRunner` 以 `children` 包裹页面（`<RequireRunner><X /></RequireRunner>`）；`renderApp(path, handler)` 签名不变，Task 10 已在其中接入跑者会话（读 `sessionStorage` 的 `werun.appToken` / `werun.appTokenExpiresAt` / `werun.devInitData`）。`FreeSignupPage` 的 `form-error` 额外带 `data-code` 属性（值为错误码），testid 不变。赛事详情与免费报名页的组别 `<select>` 选项 `value` 为组别 `id`；报名向导 `participant-<i>-category` 同样以组别 `id` 为 `value`。
8. **端到端依赖的界面行为**（Task 23 使用，均不新增 testid）：
   - 后台 antd `Select` 用键盘选择：打开后读输入框 `aria-activedescendant` 指向的 rc-select 无障碍节点（其文本就是选项 `value`），逐个 `ArrowDown` 直到值匹配再 `Enter`；多选框用 `Escape` 关闭（rc-select 打开时会 `stopPropagation`，不会关掉外层弹窗）。这样不依赖选项的中文文案。
   - 后台带时间的 `DatePicker`（`approve.receivedAt`）输入格式为 `YYYY-MM-DD HH:mm`，与新建赛事表单一致。
   - 凭证队列行 `proof-row-<proofNo>` 的文本包含订单号；赛事列表 `event-open-<slug>` 进入 `/events/<id>`。
   - 向导提交后：应付大于 0 跳到 `/orders/<orderNo>/pay`；应付为 0 跳到 `/orders/<orderNo>` 或 `/orders/<orderNo>/pay`（测试两者都接受，再直接打开订单详情）。
   - **金额一致性的判定**：算价预览不选识别分（spec 5 第 5 步、总览 `QuoteInput.PaymentAccountID = nil`），下单时识别分取 1–50 分，所以「付款页金额与算价一致」按 `1 ≤ quote-amount − pay-amount ≤ 50`（分）断言，而不是完全相等。
9. **新增端到端文件** `e2e/tests/runner-auth.spec.ts`：用真实接口 `POST /api/app/auth/telegram` 验证测试代码里的 `signInitData`（总览文件清单未列出，属于测试文件新增）。

---

### Task 22: 免费活动报名

**Files:**
- Create: `api/internal/runner/contact.go`
- Test: `api/internal/runner/contact_test.go`
- Modify: `api/db/queries/registration.sql`（文件末尾追加 4 个查询）
- Modify: `api/internal/registration/store/`（`make gen` 重新生成）
- Create: `api/internal/registration/free.go`
- Test: `api/internal/registration/free_test.go`
- Create: `api/internal/registration/free_handlers.go`
- Modify: `api/openapi/openapi.yaml`
- Modify: `api/internal/httpapi/apigen/api.gen.go`、`api/internal/httpapi/apigen/permissions.gen.go`（`make gen` 生成）
- Test: `api/internal/httpapi/free_signups_http_test.go`
- Modify: `packages/api-client/src/schema.d.ts`（`make gen` 生成）
- Create: `web/user/src/free/validate.ts`
- Test: `web/user/src/free/validate.test.ts`
- Create: `web/user/src/free/queries.ts`
- Create: `web/user/src/pages/FreeSignupPage.tsx`
- Create: `web/user/src/pages/FreeSignupPage.module.css`
- Test: `web/user/src/pages/FreeSignupPage.test.tsx`
- Create: `web/user/src/test/freeFixtures.ts`
- Modify: `web/user/src/routes.tsx`
- Modify: `web/user/src/pages/EventDetailPage.tsx`
- Modify: `web/user/src/pages/Page.module.css`（末尾追加 `.freeSignupAction`）
- Test: `web/user/src/pages/EventDetailPage.freeSignup.test.tsx`
- Modify: `packages/i18n/locales/zh/user.json`、`packages/i18n/locales/en/user.json`、`packages/i18n/locales/km/user.json`

**Interfaces:**
- Consumes：
  - `runner.ValidateProfile(p ProfileData, fieldPrefix string) error`、`runner.UserFrom(ctx)`、`(*runner.Service).SignConsent(ctx, tx, u, acc, meta, link)`、`runner.ConsentLink{FreeSignupID *int64}`、`runner.ConsentAcceptance`、`runner.SignInitData`、`(*runner.Service).LoginTelegram`、`(*runner.Service).PublishConsent`（Task 7–9）
  - `pricing.AgeOn(birth, raceDate time.Time) int`（Task 11）
  - `idgen.Code(idgen.PrefixFreeSignup)`、`idgen.Retry(constraint, fn)`（Task 1）
  - `registration.NewService(pool, runners, prices, notifier, now)`（Task 21 签名）、`notify.NewService`、`jobs.NewInserter`、`payment.NewService(pool, files, orders, notifier, now)`、`storage.NewDisk`、`piicrypt.New`
  - 错误码 `CodeRegistrationClosed`、`CodeCategorySoldOut`、`CodeAlreadyRegistered`、`CodeConsentInvalid`、`CodeEventNotFound`、`CodeValidation`、`CodeUnauthenticated`；字段文案 `field.required`、`field.too_young`（`{minAge}`）、`field.category_unavailable`、`field.already_registered`（Task 9、12 已写入三语）
  - `httpapi.RouterDeps{…, Runner, Pricing, Registration, Payment, Notify}`（Task 4–20）
  - 用户端：`usePublicEvent(slug)`（`PublicEvent.id/eventType/registrationOpen`、`PublicCategory.id/minAge/soldOut`，实现调整 #8）、`RequireRunner`、`useApi`、`ApiError`、`unwrap`、`useLang`
- Produces：
  - `registration.FreeSignupInput`、`registration.FreeSignup`、`(*Service).CreateFreeSignup(ctx, u runner.User, slug string, in FreeSignupInput, meta httpx.Meta) (FreeSignup, error)`
  - `runner.ContactFields`、`runner.ValidateContactFields(in ContactFields, fieldPrefix string) error`（契约补充 1）
  - operationId `appCreateFreeSignup`：`POST /api/app/events/{slug}/free-signups`，`x-auth: app`，201 返回 `FreeSignup`
  - 审计 `free_signup.create`（`ActorType = "USER"`，`IsFinancial = false`）
  - 路由 `/events/:slug/free-signup` → `FreeSignupPage`（包在 `RequireRunner` 内）
  - testid：`free-signup-button`（赛事详情）、`free-category`、`free-fullName`、`free-phone`、`free-emergencyName`、`free-emergencyPhone`、`free-gender`、`free-birthDate`、`consent-item-<key>`、`free-submit`、`free-signup-done`、`form-error`（带 `data-code`）
  - 文案命名空间 `user.free.*`

- [ ] **Step 1：写失败测试 `api/internal/runner/contact_test.go`**

```go
package runner_test

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/runner"
)

var contactFieldNames = map[string]bool{
	"fullName": true, "phone": true, "emergencyName": true,
	"emergencyPhone": true, "gender": true, "birthDate": true,
}

func completeProfile() runner.ProfileData {
	return runner.ProfileData{
		FullName:       "Dara Sok",
		Gender:         "M",
		BirthDate:      time.Date(1990, 5, 1, 0, 0, 0, 0, time.UTC),
		Nationality:    "KH",
		IDType:         "NATIONAL_ID",
		IDNo:           "010203040",
		Phone:          "+85512345678",
		Email:          "dara@example.com",
		EmergencyName:  "Sok Chan",
		EmergencyPhone: "+85598765432",
		TShirtSize:     "M",
	}
}

func validContact() runner.ContactFields {
	return runner.ContactFields{
		FullName:       "Dara Sok",
		Phone:          "+85512345678",
		EmergencyName:  "Sok Chan",
		EmergencyPhone: "+85598765432",
	}
}

func fieldsOf(t *testing.T, err error) map[string]apperr.FieldError {
	t.Helper()
	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	require.Equal(t, apperr.CodeValidation, ae.Code)
	return ae.Fields
}

// ValidateContactFields 依赖 ValidateProfile 使用这些字段键；这里直接验证。
func TestValidateProfileUsesContactFieldNames(t *testing.T) {
	require.NoError(t, runner.ValidateProfile(completeProfile(), "p."))

	cases := map[string]func(p *runner.ProfileData){
		"p.fullName":       func(p *runner.ProfileData) { p.FullName = "" },
		"p.phone":          func(p *runner.ProfileData) { p.Phone = "" },
		"p.emergencyName":  func(p *runner.ProfileData) { p.EmergencyName = "" },
		"p.emergencyPhone": func(p *runner.ProfileData) { p.EmergencyPhone = "" },
		"p.gender":         func(p *runner.ProfileData) { p.Gender = "Q" },
		"p.birthDate":      func(p *runner.ProfileData) { p.BirthDate = time.Time{} },
	}
	for field, mutate := range cases {
		p := completeProfile()
		mutate(&p)
		require.Contains(t, fieldsOf(t, runner.ValidateProfile(p, "p.")), field)
	}
}

func TestValidateContactFieldsAcceptsValidInputWithoutOptionalFields(t *testing.T) {
	require.NoError(t, runner.ValidateContactFields(validContact(), ""))

	gender := "F"
	birth := time.Date(2012, 2, 29, 0, 0, 0, 0, time.UTC)
	in := validContact()
	in.Gender = &gender
	in.BirthDate = &birth
	require.NoError(t, runner.ValidateContactFields(in, ""))
}

func TestValidateContactFieldsReportsOnlyContactFields(t *testing.T) {
	cases := map[string]func(c *runner.ContactFields){
		"fullName":       func(c *runner.ContactFields) { c.FullName = "" },
		"phone":          func(c *runner.ContactFields) { c.Phone = "" },
		"emergencyName":  func(c *runner.ContactFields) { c.EmergencyName = "" },
		"emergencyPhone": func(c *runner.ContactFields) { c.EmergencyPhone = "" },
		"gender": func(c *runner.ContactFields) {
			g := "Q"
			c.Gender = &g
		},
	}
	for field, mutate := range cases {
		in := validContact()
		mutate(&in)
		fields := fieldsOf(t, runner.ValidateContactFields(in, "x."))
		require.Contains(t, fields, "x."+field)
		for key := range fields {
			require.True(t, contactFieldNames[key[len("x."):]], "unexpected field %s", key)
		}
	}
}

func TestValidateContactFieldsMatchesProfileRulesForPhone(t *testing.T) {
	for _, phone := range []string{"12345", "+855", "abc", "+85512345678"} {
		p := completeProfile()
		p.Phone = phone
		profileErr := runner.ValidateProfile(p, "")

		in := validContact()
		in.Phone = phone
		contactErr := runner.ValidateContactFields(in, "")

		if profileErr == nil {
			require.NoError(t, contactErr, phone)
			continue
		}
		_, profileHasPhone := fieldsOf(t, profileErr)["phone"]
		if !profileHasPhone {
			require.NoError(t, contactErr, phone)
			continue
		}
		require.Contains(t, fieldsOf(t, contactErr), "phone", phone)
	}
}
```

- [ ] **Step 2：运行，确认失败**

Run: `cd api && go test ./internal/runner/ -run 'TestValidateProfileUsesContactFieldNames|TestValidateContactFields' -count=1`
Expected: 编译失败，输出含 `undefined: runner.ContactFields` 与 `undefined: runner.ValidateContactFields`。

- [ ] **Step 3：实现 `api/internal/runner/contact.go`**

```go
package runner

import (
	"time"

	"werun/api/internal/platform/apperr"
)

// ContactFields 是免费活动报名需要校验的资料子集。Gender、BirthDate 为 nil 表示未填写。
type ContactFields struct {
	FullName       string
	Phone          string
	EmergencyName  string
	EmergencyPhone string
	Gender         *string
	BirthDate      *time.Time
}

var contactFieldKeys = []string{"fullName", "phone", "emergencyName", "emergencyPhone", "gender", "birthDate"}

// ValidateContactFields 用 ValidateProfile 的同一套规则校验联系人字段：其余资料字段填占位值，
// 只保留 fullName、phone、emergencyName、emergencyPhone 以及已填写的 gender、birthDate 的错误。
// 占位字段即使不合法也不会出现在结果里。
func ValidateContactFields(in ContactFields, fieldPrefix string) error {
	p := ProfileData{
		FullName:       in.FullName,
		Gender:         "M",
		BirthDate:      time.Date(1990, 1, 1, 0, 0, 0, 0, time.UTC),
		Nationality:    "KH",
		IDType:         "PASSPORT",
		IDNo:           "N01234567",
		Phone:          in.Phone,
		Email:          "",
		EmergencyName:  in.EmergencyName,
		EmergencyPhone: in.EmergencyPhone,
		TShirtSize:     "M",
	}
	if in.Gender != nil {
		p.Gender = *in.Gender
	}
	if in.BirthDate != nil {
		p.BirthDate = *in.BirthDate
	}

	err := ValidateProfile(p, fieldPrefix)
	if err == nil {
		return nil
	}
	ae, ok := apperr.As(err)
	if !ok || ae.Code != apperr.CodeValidation {
		return err
	}
	out := apperr.New(ae.Status, apperr.CodeValidation)
	kept := 0
	for _, key := range contactFieldKeys {
		if fe, found := ae.Fields[fieldPrefix+key]; found {
			out = out.WithField(fieldPrefix+key, fe.Key, fe.Params)
			kept++
		}
	}
	if kept == 0 {
		return nil
	}
	return out
}
```

- [ ] **Step 4：运行，确认通过**

Run: `cd api && go test ./internal/runner/ -run 'TestValidateProfileUsesContactFieldNames|TestValidateContactFields' -count=1`
Expected: `ok  	werun/api/internal/runner`。若 `TestValidateProfileUsesContactFieldNames` 失败，说明 Task 8 的字段键与契约补充 1 不一致——停下修正 Task 8 的字段键使之与 OpenAPI 小驼峰一致，不要改本测试。

- [ ] **Step 5：写失败的数据库测试 `api/internal/registration/free_test.go`**

```go
package registration_test

import (
	"bytes"
	"context"
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"werun/api/internal/event"
	"werun/api/internal/iam"
	"werun/api/internal/jobs"
	"werun/api/internal/notify"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/piicrypt"
	"werun/api/internal/pricing"
	"werun/api/internal/registration"
	"werun/api/internal/runner"
)

const (
	freeBotToken       = "123456:free-signup-test"
	freeConsentVersion = "REG-FREE-TEST-v1"
)

var (
	freeNow        = time.Date(2026, 9, 14, 3, 0, 0, 0, time.UTC)
	freeRaceDate   = time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	freeSignupNoRe = regexp.MustCompile(`^FS[0-9A-HJKMNP-TV-Z]{8}$`)
	freeMeta       = httpx.Meta{RequestID: "req-free", IP: "127.0.0.1", UserAgent: "free-signup-test"}
)

type freeEnv struct {
	pool    *pgxpool.Pool
	svc     *registration.Service
	runners *runner.Service
	events  *event.Service
	ops     iam.Staff
}

func newFreeEnv(t *testing.T) freeEnv {
	t.Helper()
	ctx := context.Background()
	pool := dbtest.NewPool(t)
	clock := func() time.Time { return freeNow }

	pii, err := piicrypt.New(bytes.Repeat([]byte{7}, 32))
	require.NoError(t, err)
	catalog, err := i18n.LoadCatalog()
	require.NoError(t, err)
	inserter, err := jobs.NewInserter(pool)
	require.NoError(t, err)

	runners := runner.NewService(pool, []byte(strings.Repeat("s", 32)), freeBotToken, pii, clock)
	prices := pricing.NewService(pool, clock)
	notifier := notify.NewService(inserter, catalog, "http://werun.localhost")
	svc := registration.NewService(pool, runners, prices, notifier, clock)

	iamSvc := iam.NewService(pool, []byte(strings.Repeat("k", 32)), iam.NewLoginLimiter(time.Now), time.Now)
	ops, err := iamSvc.CreateStaff(ctx, "ops.free", "Ops Free", iam.RoleOps, "Correct-Horse-Battery-9")
	require.NoError(t, err)

	require.NoError(t, runners.PublishConsent(ctx, runner.PublishConsentInput{
		Purpose:       "REGISTRATION",
		Version:       freeConsentVersion,
		Lang:          "en",
		EffectiveDate: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		FullText:      "Free activity registration consent.",
		Items: []runner.ConsentItem{
			{Key: "rules", Title: "I will follow the rules", Description: "Cut-off times apply"},
			{Key: "health", Title: "I am fit to take part", Description: "Ask a doctor if unsure"},
			{Key: "terms", Title: "I accept the terms", Description: "Data is used only for the event"},
		},
	}))

	return freeEnv{pool: pool, svc: svc, runners: runners, events: event.NewService(pool), ops: ops}
}

func (e freeEnv) login(t *testing.T, telegramID int64) runner.User {
	t.Helper()
	initData := runner.SignInitData(freeBotToken, runner.TelegramUser{ID: telegramID, FirstName: "Dara", LanguageCode: "en"}, freeNow)
	sess, err := e.runners.LoginTelegram(context.Background(), initData, freeMeta)
	require.NoError(t, err)
	return sess.User
}

type freeEventOpts struct {
	slug      string
	eventType string
	capacity  int32
	minAge    int16
	open      bool
	opensAt   *time.Time
	closesAt  *time.Time
}

func (e freeEnv) createEvent(t *testing.T, o freeEventOpts) (eventID, categoryID int64) {
	t.Helper()
	ctx := context.Background()
	start := time.Date(2026, 11, 14, 23, 0, 0, 0, time.UTC)
	cutoff := start.Add(3 * time.Hour)
	ev, err := e.events.Create(ctx, e.ops, event.CreateInput{
		Slug:          o.slug,
		EventType:     o.eventType,
		OrganizerType: event.OrganizerOfficial,
		Name:          i18n.Text{i18n.ZH: "河畔亲子跑", i18n.EN: "Riverside Family Run", i18n.KM: "ការរត់គ្រួសារមាត់ទន្លេ"},
		City:          "Phnom Penh",
		RaceDate:      freeRaceDate,
		Categories: []event.CategoryInput{{
			Code:      "5K",
			Name:      i18n.Text{i18n.ZH: "亲子 5K", i18n.EN: "Family 5K", i18n.KM: "គ្រួសារ 5K"},
			DistanceM: 5000,
			Capacity:  o.capacity,
			StartAt:   &start,
			CutoffAt:  &cutoff,
		}},
	})
	require.NoError(t, err)
	_, err = e.events.Publish(ctx, e.ops, ev.ID)
	require.NoError(t, err)
	_, err = e.pool.Exec(ctx,
		`UPDATE events SET registration_open = $2, registration_opens_at = $3, registration_closes_at = $4 WHERE id = $1`,
		ev.ID, o.open, o.opensAt, o.closesAt)
	require.NoError(t, err)
	_, err = e.pool.Exec(ctx, `UPDATE event_categories SET min_age = $2 WHERE id = $1`, ev.Categories[0].ID, o.minAge)
	require.NoError(t, err)
	return ev.ID, ev.Categories[0].ID
}

func freeInput(categoryID int64, fullName, phone string) registration.FreeSignupInput {
	return registration.FreeSignupInput{
		CategoryID:     categoryID,
		FullName:       fullName,
		Phone:          phone,
		EmergencyName:  "Sok Chan",
		EmergencyPhone: "+85598765432",
		Consent: runner.ConsentAcceptance{
			Version:      freeConsentVersion,
			Lang:         "en",
			CheckedItems: []string{"terms", "rules", "health"},
		},
	}
}

func freeCount(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	require.NoError(t, pool.QueryRow(context.Background(), sql, args...).Scan(&n))
	return n
}

func requireFreeErr(t *testing.T, err error, code string, status int) *apperr.Error {
	t.Helper()
	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	require.Equal(t, code, ae.Code)
	require.Equal(t, status, ae.Status)
	return ae
}

func freeOpen(slug string, capacity int32) freeEventOpts {
	return freeEventOpts{slug: slug, eventType: "FREE_ACTIVITY", capacity: capacity, open: true}
}

func TestCreateFreeSignupSuccessWritesSignupSeatConsentAndAudit(t *testing.T) {
	env := newFreeEnv(t)
	ctx := context.Background()
	u := env.login(t, 7001)
	eventID, categoryID := env.createEvent(t, freeOpen("riverside-walk", 10))

	fs, err := env.svc.CreateFreeSignup(ctx, u, "riverside-walk", freeInput(categoryID, "  Dara Sok ", "+85512345678"), freeMeta)

	require.NoError(t, err)
	require.Regexp(t, freeSignupNoRe, fs.SignupNo)
	require.Equal(t, "riverside-walk", fs.EventSlug)
	require.Equal(t, categoryID, fs.CategoryID)
	require.Equal(t, "Dara Sok", fs.FullName)
	require.Equal(t, "REGISTERED", fs.Status)
	require.True(t, fs.CreatedAt.After(time.Time{}))

	var (
		userID    int64
		source    string
		phone     string
		gender    *string
		birthDate *time.Time
	)
	require.NoError(t, env.pool.QueryRow(ctx,
		`SELECT user_id, source, phone_e164, gender, birth_date FROM free_signups WHERE id = $1 AND event_id = $2`,
		fs.ID, eventID).Scan(&userID, &source, &phone, &gender, &birthDate))
	require.Equal(t, u.ID, userID)
	require.Equal(t, "TELEGRAM", source)
	require.Equal(t, "+85512345678", phone)
	require.Nil(t, gender)
	require.Nil(t, birthDate)

	require.Equal(t, 1, freeCount(t, env.pool, `SELECT used_count FROM event_categories WHERE id = $1`, categoryID))
	require.Equal(t, 0, freeCount(t, env.pool, `SELECT reserved_count FROM event_categories WHERE id = $1`, categoryID))
	require.Equal(t, 1, freeCount(t, env.pool, `SELECT count(*) FROM registration_consents WHERE free_signup_id = $1`, fs.ID))
	require.Equal(t, 1, freeCount(t, env.pool,
		`SELECT count(*) FROM audit_logs WHERE action = 'free_signup.create' AND entity_type = 'free_signup'
		   AND entity_id = $1 AND actor_type = 'USER' AND actor_id = $2 AND NOT is_financial`, fs.ID, u.ID))
}

func TestCreateFreeSignupDuplicateNameAndPhoneIsCaseInsensitive(t *testing.T) {
	env := newFreeEnv(t)
	ctx := context.Background()
	u := env.login(t, 7002)
	_, categoryID := env.createEvent(t, freeOpen("riverside-dup", 10))

	_, err := env.svc.CreateFreeSignup(ctx, u, "riverside-dup", freeInput(categoryID, "Dara Sok", "+85512345678"), freeMeta)
	require.NoError(t, err)
	_, err = env.svc.CreateFreeSignup(ctx, u, "riverside-dup", freeInput(categoryID, "DARA SOK", "+85512345678"), freeMeta)

	ae := requireFreeErr(t, err, apperr.CodeAlreadyRegistered, http.StatusConflict)
	require.Equal(t, "field.already_registered", ae.Fields["fullName"].Key)
	require.Equal(t, 1, freeCount(t, env.pool, `SELECT count(*) FROM free_signups WHERE category_id = $1`, categoryID))
	require.Equal(t, 1, freeCount(t, env.pool, `SELECT used_count FROM event_categories WHERE id = $1`, categoryID))
	require.Equal(t, 1, freeCount(t, env.pool, `SELECT count(*) FROM registration_consents WHERE free_signup_id IS NOT NULL`))
}

func TestCreateFreeSignupFamilyMembersShareOnePhone(t *testing.T) {
	env := newFreeEnv(t)
	ctx := context.Background()
	u := env.login(t, 7003)
	_, categoryID := env.createEvent(t, freeOpen("riverside-family", 10))

	first, err := env.svc.CreateFreeSignup(ctx, u, "riverside-family", freeInput(categoryID, "Dara Sok", "+85512345678"), freeMeta)
	require.NoError(t, err)
	second, err := env.svc.CreateFreeSignup(ctx, u, "riverside-family", freeInput(categoryID, "Sok Mealea", "+85512345678"), freeMeta)
	require.NoError(t, err)

	require.NotEqual(t, first.SignupNo, second.SignupNo)
	require.Equal(t, 2, freeCount(t, env.pool, `SELECT used_count FROM event_categories WHERE id = $1`, categoryID))
}

func TestCreateFreeSignupSoldOut(t *testing.T) {
	env := newFreeEnv(t)
	ctx := context.Background()
	u := env.login(t, 7004)
	_, categoryID := env.createEvent(t, freeOpen("riverside-full", 1))

	_, err := env.svc.CreateFreeSignup(ctx, u, "riverside-full", freeInput(categoryID, "Dara Sok", "+85512345678"), freeMeta)
	require.NoError(t, err)
	_, err = env.svc.CreateFreeSignup(ctx, u, "riverside-full", freeInput(categoryID, "Sok Mealea", "+85512345679"), freeMeta)

	requireFreeErr(t, err, apperr.CodeCategorySoldOut, http.StatusConflict)
	require.Equal(t, 1, freeCount(t, env.pool, `SELECT used_count FROM event_categories WHERE id = $1`, categoryID))
	require.Equal(t, 1, freeCount(t, env.pool, `SELECT count(*) FROM free_signups WHERE category_id = $1`, categoryID))
}

func TestCreateFreeSignupMinAge(t *testing.T) {
	env := newFreeEnv(t)
	ctx := context.Background()
	u := env.login(t, 7005)
	opts := freeOpen("riverside-age", 10)
	opts.minAge = 12
	_, categoryID := env.createEvent(t, opts)

	_, err := env.svc.CreateFreeSignup(ctx, u, "riverside-age", freeInput(categoryID, "Kid One", "+85512345601"), freeMeta)
	ae := requireFreeErr(t, err, apperr.CodeValidation, http.StatusUnprocessableEntity)
	require.Equal(t, "field.required", ae.Fields["birthDate"].Key)

	tooYoung := freeInput(categoryID, "Kid Two", "+85512345602")
	birth := time.Date(2014, 11, 16, 0, 0, 0, 0, time.UTC) // 比赛当天 11 岁
	tooYoung.BirthDate = &birth
	_, err = env.svc.CreateFreeSignup(ctx, u, "riverside-age", tooYoung, freeMeta)
	ae = requireFreeErr(t, err, apperr.CodeValidation, http.StatusUnprocessableEntity)
	require.Equal(t, "field.too_young", ae.Fields["birthDate"].Key)
	require.Equal(t, 12, ae.Fields["birthDate"].Params["minAge"])

	exactly := freeInput(categoryID, "Kid Three", "+85512345603")
	birthday := time.Date(2014, 11, 15, 0, 0, 0, 0, time.UTC) // 比赛当天刚满 12 岁
	exactly.BirthDate = &birthday
	_, err = env.svc.CreateFreeSignup(ctx, u, "riverside-age", exactly, freeMeta)
	require.NoError(t, err)
	require.Equal(t, 1, freeCount(t, env.pool, `SELECT used_count FROM event_categories WHERE id = $1`, categoryID))
}

func TestCreateFreeSignupClosed(t *testing.T) {
	env := newFreeEnv(t)
	ctx := context.Background()
	u := env.login(t, 7006)
	past := freeNow.Add(-time.Hour)
	future := freeNow.Add(time.Hour)

	notOpen := freeOpen("closed-flag", 10)
	notOpen.open = false
	race := freeOpen("closed-race", 10)
	race.eventType = "RACE"
	notYet := freeOpen("closed-not-yet", 10)
	notYet.opensAt = &future
	ended := freeOpen("closed-ended", 10)
	ended.closesAt = &past

	for _, o := range []freeEventOpts{notOpen, race, notYet, ended} {
		_, categoryID := env.createEvent(t, o)
		_, err := env.svc.CreateFreeSignup(ctx, u, o.slug, freeInput(categoryID, "Dara Sok", "+85512345678"), freeMeta)
		requireFreeErr(t, err, apperr.CodeRegistrationClosed, http.StatusConflict)
		require.Equal(t, 0, freeCount(t, env.pool, `SELECT used_count FROM event_categories WHERE id = $1`, categoryID), o.slug)
	}

	_, err := env.svc.CreateFreeSignup(ctx, u, "no-such-event", freeInput(1, "Dara Sok", "+85512345678"), freeMeta)
	requireFreeErr(t, err, apperr.CodeEventNotFound, http.StatusNotFound)
}

func TestCreateFreeSignupRejectsCategoryOfAnotherEvent(t *testing.T) {
	env := newFreeEnv(t)
	ctx := context.Background()
	u := env.login(t, 7007)
	env.createEvent(t, freeOpen("event-a", 10))
	_, otherCategoryID := env.createEvent(t, freeOpen("event-b", 10))

	_, err := env.svc.CreateFreeSignup(ctx, u, "event-a", freeInput(otherCategoryID, "Dara Sok", "+85512345678"), freeMeta)

	ae := requireFreeErr(t, err, apperr.CodeValidation, http.StatusUnprocessableEntity)
	require.Equal(t, "field.category_unavailable", ae.Fields["categoryId"].Key)
	require.Equal(t, 0, freeCount(t, env.pool, `SELECT coalesce(sum(used_count), 0) FROM event_categories`))
}

func TestCreateFreeSignupInvalidConsentWritesNothing(t *testing.T) {
	env := newFreeEnv(t)
	ctx := context.Background()
	u := env.login(t, 7008)
	_, categoryID := env.createEvent(t, freeOpen("consent-missing", 10))
	in := freeInput(categoryID, "Dara Sok", "+85512345678")
	in.Consent.CheckedItems = []string{"rules", "health"}

	_, err := env.svc.CreateFreeSignup(ctx, u, "consent-missing", in, freeMeta)

	requireFreeErr(t, err, apperr.CodeConsentInvalid, http.StatusUnprocessableEntity)
	require.Equal(t, 0, freeCount(t, env.pool, `SELECT count(*) FROM free_signups`))
	require.Equal(t, 0, freeCount(t, env.pool, `SELECT used_count FROM event_categories WHERE id = $1`, categoryID))
	require.Equal(t, 0, freeCount(t, env.pool, `SELECT count(*) FROM audit_logs WHERE action = 'free_signup.create'`))
}

func TestCreateFreeSignupValidatesFieldsBeforeTouchingDatabase(t *testing.T) {
	env := newFreeEnv(t)
	u := env.login(t, 7009)
	in := freeInput(0, "   ", "+85512345678")

	_, err := env.svc.CreateFreeSignup(context.Background(), u, "whatever", in, freeMeta)

	ae := requireFreeErr(t, err, apperr.CodeValidation, http.StatusUnprocessableEntity)
	require.Contains(t, ae.Fields, "fullName")
	require.Equal(t, "field.required", ae.Fields["categoryId"].Key)
}
```

- [ ] **Step 6：运行，确认失败**

Run（本机 colima 时先设置 `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true`）：
`cd api && go test ./internal/registration/ -run TestCreateFreeSignup -count=1`
Expected: 编译失败，输出含 `undefined: registration.FreeSignupInput` 与 `env.svc.CreateFreeSignup undefined`。

- [ ] **Step 7：在 `api/db/queries/registration.sql` 末尾追加查询并生成代码**

```sql
-- name: FreeSignupLockEvent :one
SELECT id, event_type, status, registration_open, registration_opens_at, registration_closes_at, race_date
FROM events
WHERE slug = @slug
FOR UPDATE;

-- name: FreeSignupGetCategory :one
SELECT id, min_age
FROM event_categories
WHERE id = @id AND event_id = @event_id;

-- name: FreeSignupTakeSeat :execrows
UPDATE event_categories
SET used_count = used_count + 1
WHERE id = @id AND used_count + reserved_count + 1 <= capacity;

-- name: InsertFreeSignup :one
INSERT INTO free_signups (
  signup_no, event_id, category_id, user_id, full_name, phone_e164,
  gender, birth_date, emergency_name, emergency_phone, source
) VALUES (
  @signup_no, @event_id, @category_id, @user_id::bigint, @full_name, @phone_e164,
  NULLIF(@gender::text, ''), NULLIF(@birth_date::text, '')::date,
  @emergency_name::text, @emergency_phone::text, 'TELEGRAM'
)
RETURNING id, signup_no, status, created_at;
```

说明：可空列一律用 `::text` / `::bigint` 强转参数，生成的 Go 参数类型固定为 `string` / `int64`（`gender`、`birth_date` 传空串表示 NULL），不受 sqlc 对可空 `date` 的类型推断影响。

Run: `make gen`
Expected: 退出码 0；`git status --porcelain` 显示 `api/db/queries/registration.sql` 与 `api/internal/registration/store/registration.sql.go` 有变更，生成的类型包括 `FreeSignupLockEventRow{ID int64; EventType, Status string; RegistrationOpen bool; RegistrationOpensAt, RegistrationClosesAt *time.Time; RaceDate time.Time}`、`FreeSignupGetCategoryParams{ID, EventID int64}`、`FreeSignupGetCategoryRow{ID int64; MinAge int16}`、`InsertFreeSignupParams{SignupNo string; EventID, CategoryID, UserID int64; FullName, PhoneE164, Gender, BirthDate, EmergencyName, EmergencyPhone string}`、`InsertFreeSignupRow{ID int64; SignupNo, Status string; CreatedAt time.Time}`。

- [ ] **Step 8：实现 `api/internal/registration/free.go`**

```go
package registration

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/audit"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/idgen"
	"werun/api/internal/pricing"
	"werun/api/internal/registration/store"
	"werun/api/internal/runner"
)

const (
	freeSignupNoConstraint     = "free_signups_signup_no_key"
	freeSignupActiveConstraint = "free_signups_one_active"
)

func init() {
	apperr.RegisterConstraint(freeSignupActiveConstraint, func() *apperr.Error {
		return apperr.New(http.StatusConflict, apperr.CodeAlreadyRegistered).
			WithField("fullName", "field.already_registered", nil)
	})
}

// FreeSignupInput 是免费活动报名的输入。Gender、BirthDate 为 nil 表示未填写。
type FreeSignupInput struct {
	CategoryID                                     int64
	FullName, Phone, EmergencyName, EmergencyPhone string
	Gender                                         *string
	BirthDate                                      *time.Time
	Consent                                        runner.ConsentAcceptance
}

// FreeSignup 是创建成功的免费报名。
type FreeSignup struct {
	ID         int64
	SignupNo   string
	EventSlug  string
	CategoryID int64
	FullName   string
	Status     string
	CreatedAt  time.Time
}

// CreateFreeSignup 按 spec 6.7 为免费活动报名：同一跑者可为家人报多人，
// 同一组别内同手机号 + 同姓名（不区分大小写）只能有一条有效报名。
func (s *Service) CreateFreeSignup(ctx context.Context, u runner.User, slug string, in FreeSignupInput, meta httpx.Meta) (FreeSignup, error) {
	in = freeSignupNormalize(in)
	if err := freeSignupValidate(in); err != nil {
		return FreeSignup{}, err
	}

	var out FreeSignup
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)

		ev, err := q.FreeSignupLockEvent(ctx, slug)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
		}
		if err != nil {
			return fmt.Errorf("lock event %q: %w", slug, err)
		}
		if !freeSignupOpen(ev, s.now()) {
			return apperr.New(http.StatusConflict, apperr.CodeRegistrationClosed)
		}

		cat, err := q.FreeSignupGetCategory(ctx, store.FreeSignupGetCategoryParams{ID: in.CategoryID, EventID: ev.ID})
		if errors.Is(err, pgx.ErrNoRows) {
			return freeSignupFieldError("categoryId", "field.category_unavailable", nil)
		}
		if err != nil {
			return fmt.Errorf("get category %d: %w", in.CategoryID, err)
		}
		if cat.MinAge > 0 {
			if in.BirthDate == nil {
				return freeSignupFieldError("birthDate", "field.required", nil)
			}
			if pricing.AgeOn(*in.BirthDate, ev.RaceDate) < int(cat.MinAge) {
				return freeSignupFieldError("birthDate", "field.too_young", map[string]any{"minAge": int(cat.MinAge)})
			}
		}

		taken, err := q.FreeSignupTakeSeat(ctx, cat.ID)
		if err != nil {
			return fmt.Errorf("take seat in category %d: %w", cat.ID, err)
		}
		if taken == 0 {
			return apperr.New(http.StatusConflict, apperr.CodeCategorySoldOut)
		}

		params := store.InsertFreeSignupParams{
			EventID:        ev.ID,
			CategoryID:     cat.ID,
			UserID:         u.ID,
			FullName:       in.FullName,
			PhoneE164:      in.Phone,
			EmergencyName:  in.EmergencyName,
			EmergencyPhone: in.EmergencyPhone,
		}
		if in.Gender != nil {
			params.Gender = *in.Gender
		}
		if in.BirthDate != nil {
			params.BirthDate = in.BirthDate.Format(time.DateOnly)
		}
		row, err := freeSignupInsert(ctx, tx, params)
		if err != nil {
			return err
		}

		signupID := row.ID
		if err := s.runners.SignConsent(ctx, tx, u, in.Consent, meta, runner.ConsentLink{FreeSignupID: &signupID}); err != nil {
			return err
		}

		out = FreeSignup{
			ID:         row.ID,
			SignupNo:   row.SignupNo,
			EventSlug:  slug,
			CategoryID: cat.ID,
			FullName:   in.FullName,
			Status:     row.Status,
			CreatedAt:  row.CreatedAt,
		}
		userID := u.ID
		eventID := ev.ID
		return audit.Record(ctx, tx, audit.Entry{
			ActorType:   "USER",
			ActorID:     &userID,
			Action:      "free_signup.create",
			EntityType:  "free_signup",
			EntityID:    row.ID,
			EventID:     &eventID,
			IsFinancial: false,
			Summary:     fmt.Sprintf("免费活动报名 %s（%s）", row.SignupNo, slug),
			After: map[string]any{
				"signupNo":   row.SignupNo,
				"categoryId": cat.ID,
				"status":     row.Status,
			},
			Meta: meta,
		})
	})
	if err != nil {
		return FreeSignup{}, err
	}
	return out, nil
}

func freeSignupNormalize(in FreeSignupInput) FreeSignupInput {
	in.FullName = strings.TrimSpace(in.FullName)
	in.Phone = strings.TrimSpace(in.Phone)
	in.EmergencyName = strings.TrimSpace(in.EmergencyName)
	in.EmergencyPhone = strings.TrimSpace(in.EmergencyPhone)
	if in.Gender != nil {
		g := strings.TrimSpace(*in.Gender)
		if g == "" {
			in.Gender = nil
		} else {
			in.Gender = &g
		}
	}
	return in
}

func freeSignupValidate(in FreeSignupInput) error {
	err := runner.ValidateContactFields(runner.ContactFields{
		FullName:       in.FullName,
		Phone:          in.Phone,
		EmergencyName:  in.EmergencyName,
		EmergencyPhone: in.EmergencyPhone,
		Gender:         in.Gender,
		BirthDate:      in.BirthDate,
	}, "")
	if in.CategoryID > 0 {
		return err
	}
	if err == nil {
		return freeSignupFieldError("categoryId", "field.required", nil)
	}
	if ae, ok := apperr.As(err); ok && ae.Code == apperr.CodeValidation {
		return ae.WithField("categoryId", "field.required", nil)
	}
	return err
}

func freeSignupFieldError(field, key string, params map[string]any) error {
	return apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation).WithField(field, key, params)
}

// freeSignupOpen 与 spec 6.1 第 1 步相同的开放条件，但要求 FREE_ACTIVITY。
func freeSignupOpen(ev store.FreeSignupLockEventRow, now time.Time) bool {
	if ev.Status != "PUBLISHED" || ev.EventType != "FREE_ACTIVITY" || !ev.RegistrationOpen {
		return false
	}
	if ev.RegistrationOpensAt != nil && now.Before(*ev.RegistrationOpensAt) {
		return false
	}
	if ev.RegistrationClosesAt != nil && !now.Before(*ev.RegistrationClosesAt) {
		return false
	}
	return true
}

// freeSignupInsert 在 savepoint 里写报名行：编号冲突时回滚 savepoint 并重新生成（idgen.Retry 最多 3 次），
// 外层事务不受影响；free_signups_one_active 冲突映射为 ALREADY_REGISTERED。
func freeSignupInsert(ctx context.Context, tx pgx.Tx, params store.InsertFreeSignupParams) (store.InsertFreeSignupRow, error) {
	var row store.InsertFreeSignupRow
	err := idgen.Retry(freeSignupNoConstraint, func() error {
		params.SignupNo = idgen.Code(idgen.PrefixFreeSignup)
		sp, err := tx.Begin(ctx)
		if err != nil {
			return fmt.Errorf("begin savepoint: %w", err)
		}
		inserted, err := store.New(sp).InsertFreeSignup(ctx, params)
		if err != nil {
			_ = sp.Rollback(ctx)
			return err
		}
		row = inserted
		return sp.Commit(ctx)
	})
	if err != nil {
		mapped := apperr.FromPG(err)
		if _, ok := apperr.As(mapped); ok {
			return store.InsertFreeSignupRow{}, mapped
		}
		return store.InsertFreeSignupRow{}, fmt.Errorf("insert free signup: %w", err)
	}
	return row, nil
}
```

- [ ] **Step 9：运行，确认通过**

Run（colima 环境变量同 Step 6）：`cd api && go test ./internal/registration/ -run TestCreateFreeSignup -count=1 -v`
Expected: 9 个 `--- PASS: TestCreateFreeSignup…`，最后 `ok  	werun/api/internal/registration`。

- [ ] **Step 10：写失败的 HTTP 测试 `api/internal/httpapi/free_signups_http_test.go`**

```go
package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"werun/api/internal/event"
	"werun/api/internal/httpapi"
	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/jobs"
	"werun/api/internal/notify"
	"werun/api/internal/payment"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/logx"
	"werun/api/internal/platform/piicrypt"
	"werun/api/internal/platform/storage"
	"werun/api/internal/pricing"
	"werun/api/internal/registration"
	"werun/api/internal/runner"
)

const (
	fshBotToken = "123456:free-signup-http"
	fshSlug     = "riverside-walk-http"
	fshVersion  = "REG-HTTP-v1"
)

type fshEnv struct {
	router     http.Handler
	catalog    *i18n.Catalog
	runners    *runner.Service
	categoryID int64
}

func newFreeSignupHTTPEnv(t *testing.T) fshEnv {
	t.Helper()
	gin.SetMode(gin.TestMode)
	ctx := context.Background()
	pool := dbtest.NewPool(t)
	now := time.Now

	catalog, err := i18n.LoadCatalog()
	require.NoError(t, err)
	pii, err := piicrypt.New(bytes.Repeat([]byte{9}, 32))
	require.NoError(t, err)
	inserter, err := jobs.NewInserter(pool)
	require.NoError(t, err)
	files, err := storage.NewDisk(t.TempDir())
	require.NoError(t, err)

	iamSvc := iam.NewService(pool, []byte(strings.Repeat("k", 32)), iam.NewLoginLimiter(time.Now), time.Now)
	events := event.NewService(pool)
	runners := runner.NewService(pool, []byte(strings.Repeat("k", 32)), fshBotToken, pii, now)
	prices := pricing.NewService(pool, now)
	notifier := notify.NewService(inserter, catalog, "http://werun.localhost")
	orders := registration.NewService(pool, runners, prices, notifier, now)
	payments := payment.NewService(pool, files, orders, notifier, now)

	router := httpapi.NewRouter(httpapi.RouterDeps{
		Log:          logx.New("error", io.Discard),
		Catalog:      catalog,
		Pool:         pool,
		IAM:          iamSvc,
		Events:       events,
		Runner:       runners,
		Pricing:      prices,
		Registration: orders,
		Payment:      payments,
		Notify:       notifier,
		Env:          "dev",
	})

	ops, err := iamSvc.CreateStaff(ctx, "ops.free.http", "Ops Free HTTP", iam.RoleOps, "Correct-Horse-Battery-9")
	require.NoError(t, err)
	start := time.Date(2026, 11, 14, 23, 0, 0, 0, time.UTC)
	cutoff := start.Add(2 * time.Hour)
	ev, err := events.Create(ctx, ops, event.CreateInput{
		Slug:          fshSlug,
		EventType:     event.TypeFreeActivity,
		OrganizerType: event.OrganizerOfficial,
		Name:          i18n.Text{i18n.ZH: "河畔健步走", i18n.EN: "Riverside Walk", i18n.KM: "ដើរលេងមាត់ទន្លេ"},
		City:          "Phnom Penh",
		RaceDate:      time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC),
		Categories: []event.CategoryInput{{
			Code:      "3K",
			Name:      i18n.Text{i18n.ZH: "健步走 3K", i18n.EN: "Walk 3K", i18n.KM: "ដើរ 3K"},
			DistanceM: 3000,
			Capacity:  50,
			StartAt:   &start,
			CutoffAt:  &cutoff,
		}},
	})
	require.NoError(t, err)
	_, err = events.Publish(ctx, ops, ev.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE events SET registration_open = true WHERE id = $1`, ev.ID)
	require.NoError(t, err)

	require.NoError(t, runners.PublishConsent(ctx, runner.PublishConsentInput{
		Purpose:       "REGISTRATION",
		Version:       fshVersion,
		Lang:          "en",
		EffectiveDate: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		FullText:      "Consent text.",
		Items: []runner.ConsentItem{
			{Key: "rules", Title: "Rules", Description: "Follow the rules"},
			{Key: "health", Title: "Health", Description: "Fit to take part"},
			{Key: "terms", Title: "Terms", Description: "Accept the terms"},
		},
	}))

	return fshEnv{router: router, catalog: catalog, runners: runners, categoryID: ev.Categories[0].ID}
}

func (e fshEnv) token(t *testing.T, telegramID int64) string {
	t.Helper()
	initData := runner.SignInitData(fshBotToken, runner.TelegramUser{ID: telegramID, FirstName: "Dara", LanguageCode: "en"}, time.Now())
	sess, err := e.runners.LoginTelegram(context.Background(), initData, httpx.Meta{IP: "127.0.0.1", UserAgent: "free-signup-http"})
	require.NoError(t, err)
	return sess.Token
}

func (e fshEnv) post(t *testing.T, body any, token, lang string) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	require.NoError(t, err)
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost,
		"/api/app/events/"+fshSlug+"/free-signups", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if lang != "" {
		req.Header.Set("Accept-Language", lang)
	}
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	return rec
}

func fshBody(categoryID int64, fullName string) map[string]any {
	return map[string]any{
		"categoryId":     categoryID,
		"fullName":       fullName,
		"phone":          "+85512345678",
		"emergencyName":  "Sok Chan",
		"emergencyPhone": "+85598765432",
		"consents": map[string]any{
			"version":      fshVersion,
			"lang":         "en",
			"checkedItems": []string{"rules", "health", "terms"},
		},
	}
}

func TestAppCreateFreeSignupCreatesThenRejectsDuplicate(t *testing.T) {
	env := newFreeSignupHTTPEnv(t)
	token := env.token(t, 8101)

	rec := env.post(t, fshBody(env.categoryID, "Dara Sok"), token, "en")
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	created := eventsDecode[apigen.FreeSignup](t, rec)
	require.Regexp(t, regexp.MustCompile(`^FS[0-9A-Z]{8}$`), created.SignupNo)
	require.Equal(t, fshSlug, created.EventSlug)
	require.Equal(t, env.categoryID, created.CategoryId)
	require.Equal(t, "Dara Sok", created.FullName)
	require.Equal(t, "REGISTERED", created.Status)

	rec = env.post(t, fshBody(env.categoryID, "dara sok"), token, "zh")
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	body := eventsDecode[httpx.ErrorBody](t, rec)
	require.Equal(t, apperr.CodeAlreadyRegistered, body.Error.Code)
	require.Equal(t, env.catalog.T(i18n.ZH, apperr.CodeAlreadyRegistered, nil), body.Error.Message)
	require.Contains(t, body.Error.Fields, "fullName")
}

func TestAppCreateFreeSignupRequiresRunnerToken(t *testing.T) {
	env := newFreeSignupHTTPEnv(t)

	rec := env.post(t, fshBody(env.categoryID, "Dara Sok"), "", "en")

	require.Equal(t, http.StatusUnauthorized, rec.Code, rec.Body.String())
	require.Equal(t, apperr.CodeUnauthenticated, eventsDecode[httpx.ErrorBody](t, rec).Error.Code)
}

func TestAppCreateFreeSignupReturnsFieldErrors(t *testing.T) {
	env := newFreeSignupHTTPEnv(t)
	token := env.token(t, 8102)

	rec := env.post(t, fshBody(env.categoryID, ""), token, "en")

	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	body := eventsDecode[httpx.ErrorBody](t, rec)
	require.Equal(t, apperr.CodeValidation, body.Error.Code)
	require.Contains(t, body.Error.Fields, "fullName")
}
```

- [ ] **Step 11：运行，确认失败**

Run（colima 环境变量同 Step 6）：`cd api && go test ./internal/httpapi/ -run TestAppCreateFreeSignup -count=1`
Expected: 编译失败，输出含 `undefined: apigen.FreeSignup`。

- [ ] **Step 12：修改 `api/openapi/openapi.yaml` 并生成代码**

Old：

```yaml
components:
  schemas:
    ErrorResponse:
```

New：

```yaml
  /app/events/{slug}/free-signups:
    post:
      operationId: appCreateFreeSignup
      tags: [app-free-signup]
      summary: 免费活动报名（同一跑者可为家人报多人）
      x-auth: app
      parameters:
        - name: slug
          in: path
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/FreeSignupRequest'
      responses:
        '201':
          description: 报名成功
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/FreeSignup'
        default:
          description: 错误（REGISTRATION_CLOSED、CATEGORY_SOLD_OUT、ALREADY_REGISTERED、CONSENT_INVALID、VALIDATION_FAILED、EVENT_NOT_FOUND）
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
components:
  schemas:
    FreeSignupConsent:
      type: object
      required: [version, lang, checkedItems]
      properties:
        version:
          type: string
          maxLength: 64
        lang:
          type: string
          enum: [zh, en, km]
        checkedItems:
          type: array
          maxItems: 20
          items:
            type: string
    FreeSignupRequest:
      type: object
      required: [categoryId, fullName, phone, emergencyName, emergencyPhone, consents]
      properties:
        categoryId:
          type: integer
          format: int64
        fullName:
          type: string
          maxLength: 100
        phone:
          type: string
          maxLength: 20
          description: E.164，例如 +85512345678
        emergencyName:
          type: string
          maxLength: 100
        emergencyPhone:
          type: string
          maxLength: 20
        gender:
          type: string
          enum: [M, F, X]
        birthDate:
          type: string
          format: date
          description: 组别 minAge > 0 时必填
        consents:
          $ref: '#/components/schemas/FreeSignupConsent'
    FreeSignup:
      type: object
      required: [id, signupNo, eventSlug, categoryId, fullName, status, createdAt]
      properties:
        id:
          type: integer
          format: int64
        signupNo:
          type: string
        eventSlug:
          type: string
        categoryId:
          type: integer
          format: int64
        fullName:
          type: string
        status:
          type: string
        createdAt:
          type: string
          format: date-time
    ErrorResponse:
```

Run: `make gen`
Expected: 退出码 0；`api/internal/httpapi/apigen/api.gen.go` 出现 `AppCreateFreeSignup(ctx context.Context, request AppCreateFreeSignupRequestObject) (AppCreateFreeSignupResponseObject, error)`、`type AppCreateFreeSignup201JSONResponse FreeSignup`、`FreeSignupRequestGender`、`FreeSignupConsentLang`；`permissions.gen.go` 出现 `"AppCreateFreeSignup": {Kind: AuthApp}`；`packages/api-client/src/schema.d.ts` 出现 `"/app/events/{slug}/free-signups"`。此时 `go build ./...` 报 `*Server does not implement apigen.StrictServerInterface (missing method AppCreateFreeSignup)`。

- [ ] **Step 13：实现 `api/internal/registration/free_handlers.go`**

```go
package registration

import (
	"context"
	"net/http"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/runner"
)

func (h *Handlers) AppCreateFreeSignup(ctx context.Context, req apigen.AppCreateFreeSignupRequestObject) (apigen.AppCreateFreeSignupResponseObject, error) {
	u, ok := runner.UserFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	b := *req.Body
	in := FreeSignupInput{
		CategoryID:     b.CategoryId,
		FullName:       b.FullName,
		Phone:          b.Phone,
		EmergencyName:  b.EmergencyName,
		EmergencyPhone: b.EmergencyPhone,
		Consent: runner.ConsentAcceptance{
			Version:      b.Consents.Version,
			Lang:         string(b.Consents.Lang),
			CheckedItems: b.Consents.CheckedItems,
		},
	}
	if b.Gender != nil {
		g := string(*b.Gender)
		in.Gender = &g
	}
	if b.BirthDate != nil {
		d := b.BirthDate.Time
		in.BirthDate = &d
	}

	fs, err := h.svc.CreateFreeSignup(ctx, u, req.Slug, in, httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AppCreateFreeSignup201JSONResponse{
		Id:         fs.ID,
		SignupNo:   fs.SignupNo,
		EventSlug:  fs.EventSlug,
		CategoryId: fs.CategoryID,
		FullName:   fs.FullName,
		Status:     fs.Status,
		CreatedAt:  fs.CreatedAt,
	}, nil
}
```

`httpapi.Server` 已在 Task 12 嵌入 `*RegistrationHandlers`，新方法自动满足接口，`server.go` 不用改。

- [ ] **Step 14：运行后端测试，确认通过**

Run（colima 环境变量同 Step 6）：
`cd api && go test ./internal/httpapi/ -run 'TestAppCreateFreeSignup|TestOperationAuths|TestServerImplementsStrictInterface' -count=1 -v`
Expected: `TestAppCreateFreeSignupCreatesThenRejectsDuplicate`、`TestAppCreateFreeSignupRequiresRunnerToken`、`TestAppCreateFreeSignupReturnsFieldErrors`、`TestOperationAuthsCoversEveryStrictServerInterfaceMethod`、`TestOperationAuthsUseKnownPermissions`、`TestServerImplementsStrictInterface` 全部 `PASS`。

- [ ] **Step 15：写失败测试 `web/user/src/free/validate.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { ageOn, emptyFreeSignupValues, normalizePhone, toFreeSignupRequest, validateFreeSignup, type FreeSignupValues } from "./validate";

const filled: FreeSignupValues = {
  ...emptyFreeSignupValues,
  categoryId: "501",
  fullName: " Dara Sok ",
  phone: "+855 12-345 678",
  emergencyName: "Sok Chan",
  emergencyPhone: "+85598765432",
};

const consents = { version: "REG-TEST-v1", lang: "en" as const, checkedItems: ["rules", "health", "terms"] };

describe("ageOn", () => {
  it("比赛当天生日算满岁，前一天不算", () => {
    expect(ageOn("2014-11-15", "2026-11-15")).toBe(12);
    expect(ageOn("2014-11-16", "2026-11-15")).toBe(11);
  });

  it("2 月 29 日出生者在非闰年按 3 月 1 日满岁", () => {
    expect(ageOn("2012-02-29", "2026-02-28")).toBe(13);
    expect(ageOn("2012-02-29", "2026-03-01")).toBe(14);
    expect(ageOn("2012-02-29", "2028-02-29")).toBe(16);
  });
});

describe("normalizePhone", () => {
  it("去掉空格和连字符", () => {
    expect(normalizePhone(" +855 12-345 678 ")).toBe("+85512345678");
  });
});

describe("validateFreeSignup", () => {
  it("空表单报出全部必填项", () => {
    expect(validateFreeSignup(emptyFreeSignupValues, null, "2026-11-15")).toEqual({
      categoryId: { key: "required" },
      fullName: { key: "required" },
      phone: { key: "required" },
      emergencyName: { key: "required" },
      emergencyPhone: { key: "required" },
    });
  });

  it("手机号必须带国家区号", () => {
    const issues = validateFreeSignup({ ...filled, phone: "012345678", emergencyPhone: "abc" }, { minAge: 0 }, "2026-11-15");
    expect(issues).toEqual({ phone: { key: "phoneInvalid" }, emergencyPhone: { key: "phoneInvalid" } });
  });

  it("组别有最低年龄时出生日期必填并校验年龄", () => {
    expect(validateFreeSignup(filled, { minAge: 12 }, "2026-11-15")).toEqual({ birthDate: { key: "required" } });
    expect(validateFreeSignup({ ...filled, birthDate: "2014-11-16" }, { minAge: 12 }, "2026-11-15")).toEqual({
      birthDate: { key: "tooYoung", minAge: 12 },
    });
    expect(validateFreeSignup({ ...filled, birthDate: "2014-11-15" }, { minAge: 12 }, "2026-11-15")).toEqual({});
  });

  it("没有最低年龄时出生日期可空", () => {
    expect(validateFreeSignup(filled, { minAge: 0 }, "2026-11-15")).toEqual({});
  });
});

describe("toFreeSignupRequest", () => {
  it("去空白、规范手机号，未填的性别与出生日期不出现在请求体", () => {
    expect(toFreeSignupRequest(filled, consents)).toEqual({
      categoryId: 501,
      fullName: "Dara Sok",
      phone: "+85512345678",
      emergencyName: "Sok Chan",
      emergencyPhone: "+85598765432",
      consents,
    });
  });

  it("填写了性别与出生日期时带上", () => {
    const body = toFreeSignupRequest({ ...filled, gender: "F", birthDate: "2014-11-15" }, consents);
    expect(body.gender).toBe("F");
    expect(body.birthDate).toBe("2014-11-15");
  });
});
```

- [ ] **Step 16：运行，确认失败**

Run: `pnpm --filter @werun/user test src/free/validate.test.ts`
Expected: FAIL，输出含 `Failed to resolve import "./validate"`。

- [ ] **Step 17：实现 `web/user/src/free/validate.ts`**

```ts
import type { Schemas } from "@werun/api-client";

export type FreeSignupField = "categoryId" | "fullName" | "phone" | "emergencyName" | "emergencyPhone" | "gender" | "birthDate";

export const FREE_SIGNUP_FIELDS: readonly FreeSignupField[] = [
  "categoryId",
  "fullName",
  "phone",
  "emergencyName",
  "emergencyPhone",
  "gender",
  "birthDate",
];

export interface FreeSignupValues {
  categoryId: string;
  fullName: string;
  phone: string;
  emergencyName: string;
  emergencyPhone: string;
  /** "" | "M" | "F" | "X" */
  gender: string;
  /** "" 或 YYYY-MM-DD */
  birthDate: string;
}

export const emptyFreeSignupValues: FreeSignupValues = {
  categoryId: "",
  fullName: "",
  phone: "",
  emergencyName: "",
  emergencyPhone: "",
  gender: "",
  birthDate: "",
};

export type FieldIssue = { key: "required" } | { key: "phoneInvalid" } | { key: "tooYoung"; minAge: number };
export type FreeSignupIssues = Partial<Record<FreeSignupField, FieldIssue>>;

const E164 = /^\+[1-9]\d{7,14}$/;
const GENDERS = ["M", "F", "X"] as const;
type Gender = (typeof GENDERS)[number];

export function normalizePhone(input: string): string {
  return input.replace(/[\s-]/g, "");
}

function dateParts(iso: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) {
    throw new Error(`不是 YYYY-MM-DD 日期：${iso}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** 与后端 pricing.AgeOn 相同：比赛当天周岁；2 月 29 日出生者在非闰年按 3 月 1 日满岁 */
export function ageOn(birthDate: string, raceDate: string): number {
  const [birthYear, birthMonthRaw, birthDayRaw] = dateParts(birthDate);
  const [raceYear, raceMonth, raceDay] = dateParts(raceDate);
  let birthMonth = birthMonthRaw;
  let birthDay = birthDayRaw;
  if (birthMonth === 2 && birthDay === 29 && !isLeapYear(raceYear)) {
    birthMonth = 3;
    birthDay = 1;
  }
  let age = raceYear - birthYear;
  if (raceMonth < birthMonth || (raceMonth === birthMonth && raceDay < birthDay)) {
    age -= 1;
  }
  return age;
}

export function validateFreeSignup(values: FreeSignupValues, category: { minAge: number } | null, raceDate: string): FreeSignupIssues {
  const issues: FreeSignupIssues = {};
  if (values.categoryId === "" || category === null) {
    issues.categoryId = { key: "required" };
  }
  if (values.fullName.trim() === "") {
    issues.fullName = { key: "required" };
  }
  for (const field of ["phone", "emergencyPhone"] as const) {
    const phone = normalizePhone(values[field]);
    if (phone === "") {
      issues[field] = { key: "required" };
    } else if (!E164.test(phone)) {
      issues[field] = { key: "phoneInvalid" };
    }
  }
  if (values.emergencyName.trim() === "") {
    issues.emergencyName = { key: "required" };
  }
  if (category !== null && category.minAge > 0) {
    if (values.birthDate === "") {
      issues.birthDate = { key: "required" };
    } else if (ageOn(values.birthDate, raceDate) < category.minAge) {
      issues.birthDate = { key: "tooYoung", minAge: category.minAge };
    }
  }
  return issues;
}

function isGender(value: string): value is Gender {
  return (GENDERS as readonly string[]).includes(value);
}

export function toFreeSignupRequest(
  values: FreeSignupValues,
  consents: Schemas["FreeSignupConsent"],
): Schemas["FreeSignupRequest"] {
  const body: Schemas["FreeSignupRequest"] = {
    categoryId: Number(values.categoryId),
    fullName: values.fullName.trim(),
    phone: normalizePhone(values.phone),
    emergencyName: values.emergencyName.trim(),
    emergencyPhone: normalizePhone(values.emergencyPhone),
    consents,
  };
  if (isGender(values.gender)) {
    body.gender = values.gender;
  }
  if (values.birthDate !== "") {
    body.birthDate = values.birthDate;
  }
  return body;
}
```

- [ ] **Step 18：运行，确认通过**

Run: `pnpm --filter @werun/user test src/free/validate.test.ts`
Expected: `Test Files  1 passed`，`Tests  9 passed`。

- [ ] **Step 19：写测试夹具 `web/user/src/test/freeFixtures.ts`**

```ts
import type { Schemas } from "@werun/api-client";
import { halfMarathon } from "./fixtures";

const baseCategory = halfMarathon.categories[0]!;

/** 免费活动：501 无年龄限制，502 最低 12 岁，503 已满 */
export const freeActivity: Schemas["PublicEvent"] = {
  ...halfMarathon,
  slug: "riverside-fun-walk",
  name: "Riverside Fun Walk",
  eventType: "FREE_ACTIVITY",
  registrationOpen: true,
  categories: [
    { ...baseCategory, id: 501, code: "5K", name: "Family 5K", distanceM: 5000, capacity: 300, minAge: 0, soldOut: false },
    { ...baseCategory, id: 502, code: "10K", name: "Trail 10K", distanceM: 10000, capacity: 100, minAge: 12, soldOut: false },
    { ...baseCategory, id: 503, code: "3K", name: "Sunrise 3K", distanceM: 3000, capacity: 50, minAge: 0, soldOut: true },
  ],
};

export const registrationConsent = {
  version: "REG-TEST-v1",
  lang: "en",
  effectiveDate: "2026-01-01",
  fullText: "Registration consent full text.",
  items: [
    { key: "rules", title: "I will follow the event rules", description: "Cut-off times apply" },
    { key: "health", title: "I am fit to take part", description: "Ask a doctor if unsure" },
    { key: "terms", title: "I accept the terms", description: "Data is used only for this event" },
  ],
};

export const runnerSession = {
  token: "test-runner-token",
  expiresAt: "2099-01-01T00:00:00Z",
  user: { id: 7, telegramUserId: 7001, telegramUsername: "dara", displayName: "Dara Sok", locale: "en" },
};

/** 让 RequireRunner 视为已登录：令牌与开发登录参数都写入 sessionStorage（契约补充 7） */
export function presetRunnerSession(): void {
  window.sessionStorage.setItem("werun.appToken", runnerSession.token);
  window.sessionStorage.setItem("werun.appTokenExpiresAt", runnerSession.expiresAt);
  window.sessionStorage.setItem("werun.devInitData", "user=%7B%22id%22%3A7001%7D&auth_date=1&hash=test");
}
```

- [ ] **Step 20：写失败的组件测试 `web/user/src/pages/FreeSignupPage.test.tsx`**

```tsx
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jsonResponse } from "../test/fixtures";
import { freeActivity, presetRunnerSession, registrationConsent, runnerSession } from "../test/freeFixtures";
import { renderApp } from "../test/renderApp";

const PATH = `/events/${freeActivity.slug}/free-signup`;

type PostHandler = (body: unknown) => Response;

function handler(event: unknown, onPost: PostHandler) {
  return async (request: Request) => {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/api/app/auth/telegram":
        return jsonResponse(200, runnerSession);
      case "/api/app/me":
        return jsonResponse(200, runnerSession.user);
      case `/api/events/${freeActivity.slug}`:
        return jsonResponse(200, event);
      case "/api/app/consents":
        return jsonResponse(200, registrationConsent);
      case `/api/app/events/${freeActivity.slug}/free-signups`:
        return onPost(await request.clone().json());
      default:
        return jsonResponse(404, { error: { code: "NOT_FOUND", message: "Not found" } });
    }
  };
}

const created = {
  id: 88,
  signupNo: "FS7K3M9Q2A",
  eventSlug: freeActivity.slug,
  categoryId: 501,
  fullName: "Dara Sok",
  status: "REGISTERED",
  createdAt: "2026-09-14T03:00:00Z",
};

async function fillRequired(user: ReturnType<typeof userEvent.setup>, categoryId: string) {
  await user.selectOptions(await screen.findByTestId("free-category"), categoryId);
  await user.type(screen.getByTestId("free-fullName"), "Dara Sok");
  await user.type(screen.getByTestId("free-phone"), "+855 12 345 678");
  await user.type(screen.getByTestId("free-emergencyName"), "Sok Chan");
  await user.type(screen.getByTestId("free-emergencyPhone"), "+85598765432");
}

async function checkAllConsents(user: ReturnType<typeof userEvent.setup>) {
  for (const item of registrationConsent.items) {
    await user.click(await screen.findByTestId(`consent-item-${item.key}`));
  }
}

describe("FreeSignupPage", () => {
  beforeEach(() => {
    window.localStorage.setItem("werun.lang", "en");
    presetRunnerSession();
  });

  afterEach(() => {
    window.sessionStorage.clear();
  });

  it("勾选全部同意书前不能提交；提交成功后显示报名编号，请求体正确", async () => {
    const user = userEvent.setup();
    let sent: unknown = null;
    renderApp(PATH, handler(freeActivity, (body) => {
      sent = body;
      return jsonResponse(201, created);
    }));

    await fillRequired(user, "501");
    expect(screen.getByTestId("free-submit")).toBeDisabled();
    await checkAllConsents(user);
    expect(screen.getByTestId("free-submit")).toBeEnabled();
    await user.click(screen.getByTestId("free-submit"));

    const done = await screen.findByTestId("free-signup-done");
    expect(done).toHaveTextContent("FS7K3M9Q2A");
    expect(sent).toEqual({
      categoryId: 501,
      fullName: "Dara Sok",
      phone: "+85512345678",
      emergencyName: "Sok Chan",
      emergencyPhone: "+85598765432",
      consents: { version: "REG-TEST-v1", lang: "en", checkedItems: ["rules", "health", "terms"] },
    });
  });

  it("必填项为空时提示且不发请求", async () => {
    const user = userEvent.setup();
    let posted = false;
    renderApp(PATH, handler(freeActivity, () => {
      posted = true;
      return jsonResponse(201, created);
    }));

    await checkAllConsents(user);
    await user.click(screen.getByTestId("free-submit"));

    expect(await screen.findAllByText("Required")).toHaveLength(5);
    expect(posted).toBe(false);
  });

  it("已满的组别不可选", async () => {
    renderApp(PATH, handler(freeActivity, () => jsonResponse(201, created)));
    const select = await screen.findByTestId("free-category");
    expect(within(select).getByRole("option", { name: /Sunrise 3K/ })).toBeDisabled();
  });

  it("组别有最低年龄时出生日期必填，年龄不足时提示", async () => {
    const user = userEvent.setup();
    renderApp(PATH, handler(freeActivity, () => jsonResponse(201, created)));

    await fillRequired(user, "502");
    await checkAllConsents(user);
    await user.click(screen.getByTestId("free-submit"));
    expect(await screen.findByText("Required")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("free-birthDate"), { target: { value: "2015-01-01" } });
    await user.click(screen.getByTestId("free-submit"));
    expect(await screen.findByText("Must be at least 12 years old on race day")).toBeInTheDocument();
  });

  it("重复报名显示已报名提示", async () => {
    const user = userEvent.setup();
    renderApp(PATH, handler(freeActivity, () =>
      jsonResponse(409, {
        error: { code: "ALREADY_REGISTERED", message: "Already registered", fields: { fullName: "Already signed up" } },
      }),
    ));

    await fillRequired(user, "501");
    await checkAllConsents(user);
    await user.click(screen.getByTestId("free-submit"));

    const formError = await screen.findByTestId("form-error");
    expect(formError).toHaveAttribute("data-code", "ALREADY_REGISTERED");
    expect(formError).toHaveTextContent("This name and phone number are already signed up for this category");
    expect(screen.getByText("Already signed up")).toBeInTheDocument();
    expect(screen.queryByTestId("free-signup-done")).not.toBeInTheDocument();
  });

  it("活动未开放报名时不显示表单", async () => {
    renderApp(PATH, handler({ ...freeActivity, registrationOpen: false }, () => jsonResponse(201, created)));
    expect(await screen.findByText("Registration for this activity is not open")).toBeInTheDocument();
    expect(screen.queryByTestId("free-submit")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 21：写失败的赛事详情入口测试 `web/user/src/pages/EventDetailPage.freeSignup.test.tsx`**

```tsx
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { jsonResponse } from "../test/fixtures";
import { freeActivity } from "../test/freeFixtures";
import { renderApp } from "../test/renderApp";

describe("EventDetailPage 免费报名入口", () => {
  it("免费活动开放报名时显示免费报名按钮并链接到报名页", async () => {
    window.localStorage.setItem("werun.lang", "en");
    renderApp(`/events/${freeActivity.slug}`, async () => jsonResponse(200, freeActivity));

    const button = await screen.findByTestId("free-signup-button");
    expect(button).toHaveAttribute("href", `/events/${freeActivity.slug}/free-signup`);
    expect(button).toHaveTextContent("Sign up for free");
    expect(screen.queryByTestId("register-button")).not.toBeInTheDocument();
  });

  it("未开放报名时不显示免费报名按钮", async () => {
    window.localStorage.setItem("werun.lang", "en");
    renderApp(`/events/${freeActivity.slug}`, async () => jsonResponse(200, { ...freeActivity, registrationOpen: false }));

    expect(await screen.findByRole("heading", { name: "Riverside Fun Walk" })).toBeInTheDocument();
    expect(screen.queryByTestId("free-signup-button")).not.toBeInTheDocument();
  });

  it("付费赛事不显示免费报名按钮", async () => {
    window.localStorage.setItem("werun.lang", "en");
    renderApp(`/events/${freeActivity.slug}`, async () => jsonResponse(200, { ...freeActivity, eventType: "RACE" }));

    expect(await screen.findByRole("heading", { name: "Riverside Fun Walk" })).toBeInTheDocument();
    expect(screen.queryByTestId("free-signup-button")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 22：运行，确认失败**

Run: `pnpm --filter @werun/user test src/pages/FreeSignupPage.test.tsx src/pages/EventDetailPage.freeSignup.test.tsx`
Expected: FAIL。`FreeSignupPage.test.tsx` 找不到 `free-category`（路由不存在，渲染 404 页）；`EventDetailPage.freeSignup.test.tsx` 第 1 条报 `Unable to find an element by: [data-testid="free-signup-button"]`。

- [ ] **Step 23：实现数据请求 `web/user/src/free/queries.ts`**

```ts
import { useMutation, useQuery } from "@tanstack/react-query";
import { unwrap, type ApiClient, type Schemas } from "@werun/api-client";
import { useLang, type Lang } from "@werun/i18n";
import { useApi } from "../api";

async function fetchRegistrationConsent(api: ApiClient, lang: Lang) {
  return unwrap(await api.GET("/app/consents", { params: { query: { purpose: "REGISTRATION", lang } } }));
}

export type RegistrationConsent = Awaited<ReturnType<typeof fetchRegistrationConsent>>;

export function useRegistrationConsent() {
  const api = useApi();
  const lang = useLang();
  return useQuery({
    queryKey: ["consent", "REGISTRATION", lang],
    queryFn: () => fetchRegistrationConsent(api, lang),
  });
}

export function useCreateFreeSignup(slug: string) {
  const api = useApi();
  return useMutation({
    mutationFn: async (body: Schemas["FreeSignupRequest"]) =>
      unwrap(await api.POST("/app/events/{slug}/free-signups", { params: { path: { slug } }, body })),
  });
}
```

- [ ] **Step 24：实现页面 `web/user/src/pages/FreeSignupPage.tsx`**

```tsx
import { ApiError, type Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import { QueryState } from "../components/QueryState";
import { useCreateFreeSignup, useRegistrationConsent, type RegistrationConsent } from "../free/queries";
import {
  FREE_SIGNUP_FIELDS,
  emptyFreeSignupValues,
  toFreeSignupRequest,
  validateFreeSignup,
  type FieldIssue,
  type FreeSignupField,
  type FreeSignupValues,
} from "../free/validate";
import { usePublicEvent } from "../queries";
import styles from "./FreeSignupPage.module.css";
import { NotFoundPage } from "./NotFoundPage";
import pageStyles from "./Page.module.css";

type PublicEvent = Schemas["PublicEvent"];
type FieldMessages = Partial<Record<FreeSignupField, string>>;

export function FreeSignupPage() {
  const { slug = "" } = useParams();
  const { t } = useTranslation("user");
  const event = usePublicEvent(slug);

  if (event.error instanceof ApiError && event.error.status === 404) {
    return <NotFoundPage />;
  }

  return (
    <QueryState query={event}>
      {(data) => (
        <article>
          <h1 className={pageStyles.title}>{t("free.title")}</h1>
          <p className={pageStyles.meta}>{data.name}</p>
          {data.eventType === "FREE_ACTIVITY" && data.registrationOpen ? (
            <ConsentLoader event={data} />
          ) : (
            <p className={pageStyles.muted}>{t("free.closed")}</p>
          )}
        </article>
      )}
    </QueryState>
  );
}

function ConsentLoader({ event }: { event: PublicEvent }) {
  const consent = useRegistrationConsent();
  return <QueryState query={consent}>{(data) => <FreeSignupForm event={event} consent={data} />}</QueryState>;
}

function Field({ id, label, message, hint, children }: { id: string; label: string; message?: string; hint?: string; children: ReactNode }) {
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      {children}
      {hint ? <p className={styles.hint}>{hint}</p> : null}
      {message ? (
        <p className={styles.fieldError} role="alert">
          {message}
        </p>
      ) : null}
    </div>
  );
}

function FreeSignupForm({ event, consent }: { event: PublicEvent; consent: RegistrationConsent }) {
  const { t } = useTranslation("user");
  const lang = useLang();
  const create = useCreateFreeSignup(event.slug);
  const [values, setValues] = useState<FreeSignupValues>(emptyFreeSignupValues);
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const [messages, setMessages] = useState<FieldMessages>({});

  const category = event.categories.find((c) => String(c.id) === values.categoryId);
  const allChecked = consent.items.every((item) => checked.has(item.key));

  if (create.data) {
    return (
      <section className={styles.done} data-testid="free-signup-done">
        <h2 className={styles.doneTitle}>{t("free.doneTitle")}</h2>
        <p>{t("free.doneBody", { signupNo: create.data.signupNo })}</p>
        <Link to={`/events/${event.slug}`}>{t("free.doneBack")}</Link>
      </section>
    );
  }

  const issueText = (issue: FieldIssue): string =>
    issue.key === "tooYoung" ? t("free.tooYoung", { minAge: issue.minAge }) : t(`free.${issue.key}`);

  const update = (field: keyof FreeSignupValues) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const value = e.target.value;
    setValues((prev) => ({ ...prev, [field]: value }));
  };

  const toggle = (key: string) => (e: ChangeEvent<HTMLInputElement>) => {
    const on = e.target.checked;
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const issues = validateFreeSignup(values, category ? { minAge: category.minAge } : null, event.raceDate);
    const next: FieldMessages = {};
    for (const field of FREE_SIGNUP_FIELDS) {
      const issue = issues[field];
      if (issue) {
        next[field] = issueText(issue);
      }
    }
    setMessages(next);
    if (Object.keys(next).length > 0 || !allChecked) {
      return;
    }
    const body = toFreeSignupRequest(values, {
      version: consent.version,
      lang,
      checkedItems: consent.items.map((item) => item.key),
    });
    create.mutate(body, {
      onError: (error) => {
        if (error instanceof ApiError) {
          const server: FieldMessages = {};
          for (const field of FREE_SIGNUP_FIELDS) {
            const text = error.fields[field];
            if (text) {
              server[field] = text;
            }
          }
          setMessages(server);
        }
      },
    });
  };

  const errorCode = create.error instanceof ApiError ? create.error.code : undefined;

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <Field
        id="free-category"
        label={t("free.category")}
        message={messages.categoryId}
        hint={category && category.minAge > 0 ? t("free.minAgeHint", { minAge: category.minAge }) : undefined}
      >
        <select
          id="free-category"
          data-testid="free-category"
          className={styles.input}
          value={values.categoryId}
          onChange={update("categoryId")}
          aria-invalid={messages.categoryId ? true : undefined}
        >
          <option value="">{t("free.chooseCategory")}</option>
          {event.categories.map((c) => (
            <option key={c.id} value={String(c.id)} disabled={c.soldOut}>
              {c.soldOut ? `${c.name} · ${t("free.soldOut")}` : c.name}
            </option>
          ))}
        </select>
      </Field>

      <Field id="free-fullName" label={t("free.fullName")} message={messages.fullName}>
        <input
          id="free-fullName"
          data-testid="free-fullName"
          className={styles.input}
          autoComplete="name"
          value={values.fullName}
          onChange={update("fullName")}
          aria-invalid={messages.fullName ? true : undefined}
        />
      </Field>

      <Field id="free-phone" label={t("free.phone")} message={messages.phone} hint={t("free.phoneHint")}>
        <input
          id="free-phone"
          data-testid="free-phone"
          className={styles.input}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="+85512345678"
          value={values.phone}
          onChange={update("phone")}
          aria-invalid={messages.phone ? true : undefined}
        />
      </Field>

      <Field id="free-emergencyName" label={t("free.emergencyName")} message={messages.emergencyName}>
        <input
          id="free-emergencyName"
          data-testid="free-emergencyName"
          className={styles.input}
          value={values.emergencyName}
          onChange={update("emergencyName")}
          aria-invalid={messages.emergencyName ? true : undefined}
        />
      </Field>

      <Field id="free-emergencyPhone" label={t("free.emergencyPhone")} message={messages.emergencyPhone}>
        <input
          id="free-emergencyPhone"
          data-testid="free-emergencyPhone"
          className={styles.input}
          type="tel"
          inputMode="tel"
          placeholder="+85512345678"
          value={values.emergencyPhone}
          onChange={update("emergencyPhone")}
          aria-invalid={messages.emergencyPhone ? true : undefined}
        />
      </Field>

      <Field id="free-gender" label={`${t("free.gender")} ${t("free.optional")}`} message={messages.gender}>
        <select id="free-gender" data-testid="free-gender" className={styles.input} value={values.gender} onChange={update("gender")}>
          <option value="">{t("free.genderUnset")}</option>
          <option value="M">{t("free.genderM")}</option>
          <option value="F">{t("free.genderF")}</option>
          <option value="X">{t("free.genderX")}</option>
        </select>
      </Field>

      <Field
        id="free-birthDate"
        label={category && category.minAge > 0 ? t("free.birthDate") : `${t("free.birthDate")} ${t("free.optional")}`}
        message={messages.birthDate}
      >
        <input
          id="free-birthDate"
          data-testid="free-birthDate"
          className={styles.input}
          type="date"
          value={values.birthDate}
          onChange={update("birthDate")}
          aria-invalid={messages.birthDate ? true : undefined}
        />
      </Field>

      <fieldset className={styles.consent}>
        <legend className={styles.label}>{t("free.consentTitle")}</legend>
        <details className={styles.fullText}>
          <summary>{t("free.consentFullText")}</summary>
          <p>{consent.fullText}</p>
        </details>
        {consent.items.map((item) => (
          <label key={item.key} className={styles.consentItem}>
            <input
              type="checkbox"
              data-testid={`consent-item-${item.key}`}
              checked={checked.has(item.key)}
              onChange={toggle(item.key)}
            />
            <span className={styles.consentText}>
              <strong>{item.title}</strong>
              {item.description ? <span className={styles.hint}>{item.description}</span> : null}
            </span>
          </label>
        ))}
        {!allChecked ? <p className={styles.hint}>{t("free.consentHint")}</p> : null}
      </fieldset>

      {create.error ? (
        <p className={styles.formError} role="alert" data-testid="form-error" data-code={errorCode}>
          {errorCode === "ALREADY_REGISTERED" ? t("free.alreadyRegistered") : create.error.message}
        </p>
      ) : null}

      <button type="submit" className={styles.submit} data-testid="free-submit" disabled={!allChecked || create.isPending}>
        {create.isPending ? t("free.submitting") : t("free.submit")}
      </button>
    </form>
  );
}
```

- [ ] **Step 25：样式 `web/user/src/pages/FreeSignupPage.module.css`**

```css
.form {
  display: grid;
  gap: 16px;
  max-width: 560px;
}

.field {
  display: grid;
  gap: 6px;
}

.label {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink-mid);
}

.input {
  min-height: 44px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--card);
  color: var(--ink);
  font: inherit;
}

.input[aria-invalid="true"] {
  border-color: var(--stop);
}

.hint {
  display: block;
  font-size: 13px;
  color: var(--ink-mute);
}

.fieldError {
  font-size: 13px;
  color: var(--stop);
}

.consent {
  display: grid;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--card);
}

.fullText summary {
  cursor: pointer;
  color: var(--brand);
  font-weight: 600;
}

.fullText p {
  margin-top: 8px;
  white-space: pre-wrap;
  color: var(--ink-mid);
}

.consentItem {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-height: 44px;
  cursor: pointer;
}

.consentItem input {
  width: 20px;
  height: 20px;
  margin-top: 2px;
  accent-color: var(--brand);
}

.consentText {
  display: grid;
  gap: 2px;
}

.formError {
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--stop-tint);
  color: var(--stop);
}

.submit {
  min-height: 48px;
  border: 0;
  border-radius: 100px;
  background: var(--brand);
  color: var(--card);
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}

.submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.done {
  display: grid;
  gap: 12px;
  padding: 20px;
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--card);
}

.doneTitle {
  font-size: 20px;
  font-weight: 700;
}
```

- [ ] **Step 26：注册路由 `web/user/src/routes.tsx`**

Old：

```tsx
import { EventDetailPage } from "./pages/EventDetailPage";
```

New：

```tsx
import { EventDetailPage } from "./pages/EventDetailPage";
import { FreeSignupPage } from "./pages/FreeSignupPage";
```

Old：

```tsx
      { path: "events/:slug", element: <EventDetailPage /> },
```

New：

```tsx
      { path: "events/:slug", element: <EventDetailPage /> },
      {
        path: "events/:slug/free-signup",
        element: (
          <RequireRunner>
            <FreeSignupPage />
          </RequireRunner>
        ),
      },
```

`RequireRunner` 已由 Task 10 从 `./auth/RequireRunner` 导入。

- [ ] **Step 27：赛事详情加入口 `web/user/src/pages/EventDetailPage.tsx`**

Old：

```tsx
import { useParams } from "react-router";
```

New：

```tsx
import { Link, useParams } from "react-router";
```

（若 Task 14 已把这一行改成含 `Link` 的导入，保持不变。）

Old：

```tsx
          <h2 className={styles.title}>{t("event.categories")}</h2>
```

New：

```tsx
          {data.eventType === "FREE_ACTIVITY" && data.registrationOpen ? (
            <Link
              to={`/events/${data.slug}/free-signup`}
              className={styles.freeSignupAction}
              data-testid="free-signup-button"
            >
              {t("free.button")}
            </Link>
          ) : null}
          <h2 className={styles.title}>{t("event.categories")}</h2>
```

`web/user/src/pages/Page.module.css` 末尾追加：

```css
.freeSignupAction {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 48px;
  margin-bottom: 20px;
  padding: 0 24px;
  border-radius: 100px;
  background: var(--brand);
  color: var(--card);
  font-weight: 700;
  text-decoration: none;
}
```

- [ ] **Step 28：三语文案**

在 `packages/i18n/locales/zh/user.json` 顶层对象最后一个键之后加入：

```json
  "free": {
    "title": "免费报名",
    "button": "免费报名",
    "category": "组别",
    "chooseCategory": "请选择组别",
    "soldOut": "已满",
    "minAgeHint": "最低年龄 {{minAge}} 岁（按比赛当天计算）",
    "fullName": "姓名",
    "phone": "手机号",
    "phoneHint": "带国家区号，例如 +85512345678",
    "emergencyName": "紧急联系人姓名",
    "emergencyPhone": "紧急联系人电话",
    "gender": "性别",
    "optional": "（选填）",
    "genderUnset": "不填写",
    "genderM": "男",
    "genderF": "女",
    "genderX": "其他",
    "birthDate": "出生日期",
    "consentTitle": "报名同意书",
    "consentFullText": "查看全文",
    "consentHint": "逐项勾选后才能提交",
    "submit": "提交报名",
    "submitting": "提交中…",
    "required": "必填",
    "phoneInvalid": "请输入带国家区号的手机号，例如 +85512345678",
    "tooYoung": "比赛当天须年满 {{minAge}} 岁",
    "alreadyRegistered": "该姓名和手机号已报名这个组别",
    "closed": "该活动当前未开放报名",
    "doneTitle": "报名成功",
    "doneBody": "报名编号：{{signupNo}}",
    "doneBack": "返回活动详情"
  }
```

`packages/i18n/locales/en/user.json`：

```json
  "free": {
    "title": "Free sign-up",
    "button": "Sign up for free",
    "category": "Category",
    "chooseCategory": "Choose a category",
    "soldOut": "Full",
    "minAgeHint": "Minimum age {{minAge}} on race day",
    "fullName": "Full name",
    "phone": "Phone number",
    "phoneHint": "Include the country code, e.g. +85512345678",
    "emergencyName": "Emergency contact name",
    "emergencyPhone": "Emergency contact phone",
    "gender": "Gender",
    "optional": "(optional)",
    "genderUnset": "Prefer not to say",
    "genderM": "Male",
    "genderF": "Female",
    "genderX": "Other",
    "birthDate": "Date of birth",
    "consentTitle": "Registration consent",
    "consentFullText": "Read the full text",
    "consentHint": "Tick every item to submit",
    "submit": "Submit sign-up",
    "submitting": "Submitting…",
    "required": "Required",
    "phoneInvalid": "Enter a phone number with the country code, e.g. +85512345678",
    "tooYoung": "Must be at least {{minAge}} years old on race day",
    "alreadyRegistered": "This name and phone number are already signed up for this category",
    "closed": "Registration for this activity is not open",
    "doneTitle": "You are signed up",
    "doneBody": "Sign-up number: {{signupNo}}",
    "doneBack": "Back to the activity"
  }
```

`packages/i18n/locales/km/user.json`：

```json
  "free": {
    "title": "ចុះឈ្មោះដោយឥតគិតថ្លៃ",
    "button": "ចុះឈ្មោះដោយឥតគិតថ្លៃ",
    "category": "ប្រភេទ",
    "chooseCategory": "សូមជ្រើសរើសប្រភេទ",
    "soldOut": "ពេញហើយ",
    "minAgeHint": "អាយុអប្បបរមា {{minAge}} ឆ្នាំ គិតនៅថ្ងៃប្រកួត",
    "fullName": "ឈ្មោះពេញ",
    "phone": "លេខទូរសព្ទ",
    "phoneHint": "បញ្ចូលលេខកូដប្រទេស ឧទាហរណ៍ +85512345678",
    "emergencyName": "ឈ្មោះអ្នកទំនាក់ទំនងពេលអាសន្ន",
    "emergencyPhone": "លេខទូរសព្ទពេលអាសន្ន",
    "gender": "ភេទ",
    "optional": "(មិនបង្ខំ)",
    "genderUnset": "មិនបញ្ជាក់",
    "genderM": "ប្រុស",
    "genderF": "ស្រី",
    "genderX": "ផ្សេងទៀត",
    "birthDate": "ថ្ងៃខែឆ្នាំកំណើត",
    "consentTitle": "លិខិតយល់ព្រមចុះឈ្មោះ",
    "consentFullText": "មើលអត្ថបទពេញ",
    "consentHint": "សូមធីកគ្រប់ចំណុច ទើបអាចដាក់ស្នើបាន",
    "submit": "ដាក់ស្នើការចុះឈ្មោះ",
    "submitting": "កំពុងដាក់ស្នើ…",
    "required": "ត្រូវតែបំពេញ",
    "phoneInvalid": "សូមបញ្ចូលលេខទូរសព្ទដែលមានលេខកូដប្រទេស ឧទាហរណ៍ +85512345678",
    "tooYoung": "ត្រូវមានអាយុយ៉ាងតិច {{minAge}} ឆ្នាំ នៅថ្ងៃប្រកួត",
    "alreadyRegistered": "ឈ្មោះ និងលេខទូរសព្ទនេះបានចុះឈ្មោះក្នុងប្រភេទនេះរួចហើយ",
    "closed": "សកម្មភាពនេះមិនទាន់បើកឱ្យចុះឈ្មោះទេ",
    "doneTitle": "ចុះឈ្មោះបានជោគជ័យ",
    "doneBody": "លេខចុះឈ្មោះ៖ {{signupNo}}",
    "doneBack": "ត្រឡប់ទៅទំព័រសកម្មភាព"
  }
```

（前一个键的结尾补逗号，保持 JSON 合法。）

- [ ] **Step 29：运行前端测试，确认通过**

Run: `pnpm --filter @werun/user test src/free src/pages/FreeSignupPage.test.tsx src/pages/EventDetailPage.freeSignup.test.tsx`
Expected: `Test Files  3 passed`，`Tests  18 passed`（validate 9、FreeSignupPage 6、赛事详情入口 3）。

- [ ] **Step 30：全量检查**

Run（colima 环境变量同 Step 6）：
```bash
make lint-api
make test-api
make gen && git status --porcelain api/internal/httpapi/apigen api/internal/registration/store packages/api-client/src/schema.d.ts
pnpm typecheck
pnpm lint
pnpm test
pnpm i18n:check
pnpm build
```
Expected：`golangci-lint` 输出 `0 issues.`；`go test ./...` 全部 `ok`（含 `TestEmbeddedCatalogCoversAllCodesAndFieldKeys`、`TestOperationAuthsCoversEveryStrictServerInterfaceMethod`）；第二次 `make gen` 后 `git status` 只列出本任务已有的生成文件改动、不出现新的差异；`pnpm typecheck`、`pnpm lint`、`pnpm test` 退出码 0；`pnpm i18n:check` 输出 `i18n 检查通过：3 个命名空间，三种语言 key 一致`；`pnpm build` 成功。

- [ ] **Step 31：提交**

```bash
git add api/internal/runner/contact.go api/internal/runner/contact_test.go \
  api/db/queries/registration.sql api/internal/registration/store \
  api/internal/registration/free.go api/internal/registration/free_test.go api/internal/registration/free_handlers.go \
  api/openapi/openapi.yaml api/internal/httpapi/apigen/api.gen.go api/internal/httpapi/apigen/permissions.gen.go \
  api/internal/httpapi/free_signups_http_test.go \
  packages/api-client/src/schema.d.ts \
  web/user/src/free/validate.ts web/user/src/free/validate.test.ts web/user/src/free/queries.ts \
  web/user/src/pages/FreeSignupPage.tsx web/user/src/pages/FreeSignupPage.module.css web/user/src/pages/FreeSignupPage.test.tsx \
  web/user/src/pages/EventDetailPage.tsx web/user/src/pages/EventDetailPage.freeSignup.test.tsx web/user/src/pages/Page.module.css \
  web/user/src/test/freeFixtures.ts web/user/src/routes.tsx \
  packages/i18n/locales/zh/user.json packages/i18n/locales/en/user.json packages/i18n/locales/km/user.json
git commit -m "$(cat <<'EOF'
feat: 免费活动报名接口与用户端报名页

- registration.CreateFreeSignup：开放校验、组别与年龄、占名额、同名同手机号防重、同意书关联、审计 free_signup.create
- OpenAPI appCreateFreeSignup（x-auth: app）
- runner.ValidateContactFields 复用 ValidateProfile 字段规则
- 用户端 /events/:slug/free-signup 页面与赛事详情免费报名入口，三语文案

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
)"
```

---

### Task 23: 端到端测试与 CI

**Files:**
- Modify: `e2e/tests/env.ts`
- Create: `e2e/tests/runner.ts`
- Test: `e2e/tests/runner-auth.spec.ts`
- Modify: `e2e/tests/helpers.ts`
- Modify: `e2e/scripts/seed-staff.sh`
- Create: `e2e/scripts/seed-consent.sh`
- Modify: `e2e/package.json`
- Test: `e2e/tests/registration.spec.ts`
- Test: `e2e/tests/free-signup.spec.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `Makefile`

**Interfaces:**
- Consumes：
  - Global Constraints 的 `initData` 签名算法；`POST /api/app/auth/telegram`（`appLoginTelegram`，请求体 `{initData}`，200 返回 `{token, expiresAt, user}`，失败 401 `TELEGRAM_AUTH_INVALID`）
  - 实现调整 #5（`TELEGRAM_SDK_URL = https://telegram.org/js/telegram-web-app.js`，`#tgWebAppData=`）、#6（`werun publish-consent --purpose --version --lang --effective-date --file - --items '<json>'`）
  - `werun create-staff --username --full-name --role --password-stdin`
  - 总览 §10 的全部后台与用户端 testid、表单 `name`（`priceRule`、`coupon`、`paymentAccount`、`approve`、`reject`、`event`）；Task 22 的 `free-*`、`free-signup-button`、`free-signup-done`、`form-error[data-code]`
  - 总览 §11：`.env` 的 `WERUN_TELEGRAM_BOT_TOKEN=123456:e2e-test-token`、`WERUN_TELEGRAM_BOT_USERNAME=werun_e2e_bot`、`WERUN_TELEGRAM_SEND=off`、`WERUN_APP_BASE_URL=http://werun.localhost`；`E2E_TELEGRAM_BOT_TOKEN`、`E2E_FINANCE_PASSWORD`
  - 契约补充 6、8
- Produces：
  - `e2e/tests/env.ts`：`FINANCE`、`TELEGRAM_BOT_TOKEN`
  - `e2e/tests/runner.ts`：`TELEGRAM_SDK_URL`、`interface TelegramUser`、`signInitData(botToken: string, user: TelegramUser, authDate: Date): string`、`runnerUser(firstName: string, languageCode: "zh" | "en" | "km"): TelegramUser`、`openAsRunner(page: Page, user: TelegramUser, path: string): Promise<void>`
  - `e2e/tests/helpers.ts` 新增：`adminSession`、`adminFetch`、`selectAntdOption`、`fillControl`、`makePng`、`createAndPublishEvent`、`openEventDetail`、`openRegistration`、`parseUsdCents`、`centsToPlainUsd`、`pickerNow`
  - 种子：`finance.e2e`（FINANCE，默认密码 `e2e-Finance-Password-1`）、同意书 `REG-E2E-v1`（zh/en/km，勾选项 `rules`、`health`、`terms`）
  - Make 目标 `e2e-seed` 同时执行两个种子脚本；CI e2e 任务执行 `seed-consent.sh`

> 与脚手架 Task 17 相同：所有接口调用都在浏览器页面里用 `fetch` 发出（Node 在 macOS 上不解析 `*.localhost`）。

- [ ] **Step 1：更新 `e2e/tests/env.ts`（整体替换为以下内容）**

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

export const FINANCE = {
  username: "finance.e2e",
  password: process.env.E2E_FINANCE_PASSWORD ?? "e2e-Finance-Password-1",
};

/** 必须与 compose 环境 .env 里的 WERUN_TELEGRAM_BOT_TOKEN 一致 */
export const TELEGRAM_BOT_TOKEN = process.env.E2E_TELEGRAM_BOT_TOKEN ?? "123456:e2e-test-token";
```

- [ ] **Step 2：写失败的签名往返测试 `e2e/tests/runner-auth.spec.ts`**

不写死期望 hash：签名是否正确以真实后端 `VerifyInitData` 的判定为准。

```ts
import { expect, test } from "@playwright/test";
import { TELEGRAM_BOT_TOKEN, USER_URL } from "./env";
import { openAsRunner, runnerUser, signInitData } from "./runner";

async function login(page: import("@playwright/test").Page, initData: string) {
  return page.evaluate(async (body) => {
    const res = await fetch("/api/app/auth/telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept-Language": "en" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }, { initData });
}

test("测试代码签名的 initData 通过真实接口登录", async ({ page }) => {
  await page.goto(`${USER_URL}/events`);
  const initData = signInitData(TELEGRAM_BOT_TOKEN, runnerUser("Dara", "en"), new Date());

  const result = await login(page, initData);

  expect(result.status).toBe(200);
  expect(typeof result.json.token).toBe("string");
  expect(String(result.json.token).length).toBeGreaterThan(20);
  expect(typeof result.json.expiresAt).toBe("string");
});

test("篡改 hash 的 initData 返回 TELEGRAM_AUTH_INVALID", async ({ page }) => {
  await page.goto(`${USER_URL}/events`);
  const initData = signInitData(TELEGRAM_BOT_TOKEN, runnerUser("Dara", "en"), new Date());
  const tampered = initData.replace(/hash=[0-9a-f]{64}/, `hash=${"0".repeat(64)}`);
  expect(tampered).not.toBe(initData);

  const result = await login(page, tampered);

  expect(result.status).toBe(401);
  expect((result.json.error as { code: string }).code).toBe("TELEGRAM_AUTH_INVALID");
});

test("openAsRunner 打开需要登录的页面时自动登录，不显示 open-in-telegram", async ({ page }) => {
  const loggedIn = page.waitForResponse(
    (res) => new URL(res.url()).pathname === "/api/app/auth/telegram" && res.status() === 200,
  );

  await openAsRunner(page, runnerUser("Sophea", "km"), "/orders");

  await loggedIn;
  await expect(page.getByTestId("open-in-telegram")).toHaveCount(0);
});
```

- [ ] **Step 3：运行，确认失败**

Run: `pnpm --filter @werun/e2e typecheck`
Expected: 失败，输出含 `Cannot find module './runner'`。

- [ ] **Step 4：实现 `e2e/tests/runner.ts`**

```ts
import { createHmac } from "node:crypto";
import type { Page } from "@playwright/test";
import { TELEGRAM_BOT_TOKEN, USER_URL } from "./env";

/** 与 web/user/src/telegram/telegram.ts 的 TELEGRAM_SDK_URL 相同 */
export const TELEGRAM_SDK_URL = "https://telegram.org/js/telegram-web-app.js";

/** Telegram initData 里 user 字段的 JSON 形状 */
export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

/**
 * 按 Global Constraints 签名：
 * secret = HMAC_SHA256(key="WebAppData", msg=botToken)
 * hash = hex(HMAC_SHA256(key=secret, msg=data_check_string))
 * data_check_string = 除 hash 外的字段按键名排序，以 \n 连接的 key=value（值为原文，不做 URL 编码）
 * 返回 URL 编码后的查询串，含 auth_date、user（JSON）、hash。
 */
export function signInitData(botToken: string, user: TelegramUser, authDate: Date): string {
  const fields: [string, string][] = [
    ["auth_date", String(Math.floor(authDate.getTime() / 1000))],
    ["user", JSON.stringify(user)],
  ];
  fields.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const dataCheckString = fields.map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  const params = new URLSearchParams(fields);
  params.set("hash", hash);
  return params.toString();
}

/** 每次调用生成一个新的 Telegram 用户，避免多次运行之间共享跑者数据 */
export function runnerUser(firstName: string, languageCode: "zh" | "en" | "km"): TelegramUser {
  const id = 7_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
  return {
    id,
    first_name: firstName,
    last_name: "E2E",
    username: `e2e_${id}`,
    language_code: languageCode,
  };
}

function telegramStubScript(initData: string): string {
  const params = new URLSearchParams(initData);
  const initDataUnsafe = {
    user: JSON.parse(params.get("user") ?? "{}") as unknown,
    auth_date: Number(params.get("auth_date")),
    hash: params.get("hash"),
  };
  return `(() => {
  if (window.Telegram && window.Telegram.WebApp) {
    return;
  }
  const noop = () => {};
  window.Telegram = {
    WebApp: {
      initData: ${JSON.stringify(initData)},
      initDataUnsafe: ${JSON.stringify(initDataUnsafe)},
      ready: noop,
      expand: noop,
      themeParams: {},
      viewportStableHeight: 800,
      onEvent: noop,
      offEvent: noop,
      BackButton: { show: noop, hide: noop, onClick: noop, offClick: noop },
    },
  };
})();`;
}

const pageRunners = new WeakMap<Page, number>();

/**
 * 以 Telegram 小程序身份打开用户端页面（实现调整 #5）：
 * 1. 拦截 TELEGRAM_SDK_URL，返回设置 window.Telegram.WebApp 的桩脚本；
 * 2. 同一段脚本也用 addInitScript 在页面脚本之前执行，避免登录逻辑早于 SDK 加载读取 initData；
 * 3. 打开 `${USER_URL}${path}#tgWebAppData=<initData>`。
 * 一个 page 只对应一个跑者；换跑者请新建 context。
 */
export async function openAsRunner(page: Page, user: TelegramUser, path: string): Promise<void> {
  const bound = pageRunners.get(page);
  if (bound !== undefined && bound !== user.id) {
    throw new Error(`page 已绑定跑者 ${bound}，不能再以 ${user.id} 打开；请为不同跑者新建 context`);
  }
  const initData = signInitData(TELEGRAM_BOT_TOKEN, user, new Date());
  if (bound === undefined) {
    const script = telegramStubScript(initData);
    await page.route(TELEGRAM_SDK_URL, (route) =>
      route.fulfill({ status: 200, contentType: "application/javascript; charset=utf-8", body: script }),
    );
    await page.addInitScript(script);
    pageRunners.set(page, user.id);
  }
  // 只差 hash 的地址不会重新加载文档，先离开当前页保证完整加载
  if (page.url().startsWith(USER_URL)) {
    await page.goto("about:blank");
  }
  await page.goto(`${USER_URL}${path}#tgWebAppData=${encodeURIComponent(initData)}`);
}
```

- [ ] **Step 5：类型检查通过，往返测试在 Step 13 与完整环境一起运行**

Run: `pnpm --filter @werun/e2e typecheck`
Expected: 退出码 0，无输出。

- [ ] **Step 6：扩充 `e2e/tests/helpers.ts`（整体替换为以下内容；原有 `presetLanguage`、`loginAdmin`、`fillDate` 保持不变）**

```ts
import { crc32, deflateSync } from "node:zlib";
import { expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { ADMIN_URL } from "./env";

/**
 * 在页面脚本执行前写入语言，保证每个上下文的初始语言确定。
 *
 * `addInitScript` 会在该上下文里每次导航（包括 `page.reload()`）前重新执行，
 * 不是只执行一次。如果无条件写入，reload 时会把用户在页面里切换后写入的
 * `werun.lang` 覆盖回这里的初始值。所以只在键不存在时写入，保证首次加载的
 * 初始语言确定，同时不影响页面运行时自己写入的语言。
 */
export async function presetLanguage(context: BrowserContext, lang: "zh" | "en" | "km"): Promise<void> {
  await context.addInitScript((value) => {
    if (window.localStorage.getItem("werun.lang") === null) {
      window.localStorage.setItem("werun.lang", value);
    }
  }, lang);
}

export async function loginAdmin(page: Page, username: string, password: string): Promise<void> {
  await page.goto(`${ADMIN_URL}/login`);
  await page.getByTestId("login-username").fill(username);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(`${ADMIN_URL}/events`);
}

/**
 * AntD DatePicker：输入文本后用 Tab 提交确认。selector 形如 "#event_raceDate"
 *
 * 没有用 Enter：表单里只有 slug/姓名/城市/比赛日期/组别必填项是必填的，
 * startAt/cutoffAt 不是必填项；当这些必填项都已填好时，在日期输入框按 Enter
 * 会触发 antd 表单的默认提交（浏览器原生行为），导致表单在 cutoffAt 填完之前
 * 就被提交并跳转，而不是仅仅关闭 DatePicker 面板。改用 Tab 把焦点移出输入框，
 * 同样能让 DatePicker 提交已输入的文本，但不会触发表单提交。
 */
export async function fillDate(page: Page, selector: string, value: string): Promise<void> {
  const input = page.locator(selector);
  await input.click();
  await input.fill(value);
  await input.press("Tab");
}

/** 新建 zh 语言的上下文并以员工身份登录 */
export async function adminSession(
  browser: Browser,
  username: string,
  password: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await presetLanguage(context, "zh");
  const page = await context.newPage();
  await loginAdmin(page, username, password);
  return { context, page };
}

/** 在已登录的后台页面里调用接口（带会话 Cookie 与 X-WeRun-Client） */
export async function adminFetch<T>(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const result = await page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, {
        method,
        credentials: "include",
        headers: { "Content-Type": "application/json", "Accept-Language": "zh", "X-WeRun-Client": "admin" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, json: text === "" ? null : (JSON.parse(text) as unknown) };
    },
    { method, path, body },
  );
  return { status: result.status, json: result.json as T };
}

/**
 * 按选项 value 选择 antd Select，不依赖选项文案（契约补充 8）。
 * rc-select 打开后，输入框的 aria-activedescendant 指向一个隐藏的无障碍节点，
 * 节点文本就是当前高亮选项的 value；逐个 ArrowDown 直到匹配再 Enter。
 * 多选：已选中（aria-selected="true"）时不再按 Enter（否则会取消选择），最后 Escape 关闭下拉。
 */
export async function selectAntdOption(page: Page, inputId: string, value: string, options: { multiple?: boolean } = {}): Promise<void> {
  const input = page.locator(`#${inputId}`);
  await input.click();
  await expect(input).toHaveAttribute("aria-activedescendant", /_list_\d+$/);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const activeId = await input.getAttribute("aria-activedescendant");
    if (activeId !== null) {
      const active = page.locator(`[id="${activeId}"]`);
      if ((await active.count()) > 0 && (await active.textContent()) === value) {
        if (!options.multiple) {
          await input.press("Enter");
          return;
        }
        if ((await active.getAttribute("aria-selected")) !== "true") {
          await input.press("Enter");
        }
        await input.press("Escape");
        return;
      }
    }
    await input.press("ArrowDown");
    // 选项可能异步加载（如赛事下拉）；没有匹配时稍等再试
    await page.waitForTimeout(50);
  }
  throw new Error(`antd Select #${inputId} 中找不到 value=${value} 的选项`);
}

/** 用户端原生控件：<select> 用 selectOption，其余用 fill */
export async function fillControl(locator: Locator, value: string): Promise<void> {
  const tag = await locator.evaluate((el) => el.tagName);
  if (tag === "SELECT") {
    await locator.selectOption(value);
  } else {
    await locator.fill(value);
  }
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * 运行时生成一张 2×2 的 RGB PNG，颜色取 seed 的低 24 位。
 * 不同 seed 的文件 sha256 不同，重传时不会触发重复截图标记；服务端能解码出宽高。
 */
export function makePng(seed: number): Buffer {
  const width = 2;
  const height = 2;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 位深
  header[9] = 2; // 真彩色 RGB
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const rowLength = 1 + width * 3;
  const raw = Buffer.alloc(rowLength * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * rowLength;
    raw[row] = 0; // 过滤类型 None
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 3;
      raw[offset] = seed & 0xff;
      raw[offset + 1] = (seed >> 8) & 0xff;
      raw[offset + 2] = (seed >> 16) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export interface NewEvent {
  slug: string;
  name: { zh: string; en: string; km: string };
  eventType: "RACE" | "FREE_ACTIVITY";
  capacity: number;
}

/** OPS 已登录：新建赛事（一个组别）并发布 */
export async function createAndPublishEvent(page: Page, ev: NewEvent): Promise<void> {
  await page.goto(`${ADMIN_URL}/events`);
  await page.getByTestId("event-create-button").click();
  await expect(page).toHaveURL(`${ADMIN_URL}/events/new`);

  await page.locator("#event_slug").fill(ev.slug);
  if (ev.eventType !== "RACE") {
    await selectAntdOption(page, "event_eventType", ev.eventType);
  }
  await page.locator("#event_name_zh").fill(ev.name.zh);
  await page.locator("#event_name_en").fill(ev.name.en);
  await page.locator("#event_name_km").fill(ev.name.km);
  await page.locator("#event_city").fill("Phnom Penh");
  await fillDate(page, "#event_raceDate", "2027-01-17");

  await page.locator("#event_categories_0_code").fill("5K");
  await page.locator("#event_categories_0_name_zh").fill("欢乐 5K");
  await page.locator("#event_categories_0_name_en").fill("Fun 5K");
  await page.locator("#event_categories_0_name_km").fill("រត់ 5K");
  await page.locator("#event_categories_0_distanceM").fill("5000");
  await page.locator("#event_categories_0_capacity").fill(String(ev.capacity));
  await fillDate(page, "#event_categories_0_startAt", "2027-01-17 06:00");
  await fillDate(page, "#event_categories_0_cutoffAt", "2027-01-17 08:00");

  await page.getByTestId("event-form-submit").click();
  await expect(page).toHaveURL(`${ADMIN_URL}/events`);

  const publish = page.getByTestId(`event-publish-${ev.slug}`);
  await expect(publish).toBeVisible();
  await publish.click();
  await expect(publish).toBeHidden();
}

/** 从赛事列表进入详情，返回赛事 id 与第一个组别 id */
export async function openEventDetail(page: Page, slug: string): Promise<{ id: number; categoryId: number }> {
  await page.goto(`${ADMIN_URL}/events`);
  await page.getByTestId(`event-open-${slug}`).click();
  await expect(page).toHaveURL(/\/events\/\d+/);
  const match = /\/events\/(\d+)/.exec(new URL(page.url()).pathname);
  if (!match) {
    throw new Error(`赛事详情地址不含 id：${page.url()}`);
  }
  const id = Number(match[1]);
  const detail = await adminFetch<{ categories: { id: number }[] }>(page, "GET", `/admin/events/${id}`);
  expect(detail.status).toBe(200);
  const category = detail.json.categories[0];
  if (!category) {
    throw new Error(`赛事 ${slug} 没有组别`);
  }
  return { id, categoryId: category.id };
}

/** OPS 已登录：打开报名开关并保存，刷新后确认已持久化 */
export async function openRegistration(page: Page, eventId: number): Promise<void> {
  await page.goto(`${ADMIN_URL}/events/${eventId}`);
  const toggle = page.getByTestId("event-registration-switch");
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-checked")) !== "true") {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("aria-checked", "true");

  const saved = page.waitForResponse(
    (res) => /\/api\/admin\/events\/\d+\/registration$/.test(new URL(res.url()).pathname) && res.request().method() === "PATCH",
  );
  await page.getByTestId("event-registration-save").click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByTestId("event-registration-not-ready")).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("event-registration-switch")).toHaveAttribute("aria-checked", "true");
}

/** "$44.99" / "-$5.00" / "44.99" → 4499 / 500 / 4499（只取数值部分） */
export function parseUsdCents(text: string): number {
  const match = /(\d+)\.(\d{2})/.exec(text);
  if (!match) {
    throw new Error(`不是美元金额：${text}`);
  }
  return Number(match[1]) * 100 + Number(match[2]);
}

/** 4499 → "44.99"（后台与上传页的美元输入框格式） */
export function centsToPlainUsd(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** 本地时间 "YYYY-MM-DD HH:mm"，默认为 1 分钟前（到账时间不能晚于现在） */
export function pickerNow(offsetMinutes = -1): string {
  const d = new Date(Date.now() + offsetMinutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
```

Run: `pnpm --filter @werun/e2e typecheck`
Expected: 退出码 0。

- [ ] **Step 7：种子脚本**

`e2e/scripts/seed-staff.sh` 整体替换为：

```bash
#!/usr/bin/env bash
# 在已启动的 deploy/compose.yaml 环境里创建端到端测试账号。可重复执行。
set -euo pipefail

cd "$(dirname "$0")/../.."

COMPOSE=(docker compose -f deploy/compose.yaml --env-file .env)
OPS_PASSWORD="${E2E_OPS_PASSWORD:-e2e-Ops-Password-1}"
ADMIN_PASSWORD="${E2E_ADMIN_PASSWORD:-e2e-Admin-Password-1}"
FINANCE_PASSWORD="${E2E_FINANCE_PASSWORD:-e2e-Finance-Password-1}"

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
create_staff finance.e2e "FINANCE E2E" FINANCE "$FINANCE_PASSWORD"
```

新建 `e2e/scripts/seed-consent.sh`：

```bash
#!/usr/bin/env bash
# 在已启动的 deploy/compose.yaml 环境里发布端到端测试用的报名同意书 REG-E2E-v1（zh/en/km）。
# 已发布的语言跳过（同意书版本发布后不可修改）。可重复执行。
set -euo pipefail

cd "$(dirname "$0")/../.."

COMPOSE=(docker compose -f deploy/compose.yaml --env-file .env)
VERSION="REG-E2E-v1"
EFFECTIVE_DATE="2026-01-01"

consent_exists() {
  local lang="$1"
  "${COMPOSE[@]}" exec -T postgres \
    psql -U werun -d werun -tAc "SELECT 1 FROM disclaimer_versions WHERE version = '${VERSION}' AND lang = '${lang}'" | grep -q '^1$'
}

publish_consent() {
  local lang="$1" text="$2" items="$3"
  if consent_exists "$lang"; then
    echo "skip ${VERSION} (${lang}): already published"
    return
  fi
  printf '%s\n' "$text" | "${COMPOSE[@]}" exec -T api /werun publish-consent \
    --purpose REGISTRATION --version "$VERSION" --lang "$lang" \
    --effective-date "$EFFECTIVE_DATE" --file - --items "$items"
  echo "published ${VERSION} (${lang})"
}

ZH_TEXT='# 报名同意书（端到端测试）

1. 参赛者须遵守赛事规则，包括关门时间与赛道安全要求。
2. 参赛者确认自身健康状况适合参加本次活动。
3. 报名信息仅用于赛事组织。'
ZH_ITEMS='[{"k":"rules","t":"我已阅读并遵守赛事规则","d":"包括关门时间与赛道安全要求"},{"k":"health","t":"我的身体状况适合参加本次活动","d":"如有心脏病等疾病请先咨询医生"},{"k":"terms","t":"我同意报名条款与个人信息处理规则","d":"报名信息仅用于赛事组织"}]'

EN_TEXT='# Registration consent (end-to-end test)

1. Participants must follow the event rules, including cut-off times and course safety requirements.
2. Participants confirm they are fit to take part in this event.
3. Registration data is used only to organise the event.'
EN_ITEMS='[{"k":"rules","t":"I have read and will follow the event rules","d":"Including cut-off times and course safety requirements"},{"k":"health","t":"I am fit to take part in this event","d":"Consult a doctor first if you have a heart condition or a similar illness"},{"k":"terms","t":"I agree to the registration terms and personal data policy","d":"Registration data is used only to organise the event"}]'

KM_TEXT='# លិខិតយល់ព្រមចុះឈ្មោះ (ការធ្វើតេស្តពីដើមដល់ចប់)

1. អ្នកចូលរួមត្រូវគោរពតាមវិន័យនៃព្រឹត្តិការណ៍ រួមទាំងពេលវេលាបិទ និងតម្រូវការសុវត្ថិភាពលើផ្លូវរត់។
2. អ្នកចូលរួមបញ្ជាក់ថា សុខភាពរបស់ខ្លួនសមរម្យសម្រាប់ចូលរួមព្រឹត្តិការណ៍នេះ។
3. ព័ត៌មានចុះឈ្មោះប្រើសម្រាប់តែការរៀបចំព្រឹត្តិការណ៍ប៉ុណ្ណោះ។'
KM_ITEMS='[{"k":"rules","t":"ខ្ញុំបានអាន ហើយនឹងគោរពតាមវិន័យនៃព្រឹត្តិការណ៍","d":"រួមទាំងពេលវេលាបិទ និងតម្រូវការសុវត្ថិភាពលើផ្លូវរត់"},{"k":"health","t":"សុខភាពរបស់ខ្ញុំសមរម្យសម្រាប់ចូលរួមព្រឹត្តិការណ៍នេះ","d":"ប្រសិនបើមានជំងឺបេះដូង ឬជំងឺស្រដៀងគ្នា សូមពិគ្រោះជាមួយវេជ្ជបណ្ឌិតជាមុន"},{"k":"terms","t":"ខ្ញុំយល់ព្រមលើលក្ខខណ្ឌចុះឈ្មោះ និងគោលការណ៍ទិន្នន័យផ្ទាល់ខ្លួន","d":"ព័ត៌មានចុះឈ្មោះប្រើសម្រាប់តែការរៀបចំព្រឹត្តិការណ៍ប៉ុណ្ណោះ"}]'

publish_consent zh "$ZH_TEXT" "$ZH_ITEMS"
publish_consent en "$EN_TEXT" "$EN_ITEMS"
publish_consent km "$KM_TEXT" "$KM_ITEMS"
```

Run: `chmod +x e2e/scripts/seed-consent.sh && bash -n e2e/scripts/seed-consent.sh && bash -n e2e/scripts/seed-staff.sh`
Expected: 无输出，退出码 0。

`e2e/package.json` 的 `scripts.seed`：

Old：

```json
    "seed": "bash scripts/seed-staff.sh"
```

New：

```json
    "seed": "bash scripts/seed-staff.sh && bash scripts/seed-consent.sh"
```

- [ ] **Step 8：写主流程用例 `e2e/tests/registration.spec.ts`（spec 14.4 第 1、2 条）**

价格档设计：早鸟 $20（配额 1，排序 0）+ 标准 $30（不限，排序 1）。两人同单时第 1 人取早鸟，早鸟本单已占满，第 2 人取标准，原价合计 $50；10% 优惠码减 $5，算价应付 $45.00；下单再减识别分 1–50 分（契约补充 8）。每次运行用新的 slug、优惠码、交易号与 Telegram 用户；`serial` 模式下 CI 重试会重新加载模块、生成新的 runId，从第一条重新开始。

```ts
import { expect, test, type Page } from "@playwright/test";
import { ADMIN_URL, FINANCE, OPS } from "./env";
import {
  adminSession,
  centsToPlainUsd,
  createAndPublishEvent,
  fillControl,
  fillDate,
  makePng,
  openEventDetail,
  openRegistration,
  parseUsdCents,
  pickerNow,
  presetLanguage,
  selectAntdOption,
} from "./helpers";
import { openAsRunner, runnerUser, type TelegramUser } from "./runner";

const runId = Date.now().toString(36);
const RUN = runId.toUpperCase();
const slug = `e2e-reg-${runId}`;
const eventName = {
  zh: `报名测试赛 ${runId}`,
  en: `Registration E2E ${runId}`,
  km: `ការប្រកួតសាកល្បងចុះឈ្មោះ ${runId}`,
};
const percentCode = `PCT${RUN}`;
const waiverCode = `FREE${RUN}`;
const accountName = `E2E ABA ${runId}`;
const rejectReason = `截图看不清 ${runId}`;
const CONSENT_KEYS = ["rules", "health", "terms"] as const;

const runnerA = runnerUser("Dara", "zh");
const runnerB = runnerUser("Sophea", "zh");

const shared = { eventId: 0, categoryId: 0, orderNo: "", dueCents: 0 };

test.describe.configure({ mode: "serial" });

async function runnerPage(browser: import("@playwright/test").Browser, user: TelegramUser, path: string) {
  const context = await browser.newContext();
  await presetLanguage(context, "zh");
  const page = await context.newPage();
  await openAsRunner(page, user, path);
  return { context, page };
}

async function createPriceRule(
  page: Page,
  rule: { zh: string; en: string; km: string; priceUsd: string; quota: string; sortOrder: string },
): Promise<void> {
  await page.getByTestId("price-rule-create").click();
  await page.locator("#priceRule_name_zh").fill(rule.zh);
  await page.locator("#priceRule_name_en").fill(rule.en);
  await page.locator("#priceRule_name_km").fill(rule.km);
  await selectAntdOption(page, "priceRule_audience", "ALL");
  await page.locator("#priceRule_priceUsd").fill(rule.priceUsd);
  await page.locator("#priceRule_quota").fill(rule.quota);
  await page.locator("#priceRule_sortOrder").fill(rule.sortOrder);
  await selectAntdOption(page, "priceRule_categoryIds", String(shared.categoryId), { multiple: true });
  await page.getByTestId("price-rule-submit").click();
}

async function createCoupon(
  page: Page,
  coupon: { code: string; discountType: "PERCENT" | "WAIVER"; discountValue: string; quota: string },
): Promise<void> {
  await page.getByTestId("coupon-create").click();
  await page.locator("#coupon_code").fill(coupon.code);
  await selectAntdOption(page, "coupon_discountType", coupon.discountType);
  const value = page.locator("#coupon_discountValue");
  if ((await value.isVisible()) && (await value.isEditable())) {
    await value.fill(coupon.discountValue);
  }
  await page.locator("#coupon_quota").fill(coupon.quota);
  await page.getByTestId("coupon-submit").click();
  await expect(page.getByTestId(`coupon-row-${coupon.code}`)).toBeVisible();
}

async function ensureParticipants(page: Page, count: number): Promise<void> {
  await expect(page.getByTestId("participant-add")).toBeVisible();
  for (let i = 0; i < count; i += 1) {
    const category = page.getByTestId(`participant-${i}-category`);
    if ((await category.count()) === 0) {
      await page.getByTestId("participant-add").click();
    }
    await expect(category).toBeVisible();
  }
  await expect(page.getByTestId(`participant-${count}-category`)).toHaveCount(0);
}

async function fillParticipant(
  page: Page,
  index: number,
  p: { fullName: string; gender: string; birthDate: string; idNo: string; phone: string },
): Promise<void> {
  const field = (name: string) => page.getByTestId(`participant-${index}-${name}`);
  await field("fullName").fill(p.fullName);
  await fillControl(field("gender"), p.gender);
  await field("birthDate").fill(p.birthDate);
  await fillControl(field("nationality"), "KH");
  await fillControl(field("idType"), "PASSPORT");
  await field("idNo").fill(p.idNo);
  await field("phone").fill(p.phone);
  await field("emergencyName").fill("Sok Chan");
  await field("emergencyPhone").fill("+85598765432");
  await fillControl(field("tshirtSize"), "M");
}

async function checkConsents(page: Page): Promise<void> {
  for (const key of CONSENT_KEYS) {
    await page.getByTestId(`consent-item-${key}`).check();
  }
}

async function uploadProof(page: Page, txnRef: string, png: Buffer): Promise<void> {
  await page.getByTestId("proof-file-input").setInputFiles({ name: `proof-${txnRef}.png`, mimeType: "image/png", buffer: png });
  await page.getByTestId("proof-txn-ref").fill(txnRef);
  await page.getByTestId("proof-amount").fill(centsToPlainUsd(shared.dueCents));
  await page.getByTestId("proof-submit").click();
  await expect(page).toHaveURL(new RegExp(`/orders/${shared.orderNo}$`));
  await expect(page.getByTestId("order-status")).toHaveAttribute("data-status", "PROOF_SUBMITTED");
}

async function openSubmittedProof(page: Page, orderNo: string): Promise<void> {
  await page.goto(`${ADMIN_URL}/proofs`);
  const row = page.locator('[data-testid^="proof-row-"]').filter({ hasText: orderNo });
  await expect(row).toHaveCount(1);
  await row.click();
  await expect(page).toHaveURL(/\/proofs\/\d+/);
  await expect(page.getByTestId("proof-status")).toHaveAttribute("data-status", "SUBMITTED");
  await expect(page.getByTestId("proof-image")).toBeVisible();
}

test("OPS 建赛事，配置早鸟与标准价格档、百分比与免单优惠码", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await adminSession(browser, OPS.username, OPS.password);

  await createAndPublishEvent(page, { slug, name: eventName, eventType: "RACE", capacity: 100 });
  const detail = await openEventDetail(page, slug);
  shared.eventId = detail.id;
  shared.categoryId = detail.categoryId;

  await page.getByTestId("event-tab-pricing").click();
  const rows = page.locator('[data-testid^="price-rule-row-"]');
  await createPriceRule(page, { zh: "早鸟价", en: "Early bird", km: "តម្លៃទិញមុន", priceUsd: "20", quota: "1", sortOrder: "0" });
  await expect(rows).toHaveCount(1);
  await createPriceRule(page, { zh: "标准价", en: "Standard", km: "តម្លៃស្តង់ដារ", priceUsd: "30", quota: "", sortOrder: "1" });
  await expect(rows).toHaveCount(2);

  await page.getByTestId("event-tab-coupons").click();
  await createCoupon(page, { code: percentCode, discountType: "PERCENT", discountValue: "10", quota: "10" });
  await createCoupon(page, { code: waiverCode, discountType: "WAIVER", discountValue: "0", quota: "5" });

  await context.close();
});

test("FINANCE 为该赛事建收款账户并上传二维码", async ({ browser }) => {
  const { context, page } = await adminSession(browser, FINANCE.username, FINANCE.password);

  await page.goto(`${ADMIN_URL}/payment-accounts`);
  await page.getByTestId("payment-account-create").click();
  await page.locator("#paymentAccount_name").fill(accountName);
  await selectAntdOption(page, "paymentAccount_provider", "ABA");
  await page.locator("#paymentAccount_accountName").fill("WERUN E2E");
  await page.locator("#paymentAccount_accountNoMasked").fill("*** *** 4321");
  await selectAntdOption(page, "paymentAccount_scope", "REGISTRATION");
  await selectAntdOption(page, "paymentAccount_eventId", String(shared.eventId));
  const active = page.locator("#paymentAccount_active");
  if ((await active.getAttribute("aria-checked")) !== "true") {
    await active.click();
  }
  await expect(active).toHaveAttribute("aria-checked", "true");
  await page
    .getByTestId("payment-account-qr-input")
    .setInputFiles({ name: "qr.png", mimeType: "image/png", buffer: makePng(0x33aa55) });
  await page.getByTestId("payment-account-submit").click();

  await expect(page.locator('[data-testid^="payment-account-row-"]').filter({ hasText: accountName })).toBeVisible();
  await context.close();
});

test("OPS 开放报名", async ({ browser }) => {
  const { context, page } = await adminSession(browser, OPS.username, OPS.password);
  await openRegistration(page, shared.eventId);
  await context.close();
});

test("跑者 A 两人同单用百分比优惠码下单，付款页金额与算价一致并上传凭证", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await runnerPage(browser, runnerA, `/events/${slug}`);

  await page.getByTestId("register-button").click();
  await expect(page).toHaveURL(new RegExp(`/events/${slug}/register`));

  await ensureParticipants(page, 2);
  await fillControl(page.getByTestId("participant-0-category"), String(shared.categoryId));
  await fillControl(page.getByTestId("participant-1-category"), String(shared.categoryId));
  await page.getByTestId("wizard-next").click();

  await fillParticipant(page, 0, { fullName: "Dara Sok", gender: "M", birthDate: "1990-05-01", idNo: `P${RUN}01`, phone: "+85512345678" });
  await fillParticipant(page, 1, { fullName: "Mealea Sok", gender: "F", birthDate: "1992-08-15", idNo: `P${RUN}02`, phone: "+85512345679" });
  await page.getByTestId("wizard-next").click();

  await page.getByTestId("coupon-input").fill(percentCode);
  await page.getByTestId("coupon-apply").click();
  await expect(page.getByTestId("quote-list-amount")).toContainText("$50.00");
  await expect(page.getByTestId("quote-discount")).toContainText("5.00");
  await expect(page.getByTestId("quote-amount")).toContainText("$45.00");
  const quoteCents = parseUsdCents(await page.getByTestId("quote-amount").innerText());

  await checkConsents(page);
  await page.getByTestId("order-submit").click();

  await expect(page).toHaveURL(/\/orders\/WR[0-9A-Z]{8}\/pay$/);
  shared.orderNo = (await page.getByTestId("pay-order-no").innerText()).trim();
  expect(shared.orderNo).toMatch(/^WR[0-9A-Z]{8}$/);
  expect(new URL(page.url()).pathname).toBe(`/orders/${shared.orderNo}/pay`);
  await expect(page.getByTestId("pay-qr")).toBeVisible();
  await expect(page.getByTestId("pay-countdown")).toBeVisible();

  shared.dueCents = parseUsdCents(await page.getByTestId("pay-amount").innerText());
  const identOffset = quoteCents - shared.dueCents;
  expect(identOffset).toBeGreaterThanOrEqual(1);
  expect(identOffset).toBeLessThanOrEqual(50);

  await page.getByTestId("pay-upload-link").click();
  await expect(page).toHaveURL(new RegExp(`/orders/${shared.orderNo}/proof$`));
  await uploadProof(page, `E2E${RUN}A`, makePng(0x112233));

  await context.close();
});

test("FINANCE 以 UNREADABLE 驳回凭证", async ({ browser }) => {
  const { context, page } = await adminSession(browser, FINANCE.username, FINANCE.password);

  await openSubmittedProof(page, shared.orderNo);
  await page.getByTestId("proof-reject-open").click();
  await selectAntdOption(page, "reject_rejectCode", "UNREADABLE");
  await page.locator("#reject_rejectReason").fill(rejectReason);
  await page.getByTestId("proof-reject-submit").click();
  await expect(page.getByTestId("proof-status")).toHaveAttribute("data-status", "REJECTED");

  await context.close();
});

test("跑者看到驳回原因并用新交易号重传", async ({ browser }) => {
  const { context, page } = await runnerPage(browser, runnerA, `/orders/${shared.orderNo}`);

  await expect(page.getByTestId("order-status")).toHaveAttribute("data-status", "PROOF_REJECTED");
  await expect(page.getByTestId("order-reject-reason")).toContainText(rejectReason);
  await page.getByTestId("order-reupload").click();
  await expect(page).toHaveURL(new RegExp(`/orders/${shared.orderNo}/proof$`));
  await uploadProof(page, `E2E${RUN}B`, makePng(0x445566));

  await context.close();
});

test("FINANCE 按应付金额通过", async ({ browser }) => {
  const { context, page } = await adminSession(browser, FINANCE.username, FINANCE.password);

  await openSubmittedProof(page, shared.orderNo);
  await page.getByTestId("proof-approve-open").click();
  await page.locator("#approve_receivedUsd").fill(centsToPlainUsd(shared.dueCents));
  await fillDate(page, "#approve_receivedAt", pickerNow());
  await page.getByTestId("proof-approve-submit").click();
  await expect(page.getByTestId("proof-status")).toHaveAttribute("data-status", "APPROVED");

  await context.close();
});

test("跑者订单显示已确认和参赛凭证", async ({ browser }) => {
  const { context, page } = await runnerPage(browser, runnerA, `/orders/${shared.orderNo}`);

  await expect(page.getByTestId("order-status")).toHaveAttribute("data-status", "PAID");
  await expect(page.getByTestId("order-ticket-qr").first()).toBeVisible();

  await openAsRunner(page, runnerA, "/orders");
  await expect(page.getByTestId(`order-item-${shared.orderNo}`)).toBeVisible();

  await context.close();
});

test("免单码下单直接显示已确认", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await runnerPage(browser, runnerB, `/events/${slug}`);

  await page.getByTestId("register-button").click();
  await expect(page).toHaveURL(new RegExp(`/events/${slug}/register`));
  await ensureParticipants(page, 1);
  await fillControl(page.getByTestId("participant-0-category"), String(shared.categoryId));
  await page.getByTestId("wizard-next").click();

  await fillParticipant(page, 0, { fullName: "Sophea Chan", gender: "F", birthDate: "1995-03-20", idNo: `P${RUN}03`, phone: "+85512345680" });
  await page.getByTestId("wizard-next").click();

  await page.getByTestId("coupon-input").fill(waiverCode);
  await page.getByTestId("coupon-apply").click();
  await expect(page.getByTestId("quote-amount")).toContainText("$0.00");
  await checkConsents(page);
  await page.getByTestId("order-submit").click();

  await page.waitForURL(/\/orders\/WR[0-9A-Z]{8}(\/pay)?$/);
  const match = /\/orders\/(WR[0-9A-Z]{8})/.exec(new URL(page.url()).pathname);
  expect(match).not.toBeNull();
  const waiverOrderNo = match![1]!;

  await openAsRunner(page, runnerB, `/orders/${waiverOrderNo}`);
  await expect(page.getByTestId("order-status")).toHaveAttribute("data-status", "PAID");
  await expect(page.getByTestId("order-ticket-qr").first()).toBeVisible();
  await expect(page.getByTestId("order-pay")).toHaveCount(0);

  await context.close();
});
```

- [ ] **Step 9：写免费报名用例 `e2e/tests/free-signup.spec.ts`（spec 14.4 第 3 条）**

```ts
import { expect, test } from "@playwright/test";
import { OPS } from "./env";
import { adminSession, createAndPublishEvent, openEventDetail, openRegistration, presetLanguage } from "./helpers";
import { openAsRunner, runnerUser } from "./runner";

const runId = Date.now().toString(36);
const slug = `e2e-free-${runId}`;
const eventName = {
  zh: `免费活动测试 ${runId}`,
  en: `Free Activity E2E ${runId}`,
  km: `សកម្មភាពឥតគិតថ្លៃសាកល្បង ${runId}`,
};
const phone = `+85516${String(Date.now()).slice(-6)}`;
const CONSENT_KEYS = ["rules", "health", "terms"] as const;
const runner = runnerUser("Chenda", "zh");
const shared = { categoryId: 0 };

test.describe.configure({ mode: "serial" });

async function fillFreeSignup(page: import("@playwright/test").Page, fullName: string): Promise<void> {
  await page.getByTestId("free-category").selectOption(String(shared.categoryId));
  await page.getByTestId("free-fullName").fill(fullName);
  await page.getByTestId("free-phone").fill(phone);
  await page.getByTestId("free-emergencyName").fill("Kim Sokha");
  await page.getByTestId("free-emergencyPhone").fill("+85598765432");
  await page.getByTestId("free-gender").selectOption("F");
  for (const key of CONSENT_KEYS) {
    await page.getByTestId(`consent-item-${key}`).check();
  }
}

test("OPS 建免费活动、发布并开放报名", async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page } = await adminSession(browser, OPS.username, OPS.password);

  await createAndPublishEvent(page, { slug, name: eventName, eventType: "FREE_ACTIVITY", capacity: 50 });
  const detail = await openEventDetail(page, slug);
  shared.categoryId = detail.categoryId;
  await openRegistration(page, detail.id);

  await context.close();
});

test("跑者免费报名成功；同名（大小写不同）同手机号再次报名提示已报名", async ({ browser }) => {
  const context = await browser.newContext();
  await presetLanguage(context, "zh");
  const page = await context.newPage();

  await openAsRunner(page, runner, `/events/${slug}`);
  await page.getByTestId("free-signup-button").click();
  await expect(page).toHaveURL(new RegExp(`/events/${slug}/free-signup$`));

  await fillFreeSignup(page, "Chenda Kim");
  await page.getByTestId("free-submit").click();
  await expect(page.getByTestId("free-signup-done")).toContainText(/FS[0-9A-Z]{8}/);

  await openAsRunner(page, runner, `/events/${slug}/free-signup`);
  await fillFreeSignup(page, "CHENDA KIM");
  await page.getByTestId("free-submit").click();

  const formError = page.getByTestId("form-error");
  await expect(formError).toHaveAttribute("data-code", "ALREADY_REGISTERED");
  await expect(formError).toHaveText("该姓名和手机号已报名这个组别");
  await expect(page.getByTestId("free-signup-done")).toHaveCount(0);

  await context.close();
});
```

Run: `pnpm --filter @werun/e2e typecheck`
Expected: 退出码 0。

- [ ] **Step 10：CI `.github/workflows/ci.yml` 的 e2e 任务**

Old（`e2e` 任务的 `env`）：

```yaml
    env:
      WERUN_USER_HOST: http://werun.localhost
      WERUN_ADMIN_HOST: http://admin.werun.localhost
      E2E_USER_URL: http://werun.localhost
      E2E_ADMIN_URL: http://admin.werun.localhost
```

New：

```yaml
    env:
      WERUN_USER_HOST: http://werun.localhost
      WERUN_ADMIN_HOST: http://admin.werun.localhost
      E2E_USER_URL: http://werun.localhost
      E2E_ADMIN_URL: http://admin.werun.localhost
      E2E_FINANCE_PASSWORD: e2e-Finance-Password-1
      E2E_TELEGRAM_BOT_TOKEN: "123456:e2e-test-token"
```

「Create .env with generated secrets」步骤整体替换为下面的最终内容（Task 1 若已在此步骤追加过 Telegram 变量，替换后只保留这一份）：

```yaml
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
            echo "WERUN_TELEGRAM_BOT_TOKEN=${E2E_TELEGRAM_BOT_TOKEN}"
            echo "WERUN_TELEGRAM_BOT_USERNAME=werun_e2e_bot"
            echo "WERUN_TELEGRAM_SEND=off"
            echo "WERUN_APP_BASE_URL=http://werun.localhost"
          } >> .env
```

（`.env.example` 里的同名变量在前、这里追加的在后；compose 读取 env 文件时后出现的值生效，两处取值本来也相同。）

Old：

```yaml
      - name: Seed test staff
        run: bash e2e/scripts/seed-staff.sh
```

New：

```yaml
      - name: Seed test staff
        run: bash e2e/scripts/seed-staff.sh

      - name: Seed registration consent
        run: bash e2e/scripts/seed-consent.sh
```

- [ ] **Step 11：`Makefile`**

Old：

```makefile
e2e-seed:
	bash e2e/scripts/seed-staff.sh
```

New：

```makefile
e2e-seed:
	bash e2e/scripts/seed-staff.sh
	bash e2e/scripts/seed-consent.sh
```

- [ ] **Step 12：本地起完整环境并播种**

先确认根目录 `.env` 带有总览 §11 的 Telegram 变量（Task 1 已写入 `.env.example`；旧的 `.env` 需要手动补）：

```bash
grep -E '^WERUN_(TELEGRAM_BOT_TOKEN|TELEGRAM_BOT_USERNAME|TELEGRAM_SEND|APP_BASE_URL)=' .env
```

Expected：四行，依次包含 `WERUN_TELEGRAM_BOT_TOKEN=123456:e2e-test-token`、`WERUN_TELEGRAM_BOT_USERNAME=werun_e2e_bot`、`WERUN_TELEGRAM_SEND=off`、`WERUN_APP_BASE_URL=http://werun.localhost`。缺哪行就把该行追加到 `.env`。

```bash
docker compose -f deploy/compose.yaml --env-file .env up -d --build --wait
bash e2e/scripts/seed-staff.sh
bash e2e/scripts/seed-consent.sh
bash e2e/scripts/seed-consent.sh
```

Expected：`up` 结束时 `postgres`、`api`、`caddy` 为 `Healthy`/`Started`，`migrate` 为 `Exited (0)`；`seed-staff.sh` 输出三行 `created …` 或 `skip …: already exists`，其中含 `finance.e2e (FINANCE)`；第一次 `seed-consent.sh` 输出 `published REG-E2E-v1 (zh)`、`(en)`、`(km)`；第二次输出三行 `skip REG-E2E-v1 (<lang>): already published`，退出码 0。

- [ ] **Step 13：运行端到端测试**

Run: `pnpm --filter @werun/e2e exec playwright install chromium && pnpm --filter @werun/e2e e2e`
Expected：`17 passed`（`publish-event.spec.ts` 3、`runner-auth.spec.ts` 3、`registration.spec.ts` 9、`free-signup.spec.ts` 2）。

失败时的排查顺序：`docker compose -f deploy/compose.yaml --env-file .env logs api --no-color | tail -200`；`runner-auth` 的第 1 条失败而第 2 条通过，说明 `.env` 的 `WERUN_TELEGRAM_BOT_TOKEN` 与 `E2E_TELEGRAM_BOT_TOKEN` 不一致；`registration.spec.ts` 卡在某个 `selectAntdOption`，用 `pnpm --filter @werun/e2e e2e --headed -g "<用例名>"` 观察下拉是否打开。

- [ ] **Step 14：全量检查**

```bash
pnpm --filter @werun/e2e typecheck
pnpm lint
docker compose -f deploy/compose.yaml --env-file .env down -v
```

Expected：`typecheck` 与 `lint` 退出码 0；`down -v` 删除容器与数据卷。推送后 CI 的 `Backend`、`Frontend`、`End-to-end` 三个任务全部通过，`End-to-end` 日志含 `Seed registration consent` 步骤与 `17 passed`。

- [ ] **Step 15：提交**

```bash
git add e2e/tests/env.ts e2e/tests/runner.ts e2e/tests/runner-auth.spec.ts e2e/tests/helpers.ts \
  e2e/tests/registration.spec.ts e2e/tests/free-signup.spec.ts \
  e2e/scripts/seed-staff.sh e2e/scripts/seed-consent.sh e2e/package.json \
  .github/workflows/ci.yml Makefile
git commit -m "$(cat <<'EOF'
test(e2e): 报名付款、凭证驳回重传与免费报名端到端测试

- runner.ts：按 Global Constraints 签名 initData，拦截 Telegram SDK 注入测试 WebApp
- registration.spec.ts：两人同单百分比优惠码 → 上传 → UNREADABLE 驳回 → 重传 → 通过 → 参赛凭证；免单码直接已确认
- free-signup.spec.ts：免费活动报名与重复报名提示
- 种子：finance.e2e 与 REG-E2E-v1 三语同意书；CI 播种同意书并传入 Telegram 变量

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
)"
```
