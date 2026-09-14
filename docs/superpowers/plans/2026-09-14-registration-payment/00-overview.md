# WeRun 报名与收款凭证审核 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 跑者在 Telegram 小程序里报名、下单占名额、上传付款截图，财务在后台审核通过或驳回，超时自动释放名额并推送结果；运营与财务在后台配置价格档、优惠码、收款账户；免费活动直接报名。

**Architecture:** 在现有 Go 单二进制上新增 `runner`、`pricing`、`registration`、`payment`、`notify` 五个业务包和 `storage`、`piicrypt`、`idgen` 三个平台包；跨包写操作共用调用方开启的 `pgx.Tx`。OpenAPI 仍是前后端唯一契约：后台接口在 `/api/admin`（员工 Cookie），跑者接口在 `/api/app`（Bearer 令牌）。按「后台配置 → 跑者身份 → 下单 → 凭证审核 → 超时与推送 → 免费报名与端到端」纵向分段交付，每段前后端与测试一起完成。

**Tech Stack:** 沿用脚手架：Go 1.26 · Gin · oapi-codegen strict server · pgx/v5 · sqlc · goose · River · testcontainers-go · React 19 · TypeScript 5.9 · Vite 7 · React Router 7 · TanStack Query 5 · Ant Design 5（仅后台）· CSS Modules（用户端）· react-i18next · openapi-fetch · Vitest 4 · Playwright。

**Spec:** `docs/superpowers/specs/2026-09-14-registration-payment-design.md`（执行前通读；本文件「与 spec 的实现调整」一节列出的差异以本文件为准）。

计划分为 7 个文件，按顺序执行：

| 文件 | 任务 |
|---|---|
| `00-overview.md` | 全局约束、跨任务契约（本文件） |
| `01-platform-and-admin-config.md` | Task 1–6：平台包与配置、迁移与权限、赛事详情与报名开关、价格档、优惠码、收款账户 |
| `02-runner-identity.md` | Task 7–10：Telegram 登录与跑者鉴权、常用参赛人、同意书、用户端登录与参赛人页面 |
| `03-quote-and-orders.md` | Task 11–14：算价与计数、下单、我的订单与取消、报名向导 |
| `04-proofs-and-review.md` | Task 15–19：上传凭证、后台订单查询、审核通过与驳回、用户端付款与上传、后台审核与订单页面 |
| `05-deadlines-and-notify.md` | Task 20–21：Telegram 推送、超时释放与提醒 |
| `06-free-signups-and-e2e.md` | Task 22–23：免费活动报名、端到端测试与 CI |

---

## Global Constraints

以下内容对每个任务都生效，数值取自 spec，不得改动。脚手架计划 `docs/superpowers/plans/2026-09-13-scaffold/00-overview.md` 的 Global Constraints 与依赖版本继续有效。

- 只收美元：所有新表写入 `currency = 'USD'`；金额一律用 `int64` 分（cents）传递，前端输入美元字符串时按字符串解析成分，不经过浮点。
- 付款期限读 `system_settings`：`payment.upload_window_minutes`（默认 30）、`payment.reupload_window_hours`（默认 24）、`payment.review_sla_hours`（默认 24）、`payment.ident_offset_max_cents`（默认 50，代码里再与 50 取最小值）。
- 每单参赛人 1–10 人。
- 识别分 `ident_offset_cents` 取值 0–50，算进 `discount_cents`。
- 本地价：参赛人国籍为 `KH`。年龄按赛事 `race_date` 当天周岁；2 月 29 日出生者在非闰年按 3 月 1 日满岁。
- 防重复报名：同一赛事内 `registrations.status IN ('PENDING','CONFIRMED')` 且 `id_no_hash` 相同即拒绝。
- 证件号：先去掉所有空白与连字符并转大写，再 AES-256-GCM 加密（密钥 `WERUN_PII_KEY`，32 字节，随机 12 字节 nonce 前置）与 HMAC-SHA256 哈希（HMAC 密钥 = `SHA-256("werun/pii-hash/v1" || WERUN_PII_KEY)`）。任何接口都不返回完整证件号，展示用 `MaskIDNo`（只留后 4 位，其余为 `*`）。
- 跑者令牌：32 字节随机数，Base64 URL 无填充；`sessions.subject_type = 'USER'`，`token_hash` 用与员工会话相同的 HMAC 算法和 `WERUN_SESSION_SECRET`；有效期固定 24 小时，不续期。请求头 `Authorization: Bearer <token>`。
- `initData` 校验：`secret = HMAC_SHA256(key="WebAppData", msg=botToken)`；`hash = hex(HMAC_SHA256(key=secret, msg=data_check_string))`；`data_check_string` 为除 `hash` 外所有字段按键名排序后以 `\n` 连接的 `key=value`（值为 URL 解码后的原文）；常量时间比较；`auth_date` 距今超过 24 小时即过期。
- 首次登录的 `users.locale`：Telegram `language_code` 以 `zh` 开头 → `zh`；等于 `km` → `km`；其余 → `en`。
- 凭证截图：≤ 5 MB（5 × 1024 × 1024 字节），只接受按内容识别出的 `image/jpeg`、`image/png`、`image/webp`，并能解码出宽高。收款二维码：≤ 2 MB，类型同上。
- 请求体上限：`POST /api/app/orders/{orderNo}/proofs`、`POST /api/admin/payment-accounts`、`PUT /api/admin/payment-accounts/{id}` 为 6 MiB；其余 `/api/*` 为 1 MiB。
- 交易号 `bank_txn_ref`：去掉所有空白后转大写，长度 4–64。
- 编号：订单 `WR`、凭证 `PF`、报名 `RG`、免费报名 `FS`、异常 `EX`，前缀后接 8 位 Crockford Base32（字母表 `0123456789ABCDEFGHJKMNPQRSTVWXYZ`）；`ticket_code` 为 20 字节随机数的 Crockford Base32（32 位）。唯一约束冲突时重新生成，最多 3 次。
- 存储键：`yyyy/mm/<32 位小写十六进制随机数>.<jpg|png|webp>`，年月取 UTC。
- 幂等键：请求头 `Idempotency-Key`，长度 8–64，字符 `[A-Za-z0-9_-]`；`scope = 'reg_order.create'`、`subject = 'user:<userId>'`，保留 24 小时。
- 推送：`notification_logs.channel = 'TELEGRAM'`；River 任务 `notify_send` 最多重试 5 次（`MaxAttempts: 5`）；Telegram 返回 403 时标记 `FAILED` 并 `river.JobCancel`。
- 超时任务 `order_deadline` 每分钟一次，每批 100 条；提醒窗口为截止前 10 分钟，`dedupe_key = 'reminder:<orderId>:<deadline_at 的 Unix 秒>'`。
- 时间展示：后端推送文案按赛事时区 `events.timezone`（默认 `Asia/Phnom_Penh`）格式化为 `YYYY-MM-DD HH:mm`；前端按浏览器时区。
- 语言、CSRF（仅 `/api/admin/*`）、Cookie、日志、审计、错误响应格式沿用脚手架。
- 新增或修改 OpenAPI 后必须 `make gen`，生成代码提交进仓库。
- 新错误码必须同时加入 `apperr` 常量、`apperr.AllCodes`、`messages.{zh,en,km}.json`。前端新文案三语齐全，`pnpm i18n:check` 通过。
- 每个任务结束提交一次 commit，信息末尾带：

```
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
```

### 新增依赖（执行时先查实际最新补丁版本并锁定到 `go.mod` / `package.json`，在该任务的提交信息里写明版本）

| 位置 | 包 | 用途 | 引入任务 |
|---|---|---|---|
| `api/go.mod` | `golang.org/x/image`（只用 `webp` 子包） | 解码 WebP 宽高 | Task 1 |
| `web/user/package.json` | `qrcode` 与 `@types/qrcode` | 参赛凭证二维码 | Task 18 |

不新增其他依赖。

