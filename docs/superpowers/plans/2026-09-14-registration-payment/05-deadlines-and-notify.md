# 第 5 段：超时与推送（Task 20–21）

> `00-overview.md` 的 Global Constraints、「与 spec 的实现调整」与「跨任务契约」对本文件每个任务都生效；下文使用的名字、签名、模板 key、River kind、dedupe key、审计 action 均以那里为准。本文件只在「契约补充」一节列出的地方做了增补。

**前置状态**：Task 1–19 已按 `00-overview.md` 完成，特别是：

- `jobs.Deps{Pool, Log, Sessions}`、`jobs.NewClient(d Deps)`、`jobs.NewInserter(pool)`（Task 1）；
- `App` 有 `Cfg`、`Log`、`Catalog`、`Pool`、`IAM`、`Events`、`Store`、`PII`、`Inserter`、`Runner`、`Pricing`、`Registration`、`Payment` 字段；`config.Config` 有 `TelegramBotToken`、`TelegramSend`、`AppBaseURL` 与 `TelegramSendEnabled()`（Task 1）；
- `registration.NewService(pool, runners, prices, now)`、`(*registration.Service).ReleaseOrder`（Task 12、13）；
- `payment.NewService(pool, files, orders, now)`（Task 15 之后的签名）、`ApproveProof` / `RejectProof`（Task 17，尚未推送）。

**执行前核对**（名字与下面不一致时，本文件代码中的调用点跟着改成实际名字，不改契约）：

```bash
cd api
grep -n "func NewClient\|func NewInserter\|type Deps struct" internal/jobs/*.go
grep -n "jobs.NewClient" cmd/werun/serve.go cmd/werun/worker.go          # 预期形如 jobs.NewClient(jobs.Deps{Pool: app.Pool, Log: app.Log, Sessions: app.IAM})
grep -n "app.Inserter\|app.Registration =\|app.Payment =" cmd/werun/app.go
grep -n "func (c Config) TelegramSendEnabled" internal/platform/config/config.go
grep -n "type Service struct" -A 8 internal/registration/service.go internal/payment/service.go   # 预期字段 pool、now（与 event.Service 一致）
grep -n "payment_proof.approve\|payment_proof.reject\|LockOrderByID\|MarkProofRejected" internal/payment/review.go
grep -rn "registration.NewService(\|payment.NewService(" --include=*.go .
grep -rn "NewService(" internal/registration/*_test.go internal/payment/*_test.go
```

---

## 契约补充

以下是 `00-overview.md` 契约没有写、但本段必须确定的内容，后续任务（Task 22–23）若用到须保持一致：

1. **`notify.Notification.Params` 的本地化取值**：`Enqueue` 渲染前按收件人 `users.locale` 处理参数——值为 `i18n.Text` 时取 `Text.In(lang)`；值为新类型 `notify.RejectReason{Code string; Note *string}` 时渲染为 `notify.reject_code.<Code>` 文案，`Note` 去掉首尾空白后非空则追加 `"\n" + Note`；其余值按 `fmt.Sprint`。原因：`eventName` 与驳回原因码文案必须使用跑者语言，而语言只有 `notify` 在事务里查 `users` 后才知道。
2. **`notify.FormatTime(t time.Time, timezone string) string`**：按时区格式化为 `2006-01-02 15:04`；时区为空或无法加载时用 `notify.DefaultTimezone = "Asia/Phnom_Penh"`。`payment` 与 `registration` 共用，保证推送里的时间格式一致。
3. **`notify` 的其他导出常量**：`SendMaxAttempts = 5`、`DefaultTelegramBaseURL = "https://api.telegram.org"`、`StatusPending/StatusSent/StatusFailed`；`SendArgs`、`Button` 的 JSON 字段名为 `log_id`、`chat_id`、`text`、`button`、`url`。
4. **`notification_logs` 列取值**：`recipient` = `users.telegram_user_id` 的十进制字符串；`locale` = `users.locale`（无法解析时用 `i18n.Default`）；`entity_type = 'reg_order'`、`entity_id = OrderID`。`Enqueue` 在 `Params["orderNo"]` 不是非空字符串时返回错误（按钮 URL 需要它）。`TelegramSender` 返回的 403 错误用 `%w` 包装 `ErrRecipientBlocked`（判断用 `errors.Is`）。
5. **测试支撑包**：
   - `internal/notify/notifytest`：`const AppBaseURL = "https://app.werun.test"`；`func New(t testing.TB, pool *pgxpool.Pool) *notify.Service`（只插入不执行的 River 客户端 + 内置文案目录）。不依赖 `jobs`，否则 `registration` 包内测试 → `notifytest` → `jobs` → `registration` 形成循环。
   - `internal/registration/regtest`：`Env`（已发布并开放报名的 RACE 赛事、一个组别、一个价格档、一个优惠码、一个收款账户、一版 REGISTRATION 同意书）与 `Clock`；供 `payment`、`registration`、后续端到端前的 Go 测试复用。原因：Task 20/21 的数据库测试需要真实订单，而 Task 12–17 的测试辅助函数不在契约里。
6. **`cmd/werun`**：`func newNotifySender(cfg config.Config, log *slog.Logger) notify.Sender` 与 `func (a *App) JobDeps() jobs.Deps`；`serve --with-worker` 与 `worker` 都调用 `jobs.NewClient(app.JobDeps())`，避免两处装配漂移。
7. **`ProcessDeadlines` 的 `reminded`**：本次新入队的提醒数。查询时已排除买家没有 `telegram_user_id` 的订单和同 `dedupe_key` 已登记的提醒，`Enqueue` 的唯一冲突跳过兜底并发。`order_expired` 推送参数只有 `orderNo`。

---

### Task 20: Telegram 推送（`notify` 包、发送任务、审核结果推送）

**Files:**
- Create: `api/internal/notify/model.go`
- Create: `api/internal/notify/sender.go`
- Create: `api/internal/notify/telegram.go`
- Create: `api/internal/notify/service.go`
- Create: `api/internal/notify/worker.go`
- Create: `api/internal/notify/notifytest/notifytest.go`
- Create: `api/db/queries/notify.sql`
- Create（生成）: `api/internal/notify/store/{db.go,models.go,notify.sql.go}`
- Create: `api/internal/registration/regtest/regtest.go`
- Create: `api/internal/payment/notifications.go`
- Test: `api/internal/notify/render_test.go`
- Test: `api/internal/notify/telegram_test.go`
- Test: `api/internal/notify/service_test.go`
- Test: `api/internal/notify/worker_test.go`
- Test: `api/internal/payment/review_notify_test.go`
- Test: `api/cmd/werun/app_notify_test.go`
- Modify: `api/sqlc.yaml`（加 notify 段）
- Modify: `api/internal/platform/i18n/messages.zh.json`、`messages.en.json`、`messages.km.json`
- Modify: `api/internal/jobs/jobs.go`、`api/internal/jobs/jobs_test.go`
- Modify: `api/db/queries/payment.sql`（追加一条查询）及生成的 `api/internal/payment/store/*`
- Modify: `api/internal/payment/service.go`（`NewService` 签名）、`api/internal/payment/review.go`（通过/驳回推送）
- Modify: `api/cmd/werun/app.go`、`api/cmd/werun/serve.go`、`api/cmd/werun/worker.go`、`api/cmd/werun/router.go`、`api/internal/httpapi/router.go`
- Modify: 所有调用 `payment.NewService(` 的现有测试文件（执行前核对里 grep 列出的文件）

**Interfaces:**
- Consumes:
  - `i18n.LoadCatalog() (*i18n.Catalog, error)`、`(*i18n.Catalog).T(l i18n.Lang, key string, params map[string]any) string`、`i18n.Parse`、`i18n.Text.In`
  - `db.InTx(ctx, pool, func(tx pgx.Tx) error) error`、`dbtest.NewPool(t)`、`logx.New(level, w)`
  - River v0.47.0（已在模块缓存核对）：`(*river.Client[TTx]).InsertTx(ctx, tx, args river.JobArgs, opts *river.InsertOpts) (*rivertype.JobInsertResult, error)`；`river.InsertOpts{MaxAttempts int}`；`river.JobCancel(err error) error` 返回 `*rivertype.JobCancelError`（`river.JobCancelError` 为别名），无论剩余次数都不再执行；`river.Job[T]` 嵌入 `*rivertype.JobRow`，其 `Attempt` 在执行时从 1 开始，`Attempt >= MaxAttempts` 时再报错会被丢弃（discarded）；`river.NewClient(driver, &river.Config{})` 不设 `Workers` 时为只插入客户端，且跳过未知 kind 校验
  - Telegram Bot API `sendMessage`：`POST https://api.telegram.org/bot<token>/sendMessage`，JSON 体 `chat_id`、`text`、`reply_markup`（`InlineKeyboardMarkup{inline_keyboard: [][]InlineKeyboardButton}`，按钮 `{text, web_app: {url}}`，仅私聊可用）；响应 `{"ok": bool, "error_code": int, "description": string}`；用户屏蔽机器人或未开始对话时 HTTP 403
  - `config.Config.TelegramSendEnabled() bool`、`TelegramBotToken`、`AppBaseURL`；`App.Inserter *river.Client[pgx.Tx]`
  - `runner.SignInitData`、`(*runner.Service).LoginTelegram`、`PublishConsent`；`registration.NewService(pool, runners, prices, now)`、`CreateOrder`；`payment.SubmitProof`、`ApproveProof`、`RejectProof`；`storage.NewDisk`；`piicrypt.New`；`pricing.NewService`；`iam.NewService(...).CreateStaff`
- Produces:
  - `notify.Template` 与四个常量、`notify.Notification`、`notify.JobInserter`、`notify.NewService(inserter JobInserter, cat *i18n.Catalog, appBaseURL string) *Service`、`(*Service).Enqueue(ctx, tx, n Notification) error`
  - `notify.Button`、`notify.Sender`、`notify.ErrRecipientBlocked`、`notify.NewTelegramSender(botToken, baseURL string, client *http.Client) *TelegramSender`、`notify.LogSender{Log}`
  - `notify.SendArgs{LogID, ChatID, Text, Button}`（`Kind() == "notify_send"`）、`notify.SendWorker{Pool, Sender, Log}`
  - 契约补充 1–6 列出的 `RejectReason`、`FormatTime`、常量、`notifytest`、`regtest`、`newNotifySender`、`App.JobDeps`
  - `jobs.Deps.Notify *notify.SendWorker`；`App.Notify *notify.Service`；`httpapi.RouterDeps.Notify *notify.Service`
  - `payment.NewService(pool *pgxpool.Pool, files storage.Store, orders *registration.Service, notifier *notify.Service, now func() time.Time) *Service`
  - 文案 key：`notify.proof_approved`、`notify.proof_rejected`、`notify.payment_deadline_reminder`、`notify.order_expired`、`notify.open_order`、`notify.reject_code.{NOT_RECEIVED,AMOUNT_MISMATCH,DUPLICATE_TXN,UNREADABLE,WRONG_ACCOUNT,FRAUD,OTHER}`

- [ ] **Step 1: 写模板渲染与文案的失败测试**

创建 `api/internal/notify/render_test.go`（包内测试，直接测未导出的 `render`）：

```go
package notify

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/i18n"
)

var allTemplates = []Template{
	TemplateProofApproved,
	TemplateProofRejected,
	TemplateDeadlineReminder,
	TemplateOrderExpired,
}

var allRejectCodes = []string{
	"NOT_RECEIVED", "AMOUNT_MISMATCH", "DUPLICATE_TXN", "UNREADABLE", "WRONG_ACCOUNT", "FRAUD", "OTHER",
}

var allLangs = []i18n.Lang{i18n.ZH, i18n.EN, i18n.KM}

func loadTestCatalog(t *testing.T) *i18n.Catalog {
	t.Helper()
	cat, err := i18n.LoadCatalog()
	require.NoError(t, err)
	return cat
}

func TestEveryTemplateRendersInAllLanguages(t *testing.T) {
	cat := loadTestCatalog(t)
	params := map[string]any{
		"orderNo":   "WR12345678",
		"eventName": i18n.Text{i18n.ZH: "金边城市跑", i18n.EN: "Phnom Penh City Run", i18n.KM: "ការរត់ទីក្រុងភ្នំពេញ"},
		"deadline":  "2026-09-15 10:00",
		"reason":    RejectReason{Code: "OTHER"},
	}

	for _, tpl := range allTemplates {
		key := "notify." + string(tpl)
		rendered := map[i18n.Lang]string{}
		for _, lang := range allLangs {
			text := render(cat, lang, tpl, params)
			require.NotEqual(t, key, text, "%s 缺少 %s", lang, key)
			require.Contains(t, text, "WR12345678", "%s %s 必须包含订单号", lang, key)
			require.NotContains(t, text, "{", "%s %s 有未替换的参数：%s", lang, key, text)
			require.NotContains(t, text, "}", "%s %s 有未替换的参数：%s", lang, key, text)
			rendered[lang] = text
		}
		require.NotEqual(t, rendered[i18n.ZH], rendered[i18n.EN], "%s 中英文不能相同", key)
		require.NotEqual(t, rendered[i18n.EN], rendered[i18n.KM], "%s 高棉文不能照抄英文", key)
	}
}

func TestRejectCodeAndButtonKeysExistInAllLanguages(t *testing.T) {
	cat := loadTestCatalog(t)
	keys := []string{"notify.open_order"}
	for _, code := range allRejectCodes {
		keys = append(keys, "notify.reject_code."+code)
	}
	for _, key := range keys {
		for _, lang := range allLangs {
			require.NotEqual(t, key, cat.T(lang, key, nil), "%s 缺少 %s", lang, key)
		}
	}
}

func TestRenderLocalizesTextAndRejectReason(t *testing.T) {
	cat := loadTestCatalog(t)
	note := "  Photo is blurry  "
	eventName := i18n.Text{i18n.ZH: "金边城市跑", i18n.EN: "Phnom Penh City Run", i18n.KM: "ការរត់ទីក្រុងភ្នំពេញ"}

	en := render(cat, i18n.EN, TemplateProofRejected, map[string]any{
		"orderNo":   "WR12345678",
		"eventName": eventName,
		"reason":    RejectReason{Code: "UNREADABLE", Note: &note},
		"deadline":  "2026-09-15 10:00",
	})
	require.Equal(t,
		"Payment proof not accepted\nEvent: Phnom Penh City Run\nOrder: WR12345678\nReason: Screenshot is unreadable\nPhoto is blurry\nPlease upload a new proof before 2026-09-15 10:00, otherwise the order will be cancelled automatically.",
		en)

	zh := render(cat, i18n.ZH, TemplateProofRejected, map[string]any{
		"orderNo":   "WR12345678",
		"eventName": eventName,
		"reason":    RejectReason{Code: "NOT_RECEIVED"},
		"deadline":  "2026-09-15 10:00",
	})
	require.Contains(t, zh, "赛事：金边城市跑\n")
	require.Contains(t, zh, "原因：未查到到账记录\n请在 2026-09-15 10:00 前")
}

func TestFormatTimeUsesEventTimezone(t *testing.T) {
	at := time.Date(2026, 9, 15, 3, 0, 0, 0, time.UTC)

	require.Equal(t, "2026-09-15 10:00", FormatTime(at, "Asia/Phnom_Penh"))
	require.Equal(t, "2026-09-15 03:00", FormatTime(at, "UTC"))
	require.Equal(t, "2026-09-15 10:00", FormatTime(at, ""), "空时区用 Asia/Phnom_Penh")
	require.Equal(t, "2026-09-15 10:00", FormatTime(at, "Not/AZone"), "无效时区用 Asia/Phnom_Penh")
}

func TestSendArgsKind(t *testing.T) {
	require.Equal(t, "notify_send", SendArgs{}.Kind())
	require.Equal(t, 5, SendMaxAttempts)
}
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd api && go test ./internal/notify/ -run 'TestEveryTemplate|TestRejectCode|TestRenderLocalizes|TestFormatTime|TestSendArgsKind' -v`
Expected: 编译失败，报 `no non-test Go files in .../internal/notify` 或 `undefined: Template`、`undefined: render`、`undefined: RejectReason`、`undefined: FormatTime`。

- [ ] **Step 3: 加推送文案（三语）**

三个文件都是扁平 JSON 对象。在各自**最后一个键值对**后面追加下面的键（给原最后一行末尾补逗号，保持文件仍是合法 JSON；键顺序不影响加载）。

`api/internal/platform/i18n/messages.zh.json` 追加：