---

## 与 spec 的实现调整

以下调整不改变 spec 的业务结果，只确定实现归属：

1. **`ConfirmPaid` 负责把订单改成 `PAID`**：spec 6.3 第 6 步「订单改为 PAID」与「调用 ConfirmPaid」合并为 `registration.ConfirmPaid(ctx, tx, orderID, paidAt)`；它依次执行订单 `status = 'PAID'`、`paid_at`、`deadline_at = NULL`、`reservation_state = 'CONSUMED'`，调用 `pricing.Consume`，报名改为 `CONFIRMED`。0 元订单（spec 6.1 第 12 步）同样调用它。
2. **优惠码核销行由 `pricing` 写**：`pricing.Reserve` 只做三类计数的条件更新（在写订单之前）；订单写入后调用 `pricing.RecordRedemption` 写 `coupon_redemptions`。
3. **收款账户选择查询放在 `registration`**：避免 `registration` 依赖 `payment`（`payment` 依赖 `registration`）。
4. **推送分两步接入**：Task 17 的通过/驳回与 Task 13 的取消先不推送；Task 20 建好 `notify` 后，在 `payment.ApproveProof`、`payment.RejectProof` 中加 `notify.Enqueue`；Task 21 的超时释放与提醒直接使用 `notify`。
5. **端到端测试的跑者登录**：compose 里跑的是生产构建，不含 `?devInitData=`。Playwright 拦截 Telegram SDK 地址 `https://telegram.org/js/telegram-web-app.js`，返回一段设置 `window.Telegram.WebApp`（带测试代码签名的 `initData`）的脚本，并以 `#tgWebAppData=<initData>` 打开页面。
6. **`werun publish-consent` 参数**：`--file` 接受路径或 `-`（从标准输入读正文）；`--items` 直接接受 JSON 字符串。方便在 distroless 容器里通过 `docker compose exec -T` 执行。
7. **`WERUN_TELEGRAM_SEND` 的默认值**：变量为空时，`WERUN_ENV=prod` 视为 `on`，其余视为 `off`；显式取值只能是 `on` 或 `off`。
8. **公开赛事接口补充字段**（Task 12）：`PublicEvent` 增加 `id`、`eventType`、`registrationOpen`、`registrationOpensAt`、`registrationClosesAt`；`PublicCategory` 增加 `id`、`minAge`、`soldOut`（`used_count + reserved_count >= capacity`）。

---

## 目录与文件总览

后端新增（`api/`）：

```
db/migrations/0010_registration_payment.sql
db/queries/{storage,runner,pricing,registration,payment,notify}.sql
internal/platform/storage/{storage.go,disk.go,image.go,key.go,files.go}  + store/（sqlc）
internal/platform/piicrypt/piicrypt.go
internal/platform/idgen/idgen.go
internal/runner/{service.go,initdata.go,context.go,profiles.go,consents.go,model.go,handlers.go} + store/
internal/pricing/{service.go,quote.go,rules.go,coupons.go,model.go,handlers.go} + store/
internal/registration/{service.go,create.go,orders.go,deadline.go,free.go,model.go,handlers.go,admin.go} + store/
internal/payment/{service.go,accounts.go,proofs.go,review.go,model.go,handlers.go,files.go} + store/
internal/notify/{service.go,sender.go,telegram.go,worker.go,model.go} + store/
cmd/werun/{devinitdata.go,publishconsent.go}
```

前端新增（主要文件，实现时可按需拆分组件）：

```
packages/api-client/src/money.ts
web/admin/src/pages/{EventDetailPage,PaymentAccountsPage,ProofsPage,ProofDetailPage,OrdersPage,OrderDetailPage}.tsx
web/admin/src/{pricing,coupons,payments,orders}/…（表单、queries、localize）
web/user/src/auth/{session.ts,AuthProvider.tsx,RequireRunner.tsx}
web/user/src/pages/{RegisterPage,OrdersPage,OrderDetailPage,PayPage,ProofUploadPage,ProfilesPage,FreeSignupPage}.tsx
web/user/src/register/…（向导步骤组件、表单校验）
e2e/tests/{registration.spec.ts,free-signup.spec.ts,runner.ts}
e2e/scripts/seed-consent.sh
```

---

## 跨任务契约

实现者只看得到自己的任务；以下名字、签名、取值是任务之间的约定，不得改名。签名里的 `ctx` 均为 `context.Context`，`tx` 均为 `pgx.Tx`。

### 1. 平台包

**`internal/platform/storage`**（Task 1）

```go
type Store interface {
	Put(ctx context.Context, key string, r io.Reader) error
	Open(ctx context.Context, key string) (io.ReadCloser, error) // 不存在时返回 ErrNotFound
	Delete(ctx context.Context, key string) error               // 不存在时返回 nil
}
var ErrNotFound = errors.New("storage: not found")

func NewDisk(root string) (*Disk, error) // 目录不存在时创建；Put 先写临时文件再 rename
func NewKey(now time.Time, ext string) string // "2026/09/<32hex>.png"

type Image struct {
	Data   []byte
	MIME   string // image/jpeg | image/png | image/webp
	Ext    string // jpg | png | webp
	SHA256 [32]byte
	Width  int
	Height int
}
// ReadImage 读取至多 maxBytes+1 字节；超限返回 apperr FILE_TOO_LARGE(413)，类型不符或无法解码返回 FILE_TYPE_NOT_ALLOWED(415)。
func ReadImage(r io.Reader, maxBytes int64) (Image, error)

type FileRecord struct {
	StorageKey     string
	Visibility     string // PUBLIC | PRIVATE
	Purpose        string // PAYMENT_PROOF | PAYMENT_QR
	Image          Image
	UploadedByType string // USER | STAFF
	UploadedByID   int64
}
type File struct {
	ID         int64
	StorageKey string
	Visibility string
	MIME       string
	SizeBytes  int64
	SHA256     []byte
}
func InsertFile(ctx context.Context, tx pgx.Tx, rec FileRecord) (int64, error)
func GetFile(ctx context.Context, q store.DBTX, id int64) (File, error) // 不存在返回 apperr NOT_FOUND(404)
func CountOtherFilesWithSHA256(ctx context.Context, tx pgx.Tx, sha []byte, purpose string, excludeID int64) (int64, error)

const MaxProofBytes = 5 << 20
const MaxQRBytes = 2 << 20
```

**`internal/platform/piicrypt`**（Task 1）

```go
type Cipher struct{ /* 不导出 */ }
func New(key []byte) (*Cipher, error)              // key 必须 32 字节
func NormalizeIDNo(s string) string
func (c *Cipher) Encrypt(plain string) ([]byte, error)
func (c *Cipher) Decrypt(sealed []byte) (string, error)
func (c *Cipher) Hash(normalized string) []byte    // 32 字节
func MaskIDNo(normalized string) string            // "********1234"；长度 ≤ 4 时全部为 *
```

**`internal/platform/idgen`**（Task 1）

```go
const (
	PrefixOrder = "WR"; PrefixProof = "PF"; PrefixRegistration = "RG"
	PrefixFreeSignup = "FS"; PrefixException = "EX"
)
func Code(prefix string) string   // prefix + 8 位 Crockford Base32
func TicketCode() string          // 32 位 Crockford Base32
// Retry 调用 fn 最多 3 次；fn 返回的错误是 PostgreSQL 唯一约束冲突且约束名等于 constraint 时重试，否则原样返回。
func Retry(constraint string, fn func() error) error
```

**`internal/platform/config`**（Task 1）新增字段：

```go
TelegramBotToken    string `env:"WERUN_TELEGRAM_BOT_TOKEN,required"`
TelegramBotUsername string `env:"WERUN_TELEGRAM_BOT_USERNAME,required"`
TelegramSend        string `env:"WERUN_TELEGRAM_SEND"` // "" | on | off
AppBaseURL          string `env:"WERUN_APP_BASE_URL,required"`
func (c Config) TelegramSendEnabled() bool
func (c Config) PIIKeyBytes() ([]byte, error) // 保持脚手架现有签名；Load 成功后必定返回 32 字节
```

**`internal/platform/settings`**（Task 1）

```go
type Payment struct {
	UploadWindow       time.Duration
	ReuploadWindow     time.Duration
	ReviewSLA          time.Duration
	IdentOffsetMaxCents int64 // 已与 50 取最小值
}
func LoadPayment(ctx context.Context, q interface{ QueryRow(context.Context, string, ...any) pgx.Row }) (Payment, error)
```

**`internal/jobs`**（Task 1 改签名，后续任务只加字段）

```go
type Deps struct {
	Pool     *pgxpool.Pool
	Log      *slog.Logger
	Sessions SessionCleaner
	Notify   *notify.SendWorker          // Task 20 加入
	Deadline *registration.DeadlineWorker // Task 21 加入
}
func NewClient(d Deps) (*river.Client[pgx.Tx], error) // 执行任务的客户端
func NewInserter(pool *pgxpool.Pool) (*river.Client[pgx.Tx], error) // 不注册 worker、不开队列，只用于 InsertTx

// 业务包依赖的最小接口（在 notify 包声明）
type JobInserter interface {
	InsertTx(ctx context.Context, tx pgx.Tx, args river.JobArgs, opts *river.InsertOpts) (*rivertype.JobInsertResult, error)
}
```

`cmd/werun/app.go` 的 `App` 在 Task 1 增加 `Store storage.Store`、`PII *piicrypt.Cipher`、`Inserter *river.Client[pgx.Tx]`；各业务服务在引入它的任务里加入 `App` 与 `httpapi.RouterDeps`：`Runner`（Task 7）、`Pricing`（Task 4）、`Registration`（Task 12）、`Payment`（Task 6）、`Notify`（Task 20）。

### 2. HTTP 层

- `permgen`（Task 7）：路径以 `/app/` 开头的操作必须声明 `x-auth: none` 或 `x-auth: app`，映射为 `AuthNone` / `AuthApp`，不得声明 `x-permission` / `x-access`；`/admin/` 规则不变，且 `x-auth: app` 在 `/admin/` 下非法；其余公开路径规则不变。
- `apigen.AuthApp` 常量由 permgen 模板生成（与 `AuthNone`、`AuthSession`、`AuthPermission` 并列）。
- `AuthMiddleware`（Task 7）新签名：

```go
type RunnerAuthenticator interface {
	Authenticate(ctx context.Context, token string) (runner.User, error)
}
func AuthMiddleware(staff *iam.Service, runners RunnerAuthenticator, auths map[string]apigen.OperationAuth, log *slog.Logger) apigen.StrictMiddlewareFunc
```

  `AuthApp`：读 `Authorization: Bearer`，缺失或无效返回 401 `UNAUTHENTICATED`（令牌无效/过期同样 401 `UNAUTHENTICATED`）；成功后 `runner.WithUser(c, user)`。`AuthSession` / `AuthPermission` 分支保持原样（只认员工 Cookie）。
- `maxBodySize`（Task 1）改为按路径取上限：

```go
func bodyLimitFor(path string) int64 // 匹配 ^/api/app/orders/[^/]+/proofs$ 或 ^/api/admin/payment-accounts(/[0-9]+)?$ 返回 6<<20，否则 1<<20
```

- 二进制响应（`getPublicFile`、`adminGetFile`）在 OpenAPI 中声明 `content: {image/*: {schema: {type: string, format: binary}}}`，handler 返回生成的 `…200ImageResponse{Body, ContentType, ContentLength}`。
- `multipart/form-data` 请求：strict handler 收到 `*multipart.Reader`；handler 逐个 part 读取，文件 part 名为 `file`（凭证）或 `qr`（收款码），其余为文本字段。

### 3. 业务包公开接口

**`runner`**（Task 7–9）

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
func SignInitData(botToken string, u TelegramUser, authDate time.Time) string       // 生成含 user、auth_date、hash 的查询串
func (s *Service) LoginTelegram(ctx context.Context, initData string, meta httpx.Meta) (Session, error)
func (s *Service) Authenticate(ctx context.Context, token string) (User, error)
func (s *Service) Logout(ctx context.Context, token string) error
func WithUser(c *gin.Context, u User)
func UserFrom(ctx context.Context) (User, bool)

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
// ValidateProfile 返回 apperr VALIDATION_FAILED，字段名前缀由 fieldPrefix 给出（如 "participants[0]."）
func ValidateProfile(p ProfileData, fieldPrefix string) error
func (s *Service) ListProfiles(ctx context.Context, u User) ([]Profile, error)
func (s *Service) CreateProfile(ctx context.Context, u User, p ProfileData, isSelf bool) (Profile, error)
func (s *Service) UpdateProfile(ctx context.Context, u User, id int64, p ProfileData, isSelf bool) (Profile, error) // IDNo 为空串时保留原证件号
func (s *Service) DeleteProfile(ctx context.Context, u User, id int64) error
func (s *Service) CreateProfileTx(ctx context.Context, tx pgx.Tx, u User, p ProfileData) (int64, error)
// LoadProfileForOrder 返回解密后的完整资料（含 IDNo）；资料不属于该用户返回 VALIDATION_FAILED（字段 fieldPrefix+"profileId"）
func (s *Service) LoadProfileForOrder(ctx context.Context, tx pgx.Tx, u User, id int64, fieldPrefix string) (ProfileData, error)
func (s *Service) PII() *piicrypt.Cipher

type ConsentItem struct { Key, Title, Description string }
type ConsentVersion struct { Version, Lang string; EffectiveDate time.Time; FullText string; Items []ConsentItem }
type ConsentAcceptance struct { Version, Lang string; CheckedItems []string }
type ConsentLink struct { RegOrderID, FreeSignupID *int64 } // 恰好一个非空
type PublishConsentInput struct { Purpose, Version, Lang string; EffectiveDate time.Time; FullText string; Items []ConsentItem }
func (s *Service) PublishConsent(ctx context.Context, in PublishConsentInput) error
func (s *Service) CurrentConsent(ctx context.Context, purpose string, lang i18n.Lang) (ConsentVersion, error) // 取 effective_date <= 今天 中最新的一版；无则 NOT_FOUND
// SignConsent 校验版本存在、purpose=REGISTRATION、CheckedItems 恰好等于该版本全部 key（顺序无关），写 disclaimer_signatures 与 registration_consents
func (s *Service) SignConsent(ctx context.Context, tx pgx.Tx, u User, acc ConsentAcceptance, meta httpx.Meta, link ConsentLink) error
```

**`pricing`**（Task 4、5、11）

```go
type ParticipantInput struct {
	CategoryID  int64
	Nationality string
	BirthDate   time.Time
}
type QuoteInput struct {
	EventID          int64
	RaceDate         time.Time
	CouponCode       string   // 空串表示不用
	Participants     []ParticipantInput
	Now              time.Time
	PaymentAccountID *int64   // nil = 预览，不选识别分、不加锁
}
type ParticipantQuote struct {
	CategoryID, PriceRuleID int64
	Audience                string // ALL | LOCAL
	ListPriceCents          int64
	PaidCents               int64
}
type Quote struct {
	Participants        []ParticipantQuote
	ListAmountCents     int64
	CouponID            *int64
	CouponDiscountCents int64
	IdentOffsetCents    int64
	DiscountCents       int64
	AmountCents         int64
	Currency            string // "USD"
}
func NewService(pool *pgxpool.Pool, now func() time.Time) *Service
func (s *Service) Quote(ctx context.Context, tx pgx.Tx, in QuoteInput) (Quote, error)
func (s *Service) Reserve(ctx context.Context, tx pgx.Tx, q Quote) error
func (s *Service) RecordRedemption(ctx context.Context, tx pgx.Tx, orderID int64, q Quote) error // 无优惠码时什么都不做
func (s *Service) Consume(ctx context.Context, tx pgx.Tx, orderID int64) error  // 读 order_participants 与 coupon_redemptions
func (s *Service) Release(ctx context.Context, tx pgx.Tx, orderID int64) error