```json
  "notify.proof_approved": "付款已确认\n赛事：{eventName}\n订单号：{orderNo}\n报名已生效，打开订单即可查看参赛凭证。",
  "notify.proof_rejected": "付款凭证未通过审核\n赛事：{eventName}\n订单号：{orderNo}\n原因：{reason}\n请在 {deadline} 前重新上传凭证，逾期订单将自动取消。",
  "notify.payment_deadline_reminder": "订单 {orderNo} 的付款截止时间为 {deadline}，请尽快完成转账并上传付款凭证，逾期名额将自动释放。",
  "notify.order_expired": "订单 {orderNo} 未在期限内完成付款，已自动取消，名额已释放。如仍想参加，请重新报名。",
  "notify.open_order": "查看订单",
  "notify.reject_code.NOT_RECEIVED": "未查到到账记录",
  "notify.reject_code.AMOUNT_MISMATCH": "转账金额与应付金额不符",
  "notify.reject_code.DUPLICATE_TXN": "交易号已被使用",
  "notify.reject_code.UNREADABLE": "截图无法辨认",
  "notify.reject_code.WRONG_ACCOUNT": "转入的收款账户不正确",
  "notify.reject_code.FRAUD": "凭证信息无法核实",
  "notify.reject_code.OTHER": "其他原因"
```

`api/internal/platform/i18n/messages.en.json` 追加：

```json
  "notify.proof_approved": "Payment confirmed\nEvent: {eventName}\nOrder: {orderNo}\nYour registration is confirmed. Open the order to see your race ticket.",
  "notify.proof_rejected": "Payment proof not accepted\nEvent: {eventName}\nOrder: {orderNo}\nReason: {reason}\nPlease upload a new proof before {deadline}, otherwise the order will be cancelled automatically.",
  "notify.payment_deadline_reminder": "Order {orderNo}: payment is due by {deadline}. Please complete the transfer and upload your payment proof, otherwise your spot will be released.",
  "notify.order_expired": "Order {orderNo} was not paid in time and has been cancelled. Your spot has been released. Please register again if you still want to take part.",
  "notify.open_order": "View order",
  "notify.reject_code.NOT_RECEIVED": "Payment not received",
  "notify.reject_code.AMOUNT_MISMATCH": "Amount does not match the amount due",
  "notify.reject_code.DUPLICATE_TXN": "Transaction reference already used",
  "notify.reject_code.UNREADABLE": "Screenshot is unreadable",
  "notify.reject_code.WRONG_ACCOUNT": "Paid to the wrong account",
  "notify.reject_code.FRAUD": "Proof could not be verified",
  "notify.reject_code.OTHER": "Other reason"
```

`api/internal/platform/i18n/messages.km.json` 追加：

```json
  "notify.proof_approved": "ការបង់ប្រាក់ត្រូវបានបញ្ជាក់\nព្រឹត្តិការណ៍៖ {eventName}\nលេខបញ្ជាទិញ៖ {orderNo}\nការចុះឈ្មោះរបស់អ្នកត្រូវបានបញ្ជាក់ហើយ។ សូមបើកការបញ្ជាទិញដើម្បីមើលប័ណ្ណចូលរួម។",
  "notify.proof_rejected": "ភស្តុតាងបង់ប្រាក់មិនត្រូវបានទទួលយកទេ\nព្រឹត្តិការណ៍៖ {eventName}\nលេខបញ្ជាទិញ៖ {orderNo}\nមូលហេតុ៖ {reason}\nសូមផ្ទុកឡើងភស្តុតាងថ្មីមុន {deadline} បើមិនដូច្នោះទេ ការបញ្ជាទិញនឹងត្រូវលុបចោលដោយស្វ័យប្រវត្តិ។",
  "notify.payment_deadline_reminder": "ការបញ្ជាទិញ {orderNo} ត្រូវបង់ប្រាក់មុន {deadline}។ សូមផ្ទេរប្រាក់ ហើយផ្ទុកឡើងភស្តុតាងបង់ប្រាក់ឱ្យបានឆាប់ បើមិនដូច្នោះទេ កន្លែងរបស់អ្នកនឹងត្រូវដោះលែង។",
  "notify.order_expired": "ការបញ្ជាទិញ {orderNo} មិនបានបង់ប្រាក់ទាន់ពេលកំណត់ ហើយត្រូវបានលុបចោលដោយស្វ័យប្រវត្តិ។ កន្លែងរបស់អ្នកត្រូវបានដោះលែងហើយ។ ប្រសិនបើអ្នកនៅតែចង់ចូលរួម សូមចុះឈ្មោះម្តងទៀត។",
  "notify.open_order": "មើលការបញ្ជាទិញ",
  "notify.reject_code.NOT_RECEIVED": "មិនទាន់ទទួលបានប្រាក់",
  "notify.reject_code.AMOUNT_MISMATCH": "ចំនួនទឹកប្រាក់មិនត្រូវនឹងចំនួនដែលត្រូវបង់",
  "notify.reject_code.DUPLICATE_TXN": "លេខប្រតិបត្តិការត្រូវបានប្រើរួចហើយ",
  "notify.reject_code.UNREADABLE": "រូបថតអេក្រង់មើលមិនច្បាស់",
  "notify.reject_code.WRONG_ACCOUNT": "បានផ្ទេរទៅគណនីខុស",
  "notify.reject_code.FRAUD": "មិនអាចផ្ទៀងផ្ទាត់ភស្តុតាងបានទេ",
  "notify.reject_code.OTHER": "មូលហេតុផ្សេងទៀត"
```

- [ ] **Step 4: 实现模型与渲染**

创建 `api/internal/notify/model.go`：

```go
// Package notify 负责推送：登记 notification_logs、按跑者语言渲染模板、入队并执行 Telegram 发送任务。
package notify

import (
	"context"
	"fmt"
	"strings"
	"time"
	_ "time/tzdata" // 运行镜像不一定带时区库

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"

	"werun/api/internal/platform/i18n"
)

// Template 是推送模板名；文案 key 为 "notify.<Template>"。
type Template string

const (
	TemplateProofApproved    Template = "proof_approved"
	TemplateProofRejected    Template = "proof_rejected"
	TemplateDeadlineReminder Template = "payment_deadline_reminder"
	TemplateOrderExpired     Template = "order_expired"
)

// notification_logs.status 的取值。
const (
	StatusPending = "PENDING"
	StatusSent    = "SENT"
	StatusFailed  = "FAILED"
)

// SendMaxAttempts 是 notify_send 任务的最大尝试次数（含第一次）。
const SendMaxAttempts = 5

// DefaultTimezone 是赛事时区为空或无效时使用的时区。
const DefaultTimezone = "Asia/Phnom_Penh"

// Notification 是一条待登记的推送。
type Notification struct {
	Template  Template
	UserID    int64
	OrderID   int64
	ProofID   *int64
	DedupeKey string         // 空串时用 "<template>:<orderId>:<proofId 或 0>"
	Params    map[string]any // 文案参数：orderNo（必填）、deadline、reason、eventName
}

// JobInserter 是 notify 需要的最小 River 能力；*river.Client[pgx.Tx] 实现了它。
type JobInserter interface {
	InsertTx(ctx context.Context, tx pgx.Tx, args river.JobArgs, opts *river.InsertOpts) (*rivertype.JobInsertResult, error)
}

// RejectReason 作为 Params 的值时，按收件人语言渲染为原因码文案，Note 非空时换行追加说明。
type RejectReason struct {
	Code string
	Note *string
}

// SendArgs 是 notify_send 任务参数。文本在入队时已按收件人语言渲染好。
type SendArgs struct {
	LogID  int64   `json:"log_id"`
	ChatID int64   `json:"chat_id"`
	Text   string  `json:"text"`
	Button *Button `json:"button,omitempty"`
}

// Kind 是 River 任务类型名。
func (SendArgs) Kind() string { return "notify_send" }

// FormatTime 把时间按时区格式化为 YYYY-MM-DD HH:mm；时区为空或无法加载时用 Asia/Phnom_Penh。
func FormatTime(t time.Time, timezone string) string {
	loc := defaultLocation()
	if timezone != "" {
		if l, err := time.LoadLocation(timezone); err == nil {
			loc = l
		}
	}
	return t.In(loc).Format("2006-01-02 15:04")
}

func defaultLocation() *time.Location {
	loc, err := time.LoadLocation(DefaultTimezone)
	if err != nil {
		return time.UTC
	}
	return loc
}

// render 用收件人语言渲染模板正文。
func render(cat *i18n.Catalog, lang i18n.Lang, tpl Template, params map[string]any) string {
	return cat.T(lang, "notify."+string(tpl), localizeParams(cat, lang, params))
}

func localizeParams(cat *i18n.Catalog, lang i18n.Lang, params map[string]any) map[string]any {
	if params == nil {
		return nil
	}
	out := make(map[string]any, len(params))
	for name, value := range params {
		switch v := value.(type) {
		case i18n.Text:
			out[name] = v.In(lang)
		case RejectReason:
			text := cat.T(lang, "notify.reject_code."+v.Code, nil)
			if v.Note != nil {
				if note := strings.TrimSpace(*v.Note); note != "" {
					text += "\n" + note
				}
			}
			out[name] = text
		default:
			out[name] = fmt.Sprint(v)
		}
	}
	return out
}
```

创建 `api/internal/notify/sender.go`（`SendArgs` 引用了 `Button`，与模型同一步建好才能编译）：

```go
package notify

import (
	"context"
	"errors"
	"log/slog"
)

// Button 是消息下方的按钮：点击后在 Telegram 内打开小程序页面。
type Button struct {
	Text string `json:"text"`
	URL  string `json:"url"`
}

// Sender 发送一条 Telegram 私信。
type Sender interface {
	Send(ctx context.Context, chatID int64, text string, button *Button) error
}

// ErrRecipientBlocked 表示跑者屏蔽了机器人或从未与机器人对话（Telegram 返回 403）。
// 发送实现用 %w 包装它，调用方用 errors.Is 判断。
var ErrRecipientBlocked = errors.New("notify: recipient blocked the bot")

// LogSender 在 WERUN_TELEGRAM_SEND=off 时使用：只写日志，不调用 Telegram。
type LogSender struct{ Log *slog.Logger }

// Send 记录一条日志并返回 nil。
func (s LogSender) Send(ctx context.Context, chatID int64, text string, button *Button) error {
	attrs := []any{"chat_id", chatID, "text", text}
	if button != nil {
		attrs = append(attrs, "button_text", button.Text, "button_url", button.URL)
	}
	s.Log.InfoContext(ctx, "telegram send disabled; notification logged only", attrs...)
	return nil
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `cd api && go test ./internal/notify/ -run 'TestEveryTemplate|TestRejectCode|TestRenderLocalizes|TestFormatTime|TestSendArgsKind' -v && go test ./internal/platform/i18n/`
Expected: 5 个测试 PASS；`ok  werun/api/internal/platform/i18n`（三语 key 集合一致）。

- [ ] **Step 6: 写 TelegramSender 的失败测试**

创建 `api/internal/notify/telegram_test.go`：

```go
package notify_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"werun/api/internal/notify"
	"werun/api/internal/platform/logx"
)

const testBotToken = "123456:test-token"

type capturedRequest struct {
	method      string
	path        string
	contentType string
	body        []byte
}

func telegramServer(t *testing.T, status int, response string) (*httptest.Server, <-chan capturedRequest) {
	t.Helper()
	captured := make(chan capturedRequest, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		captured <- capturedRequest{method: r.Method, path: r.URL.Path, contentType: r.Header.Get("Content-Type"), body: body}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, response)
	}))
	t.Cleanup(srv.Close)
	return srv, captured
}

func TestTelegramSenderSendsMessageWithWebAppButton(t *testing.T) {
	srv, captured := telegramServer(t, http.StatusOK, `{"ok":true,"result":{"message_id":1}}`)
	sender := notify.NewTelegramSender(testBotToken, srv.URL, srv.Client())

	err := sender.Send(context.Background(), 42, "hello", &notify.Button{Text: "View order", URL: "https://app.werun.test/orders/WR1"})

	require.NoError(t, err)
	req := <-captured
	require.Equal(t, http.MethodPost, req.method)
	require.Equal(t, "/bot"+testBotToken+"/sendMessage", req.path)
	require.Equal(t, "application/json", req.contentType)
	require.JSONEq(t, `{
		"chat_id": 42,
		"text": "hello",
		"reply_markup": {"inline_keyboard": [[{"text": "View order", "web_app": {"url": "https://app.werun.test/orders/WR1"}}]]}
	}`, string(req.body))
}

func TestTelegramSenderOmitsReplyMarkupWithoutButton(t *testing.T) {
	srv, captured := telegramServer(t, http.StatusOK, `{"ok":true,"result":{}}`)
	sender := notify.NewTelegramSender(testBotToken, srv.URL, srv.Client())

	require.NoError(t, sender.Send(context.Background(), 42, "hello", nil))

	require.JSONEq(t, `{"chat_id": 42, "text": "hello"}`, string((<-captured).body))
}

func TestTelegramSenderForbiddenIsRecipientBlocked(t *testing.T) {
	srv, _ := telegramServer(t, http.StatusForbidden, `{"ok":false,"error_code":403,"description":"Forbidden: bot was blocked by the user"}`)
	sender := notify.NewTelegramSender(testBotToken, srv.URL, srv.Client())

	err := sender.Send(context.Background(), 42, "hello", nil)

	require.ErrorIs(t, err, notify.ErrRecipientBlocked)
	require.ErrorContains(t, err, "Forbidden: bot was blocked by the user")
}

func TestTelegramSenderBadRequestReturnsDescription(t *testing.T) {
	srv, _ := telegramServer(t, http.StatusBadRequest, `{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}`)
	sender := notify.NewTelegramSender(testBotToken, srv.URL, srv.Client())

	err := sender.Send(context.Background(), 42, "hello", nil)

	require.Error(t, err)
	require.NotErrorIs(t, err, notify.ErrRecipientBlocked)
	require.ErrorContains(t, err, "status 400")
	require.ErrorContains(t, err, "Bad Request: chat not found")
}

func TestTelegramSenderOKFalseIsError(t *testing.T) {
	srv, _ := telegramServer(t, http.StatusOK, `{"ok":false,"description":"Bad Request: message text is empty"}`)
	sender := notify.NewTelegramSender(testBotToken, srv.URL, srv.Client())

	err := sender.Send(context.Background(), 42, "", nil)

	require.ErrorContains(t, err, "Bad Request: message text is empty")
}

func TestTelegramSenderNetworkErrorDoesNotLeakToken(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	baseURL := srv.URL
	srv.Close()
	sender := notify.NewTelegramSender(testBotToken, baseURL, nil)

	err := sender.Send(context.Background(), 42, "hello", nil)

	require.Error(t, err)
	require.NotContains(t, err.Error(), testBotToken)
}

func TestLogSenderNeverFails(t *testing.T) {
	sender := notify.LogSender{Log: logx.New("error", io.Discard)}

	require.NoError(t, sender.Send(context.Background(), 42, "hello", &notify.Button{Text: "View order", URL: "https://x"}))
}
```

- [ ] **Step 7: 运行测试，确认失败**

Run: `cd api && go test ./internal/notify/ -run 'TestTelegramSender|TestLogSender' -v`
Expected: 编译失败，报 `undefined: notify.NewTelegramSender`。

- [ ] **Step 8: 实现 TelegramSender**

创建 `api/internal/notify/telegram.go`：

```go
package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// DefaultTelegramBaseURL 是 Telegram Bot API 地址。
const DefaultTelegramBaseURL = "https://api.telegram.org"

// TelegramSender 通过 Bot API sendMessage 发送私信。
type TelegramSender struct {
	token   string
	baseURL string
	client  *http.Client
}

// NewTelegramSender 创建发送器；baseURL 为空时用 DefaultTelegramBaseURL，client 为 nil 时用 10 秒超时的客户端。
func NewTelegramSender(botToken, baseURL string, client *http.Client) *TelegramSender {
	if baseURL == "" {
		baseURL = DefaultTelegramBaseURL
	}
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	return &TelegramSender{token: botToken, baseURL: strings.TrimRight(baseURL, "/"), client: client}
}

type sendMessageRequest struct {
	ChatID      int64                 `json:"chat_id"`
	Text        string                `json:"text"`
	ReplyMarkup *inlineKeyboardMarkup `json:"reply_markup,omitempty"`
}

type inlineKeyboardMarkup struct {
	InlineKeyboard [][]inlineKeyboardButton `json:"inline_keyboard"`
}