// 纯函数（Task 11，单元测试直接覆盖）
type TierCandidate struct {
	PriceRuleID   int64
	Audience      string
	PriceCents    int64
	Quota         *int32
	UsedCount     int32
	ReservedCount int32
	SaleStartsAt  *time.Time
	SaleEndsAt    *time.Time
	SortOrder     int16
}
func SelectTier(cands []TierCandidate, nationality string, now time.Time, takenInOrder map[int64]int) (TierCandidate, bool)
func AgeOn(birth, raceDate time.Time) int
type CouponRule struct { DiscountType string; DiscountValue int64 } // PERCENT | AMOUNT | WAIVER
func CouponDiscount(c CouponRule, listAmount int64) int64
func Allocate(listPrices []int64, discount int64) []int64 // 返回每人 paid_cents
func PickIdentOffset(amountAfterCoupon int64, taken map[int64]bool, maxCents int64) int64 // taken 的键是其他未完成订单的 amount_cents

// 后台维护（Task 4、5）
type PriceRuleInput struct {
	Name         i18n.Text
	Audience     string
	PriceCents   int64
	Quota        *int32
	SaleStartsAt *time.Time
	SaleEndsAt   *time.Time
	SortOrder    int16
	CategoryIDs  []int64
}
type PriceRule struct {
	ID, EventID   int64
	Input         PriceRuleInput
	UsedCount     int32
	ReservedCount int32
}
func (s *Service) ListPriceRules(ctx context.Context, eventID int64) ([]PriceRule, error)
func (s *Service) CreatePriceRule(ctx context.Context, actor iam.Staff, eventID int64, in PriceRuleInput) (PriceRule, error)
func (s *Service) UpdatePriceRule(ctx context.Context, actor iam.Staff, id int64, in PriceRuleInput) (PriceRule, error)
type CouponInput struct {
	Code          string
	EventID       *int64
	DiscountType  string
	DiscountValue int64
	Quota         int32
	MinRunners    *int16
	ValidFrom     *time.Time
	ValidUntil    *time.Time
	Description   i18n.Text // 可为 nil
	Status        string    // ACTIVE | DISABLED
}
type Coupon struct { ID int64; Input CouponInput; UsedCount, ReservedCount int32 }
func (s *Service) ListCoupons(ctx context.Context, eventID *int64) ([]Coupon, error)
func (s *Service) CreateCoupon(ctx context.Context, actor iam.Staff, in CouponInput) (Coupon, error)
func (s *Service) UpdateCoupon(ctx context.Context, actor iam.Staff, id int64, in CouponInput) (Coupon, error) // Code 不可改
```

**`registration`**（Task 12–16、21、22）

```go
type OrderParticipantInput struct {
	CategoryID    int64
	ProfileID     *int64
	Profile       *runner.ProfileData
	SaveAsProfile bool
}
type CreateOrderInput struct {
	EventSlug      string
	CouponCode     string
	Consent        runner.ConsentAcceptance
	Participants   []OrderParticipantInput
	IdempotencyKey string
}
type QuotePreviewInput struct {
	CouponCode   string
	Participants []pricing.ParticipantInput
}
type Order struct {
	ID, EventID, BuyerUserID int64
	OrderNo            string
	Status             string
	ReservationState   string
	ListAmountCents    int64
	DiscountCents      int64
	IdentOffsetCents   int64
	AmountCents        int64
	Currency           string
	PaymentAccountID   int64
	DeadlineAt         *time.Time
	PaidAt             *time.Time
	CreatedAt          time.Time
}
type OrderParticipant struct {
	RegistrationID   int64
	RegNo            string
	CategoryID       int64
	CategoryName     i18n.Text
	FullName         string
	PriceRuleID      int64
	ListPriceCents   int64
	PaidCents        int64
	RegistrationStatus string // PENDING | CONFIRMED | CANCELLED
	TicketCode       *string  // 仅 CONFIRMED 时非空
}
type PaymentAccountView struct {
	ID              int64
	Name            string
	Provider        string
	AccountName     string
	AccountNoMasked string
	QRFileID        int64
}
type LastRejection struct { Code string; Reason *string; ReviewedAt time.Time }
type OrderDetail struct {
	Order
	EventSlug      string
	EventName      i18n.Text
	EventTimezone  string
	Participants   []OrderParticipant
	PaymentAccount PaymentAccountView
	LastRejection  *LastRejection
}
type OrderSummary struct { Order; EventSlug string; EventName i18n.Text; ParticipantCount int }

func NewService(pool *pgxpool.Pool, runners *runner.Service, prices *pricing.Service, now func() time.Time) *Service
func (s *Service) PreviewQuote(ctx context.Context, u runner.User, slug string, in QuotePreviewInput) (pricing.Quote, error)
func (s *Service) CreateOrder(ctx context.Context, u runner.User, in CreateOrderInput, meta httpx.Meta) (OrderDetail, error)
func (s *Service) ListMyOrders(ctx context.Context, u runner.User) ([]OrderSummary, error)
func (s *Service) GetMyOrder(ctx context.Context, u runner.User, orderNo string) (OrderDetail, error) // 不属于该用户返回 ORDER_NOT_FOUND(404)
func (s *Service) CancelOrder(ctx context.Context, u runner.User, orderNo string, meta httpx.Meta) (OrderDetail, error)

// 供 payment 在其事务内调用：LockOrderByNo、MarkProofSubmitted 由 Task 15 实现；LockOrderByID、MarkProofRejected 由 Task 17 实现；ConfirmPaid 由 Task 12 实现（0 元订单使用）
func (s *Service) LockOrderByNo(ctx context.Context, tx pgx.Tx, orderNo string) (Order, error) // FOR UPDATE；不存在 ORDER_NOT_FOUND
func (s *Service) LockOrderByID(ctx context.Context, tx pgx.Tx, id int64) (Order, error)
func (s *Service) MarkProofSubmitted(ctx context.Context, tx pgx.Tx, orderID int64) error
func (s *Service) MarkProofRejected(ctx context.Context, tx pgx.Tx, orderID int64, deadline time.Time) error
func (s *Service) ConfirmPaid(ctx context.Context, tx pgx.Tx, orderID int64, paidAt time.Time) error

// 释放（取消与超时共用）
type ReleaseKind string
const (ReleaseExpired ReleaseKind = "ORDER_EXPIRED"; ReleaseCancelled ReleaseKind = "ORDER_CANCELLED")
func (s *Service) ReleaseOrder(ctx context.Context, tx pgx.Tx, orderID int64, kind ReleaseKind) (bool, error) // 条件更新影响 1 行才释放计数并返回 true

// 后台（Task 16）
type AdminOrderFilter struct { EventID *int64; Status string; Query string; Limit, Offset int32 }
type AdminOrderDetail struct {
	OrderDetail
	BuyerName, BuyerPhone string
	Proofs   []ProofHistoryItem
	Receipts []ReceiptItem
	Coupon   *AppliedCoupon
}
type ProofHistoryItem struct { ID int64; ProofNo, Status, BankTxnRef string; DeclaredAmountCents int64; RejectCode *string; CreatedAt time.Time; ReviewedAt *time.Time }
type ReceiptItem struct { ID int64; TxnRef string; AmountCents int64; ReceivedAt time.Time; MatchStatus string }
type AppliedCoupon struct { Code string; DiscountCents int64; State string }
func (s *Service) AdminListOrders(ctx context.Context, f AdminOrderFilter) ([]OrderSummary, int64, error)
func (s *Service) AdminGetOrder(ctx context.Context, id int64) (AdminOrderDetail, error)

// 超时（Task 21）
type DeadlineArgs struct{}               // Kind() == "order_deadline"
type DeadlineWorker struct {
	river.WorkerDefaults[DeadlineArgs]
	Svc *Service
	Log *slog.Logger
}
func (s *Service) ProcessDeadlines(ctx context.Context) (expired, reminded int, err error)

// 免费活动（Task 22）
type FreeSignupInput struct {
	CategoryID                                    int64
	FullName, Phone, EmergencyName, EmergencyPhone string
	Gender                                        *string
	BirthDate                                     *time.Time
	Consent                                       runner.ConsentAcceptance
}
type FreeSignup struct { ID int64; SignupNo string; EventSlug string; CategoryID int64; FullName string; Status string; CreatedAt time.Time }
func (s *Service) CreateFreeSignup(ctx context.Context, u runner.User, slug string, in FreeSignupInput, meta httpx.Meta) (FreeSignup, error)
```

`registration.NewService` 在 Task 21 改为额外接收 `notifier *notify.Service`（`NewService(pool, runners, prices, notifier, now)`）；Task 12 先按上面的签名实现。

**`payment`**（Task 6、15、17）

```go
type AccountInput struct {
	Name, Provider, AccountName, AccountNoMasked string // Provider: ABA | ACLEDA | WING | BAKONG | OTHER
	Scope   string // REGISTRATION | MERCH | ALL
	EventID *int64
	Active  bool
}
type Account struct { ID int64; Input AccountInput; Currency string; QRFileID int64; CreatedAt time.Time }
func NewService(pool *pgxpool.Pool, files storage.Store, orders *registration.Service, now func() time.Time) *Service
func (s *Service) ListAccounts(ctx context.Context) ([]Account, error)
func (s *Service) CreateAccount(ctx context.Context, actor iam.Staff, in AccountInput, qr io.Reader) (Account, error) // qr 必填
func (s *Service) UpdateAccount(ctx context.Context, actor iam.Staff, id int64, in AccountInput, qr io.Reader) (Account, error) // qr 为 nil 时不换
func (s *Service) OpenPublicFile(ctx context.Context, id int64) (storage.File, io.ReadCloser, error)  // 非 PUBLIC 返回 NOT_FOUND
func (s *Service) OpenPrivateFile(ctx context.Context, id int64) (storage.File, io.ReadCloser, error)

type SubmitProofInput struct {
	File                io.Reader
	BankTxnRef          string
	DeclaredAmountCents int64
	DeclaredPaidAt      *time.Time
	PayerName           *string
}
type Proof struct {
	ID, OrderID, PaymentAccountID, FileID int64
	ProofNo, OrderNo, BankTxnRef, Status  string
	DeclaredAmountCents int64
	DeclaredPaidAt      *time.Time
	PayerName           *string
	DupFileHit          bool
	RejectCode          *string
	RejectReason        *string
	ReviewedBy          *int64
	ReviewedAt          *time.Time
	CreatedAt           time.Time
}
type ProofQueueItem struct { Proof; AmountCents int64; EventName i18n.Text; WaitingSince time.Time; OverSLA bool }
type ProofDetail struct { Proof; Order registration.AdminOrderDetail }
type ApproveInput struct { ReceivedAmountCents int64; ReceivedAt time.Time; Note *string }
type RejectInput struct { Code string; Reason *string }
func (s *Service) SubmitProof(ctx context.Context, u runner.User, orderNo string, in SubmitProofInput, meta httpx.Meta) (Proof, error)
func (s *Service) ListProofs(ctx context.Context, status string) ([]ProofQueueItem, error) // status 为空时取 SUBMITTED
func (s *Service) GetProof(ctx context.Context, id int64) (ProofDetail, error)
func (s *Service) ApproveProof(ctx context.Context, actor iam.Staff, id int64, in ApproveInput, meta httpx.Meta) (ProofDetail, error)
func (s *Service) RejectProof(ctx context.Context, actor iam.Staff, id int64, in RejectInput, meta httpx.Meta) (ProofDetail, error)
```

`payment.NewService` 的签名分三步演进：Task 6 为 `NewService(pool, files, now)`（此时还没有 `registration` 包）；Task 15 改为上面的 `NewService(pool, files, orders, now)`；Task 20 改为 `NewService(pool, files, orders, notifier *notify.Service, now)`。每次改签名的任务负责同步 `cmd/werun/app.go` 与已有测试。

**`notify`**（Task 20）

```go
type Template string
const (
	TemplateProofApproved   Template = "proof_approved"
	TemplateProofRejected   Template = "proof_rejected"
	TemplateDeadlineReminder Template = "payment_deadline_reminder"
	TemplateOrderExpired    Template = "order_expired"
)
type Notification struct {
	Template  Template
	UserID    int64
	OrderID   int64
	ProofID   *int64
	DedupeKey string         // 空串时用 "<template>:<orderId>:<proofId 或 0>"
	Params    map[string]any // 文案参数：orderNo、deadline、reason 等
}
type JobInserter interface { InsertTx(ctx context.Context, tx pgx.Tx, args river.JobArgs, opts *river.InsertOpts) (*rivertype.JobInsertResult, error) }
func NewService(inserter JobInserter, cat *i18n.Catalog, appBaseURL string) *Service
func (s *Service) Enqueue(ctx context.Context, tx pgx.Tx, n Notification) error // 同键已存在时返回 nil 且不入队

type Button struct { Text, URL string }
type Sender interface { Send(ctx context.Context, chatID int64, text string, button *Button) error }
var ErrRecipientBlocked = errors.New("notify: recipient blocked the bot")
func NewTelegramSender(botToken, baseURL string, client *http.Client) *TelegramSender // baseURL 默认 https://api.telegram.org
type LogSender struct{ Log *slog.Logger }

type SendArgs struct { LogID, ChatID int64; Text string; Button *Button } // Kind() == "notify_send"；InsertOpts.MaxAttempts = 5
type SendWorker struct { river.WorkerDefaults[SendArgs]; Pool *pgxpool.Pool; Sender Sender; Log *slog.Logger }
```

消息文案 key：`notify.proof_approved`、`notify.proof_rejected`、`notify.payment_deadline_reminder`、`notify.order_expired`、`notify.open_order`（按钮文字）、`notify.reject_code.<CODE>`（七个原因码）。参数用 `{orderNo}`、`{deadline}`、`{reason}`、`{eventName}`。按钮 URL：`<AppBaseURL>/orders/<orderNo>`。

### 4. 数据库迁移 `0010_registration_payment.sql`（Task 2）

```sql
-- +goose Up
ALTER TABLE disclaimer_versions
  ADD COLUMN purpose text NOT NULL DEFAULT 'COMMUNITY' CHECK (purpose IN ('COMMUNITY','REGISTRATION'));