type inlineKeyboardButton struct {
	Text   string     `json:"text"`
	WebApp webAppInfo `json:"web_app"`
}

type webAppInfo struct {
	URL string `json:"url"`
}

type apiResponse struct {
	OK          bool   `json:"ok"`
	ErrorCode   int    `json:"error_code"`
	Description string `json:"description"`
}

// Send 调用 sendMessage。403 返回包装了 ErrRecipientBlocked 的错误；其他非 2xx 或 ok=false 返回带 description 的错误。
func (s *TelegramSender) Send(ctx context.Context, chatID int64, text string, button *Button) error {
	body := sendMessageRequest{ChatID: chatID, Text: text}
	if button != nil {
		body.ReplyMarkup = &inlineKeyboardMarkup{InlineKeyboard: [][]inlineKeyboardButton{{
			{Text: button.Text, WebApp: webAppInfo{URL: button.URL}},
		}}}
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("telegram sendMessage: encode request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.baseURL+"/bot"+s.token+"/sendMessage", bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("telegram sendMessage: build request: %w", s.redact(err))
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("telegram sendMessage: %w", s.redact(err))
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return fmt.Errorf("telegram sendMessage: read response (status %d): %w", resp.StatusCode, err)
	}
	var out apiResponse
	_ = json.Unmarshal(raw, &out) // 解析失败时 out.OK 为 false，下面按错误处理
	description := out.Description
	if description == "" {
		description = strings.TrimSpace(string(raw))
		if len(description) > 200 {
			description = description[:200]
		}
		description = strings.ToValidUTF8(description, "")
	}

	if resp.StatusCode == http.StatusForbidden {
		return fmt.Errorf("%w: %s", ErrRecipientBlocked, description)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 || !out.OK {
		return fmt.Errorf("telegram sendMessage: status %d: %s", resp.StatusCode, description)
	}
	return nil
}

// redact 去掉错误信息里的机器人 token（*url.Error 会带上完整 URL）。
func (s *TelegramSender) redact(err error) error {
	if s.token == "" {
		return err
	}
	return errors.New(strings.ReplaceAll(err.Error(), s.token, "<redacted>"))
}
```

- [ ] **Step 9: 运行测试，确认通过**

Run: `cd api && go test ./internal/notify/ -run 'TestTelegramSender|TestLogSender' -v`
Expected: 7 个测试全部 PASS。

- [ ] **Step 10: 写 notify 的查询并生成代码**

创建 `api/db/queries/notify.sql`：

```sql
-- name: GetNotifyRecipient :one
SELECT telegram_user_id, locale
FROM users
WHERE id = @id;

-- name: InsertNotificationLog :one
INSERT INTO notification_logs (channel, recipient, template, locale, entity_type, entity_id, dedupe_key)
VALUES ('TELEGRAM', @recipient, @template, @locale, 'reg_order', @entity_id, @dedupe_key)
ON CONFLICT (dedupe_key) DO NOTHING
RETURNING id;

-- name: GetNotificationLog :one
SELECT id, status, attempts
FROM notification_logs
WHERE id = @id;

-- name: MarkNotificationSent :exec
UPDATE notification_logs
SET status = 'SENT', sent_at = @sent_at, attempts = attempts + 1, last_error = NULL
WHERE id = @id;

-- name: MarkNotificationAttemptFailed :exec
UPDATE notification_logs
SET status = @status, attempts = attempts + 1, last_error = @last_error
WHERE id = @id;
```

在 `api/sqlc.yaml` 的 `sql:` 列表末尾追加（与 `iam`、`event` 段的 `gen.go` 完全相同）：

```yaml
  - engine: postgresql
    schema: db/migrations
    queries: db/queries/notify.sql
    gen:
      go:
        package: store
        out: internal/notify/store
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

Run: `make gen && cd api && go build ./internal/notify/... && grep -n "func (q \*Queries)" internal/notify/store/notify.sql.go`
Expected: 生成 `internal/notify/store/{db.go,models.go,notify.sql.go}`，编译通过；grep 列出 5 个方法，签名为：
`GetNotifyRecipient(ctx, id int64) (GetNotifyRecipientRow, error)`（字段 `TelegramUserID *int64`、`Locale string`）、
`InsertNotificationLog(ctx, arg InsertNotificationLogParams) (int64, error)`（字段 `Recipient`、`Template`、`Locale string`、`EntityID *int64`、`DedupeKey string`）、
`GetNotificationLog(ctx, id int64) (GetNotificationLogRow, error)`（字段 `ID int64`、`Status string`、`Attempts int16`）、
`MarkNotificationSent(ctx, arg MarkNotificationSentParams) error`（字段 `SentAt *time.Time`、`ID int64`）、
`MarkNotificationAttemptFailed(ctx, arg MarkNotificationAttemptFailedParams) error`（字段 `Status string`、`LastError *string`、`ID int64`）。
字段名或指针形态与此不同时，下面 service.go / worker.go 按生成结果调整字段访问。

- [ ] **Step 11: 写 Enqueue 的失败测试（数据库）**

创建 `api/internal/notify/service_test.go`：

```go
package notify_test

import (
	"context"
	"errors"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"werun/api/internal/notify"
	"werun/api/internal/notify/notifytest"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/i18n"
)

const expiredTextEN = "Order WR0000TEST was not paid in time and has been cancelled. Your spot has been released. Please register again if you still want to take part."

func insertTelegramUser(t *testing.T, pool *pgxpool.Pool, telegramID int64, locale string) int64 {
	t.Helper()
	var id int64
	require.NoError(t, pool.QueryRow(context.Background(),
		`INSERT INTO users (telegram_user_id, display_name, locale) VALUES ($1, 'Runner', $2) RETURNING id`,
		telegramID, locale).Scan(&id))
	return id
}

func countNotifyRows(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	require.NoError(t, pool.QueryRow(context.Background(), sql, args...).Scan(&n))
	return n
}

func enqueueInTx(t *testing.T, pool *pgxpool.Pool, svc *notify.Service, n notify.Notification) {
	t.Helper()
	require.NoError(t, db.InTx(context.Background(), pool, func(tx pgx.Tx) error {
		return svc.Enqueue(context.Background(), tx, n)
	}))
}

func TestEnqueueWritesLogAndSendJob(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := notifytest.New(t, pool)
	userID := insertTelegramUser(t, pool, 555001, "en")
	ctx := context.Background()

	enqueueInTx(t, pool, svc, notify.Notification{
		Template: notify.TemplateOrderExpired,
		UserID:   userID,
		OrderID:  77,
		Params:   map[string]any{"orderNo": "WR0000TEST"},
	})

	var (
		logID                                                        int64
		channel, recipient, template, locale, entityType, key, status string
		entityID                                                     int64
		attempts                                                     int16
	)
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT id, channel, recipient, template, locale, entity_type, entity_id, dedupe_key, status, attempts
		FROM notification_logs`).Scan(&logID, &channel, &recipient, &template, &locale, &entityType, &entityID, &key, &status, &attempts))
	require.Equal(t, "TELEGRAM", channel)
	require.Equal(t, "555001", recipient)
	require.Equal(t, "order_expired", template)
	require.Equal(t, "en", locale)
	require.Equal(t, "reg_order", entityType)
	require.Equal(t, int64(77), entityID)
	require.Equal(t, "order_expired:77:0", key)
	require.Equal(t, "PENDING", status)
	require.Equal(t, int16(0), attempts)

	var (
		kind        string
		maxAttempts int
		args        []byte
	)
	require.NoError(t, pool.QueryRow(ctx, `SELECT kind, max_attempts, args FROM river_job`).Scan(&kind, &maxAttempts, &args))
	require.Equal(t, "notify_send", kind)
	require.Equal(t, 5, maxAttempts)
	require.JSONEq(t, `{
		"log_id": `+strconv.FormatInt(logID, 10)+`,
		"chat_id": 555001,
		"text": "`+expiredTextEN+`",
		"button": {"text": "View order", "url": "https://app.werun.test/orders/WR0000TEST"}
	}`, string(args))
}

func TestEnqueueSameDedupeKeyTwiceInsertsOnce(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := notifytest.New(t, pool)
	userID := insertTelegramUser(t, pool, 555002, "zh")
	proofID := int64(9)
	n := notify.Notification{
		Template: notify.TemplateProofApproved,
		UserID:   userID,
		OrderID:  77,
		ProofID:  &proofID,
		Params: map[string]any{
			"orderNo":   "WR0000TEST",
			"eventName": i18n.Text{i18n.ZH: "金边城市跑", i18n.EN: "Phnom Penh City Run"},
		},
	}

	enqueueInTx(t, pool, svc, n)
	enqueueInTx(t, pool, svc, n)

	require.Equal(t, 1, countNotifyRows(t, pool, `SELECT count(*) FROM notification_logs WHERE dedupe_key = 'proof_approved:77:9'`))
	require.Equal(t, 1, countNotifyRows(t, pool, `SELECT count(*) FROM notification_logs`))
	require.Equal(t, 1, countNotifyRows(t, pool, `SELECT count(*) FROM river_job WHERE kind = 'notify_send'`))
	require.Equal(t, 1, countNotifyRows(t, pool,
		`SELECT count(*) FROM river_job WHERE args->>'text' = $1`,
		"付款已确认\n赛事：金边城市跑\n订单号：WR0000TEST\n报名已生效，打开订单即可查看参赛凭证。"))
}

func TestEnqueueHonorsExplicitDedupeKey(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := notifytest.New(t, pool)
	userID := insertTelegramUser(t, pool, 555003, "en")
	reminder := func(key string) notify.Notification {
		return notify.Notification{
			Template:  notify.TemplateDeadlineReminder,
			UserID:    userID,
			OrderID:   77,
			DedupeKey: key,
			Params:    map[string]any{"orderNo": "WR0000TEST", "deadline": "2026-09-15 10:00"},
		}
	}

	enqueueInTx(t, pool, svc, reminder("reminder:77:1789441200"))
	enqueueInTx(t, pool, svc, reminder("reminder:77:1789441200"))
	enqueueInTx(t, pool, svc, reminder("reminder:77:1789527600"))

	require.Equal(t, 2, countNotifyRows(t, pool, `SELECT count(*) FROM notification_logs WHERE template = 'payment_deadline_reminder'`))
	require.Equal(t, 1, countNotifyRows(t, pool, `SELECT count(*) FROM notification_logs WHERE dedupe_key = 'reminder:77:1789441200'`))
	require.Equal(t, 2, countNotifyRows(t, pool, `SELECT count(*) FROM river_job WHERE kind = 'notify_send'`))
}

func TestEnqueueSkipsUserWithoutTelegram(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := notifytest.New(t, pool)
	var userID int64
	require.NoError(t, pool.QueryRow(context.Background(),
		`INSERT INTO users (phone_e164, locale) VALUES ('+85510000001', 'en') RETURNING id`).Scan(&userID))

	enqueueInTx(t, pool, svc, notify.Notification{
		Template: notify.TemplateOrderExpired,
		UserID:   userID,
		OrderID:  77,
		Params:   map[string]any{"orderNo": "WR0000TEST"},
	})

	require.Equal(t, 0, countNotifyRows(t, pool, `SELECT count(*) FROM notification_logs`))
	require.Equal(t, 0, countNotifyRows(t, pool, `SELECT count(*) FROM river_job`))
}

func TestEnqueueRollsBackWithCallerTransaction(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := notifytest.New(t, pool)
	userID := insertTelegramUser(t, pool, 555004, "en")
	boom := errors.New("boom")

	err := db.InTx(context.Background(), pool, func(tx pgx.Tx) error {
		if err := svc.Enqueue(context.Background(), tx, notify.Notification{
			Template: notify.TemplateOrderExpired, UserID: userID, OrderID: 77,
			Params: map[string]any{"orderNo": "WR0000TEST"},
		}); err != nil {
			return err
		}
		return boom
	})

	require.ErrorIs(t, err, boom)
	require.Equal(t, 0, countNotifyRows(t, pool, `SELECT count(*) FROM notification_logs`))
	require.Equal(t, 0, countNotifyRows(t, pool, `SELECT count(*) FROM river_job`))
}

func TestEnqueueUsesRecipientLocaleForButton(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := notifytest.New(t, pool)
	userID := insertTelegramUser(t, pool, 555005, "km")

	enqueueInTx(t, pool, svc, notify.Notification{
		Template: notify.TemplateOrderExpired, UserID: userID, OrderID: 78,
		Params: map[string]any{"orderNo": "WR0000KM01"},
	})

	require.Equal(t, 1, countNotifyRows(t, pool, `SELECT count(*) FROM notification_logs WHERE locale = 'km'`))
	require.Equal(t, 1, countNotifyRows(t, pool,
		`SELECT count(*) FROM river_job WHERE args->'button'->>'text' = 'មើលការបញ្ជាទិញ'`))
}

func TestEnqueueRequiresOrderNo(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := notifytest.New(t, pool)
	userID := insertTelegramUser(t, pool, 555006, "en")

	err := db.InTx(context.Background(), pool, func(tx pgx.Tx) error {
		return svc.Enqueue(context.Background(), tx, notify.Notification{
			Template: notify.TemplateOrderExpired, UserID: userID, OrderID: 79,
		})
	})

	require.ErrorContains(t, err, "orderNo")
	require.Equal(t, 0, countNotifyRows(t, pool, `SELECT count(*) FROM notification_logs`))
}
```

- [ ] **Step 12: 运行测试，确认失败**

Run: `cd api && DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true go test ./internal/notify/ -run TestEnqueue -v`（非 colima 环境去掉前两个环境变量）
Expected: 编译失败，报 `no non-test Go files in .../internal/notify/notifytest`、`undefined: notify.Service`。

- [ ] **Step 13: 实现 Service 与 notifytest**

创建 `api/internal/notify/service.go`：

```go
package notify

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"werun/api/internal/notify/store"
	"werun/api/internal/platform/i18n"
)

// Service 负责在调用方事务里登记推送并入队发送任务。
type Service struct {
	inserter   JobInserter
	cat        *i18n.Catalog
	appBaseURL string
}

// NewService 创建推送服务；appBaseURL 为小程序地址前缀（WERUN_APP_BASE_URL）。
func NewService(inserter JobInserter, cat *i18n.Catalog, appBaseURL string) *Service {
	return &Service{inserter: inserter, cat: cat, appBaseURL: strings.TrimRight(appBaseURL, "/")}
}

// Enqueue 在 tx 内写 notification_logs 并 InsertTx 一个 notify_send 任务。
// 跑者没有 telegram_user_id 时什么都不做；同一 dedupe_key 已登记时返回 nil 且不入队。
func (s *Service) Enqueue(ctx context.Context, tx pgx.Tx, n Notification) error {
	orderNo, _ := n.Params["orderNo"].(string)
	if orderNo == "" {
		return fmt.Errorf("notify: %s for order %d: params.orderNo is required", n.Template, n.OrderID)
	}

	q := store.New(tx)
	recipient, err := q.GetNotifyRecipient(ctx, n.UserID)
	if err != nil {
		return fmt.Errorf("notify: load recipient user %d: %w", n.UserID, err)
	}
	if recipient.TelegramUserID == nil {
		return nil
	}
	chatID := *recipient.TelegramUserID
	lang, ok := i18n.Parse(recipient.Locale)
	if !ok {
		lang = i18n.Default
	}

	dedupeKey := n.DedupeKey
	if dedupeKey == "" {
		var proofID int64
		if n.ProofID != nil {
			proofID = *n.ProofID
		}
		dedupeKey = fmt.Sprintf("%s:%d:%d", n.Template, n.OrderID, proofID)
	}

	orderID := n.OrderID
	logID, err := q.InsertNotificationLog(ctx, store.InsertNotificationLogParams{
		Recipient: strconv.FormatInt(chatID, 10),
		Template:  string(n.Template),
		Locale:    string(lang),
		EntityID:  &orderID,
		DedupeKey: dedupeKey,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil // ON CONFLICT DO NOTHING：同键已登记
	}
	if err != nil {
		return fmt.Errorf("notify: insert notification log %s: %w", dedupeKey, err)
	}

	args := SendArgs{
		LogID:  logID,
		ChatID: chatID,
		Text:   render(s.cat, lang, n.Template, n.Params),
		Button: &Button{
			Text: s.cat.T(lang, "notify.open_order", nil),
			URL:  s.appBaseURL + "/orders/" + url.PathEscape(orderNo),
		},
	}
	if _, err := s.inserter.InsertTx(ctx, tx, args, &river.InsertOpts{MaxAttempts: SendMaxAttempts}); err != nil {
		return fmt.Errorf("notify: enqueue send job for log %d: %w", logID, err)
	}
	return nil
}
```

创建 `api/internal/notify/notifytest/notifytest.go`：

```go
// Package notifytest 为其他包的测试构造 notify.Service：River 客户端只插入不执行，文案用内置目录。
// 不得依赖 internal/jobs（jobs 依赖 registration，会形成导入循环）。
package notifytest

import (
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"werun/api/internal/notify"
	"werun/api/internal/platform/i18n"
)

// AppBaseURL 是测试里按钮链接的前缀。
const AppBaseURL = "https://app.werun.test"

// New 返回写入 pool 的 notify.Service。
func New(t testing.TB, pool *pgxpool.Pool) *notify.Service {
	t.Helper()
	inserter, err := river.NewClient(riverpgxv5.New(pool), &river.Config{})
	if err != nil {
		t.Fatalf("notifytest: create river insert-only client: %v", err)
	}
	cat, err := i18n.LoadCatalog()
	if err != nil {
		t.Fatalf("notifytest: load catalog: %v", err)
	}
	return notify.NewService(inserter, cat, AppBaseURL)
}
```

- [ ] **Step 14: 运行测试，确认通过**

Run: `cd api && DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true go test ./internal/notify/ -run TestEnqueue -v`
Expected: 7 个 `TestEnqueue*` 全部 PASS。

- [ ] **Step 15: 写 SendWorker 的失败测试（数据库 + 假 Sender）**

创建 `api/internal/notify/worker_test.go`：

```go
package notify_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
	"github.com/stretchr/testify/require"

	"werun/api/internal/notify"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/logx"
)