CREATE TABLE registration_consents (
  signature_id   bigint PRIMARY KEY REFERENCES disclaimer_signatures(id),
  reg_order_id   bigint REFERENCES reg_orders(id),
  free_signup_id bigint REFERENCES free_signups(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(reg_order_id, free_signup_id) = 1)
);
CREATE INDEX registration_consents_order_idx ON registration_consents (reg_order_id) WHERE reg_order_id IS NOT NULL;
CREATE INDEX registration_consents_free_idx  ON registration_consents (free_signup_id) WHERE free_signup_id IS NOT NULL;
CREATE TRIGGER registration_consents_append_only BEFORE UPDATE OR DELETE ON registration_consents
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- +goose Down
DROP TABLE registration_consents;
ALTER TABLE disclaimer_versions DROP COLUMN purpose;
```

### 5. sqlc

每个新查询文件在 `api/sqlc.yaml` 增加一段，`gen.go` 配置与现有 `iam`、`event` 段完全相同（含全部 `overrides`），输出目录如下：

| 查询文件 | 输出包 |
|---|---|
| `db/queries/storage.sql` | `internal/platform/storage/store` |
| `db/queries/runner.sql` | `internal/runner/store` |
| `db/queries/pricing.sql` | `internal/pricing/store` |
| `db/queries/registration.sql` | `internal/registration/store` |
| `db/queries/payment.sql` | `internal/payment/store` |
| `db/queries/notify.sql` | `internal/notify/store` |

带条件的计数更新用 `:execrows`，由调用方判断影响行数。

### 6. OpenAPI 操作

`x-auth` / `x-permission` + `x-access` 按下表声明。`operationId` 固定如下，strict 接口方法名为首字母大写形式。

| operationId | 方法与路径（相对 `/api`） | 鉴权 | 引入任务 |
|---|---|---|---|
| `adminGetEvent` | `GET /admin/events/{id}` | `event_config` read | 3 |
| `adminUpdateEventRegistration` | `PATCH /admin/events/{id}/registration` | `event_config` write | 3 |
| `adminListPriceRules` | `GET /admin/events/{id}/price-rules` | `price_config` read | 4 |
| `adminCreatePriceRule` | `POST /admin/events/{id}/price-rules` | `price_config` write | 4 |
| `adminUpdatePriceRule` | `PUT /admin/price-rules/{id}` | `price_config` write | 4 |
| `adminListCoupons` | `GET /admin/coupons`（`?eventId=`） | `coupon_manage` read | 5 |
| `adminCreateCoupon` | `POST /admin/coupons` | `coupon_manage` write | 5 |
| `adminUpdateCoupon` | `PUT /admin/coupons/{id}` | `coupon_manage` write | 5 |
| `adminListPaymentAccounts` | `GET /admin/payment-accounts` | `payment_account_manage` read | 6 |
| `adminCreatePaymentAccount` | `POST /admin/payment-accounts`（multipart） | `payment_account_manage` write | 6 |
| `adminUpdatePaymentAccount` | `PUT /admin/payment-accounts/{id}`（multipart） | `payment_account_manage` write | 6 |
| `getPublicFile` | `GET /files/{id}` | 公开 | 6 |
| `appLoginTelegram` | `POST /app/auth/telegram` | `x-auth: none` | 7 |
| `appLogout` | `POST /app/auth/logout` | `x-auth: app` | 7 |
| `appGetMe` | `GET /app/me` | `x-auth: app` | 7 |
| `appListProfiles` | `GET /app/profiles` | `x-auth: app` | 8 |
| `appCreateProfile` | `POST /app/profiles` | `x-auth: app` | 8 |
| `appUpdateProfile` | `PUT /app/profiles/{id}` | `x-auth: app` | 8 |
| `appDeleteProfile` | `DELETE /app/profiles/{id}` | `x-auth: app` | 8 |
| `appGetConsent` | `GET /app/consents`（`?purpose=REGISTRATION&lang=`） | `x-auth: app` | 9 |
| `appQuote` | `POST /app/events/{slug}/quote` | `x-auth: app` | 12 |
| `appCreateOrder` | `POST /app/orders`（请求头 `Idempotency-Key`） | `x-auth: app` | 12 |
| `appListOrders` | `GET /app/orders` | `x-auth: app` | 13 |
| `appGetOrder` | `GET /app/orders/{orderNo}` | `x-auth: app` | 13 |
| `appCancelOrder` | `POST /app/orders/{orderNo}/cancel` | `x-auth: app` | 13 |
| `appSubmitProof` | `POST /app/orders/{orderNo}/proofs`（multipart） | `x-auth: app` | 15 |
| `adminListOrders` | `GET /admin/orders`（`?eventId=&status=&q=&limit=&offset=`） | `order_view` read | 16 |
| `adminGetOrder` | `GET /admin/orders/{id}` | `order_view` read | 16 |
| `adminListProofs` | `GET /admin/proofs`（`?status=`） | `proof_review` read | 17 |
| `adminGetProof` | `GET /admin/proofs/{id}` | `proof_review` read | 17 |
| `adminApproveProof` | `POST /admin/proofs/{id}/approve` | `proof_review` write | 17 |
| `adminRejectProof` | `POST /admin/proofs/{id}/reject` | `proof_review` write | 17 |
| `adminGetFile` | `GET /admin/files/{id}` | `proof_review` read | 17 |
| `appCreateFreeSignup` | `POST /app/events/{slug}/free-signups` | `x-auth: app` | 22 |

JSON 字段一律小驼峰；金额字段以 `Cents` 结尾，类型 `integer`、`format: int64`；时间 `string`、`format: date-time`；日期 `string`、`format: date`；三语文本复用 `LocalizedText`。

### 7. 错误码

| 常量 | 值 | HTTP | 引入任务 |
|---|---|---|---|
| `CodeFileTooLarge` | `FILE_TOO_LARGE` | 413 | 1 |
| `CodeFileTypeNotAllowed` | `FILE_TYPE_NOT_ALLOWED` | 415 | 1 |
| `CodeRegistrationNotReady` | `REGISTRATION_NOT_READY` | 422 | 3 |
| `CodePriceRuleLocked` | `PRICE_RULE_LOCKED` | 409 | 4 |
| `CodeCouponCodeTaken` | `COUPON_CODE_TAKEN` | 409 | 5 |
| `CodeTelegramAuthInvalid` | `TELEGRAM_AUTH_INVALID` | 401 | 7 |
| `CodeConsentInvalid` | `CONSENT_INVALID` | 422 | 9 |
| `CodeRegistrationClosed` | `REGISTRATION_CLOSED` | 409 | 12 |
| `CodeCategorySoldOut` | `CATEGORY_SOLD_OUT` | 409 | 11 |
| `CodePriceTierSoldOut` | `PRICE_TIER_SOLD_OUT` | 409 | 11 |
| `CodeCouponInvalid` | `COUPON_INVALID` | 422 | 11 |
| `CodeCouponExhausted` | `COUPON_EXHAUSTED` | 409 | 11 |
| `CodeAlreadyRegistered` | `ALREADY_REGISTERED` | 409 | 12 |
| `CodePaymentAccountUnavailable` | `PAYMENT_ACCOUNT_UNAVAILABLE` | 503 | 12 |
| `CodeIdempotencyKeyReused` | `IDEMPOTENCY_KEY_REUSED` | 422 | 12 |
| `CodeOrderNotFound` | `ORDER_NOT_FOUND` | 404 | 13 |
| `CodeOrderStateConflict` | `ORDER_STATE_CONFLICT` | 409 | 12 |
| `CodeOrderExpired` | `ORDER_EXPIRED` | 409 | 15 |
| `CodeProofTxnRefUsed` | `PROOF_TXN_REF_USED` | 409 | 15 |
| `CodeReceivedAmountTooLow` | `RECEIVED_AMOUNT_TOO_LOW` | 422 | 17 |

`REGISTRATION_NOT_READY`：开放报名校验不通过（Task 3 在 `event` 包自己的查询里统计「没有关联价格档的组别」与「可用于该赛事报名的启用收款账户数」，不依赖 `pricing` / `payment` 包）（spec 第 7 节「不满足返回 VALIDATION_FAILED 并指明缺什么」实现为该错误码，同时设置 `Params`（`missing`：`PUBLISHED` / `PRICE_RULE` / `PAYMENT_ACCOUNT`；`categories`：缺价格档的组别 code 列表，仅供日志与后端使用）和字段错误（错误响应体只下发 `fields`，前端据此显示原因）：`status` → `field.event_not_published`、`priceRules` → `field.missing_price_rule`（参数 `{categories}`，逗号分隔的组别 code）、`paymentAccounts` → `field.missing_payment_account`；见第 1 段契约补充第 2 条）。`PRICE_RULE_LOCKED`：已有占用时修改价格、人群或关联组别。`COUPON_CODE_TAKEN`：`coupons_code_key` 唯一约束。`CONSENT_INVALID`：同意书版本不存在、不是 REGISTRATION、或勾选项不完整。`ORDER_NOT_FOUND`：订单不存在或不属于当前跑者。

字段级错误文案 key（`messages.*.json` 的 `field.*`）：脚手架已有 `field.required`、`field.invalid`、`field.too_long`、`field.must_be_positive` 等，直接复用。新增的 key 只在一个任务里加，避免重复：Task 1–6 加 `field.coupon_code_format`、`field.ends_before_starts`、`field.event_not_published`、`field.missing_payment_account`、`field.missing_price_rule`、`field.percent_range`、`field.quota_below_taken`；Task 11–12 加 `field.too_young`（参数 `{minAge}`）、`field.category_unavailable`、`field.duplicate_id_no`、`field.already_registered`、`field.coupon_invalid`。

### 8. 权限（Task 2）

`internal/iam/matrix.go` 追加常量 `PermPriceConfig = "price_config"`、`PermCouponManage = "coupon_manage"`、`PermPaymentAccountManage = "payment_account_manage"`、`PermProofReview = "proof_review"`，追加到 `AllPermissions` 末尾，矩阵取值见 spec 第 8 节。`web/admin/src/auth/can.ts` 同步增加 `PERM_PRICE_CONFIG`、`PERM_COUPON_MANAGE`、`PERM_PAYMENT_ACCOUNT_MANAGE`、`PERM_PROOF_REVIEW`、`PERM_ORDER_VIEW`（若尚未导出）。

### 9. 审计 action

| action | 实体 | `IsFinancial` | 任务 |
|---|---|---|---|
| `event.registration_update` | event | false | 3 |
| `price_rule.create` / `price_rule.update` | price_rule | false | 4 |
| `coupon.create` / `coupon.update` | coupon | false | 5 |
| `payment_account.create` / `payment_account.update` | payment_account | true | 6 |
| `runner.login` | user | false | 7 |
| `consent.publish` | disclaimer_version（`EntityID` 取 0） | false | 9 |
| `reg_order.create` / `reg_order.paid_zero` | reg_order | true | 12 |
| `reg_order.cancel` | reg_order | true | 13 |
| `payment_proof.submit` | payment_proof | true | 15 |
| `payment_proof.approve` / `payment_proof.reject` | payment_proof | true | 17 |
| `reg_order.expire` | reg_order（`ActorType = "SYSTEM"`） | true | 21 |
| `free_signup.create` | free_signup | false | 22 |

跑者发起的操作 `ActorType = "USER"`、`ActorID = user.ID`。

### 10. 前端契约

**api-client**（Task 3、10）：

```ts
// packages/api-client/src/money.ts（Task 3）
export function formatUsd(cents: number): string;             // 2500 → "$25.00"；-5 → "-$0.05"
export function parseUsdToCents(input: string): number | null; // "25" | "25.5" | "25.50" → 2500 | 2550；非法或超过两位小数 → null
// ApiClientOptions 增加（Task 10）
getAuthToken?: () => string | null;       // 非空时设置 Authorization: Bearer
onUnauthorized?: () => void;              // 已有，保持
```

`index.ts` 导出 `formatUsd`、`parseUsdToCents`。

**用户端路由**（`web/user/src/routes.tsx`）：

| 路由 | 页面 | 任务 |
|---|---|---|
| `/profiles` | `ProfilesPage` | 10 |
| `/events/:slug/register` | `RegisterPage`（向导） | 14 |
| `/orders` | `OrdersPage` | 14 |
| `/orders/:orderNo` | `OrderDetailPage` | 14（Task 18 补全各状态） |
| `/orders/:orderNo/pay` | `PayPage` | 18 |
| `/orders/:orderNo/proof` | `ProofUploadPage` | 18 |
| `/events/:slug/free-signup` | `FreeSignupPage` | 22 |

需要登录的页面包在 `RequireRunner` 内：非 Telegram 环境且无开发登录参数时渲染 `open-in-telegram` 提示。

用户端会话（Task 10）：`sessionStorage` 键 `werun.appToken`（令牌）、`werun.appTokenExpiresAt`（ISO 时间）、`werun.devInitData`（开发登录参数）。`initData` 来源顺序：`window.Telegram?.WebApp?.initData` 非空 → `import.meta.env.DEV` 时 `?devInitData=`（读到后存入 `werun.devInitData`）→ `werun.devInitData`。收到 401 时清除令牌，用 `initData` 重新登录一次后重试原请求；仍失败则显示 `open-in-telegram`。

**后台路由**（`web/admin/src/routes.tsx`）：

| 路由 | 页面 | 权限 | 任务 |
|---|---|---|---|
| `/events/:id` | `EventDetailPage`（基本信息、报名开关、价格档与优惠码标签页） | `event_config` read | 3（Task 4、5 加标签页） |
| `/payment-accounts` | `PaymentAccountsPage` | `payment_account_manage` read | 6 |
| `/proofs` | `ProofsPage` | `proof_review` read | 19 |
| `/proofs/:id` | `ProofDetailPage` | `proof_review` read | 19 |
| `/orders` | `OrdersPage` | `order_view` read | 19 |
| `/orders/:id` | `OrderDetailPage` | `order_view` read | 19 |

菜单项在对应任务中加入 `AppLayout`，按权限显示。

**`data-testid` 约定**（端到端测试 Task 23 依赖，不得改名）：

后台（antd 表单另用 `Form name` 生成 id，下表列出 `name`）：

| 位置 | testid / 表单 |
|---|---|
| 赛事列表行进入详情 | `event-open-<slug>` |
| 报名开关 | `event-registration-switch`；保存 `event-registration-save`；未就绪提示 `event-registration-not-ready` |
| 标签页 | `event-tab-pricing`、`event-tab-coupons` |
| 价格档 | 新建按钮 `price-rule-create`；表单 `name="priceRule"`，字段 `name_zh`、`name_en`、`name_km`、`audience`、`priceUsd`、`quota`、`saleStartsAt`、`saleEndsAt`、`sortOrder`、`categoryIds`；提交 `price-rule-submit`；行 `price-rule-row-<id>` |
| 优惠码 | 新建按钮 `coupon-create`；表单 `name="coupon"`，字段 `code`、`discountType`、`discountValue`、`quota`、`minRunners`、`validFrom`、`validUntil`、`status`；提交 `coupon-submit`；行 `coupon-row-<CODE>` |
| 收款账户 | 新建 `payment-account-create`；表单 `name="paymentAccount"`，字段 `name`、`provider`、`accountName`、`accountNoMasked`、`scope`、`eventId`、`active`；二维码文件输入 `payment-account-qr-input`；提交 `payment-account-submit`；行 `payment-account-row-<id>` |
| 凭证队列 | 行 `proof-row-<proofNo>`（点击进入详情） |
| 凭证详情 | 状态 `proof-status`（`data-status` 属性为状态值）；截图 `proof-image`；通过按钮 `proof-approve-open`，表单 `name="approve"`，字段 `receivedUsd`、`receivedAt`，提交 `proof-approve-submit`；驳回按钮 `proof-reject-open`，表单 `name="reject"`，字段 `rejectCode`、`rejectReason`，提交 `proof-reject-submit` |
| 订单 | 行 `order-row-<orderNo>`；详情状态 `order-status`（`data-status`） |

用户端（原生表单元素，每个元素带 testid）：

| 位置 | testid |
|---|---|
| 未在 Telegram | `open-in-telegram` |
| 赛事详情 | 报名按钮 `register-button`（RACE）、`free-signup-button`（FREE_ACTIVITY） |
| 向导通用 | 下一步 `wizard-next`、上一步 `wizard-back`、表单错误汇总 `form-error` |
| 第 1 步 | 添加参赛人 `participant-add`；第 i 人（从 0 开始）组别 `participant-<i>-category`、选择常用参赛人 `participant-<i>-profile` |
| 第 2 步 | `participant-<i>-fullName`、`-gender`、`-birthDate`（`type="date"`）、`-nationality`、`-idType`、`-idNo`、`-phone`、`-email`、`-emergencyName`、`-emergencyPhone`、`-tshirtSize`、`-saveProfile` |
| 第 3 步 | 优惠码 `coupon-input`、应用 `coupon-apply`、原价 `quote-list-amount`、优惠 `quote-discount`、应付 `quote-amount`、同意书勾选 `consent-item-<key>`、提交 `order-submit` |
| 付款页 | 二维码 `pay-qr`、应付 `pay-amount`、订单号 `pay-order-no`、倒计时 `pay-countdown`、去上传 `pay-upload-link` |
| 上传页 | 文件 `proof-file-input`、交易号 `proof-txn-ref`、金额 `proof-amount`、付款时间 `proof-paid-at`、提交 `proof-submit` |
| 订单详情 | 状态 `order-status`（`data-status`）、驳回原因 `order-reject-reason`、重新上传 `order-reupload`、去付款 `order-pay`、取消 `order-cancel`、参赛凭证 `order-ticket-qr` |
| 我的订单 | `order-item-<orderNo>` |
| 免费报名 | 组别 `free-category`、`free-fullName`、`free-phone`、`free-emergencyName`、`free-emergencyPhone`、`free-gender`、`free-birthDate`、同意书 `consent-item-<key>`、提交 `free-submit`、完成 `free-signup-done` |

**前端文案命名空间**：后台 `admin.eventDetail.*`、`admin.pricing.*`、`admin.coupons.*`、`admin.paymentAccounts.*`、`admin.proofs.*`、`admin.orders.*`；用户端 `user.auth.*`、`user.profiles.*`、`user.register.*`、`user.orders.*`、`user.pay.*`、`user.proof.*`、`user.free.*`；错误码文案沿用 `errors.<CODE>`。

### 11. 端到端环境（Task 1、23）

- CI 与本地 compose 的 `.env` 增加：`WERUN_TELEGRAM_BOT_TOKEN=123456:e2e-test-token`、`WERUN_TELEGRAM_BOT_USERNAME=werun_e2e_bot`、`WERUN_TELEGRAM_SEND=off`、`WERUN_APP_BASE_URL=http://werun.localhost`（Task 1 写入 `.env.example`、`deploy/compose.yaml`、`.github/workflows/ci.yml`）。
- Playwright 环境变量：`E2E_TELEGRAM_BOT_TOKEN`（默认 `123456:e2e-test-token`）、`E2E_FINANCE_PASSWORD`（默认 `e2e-Finance-Password-1`）。
- `e2e/scripts/seed-staff.sh` 增加 `finance.e2e`（FINANCE）；`e2e/scripts/seed-consent.sh` 发布 `REG-E2E-v1` 三语同意书，勾选项 key 为 `rules`、`health`、`terms`。

---

## 执行说明

- 数据库测试需要 Docker；本机为 colima 时设置 `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock` 与 `TESTCONTAINERS_RYUK_DISABLED=true`。
- 本机 Node ≥ 25 时，jsdom 测试脚本需带 `NODE_OPTIONS=--no-experimental-webstorage`（已写在各包 `test` 脚本里）。
- 后台 antd 表单的组件测试用 `userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })` 并用 `paste` 填值（见 `web/admin/src/app.test.tsx`），否则在 CI 上会超时。
- 并发测试用 `sync.WaitGroup` 同时启动 goroutine，每个 goroutine 各自调用服务方法（各自开事务），断言成功次数与最终计数；并发用例在本机连续运行 5 次（`go test -count=5 -run <名字>`）确认稳定后再提交。

---

## 各段契约补充索引

各分段文件开头的「契约补充」是对本文件契约的增补，与本文件同等约束。执行某个任务前，先读该任务所在分段的契约补充。以下为一行摘要，细节以分段文件为准。

**第 1 段（Task 1–6）**：`Config.PIIKeyBytes()` 保持 `([]byte, error)`；`REGISTRATION_NOT_READY` 以字段错误表达缺项（可含未发布）；新增 7 个 `field.*` 文案 key；`AdminEvent` 增加时区与报名字段；新增 schema 与 multipart part 名；`event` 服务新增方法；存储常量与 `FILE_TOO_LARGE` 参数 `{maxMB}`；`ListCoupons` 过滤规则；`Cache-Control` 通过 gin 上下文设置；`idgen.Retry` 在事务内使用时必须包在保存点里；`payment.NewService` 在 Task 6 为 3 个参数。