type sentMessage struct {
	chatID int64
	text   string
	button *notify.Button
}

type fakeSender struct {
	err   error
	calls []sentMessage
}

func (f *fakeSender) Send(_ context.Context, chatID int64, text string, button *notify.Button) error {
	f.calls = append(f.calls, sentMessage{chatID: chatID, text: text, button: button})
	return f.err
}

type logState struct {
	status    string
	attempts  int16
	lastError *string
	sentAt    *time.Time
}

func insertPendingLog(t *testing.T, pool *pgxpool.Pool, key string) int64 {
	t.Helper()
	var id int64
	require.NoError(t, pool.QueryRow(context.Background(), `
		INSERT INTO notification_logs (channel, recipient, template, locale, entity_type, entity_id, dedupe_key)
		VALUES ('TELEGRAM', '42', 'order_expired', 'en', 'reg_order', 1, $1)
		RETURNING id`, key).Scan(&id))
	return id
}

func readLogState(t *testing.T, pool *pgxpool.Pool, id int64) logState {
	t.Helper()
	var s logState
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT status, attempts, last_error, sent_at FROM notification_logs WHERE id = $1`, id).
		Scan(&s.status, &s.attempts, &s.lastError, &s.sentAt))
	return s
}

func sendJob(logID int64, attempt, maxAttempts int) *river.Job[notify.SendArgs] {
	return &river.Job[notify.SendArgs]{
		JobRow: &rivertype.JobRow{ID: 1, Attempt: attempt, MaxAttempts: maxAttempts},
		Args: notify.SendArgs{
			LogID:  logID,
			ChatID: 42,
			Text:   "hello",
			Button: &notify.Button{Text: "View order", URL: "https://app.werun.test/orders/WR1"},
		},
	}
}

func newSendWorker(pool *pgxpool.Pool, sender notify.Sender) *notify.SendWorker {
	return &notify.SendWorker{Pool: pool, Sender: sender, Log: logx.New("error", io.Discard)}
}

func TestSendWorkerMarksLogSent(t *testing.T) {
	pool := dbtest.NewPool(t)
	logID := insertPendingLog(t, pool, "worker:sent")
	sender := &fakeSender{}

	err := newSendWorker(pool, sender).Work(context.Background(), sendJob(logID, 1, 5))

	require.NoError(t, err)
	require.Equal(t, []sentMessage{{chatID: 42, text: "hello", button: &notify.Button{Text: "View order", URL: "https://app.werun.test/orders/WR1"}}}, sender.calls)
	state := readLogState(t, pool, logID)
	require.Equal(t, "SENT", state.status)
	require.Equal(t, int16(1), state.attempts)
	require.Nil(t, state.lastError)
	require.NotNil(t, state.sentAt)
}

func TestSendWorkerSkipsAlreadySentLog(t *testing.T) {
	pool := dbtest.NewPool(t)
	logID := insertPendingLog(t, pool, "worker:already-sent")
	_, err := pool.Exec(context.Background(), `UPDATE notification_logs SET status = 'SENT', sent_at = now(), attempts = 1 WHERE id = $1`, logID)
	require.NoError(t, err)
	sender := &fakeSender{}

	err = newSendWorker(pool, sender).Work(context.Background(), sendJob(logID, 2, 5))

	require.NoError(t, err)
	require.Empty(t, sender.calls)
	require.Equal(t, int16(1), readLogState(t, pool, logID).attempts)
}

func TestSendWorkerBlockedRecipientFailsAndCancels(t *testing.T) {
	pool := dbtest.NewPool(t)
	logID := insertPendingLog(t, pool, "worker:blocked")
	sender := &fakeSender{err: fmt.Errorf("%w: Forbidden: bot was blocked by the user", notify.ErrRecipientBlocked)}

	err := newSendWorker(pool, sender).Work(context.Background(), sendJob(logID, 1, 5))

	var cancelErr *river.JobCancelError
	require.True(t, errors.As(err, &cancelErr), "403 必须返回 river.JobCancel，得到 %v", err)
	state := readLogState(t, pool, logID)
	require.Equal(t, "FAILED", state.status)
	require.Equal(t, int16(1), state.attempts)
	require.NotNil(t, state.lastError)
	require.Contains(t, *state.lastError, "blocked")
	require.Nil(t, state.sentAt)
}

func TestSendWorkerTransientErrorKeepsPendingAndCountsAttempts(t *testing.T) {
	pool := dbtest.NewPool(t)
	logID := insertPendingLog(t, pool, "worker:transient")
	sender := &fakeSender{err: errors.New("telegram sendMessage: status 502: Bad Gateway")}
	worker := newSendWorker(pool, sender)

	err := worker.Work(context.Background(), sendJob(logID, 1, 5))

	require.ErrorContains(t, err, "status 502")
	var cancelErr *river.JobCancelError
	require.False(t, errors.As(err, &cancelErr), "临时错误要让 River 重试")
	state := readLogState(t, pool, logID)
	require.Equal(t, "PENDING", state.status)
	require.Equal(t, int16(1), state.attempts)
	require.NotNil(t, state.lastError)
	require.Contains(t, *state.lastError, "Bad Gateway")

	require.Error(t, worker.Work(context.Background(), sendJob(logID, 2, 5)))
	state = readLogState(t, pool, logID)
	require.Equal(t, "PENDING", state.status)
	require.Equal(t, int16(2), state.attempts)
}

func TestSendWorkerLastAttemptMarksFailed(t *testing.T) {
	pool := dbtest.NewPool(t)
	logID := insertPendingLog(t, pool, "worker:last-attempt")
	sender := &fakeSender{err: errors.New("telegram sendMessage: status 500: Internal Server Error")}

	err := newSendWorker(pool, sender).Work(context.Background(), sendJob(logID, 5, 5))

	require.Error(t, err)
	state := readLogState(t, pool, logID)
	require.Equal(t, "FAILED", state.status)
	require.Equal(t, int16(1), state.attempts)
}

func TestSendWorkerMissingLogCancels(t *testing.T) {
	pool := dbtest.NewPool(t)
	sender := &fakeSender{}

	err := newSendWorker(pool, sender).Work(context.Background(), sendJob(999999, 1, 5))

	var cancelErr *river.JobCancelError
	require.True(t, errors.As(err, &cancelErr))
	require.Empty(t, sender.calls)
}
```

- [ ] **Step 16: 运行测试，确认失败**

Run: `cd api && DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true go test ./internal/notify/ -run TestSendWorker -v`
Expected: 编译失败，报 `undefined: notify.SendWorker`。

- [ ] **Step 17: 实现 SendWorker**

创建 `api/internal/notify/worker.go`：

```go
package notify

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"werun/api/internal/notify/store"
)

const maxLastErrorBytes = 1000

// SendWorker 执行 notify_send：发送并回写 notification_logs。
type SendWorker struct {
	river.WorkerDefaults[SendArgs]
	Pool   *pgxpool.Pool
	Sender Sender
	Log    *slog.Logger
}

// Work 发送一条推送。已 SENT 的记录直接返回；403 写 FAILED 并取消任务；
// 其他错误 attempts+1、写 last_error 并返回错误让 River 重试，最后一次尝试失败时写 FAILED。
func (w *SendWorker) Work(ctx context.Context, job *river.Job[SendArgs]) error {
	q := store.New(w.Pool)
	row, err := q.GetNotificationLog(ctx, job.Args.LogID)
	if errors.Is(err, pgx.ErrNoRows) {
		return river.JobCancel(fmt.Errorf("notify: notification log %d not found", job.Args.LogID))
	}
	if err != nil {
		return fmt.Errorf("notify: load notification log %d: %w", job.Args.LogID, err)
	}
	if row.Status == StatusSent {
		return nil
	}

	sendErr := w.Sender.Send(ctx, job.Args.ChatID, job.Args.Text, job.Args.Button)
	if sendErr == nil {
		sentAt := time.Now()
		if err := q.MarkNotificationSent(ctx, store.MarkNotificationSentParams{ID: row.ID, SentAt: &sentAt}); err != nil {
			// 消息已发出但回写失败：返回错误会重试并可能重复发送，比丢失状态更可接受。
			return fmt.Errorf("notify: mark log %d sent: %w", row.ID, err)
		}
		w.Log.InfoContext(ctx, "notification sent", "log_id", row.ID, "job_id", job.ID)
		return nil
	}

	blocked := errors.Is(sendErr, ErrRecipientBlocked)
	status := StatusPending
	if blocked || job.Attempt >= job.MaxAttempts {
		status = StatusFailed
	}
	lastError := truncateError(sendErr)
	if err := q.MarkNotificationAttemptFailed(ctx, store.MarkNotificationAttemptFailedParams{
		ID:        row.ID,
		Status:    status,
		LastError: &lastError,
	}); err != nil {
		return errors.Join(sendErr, fmt.Errorf("notify: record failure for log %d: %w", row.ID, err))
	}

	if blocked {
		w.Log.WarnContext(ctx, "notification recipient blocked the bot", "log_id", row.ID, "job_id", job.ID)
		return river.JobCancel(sendErr)
	}
	w.Log.WarnContext(ctx, "notification send failed", "log_id", row.ID, "job_id", job.ID,
		"attempt", job.Attempt, "max_attempts", job.MaxAttempts, "error", lastError)
	return fmt.Errorf("notify: send log %d: %w", row.ID, sendErr)
}

func truncateError(err error) string {
	s := err.Error()
	if len(s) > maxLastErrorBytes {
		s = s[:maxLastErrorBytes]
	}
	return strings.ToValidUTF8(s, "")
}
```

- [ ] **Step 18: 运行测试，确认通过**

Run: `cd api && DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true go test ./internal/notify/... -v`
Expected: `render_test`、`telegram_test`、`service_test`、`worker_test` 全部 PASS；`ok  werun/api/internal/notify`。

- [ ] **Step 19: 写 jobs 注册推送 worker 的失败测试**

在 `api/internal/jobs/jobs_test.go` 的 import 中加入 `"werun/api/internal/notify"`，并在文件末尾追加：

```go
type chanSender struct {
	sent chan string
}

func (s *chanSender) Send(_ context.Context, _ int64, text string, _ *notify.Button) error {
	s.sent <- text
	return nil
}

// 集成测试：注册了 Deps.Notify 的客户端必须执行 notify_send 并回写 SENT。
func TestClientRunsNotifySendJob(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()
	log := logx.New("error", io.Discard)
	var logID int64
	require.NoError(t, pool.QueryRow(ctx, `
		INSERT INTO notification_logs (channel, recipient, template, locale, entity_type, entity_id, dedupe_key)
		VALUES ('TELEGRAM', '42', 'order_expired', 'en', 'reg_order', 1, 'jobs-test:1')
		RETURNING id`).Scan(&logID))
	sender := &chanSender{sent: make(chan string, 1)}

	client, err := jobs.NewClient(jobs.Deps{
		Pool:     pool,
		Log:      log,
		Sessions: newFakeCleaner(),
		Notify:   &notify.SendWorker{Pool: pool, Sender: sender, Log: log},
	})
	require.NoError(t, err)
	require.NoError(t, client.Start(ctx))
	t.Cleanup(func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = client.Stop(stopCtx)
	})

	_, err = client.Insert(ctx, notify.SendArgs{LogID: logID, ChatID: 42, Text: "hello"}, &river.InsertOpts{MaxAttempts: notify.SendMaxAttempts})
	require.NoError(t, err)

	select {
	case text := <-sender.sent:
		require.Equal(t, "hello", text)
	case <-time.After(15 * time.Second):
		t.Fatal("15 秒内 notify_send 任务没有被执行")
	}
	require.Eventually(t, func() bool {
		var status string
		return pool.QueryRow(ctx, `SELECT status FROM notification_logs WHERE id = $1`, logID).Scan(&status) == nil && status == "SENT"
	}, 10*time.Second, 100*time.Millisecond)
}
```

- [ ] **Step 20: 运行测试，确认失败**

Run: `cd api && DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true go test ./internal/jobs/ -run TestClientRunsNotifySendJob -v`
Expected: 编译失败，报 `unknown field Notify in struct literal of type jobs.Deps`。

- [ ] **Step 21: 在 jobs.Deps 注册 SendWorker**

`api/internal/jobs/jobs.go`：import 加 `"werun/api/internal/notify"`；`Deps` 结构体加字段（其余字段保持 Task 1 的样子）：

```go
type Deps struct {
	Pool     *pgxpool.Pool
	Log      *slog.Logger
	Sessions SessionCleaner
	Notify   *notify.SendWorker // Task 20：为 nil 时不注册 notify_send（仅测试这样用）
}
```

把 `NewClient` 整个函数替换为：

```go
// NewClient 创建能执行任务的 River 客户端：注册全部 worker 与周期任务，默认队列 10 个并发。
func NewClient(d Deps) (*river.Client[pgx.Tx], error) {
	phnomPenh, err := time.LoadLocation("Asia/Phnom_Penh")
	if err != nil {
		return nil, fmt.Errorf("load Asia/Phnom_Penh: %w", err)
	}

	workers := river.NewWorkers()
	river.AddWorker(workers, &SessionCleanupWorker{Sessions: d.Sessions, Log: d.Log})
	if d.Notify != nil {
		river.AddWorker(workers, d.Notify)
	}

	periodicJobs := []*river.PeriodicJob{
		river.NewPeriodicJob(
			DailyAt{Hour: 3, Minute: 0, Loc: phnomPenh},
			func() (river.JobArgs, *river.InsertOpts) { return SessionCleanupArgs{}, nil },
			&river.PeriodicJobOpts{ID: "session_cleanup"},
		),
	}

	client, err := river.NewClient(riverpgxv5.New(d.Pool), &river.Config{
		Logger: d.Log,
		Queues: map[string]river.QueueConfig{
			river.QueueDefault: {MaxWorkers: 10},
		},
		Workers:      workers,
		PeriodicJobs: periodicJobs,
	})
	if err != nil {
		return nil, fmt.Errorf("create river client: %w", err)
	}
	return client, nil
}
```

- [ ] **Step 22: 运行测试，确认通过**

Run: `cd api && DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true go test ./internal/jobs/ -v`
Expected: 原有 jobs 测试与 `TestClientRunsNotifySendJob` 全部 PASS。

- [ ] **Step 23: 建测试环境包 regtest**

创建 `api/internal/registration/regtest/regtest.go`：

```go
// Package regtest 为 registration、payment 等包的数据库测试搭建可下单的赛事环境：
// 已发布并开放报名的 RACE 赛事、一个组别、一个价格档、一个优惠码、一个收款账户、一版 REGISTRATION 同意书。
package regtest

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"werun/api/internal/iam"
	"werun/api/internal/notify"
	"werun/api/internal/notify/notifytest"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/piicrypt"
	"werun/api/internal/pricing"
	"werun/api/internal/registration"
	"werun/api/internal/runner"
)

const (
	BotToken       = "123456:regtest-token"
	EventSlug      = "regtest-city-run"
	EventNameEN    = "Regtest City Run"
	EventTimezone  = "Asia/Phnom_Penh"
	ConsentVersion = "REG-REGTEST-v1"
	CouponCode     = "REGTEST5"
	PriceCents     = 2500
)

// Clock 是可拨动的时钟，并发安全。
type Clock struct {
	mu  sync.Mutex
	now time.Time
}

// Now 返回当前设定的时间。
func (c *Clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// Set 把时钟拨到 t。
func (c *Clock) Set(t time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = t
}

// Advance 把时钟往后拨 d。
func (c *Clock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

// Env 是一套独立测试库上的服务与种子数据。
type Env struct {
	Pool     *pgxpool.Pool
	Clock    *Clock
	Runners  *runner.Service
	Pricing  *pricing.Service
	Notifier *notify.Service
	Orders   *registration.Service

	EventID          int64
	CategoryID       int64
	PriceRuleID      int64
	CouponID         int64
	PaymentAccountID int64
}

// Counters 是组别、价格档、优惠码三类计数。
type Counters struct {
	CategoryUsed, CategoryReserved int
	RuleUsed, RuleReserved         int
	CouponUsed, CouponReserved     int
}

// New 创建测试库、服务与种子数据。时钟初值为当前时间截断到秒。
func New(t testing.TB) *Env {
	t.Helper()
	pool := dbtest.NewPool(t)
	clock := &Clock{now: time.Now().UTC().Truncate(time.Second)}
	pii, err := piicrypt.New(bytes.Repeat([]byte{7}, 32))
	require.NoError(t, err)
	runners := runner.NewService(pool, []byte(strings.Repeat("r", 32)), BotToken, pii, time.Now)
	prices := pricing.NewService(pool, clock.Now)
	notifier := notifytest.New(t, pool)

	env := &Env{
		Pool:     pool,
		Clock:    clock,
		Runners:  runners,
		Pricing:  prices,
		Notifier: notifier,
		Orders:   registration.NewService(pool, runners, prices, clock.Now),
	}
	env.seed(t)
	return env
}

func (e *Env) seed(t testing.TB) {
	t.Helper()
	ctx := context.Background()
	raceDate := time.Date(e.Clock.Now().Year()+1, 1, 15, 0, 0, 0, 0, time.UTC)

	require.NoError(t, e.Pool.QueryRow(ctx, `
		INSERT INTO events (slug, event_type, organizer_type, name, city, race_date, timezone,
		                    status, registration_open, public_visible, published_at)
		VALUES ($1, 'RACE', 'OFFICIAL', $2, 'Phnom Penh', $3, $4, 'PUBLISHED', true, true, now())
		RETURNING id`,
		EventSlug, `{"zh":"回归测试城市跑","en":"`+EventNameEN+`","km":"ការរត់ក្នុងទីក្រុងសាកល្បង"}`, raceDate, EventTimezone,
	).Scan(&e.EventID))

	require.NoError(t, e.Pool.QueryRow(ctx, `
		INSERT INTO event_categories (event_id, code, name, distance_m, capacity)
		VALUES ($1, '10K', '{"zh":"10 公里","en":"10K","km":"១០ គីឡូម៉ែត្រ"}', 10000, 500)
		RETURNING id`, e.EventID).Scan(&e.CategoryID))

	require.NoError(t, e.Pool.QueryRow(ctx, `
		INSERT INTO price_rules (event_id, name, audience, price_cents)
		VALUES ($1, '{"zh":"标准价","en":"Standard","km":"តម្លៃស្តង់ដារ"}', 'ALL', $2)
		RETURNING id`, e.EventID, PriceCents).Scan(&e.PriceRuleID))
	_, err := e.Pool.Exec(ctx, `INSERT INTO category_price_rules (category_id, price_rule_id) VALUES ($1, $2)`, e.CategoryID, e.PriceRuleID)
	require.NoError(t, err)

	require.NoError(t, e.Pool.QueryRow(ctx, `
		INSERT INTO coupons (code, event_id, discount_type, discount_value, quota, status)
		VALUES ($1, $2, 'AMOUNT', 500, 100, 'ACTIVE')
		RETURNING id`, CouponCode, e.EventID).Scan(&e.CouponID))

	var qrFileID int64
	require.NoError(t, e.Pool.QueryRow(ctx, `
		INSERT INTO files (storage_key, visibility, purpose, mime_type, size_bytes, sha256, width, height, uploaded_by_type)
		VALUES ('regtest/qr.png', 'PUBLIC', 'PAYMENT_QR', 'image/png', 1, $1, 2, 2, 'SYSTEM')
		RETURNING id`, []byte{0x01}).Scan(&qrFileID))
	require.NoError(t, e.Pool.QueryRow(ctx, `
		INSERT INTO payment_accounts (name, provider, account_name, account_no_masked, currency, qr_file_id, scope, event_id, active)
		VALUES ('Regtest ABA', 'ABA', 'WERUN TEST', '***1234', 'USD', $1, 'REGISTRATION', $2, true)
		RETURNING id`, qrFileID, e.EventID).Scan(&e.PaymentAccountID))

	require.NoError(t, e.Runners.PublishConsent(ctx, runner.PublishConsentInput{
		Purpose:       "REGISTRATION",
		Version:       ConsentVersion,
		Lang:          "en",
		EffectiveDate: time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC),
		FullText:      "Regtest registration consent.",
		Items:         []runner.ConsentItem{{Key: "rules", Title: "Rules", Description: "I accept the race rules."}},
	}))
}

// NewRunner 用签名正确的 initData 登录一个跑者（lang 为 Telegram language_code）。
func (e *Env) NewRunner(t testing.TB, telegramID int64, lang string) runner.User {
	t.Helper()
	initData := runner.SignInitData(BotToken, runner.TelegramUser{
		ID:           telegramID,
		FirstName:    "Runner",
		LastName:     fmt.Sprint(telegramID),
		Username:     fmt.Sprintf("runner%d", telegramID),
		LanguageCode: lang,
	}, time.Now())
	session, err := e.Runners.LoginTelegram(context.Background(), initData, httpx.Meta{})
	require.NoError(t, err)
	return session.User
}

// NewStaff 创建一个员工账号。
func (e *Env) NewStaff(t testing.TB, role iam.Role, username string) iam.Staff {
	t.Helper()
	svc := iam.NewService(e.Pool, []byte(strings.Repeat("s", 32)), iam.NewLoginLimiter(time.Now), time.Now)
	staff, err := svc.CreateStaff(context.Background(), username, "Regtest "+string(role), role, "Correct-Horse-Battery-9")
	require.NoError(t, err)
	return staff
}

// CreateOrder 为 u 下一张单人订单；idNo 在同一环境内必须唯一，couponCode 可为空串。
func (e *Env) CreateOrder(t testing.TB, u runner.User, idNo, couponCode string) registration.OrderDetail {
	t.Helper()
	detail, err := e.Orders.CreateOrder(context.Background(), u, registration.CreateOrderInput{
		EventSlug:  EventSlug,
		CouponCode: couponCode,
		Consent:    runner.ConsentAcceptance{Version: ConsentVersion, Lang: "en", CheckedItems: []string{"rules"}},
		Participants: []registration.OrderParticipantInput{{
			CategoryID: e.CategoryID,
			Profile: &runner.ProfileData{
				FullName:       "Regtest Runner " + idNo,
				Gender:         "M",
				BirthDate:      time.Date(1990, 1, 1, 0, 0, 0, 0, time.UTC),
				Nationality:    "US",
				IDType:         "PASSPORT",
				IDNo:           idNo,
				Phone:          "+85512345678",
				EmergencyName:  "Regtest Contact",
				EmergencyPhone: "+85512345679",
				TShirtSize:     "M",
			},
		}},
		IdempotencyKey: "regtest-" + idNo,
	}, httpx.Meta{})
	require.NoError(t, err)
	return detail
}

// Counters 读取种子组别、价格档、优惠码的计数。
func (e *Env) Counters(t testing.TB) Counters {
	t.Helper()
	var c Counters
	require.NoError(t, e.Pool.QueryRow(context.Background(), `
		SELECT
		  (SELECT used_count     FROM event_categories WHERE id = $1),
		  (SELECT reserved_count FROM event_categories WHERE id = $1),
		  (SELECT used_count     FROM price_rules WHERE id = $2),
		  (SELECT reserved_count FROM price_rules WHERE id = $2),
		  (SELECT used_count     FROM coupons WHERE id = $3),
		  (SELECT reserved_count FROM coupons WHERE id = $3)`,
		e.CategoryID, e.PriceRuleID, e.CouponID,
	).Scan(&c.CategoryUsed, &c.CategoryReserved, &c.RuleUsed, &c.RuleReserved, &c.CouponUsed, &c.CouponReserved))
	return c
}

// CountRows 执行返回单个计数的查询。
func (e *Env) CountRows(t testing.TB, sql string, args ...any) int {
	t.Helper()
	var n int
	require.NoError(t, e.Pool.QueryRow(context.Background(), sql, args...).Scan(&n))
	return n
}

// QueryString 执行返回单个文本值的查询。
func (e *Env) QueryString(t testing.TB, sql string, args ...any) string {
	t.Helper()
	var s string
	require.NoError(t, e.Pool.QueryRow(context.Background(), sql, args...).Scan(&s))
	return s
}

// Exec 执行一条写语句。
func (e *Env) Exec(t testing.TB, sql string, args ...any) {
	t.Helper()
	_, err := e.Pool.Exec(context.Background(), sql, args...)
	require.NoError(t, err)
}

// PNG 返回一张 2×2 的合法 PNG，用作凭证截图。
func PNG(t testing.TB) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, img))
	return buf.Bytes()
}
```

Run: `cd api && go vet ./internal/registration/regtest/`
Expected: 无输出（编译通过）。

- [ ] **Step 24: 写审核结果推送的失败测试**

创建 `api/internal/payment/review_notify_test.go`：

```go
package payment_test

import (
	"bytes"
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"werun/api/internal/iam"
	"werun/api/internal/notify/notifytest"
	"werun/api/internal/payment"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/storage"
	"werun/api/internal/registration"
	"werun/api/internal/registration/regtest"
	"werun/api/internal/runner"
)

type proofNotifyFixture struct {
	env     *regtest.Env
	pay     *payment.Service
	user    runner.User
	order   registration.OrderDetail
	proof   payment.Proof
	finance iam.Staff
}

func newProofNotifyFixture(t *testing.T, telegramID int64, idNo string) proofNotifyFixture {
	t.Helper()
	env := regtest.New(t)
	disk, err := storage.NewDisk(t.TempDir())
	require.NoError(t, err)
	pay := payment.NewService(env.Pool, disk, env.Orders, env.Notifier, env.Clock.Now)
	user := env.NewRunner(t, telegramID, "en")
	order := env.CreateOrder(t, user, idNo, "")
	proof, err := pay.SubmitProof(context.Background(), user, order.OrderNo, payment.SubmitProofInput{
		File:                bytes.NewReader(regtest.PNG(t)),
		BankTxnRef:          "TXN" + idNo,
		DeclaredAmountCents: order.AmountCents,
	}, httpx.Meta{})
	require.NoError(t, err)
	finance := env.NewStaff(t, iam.RoleFinance, fmt.Sprintf("finance.%d", telegramID))
	return proofNotifyFixture{env: env, pay: pay, user: user, order: order, proof: proof, finance: finance}
}

func TestApproveProofEnqueuesApprovedNotification(t *testing.T) {
	f := newProofNotifyFixture(t, 720001, "P7200011")

	_, err := f.pay.ApproveProof(context.Background(), f.finance, f.proof.ID, payment.ApproveInput{
		ReceivedAmountCents: f.order.AmountCents,
		ReceivedAt:          f.env.Clock.Now(),
	}, httpx.Meta{})

	require.NoError(t, err)
	require.Equal(t, 1, f.env.CountRows(t, `SELECT count(*) FROM river_job WHERE kind = 'notify_send'`))
	require.Equal(t, 1, f.env.CountRows(t,
		`SELECT count(*) FROM notification_logs WHERE template = 'proof_approved' AND locale = 'en' AND dedupe_key = $1`,
		fmt.Sprintf("proof_approved:%d:%d", f.order.ID, f.proof.ID)))
	require.Equal(t,
		fmt.Sprintf("Payment confirmed\nEvent: %s\nOrder: %s\nYour registration is confirmed. Open the order to see your race ticket.",
			regtest.EventNameEN, f.order.OrderNo),
		f.env.QueryString(t, `SELECT args->>'text' FROM river_job WHERE kind = 'notify_send'`))
	require.Equal(t, notifytest.AppBaseURL+"/orders/"+f.order.OrderNo,
		f.env.QueryString(t, `SELECT args->'button'->>'url' FROM river_job WHERE kind = 'notify_send'`))
}

func TestRejectProofEnqueuesRejectedNotification(t *testing.T) {
	f := newProofNotifyFixture(t, 720002, "P7200021")
	ctx := context.Background()
	note := "Photo is blurry"

	_, err := f.pay.RejectProof(ctx, f.finance, f.proof.ID, payment.RejectInput{Code: "UNREADABLE", Reason: &note}, httpx.Meta{})

	require.NoError(t, err)
	var deadline time.Time
	require.NoError(t, f.env.Pool.QueryRow(ctx, `SELECT deadline_at FROM reg_orders WHERE id = $1`, f.order.ID).Scan(&deadline))
	phnomPenh, err := time.LoadLocation("Asia/Phnom_Penh")
	require.NoError(t, err)
	require.Equal(t, 1, f.env.CountRows(t, `SELECT count(*) FROM river_job WHERE kind = 'notify_send'`))
	require.Equal(t, 1, f.env.CountRows(t,
		`SELECT count(*) FROM notification_logs WHERE template = 'proof_rejected' AND dedupe_key = $1`,
		fmt.Sprintf("proof_rejected:%d:%d", f.order.ID, f.proof.ID)))
	require.Equal(t,
		fmt.Sprintf("Payment proof not accepted\nEvent: %s\nOrder: %s\nReason: Screenshot is unreadable\nPhoto is blurry\nPlease upload a new proof before %s, otherwise the order will be cancelled automatically.",
			regtest.EventNameEN, f.order.OrderNo, deadline.In(phnomPenh).Format("2006-01-02 15:04")),
		f.env.QueryString(t, `SELECT args->>'text' FROM river_job WHERE kind = 'notify_send'`))
}

func TestApproveProofFailureEnqueuesNothing(t *testing.T) {
	f := newProofNotifyFixture(t, 720003, "P7200031")

	_, err := f.pay.ApproveProof(context.Background(), f.finance, f.proof.ID, payment.ApproveInput{
		ReceivedAmountCents: f.order.AmountCents - 1,
		ReceivedAt:          f.env.Clock.Now(),
	}, httpx.Meta{})

	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	require.Equal(t, apperr.CodeReceivedAmountTooLow, ae.Code)
	require.Equal(t, 0, f.env.CountRows(t, `SELECT count(*) FROM river_job WHERE kind = 'notify_send'`))
	require.Equal(t, 0, f.env.CountRows(t, `SELECT count(*) FROM notification_logs`))
}
```

- [ ] **Step 25: 运行测试，确认失败**

Run: `cd api && DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true go test ./internal/payment/ -run 'TestApproveProofEnqueues|TestRejectProofEnqueues|TestApproveProofFailureEnqueuesNothing' -v`
Expected: 编译失败，报 `too many arguments in call to payment.NewService`（have 5，want 4）。

- [ ] **Step 26: payment 接入 notifier**

1）在 `api/db/queries/payment.sql` 末尾追加：

```sql
-- name: GetOrderForProofNotice :one
SELECT o.order_no, o.buyer_user_id, o.deadline_at, e.name AS event_name, e.timezone AS event_timezone
FROM reg_orders o
JOIN events e ON e.id = o.event_id
WHERE o.id = @order_id;
```

Run: `make gen`
Expected: `internal/payment/store/payment.sql.go` 新增 `GetOrderForProofNotice(ctx, orderID int64) (GetOrderForProofNoticeRow, error)`，行字段 `OrderNo string`、`BuyerUserID *int64`、`DeadlineAt *time.Time`、`EventName []byte`、`EventTimezone string`。

2）`api/internal/payment/service.go`：import 加 `"werun/api/internal/notify"`；`Service` 结构体追加字段 `notifier *notify.Service`；签名

```go
func NewService(pool *pgxpool.Pool, files storage.Store, orders *registration.Service, now func() time.Time) *Service {
```

改为

```go
func NewService(pool *pgxpool.Pool, files storage.Store, orders *registration.Service, notifier *notify.Service, now func() time.Time) *Service {
```

并在函数体返回的 `&Service{…}` 字面量里加一行 `notifier: notifier,`（其余字段不变）。

3）创建 `api/internal/payment/notifications.go`：

```go
package payment

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/notify"
	"werun/api/internal/payment/store"
	"werun/api/internal/platform/i18n"
)

// proofNotice 是审核结果推送需要的订单信息。必须在审核事务里、订单状态更新之后读取，
// 驳回时读到的 deadline_at 才是新的重传截止时间。
type proofNotice struct {
	OrderNo       string
	BuyerUserID   *int64
	DeadlineAt    *time.Time
	EventName     i18n.Text
	EventTimezone string
}

func loadProofNotice(ctx context.Context, tx pgx.Tx, orderID int64) (proofNotice, error) {
	row, err := store.New(tx).GetOrderForProofNotice(ctx, orderID)
	if err != nil {
		return proofNotice{}, fmt.Errorf("load order %d for notification: %w", orderID, err)
	}
	var name i18n.Text
	if err := json.Unmarshal(row.EventName, &name); err != nil {
		return proofNotice{}, fmt.Errorf("decode event name for order %d: %w", orderID, err)
	}
	return proofNotice{
		OrderNo:       row.OrderNo,
		BuyerUserID:   row.BuyerUserID,
		DeadlineAt:    row.DeadlineAt,
		EventName:     name,
		EventTimezone: row.EventTimezone,
	}, nil
}

// enqueueProofApproved 在审核通过事务内登记 proof_approved 推送。
func (s *Service) enqueueProofApproved(ctx context.Context, tx pgx.Tx, orderID, proofID int64) error {
	info, err := loadProofNotice(ctx, tx, orderID)
	if err != nil {
		return err
	}
	if info.BuyerUserID == nil {
		return nil
	}
	return s.notifier.Enqueue(ctx, tx, notify.Notification{
		Template: notify.TemplateProofApproved,
		UserID:   *info.BuyerUserID,
		OrderID:  orderID,
		ProofID:  &proofID,
		Params: map[string]any{
			"orderNo":   info.OrderNo,
			"eventName": info.EventName,
		},
	})
}

// enqueueProofRejected 在驳回事务内（MarkProofRejected 之后）登记 proof_rejected 推送。
func (s *Service) enqueueProofRejected(ctx context.Context, tx pgx.Tx, orderID, proofID int64, in RejectInput) error {
	info, err := loadProofNotice(ctx, tx, orderID)
	if err != nil {
		return err
	}
	if info.BuyerUserID == nil {
		return nil
	}
	deadline := ""
	if info.DeadlineAt != nil {
		deadline = notify.FormatTime(*info.DeadlineAt, info.EventTimezone)
	}
	return s.notifier.Enqueue(ctx, tx, notify.Notification{
		Template: notify.TemplateProofRejected,
		UserID:   *info.BuyerUserID,
		OrderID:  orderID,
		ProofID:  &proofID,
		Params: map[string]any{
			"orderNo":   info.OrderNo,
			"eventName": info.EventName,
			"reason":    notify.RejectReason{Code: in.Code, Note: in.Reason},
			"deadline":  deadline,
		},
	})
}
```

4）`api/internal/payment/review.go`：

- 在 `ApproveProof` 的 `db.InTx` 回调里，`audit.Record(ctx, tx, audit.Entry{… Action: "payment_proof.approve" …})` 的错误检查之后、回调 `return nil` 之前插入（`order` 指 Task 17 中 `s.orders.LockOrderByID` 返回的订单变量，`id` 为方法参数凭证 ID；实际变量名不同时按实际名字写）：

```go
		if err := s.enqueueProofApproved(ctx, tx, order.ID, id); err != nil {
			return err
		}
```

- 在 `RejectProof` 的 `db.InTx` 回调里，`audit.Record(ctx, tx, audit.Entry{… Action: "payment_proof.reject" …})` 的错误检查之后、回调 `return nil` 之前插入（此时 `s.orders.MarkProofRejected` 已执行）：

```go
		if err := s.enqueueProofRejected(ctx, tx, order.ID, id, in); err != nil {
			return err
		}
```

5）更新现有调用方：对执行前核对中 `grep -rn "payment.NewService(" --include=*.go .` 与 `grep -rn "NewService(" internal/payment/*_test.go` 列出的每个**测试**调用点（包括非 `_test.go` 的测试辅助包，如 Task 15 的 `api/internal/payment/paytest/paytest.go`、Task 12 的 `api/internal/testfixture`），在 `orders` 参数与 `now` 参数之间插入 `notifytest.New(t, pool)`（`t`、`pool` 用该测试里实际的 `testing.TB` 与连接池变量），并在该文件 import 中加 `"werun/api/internal/notify/notifytest"`。例如：

```go
payment.NewService(pool, disk, orders, time.Now)
```

改为

```go
payment.NewService(pool, disk, orders, notifytest.New(t, pool), time.Now)
```

`cmd/werun/app.go` 中的调用在 Step 29 处理。

- [ ] **Step 27: 运行测试，确认通过**

Run: `cd api && DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true go test ./internal/payment/... -v`
Expected: 新增 3 个测试与 Task 6/15/17 的既有 payment 测试全部 PASS（`go build ./cmd/werun` 此时仍会因 app.go 的旧调用失败，下一步修）。

- [ ] **Step 28: 写发送器选择与任务依赖的失败测试**

创建 `api/cmd/werun/app_notify_test.go`：

```go
package main

import (
	"io"
	"testing"

	"github.com/stretchr/testify/require"

	"werun/api/internal/notify"
	"werun/api/internal/platform/config"
	"werun/api/internal/platform/logx"
)

func TestNewNotifySenderFollowsTelegramSendSetting(t *testing.T) {
	log := logx.New("error", io.Discard)
	cases := []struct {
		name         string
		cfg          config.Config
		wantTelegram bool
	}{
		{"prod 未设置时发送", config.Config{Env: "prod", TelegramBotToken: "1:x"}, true},
		{"dev 未设置时只写日志", config.Config{Env: "dev", TelegramBotToken: "1:x"}, false},
		{"dev 显式 on", config.Config{Env: "dev", TelegramSend: "on", TelegramBotToken: "1:x"}, true},
		{"prod 显式 off", config.Config{Env: "prod", TelegramSend: "off", TelegramBotToken: "1:x"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sender := newNotifySender(tc.cfg, log)

			_, isTelegram := sender.(*notify.TelegramSender)
			_, isLog := sender.(notify.LogSender)
			require.Equal(t, tc.wantTelegram, isTelegram)
			require.Equal(t, !tc.wantTelegram, isLog)
		})
	}
}

func TestJobDepsIncludesNotifyWorker(t *testing.T) {
	app := &App{Cfg: config.Config{Env: "dev"}, Log: logx.New("error", io.Discard)}

	deps := app.JobDeps()

	require.NotNil(t, deps.Notify)
	require.IsType(t, notify.LogSender{}, deps.Notify.Sender)
	require.Same(t, app.Log, deps.Notify.Log)
	require.Same(t, app.Log, deps.Log)
}
```

Run: `cd api && go test ./cmd/werun/ -run 'TestNewNotifySender|TestJobDeps' -v`
Expected: 编译失败，报 `undefined: newNotifySender`、`app.JobDeps undefined`（以及 app.go 中 `payment.NewService` 参数个数不对）。

- [ ] **Step 29: 装配 App.Notify、发送器与 worker**

1）`api/cmd/werun/app.go`：

- import 加 `"net/http"`、`"werun/api/internal/jobs"`、`"werun/api/internal/notify"`（`config`、`slog`、`time` 已有）。
- `App` 结构体追加字段：

```go
	Notify *notify.Service // Task 20
```

- `Bootstrap` 中紧跟 `app.Inserter` 赋值（及其错误检查）之后插入下面一行；它必须位于 `app.Payment = …` 与 `app.Registration = …` 之前：

```go
	app.Notify = notify.NewService(app.Inserter, app.Catalog, app.Cfg.AppBaseURL)
```

- 把 `app.Payment = payment.NewService(app.Pool, app.Store, app.Registration, time.Now)` 改为：

```go
	app.Payment = payment.NewService(app.Pool, app.Store, app.Registration, app.Notify, time.Now)
```

- 在文件末尾追加：

```go
// newNotifySender 按 WERUN_TELEGRAM_SEND 选择发送实现：开启时调用 Telegram Bot API，关闭时只写日志。
func newNotifySender(cfg config.Config, log *slog.Logger) notify.Sender {
	if cfg.TelegramSendEnabled() {
		return notify.NewTelegramSender(cfg.TelegramBotToken, notify.DefaultTelegramBaseURL, &http.Client{Timeout: 10 * time.Second})
	}
	return notify.LogSender{Log: log}
}

// JobDeps 汇总 River worker 的依赖；serve --with-worker 与 worker 命令共用。
func (a *App) JobDeps() jobs.Deps {
	return jobs.Deps{
		Pool:     a.Pool,
		Log:      a.Log,
		Sessions: a.IAM,
		Notify:   &notify.SendWorker{Pool: a.Pool, Sender: newNotifySender(a.Cfg, a.Log), Log: a.Log},
	}
}
```

2）`api/cmd/werun/serve.go`：把 `riverClient, err = jobs.NewClient(jobs.Deps{…})`（Task 1 形态为 `jobs.NewClient(jobs.Deps{Pool: app.Pool, Log: app.Log, Sessions: app.IAM})`）整个调用改为：

```go
		riverClient, err = jobs.NewClient(app.JobDeps())
```

3）`api/cmd/werun/worker.go`：把 `client, err := jobs.NewClient(jobs.Deps{…})` 改为：

```go
	client, err := jobs.NewClient(app.JobDeps())
```

4）`api/internal/httpapi/router.go`：import 加 `"werun/api/internal/notify"`，`RouterDeps` 追加字段 `Notify *notify.Service`；`api/cmd/werun/router.go` 的 `httpapi.RouterDeps{…}` 字面量追加 `Notify: app.Notify,`。

- [ ] **Step 30: 运行测试，确认通过**

Run: `cd api && go build ./... && go test ./cmd/werun/ -v`
Expected: 编译通过；`TestNewNotifySenderFollowsTelegramSendSetting`（4 个子测试）、`TestJobDepsIncludesNotifyWorker` 与既有 cmd 测试全部 PASS。

- [ ] **Step 31: 全量检查**

Run: `make gen && git status --short`
Expected: 生成代码无额外变化（只出现本任务列出的文件）。

Run: `cd api && DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true go test ./...`
Expected: 全部 `ok`，无 FAIL。

Run: `cd api && go tool golangci-lint run ./...`
Expected: `0 issues.`

- [ ] **Step 32: 提交**

```bash
git add api/internal/notify api/internal/registration/regtest \
  api/db/queries/notify.sql api/db/queries/payment.sql api/sqlc.yaml \
  api/internal/payment \
  api/internal/jobs/jobs.go api/internal/jobs/jobs_test.go \
  api/internal/platform/i18n/messages.zh.json api/internal/platform/i18n/messages.en.json api/internal/platform/i18n/messages.km.json \
  api/cmd/werun/app.go api/cmd/werun/app_notify_test.go api/cmd/werun/serve.go api/cmd/werun/worker.go api/cmd/werun/router.go \
  api/internal/httpapi
git status --short   # 预期没有未暂存的 .go 文件；Step 26 第 5 点改过的其他测试文件若不在上述目录，逐个 git add
git commit -m "$(cat <<'EOF'
feat(api): add Telegram notifications for proof review results

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
)"
```

---

### Task 21: 超时释放与付款提醒（`order_deadline` 周期任务）

**Files:**
- Create: `api/internal/registration/deadline.go`
- Test: `api/internal/registration/deadline_test.go`
- Modify: `api/db/queries/registration.sql`（追加三条查询）及生成的 `api/internal/registration/store/*`
- Modify: `api/internal/registration/service.go`（`Service` 字段与 `NewService` 签名）
- Modify: `api/internal/registration/regtest/regtest.go`
- Modify: `api/internal/jobs/jobs.go`、`api/internal/jobs/jobs_test.go`
- Modify: `api/cmd/werun/app.go`、`api/cmd/werun/app_notify_test.go`
- Modify: 所有调用 `registration.NewService(` 的现有测试文件（执行前核对里 grep 列出的文件）

**Interfaces:**
- Consumes:
  - `(*registration.Service).ReleaseOrder(ctx, tx, orderID int64, kind ReleaseKind) (bool, error)`、`registration.ReleaseExpired`（Task 13）
  - `audit.Record(ctx, tx, audit.Entry)`；`db.InTx`
  - `notify.Service.Enqueue`、`notify.TemplateOrderExpired`、`notify.TemplateDeadlineReminder`、`notify.FormatTime`、`notifytest.New`（Task 20）
  - `regtest.New / NewRunner / CreateOrder / Counters / CountRows / QueryString / Exec / PNG`（Task 20）
  - `payment.NewService(pool, files, orders, notifier, now)`、`(*payment.Service).SubmitProof`；`storage.NewDisk`
  - River v0.47.0：`river.PeriodicInterval(interval time.Duration) PeriodicSchedule`、`river.NewPeriodicJob(schedule, constructor func() (river.JobArgs, *river.InsertOpts), *river.PeriodicJobOpts)`、`river.PeriodicJobOpts{ID string}`；设置了 `Workers` 的客户端插入未注册 kind 时返回 `*river.UnknownJobKindError`
- Produces:
  - `registration.NewService(pool *pgxpool.Pool, runners *runner.Service, prices *pricing.Service, notifier *notify.Service, now func() time.Time) *Service`
  - `registration.DeadlineArgs{}`（`Kind() == "order_deadline"`）、`registration.DeadlineWorker{Svc, Log}`
  - `(*registration.Service).ProcessDeadlines(ctx) (expired, reminded int, err error)`
  - `jobs.Deps.Deadline *registration.DeadlineWorker`，周期任务 ID `order_deadline`、每分钟一次
  - 审计 `reg_order.expire`（`ActorType = "SYSTEM"`、`IsFinancial = true`）；推送 `order_expired`（默认 dedupe key `order_expired:<orderId>:0`）、`payment_deadline_reminder`（dedupe key `reminder:<orderId>:<deadline_at Unix 秒>`）

- [ ] **Step 1: 写超时与提醒的失败测试**

创建 `api/internal/registration/deadline_test.go`：

```go
package registration_test

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
	"github.com/stretchr/testify/require"

	"werun/api/internal/payment"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/logx"
	"werun/api/internal/platform/storage"
	"werun/api/internal/registration"
	"werun/api/internal/registration/regtest"
)

func expiredNoticeText(orderNo string) string {
	return fmt.Sprintf("Order %s was not paid in time and has been cancelled. Your spot has been released. Please register again if you still want to take part.", orderNo)
}

func reminderNoticeText(t *testing.T, orderNo string, deadline time.Time) string {
	t.Helper()
	phnomPenh, err := time.LoadLocation("Asia/Phnom_Penh")
	require.NoError(t, err)
	return fmt.Sprintf("Order %s: payment is due by %s. Please complete the transfer and upload your payment proof, otherwise your spot will be released.",
		orderNo, deadline.In(phnomPenh).Format("2006-01-02 15:04"))
}

func TestDeadlineArgsKind(t *testing.T) {
	require.Equal(t, "order_deadline", registration.DeadlineArgs{}.Kind())
}

func TestProcessDeadlinesExpiresPendingPaymentOrder(t *testing.T) {
	env := regtest.New(t)
	ctx := context.Background()
	user := env.NewRunner(t, 810001, "en")
	order := env.CreateOrder(t, user, "E8100011", regtest.CouponCode)
	require.Equal(t, regtest.Counters{CategoryReserved: 1, RuleReserved: 1, CouponReserved: 1}, env.Counters(t))

	env.Clock.Advance(31 * time.Minute)
	expired, reminded, err := env.Orders.ProcessDeadlines(ctx)

	require.NoError(t, err)
	require.Equal(t, 1, expired)
	require.Equal(t, 0, reminded)
	require.Equal(t, 1, env.CountRows(t, `
		SELECT count(*) FROM reg_orders
		WHERE id = $1 AND status = 'EXPIRED' AND reservation_state = 'RELEASED'
		  AND reservation_release_kind = 'ORDER_EXPIRED' AND deadline_at IS NULL AND expired_at IS NOT NULL`, order.ID))
	require.Equal(t, regtest.Counters{}, env.Counters(t))
	require.Equal(t, 1, env.CountRows(t, `SELECT count(*) FROM coupon_redemptions WHERE order_id = $1 AND state = 'RELEASED'`, order.ID))
	require.Equal(t, 1, env.CountRows(t, `
		SELECT count(*) FROM registrations r JOIN order_participants p ON p.id = r.order_participant_id
		WHERE p.order_id = $1 AND r.status = 'CANCELLED' AND r.cancel_reason = 'ORDER_EXPIRED'`, order.ID))
	require.Equal(t, 0, env.CountRows(t, `
		SELECT count(*) FROM registrations r JOIN order_participants p ON p.id = r.order_participant_id
		WHERE p.order_id = $1 AND r.status <> 'CANCELLED'`, order.ID))
	require.Equal(t, 1, env.CountRows(t, `
		SELECT count(*) FROM audit_logs
		WHERE action = 'reg_order.expire' AND entity_type = 'reg_order' AND entity_id = $1
		  AND actor_type = 'SYSTEM' AND actor_id IS NULL AND is_financial`, order.ID))
	require.Equal(t, 1, env.CountRows(t,
		`SELECT count(*) FROM notification_logs WHERE template = 'order_expired' AND dedupe_key = $1`,
		fmt.Sprintf("order_expired:%d:0", order.ID)))
	require.Equal(t, 1, env.CountRows(t, `SELECT count(*) FROM river_job WHERE kind = 'notify_send'`))
	require.Equal(t, expiredNoticeText(order.OrderNo),
		env.QueryString(t, `SELECT args->>'text' FROM river_job WHERE kind = 'notify_send'`))
}

func TestProcessDeadlinesExpiresRejectedOrderAfterReuploadDeadline(t *testing.T) {
	env := regtest.New(t)
	ctx := context.Background()
	order := env.CreateOrder(t, env.NewRunner(t, 810002, "en"), "E8100021", "")
	reupload := env.Clock.Now().Add(24 * time.Hour)
	env.Exec(t, `UPDATE reg_orders SET status = 'PROOF_REJECTED', deadline_at = $2 WHERE id = $1`, order.ID, reupload)

	env.Clock.Set(reupload.Add(-11 * time.Minute))
	expired, reminded, err := env.Orders.ProcessDeadlines(ctx)
	require.NoError(t, err)
	require.Equal(t, 0, expired, "重传期未到不能释放")
	require.Equal(t, 0, reminded, "距截止 11 分钟不在提醒窗口内")

	env.Clock.Set(reupload)
	expired, _, err = env.Orders.ProcessDeadlines(ctx)

	require.NoError(t, err)
	require.Equal(t, 1, expired)
	require.Equal(t, "EXPIRED", env.QueryString(t, `SELECT status FROM reg_orders WHERE id = $1`, order.ID))
	require.Equal(t, regtest.Counters{}, env.Counters(t))
	require.Equal(t, 1, env.CountRows(t, `SELECT count(*) FROM notification_logs WHERE template = 'order_expired'`))
}

func TestProcessDeadlinesLeavesProofSubmittedOrderAlone(t *testing.T) {
	env := regtest.New(t)
	ctx := context.Background()
	order := env.CreateOrder(t, env.NewRunner(t, 810003, "en"), "E8100031", "")
	// 故意保留一个已过去的 deadline_at：只按状态过滤也不能动审核中的订单。
	env.Exec(t, `UPDATE reg_orders SET status = 'PROOF_SUBMITTED', deadline_at = $2 WHERE id = $1`, order.ID, env.Clock.Now().Add(-time.Minute))

	env.Clock.Advance(31 * time.Minute)
	expired, reminded, err := env.Orders.ProcessDeadlines(ctx)

	require.NoError(t, err)
	require.Equal(t, 0, expired)
	require.Equal(t, 0, reminded)
	require.Equal(t, 1, env.CountRows(t, `SELECT count(*) FROM reg_orders WHERE id = $1 AND status = 'PROOF_SUBMITTED' AND reservation_state = 'RESERVED'`, order.ID))
	require.Equal(t, regtest.Counters{CategoryReserved: 1, RuleReserved: 1}, env.Counters(t))
	require.Equal(t, 0, env.CountRows(t, `SELECT count(*) FROM audit_logs WHERE action = 'reg_order.expire'`))
	require.Equal(t, 0, env.CountRows(t, `SELECT count(*) FROM notification_logs`))
}

func TestProcessDeadlinesTwiceReleasesOnce(t *testing.T) {
	env := regtest.New(t)
	ctx := context.Background()
	user := env.NewRunner(t, 810004, "en")
	env.CreateOrder(t, user, "E8100041", regtest.CouponCode)
	env.CreateOrder(t, user, "E8100042", "")
	require.Equal(t, regtest.Counters{CategoryReserved: 2, RuleReserved: 2, CouponReserved: 1}, env.Counters(t))

	env.Clock.Advance(31 * time.Minute)
	expired, _, err := env.Orders.ProcessDeadlines(ctx)
	require.NoError(t, err)
	require.Equal(t, 2, expired)

	expired, _, err = env.Orders.ProcessDeadlines(ctx)

	require.NoError(t, err)
	require.Equal(t, 0, expired)
	require.Equal(t, regtest.Counters{}, env.Counters(t))
	require.Equal(t, 2, env.CountRows(t, `SELECT count(*) FROM audit_logs WHERE action = 'reg_order.expire'`))
	require.Equal(t, 2, env.CountRows(t, `SELECT count(*) FROM notification_logs WHERE template = 'order_expired'`))
	require.Equal(t, 2, env.CountRows(t, `SELECT count(*) FROM river_job WHERE kind = 'notify_send'`))
}

func TestProcessDeadlinesProcessesMultipleBatches(t *testing.T) {
	env := regtest.New(t)
	ctx := context.Background()
	user := env.NewRunner(t, 810005, "en")
	const total = 150
	for i := range total {
		env.CreateOrder(t, user, fmt.Sprintf("B%07d", i), "")
	}
	require.Equal(t, total, env.Counters(t).CategoryReserved)

	env.Clock.Advance(31 * time.Minute)
	expired, _, err := env.Orders.ProcessDeadlines(ctx)

	require.NoError(t, err)
	require.Equal(t, total, expired)
	require.Equal(t, total, env.CountRows(t, `SELECT count(*) FROM reg_orders WHERE status = 'EXPIRED'`))
	require.Equal(t, regtest.Counters{}, env.Counters(t))
	require.Equal(t, total, env.CountRows(t, `SELECT count(*) FROM audit_logs WHERE action = 'reg_order.expire'`))
	require.Equal(t, total, env.CountRows(t, `SELECT count(*) FROM notification_logs WHERE template = 'order_expired'`))
}

func TestProcessDeadlinesSkipsOrderLockedByAnotherTransaction(t *testing.T) {
	env := regtest.New(t)
	ctx := context.Background()
	order := env.CreateOrder(t, env.NewRunner(t, 810006, "en"), "E8100061", "")
	env.Clock.Advance(31 * time.Minute)

	// 模拟上传凭证事务正持有订单行锁。
	tx, err := env.Pool.Begin(ctx)
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	var lockedID int64
	require.NoError(t, tx.QueryRow(ctx, `SELECT id FROM reg_orders WHERE id = $1 FOR UPDATE`, order.ID).Scan(&lockedID))

	expired, _, err := env.Orders.ProcessDeadlines(ctx)
	require.NoError(t, err)
	require.Equal(t, 0, expired, "SKIP LOCKED 必须跳过被锁住的订单")
	require.Equal(t, "PENDING_PAYMENT", env.QueryString(t, `SELECT status FROM reg_orders WHERE id = $1`, order.ID))

	require.NoError(t, tx.Rollback(ctx))
	expired, _, err = env.Orders.ProcessDeadlines(ctx)

	require.NoError(t, err)
	require.Equal(t, 1, expired)
	require.Equal(t, regtest.Counters{}, env.Counters(t))
}

// 并发：同一订单的上传凭证与超时释放同时发生，只能有一边生效。本机用 -count=5 连续运行确认稳定。
func TestProcessDeadlinesRacesSubmitProof(t *testing.T) {
	env := regtest.New(t)
	ctx := context.Background()
	user := env.NewRunner(t, 810007, "en")
	order := env.CreateOrder(t, user, "E8100071", "")
	require.NotNil(t, order.DeadlineAt)
	deadline := *order.DeadlineAt
	disk, err := storage.NewDisk(t.TempDir())
	require.NoError(t, err)
	// 付款服务的时钟停在截止前 1 分钟（上传本身合法），超时任务的时钟已过截止时间。
	pay := payment.NewService(env.Pool, disk, env.Orders, env.Notifier, func() time.Time { return deadline.Add(-time.Minute) })
	env.Clock.Set(deadline.Add(time.Second))
	img := regtest.PNG(t)

	var (
		wg         sync.WaitGroup
		submitErr  error
		processErr error
		expired    int
	)
	start := make(chan struct{})
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		_, submitErr = pay.SubmitProof(ctx, user, order.OrderNo, payment.SubmitProofInput{
			File:                bytes.NewReader(img),
			BankTxnRef:          "RACE8100071",
			DeclaredAmountCents: order.AmountCents,
		}, httpx.Meta{})
	}()
	go func() {
		defer wg.Done()
		<-start
		expired, _, processErr = env.Orders.ProcessDeadlines(ctx)
	}()
	close(start)
	wg.Wait()

	require.NoError(t, processErr)
	status := env.QueryString(t, `SELECT status FROM reg_orders WHERE id = $1`, order.ID)
	proofs := env.CountRows(t, `SELECT count(*) FROM payment_proofs WHERE reg_order_id = $1`, order.ID)
	counters := env.Counters(t)
	if submitErr == nil {
		require.Equal(t, 0, expired)
		require.Equal(t, "PROOF_SUBMITTED", status)
		require.Equal(t, 1, proofs)
		require.Equal(t, regtest.Counters{CategoryReserved: 1, RuleReserved: 1}, counters)
		require.Equal(t, 0, env.CountRows(t, `SELECT count(*) FROM notification_logs`))
		return
	}
	ae, ok := apperr.As(submitErr)
	require.Truef(t, ok, "上传失败必须是业务错误，得到 %v", submitErr)
	require.Contains(t, []string{apperr.CodeOrderStateConflict, apperr.CodeOrderExpired}, ae.Code)
	require.Equal(t, 1, expired)
	require.Equal(t, "EXPIRED", status)
	require.Equal(t, 0, proofs)
	require.Equal(t, regtest.Counters{}, counters)
	require.Equal(t, 1, env.CountRows(t, `SELECT count(*) FROM notification_logs WHERE template = 'order_expired'`))
}

func TestProcessDeadlinesRemindsOncePerDeadline(t *testing.T) {
	env := regtest.New(t)
	ctx := context.Background()
	order := env.CreateOrder(t, env.NewRunner(t, 810008, "en"), "E8100081", "")
	require.NotNil(t, order.DeadlineAt)
	first := *order.DeadlineAt

	env.Clock.Set(first.Add(-9 * time.Minute))
	expired, reminded, err := env.Orders.ProcessDeadlines(ctx)
	require.NoError(t, err)
	require.Equal(t, 0, expired)
	require.Equal(t, 1, reminded)

	_, reminded, err = env.Orders.ProcessDeadlines(ctx)
	require.NoError(t, err)
	require.Equal(t, 0, reminded, "同一截止时间只提醒一次")
	require.Equal(t, 1, env.CountRows(t, `SELECT count(*) FROM notification_logs WHERE template = 'payment_deadline_reminder'`))
	require.Equal(t, 1, env.CountRows(t, `SELECT count(*) FROM notification_logs WHERE dedupe_key = $1`,
		fmt.Sprintf("reminder:%d:%d", order.ID, first.Unix())))
	require.Equal(t, 1, env.CountRows(t, `SELECT count(*) FROM river_job WHERE kind = 'notify_send'`))
	require.Equal(t, reminderNoticeText(t, order.OrderNo, first),
		env.QueryString(t, `SELECT args->>'text' FROM river_job WHERE kind = 'notify_send'`))

	// 驳回后进入 24 小时重传期：新的截止时间再提醒一次。
	second := env.Clock.Now().Add(24 * time.Hour)
	env.Exec(t, `UPDATE reg_orders SET status = 'PROOF_REJECTED', deadline_at = $2 WHERE id = $1`, order.ID, second)
	_, reminded, err = env.Orders.ProcessDeadlines(ctx)
	require.NoError(t, err)
	require.Equal(t, 0, reminded)

	env.Clock.Set(second.Add(-5 * time.Minute))
	_, reminded, err = env.Orders.ProcessDeadlines(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, reminded)
	_, reminded, err = env.Orders.ProcessDeadlines(ctx)
	require.NoError(t, err)
	require.Equal(t, 0, reminded)

	require.Equal(t, 2, env.CountRows(t, `SELECT count(*) FROM notification_logs WHERE template = 'payment_deadline_reminder'`))
	require.Equal(t, 1, env.CountRows(t, `SELECT count(*) FROM notification_logs WHERE dedupe_key = $1`,
		fmt.Sprintf("reminder:%d:%d", order.ID, second.Unix())))
	require.Equal(t, 2, env.CountRows(t, `SELECT count(*) FROM river_job WHERE kind = 'notify_send'`))
}

func TestDeadlineWorkerProcessesDueOrders(t *testing.T) {
	env := regtest.New(t)
	order := env.CreateOrder(t, env.NewRunner(t, 810009, "en"), "E8100091", "")
	env.Clock.Advance(31 * time.Minute)
	worker := &registration.DeadlineWorker{Svc: env.Orders, Log: logx.New("error", io.Discard)}

	err := worker.Work(context.Background(), &river.Job[registration.DeadlineArgs]{JobRow: &rivertype.JobRow{ID: 9}})

	require.NoError(t, err)
	require.Equal(t, "EXPIRED", env.QueryString(t, `SELECT status FROM reg_orders WHERE id = $1`, order.ID))
}
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd api && DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true go test ./internal/registration/ -run 'TestDeadline|TestProcessDeadlines' -v`（非 colima 环境去掉前两个环境变量）
Expected: 编译失败，报 `undefined: registration.DeadlineArgs`、`env.Orders.ProcessDeadlines undefined`、`undefined: registration.DeadlineWorker`。

- [ ] **Step 3: 追加超时查询并生成代码**

在 `api/db/queries/registration.sql` 末尾追加：

```sql
-- name: ListDueOrderIDsForExpiry :many
SELECT id
FROM reg_orders
WHERE status IN ('PENDING_PAYMENT', 'PROOF_REJECTED')
  AND deadline_at <= @as_of::timestamptz
ORDER BY deadline_at, id
LIMIT @batch_limit::int
FOR UPDATE SKIP LOCKED;

-- name: GetOrderForExpiryNotice :one
SELECT order_no, buyer_user_id, event_id, status, deadline_at
FROM reg_orders
WHERE id = @id;

-- name: ListOrdersDueForReminder :many
SELECT o.id, o.order_no, o.buyer_user_id, o.deadline_at, e.timezone AS event_timezone
FROM reg_orders o
JOIN events e ON e.id = o.event_id
JOIN users u ON u.id = o.buyer_user_id
WHERE o.status IN ('PENDING_PAYMENT', 'PROOF_REJECTED')
  AND o.deadline_at > @as_of::timestamptz
  AND o.deadline_at <= @until::timestamptz
  AND u.telegram_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM notification_logs n
    WHERE n.dedupe_key = 'reminder:' || o.id || ':' || floor(extract(epoch FROM o.deadline_at))::bigint
  )
ORDER BY o.deadline_at, o.id;
```

Run: `make gen && cd api && grep -n "func (q \*Queries) ListDueOrderIDsForExpiry\|func (q \*Queries) GetOrderForExpiryNotice\|func (q \*Queries) ListOrdersDueForReminder" internal/registration/store/registration.sql.go`
Expected: 三个方法：
`ListDueOrderIDsForExpiry(ctx, arg ListDueOrderIDsForExpiryParams) ([]int64, error)`（`AsOf time.Time`、`BatchLimit int32`）、
`GetOrderForExpiryNotice(ctx, id int64) (GetOrderForExpiryNoticeRow, error)`（`OrderNo string`、`BuyerUserID *int64`、`EventID int64`、`Status string`、`DeadlineAt *time.Time`）、
`ListOrdersDueForReminder(ctx, arg ListOrdersDueForReminderParams) ([]ListOrdersDueForReminderRow, error)`（参数 `AsOf`、`Until time.Time`；行 `ID int64`、`OrderNo string`、`BuyerUserID *int64`、`DeadlineAt *time.Time`、`EventTimezone string`）。
若查询名与 Task 12–16 已有查询重名，`sqlc generate` 会报错，此时给新查询加 `Deadline` 前缀并同步 deadline.go。

- [ ] **Step 4: registration.Service 接收 notifier**

`api/internal/registration/service.go`：import 加 `"werun/api/internal/notify"`；`Service` 结构体追加字段 `notifier *notify.Service`；签名

```go
func NewService(pool *pgxpool.Pool, runners *runner.Service, prices *pricing.Service, now func() time.Time) *Service {
```

改为

```go
func NewService(pool *pgxpool.Pool, runners *runner.Service, prices *pricing.Service, notifier *notify.Service, now func() time.Time) *Service {
```

并在返回的 `&Service{…}` 字面量里加 `notifier: notifier,`（其余字段不变）。

`api/internal/registration/regtest/regtest.go` 中

```go
		Orders:   registration.NewService(pool, runners, prices, clock.Now),
```

改为

```go
		Orders:   registration.NewService(pool, runners, prices, notifier, clock.Now),
```

对执行前核对中 `grep -rn "registration.NewService(" --include=*.go .` 与 `grep -rn "NewService(" internal/registration/*_test.go` 列出的每个**测试**调用点（包括非 `_test.go` 的测试辅助包，如 `api/internal/payment/paytest/paytest.go`、`api/internal/testfixture`），在 `prices` 参数与 `now` 参数之间插入 `notifytest.New(t, pool)`（`t`、`pool` 用该测试里实际的变量），并加 import `"werun/api/internal/notify/notifytest"`。例如：

```go
registration.NewService(pool, runners, prices, time.Now)
```

改为

```go
registration.NewService(pool, runners, prices, notifytest.New(t, pool), time.Now)
```

- [ ] **Step 5: 实现 ProcessDeadlines 与 DeadlineWorker**

创建 `api/internal/registration/deadline.go`：

```go
package registration

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"werun/api/internal/audit"
	"werun/api/internal/notify"
	"werun/api/internal/platform/db"
	"werun/api/internal/registration/store"
)

const (
	deadlineBatchSize = 100
	reminderWindow    = 10 * time.Minute
)

// DeadlineArgs 是 order_deadline 周期任务的参数（无字段）。
type DeadlineArgs struct{}

// Kind 是 River 任务类型名。
func (DeadlineArgs) Kind() string { return "order_deadline" }

// DeadlineWorker 每分钟执行一次超时释放与付款提醒。
type DeadlineWorker struct {
	river.WorkerDefaults[DeadlineArgs]
	Svc *Service
	Log *slog.Logger
}

// Work 调用 ProcessDeadlines 并记录处理数量；出错时返回错误由 River 重试。
func (w *DeadlineWorker) Work(ctx context.Context, job *river.Job[DeadlineArgs]) error {
	expired, reminded, err := w.Svc.ProcessDeadlines(ctx)
	if err != nil {
		return fmt.Errorf("process order deadlines: %w", err)
	}
	w.Log.InfoContext(ctx, "order deadline job finished", "job_id", job.ID, "expired", expired, "reminded", reminded)
	return nil
}

// ProcessDeadlines 释放已过截止时间的待付款 / 被驳回订单（每批 100 条、一批一个事务，直到不足一批），
// 然后为截止前 10 分钟内的订单登记付款提醒。返回本次释放的订单数与新入队的提醒数。
func (s *Service) ProcessDeadlines(ctx context.Context) (expired, reminded int, err error) {
	asOf := s.now()
	for {
		selected, released, batchErr := s.expireDueBatch(ctx, asOf)
		if batchErr != nil {
			return expired, 0, fmt.Errorf("expire due orders: %w", batchErr)
		}
		expired += released
		// 不足一批说明已处理完；整批都没有释放成功时也停下，避免同一批订单反复被选中而空转。
		if selected < deadlineBatchSize || released == 0 {
			break
		}
	}

	reminded, err = s.enqueueDeadlineReminders(ctx, asOf)
	if err != nil {
		return expired, 0, fmt.Errorf("enqueue deadline reminders: %w", err)
	}
	return expired, reminded, nil
}

// expireDueBatch 在一个事务里锁定至多 100 张到期订单并逐张释放。
func (s *Service) expireDueBatch(ctx context.Context, asOf time.Time) (int, int, error) {
	var selected, released int
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		selected, released = 0, 0
		ids, err := store.New(tx).ListDueOrderIDsForExpiry(ctx, store.ListDueOrderIDsForExpiryParams{
			AsOf:       asOf,
			BatchLimit: deadlineBatchSize,
		})
		if err != nil {
			return fmt.Errorf("lock due orders: %w", err)
		}
		selected = len(ids)
		for _, id := range ids {
			ok, err := s.expireOrder(ctx, tx, id)
			if err != nil {
				return err
			}
			if ok {
				released++
			}
		}
		return nil
	})
	if err != nil {
		return 0, 0, err
	}
	return selected, released, nil
}

// expireOrder 释放一张已被本事务锁定的订单；条件更新没有命中（已被释放或状态已变）时返回 false。
func (s *Service) expireOrder(ctx context.Context, tx pgx.Tx, orderID int64) (bool, error) {
	before, err := store.New(tx).GetOrderForExpiryNotice(ctx, orderID)
	if err != nil {
		return false, fmt.Errorf("load order %d: %w", orderID, err)
	}
	released, err := s.ReleaseOrder(ctx, tx, orderID, ReleaseExpired)
	if err != nil {
		return false, fmt.Errorf("release order %d: %w", orderID, err)
	}
	if !released {
		return false, nil
	}

	eventID := before.EventID
	if err := audit.Record(ctx, tx, audit.Entry{
		ActorType:   "SYSTEM",
		Action:      "reg_order.expire",
		EntityType:  "reg_order",
		EntityID:    orderID,
		EventID:     &eventID,
		IsFinancial: true,
		Summary:     fmt.Sprintf("订单 %s 超过付款期限，已释放名额", before.OrderNo),
		Before: map[string]any{
			"status":           before.Status,
			"reservationState": "RESERVED",
			"deadlineAt":       before.DeadlineAt,
		},
		After: map[string]any{
			"status":           "EXPIRED",
			"reservationState": "RELEASED",
			"releaseKind":      string(ReleaseExpired),
		},
	}); err != nil {
		return false, err
	}

	if before.BuyerUserID == nil {
		return true, nil
	}
	if err := s.notifier.Enqueue(ctx, tx, notify.Notification{
		Template: notify.TemplateOrderExpired,
		UserID:   *before.BuyerUserID,
		OrderID:  orderID,
		Params:   map[string]any{"orderNo": before.OrderNo},
	}); err != nil {
		return false, fmt.Errorf("enqueue expiry notice for order %d: %w", orderID, err)
	}
	return true, nil
}

// enqueueDeadlineReminders 为截止时间落在 (asOf, asOf+10 分钟] 的订单登记提醒，每个截止时间只提醒一次。
func (s *Service) enqueueDeadlineReminders(ctx context.Context, asOf time.Time) (int, error) {
	var sent int
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		sent = 0
		rows, err := store.New(tx).ListOrdersDueForReminder(ctx, store.ListOrdersDueForReminderParams{
			AsOf:  asOf,
			Until: asOf.Add(reminderWindow),
		})
		if err != nil {
			return fmt.Errorf("list orders near deadline: %w", err)
		}
		for _, r := range rows {
			if r.BuyerUserID == nil || r.DeadlineAt == nil {
				continue
			}
			deadline := *r.DeadlineAt
			if err := s.notifier.Enqueue(ctx, tx, notify.Notification{
				Template:  notify.TemplateDeadlineReminder,
				UserID:    *r.BuyerUserID,
				OrderID:   r.ID,
				DedupeKey: reminderDedupeKey(r.ID, deadline),
				Params: map[string]any{
					"orderNo":  r.OrderNo,
					"deadline": notify.FormatTime(deadline, r.EventTimezone),
				},
			}); err != nil {
				return fmt.Errorf("enqueue reminder for order %d: %w", r.ID, err)
			}
			sent++
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return sent, nil
}

// reminderDedupeKey 与 ListOrdersDueForReminder 里的 SQL 表达式必须一致。
func reminderDedupeKey(orderID int64, deadline time.Time) string {
	return fmt.Sprintf("reminder:%d:%d", orderID, deadline.Unix())
}
```

- [ ] **Step 6: 运行测试，确认通过**

Run: `cd api && DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true go test ./internal/registration/... ./internal/payment/... -v`
Expected: `TestDeadlineArgsKind`、8 个 `TestProcessDeadlines*`、`TestDeadlineWorkerProcessesDueOrders` 与 Task 12–17 既有测试、Task 20 的 payment 推送测试全部 PASS。

Run: `cd api && DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true go test ./internal/registration/ -run 'TestProcessDeadlinesRacesSubmitProof|TestProcessDeadlinesSkipsOrderLockedByAnotherTransaction' -count=5 -v`
Expected: 10 次运行全部 PASS。

- [ ] **Step 7: 写 jobs 注册周期任务的失败测试**

在 `api/internal/jobs/jobs_test.go` 的 import 中加入 `"werun/api/internal/notify/notifytest"` 与 `"werun/api/internal/registration"`，并在文件末尾追加：

```go
func TestNewClientRegistersDeadlineWorker(t *testing.T) {
	pool := dbtest.NewPool(t)
	log := logx.New("error", io.Discard)
	svc := registration.NewService(pool, nil, nil, notifytest.New(t, pool), time.Now)

	client, err := jobs.NewClient(jobs.Deps{
		Pool:     pool,
		Log:      log,
		Sessions: newFakeCleaner(),
		Deadline: &registration.DeadlineWorker{Svc: svc, Log: log},
	})
	require.NoError(t, err)

	// 客户端配置了 Workers：未注册的 kind 会返回 UnknownJobKindError。
	_, err = client.Insert(context.Background(), registration.DeadlineArgs{}, nil)
	require.NoError(t, err)
}
```

Run: `cd api && DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true go test ./internal/jobs/ -run TestNewClientRegistersDeadlineWorker -v`
Expected: 编译失败，报 `unknown field Deadline in struct literal of type jobs.Deps`。

- [ ] **Step 8: 在 jobs 注册 DeadlineWorker 与每分钟周期任务**

`api/internal/jobs/jobs.go`：import 加 `"werun/api/internal/registration"`；`Deps` 改为：

```go
type Deps struct {
	Pool     *pgxpool.Pool
	Log      *slog.Logger
	Sessions SessionCleaner
	Notify   *notify.SendWorker           // Task 20：为 nil 时不注册 notify_send（仅测试这样用）
	Deadline *registration.DeadlineWorker // Task 21：为 nil 时不注册 order_deadline（仅测试这样用）
}
```

把 `NewClient` 整个函数替换为：

```go
// NewClient 创建能执行任务的 River 客户端：注册全部 worker 与周期任务，默认队列 10 个并发。
func NewClient(d Deps) (*river.Client[pgx.Tx], error) {
	phnomPenh, err := time.LoadLocation("Asia/Phnom_Penh")
	if err != nil {
		return nil, fmt.Errorf("load Asia/Phnom_Penh: %w", err)
	}

	workers := river.NewWorkers()
	river.AddWorker(workers, &SessionCleanupWorker{Sessions: d.Sessions, Log: d.Log})
	if d.Notify != nil {
		river.AddWorker(workers, d.Notify)
	}

	periodicJobs := []*river.PeriodicJob{
		river.NewPeriodicJob(
			DailyAt{Hour: 3, Minute: 0, Loc: phnomPenh},
			func() (river.JobArgs, *river.InsertOpts) { return SessionCleanupArgs{}, nil },
			&river.PeriodicJobOpts{ID: "session_cleanup"},
		),
	}
	if d.Deadline != nil {
		river.AddWorker(workers, d.Deadline)
		periodicJobs = append(periodicJobs, river.NewPeriodicJob(
			river.PeriodicInterval(time.Minute),
			func() (river.JobArgs, *river.InsertOpts) { return registration.DeadlineArgs{}, nil },
			&river.PeriodicJobOpts{ID: "order_deadline"},
		))
	}

	client, err := river.NewClient(riverpgxv5.New(d.Pool), &river.Config{
		Logger: d.Log,
		Queues: map[string]river.QueueConfig{
			river.QueueDefault: {MaxWorkers: 10},
		},
		Workers:      workers,
		PeriodicJobs: periodicJobs,
	})
	if err != nil {
		return nil, fmt.Errorf("create river client: %w", err)
	}
	return client, nil
}
```

Run: `cd api && DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true go test ./internal/jobs/ -v`
Expected: 全部 PASS（含 `TestNewClientRegistersDeadlineWorker`、`TestClientRunsNotifySendJob`）。

- [ ] **Step 9: 装配 serve / worker 的超时任务**

先在 `api/cmd/werun/app_notify_test.go` 的 import 中加入 `"time"` 与 `"werun/api/internal/registration"`，把 `TestJobDepsIncludesNotifyWorker` 整个替换为：

```go
func TestJobDepsIncludesNotifyAndDeadlineWorkers(t *testing.T) {
	app := &App{
		Cfg:          config.Config{Env: "dev"},
		Log:          logx.New("error", io.Discard),
		Registration: registration.NewService(nil, nil, nil, nil, time.Now),
	}

	deps := app.JobDeps()

	require.NotNil(t, deps.Notify)
	require.IsType(t, notify.LogSender{}, deps.Notify.Sender)
	require.Same(t, app.Log, deps.Notify.Log)
	require.NotNil(t, deps.Deadline)
	require.Same(t, app.Registration, deps.Deadline.Svc)
	require.Same(t, app.Log, deps.Deadline.Log)
}
```

Run: `cd api && go test ./cmd/werun/ -run TestJobDeps -v`
Expected: 编译失败（`app.go` 仍按 4 个参数调用 `registration.NewService`），或 `deps.Deadline` 为 nil 导致 FAIL。

然后修改 `api/cmd/werun/app.go`：

- 确认 `app.Notify = notify.NewService(…)` 位于 `app.Registration = …` 之前（Task 20 Step 29 已放在 `app.Inserter` 之后）；
- 把 `app.Registration = registration.NewService(app.Pool, app.Runner, app.Pricing, time.Now)` 改为：

```go
	app.Registration = registration.NewService(app.Pool, app.Runner, app.Pricing, app.Notify, time.Now)
```

- 把 `JobDeps` 整个函数替换为：

```go
// JobDeps 汇总 River worker 的依赖；serve --with-worker 与 worker 命令共用。
func (a *App) JobDeps() jobs.Deps {
	return jobs.Deps{
		Pool:     a.Pool,
		Log:      a.Log,
		Sessions: a.IAM,
		Notify:   &notify.SendWorker{Pool: a.Pool, Sender: newNotifySender(a.Cfg, a.Log), Log: a.Log},
		Deadline: &registration.DeadlineWorker{Svc: a.Registration, Log: a.Log},
	}
}
```

（`serve.go`、`worker.go` 已在 Task 20 改为 `jobs.NewClient(app.JobDeps())`，无需再改。）

Run: `cd api && go build ./... && go test ./cmd/werun/ -v`
Expected: 编译通过；`TestJobDepsIncludesNotifyAndDeadlineWorkers` 与其他 cmd 测试全部 PASS。

- [ ] **Step 10: 全量检查**

Run: `make gen && git status --short`
Expected: 生成代码无额外变化（只出现本任务列出的文件）。

Run: `cd api && DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true go test ./...`
Expected: 全部 `ok`，无 FAIL。

Run: `cd api && go tool golangci-lint run ./...`
Expected: `0 issues.`

- [ ] **Step 11: 提交**

```bash
git add api/internal/registration api/db/queries/registration.sql \
  api/internal/jobs/jobs.go api/internal/jobs/jobs_test.go \
  api/cmd/werun/app.go api/cmd/werun/app_notify_test.go \
  api/internal/payment api/internal/httpapi
git status --short   # 预期没有未暂存的 .go 文件；Step 4 改过的其他测试文件若不在上述目录，逐个 git add
git commit -m "$(cat <<'EOF'
feat(api): expire unpaid orders and send payment deadline reminders

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
)"
```