**第 2 段（Task 7–10）**：`BearerToken`、`SessionTTL`；停用的跑者登录返回 403；`dev-initdata` 输出字段；`runner.NormalizeProfile`；OpenAPI schema 名（`AppLoginRequest`、`AppSession`、`AppUser`、`ProfileInput`、`RunnerProfile`、`RunnerProfileList`、`ConsentVersion`、`ConsentItem`、`Gender`、`IdType`、`TShirtSize`）；同意书版本重复返回 422 `VALIDATION_FAILED`（字段 `version`）；「今天」按 UTC+7，文本回退 en → zh；`publish-consent --items` 元素格式 `{"k","t","d"}`；构建期变量 `VITE_TELEGRAM_BOT_USERNAME`（Dockerfile、compose、CI 同步）；`createUserApp`、`AuthController`、`renderApp` 新选项；开发登录参数只在 DEV 生效；`telegram.ts` 调整；可复用的 `ProfileFields` 组件与参赛人页 testid；同意书 purpose 常量。`RequireRunner` 渲染 `children ?? <Outlet />`，既可包裹页面也可作布局路由。

**第 3 段（Task 11–14）**：`CATEGORY_SOLD_OUT`、`PRICE_TIER_SOLD_OUT` 在 Task 11 引入，`ORDER_STATE_CONFLICT` 在 Task 12 引入；`field.*` 文案 key 的归属任务；测试专用包 `internal/testfixture`；幂等重放存储三语 `OrderDetail` JSON；固定加锁顺序，赛事行用 `FOR SHARE`；`pricing` 查询名加前缀；新增 OpenAPI schema 名；`App` 中 `Registration` 在 `Payment` 之前构造（Task 12 不改 `payment.NewService`）；前端依赖第 2 段的数据形状。

**第 4 段（Task 15–19）**：新增 `payment.OpenProofFile`（只打开 `PAYMENT_PROOF` 私有文件）与 `registration.AdminOrderDetailToAPI`；`ConfirmPaid` 接受 `PROOF_SUBMITTED` 状态的订单；测试辅助包 `internal/payment/paytest`；`idgen.Retry` 的 `fn` 内自开保存点；`appSubmitProof` 返回 201，通过与驳回返回 200；`RECEIVED_AMOUNT_TOO_LOW` 带参数 `amountDue`；凭证队列行带 `data-over-sla`，审核弹窗另有 `proof-approve-too-low` 提示与 `note` 字段，订单页有 `order-filter-submit`、`order-ident-offset`、`order-amount`。

**第 5 段（Task 20–21）**：推送参数中 `i18n.Text` 与 `notify.RejectReason` 按跑者语言渲染；`notify.FormatTime`；新增常量与 JSON 字段名；`notification_logs` 各列取值，`Enqueue` 缺 `orderNo` 参数时报错；测试辅助包 `internal/notify/notifytest`、`internal/registration/regtest`；`newNotifySender` 与 `App.JobDeps()`；`reminded` 只统计新入队的提醒。

**第 6 段（Task 22–23）**：`runner.ContactFields` 与 `runner.ValidateContactFields`（Task 22 新增）；免费报名的 sqlc 查询名，`free_signups_one_active` 映射 `ALREADY_REGISTERED`；事务内先写报名行再签同意书（外键顺序）；schema `FreeSignupConsent`、`FreeSignupRequest`、`FreeSignup`；`FreeSignupPage` 的 `form-error` 带 `data-code`；端到端测试按选项值选择 antd `Select`，并断言应付金额比算价预览少 1–50 分；新增 `e2e/tests/runner-auth.spec.ts`。

