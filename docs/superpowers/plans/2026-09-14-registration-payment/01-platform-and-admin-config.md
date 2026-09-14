# 第 1 段：平台与后台配置（Task 1–6）

> `00-overview.md` 的 **Global Constraints**、**与 spec 的实现调整**、**跨任务契约**、**执行说明** 对本文件每个任务都生效。下文 Interfaces 中抄录的签名与契约一致；本段对契约的补充见下一节，同样对后续段落生效。

## 契约补充

实现本段时发现契约缺少或无法照写的地方，逐条补充如下（后续段落以此为准）：

1. **`Config.PIIKeyBytes` 保持现有签名 `func (c Config) PIIKeyBytes() ([]byte, error)`。** 脚手架已实现该方法并在 `Load` 里用它校验密钥；改成无错误返回值需要改动已上线的校验代码且没有收益。`Load` 成功后调用方可以放心忽略错误（`key, _ := cfg.PIIKeyBytes()` 不推荐，`Bootstrap` 里仍检查）。
2. **`REGISTRATION_NOT_READY` 额外携带字段错误。** 错误响应体（`httpx.ErrorBody`）只有 `code`、`message`、`fields`，`Params` 不会下发，前端拿不到 `missing` / `categories`。因此除 `Params`（`missing []string`、`categories []string`）外同时附带字段错误：`status` → `field.event_not_published`；`priceRules` → `field.missing_price_rule`（参数 `{categories}`，值为逗号分隔的组别 code）；`paymentAccounts` → `field.missing_payment_account`。赛事未发布时 `missing` 含 `PUBLISHED`（契约原文只列了 `PRICE_RULE`、`PAYMENT_ACCOUNT`）。
3. **新增字段文案 key**（写入 `messages.{zh,en,km}.json` 与 `catalog_test.go`）：`field.event_not_published`、`field.missing_price_rule`、`field.missing_payment_account`、`field.ends_before_starts`（结束时间必须晚于开始时间，报名时间、销售时间、优惠码有效期共用）、`field.quota_below_taken`（参数 `{min}`）、`field.coupon_code_format`、`field.percent_range`。
4. **`AdminEvent` schema 增加 4 个必填属性**：`timezone`（string）、`registrationOpen`（boolean）、`registrationOpensAt`、`registrationClosesAt`（date-time，nullable）。`adminGetEvent` 与 `adminUpdateEventRegistration` 都返回 `AdminEvent`；请求体 schema 为 `UpdateEventRegistrationRequest{open, opensAt?, closesAt?}`。
5. **本段新增的 OpenAPI schema 名**：`PriceAudience`、`PriceRule`、`PriceRuleInput`、`PriceRuleList`、`DiscountType`、`CouponStatus`、`Coupon`、`CreateCouponRequest`、`UpdateCouponRequest`（没有 `code`，优惠码不可改）、`CouponList`、`PaymentProvider`、`PaymentAccountScope`、`PaymentAccount`、`PaymentAccountList`。收款账户 multipart 的文本 part 名：`name`、`provider`、`accountName`、`accountNoMasked`、`scope`、`eventId`（空串或缺省 = 全局）、`active`（`true` / `false`）；文件 part 名 `qr`。
6. **`event` 包新增**：`type RegistrationInput struct{ Open bool; OpensAt, ClosesAt *time.Time }`、`(*Service).GetAdmin(ctx, id int64) (Event, error)`、`(*Service).UpdateRegistration(ctx, actor iam.Staff, id int64, in RegistrationInput) (Event, error)`；`event.Event` 增加 `Timezone string`、`RegistrationOpen bool`、`RegistrationOpensAt *time.Time`、`RegistrationClosesAt *time.Time`。
7. **`storage` 常量**：`VisibilityPublic = "PUBLIC"`、`VisibilityPrivate = "PRIVATE"`、`PurposePaymentProof = "PAYMENT_PROOF"`、`PurposePaymentQR = "PAYMENT_QR"`。`Disk` 拒绝不是本地相对路径的 key（`filepath.IsLocal`）。`ReadImage` 读到 `*http.MaxBytesError` 时同样返回 `FILE_TOO_LARGE`。`FILE_TOO_LARGE` 文案带参数 `{maxMB}`。
8. **`pricing.ListCoupons(ctx, eventID)`**：`eventID` 非 nil 时只返回 `event_id` 等于它的优惠码；nil 时返回全部。`pricing` 与 `payment` 包各自声明 `Handlers` / `NewHandlers(svc *Service) *Handlers`，在 `httpapi/server.go` 以别名 `PricingHandlers`、`PaymentHandlers` 嵌入。
9. **`getPublicFile` 的 `Cache-Control`** 由 handler 通过 `httpx.Gin(ctx)` 设置响应头（不在 OpenAPI 声明响应头，这样生成类型保持 `GetPublicFile200ImageResponse{Body, ContentType, ContentLength}`）。
10. **`idgen.Retry` 在事务内使用时**，`fn` 必须在保存点里执行插入（`tx.Begin(ctx)` 得到嵌套事务），否则唯一冲突会让外层事务进入 aborted 状态，重试必然失败。本段不使用 `Retry`，只在文档注释中写明。
11. **`payment.NewService` 分三步演进**：Task 6 为 `NewService(pool *pgxpool.Pool, files storage.Store, now func() time.Time)`（`payment` 此时不能依赖尚不存在的 `registration`）；Task 15 改为契约中的 `NewService(pool, files, orders, now)`；Task 20 再加 `notifier`。改签名的任务负责同步修改 `cmd/werun/app.go` 与 `api/internal/httpapi/events_http_test.go` 中的调用。

---

### Task 1: 平台包与配置

**Files:**
- Modify: `api/go.mod`、`api/go.sum`（`golang.org/x/image`）
- Create: `api/internal/platform/storage/storage.go`
- Create: `api/internal/platform/storage/key.go`
- Create: `api/internal/platform/storage/disk.go`
- Create: `api/internal/platform/storage/image.go`
- Create: `api/internal/platform/storage/files.go`
- Create: `api/db/queries/storage.sql`
- Modify: `api/sqlc.yaml`（追加 storage 块）
- Generate: `api/internal/platform/storage/store/`（sqlc）
- Test: `api/internal/platform/storage/key_test.go`、`disk_test.go`、`image_test.go`、`files_test.go`
- Create: `api/internal/platform/piicrypt/piicrypt.go`；Test: `api/internal/platform/piicrypt/piicrypt_test.go`
- Create: `api/internal/platform/idgen/idgen.go`；Test: `api/internal/platform/idgen/idgen_test.go`
- Create: `api/internal/platform/settings/settings.go`；Test: `api/internal/platform/settings/settings_test.go`
- Modify: `api/internal/platform/config/config.go`、`api/internal/platform/config/config_test.go`
- Modify: `api/internal/platform/apperr/apperr.go`、`api/internal/platform/apperr/apperr_test.go`
- Modify: `api/internal/platform/i18n/messages.zh.json`、`messages.en.json`、`messages.km.json`
- Modify: `api/internal/httpapi/router.go`、`api/internal/httpapi/router_test.go`；Create: `api/internal/httpapi/bodylimit_test.go`
- Modify: `api/internal/jobs/jobs.go`、`api/internal/jobs/jobs_test.go`
- Modify: `api/cmd/werun/app.go`、`api/cmd/werun/serve.go`、`api/cmd/werun/worker.go`
- Modify: `.env.example`、`deploy/compose.yaml`、`.github/workflows/ci.yml`

**Interfaces:**
- Consumes：`apperr.New / WithParams / Wrap`、`db.InTx`、`dbtest.NewPool`、`riverpgxv5.New`、`river.NewClient`、`caarlos0/env`
- Produces（抄自契约 §1）：

```go
// storage
type Store interface {
	Put(ctx context.Context, key string, r io.Reader) error
	Open(ctx context.Context, key string) (io.ReadCloser, error) // 不存在时返回 ErrNotFound
	Delete(ctx context.Context, key string) error               // 不存在时返回 nil
}
var ErrNotFound = errors.New("storage: not found")
func NewDisk(root string) (*Disk, error)
func NewKey(now time.Time, ext string) string
type Image struct { Data []byte; MIME, Ext string; SHA256 [32]byte; Width, Height int }
func ReadImage(r io.Reader, maxBytes int64) (Image, error)
type FileRecord struct { StorageKey, Visibility, Purpose string; Image Image; UploadedByType string; UploadedByID int64 }
type File struct { ID int64; StorageKey, Visibility, MIME string; SizeBytes int64; SHA256 []byte }
func InsertFile(ctx context.Context, tx pgx.Tx, rec FileRecord) (int64, error)
func GetFile(ctx context.Context, q store.DBTX, id int64) (File, error)
func CountOtherFilesWithSHA256(ctx context.Context, tx pgx.Tx, sha []byte, purpose string, excludeID int64) (int64, error)
const MaxProofBytes = 5 << 20
const MaxQRBytes = 2 << 20

// piicrypt
func New(key []byte) (*Cipher, error)
func NormalizeIDNo(s string) string
func (c *Cipher) Encrypt(plain string) ([]byte, error)
func (c *Cipher) Decrypt(sealed []byte) (string, error)
func (c *Cipher) Hash(normalized string) []byte
func MaskIDNo(normalized string) string

// idgen
const (PrefixOrder = "WR"; PrefixProof = "PF"; PrefixRegistration = "RG"; PrefixFreeSignup = "FS"; PrefixException = "EX")
func Code(prefix string) string
func TicketCode() string
func Retry(constraint string, fn func() error) error

// config
TelegramBotToken    string `env:"WERUN_TELEGRAM_BOT_TOKEN,required"`
TelegramBotUsername string `env:"WERUN_TELEGRAM_BOT_USERNAME,required"`
TelegramSend        string `env:"WERUN_TELEGRAM_SEND"`
AppBaseURL          string `env:"WERUN_APP_BASE_URL,required"`
func (c Config) TelegramSendEnabled() bool
func (c Config) PIIKeyBytes() ([]byte, error) // 契约补充 1

// settings
type Payment struct { UploadWindow, ReuploadWindow, ReviewSLA time.Duration; IdentOffsetMaxCents int64 }
func LoadPayment(ctx context.Context, q interface{ QueryRow(context.Context, string, ...any) pgx.Row }) (Payment, error)

// jobs
type Deps struct { Pool *pgxpool.Pool; Log *slog.Logger; Sessions SessionCleaner }
func NewClient(d Deps) (*river.Client[pgx.Tx], error)
func NewInserter(pool *pgxpool.Pool) (*river.Client[pgx.Tx], error)

// httpapi（包内）
func bodyLimitFor(path string) int64

// apperr
CodeFileTooLarge = "FILE_TOO_LARGE"             // 413
CodeFileTypeNotAllowed = "FILE_TYPE_NOT_ALLOWED" // 415

// cmd/werun App 新字段
Store    storage.Store
PII      *piicrypt.Cipher
Inserter *river.Client[pgx.Tx]
```

- [ ] **Step 1: 引入 `golang.org/x/image`**

先查最新补丁版本，再锁定（写本计划时为 `v0.43.0`，已在 `go.sum` 中作为间接依赖出现）：

```bash
cd api && go list -m -versions golang.org/x/image | tr ' ' '\n' | tail -1
cd api && go get golang.org/x/image@v0.43.0   # 若上一条输出更新的版本，用那个版本
```

Expected：`api/go.mod` 的第一个 `require` 块出现 `golang.org/x/image v0.43.0`（`go mod tidy` 会在 Step 6 后把它从 indirect 移到直接依赖）。

- [ ] **Step 2: 写 `apperr` 与文案的失败测试**

修改 `api/internal/platform/apperr/apperr_test.go` 的 `TestAllCodesAreUnique` 末尾：

```go
	assert.Len(t, apperr.AllCodes, 16)
```

改为：

```go
	assert.Len(t, apperr.AllCodes, 18)
	assert.Contains(t, apperr.AllCodes, apperr.CodeFileTooLarge)
	assert.Contains(t, apperr.AllCodes, apperr.CodeFileTypeNotAllowed)
```

Run: `cd api && go test ./internal/platform/apperr/`
Expected: 编译失败，`undefined: apperr.CodeFileTooLarge`。

- [ ] **Step 3: 实现错误码与三语文案**

`api/internal/platform/apperr/apperr.go` 常量块末尾：

```go
	CodeEventCategoryIncomplete = "EVENT_CATEGORY_INCOMPLETE"
)
```

改为：

```go
	CodeEventCategoryIncomplete = "EVENT_CATEGORY_INCOMPLETE"
	CodeFileTooLarge            = "FILE_TOO_LARGE"
	CodeFileTypeNotAllowed      = "FILE_TYPE_NOT_ALLOWED"
)
```

`AllCodes` 末尾：

```go
	CodeEventCategoryIncomplete,
}
```

改为：

```go
	CodeEventCategoryIncomplete,
	CodeFileTooLarge,
	CodeFileTypeNotAllowed,
}
```

`api/internal/platform/i18n/messages.zh.json`，在 `"EVENT_CATEGORY_INCOMPLETE"` 一行之后插入：

```json
  "FILE_TOO_LARGE": "文件太大，不能超过 {maxMB} MB。",
  "FILE_TYPE_NOT_ALLOWED": "只支持 JPG、PNG 或 WebP 图片。",
```

`messages.en.json` 同一位置插入：

```json
  "FILE_TOO_LARGE": "The file is too large. The limit is {maxMB} MB.",
  "FILE_TYPE_NOT_ALLOWED": "Only JPG, PNG or WebP images are allowed.",
```

`messages.km.json` 同一位置插入：

```json
  "FILE_TOO_LARGE": "ឯកសារធំពេក។ ទំហំអតិបរមាគឺ {maxMB} MB។",
  "FILE_TYPE_NOT_ALLOWED": "អនុញ្ញាតតែរូបភាព JPG, PNG ឬ WebP ប៉ុណ្ណោះ។",
```

Run: `cd api && go test ./internal/platform/apperr/ ./internal/platform/i18n/`
Expected: PASS（`TestEmbeddedCatalogCoversAllCodesAndFieldKeys` 自动覆盖新错误码）。

- [ ] **Step 4: 写 `piicrypt` 与 `idgen` 的失败测试**

创建 `api/internal/platform/piicrypt/piicrypt_test.go`：

```go
package piicrypt_test

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/piicrypt"
)

var testKey = []byte("dev-only-pii-key-32-bytes-000000")

func newCipher(t *testing.T) *piicrypt.Cipher {
	t.Helper()
	c, err := piicrypt.New(testKey)
	require.NoError(t, err)
	return c
}

func TestNewRejectsWrongKeyLength(t *testing.T) {
	_, err := piicrypt.New(testKey[:31])
	require.Error(t, err)
	_, err = piicrypt.New(append(bytes.Clone(testKey), 'x'))
	require.Error(t, err)
}

func TestNormalizeIDNo(t *testing.T) {
	cases := map[string]string{
		"n 123-456 789":   "N123456789",
		"\tab-12 cd ": "AB12CD",
		"E1234567":        "E1234567",
		"":                "",
	}
	for in, want := range cases {
		assert.Equal(t, want, piicrypt.NormalizeIDNo(in), "%q", in)
	}
}

func TestEncryptDecryptRoundTrip(t *testing.T) {
	c := newCipher(t)

	first, err := c.Encrypt("N123456789")
	require.NoError(t, err)
	second, err := c.Encrypt("N123456789")
	require.NoError(t, err)

	assert.NotEqual(t, first, second, "随机 nonce：同一明文两次加密结果不同")
	assert.Len(t, first, 12+len("N123456789")+16, "12 字节 nonce + 密文 + 16 字节 GCM 标签")
	plain, err := c.Decrypt(first)
	require.NoError(t, err)
	assert.Equal(t, "N123456789", plain)
}

func TestDecryptRejectsTamperedOrShortInput(t *testing.T) {
	c := newCipher(t)
	sealed, err := c.Encrypt("N123456789")
	require.NoError(t, err)

	tampered := bytes.Clone(sealed)
	tampered[len(tampered)-1] ^= 0x01
	_, err = c.Decrypt(tampered)
	require.Error(t, err)

	_, err = c.Decrypt(sealed[:10])
	require.Error(t, err)

	other, err := piicrypt.New([]byte("another-pii-key-32-bytes-0000000"))
	require.NoError(t, err)
	_, err = other.Decrypt(sealed)
	require.Error(t, err)
}

func TestHashUsesDerivedHMACKey(t *testing.T) {
	c := newCipher(t)

	derive := sha256.New()
	derive.Write([]byte("werun/pii-hash/v1"))
	derive.Write(testKey)
	mac := hmac.New(sha256.New, derive.Sum(nil))
	mac.Write([]byte("N123456789"))

	got := c.Hash("N123456789")

	assert.Len(t, got, 32)
	assert.Equal(t, mac.Sum(nil), got)
	assert.Equal(t, got, c.Hash("N123456789"), "同一输入哈希稳定")
	assert.NotEqual(t, got, c.Hash("N123456788"))
}

func TestMaskIDNo(t *testing.T) {
	assert.Equal(t, "******6789", piicrypt.MaskIDNo("N123456789"))
	assert.Equal(t, "********1234", piicrypt.MaskIDNo("AB1234561234"))
	assert.Equal(t, "*1234", piicrypt.MaskIDNo("A1234"))
	assert.Equal(t, "****", piicrypt.MaskIDNo("1234"))
	assert.Equal(t, "**", piicrypt.MaskIDNo("12"))
	assert.Equal(t, "", piicrypt.MaskIDNo(""))
}
```

创建 `api/internal/platform/idgen/idgen_test.go`：

```go
package idgen_test

import (
	"errors"
	"fmt"
	"regexp"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/idgen"
)

func TestCodeFormat(t *testing.T) {
	pattern := regexp.MustCompile(`^WR[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$`)
	seen := map[string]bool{}
	for range 200 {
		code := idgen.Code(idgen.PrefixOrder)
		require.Regexp(t, pattern, code)
		seen[code] = true
	}
	assert.Greater(t, len(seen), 195, "40 位随机数，200 次几乎不可能大量重复")
	assert.Regexp(t, `^FS[0-9A-Z]{8}$`, idgen.Code(idgen.PrefixFreeSignup))
	assert.Equal(t, []string{"WR", "PF", "RG", "FS", "EX"},
		[]string{idgen.PrefixOrder, idgen.PrefixProof, idgen.PrefixRegistration, idgen.PrefixFreeSignup, idgen.PrefixException})
}

func TestTicketCodeFormat(t *testing.T) {
	code := idgen.TicketCode()
	assert.Regexp(t, `^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{32}$`, code)
	assert.NotEqual(t, code, idgen.TicketCode())
}

func uniqueViolation(constraint string) error {
	return fmt.Errorf("insert: %w", &pgconn.PgError{Code: "23505", ConstraintName: constraint})
}

func TestRetryRetriesMatchingUniqueViolation(t *testing.T) {
	calls := 0
	err := idgen.Retry("reg_orders_order_no_key", func() error {
		calls++
		if calls < 3 {
			return uniqueViolation("reg_orders_order_no_key")
		}
		return nil
	})

	require.NoError(t, err)
	assert.Equal(t, 3, calls)
}

func TestRetryGivesUpAfterThreeAttempts(t *testing.T) {
	calls := 0
	err := idgen.Retry("reg_orders_order_no_key", func() error {
		calls++
		return uniqueViolation("reg_orders_order_no_key")
	})

	var pgErr *pgconn.PgError
	require.ErrorAs(t, err, &pgErr)
	assert.Equal(t, "reg_orders_order_no_key", pgErr.ConstraintName)
	assert.Equal(t, 3, calls)
}

func TestRetryReturnsOtherErrorsImmediately(t *testing.T) {
	for name, returned := range map[string]error{
		"其他约束":     uniqueViolation("payment_proofs_txn_ref_uniq"),
		"非唯一冲突":    &pgconn.PgError{Code: "23514", ConstraintName: "reg_orders_order_no_key"},
		"普通错误":     errors.New("boom"),
	} {
		t.Run(name, func(t *testing.T) {
			calls := 0
			err := idgen.Retry("reg_orders_order_no_key", func() error {
				calls++
				return returned
			})
			assert.ErrorIs(t, err, returned)
			assert.Equal(t, 1, calls)
		})
	}
}
```

Run: `cd api && go test ./internal/platform/piicrypt/ ./internal/platform/idgen/`
Expected: 编译失败，`no non-test Go files` / `undefined: piicrypt.New`、`undefined: idgen.Code`。

- [ ] **Step 5: 实现 `piicrypt` 与 `idgen`**

创建 `api/internal/platform/piicrypt/piicrypt.go`：

```go
// Package piicrypt 加密与哈希个人证件号：AES-256-GCM（随机 12 字节 nonce 前置）与 HMAC-SHA256。
package piicrypt

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
	"unicode"
)

const hashKeyLabel = "werun/pii-hash/v1"

// Cipher 持有加密器与派生出的哈希密钥，可并发使用。
type Cipher struct {
	aead    cipher.AEAD
	hashKey []byte
}

// New 用 32 字节密钥（WERUN_PII_KEY 解码后）创建 Cipher。
// 哈希密钥 = SHA-256("werun/pii-hash/v1" || key)，与加密密钥分离。
func New(key []byte) (*Cipher, error) {
	if len(key) != 32 {
		return nil, fmt.Errorf("piicrypt: key must be 32 bytes, got %d", len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("piicrypt: new aes cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("piicrypt: new gcm: %w", err)
	}
	h := sha256.New()
	h.Write([]byte(hashKeyLabel))
	h.Write(key)
	return &Cipher{aead: aead, hashKey: h.Sum(nil)}, nil
}

// NormalizeIDNo 去掉所有空白与连字符并转大写。加密、哈希、打码都使用规范化后的值。
func NormalizeIDNo(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if unicode.IsSpace(r) || r == '-' {
			continue
		}
		b.WriteRune(unicode.ToUpper(r))
	}
	return b.String()
}

// Encrypt 返回 nonce || 密文 || GCM 标签。
func (c *Cipher) Encrypt(plain string) ([]byte, error) {
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("piicrypt: read nonce: %w", err)
	}
	return c.aead.Seal(nonce, nonce, []byte(plain), nil), nil
}

// Decrypt 解开 Encrypt 的输出；数据被篡改或密钥不同时返回错误。
func (c *Cipher) Decrypt(sealed []byte) (string, error) {
	n := c.aead.NonceSize()
	if len(sealed) < n+c.aead.Overhead() {
		return "", errors.New("piicrypt: sealed data too short")
	}
	plain, err := c.aead.Open(nil, sealed[:n], sealed[n:], nil)
	if err != nil {
		return "", fmt.Errorf("piicrypt: decrypt: %w", err)
	}
	return string(plain), nil
}

// Hash 返回 32 字节 HMAC-SHA256，用于按证件号查重。参数应已规范化。
func (c *Cipher) Hash(normalized string) []byte {
	mac := hmac.New(sha256.New, c.hashKey)
	mac.Write([]byte(normalized))
	return mac.Sum(nil)
}

// MaskIDNo 只保留后 4 位，其余替换为 *；长度不超过 4 时全部为 *。
func MaskIDNo(normalized string) string {
	runes := []rune(normalized)
	if len(runes) <= 4 {
		return strings.Repeat("*", len(runes))
	}
	return strings.Repeat("*", len(runes)-4) + string(runes[len(runes)-4:])
}
```

创建 `api/internal/platform/idgen/idgen.go`：

```go
// Package idgen 生成对外展示的业务编号（Crockford Base32）。
package idgen

import (
	"crypto/rand"
	"encoding/base32"
	"errors"

	"github.com/jackc/pgx/v5/pgconn"
)

const (
	PrefixOrder        = "WR"
	PrefixProof        = "PF"
	PrefixRegistration = "RG"
	PrefixFreeSignup   = "FS"
	PrefixException    = "EX"
)

const maxAttempts = 3

var crockford = base32.NewEncoding("0123456789ABCDEFGHJKMNPQRSTVWXYZ").WithPadding(base32.NoPadding)

// Code 返回 prefix + 8 位 Crockford Base32（40 位随机数）。
func Code(prefix string) string {
	var b [5]byte
	_, _ = rand.Read(b[:]) // crypto/rand.Read 不会返回错误
	return prefix + crockford.EncodeToString(b[:])
}

// TicketCode 返回 20 字节随机数的 Crockford Base32（32 位）。
func TicketCode() string {
	var b [20]byte
	_, _ = rand.Read(b[:])
	return crockford.EncodeToString(b[:])
}

// Retry 调用 fn 最多 3 次；fn 返回的错误是 PostgreSQL 唯一约束冲突（23505）且约束名等于
// constraint 时重试，否则原样返回。第 3 次仍冲突时返回最后一次的错误。
//
// 在事务里使用时，fn 必须在保存点（tx.Begin 得到的嵌套事务）内执行插入：
// 唯一冲突会让所在事务进入 aborted 状态，不用保存点的话重试一定失败。
func Retry(constraint string, fn func() error) error {
	var err error
	for range maxAttempts {
		err = fn()
		if !isUniqueViolation(err, constraint) {
			return err
		}
	}
	return err
}

func isUniqueViolation(err error, constraint string) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == constraint
}
```

Run: `cd api && go test ./internal/platform/piicrypt/ ./internal/platform/idgen/ -v`
Expected: PASS；`TestRetryReturnsOtherErrorsImmediately` 3 个子测试通过。

- [ ] **Step 6: 写 `storage` 纯函数的失败测试**

创建 `api/internal/platform/storage/key_test.go`：

```go
package storage_test

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"

	"werun/api/internal/platform/storage"
)

func TestNewKeyUsesUTCYearMonthAndRandomHex(t *testing.T) {
	// 金边时间 10 月 1 日 03:00 = UTC 9 月 30 日 20:00
	now := time.Date(2026, 10, 1, 3, 0, 0, 0, time.FixedZone("ICT", 7*3600))

	key := storage.NewKey(now, "png")

	assert.Regexp(t, `^2026/09/[0-9a-f]{32}\.png$`, key)
	assert.NotEqual(t, key, storage.NewKey(now, "png"))
}
```

创建 `api/internal/platform/storage/disk_test.go`：

```go
package storage_test

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/storage"
)

func TestNewDiskCreatesRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "nested", "files")

	_, err := storage.NewDisk(root)

	require.NoError(t, err)
	info, err := os.Stat(root)
	require.NoError(t, err)
	assert.True(t, info.IsDir())

	_, err = storage.NewDisk("")
	assert.Error(t, err)
}

func TestDiskPutOpenDelete(t *testing.T) {
	root := t.TempDir()
	disk, err := storage.NewDisk(root)
	require.NoError(t, err)
	ctx := context.Background()
	var _ storage.Store = disk

	require.NoError(t, disk.Put(ctx, "2026/09/abc.png", strings.NewReader("first")))
	require.NoError(t, disk.Put(ctx, "2026/09/abc.png", strings.NewReader("second")))

	rc, err := disk.Open(ctx, "2026/09/abc.png")
	require.NoError(t, err)
	body, err := io.ReadAll(rc)
	require.NoError(t, err)
	require.NoError(t, rc.Close())
	assert.Equal(t, "second", string(body))

	entries, err := os.ReadDir(filepath.Join(root, "2026", "09"))
	require.NoError(t, err)
	assert.Len(t, entries, 1, "临时文件已经 rename，不留残余")

	require.NoError(t, disk.Delete(ctx, "2026/09/abc.png"))
	_, err = disk.Open(ctx, "2026/09/abc.png")
	assert.ErrorIs(t, err, storage.ErrNotFound)
	assert.NoError(t, disk.Delete(ctx, "2026/09/abc.png"), "删除不存在的文件返回 nil")
}

func TestDiskRejectsKeysOutsideRoot(t *testing.T) {
	disk, err := storage.NewDisk(t.TempDir())
	require.NoError(t, err)
	ctx := context.Background()

	for _, key := range []string{"", "../escape.png", "/etc/passwd", "2026/../../x.png"} {
		assert.Error(t, disk.Put(ctx, key, strings.NewReader("x")), key)
		_, err := disk.Open(ctx, key)
		assert.Error(t, err, key)
		assert.NotErrorIs(t, err, storage.ErrNotFound, key)
	}
}
```

创建 `api/internal/platform/storage/image_test.go`：

```go
package storage_test

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/storage"
)

// 1×1 无损 WebP（34 字节）
var tinyWebP = []byte("RIFF\x1a\x00\x00\x00WEBPVP8L\x0d\x00\x00\x00\x2f\x00\x00\x00\x10\x07\x10\x11\x11\x88\x88\xfe\x07\x00")

func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, img))
	return buf.Bytes()
}

func jpegBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	require.NoError(t, jpeg.Encode(&buf, image.NewGray(image.Rect(0, 0, w, h)), nil))
	return buf.Bytes()
}

func requireAppErr(t *testing.T, err error, code string, status int) {
	t.Helper()
	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	assert.Equal(t, code, ae.Code)
	assert.Equal(t, status, ae.Status)
}

func TestReadImageAcceptsJPEGPNGWebP(t *testing.T) {
	cases := []struct {
		name          string
		data          []byte
		mime, ext     string
		width, height int
	}{
		{"png", pngBytes(t, 3, 2), "image/png", "png", 3, 2},
		{"jpeg", jpegBytes(t, 4, 5), "image/jpeg", "jpg", 4, 5},
		{"webp", tinyWebP, "image/webp", "webp", 1, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			img, err := storage.ReadImage(bytes.NewReader(tc.data), storage.MaxQRBytes)

			require.NoError(t, err)
			assert.Equal(t, tc.mime, img.MIME)
			assert.Equal(t, tc.ext, img.Ext)
			assert.Equal(t, tc.width, img.Width)
			assert.Equal(t, tc.height, img.Height)
			assert.Equal(t, tc.data, img.Data)
			assert.Equal(t, sha256.Sum256(tc.data), img.SHA256)
		})
	}
}

func TestReadImageSizeLimit(t *testing.T) {
	data := pngBytes(t, 2, 2)

	_, err := storage.ReadImage(bytes.NewReader(data), int64(len(data)))
	require.NoError(t, err, "恰好等于上限可以通过")

	_, err = storage.ReadImage(bytes.NewReader(data), int64(len(data)-1))
	requireAppErr(t, err, apperr.CodeFileTooLarge, http.StatusRequestEntityTooLarge)
	ae, _ := apperr.As(err)
	assert.Equal(t, int64(0), ae.Params["maxMB"])

	huge := io.MultiReader(bytes.NewReader(data), strings.NewReader(strings.Repeat("x", storage.MaxProofBytes)))
	_, err = storage.ReadImage(huge, storage.MaxProofBytes)
	requireAppErr(t, err, apperr.CodeFileTooLarge, http.StatusRequestEntityTooLarge)
}

type maxBytesReader struct{}

func (maxBytesReader) Read([]byte) (int, error) { return 0, &http.MaxBytesError{Limit: 6 << 20} }

func TestReadImageMapsRequestBodyLimitToFileTooLarge(t *testing.T) {
	_, err := storage.ReadImage(maxBytesReader{}, storage.MaxProofBytes)
	requireAppErr(t, err, apperr.CodeFileTooLarge, http.StatusRequestEntityTooLarge)
}

func TestReadImageRejectsNonImages(t *testing.T) {
	gif := []byte("GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00!\xf9\x04\x00\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;")
	truncatedPNG := pngBytes(t, 2, 2)[:20]
	cases := map[string][]byte{
		"空文件":          {},
		"文本伪装成 png":    []byte("this is not an image, just text named proof.png"),
		"gif 不在白名单":    gif,
		"png 文件头但无法解码": truncatedPNG,
		"pdf":          []byte("%PDF-1.7\n1 0 obj\n"),
	}
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := storage.ReadImage(bytes.NewReader(data), storage.MaxProofBytes)
			requireAppErr(t, err, apperr.CodeFileTypeNotAllowed, http.StatusUnsupportedMediaType)
		})
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("disk on fire") }

func TestReadImageReturnsReadErrors(t *testing.T) {
	_, err := storage.ReadImage(failingReader{}, storage.MaxProofBytes)
	require.ErrorContains(t, err, "disk on fire")
	_, isAppErr := apperr.As(err)
	assert.False(t, isAppErr)
}
```

Run: `cd api && go test ./internal/platform/storage/`
Expected: 编译失败，`undefined: storage.NewKey`、`undefined: storage.NewDisk`、`undefined: storage.ReadImage`。

- [ ] **Step 7: 实现 `storage` 的 Store、磁盘、存储键与图片识别**

创建 `api/internal/platform/storage/storage.go`：

```go
// Package storage 保存上传文件：Store 接口与本地磁盘实现、图片识别、files 表读写。
package storage

import (
	"context"
	"errors"
	"io"
)

// 上传大小上限。
const (
	MaxProofBytes = 5 << 20 // 付款凭证截图
	MaxQRBytes    = 2 << 20 // 收款二维码
)

// files.visibility 与 files.purpose 的取值。
const (
	VisibilityPublic    = "PUBLIC"
	VisibilityPrivate   = "PRIVATE"
	PurposePaymentProof = "PAYMENT_PROOF"
	PurposePaymentQR    = "PAYMENT_QR"
)

// ErrNotFound 表示存储中没有该 key。
var ErrNotFound = errors.New("storage: not found")

// Store 是文件内容的存取接口；元数据在 files 表。
type Store interface {
	Put(ctx context.Context, key string, r io.Reader) error
	Open(ctx context.Context, key string) (io.ReadCloser, error) // 不存在时返回 ErrNotFound
	Delete(ctx context.Context, key string) error               // 不存在时返回 nil
}
```

创建 `api/internal/platform/storage/key.go`：

```go
package storage

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"
)

// NewKey 生成 "yyyy/mm/<32 位小写十六进制>.<ext>"，年月取 UTC。
func NewKey(now time.Time, ext string) string {
	var b [16]byte
	_, _ = rand.Read(b[:]) // crypto/rand.Read 不会返回错误
	u := now.UTC()
	return fmt.Sprintf("%04d/%02d/%s.%s", u.Year(), int(u.Month()), hex.EncodeToString(b[:]), ext)
}
```

创建 `api/internal/platform/storage/disk.go`：

```go
package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

// Disk 把文件存在本地目录（WERUN_FILES_DIR）下。
type Disk struct {
	root string
}

var _ Store = (*Disk)(nil)

// NewDisk 在目录不存在时创建它。
func NewDisk(root string) (*Disk, error) {
	if root == "" {
		return nil, errors.New("storage: root directory is empty")
	}
	if err := os.MkdirAll(root, 0o750); err != nil {
		return nil, fmt.Errorf("storage: create root %s: %w", root, err)
	}
	return &Disk{root: root}, nil
}

// path 把 key 映射到根目录下的路径；拒绝绝对路径与跳出根目录的 key。
func (d *Disk) path(key string) (string, error) {
	local := filepath.FromSlash(key)
	if key == "" || !filepath.IsLocal(local) {
		return "", fmt.Errorf("storage: invalid key %q", key)
	}
	return filepath.Join(d.root, local), nil
}

// Put 先写同目录的临时文件再 rename，读者不会看到写了一半的文件。
func (d *Disk) Put(ctx context.Context, key string, r io.Reader) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	p, err := d.path(key)
	if err != nil {
		return err
	}
	dir := filepath.Dir(p)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return fmt.Errorf("storage: create dir for %s: %w", key, err)
	}
	tmp, err := os.CreateTemp(dir, ".upload-*")
	if err != nil {
		return fmt.Errorf("storage: create temp file for %s: %w", key, err)
	}
	if _, err := io.Copy(tmp, r); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		return fmt.Errorf("storage: write %s: %w", key, err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmp.Name())
		return fmt.Errorf("storage: close %s: %w", key, err)
	}
	if err := os.Rename(tmp.Name(), p); err != nil {
		_ = os.Remove(tmp.Name())
		return fmt.Errorf("storage: rename %s: %w", key, err)
	}
	return nil
}

// Open 打开文件；不存在时返回 ErrNotFound。
func (d *Disk) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	p, err := d.path(key)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("storage: open %s: %w", key, err)
	}
	return f, nil
}

// Delete 删除文件；不存在时返回 nil。
func (d *Disk) Delete(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	p, err := d.path(key)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("storage: delete %s: %w", key, err)
	}
	return nil
}
```

创建 `api/internal/platform/storage/image.go`：

```go
package storage

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg" // 注册 jpeg 解码器
	_ "image/png"  // 注册 png 解码器
	"io"
	"net/http"

	_ "golang.org/x/image/webp" // 注册 webp 解码器

	"werun/api/internal/platform/apperr"
)

// Image 是通过校验的上传图片。
type Image struct {
	Data   []byte
	MIME   string // image/jpeg | image/png | image/webp
	Ext    string // jpg | png | webp
	SHA256 [32]byte
	Width  int
	Height int
}

var extByMIME = map[string]string{
	"image/jpeg": "jpg",
	"image/png":  "png",
	"image/webp": "webp",
}

var mimeByFormat = map[string]string{
	"jpeg": "image/jpeg",
	"png":  "image/png",
	"webp": "image/webp",
}

// ReadImage 读取至多 maxBytes+1 字节；超限返回 FILE_TOO_LARGE(413)。
// 类型按前 512 字节内容识别（不看文件名），不在白名单或解不出宽高时返回 FILE_TYPE_NOT_ALLOWED(415)。
func ReadImage(r io.Reader, maxBytes int64) (Image, error) {
	tooLarge := apperr.New(http.StatusRequestEntityTooLarge, apperr.CodeFileTooLarge).
		WithParams(map[string]any{"maxMB": maxBytes >> 20})

	data, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return Image{}, tooLarge.Wrap(err)
		}
		return Image{}, fmt.Errorf("storage: read upload: %w", err)
	}
	if int64(len(data)) > maxBytes {
		return Image{}, tooLarge
	}

	notAllowed := apperr.New(http.StatusUnsupportedMediaType, apperr.CodeFileTypeNotAllowed)
	if len(data) == 0 {
		return Image{}, notAllowed
	}
	head := data
	if len(head) > 512 {
		head = head[:512]
	}
	mime := http.DetectContentType(head)
	ext, ok := extByMIME[mime]
	if !ok {
		return Image{}, notAllowed
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return Image{}, notAllowed.Wrap(err)
	}
	if mimeByFormat[format] != mime || cfg.Width <= 0 || cfg.Height <= 0 {
		return Image{}, notAllowed
	}
	return Image{
		Data:   data,
		MIME:   mime,
		Ext:    ext,
		SHA256: sha256.Sum256(data),
		Width:  cfg.Width,
		Height: cfg.Height,
	}, nil
}
```

Run: `cd api && go test ./internal/platform/storage/ -run 'TestNewKey|TestNewDisk|TestDisk|TestReadImage' -v`
Expected: PASS（`TestReadImageRejectsNonImages` 5 个子测试、`TestReadImageAcceptsJPEGPNGWebP` 3 个子测试）。

- [ ] **Step 8: 写 `files` 表的失败测试（数据库）**

创建 `api/internal/platform/storage/files_test.go`：

```go
package storage_test

import (
	"context"
	"crypto/sha256"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/storage"
)

func TestInsertGetAndCountFiles(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()
	data := pngBytes(t, 3, 2)
	img, err := storage.ReadImage(bytesReader(data), storage.MaxProofBytes)
	require.NoError(t, err)

	var firstID, secondID, otherPurposeID int64
	require.NoError(t, db.InTx(ctx, pool, func(tx pgx.Tx) error {
		var err error
		firstID, err = storage.InsertFile(ctx, tx, storage.FileRecord{
			StorageKey: "2026/09/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png", Visibility: storage.VisibilityPrivate,
			Purpose: storage.PurposePaymentProof, Image: img, UploadedByType: "USER", UploadedByID: 42,
		})
		if err != nil {
			return err
		}
		secondID, err = storage.InsertFile(ctx, tx, storage.FileRecord{
			StorageKey: "2026/09/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png", Visibility: storage.VisibilityPrivate,
			Purpose: storage.PurposePaymentProof, Image: img, UploadedByType: "USER", UploadedByID: 43,
		})
		if err != nil {
			return err
		}
		otherPurposeID, err = storage.InsertFile(ctx, tx, storage.FileRecord{
			StorageKey: "2026/09/cccccccccccccccccccccccccccccccc.png", Visibility: storage.VisibilityPublic,
			Purpose: storage.PurposePaymentQR, Image: img, UploadedByType: "STAFF", UploadedByID: 1,
		})
		return err
	}))

	f, err := storage.GetFile(ctx, pool, firstID)
	require.NoError(t, err)
	sum := sha256.Sum256(data)
	assert.Equal(t, storage.File{
		ID: firstID, StorageKey: "2026/09/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png", Visibility: "PRIVATE",
		MIME: "image/png", SizeBytes: int64(len(data)), SHA256: sum[:],
	}, f)

	var width, height int32
	var uploader int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT width, height, uploaded_by_id FROM files WHERE id = $1`, firstID).
		Scan(&width, &height, &uploader))
	assert.Equal(t, []any{int32(3), int32(2), int64(42)}, []any{width, height, uploader})

	require.NoError(t, db.InTx(ctx, pool, func(tx pgx.Tx) error {
		n, err := storage.CountOtherFilesWithSHA256(ctx, tx, sum[:], storage.PurposePaymentProof, firstID)
		require.NoError(t, err)
		assert.Equal(t, int64(1), n, "只数其他凭证文件，不含自己，也不含二维码")
		n, err = storage.CountOtherFilesWithSHA256(ctx, tx, sum[:], storage.PurposePaymentQR, otherPurposeID)
		require.NoError(t, err)
		assert.Equal(t, int64(0), n)
		_ = secondID
		return nil
	}))

	_, err = storage.GetFile(ctx, pool, 999999)
	ae, ok := apperr.As(err)
	require.True(t, ok)
	assert.Equal(t, apperr.CodeNotFound, ae.Code)
	assert.Equal(t, http.StatusNotFound, ae.Status)
}
```

在 `api/internal/platform/storage/image_test.go` 末尾追加辅助函数：

```go
func bytesReader(b []byte) io.Reader { return bytes.NewReader(b) }
```

Run（数据库测试需要 Docker；本机为 colima 时先 `export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true`）：
`cd api && go test ./internal/platform/storage/ -run TestInsertGetAndCountFiles`
Expected: 编译失败，`undefined: storage.InsertFile`、`undefined: storage.FileRecord`。

- [ ] **Step 9: 实现 `files` 查询与 sqlc 配置**

创建 `api/db/queries/storage.sql`：

```sql
-- name: InsertFile :one
INSERT INTO files (storage_key, visibility, purpose, mime_type, size_bytes, sha256,
                   width, height, uploaded_by_type, uploaded_by_id)
VALUES (@storage_key, @visibility, @purpose, @mime_type, @size_bytes, @sha256,
        @width, @height, @uploaded_by_type, @uploaded_by_id)
RETURNING id;

-- name: GetFile :one
SELECT id, storage_key, visibility, mime_type, size_bytes, sha256
FROM files
WHERE id = @id;

-- name: CountOtherFilesWithSHA256 :one
SELECT count(*) FROM files
WHERE sha256 = @sha256 AND purpose = @purpose AND id <> @exclude_id;
```

`api/sqlc.yaml` 末尾追加（与 iam、event 块逐字相同，只改 `queries` 与 `out`）：

```yaml
  - engine: postgresql
    schema: db/migrations
    queries: db/queries/storage.sql
    gen:
      go:
        package: store
        out: internal/platform/storage/store
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

Run: `cd api && go tool sqlc generate`
Expected: 生成 `api/internal/platform/storage/store/{db.go,models.go,storage.sql.go}`；`InsertFileParams` 中 `Width`、`Height` 为 `*int32`，`UploadedByID` 为 `*int64`，`Sha256` 为 `[]byte`；`GetFileRow` 含 `ID, StorageKey, Visibility, MimeType, SizeBytes, Sha256`；`CountOtherFilesWithSHA256Params{Sha256, Purpose, ExcludeID}`。

创建 `api/internal/platform/storage/files.go`：

```go
package storage

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/storage/store"
)

// FileRecord 是写 files 表的输入。
type FileRecord struct {
	StorageKey     string
	Visibility     string // PUBLIC | PRIVATE
	Purpose        string // PAYMENT_PROOF | PAYMENT_QR
	Image          Image
	UploadedByType string // USER | STAFF
	UploadedByID   int64
}

// File 是读取文件时需要的元数据。
type File struct {
	ID         int64
	StorageKey string
	Visibility string
	MIME       string
	SizeBytes  int64
	SHA256     []byte
}

// InsertFile 在调用方事务里写 files，返回新行 id。
func InsertFile(ctx context.Context, tx pgx.Tx, rec FileRecord) (int64, error) {
	width := int32(rec.Image.Width)
	height := int32(rec.Image.Height)
	uploader := rec.UploadedByID
	id, err := store.New(tx).InsertFile(ctx, store.InsertFileParams{
		StorageKey:     rec.StorageKey,
		Visibility:     rec.Visibility,
		Purpose:        rec.Purpose,
		MimeType:       rec.Image.MIME,
		SizeBytes:      int64(len(rec.Image.Data)),
		Sha256:         rec.Image.SHA256[:],
		Width:          &width,
		Height:         &height,
		UploadedByType: rec.UploadedByType,
		UploadedByID:   &uploader,
	})
	if err != nil {
		return 0, fmt.Errorf("storage: insert file %s: %w", rec.StorageKey, err)
	}
	return id, nil
}

// GetFile 读取文件元数据；不存在返回 NOT_FOUND(404)。
func GetFile(ctx context.Context, q store.DBTX, id int64) (File, error) {
	row, err := store.New(q).GetFile(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return File{}, apperr.New(http.StatusNotFound, apperr.CodeNotFound)
	}
	if err != nil {
		return File{}, fmt.Errorf("storage: get file %d: %w", id, err)
	}
	return File{
		ID:         row.ID,
		StorageKey: row.StorageKey,
		Visibility: row.Visibility,
		MIME:       row.MimeType,
		SizeBytes:  row.SizeBytes,
		SHA256:     row.Sha256,
	}, nil
}

// CountOtherFilesWithSHA256 统计同用途、内容相同、id 不等于 excludeID 的文件数（重复截图检测）。
func CountOtherFilesWithSHA256(ctx context.Context, tx pgx.Tx, sha []byte, purpose string, excludeID int64) (int64, error) {
	n, err := store.New(tx).CountOtherFilesWithSHA256(ctx, store.CountOtherFilesWithSHA256Params{
		Sha256:    sha,
		Purpose:   purpose,
		ExcludeID: excludeID,
	})
	if err != nil {
		return 0, fmt.Errorf("storage: count files by sha256: %w", err)
	}
	return n, nil
}
```

Run: `cd api && go test ./internal/platform/storage/ -v`（colima 环境变量同 Step 8）
Expected: 全部 PASS，含 `TestInsertGetAndCountFiles`。

- [ ] **Step 10: 写 `settings` 的失败测试（数据库）**

创建 `api/internal/platform/settings/settings_test.go`：

```go
package settings_test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/settings"
)

func TestLoadPaymentReadsSeededDefaults(t *testing.T) {
	pool := dbtest.NewPool(t)

	p, err := settings.LoadPayment(context.Background(), pool)

	require.NoError(t, err)
	assert.Equal(t, settings.Payment{
		UploadWindow:        30 * time.Minute,
		ReuploadWindow:      24 * time.Hour,
		ReviewSLA:           24 * time.Hour,
		IdentOffsetMaxCents: 50,
	}, p)
}

func TestLoadPaymentHonoursChangesCapsOffsetAndFallsBack(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `UPDATE system_settings SET value = '45' WHERE key = 'payment.upload_window_minutes'`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE system_settings SET value = '"12"' WHERE key = 'payment.reupload_window_hours'`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE system_settings SET value = '80' WHERE key = 'payment.ident_offset_max_cents'`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `DELETE FROM system_settings WHERE key = 'payment.review_sla_hours'`)
	require.NoError(t, err)

	p, err := settings.LoadPayment(ctx, pool)

	require.NoError(t, err)
	assert.Equal(t, 45*time.Minute, p.UploadWindow)
	assert.Equal(t, 12*time.Hour, p.ReuploadWindow, "字符串形式的 JSON 数字同样可读")
	assert.Equal(t, 24*time.Hour, p.ReviewSLA, "缺行时用默认值")
	assert.Equal(t, int64(50), p.IdentOffsetMaxCents, "识别分上限不超过 50")
}

func TestLoadPaymentReturnsErrorOnGarbage(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `UPDATE system_settings SET value = '"thirty"' WHERE key = 'payment.upload_window_minutes'`)
	require.NoError(t, err)

	_, err = settings.LoadPayment(ctx, pool)

	require.ErrorContains(t, err, "payment.upload_window_minutes")
}
```

Run（colima 环境变量同 Step 8）：`cd api && go test ./internal/platform/settings/`
Expected: 编译失败，`no non-test Go files` / `undefined: settings.LoadPayment`。

- [ ] **Step 11: 实现 `settings`**

创建 `api/internal/platform/settings/settings.go`：

```go
// Package settings 读取 system_settings 中的运行参数。
package settings

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// identOffsetHardMax 是识别分的代码上限，数据库配置不能突破。
const identOffsetHardMax = 50

// Payment 是付款相关期限。
type Payment struct {
	UploadWindow        time.Duration
	ReuploadWindow      time.Duration
	ReviewSLA           time.Duration
	IdentOffsetMaxCents int64 // 已与 50 取最小值
}

// LoadPayment 读取付款期限；缺行或值不大于 0 时用默认值（30 分钟、24 小时、24 小时、50 分）。
// q 可以是连接池或事务。
func LoadPayment(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}) (Payment, error) {
	upload, err := intSetting(ctx, q, "payment.upload_window_minutes", 30)
	if err != nil {
		return Payment{}, err
	}
	reupload, err := intSetting(ctx, q, "payment.reupload_window_hours", 24)
	if err != nil {
		return Payment{}, err
	}
	sla, err := intSetting(ctx, q, "payment.review_sla_hours", 24)
	if err != nil {
		return Payment{}, err
	}
	offset, err := intSetting(ctx, q, "payment.ident_offset_max_cents", identOffsetHardMax)
	if err != nil {
		return Payment{}, err
	}
	return Payment{
		UploadWindow:        time.Duration(upload) * time.Minute,
		ReuploadWindow:      time.Duration(reupload) * time.Hour,
		ReviewSLA:           time.Duration(sla) * time.Hour,
		IdentOffsetMaxCents: min(offset, identOffsetHardMax),
	}, nil
}

// intSetting 读取一个整数设置；jsonb 的数字与数字字符串（'45'、'"45"'）都接受。
func intSetting(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, key string, def int64) (int64, error) {
	var v int64
	err := q.QueryRow(ctx, `SELECT (value #>> '{}')::bigint FROM system_settings WHERE key = $1`, key).Scan(&v)
	if errors.Is(err, pgx.ErrNoRows) {
		return def, nil
	}
	if err != nil {
		return 0, fmt.Errorf("settings: read %s: %w", key, err)
	}
	if v <= 0 {
		return def, nil
	}
	return v, nil
}
```

Run（colima 环境变量同 Step 8）：`cd api && go test ./internal/platform/settings/ -v`
Expected: 3 个测试 PASS。

- [ ] **Step 12: 写配置的失败测试**

`api/internal/platform/config/config_test.go`，把 `setRequired` 整个函数替换为：

```go
func setRequired(t *testing.T) {
	t.Helper()
	unset(t, "WERUN_ENV", "WERUN_HTTP_ADDR", "WERUN_FILES_DIR", "WERUN_LOG_LEVEL", "WERUN_TELEGRAM_SEND")
	t.Setenv("WERUN_DATABASE_URL", "postgres://werun:werun@localhost:55432/werun?sslmode=disable")
	t.Setenv("WERUN_SESSION_SECRET", strings.Repeat("s", 32))
	t.Setenv("WERUN_PII_KEY", validPIIKey)
	t.Setenv("WERUN_TELEGRAM_BOT_TOKEN", "123456:e2e-test-token")
	t.Setenv("WERUN_TELEGRAM_BOT_USERNAME", "werun_e2e_bot")
	t.Setenv("WERUN_APP_BASE_URL", "http://werun.localhost")
}
```

把 `TestLoadReportsEveryInvalidVariable` 整个函数替换为：

```go
func TestLoadReportsEveryInvalidVariable(t *testing.T) {
	unset(t, "WERUN_DATABASE_URL", "WERUN_HTTP_ADDR", "WERUN_FILES_DIR", "WERUN_LOG_LEVEL",
		"WERUN_TELEGRAM_BOT_TOKEN", "WERUN_TELEGRAM_BOT_USERNAME", "WERUN_APP_BASE_URL")
	t.Setenv("WERUN_ENV", "staging")
	t.Setenv("WERUN_SESSION_SECRET", "too-short")
	t.Setenv("WERUN_PII_KEY", "not base64 !!")
	t.Setenv("WERUN_TELEGRAM_SEND", "yes")

	_, err := config.Load()

	require.Error(t, err)
	for _, name := range []string{
		"WERUN_DATABASE_URL", "WERUN_ENV", "WERUN_SESSION_SECRET", "WERUN_PII_KEY",
		"WERUN_TELEGRAM_BOT_TOKEN", "WERUN_TELEGRAM_BOT_USERNAME", "WERUN_APP_BASE_URL", "WERUN_TELEGRAM_SEND",
	} {
		assert.Contains(t, err.Error(), name)
	}
}
```

在 `TestLoadAppliesDefaults` 的断言末尾（`assert.False(t, cfg.IsProd())` 之后）追加：

```go
	assert.Equal(t, "123456:e2e-test-token", cfg.TelegramBotToken)
	assert.Equal(t, "werun_e2e_bot", cfg.TelegramBotUsername)
	assert.Equal(t, "", cfg.TelegramSend)
	assert.Equal(t, "http://werun.localhost", cfg.AppBaseURL)
	assert.False(t, cfg.TelegramSendEnabled(), "dev 默认不发送")
```

文件末尾追加：

```go
func TestTelegramSendEnabled(t *testing.T) {
	cases := []struct {
		env, send string
		want      bool
	}{
		{"dev", "", false},
		{"prod", "", true},
		{"dev", "on", true},
		{"prod", "off", false},
	}
	for _, tc := range cases {
		t.Run(tc.env+"/"+tc.send, func(t *testing.T) {
			setRequired(t)
			t.Setenv("WERUN_ENV", tc.env)
			if tc.send != "" {
				t.Setenv("WERUN_TELEGRAM_SEND", tc.send)
			}

			cfg, err := config.Load()

			require.NoError(t, err)
			assert.Equal(t, tc.want, cfg.TelegramSendEnabled())
		})
	}
}

func TestLoadValidatesAppBaseURL(t *testing.T) {
	for _, bad := range []string{"", "werun.localhost", "ftp://werun.localhost", "http://"} {
		t.Run(bad, func(t *testing.T) {
			setRequired(t)
			t.Setenv("WERUN_APP_BASE_URL", bad)

			_, err := config.Load()

			require.Error(t, err)
			assert.Contains(t, err.Error(), "WERUN_APP_BASE_URL")
		})
	}

	setRequired(t)
	t.Setenv("WERUN_APP_BASE_URL", "https://app.werun.asia/")
	cfg, err := config.Load()
	require.NoError(t, err)
	assert.Equal(t, "https://app.werun.asia", cfg.AppBaseURL, "去掉结尾斜杠，便于拼接 /orders/<orderNo>")
}
```

Run: `cd api && go test ./internal/platform/config/`
Expected: 编译失败，`cfg.TelegramBotToken undefined`、`cfg.TelegramSendEnabled undefined`。

- [ ] **Step 13: 实现配置字段与校验**

`api/internal/platform/config/config.go` 的 import 块：

```go
import (
	"encoding/base64"
	"errors"
	"fmt"

	"github.com/caarlos0/env/v11"
)
```

改为：

```go
import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/caarlos0/env/v11"
)
```

`Config` 结构体整体替换为：

```go
// Config 是 werun 进程的全部运行配置。
type Config struct {
	Env                 string `env:"WERUN_ENV" envDefault:"dev"`
	HTTPAddr            string `env:"WERUN_HTTP_ADDR" envDefault:":8080"`
	DatabaseURL         string `env:"WERUN_DATABASE_URL,required"`
	SessionSecret       string `env:"WERUN_SESSION_SECRET,required"`
	PIIKey              string `env:"WERUN_PII_KEY,required"`
	FilesDir            string `env:"WERUN_FILES_DIR" envDefault:"./data/files"`
	LogLevel            string `env:"WERUN_LOG_LEVEL" envDefault:"info"`
	TelegramBotToken    string `env:"WERUN_TELEGRAM_BOT_TOKEN,required"`
	TelegramBotUsername string `env:"WERUN_TELEGRAM_BOT_USERNAME,required"`
	TelegramSend        string `env:"WERUN_TELEGRAM_SEND"` // "" | on | off
	AppBaseURL          string `env:"WERUN_APP_BASE_URL,required"`
}
```

`Load` 中：

```go
	if cfg.PIIKey != "" {
		if _, keyErr := cfg.PIIKeyBytes(); keyErr != nil {
			errs = append(errs, keyErr)
		}
	}
	if len(errs) > 0 {
```

改为：

```go
	if cfg.PIIKey != "" {
		if _, keyErr := cfg.PIIKeyBytes(); keyErr != nil {
			errs = append(errs, keyErr)
		}
	}
	if cfg.TelegramSend != "" && cfg.TelegramSend != "on" && cfg.TelegramSend != "off" {
		errs = append(errs, fmt.Errorf("WERUN_TELEGRAM_SEND must be on, off or empty, got %q", cfg.TelegramSend))
	}
	// 变量未设置时 env.ParseAs 已经报过 WERUN_APP_BASE_URL，不重复报
	if err == nil || !strings.Contains(err.Error(), "WERUN_APP_BASE_URL") {
		if baseErr := validateBaseURL(cfg.AppBaseURL); baseErr != nil {
			errs = append(errs, baseErr)
		}
	}
	cfg.AppBaseURL = strings.TrimRight(cfg.AppBaseURL, "/")
	if len(errs) > 0 {
```

在文件末尾追加：

```go
// TelegramSendEnabled 表示推送是否真正调用 Telegram：显式 on/off 优先，未设置时只有 prod 发送。
func (c Config) TelegramSendEnabled() bool {
	switch c.TelegramSend {
	case "on":
		return true
	case "off":
		return false
	default:
		return c.IsProd()
	}
}

func validateBaseURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("WERUN_APP_BASE_URL must be an absolute http(s) URL, got %q", raw)
	}
	return nil
}
```

说明：`required` 只要求变量存在；显式设为空串时由 `validateBaseURL` 报错。

Run: `cd api && go test ./internal/platform/config/ -v`
Expected: PASS；`TestTelegramSendEnabled` 4 个子测试、`TestLoadValidatesAppBaseURL` 4 个子测试通过。

- [ ] **Step 14: 写请求体上限的失败测试**

创建 `api/internal/httpapi/bodylimit_test.go`：

```go
package httpapi

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestBodyLimitFor(t *testing.T) {
	cases := map[string]int64{
		"/api/app/orders/WR7K3M9Q2A/proofs":        6 << 20,
		"/api/admin/payment-accounts":              6 << 20,
		"/api/admin/payment-accounts/12":           6 << 20,
		"/api/app/orders/WR7K3M9Q2A/proofs/1":      1 << 20,
		"/api/app/orders//proofs":                  1 << 20,
		"/api/admin/payment-accounts/abc":          1 << 20,
		"/api/admin/payment-accounts/12/qr":        1 << 20,
		"/api/admin/events":                        1 << 20,
		"/api/app/orders":                          1 << 20,
		"/prefix/api/admin/payment-accounts":       1 << 20,
	}
	for path, want := range cases {
		assert.Equal(t, want, bodyLimitFor(path), path)
	}
}
```

在 `api/internal/httpapi/router_test.go` 末尾追加（import 块补 `"io"` 与 `"bytes"`）：

```go
// 上传接口的真实路由在 Task 6、Task 15 才注册；这里在同一个 engine 上挂 PATCH 探针路由
// （apigen 不会给这些路径注册 PATCH），只验证中间件按路径选的上限。
func TestUploadPathsAllowSixMiBBodies(t *testing.T) {
	r := newRouter(t, nil)
	probe := func(c *gin.Context) {
		n, err := io.Copy(io.Discard, c.Request.Body)
		if err != nil {
			c.Status(http.StatusRequestEntityTooLarge)
			return
		}
		c.String(http.StatusOK, "%d", n)
	}
	paths := []string{
		"/api/app/orders/WR0000TEST/proofs",
		"/api/admin/payment-accounts",
		"/api/admin/payment-accounts/9",
		"/api/admin/limit-probe",
	}
	for _, p := range paths {
		r.PATCH(p, probe)
	}
	send := func(path string, size int) *httptest.ResponseRecorder {
		req := httptest.NewRequestWithContext(context.Background(), http.MethodPatch, path, bytes.NewReader(make([]byte, size)))
		req.Header.Set(httpx.HeaderClient, "admin")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}

	twoMiB := 2 << 20
	for _, p := range paths[:3] {
		rec := send(p, twoMiB)
		assert.Equal(t, http.StatusOK, rec.Code, p)
		assert.Equal(t, "2097152", rec.Body.String(), p)
	}
	assert.Equal(t, http.StatusRequestEntityTooLarge, send("/api/admin/limit-probe", twoMiB).Code,
		"同样大小的请求体发到其他路径被 1 MiB 上限拒绝")
	assert.Equal(t, http.StatusRequestEntityTooLarge, send("/api/admin/payment-accounts", (6<<20)+1).Code,
		"上传路径超过 6 MiB 同样被拒绝")
}
```

Run: `cd api && go test ./internal/httpapi/ -run 'TestBodyLimitFor|TestUploadPathsAllowSixMiBBodies|TestOversizedRequestBodyIsRejected'`
Expected: 编译失败，`undefined: bodyLimitFor`。

- [ ] **Step 15: 实现按路径取上限**

`api/internal/httpapi/router.go`：import 块加入 `"regexp"`。把：

```go
// maxRequestBodyBytes 限制 /api/* 请求体大小：没有这个上限的话，一个超大请求体在被
// 参数校验拒绝之前就要被完整读入内存（且可能先跑到 argon2 这类昂贵的处理之前），本身
// 就是一种放大攻击。
const maxRequestBodyBytes = 1 << 20 // 1 MiB

// maxBodySize 给 /api/* 下的请求包一层 http.MaxBytesReader；超出大小时后续的 body 读取
// （如 ShouldBindJSON）会失败，经由 apigen 的 RequestErrorHandlerFunc 转成 BAD_REQUEST。
func maxBodySize(limit int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		if strings.HasPrefix(c.Request.URL.Path, "/api/") {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
		}
		c.Next()
	}
}
```

替换为：

```go
// 请求体上限：没有上限的话，一个超大请求体在被参数校验拒绝之前就要被完整读入内存
// （且可能先跑到 argon2 这类昂贵的处理之前），本身就是一种放大攻击。
const (
	maxRequestBodyBytes = 1 << 20 // 1 MiB：普通 JSON 接口
	maxUploadBodyBytes  = 6 << 20 // 6 MiB：凭证截图（≤ 5 MB）与收款二维码（≤ 2 MB）的 multipart 接口
)

var uploadBodyPath = regexp.MustCompile(`^(?:/api/app/orders/[^/]+/proofs|/api/admin/payment-accounts(?:/[0-9]+)?)$`)

// bodyLimitFor 返回路径对应的请求体上限。
func bodyLimitFor(path string) int64 {
	if uploadBodyPath.MatchString(path) {
		return maxUploadBodyBytes
	}
	return maxRequestBodyBytes
}

// maxBodySize 给 /api/* 下的请求包一层 http.MaxBytesReader；超出大小时后续的 body 读取
// （如 ShouldBindJSON）会失败，经由 apigen 的 RequestErrorHandlerFunc 转成 BAD_REQUEST，
// 上传接口读图片时由 storage.ReadImage 转成 FILE_TOO_LARGE。
func maxBodySize() gin.HandlerFunc {
	return func(c *gin.Context) {
		if strings.HasPrefix(c.Request.URL.Path, "/api/") {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, bodyLimitFor(c.Request.URL.Path))
		}
		c.Next()
	}
}
```

`NewRouter` 中 `maxBodySize(maxRequestBodyBytes),` 改为 `maxBodySize(),`。

Run: `cd api && go test ./internal/httpapi/ -run 'TestBodyLimitFor|TestUploadPathsAllowSixMiBBodies|TestOversizedRequestBodyIsRejected|TestHealthz|TestUnknownRoute' -v`
Expected: PASS。

- [ ] **Step 16: 写 River 只入队客户端的失败测试**

`api/internal/jobs/jobs_test.go`：import 块加入 `"github.com/jackc/pgx/v5"` 与 `"werun/api/internal/platform/db"`。把 `TestClientRunsSessionCleanupJob` 中：

```go
	client, err := jobs.NewClient(pool, logx.New("error", io.Discard), cleaner)
```

改为：

```go
	client, err := jobs.NewClient(jobs.Deps{Pool: pool, Log: logx.New("error", io.Discard), Sessions: cleaner})
```

文件末尾追加：

```go
// inserterProbeArgs 是只在测试里存在的任务类型：只入队客户端不认识任何 worker，也必须能插入。
type inserterProbeArgs struct {
	Note string `json:"note"`
}

func (inserterProbeArgs) Kind() string { return "inserter_probe" }

func TestInserterInsertsAnyJobKindInsideTransaction(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()
	inserter, err := jobs.NewInserter(pool)
	require.NoError(t, err)

	require.NoError(t, db.InTx(ctx, pool, func(tx pgx.Tx) error {
		res, err := inserter.InsertTx(ctx, tx, inserterProbeArgs{Note: "committed"}, &river.InsertOpts{MaxAttempts: 5})
		if err != nil {
			return err
		}
		require.NotZero(t, res.Job.ID)
		return nil
	}))

	rollback := errors.New("roll back on purpose")
	err = db.InTx(ctx, pool, func(tx pgx.Tx) error {
		if _, err := inserter.InsertTx(ctx, tx, inserterProbeArgs{Note: "rolled back"}, nil); err != nil {
			return err
		}
		return rollback
	})
	require.ErrorIs(t, err, rollback)

	var count, maxAttempts int
	var state, args string
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT count(*) OVER (), max_attempts, state::text, args::text FROM river_job WHERE kind = 'inserter_probe'`).
		Scan(&count, &maxAttempts, &state, &args))
	require.Equal(t, 1, count, "回滚的事务不留下任务")
	require.Equal(t, 5, maxAttempts)
	require.Equal(t, "available", state, "没有 worker 在跑，任务保持可执行状态")
	require.JSONEq(t, `{"note":"committed"}`, args)
}
```

Run（colima 环境变量同 Step 8）：`cd api && go test ./internal/jobs/`
Expected: 编译失败，`undefined: jobs.Deps`、`undefined: jobs.NewInserter`。

- [ ] **Step 17: 实现 `jobs.Deps`、`NewInserter` 并更新调用方**

`api/internal/jobs/jobs.go` 中把 `NewClient` 整个函数替换为：

```go
// Deps 是执行任务的客户端需要的依赖。后续任务只在这里加字段（Notify、Deadline）。
type Deps struct {
	Pool     *pgxpool.Pool
	Log      *slog.Logger
	Sessions SessionCleaner
}

// NewClient 创建能执行任务的 River 客户端：注册全部 worker 与周期任务，默认队列 10 个并发。
func NewClient(d Deps) (*river.Client[pgx.Tx], error) {
	phnomPenh, err := time.LoadLocation("Asia/Phnom_Penh")
	if err != nil {
		return nil, fmt.Errorf("load Asia/Phnom_Penh: %w", err)
	}

	workers := river.NewWorkers()
	river.AddWorker(workers, &SessionCleanupWorker{Sessions: d.Sessions, Log: d.Log})

	client, err := river.NewClient(riverpgxv5.New(d.Pool), &river.Config{
		Logger: d.Log,
		Queues: map[string]river.QueueConfig{
			river.QueueDefault: {MaxWorkers: 10},
		},
		Workers: workers,
		PeriodicJobs: []*river.PeriodicJob{
			river.NewPeriodicJob(
				DailyAt{Hour: 3, Minute: 0, Loc: phnomPenh},
				func() (river.JobArgs, *river.InsertOpts) { return SessionCleanupArgs{}, nil },
				&river.PeriodicJobOpts{ID: "session_cleanup"},
			),
		},
	})
	if err != nil {
		return nil, fmt.Errorf("create river client: %w", err)
	}
	return client, nil
}

// NewInserter 创建只用于 InsertTx 的客户端：不注册 worker、不开队列，不需要 Start。
// 不设 Workers 时 River 跳过“任务类型必须有 worker”的检查，所以 HTTP 进程可以入队任意任务。
func NewInserter(pool *pgxpool.Pool) (*river.Client[pgx.Tx], error) {
	client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{Logger: slog.Default()})
	if err != nil {
		return nil, fmt.Errorf("create river inserter: %w", err)
	}
	return client, nil
}
```

`api/cmd/werun/serve.go` 中：

```go
		riverClient, err = jobs.NewClient(app.Pool, app.Log, app.IAM)
```

改为：

```go
		riverClient, err = jobs.NewClient(jobs.Deps{Pool: app.Pool, Log: app.Log, Sessions: app.IAM})
```

`api/cmd/werun/worker.go` 中：

```go
	client, err := jobs.NewClient(app.Pool, app.Log, app.IAM)
```

改为：

```go
	client, err := jobs.NewClient(jobs.Deps{Pool: app.Pool, Log: app.Log, Sessions: app.IAM})
```

`api/cmd/werun/app.go` 整文件替换为：

```go
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"werun/api/internal/event"
	"werun/api/internal/iam"
	"werun/api/internal/jobs"
	"werun/api/internal/platform/config"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/logx"
	"werun/api/internal/platform/piicrypt"
	"werun/api/internal/platform/storage"
)

// App 持有进程级依赖。各业务服务在引入它的任务里追加字段。
type App struct {
	Cfg      config.Config
	Log      *slog.Logger
	Catalog  *i18n.Catalog
	Pool     *pgxpool.Pool
	Store    storage.Store
	PII      *piicrypt.Cipher
	Inserter *river.Client[pgx.Tx] // 只入队，不执行任务
	IAM      *iam.Service
	Events   *event.Service
}

// Bootstrap 读取配置、创建日志器、加载文案、连接数据库并构造各服务。
func Bootstrap(ctx context.Context) (*App, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, fmt.Errorf("load config: %w", err)
	}
	log := logx.New(cfg.LogLevel, os.Stdout)
	slog.SetDefault(log)
	cat, err := i18n.LoadCatalog()
	if err != nil {
		return nil, fmt.Errorf("load messages: %w", err)
	}
	files, err := storage.NewDisk(cfg.FilesDir)
	if err != nil {
		return nil, fmt.Errorf("open file storage: %w", err)
	}
	piiKey, err := cfg.PIIKeyBytes()
	if err != nil {
		return nil, fmt.Errorf("decode pii key: %w", err)
	}
	pii, err := piicrypt.New(piiKey)
	if err != nil {
		return nil, fmt.Errorf("create pii cipher: %w", err)
	}
	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	inserter, err := jobs.NewInserter(pool)
	if err != nil {
		pool.Close()
		return nil, fmt.Errorf("create job inserter: %w", err)
	}
	app := &App{Cfg: cfg, Log: log, Catalog: cat, Pool: pool, Store: files, PII: pii, Inserter: inserter}
	app.IAM = iam.NewService(app.Pool, []byte(app.Cfg.SessionSecret), iam.NewLoginLimiter(time.Now), time.Now)
	app.Events = event.NewService(app.Pool)
	return app, nil
}

// Close 释放进程级资源。
func (a *App) Close() {
	a.Pool.Close()
}
```

Run（colima 环境变量同 Step 8）：`cd api && go build ./... && go test ./internal/jobs/ ./cmd/werun/ -v`
Expected: 编译通过；`TestInserterInsertsAnyJobKindInsideTransaction`、`TestClientRunsSessionCleanupJob` 与 `cmd/werun` 测试 PASS。

- [ ] **Step 18: 环境变量同步到 `.env.example`、compose 与 CI**

`.env.example` 在 `WERUN_FILES_DIR=./data/files` 一行之后插入：

```dotenv

# Telegram 机器人。本地与 CI 使用假的 token（端到端测试用同一个 token 给 initData 签名）；
# 生产环境从 AWS SSM 渲染真实值
WERUN_TELEGRAM_BOT_TOKEN=123456:e2e-test-token
WERUN_TELEGRAM_BOT_USERNAME=werun_e2e_bot
# on | off；留空时 WERUN_ENV=prod 视为 on，其余视为 off（off 只写日志，不调用 Telegram）
WERUN_TELEGRAM_SEND=off
# 推送消息里小程序订单页链接的前缀，不带结尾斜杠
WERUN_APP_BASE_URL=http://werun.localhost
```

`deploy/compose.yaml` 的 `x-api-env`：

```yaml
x-api-env: &api-env
  WERUN_DATABASE_URL: postgres://werun:${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}@postgres:5432/werun?sslmode=disable
  WERUN_HTTP_ADDR: ":8080"
  WERUN_FILES_DIR: /data/files
```

改为（`migrate` 与 `api` 共用这组变量，二者都会 `Bootstrap` 读取配置）：

```yaml
x-api-env: &api-env
  WERUN_DATABASE_URL: postgres://werun:${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}@postgres:5432/werun?sslmode=disable
  WERUN_HTTP_ADDR: ":8080"
  WERUN_FILES_DIR: /data/files
  WERUN_TELEGRAM_BOT_TOKEN: ${WERUN_TELEGRAM_BOT_TOKEN:?WERUN_TELEGRAM_BOT_TOKEN must be set}
  WERUN_TELEGRAM_BOT_USERNAME: ${WERUN_TELEGRAM_BOT_USERNAME:?WERUN_TELEGRAM_BOT_USERNAME must be set}
  WERUN_TELEGRAM_SEND: ${WERUN_TELEGRAM_SEND:-}
  WERUN_APP_BASE_URL: ${WERUN_APP_BASE_URL:?WERUN_APP_BASE_URL must be set}
```

`.github/workflows/ci.yml` 的 e2e 任务 `Create .env with generated secrets` 步骤：

```yaml
          {
            echo "WERUN_ENV=dev"
            echo "WERUN_SESSION_SECRET=$(openssl rand -hex 32)"
            echo "WERUN_PII_KEY=$(openssl rand -base64 32)"
            echo "WERUN_USER_HOST=${WERUN_USER_HOST}"
            echo "WERUN_ADMIN_HOST=${WERUN_ADMIN_HOST}"
            echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)"
          } >> .env
```

改为：

```yaml
          {
            echo "WERUN_ENV=dev"
            echo "WERUN_SESSION_SECRET=$(openssl rand -hex 32)"
            echo "WERUN_PII_KEY=$(openssl rand -base64 32)"
            echo "WERUN_USER_HOST=${WERUN_USER_HOST}"
            echo "WERUN_ADMIN_HOST=${WERUN_ADMIN_HOST}"
            echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)"
            echo "WERUN_TELEGRAM_BOT_TOKEN=123456:e2e-test-token"
            echo "WERUN_TELEGRAM_BOT_USERNAME=werun_e2e_bot"
            echo "WERUN_TELEGRAM_SEND=off"
            echo "WERUN_APP_BASE_URL=http://werun.localhost"
          } >> .env
```

CI 中只有这一处写 `.env`（backend 任务的 `go test` 不读 `.env`，配置测试自己设置变量）。`Makefile` 只在 `.env` 不存在时从 `.env.example` 复制，不生成内容，无需修改。本机已有的 `.env`（不入库）需要手动追加上面 4 行，否则 `make dev-api` 启动时报缺少变量。

Run: `cp .env.example /tmp/werun-env-check && docker compose -f deploy/compose.yaml --env-file /tmp/werun-env-check config --quiet && rm /tmp/werun-env-check`
Expected: 退出码 0，无输出。再运行 `sed 's/^WERUN_APP_BASE_URL=.*//' .env.example > /tmp/werun-env-bad && docker compose -f deploy/compose.yaml --env-file /tmp/werun-env-bad config --quiet; rm /tmp/werun-env-bad`，Expected：报错 `WERUN_APP_BASE_URL must be set`。

- [ ] **Step 19: 全量检查**

Run（colima 环境变量同 Step 8）：

```bash
cd api && go mod tidy && make -C .. gen-api && git -C .. status --porcelain api/internal/httpapi/apigen
cd api && go test ./...
cd api && go tool golangci-lint run ./...
```

Expected：`go mod tidy` 后 `golang.org/x/image` 位于直接依赖；`make gen-api` 只新增 `internal/platform/storage/store/`，apigen 目录无变化；`go test ./...` 全部 PASS；lint 无问题。

- [ ] **Step 20: 提交**

```bash
git add api/go.mod api/go.sum \
  api/internal/platform/storage api/db/queries/storage.sql api/sqlc.yaml \
  api/internal/platform/piicrypt api/internal/platform/idgen api/internal/platform/settings \
  api/internal/platform/config api/internal/platform/apperr api/internal/platform/i18n \
  api/internal/httpapi/router.go api/internal/httpapi/router_test.go api/internal/httpapi/bodylimit_test.go \
  api/internal/jobs api/cmd/werun/app.go api/cmd/werun/serve.go api/cmd/werun/worker.go \
  .env.example deploy/compose.yaml .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
feat(api): add storage, pii crypto, id generation, payment settings and telegram config

Adds golang.org/x/image v0.43.0 for WebP dimension decoding. Upload endpoints
get a 6 MiB request body limit; River gains an insert-only client.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
)"
```

---
### Task 2: 迁移与权限

**Files:**
- Create: `api/db/migrations/0010_registration_payment.sql`
- Create: `api/db/registration_consents_test.go`
- Modify: `api/internal/platform/migrate/migrate_test.go`（表数 69→70，迁移数 9→10）
- Modify: `api/internal/iam/matrix.go`、`api/internal/iam/matrix_test.go`
- Modify: `web/admin/src/auth/can.ts`、`web/admin/src/auth/can.test.ts`

**Interfaces:**
- Consumes：`dbtest.NewPool`、`migrate.Status / Down`、`iam.row / Allowed / PermissionsOf`
- Produces：
  - 迁移 `0010_registration_payment.sql`（契约 §4，逐字）：`disclaimer_versions.purpose`、表 `registration_consents`
  - `iam.PermPriceConfig = "price_config"`、`iam.PermCouponManage = "coupon_manage"`、`iam.PermPaymentAccountManage = "payment_account_manage"`、`iam.PermProofReview = "proof_review"`（追加到 `AllPermissions` 末尾）
  - `web/admin/src/auth/can.ts`：`PERM_PRICE_CONFIG`、`PERM_COUPON_MANAGE`、`PERM_PAYMENT_ACCOUNT_MANAGE`、`PERM_PROOF_REVIEW`、`PERM_ORDER_VIEW`

权限矩阵（spec §8）：

| 权限 | ADMIN | OPS | FINANCE | SUPPORT | RACE_SUPERVISOR | RACE_STAFF | PHOTOGRAPHER |
|---|---|---|---|---|---|---|---|
| `price_config` | R | W | R | — | — | — | — |
| `coupon_manage` | R | W | R | R | — | — | — |
| `payment_account_manage` | R | R | W | — | — | — | — |
| `proof_review` | R | R | W | R | — | — | — |

- [ ] **Step 1: 写迁移的失败测试**

创建 `api/db/registration_consents_test.go`：

```go
package db_test

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/dbtest"
)

type consentFixture struct {
	signatureIDs []int64
	orderID      int64
	freeSignupID int64
}

// seedConsentFixture 建一个跑者、一个赛事与组别、一张订单、一条免费报名、一版同意书和三条签署记录。
func seedConsentFixture(t *testing.T, pool *pgxpool.Pool) consentFixture {
	t.Helper()
	ctx := context.Background()
	var f consentFixture
	var userID, eventID, categoryID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO users (telegram_user_id, display_name) VALUES (777000111, 'Sok Dara') RETURNING id`).Scan(&userID))
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO events (slug, event_type, organizer_type, name, city, race_date)
		 VALUES ('consent-run', 'RACE', 'OFFICIAL', '{"en":"Consent Run"}', 'Phnom Penh', '2026-11-15') RETURNING id`).Scan(&eventID))
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO event_categories (event_id, code, name, distance_m, capacity)
		 VALUES ($1, '5K', '{"en":"5K"}', 5000, 100) RETURNING id`, eventID).Scan(&categoryID))
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO reg_orders (order_no, event_id, buyer_user_id, buyer_name, buyer_phone_e164, status, reservation_state,
		                         list_amount_cents, amount_cents)
		 VALUES ('WRCONSENT1', $1, $2, 'Sok Dara', '+85512345678', 'PENDING_PAYMENT', 'RESERVED', 2500, 2500) RETURNING id`,
		eventID, userID).Scan(&f.orderID))
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO free_signups (signup_no, event_id, category_id, user_id, full_name, phone_e164)
		 VALUES ('FSCONSENT1', $1, $2, $3, 'Sok Dara', '+85512345678') RETURNING id`,
		eventID, categoryID, userID).Scan(&f.freeSignupID))
	_, err := pool.Exec(ctx,
		`INSERT INTO disclaimer_versions (version, lang, effective_date, full_text, items, text_sha256, purpose)
		 VALUES ('REG-T-v1', 'en', '2026-09-01', 'Rules', '[{"k":"rules","t":"Rules","d":""}]', '\x01', 'REGISTRATION')`)
	require.NoError(t, err)
	for range 3 {
		var id int64
		require.NoError(t, pool.QueryRow(ctx,
			`INSERT INTO disclaimer_signatures (version, lang, text_sha256, user_id, checked_items)
			 VALUES ('REG-T-v1', 'en', '\x01', $1, '["rules"]') RETURNING id`, userID).Scan(&id))
		f.signatureIDs = append(f.signatureIDs, id)
	}
	return f
}

func TestDisclaimerVersionPurposeDefaultsToCommunity(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()

	_, err := pool.Exec(ctx,
		`INSERT INTO disclaimer_versions (version, lang, effective_date, full_text, items, text_sha256)
		 VALUES ('UGC-T-v1', 'zh', '2026-09-01', '正文', '[]', '\x01')`)
	require.NoError(t, err)

	var purpose string
	require.NoError(t, pool.QueryRow(ctx, `SELECT purpose FROM disclaimer_versions WHERE version = 'UGC-T-v1'`).Scan(&purpose))
	assert.Equal(t, "COMMUNITY", purpose)

	_, err = pool.Exec(ctx,
		`INSERT INTO disclaimer_versions (version, lang, effective_date, full_text, items, text_sha256, purpose)
		 VALUES ('BAD-T-v1', 'zh', '2026-09-01', '正文', '[]', '\x01', 'MERCH')`)
	assert.ErrorContains(t, err, "disclaimer_versions_purpose_check")
}

func TestRegistrationConsentsLinkExactlyOneTarget(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()
	f := seedConsentFixture(t, pool)

	_, err := pool.Exec(ctx,
		`INSERT INTO registration_consents (signature_id, reg_order_id) VALUES ($1, $2)`, f.signatureIDs[0], f.orderID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx,
		`INSERT INTO registration_consents (signature_id, free_signup_id) VALUES ($1, $2)`, f.signatureIDs[1], f.freeSignupID)
	require.NoError(t, err)

	_, err = pool.Exec(ctx, `INSERT INTO registration_consents (signature_id) VALUES ($1)`, f.signatureIDs[2])
	assert.ErrorContains(t, err, "registration_consents_check", "两个都为空")
	_, err = pool.Exec(ctx,
		`INSERT INTO registration_consents (signature_id, reg_order_id, free_signup_id) VALUES ($1, $2, $3)`,
		f.signatureIDs[2], f.orderID, f.freeSignupID)
	assert.ErrorContains(t, err, "registration_consents_check", "两个都不为空")
	_, err = pool.Exec(ctx,
		`INSERT INTO registration_consents (signature_id, reg_order_id) VALUES ($1, $2)`, f.signatureIDs[0], f.orderID)
	assert.ErrorContains(t, err, "registration_consents_pkey", "一条签署只关联一次")
}

func TestRegistrationConsentsAreAppendOnly(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()
	f := seedConsentFixture(t, pool)
	_, err := pool.Exec(ctx,
		`INSERT INTO registration_consents (signature_id, reg_order_id) VALUES ($1, $2)`, f.signatureIDs[0], f.orderID)
	require.NoError(t, err)

	_, err = pool.Exec(ctx, `UPDATE registration_consents SET created_at = now() WHERE signature_id = $1`, f.signatureIDs[0])
	assert.ErrorContains(t, err, "registration_consents is append-only")
	_, err = pool.Exec(ctx, `DELETE FROM registration_consents WHERE signature_id = $1`, f.signatureIDs[0])
	assert.ErrorContains(t, err, "registration_consents is append-only")

	var indexes int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT count(*) FROM pg_indexes WHERE tablename = 'registration_consents'
		   AND indexname IN ('registration_consents_order_idx', 'registration_consents_free_idx')`).Scan(&indexes))
	assert.Equal(t, 2, indexes)
}
```

`api/internal/platform/migrate/migrate_test.go`：

```go
	assert.Equal(t, 69, business)
```

改为：

```go
	assert.Equal(t, 70, business)
```

```go
	require.Len(t, lines, 9)
```

改为：

```go
	require.Len(t, lines, 10)
```

```go
	assert.Equal(t, "0009_content_community.sql pending", lines[len(lines)-1])
	assert.Equal(t, "0008_results_photos.sql applied", lines[len(lines)-2])
```

改为：

```go
	assert.Equal(t, "0010_registration_payment.sql pending", lines[len(lines)-1])
	assert.Equal(t, "0009_content_community.sql applied", lines[len(lines)-2])
```

Run（数据库测试需要 Docker；本机为 colima 时先 `export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true`）：
`cd api && go test ./db/ ./internal/platform/migrate/`
Expected: FAIL：`column "purpose" of relation "disclaimer_versions" does not exist`、`relation "registration_consents" does not exist`；migrate 测试 `expected: 70 actual: 69`、`lines` 长度 9。

- [ ] **Step 2: 写迁移**

创建 `api/db/migrations/0010_registration_payment.sql`（与契约 §4 逐字一致）：

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

PostgreSQL 给未命名的列级 CHECK 取名 `disclaimer_versions_purpose_check`，表级 CHECK 取名 `registration_consents_check`，测试据此断言。

Run（colima 环境变量同 Step 1）：`cd api && go test ./db/ ./internal/platform/migrate/ -v`
Expected: `TestDisclaimerVersionPurposeDefaultsToCommunity`、`TestRegistrationConsentsLinkExactlyOneTarget`、`TestRegistrationConsentsAreAppendOnly`、`TestInvariants`（仍为 23 个 PASS）与 4 个 migrate 测试全部 PASS。

- [ ] **Step 3: 写权限矩阵的失败测试**

`api/internal/iam/matrix_test.go` 的 `TestMatrixCellsMatchDemo` 用例列表末尾：

```go
		{PermAuditView, map[Role]Access{RoleAdmin: AccessWrite, RoleOps: AccessRead, RoleFinance: AccessRead}},
	}
```

改为：

```go
		{PermAuditView, map[Role]Access{RoleAdmin: AccessWrite, RoleOps: AccessRead, RoleFinance: AccessRead}},
		// 报名与收款凭证迭代（spec §8）
		{PermPriceConfig, map[Role]Access{RoleAdmin: AccessRead, RoleOps: AccessWrite, RoleFinance: AccessRead}},
		{PermCouponManage, map[Role]Access{RoleAdmin: AccessRead, RoleOps: AccessWrite, RoleFinance: AccessRead, RoleSupport: AccessRead}},
		{PermPaymentAccountManage, map[Role]Access{RoleAdmin: AccessRead, RoleOps: AccessRead, RoleFinance: AccessWrite}},
		{PermProofReview, map[Role]Access{RoleAdmin: AccessRead, RoleOps: AccessRead, RoleFinance: AccessWrite, RoleSupport: AccessRead}},
	}
```

`TestAllPermissionsCount` 整个函数替换为：

```go
func TestAllPermissionsCount(t *testing.T) {
	assert.Len(t, AllPermissions, 36)
	assert.Len(t, matrix, 36)
	assert.Equal(t,
		[]Permission{PermPriceConfig, PermCouponManage, PermPaymentAccountManage, PermProofReview},
		AllPermissions[32:], "新权限追加在末尾")
	assert.Equal(t, "price_config", string(PermPriceConfig))
	assert.Equal(t, "coupon_manage", string(PermCouponManage))
	assert.Equal(t, "payment_account_manage", string(PermPaymentAccountManage))
	assert.Equal(t, "proof_review", string(PermProofReview))
}
```

`web/admin/src/auth/can.test.ts` 整文件替换为：

```ts
import { describe, expect, it } from "vitest";
import {
  PERM_COUPON_MANAGE,
  PERM_EVENT_CONFIG,
  PERM_EVENT_PUBLISH,
  PERM_ORDER_VIEW,
  PERM_PAYMENT_ACCOUNT_MANAGE,
  PERM_PRICE_CONFIG,
  PERM_PROOF_REVIEW,
  can,
  type Access,
  type PermissionMap,
} from "./can";

describe("can", () => {
  it.each<[PermissionMap | undefined, string, Access, boolean]>([
    [undefined, "event_config", "read", false],
    [{}, "event_config", "read", false],
    [{ event_config: "read" }, "event_config", "read", true],
    [{ event_config: "read" }, "event_config", "write", false],
    [{ event_config: "write" }, "event_config", "read", true],
    [{ event_config: "write" }, "event_config", "write", true],
  ])("permissions=%j 对 %s 要求 %s → %s", (permissions, permission, access, expected) => {
    expect(can(permissions, permission, access)).toBe(expected);
  });
});

describe("权限名常量与后端 iam.Perm* 一致", () => {
  it.each([
    [PERM_EVENT_CONFIG, "event_config"],
    [PERM_EVENT_PUBLISH, "event_publish"],
    [PERM_ORDER_VIEW, "order_view"],
    [PERM_PRICE_CONFIG, "price_config"],
    [PERM_COUPON_MANAGE, "coupon_manage"],
    [PERM_PAYMENT_ACCOUNT_MANAGE, "payment_account_manage"],
    [PERM_PROOF_REVIEW, "proof_review"],
  ])("%s", (constant, expected) => {
    expect(constant).toBe(expected);
  });
});
```

Run: `cd api && go test ./internal/iam/ -run 'TestMatrix|TestAllPermissions|TestEveryPermission'` 与 `pnpm --filter @werun/admin test src/auth`
Expected: Go 编译失败 `undefined: PermPriceConfig`；Vitest FAIL，`PERM_PRICE_CONFIG` 等导出不存在（`expected undefined to be "price_config"`）。

- [ ] **Step 4: 实现权限**

`api/internal/iam/matrix.go` 常量块末尾：

```go
	PermAuditView          Permission = "audit_view"
)
```

改为：

```go
	PermAuditView          Permission = "audit_view"

	// 报名与收款凭证迭代新增（spec §8）
	PermPriceConfig          Permission = "price_config"
	PermCouponManage         Permission = "coupon_manage"
	PermPaymentAccountManage Permission = "payment_account_manage"
	PermProofReview          Permission = "proof_review"
)
```

`AllPermissions` 末尾：

```go
	PermAuditView,
}
```

改为：

```go
	PermAuditView,
	PermPriceConfig,
	PermCouponManage,
	PermPaymentAccountManage,
	PermProofReview,
}
```

`matrix` 末尾：

```go
	PermAuditView:          row("W", "R", "R", "", "", "", ""),
}
```

改为：

```go
	PermAuditView:          row("W", "R", "R", "", "", "", ""),

	PermPriceConfig:          row("R", "W", "R", "", "", "", ""),
	PermCouponManage:         row("R", "W", "R", "R", "", "", ""),
	PermPaymentAccountManage: row("R", "R", "W", "", "", "", ""),
	PermProofReview:          row("R", "R", "W", "R", "", "", ""),
}
```

（`gofmt` 会重新对齐常量与 map 的列，运行 `cd api && gofmt -w internal/iam/matrix.go`。）

`web/admin/src/auth/can.ts` 中：

```ts
export const PERM_EVENT_CONFIG = "event_config";
export const PERM_EVENT_PUBLISH = "event_publish";
```

改为：

```ts
export const PERM_EVENT_CONFIG = "event_config";
export const PERM_EVENT_PUBLISH = "event_publish";
export const PERM_ORDER_VIEW = "order_view";
export const PERM_PRICE_CONFIG = "price_config";
export const PERM_COUPON_MANAGE = "coupon_manage";
export const PERM_PAYMENT_ACCOUNT_MANAGE = "payment_account_manage";
export const PERM_PROOF_REVIEW = "proof_review";
```

Run: `cd api && go test ./internal/iam/ -v -run 'TestMatrix|TestAllPermissions|TestEveryPermission|TestAllowed'` 与 `pnpm --filter @werun/admin test src/auth`
Expected: Go PASS（`TestMatrixCellsMatchDemo` 11 个子测试）；Vitest `can.test.ts` 13 passed。

- [ ] **Step 5: 全量检查**

Run（colima 环境变量同 Step 1）：

```bash
cd api && go tool sqlc generate && git -C .. status --porcelain api/internal
cd api && go test ./...
cd api && go tool golangci-lint run ./...
pnpm typecheck && pnpm lint && pnpm --filter @werun/admin test
```

Expected：`sqlc generate` 后各 `store/models.go` 出现 `RegistrationConsent` 结构体、`DisclaimerVersion` 增加 `Purpose string`（这些生成文件的变更属于本任务，一并提交）；Go 测试与 lint 通过；前端类型检查、lint 与 admin 测试通过。

- [ ] **Step 6: 提交**

```bash
git add api/db/migrations/0010_registration_payment.sql api/db/registration_consents_test.go \
  api/internal/platform/migrate/migrate_test.go api/internal/iam/matrix.go api/internal/iam/matrix_test.go \
  api/internal/iam/store api/internal/event/store api/internal/platform/storage/store \
  web/admin/src/auth/can.ts web/admin/src/auth/can.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add registration consent migration and pricing/payment permissions

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
)"
```

---
### Task 3: 赛事详情与报名开关

**Files:**
- Modify: `api/openapi/openapi.yaml`（`adminGetEvent`、`adminUpdateEventRegistration`；`AdminEvent` 增加 4 个属性；新 schema `UpdateEventRegistrationRequest`）
- Generate: `api/internal/httpapi/apigen/api.gen.go`、`permissions.gen.go`、`packages/api-client/src/schema.d.ts`
- Modify: `api/db/queries/event.sql`；Generate: `api/internal/event/store/event.sql.go`
- Modify: `api/internal/event/model.go`、`validate.go`、`service.go`、`handlers.go`
- Test: `api/internal/event/validate_test.go`、`api/internal/event/service_test.go`、`api/internal/httpapi/events_http_test.go`
- Modify: `api/internal/platform/apperr/apperr.go`、`apperr_test.go`、`api/internal/platform/i18n/messages.{zh,en,km}.json`、`catalog_test.go`
- Create: `packages/api-client/src/money.ts`、`packages/api-client/src/money.test.ts`；Modify: `packages/api-client/src/index.ts`
- Create: `web/admin/src/pages/EventDetailPage.tsx`、`web/admin/src/events/RegistrationCard.tsx`、`web/admin/src/test/form.ts`、`web/admin/src/pages/EventDetailPage.test.tsx`
- Modify: `web/admin/src/events/queries.ts`、`web/admin/src/pages/EventsPage.tsx`、`web/admin/src/routes.tsx`、`web/admin/src/test/fixtures.ts`
- Modify: `packages/i18n/locales/{zh,en,km}/admin.json`

**Interfaces:**
- Consumes：`event.Service` 现有方法与 `eventFromRow` / `withCategories` / `loadCategories`；`audit.Record`；`iam.StaffFrom`；`apperr.New / WithField / WithParams`；`unwrap`、`ApiError`；`renderAdminApp`、`jsonResponse`
- Produces：
  - OpenAPI：`adminGetEvent`（`GET /admin/events/{id}`，`event_config` read）、`adminUpdateEventRegistration`（`PATCH /admin/events/{id}/registration`，`event_config` write）
  - `apperr.CodeRegistrationNotReady = "REGISTRATION_NOT_READY"`（422），`Params{missing, categories}` + 字段错误（契约补充 2）
  - `event.RegistrationInput`、`(*event.Service).GetAdmin`、`(*event.Service).UpdateRegistration`、`event.ValidateRegistration(in RegistrationInput) error`、`event.CheckRegistrationReady(e Event, categoriesWithoutPriceRule []string, usableAccounts int64) error`
  - 审计 `event.registration_update`（entity `event`，`IsFinancial=false`）
  - `packages/api-client`：`formatUsd(cents: number): string`、`parseUsdToCents(input: string): number | null`
  - 后台路由 `/events/:id` → `EventDetailPage`；testid `event-open-<slug>`、`event-registration-switch`、`event-registration-save`、`event-registration-not-ready`；标签页 label 容器 `event-tab-basic`
  - `web/admin/src/test/form.ts`：`setupFormUser()`、`fillField(user, id, value)`、`fillDateField(user, id, value)`（Task 4–6 的组件测试复用）

- [ ] **Step 1: 写后端纯函数的失败测试**

在 `api/internal/event/validate_test.go` 末尾追加：

```go
func TestValidateRegistration(t *testing.T) {
	require.NoError(t, event.ValidateRegistration(event.RegistrationInput{Open: true}))
	require.NoError(t, event.ValidateRegistration(event.RegistrationInput{
		Open: true, OpensAt: ptrTime("2026-09-20T00:00:00+07:00"), ClosesAt: ptrTime("2026-11-01T00:00:00+07:00"),
	}))
	require.NoError(t, event.ValidateRegistration(event.RegistrationInput{ClosesAt: ptrTime("2026-11-01T00:00:00+07:00")}))

	err := event.ValidateRegistration(event.RegistrationInput{
		Open: true, OpensAt: ptrTime("2026-11-01T00:00:00+07:00"), ClosesAt: ptrTime("2026-11-01T00:00:00+07:00"),
	})
	ae, ok := apperr.As(err)
	require.True(t, ok)
	require.Equal(t, apperr.CodeValidation, ae.Code)
	require.Equal(t, "field.ends_before_starts", fieldKeys(t, err)["closesAt"])
}

func TestCheckRegistrationReady(t *testing.T) {
	published := func(eventType string) event.Event {
		return event.Event{ID: 1, Slug: "pphm-2026", EventType: eventType, Status: event.StatusPublished}
	}
	cases := []struct {
		name       string
		ev         event.Event
		noPrice    []string
		accounts   int64
		missing    []string
		categories []string
		fields     map[string]string
	}{
		{name: "付费赛事全部就绪", ev: published(event.TypeRace), accounts: 1},
		{
			name: "草稿赛事", ev: event.Event{EventType: event.TypeRace, Status: event.StatusDraft}, accounts: 1,
			missing: []string{"PUBLISHED"}, categories: []string{},
			fields: map[string]string{"status": "field.event_not_published"},
		},
		{
			name: "组别缺价格档且没有收款账户", ev: published(event.TypeRace), noPrice: []string{"21K", "10K"},
			missing: []string{"PRICE_RULE", "PAYMENT_ACCOUNT"}, categories: []string{"21K", "10K"},
			fields: map[string]string{"priceRules": "field.missing_price_rule", "paymentAccounts": "field.missing_payment_account"},
		},
		{name: "免费活动不检查价格档与收款账户", ev: published(event.TypeFreeActivity), noPrice: []string{"5K"}},
		{
			name: "免费活动也必须已发布", ev: event.Event{EventType: event.TypeFreeActivity, Status: event.StatusDraft},
			missing: []string{"PUBLISHED"}, categories: []string{},
			fields: map[string]string{"status": "field.event_not_published"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := event.CheckRegistrationReady(tc.ev, tc.noPrice, tc.accounts)

			if tc.missing == nil {
				require.NoError(t, err)
				return
			}
			ae, ok := apperr.As(err)
			require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
			require.Equal(t, apperr.CodeRegistrationNotReady, ae.Code)
			require.Equal(t, http.StatusUnprocessableEntity, ae.Status)
			require.Equal(t, tc.missing, ae.Params["missing"])
			require.Equal(t, tc.categories, ae.Params["categories"])
			require.Equal(t, tc.fields, fieldKeys(t, err))
			if len(tc.noPrice) > 0 {
				require.Equal(t, "21K, 10K", ae.Fields["priceRules"].Params["categories"])
			}
		})
	}
}
```

Run: `cd api && go test ./internal/event/ -run 'TestValidateRegistration|TestCheckRegistrationReady'`
Expected: 编译失败，`undefined: event.ValidateRegistration`、`undefined: apperr.CodeRegistrationNotReady`。

- [ ] **Step 2: 实现错误码、文案、模型与纯函数**

`api/internal/platform/apperr/apperr.go`：常量块在 `CodeFileTypeNotAllowed` 之后加 `CodeRegistrationNotReady = "REGISTRATION_NOT_READY"`；`AllCodes` 末尾在 `CodeFileTypeNotAllowed,` 之后加 `CodeRegistrationNotReady,`。`apperr_test.go` 中 `assert.Len(t, apperr.AllCodes, 18)` 改为 `assert.Len(t, apperr.AllCodes, 19)`。

`messages.zh.json`：在 `"FILE_TYPE_NOT_ALLOWED"` 一行之后插入

```json
  "REGISTRATION_NOT_READY": "报名还不能开放，请先补齐下面列出的项目。",
```

在 `"field.category_incomplete"` 一行（文件最后一个条目）末尾补逗号，并在其后插入：

```json
  "field.event_not_published": "赛事发布后才能开放报名。",
  "field.missing_price_rule": "这些组别还没有价格档：{categories}。",
  "field.missing_payment_account": "没有可用于本赛事报名的启用中美元收款账户。",
  "field.ends_before_starts": "结束时间必须晚于开始时间。"
```

`messages.en.json` 同样位置：

```json
  "REGISTRATION_NOT_READY": "Registration can't be opened yet. Fix the items listed below.",
```

```json
  "field.event_not_published": "Publish the event before opening registration.",
  "field.missing_price_rule": "These categories have no price tier: {categories}.",
  "field.missing_payment_account": "There is no active USD payment account for this event's registration.",
  "field.ends_before_starts": "The end time must be after the start time."
```

`messages.km.json` 同样位置：

```json
  "REGISTRATION_NOT_READY": "មិនទាន់អាចបើកការចុះឈ្មោះបានទេ។ សូមបំពេញចំណុចដែលបានរាយខាងក្រោម។",
```

```json
  "field.event_not_published": "សូមផ្សព្វផ្សាយព្រឹត្តិការណ៍ជាមុនសិន ទើបអាចបើកការចុះឈ្មោះបាន។",
  "field.missing_price_rule": "ប្រភេទទាំងនេះមិនទាន់មានកម្រិតតម្លៃ៖ {categories}។",
  "field.missing_payment_account": "មិនមានគណនីទទួលប្រាក់ដុល្លារដែលកំពុងដំណើរការសម្រាប់ការចុះឈ្មោះព្រឹត្តិការណ៍នេះទេ។",
  "field.ends_before_starts": "ពេលវេលាបញ្ចប់ត្រូវតែនៅក្រោយពេលវេលាចាប់ផ្ដើម។"
```

`api/internal/platform/i18n/catalog_test.go` 的 key 列表：

```go
		"field.category_incomplete",
	)
```

改为：

```go
		"field.category_incomplete",
		"field.event_not_published",
		"field.missing_price_rule",
		"field.missing_payment_account",
		"field.ends_before_starts",
	)
```

`api/internal/event/model.go`：`Event` 结构体整体替换为：

```go
// Event 是赛事及其组别。
type Event struct {
	ID                   int64
	Slug                 string
	EventType            string
	OrganizerType        string
	Name                 i18n.Text
	City                 string
	RaceDate             time.Time // 日期，UTC 零点
	Timezone             string
	Status               string // StatusDraft | StatusPublished
	PublicVisible        bool
	PublishedAt          *time.Time
	RegistrationOpen     bool
	RegistrationOpensAt  *time.Time
	RegistrationClosesAt *time.Time
	Categories           []Category
}
```

文件末尾追加：

```go
// RegistrationInput 是后台修改报名开关与报名时间的输入；时间为 nil 表示不限。
type RegistrationInput struct {
	Open     bool
	OpensAt  *time.Time
	ClosesAt *time.Time
}

// 开放报名校验中缺失项的取值（REGISTRATION_NOT_READY 的 Params["missing"]）。
const (
	MissingPublished      = "PUBLISHED"
	MissingPriceRule      = "PRICE_RULE"
	MissingPaymentAccount = "PAYMENT_ACCOUNT"
)
```

`api/internal/event/validate.go` 末尾追加：

```go
// ValidateRegistration 校验报名时间：两者都有时截止必须晚于开始。
func ValidateRegistration(in RegistrationInput) error {
	if in.OpensAt != nil && in.ClosesAt != nil && !in.ClosesAt.After(*in.OpensAt) {
		return apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation).
			WithField("closesAt", "field.ends_before_starts", nil)
	}
	return nil
}

// CheckRegistrationReady 是开放报名前的校验：赛事必须已发布；付费赛事（RACE）每个组别至少有一个
// 价格档（categoriesWithoutPriceRule 为空），且至少有一个可用于该赛事报名的启用美元收款账户。
// 免费活动忽略后两个参数。不满足时返回 REGISTRATION_NOT_READY，Params 为 missing 与 categories，
// 同时附带字段错误供前端逐条展示（错误响应体不包含 Params）。
func CheckRegistrationReady(e Event, categoriesWithoutPriceRule []string, usableAccounts int64) error {
	notReady := apperr.New(http.StatusUnprocessableEntity, apperr.CodeRegistrationNotReady)
	missing := []string{}
	categories := []string{}

	if e.Status != StatusPublished {
		missing = append(missing, MissingPublished)
		notReady = notReady.WithField("status", "field.event_not_published", nil)
	}
	if e.EventType == TypeRace {
		if len(categoriesWithoutPriceRule) > 0 {
			missing = append(missing, MissingPriceRule)
			categories = append(categories, categoriesWithoutPriceRule...)
			notReady = notReady.WithField("priceRules", "field.missing_price_rule",
				map[string]any{"categories": strings.Join(categoriesWithoutPriceRule, ", ")})
		}
		if usableAccounts == 0 {
			missing = append(missing, MissingPaymentAccount)
			notReady = notReady.WithField("paymentAccounts", "field.missing_payment_account", nil)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	return notReady.WithParams(map[string]any{"missing": missing, "categories": categories})
}
```

Run: `cd api && go test ./internal/event/ -run 'TestValidate|TestCheckRegistrationReady' -v && go test ./internal/platform/apperr/ ./internal/platform/i18n/`
Expected: PASS（`TestCheckRegistrationReady` 5 个子测试）。

- [ ] **Step 3: 写服务的失败测试（数据库）**

在 `api/internal/event/service_test.go` 末尾追加：

```go
func seedPriceRuleFor(t *testing.T, pool *pgxpool.Pool, eventID, categoryID int64) {
	t.Helper()
	ctx := context.Background()
	var ruleID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO price_rules (event_id, name, audience, price_cents) VALUES ($1, '{"en":"Standard"}', 'ALL', 2500) RETURNING id`,
		eventID).Scan(&ruleID))
	_, err := pool.Exec(ctx, `INSERT INTO category_price_rules (category_id, price_rule_id) VALUES ($1, $2)`, categoryID, ruleID)
	require.NoError(t, err)
}

func seedPaymentAccount(t *testing.T, pool *pgxpool.Pool, scope string, eventID *int64, active bool, currency string) {
	t.Helper()
	ctx := context.Background()
	var fileID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO files (storage_key, visibility, purpose, mime_type, size_bytes, sha256, uploaded_by_type)
		 VALUES ('2026/09/' || md5(random()::text) || '.png', 'PUBLIC', 'PAYMENT_QR', 'image/png', 10, '\x01', 'SYSTEM')
		 RETURNING id`).Scan(&fileID))
	_, err := pool.Exec(ctx,
		`INSERT INTO payment_accounts (name, provider, account_name, account_no_masked, currency, qr_file_id, scope, event_id, active)
		 VALUES ('ABA USD', 'ABA', 'WERUN CO', '***123', $1, $2, $3, $4, $5)`,
		currency, fileID, scope, eventID, active)
	require.NoError(t, err)
}

func TestServiceGetAdminReturnsDraftsAndNotFound(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := event.NewService(pool)
	actor := newActor(t, pool, iam.RoleOps, "ops.getadmin")
	ctx := context.Background()
	created, err := svc.Create(ctx, actor, validInput())
	require.NoError(t, err)

	got, err := svc.GetAdmin(ctx, created.ID)

	require.NoError(t, err)
	require.Equal(t, event.StatusDraft, got.Status)
	require.Equal(t, "Asia/Phnom_Penh", got.Timezone)
	require.False(t, got.RegistrationOpen)
	require.Len(t, got.Categories, 1)

	_, err = svc.GetAdmin(ctx, 999999)
	ae, ok := apperr.As(err)
	require.True(t, ok)
	require.Equal(t, apperr.CodeEventNotFound, ae.Code)
}

func TestServiceUpdateRegistrationChecksReadinessThenOpens(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := event.NewService(pool)
	actor := newActor(t, pool, iam.RoleOps, "ops.registration")
	ctx := context.Background()
	created, err := svc.Create(ctx, actor, validInput())
	require.NoError(t, err)
	opensAt := ptrTime("2026-09-20T08:00:00+07:00")
	closesAt := ptrTime("2026-11-01T23:59:00+07:00")
	open := event.RegistrationInput{Open: true, OpensAt: opensAt, ClosesAt: closesAt}

	_, err = svc.UpdateRegistration(ctx, actor, created.ID, open)
	ae, ok := apperr.As(err)
	require.True(t, ok)
	require.Equal(t, apperr.CodeRegistrationNotReady, ae.Code)
	require.Equal(t, []string{"PUBLISHED", "PRICE_RULE", "PAYMENT_ACCOUNT"}, ae.Params["missing"])
	require.Equal(t, []string{"21K"}, ae.Params["categories"])

	_, err = svc.Publish(ctx, actor, created.ID)
	require.NoError(t, err)
	otherEvent := validInput()
	otherEvent.Slug = "other-run"
	other, err := svc.Create(ctx, actor, otherEvent)
	require.NoError(t, err)
	// 这些账户都不算：绑定其他赛事、停用、只收周边、瑞尔
	seedPaymentAccount(t, pool, "ALL", &other.ID, true, "USD")
	seedPaymentAccount(t, pool, "REGISTRATION", nil, false, "USD")
	seedPaymentAccount(t, pool, "MERCH", nil, true, "USD")
	seedPaymentAccount(t, pool, "ALL", nil, true, "KHR")
	seedPriceRuleFor(t, pool, created.ID, created.Categories[0].ID)

	_, err = svc.UpdateRegistration(ctx, actor, created.ID, open)
	ae, ok = apperr.As(err)
	require.True(t, ok)
	require.Equal(t, []string{"PAYMENT_ACCOUNT"}, ae.Params["missing"])
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM audit_logs WHERE action = 'event.registration_update'`))

	seedPaymentAccount(t, pool, "REGISTRATION", &created.ID, true, "USD")
	updated, err := svc.UpdateRegistration(ctx, actor, created.ID, open)

	require.NoError(t, err)
	require.True(t, updated.RegistrationOpen)
	require.True(t, updated.RegistrationOpensAt.Equal(*opensAt))
	require.True(t, updated.RegistrationClosesAt.Equal(*closesAt))
	require.Len(t, updated.Categories, 1)
	require.Equal(t, 1, countRows(t, pool,
		`SELECT count(*) FROM events WHERE id = $1 AND registration_open AND registration_opens_at = $2`, created.ID, *opensAt))
	require.Equal(t, 1, countRows(t, pool,
		`SELECT count(*) FROM audit_logs WHERE action = 'event.registration_update' AND entity_type = 'event'
		   AND entity_id = $1 AND actor_id = $2 AND NOT is_financial
		   AND before_data->>'open' = 'false' AND after_data->>'open' = 'true'`, created.ID, actor.ID))

	closed, err := svc.UpdateRegistration(ctx, actor, created.ID, event.RegistrationInput{Open: false})
	require.NoError(t, err)
	require.False(t, closed.RegistrationOpen)
	require.Nil(t, closed.RegistrationOpensAt)
}

func TestServiceUpdateRegistrationFreeActivitySkipsPricingChecks(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := event.NewService(pool)
	actor := newActor(t, pool, iam.RoleOps, "ops.free")
	ctx := context.Background()
	in := validInput()
	in.Slug = "sunday-fun-run"
	in.EventType = event.TypeFreeActivity
	created, err := svc.Create(ctx, actor, in)
	require.NoError(t, err)
	_, err = svc.Publish(ctx, actor, created.ID)
	require.NoError(t, err)

	updated, err := svc.UpdateRegistration(ctx, actor, created.ID, event.RegistrationInput{Open: true})

	require.NoError(t, err)
	require.True(t, updated.RegistrationOpen)
}

func TestServiceUpdateRegistrationValidationAndNotFound(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := event.NewService(pool)
	actor := newActor(t, pool, iam.RoleOps, "ops.regvalidate")
	ctx := context.Background()

	_, err := svc.UpdateRegistration(ctx, actor, 1, event.RegistrationInput{
		OpensAt: ptrTime("2026-11-01T00:00:00Z"), ClosesAt: ptrTime("2026-10-01T00:00:00Z"),
	})
	require.Equal(t, "field.ends_before_starts", fieldKeys(t, err)["closesAt"])

	_, err = svc.UpdateRegistration(ctx, actor, 999999, event.RegistrationInput{})
	ae, ok := apperr.As(err)
	require.True(t, ok)
	require.Equal(t, apperr.CodeEventNotFound, ae.Code)
}
```

Run（数据库测试需要 Docker；本机为 colima 时先 `export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true`）：
`cd api && go test ./internal/event/ -run 'TestServiceGetAdmin|TestServiceUpdateRegistration'`
Expected: 编译失败，`svc.GetAdmin undefined`、`svc.UpdateRegistration undefined`。

- [ ] **Step 4: 实现查询与服务**

`api/db/queries/event.sql` 末尾追加：

```sql
-- name: GetEventByID :one
SELECT * FROM events
WHERE id = @id;

-- name: UpdateEventRegistration :one
UPDATE events
SET registration_open = @registration_open,
    registration_opens_at = sqlc.narg(registration_opens_at),
    registration_closes_at = sqlc.narg(registration_closes_at),
    version = version + 1,
    updated_at = now()
WHERE id = @id
RETURNING *;

-- name: ListCategoryCodesWithoutPriceRule :many
SELECT c.code FROM event_categories c
WHERE c.event_id = @event_id
  AND NOT EXISTS (SELECT 1 FROM category_price_rules cpr WHERE cpr.category_id = c.id)
ORDER BY c.sort_order, c.id;

-- name: CountRegistrationPaymentAccounts :one
SELECT count(*) FROM payment_accounts
WHERE active
  AND currency = 'USD'
  AND scope IN ('REGISTRATION', 'ALL')
  AND (event_id = @event_id::bigint OR event_id IS NULL);
```

Run: `cd api && go tool sqlc generate`
Expected: `event.sql.go` 新增 `GetEventByID(ctx, id int64)`、`UpdateEventRegistration(ctx, UpdateEventRegistrationParams{RegistrationOpen bool, RegistrationOpensAt, RegistrationClosesAt *time.Time, ID int64})`、`ListCategoryCodesWithoutPriceRule(ctx, eventID int64) ([]string, error)`、`CountRegistrationPaymentAccounts(ctx, eventID int64) (int64, error)`。

`api/internal/event/service.go`（import 块不变；`validate.go` 已导入 `strings`）：`eventFromRow` 的返回值整体替换为：

```go
	return Event{
		ID:                   r.ID,
		Slug:                 r.Slug,
		EventType:            r.EventType,
		OrganizerType:        r.OrganizerType,
		Name:                 name,
		City:                 r.City,
		RaceDate:             r.RaceDate,
		Timezone:             r.Timezone,
		Status:               r.Status,
		PublicVisible:        r.PublicVisible,
		PublishedAt:          r.PublishedAt,
		RegistrationOpen:     r.RegistrationOpen,
		RegistrationOpensAt:  r.RegistrationOpensAt,
		RegistrationClosesAt: r.RegistrationClosesAt,
	}, nil
```

在 `ListAll` 之前插入：

```go
// GetAdmin 返回任意状态的赛事及其组别（后台用）；不存在返回 EVENT_NOT_FOUND。
func (s *Service) GetAdmin(ctx context.Context, id int64) (Event, error) {
	q := store.New(s.pool)
	row, err := q.GetEventByID(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Event{}, apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
	}
	if err != nil {
		return Event{}, fmt.Errorf("get event %d: %w", id, err)
	}
	events, err := withCategories(ctx, q, []store.Event{row})
	if err != nil {
		return Event{}, err
	}
	return events[0], nil
}

// UpdateRegistration 修改报名开关与报名时间。设为开放时锁定赛事行并做开放前校验
// （CheckRegistrationReady，统计用本包自己的查询，不依赖 pricing / payment 包），写审计 event.registration_update。
func (s *Service) UpdateRegistration(ctx context.Context, actor iam.Staff, id int64, in RegistrationInput) (Event, error) {
	if err := ValidateRegistration(in); err != nil {
		return Event{}, err
	}
	var out Event
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		row, err := q.GetEventForUpdate(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
		}
		if err != nil {
			return fmt.Errorf("lock event %d: %w", id, err)
		}
		before, err := eventFromRow(row)
		if err != nil {
			return err
		}

		if in.Open {
			var noPrice []string
			var accounts int64
			if before.EventType == TypeRace {
				if noPrice, err = q.ListCategoryCodesWithoutPriceRule(ctx, before.ID); err != nil {
					return fmt.Errorf("list categories without price rule: %w", err)
				}
				if accounts, err = q.CountRegistrationPaymentAccounts(ctx, before.ID); err != nil {
					return fmt.Errorf("count payment accounts: %w", err)
				}
			}
			if err := CheckRegistrationReady(before, noPrice, accounts); err != nil {
				return err
			}
		}

		updatedRow, err := q.UpdateEventRegistration(ctx, store.UpdateEventRegistrationParams{
			RegistrationOpen:     in.Open,
			RegistrationOpensAt:  in.OpensAt,
			RegistrationClosesAt: in.ClosesAt,
			ID:                   before.ID,
		})
		if err != nil {
			return fmt.Errorf("update registration of event %d: %w", id, err)
		}
		updated, err := eventFromRow(updatedRow)
		if err != nil {
			return err
		}
		cats, err := loadCategories(ctx, q, []int64{updated.ID})
		if err != nil {
			return err
		}
		updated.Categories = cats[updated.ID]
		out = updated

		actorID := actor.ID
		role := string(actor.Role)
		eventID := updated.ID
		return audit.Record(ctx, tx, audit.Entry{
			ActorType:  "STAFF",
			ActorID:    &actorID,
			ActorRole:  &role,
			Action:     "event.registration_update",
			EntityType: "event",
			EntityID:   updated.ID,
			EventID:    &eventID,
			Summary:    fmt.Sprintf("修改赛事 %s 报名设置（开放：%t）", updated.Slug, updated.RegistrationOpen),
			Before:     registrationSnapshot(before),
			After:      registrationSnapshot(updated),
			Meta:       httpx.MetaOf(ctx),
		})
	})
	if err != nil {
		return Event{}, err
	}
	return out, nil
}

func registrationSnapshot(e Event) map[string]any {
	return map[string]any{
		"open":     e.RegistrationOpen,
		"opensAt":  e.RegistrationOpensAt,
		"closesAt": e.RegistrationClosesAt,
	}
}
```

Run（colima 环境变量同 Step 3）：`cd api && go test ./internal/event/ -v`
Expected: 全部 PASS，含 `TestServiceUpdateRegistrationChecksReadinessThenOpens`。

- [ ] **Step 5: OpenAPI 与生成代码**

`api/openapi/openapi.yaml` 的 `paths` 中，在 `/admin/events/{id}/publish:` 之前插入：

```yaml
  /admin/events/{id}:
    get:
      operationId: adminGetEvent
      summary: 后台赛事详情（任意状态，含报名设置与组别）
      x-permission: event_config
      x-access: read
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: integer
            format: int64
      responses:
        '200':
          description: 赛事详情
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AdminEvent'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
  /admin/events/{id}/registration:
    patch:
      operationId: adminUpdateEventRegistration
      summary: 修改报名开关与报名时间（开放前校验发布状态、价格档与收款账户）
      x-permission: event_config
      x-access: write
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
              $ref: '#/components/schemas/UpdateEventRegistrationRequest'
      responses:
        '200':
          description: 已保存
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AdminEvent'
        default:
          description: 错误（未就绪时为 422 REGISTRATION_NOT_READY）
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
```

`components.schemas.AdminEvent` 的 `required` 改为：

```yaml
      required: [id, slug, eventType, organizerType, name, city, raceDate, timezone, status, publicVisible, publishedAt, registrationOpen, registrationOpensAt, registrationClosesAt, categories]
```

并在其 `publishedAt` 属性之后、`categories` 之前插入：

```yaml
        timezone:
          type: string
        registrationOpen:
          type: boolean
        registrationOpensAt:
          type: string
          format: date-time
          nullable: true
        registrationClosesAt:
          type: string
          format: date-time
          nullable: true
```

在 `AdminEventList` 之后插入：

```yaml
    UpdateEventRegistrationRequest:
      type: object
      required: [open]
      properties:
        open:
          type: boolean
        opensAt:
          type: string
          format: date-time
          nullable: true
        closesAt:
          type: string
          format: date-time
          nullable: true
```

Run: `make gen`
Expected: `api.gen.go` 出现 `AdminGetEventRequestObject{Id int64}`、`AdminUpdateEventRegistrationRequestObject{Id int64; Body *AdminUpdateEventRegistrationJSONRequestBody}`、`UpdateEventRegistrationRequest{ClosesAt *time.Time; Open bool; OpensAt *time.Time}`；`AdminEvent` 增加 `RegistrationClosesAt *time.Time`、`RegistrationOpen bool`、`RegistrationOpensAt *time.Time`、`Timezone string`；`permissions.gen.go` 增加 `"AdminGetEvent": {Kind: AuthPermission, Permission: "event_config", Access: "read"}` 与 `"AdminUpdateEventRegistration": {..., Access: "write"}`；`schema.d.ts` 同步。此时 `go build ./...` 因 `*Server` 未实现两个新方法而失败，下一步补上。

- [ ] **Step 6: 写接口的失败测试**

`api/internal/httpapi/events_http_test.go`：import 块加入 `"github.com/jackc/pgx/v5/pgxpool"`。`eventsEnv` 与 `newEventsEnv` 整体替换为：

```go
type eventsEnv struct {
	router  http.Handler
	iam     *iam.Service
	catalog *i18n.Catalog
	pool    *pgxpool.Pool
}

func newEventsEnv(t *testing.T) eventsEnv {
	t.Helper()
	gin.SetMode(gin.TestMode)
	pool := dbtest.NewPool(t)
	catalog, err := i18n.LoadCatalog()
	require.NoError(t, err)

	iamSvc := iam.NewService(pool, []byte(strings.Repeat("k", 32)), iam.NewLoginLimiter(time.Now), time.Now)
	router := httpapi.NewRouter(httpapi.RouterDeps{
		Log:     logx.New("error", io.Discard),
		Catalog: catalog,
		Pool:    pool,
		IAM:     iamSvc,
		Events:  event.NewService(pool),
		Env:     "dev",
	})
	return eventsEnv{router: router, iam: iamSvc, catalog: catalog, pool: pool}
}
```

文件末尾追加：

```go
var adminClientHeader = http.Header{httpx.HeaderClient: []string{"admin"}}

// createPublishedEvent 以 OPS 身份新建并发布 eventsCreateBody 描述的赛事，返回赛事。
func (e eventsEnv) createPublishedEvent(t *testing.T, ops *http.Cookie) apigen.AdminEvent {
	t.Helper()
	rec := e.do(t, http.MethodPost, "/api/admin/events", eventsCreateBody(), ops, adminClientHeader)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	created := eventsDecode[apigen.AdminEvent](t, rec)
	rec = e.do(t, http.MethodPost, fmt.Sprintf("/api/admin/events/%d/publish", created.Id), nil, ops, adminClientHeader)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	return eventsDecode[apigen.AdminEvent](t, rec)
}

func TestAdminEventDetailAndRegistrationSwitch(t *testing.T) {
	env := newEventsEnv(t)
	ctx := context.Background()
	ops := env.sessionCookie(t, iam.RoleOps, "ops.regswitch")
	finance := env.sessionCookie(t, iam.RoleFinance, "finance.regswitch")
	support := env.sessionCookie(t, iam.RoleSupport, "support.regswitch")
	ev := env.createPublishedEvent(t, ops)
	detailPath := fmt.Sprintf("/api/admin/events/%d", ev.Id)
	registrationPath := detailPath + "/registration"

	rec := env.do(t, http.MethodGet, detailPath, nil, finance, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	detail := eventsDecode[apigen.AdminEvent](t, rec)
	require.Equal(t, "Asia/Phnom_Penh", detail.Timezone)
	require.False(t, detail.RegistrationOpen)
	require.Nil(t, detail.RegistrationOpensAt)
	require.Len(t, detail.Categories, 1)

	rec = env.do(t, http.MethodGet, detailPath, nil, support, nil)
	require.Equal(t, http.StatusForbidden, rec.Code, "SUPPORT 没有 event_config")

	openBody := map[string]any{"open": true, "opensAt": "2026-09-20T08:00:00+07:00", "closesAt": nil}
	rec = env.do(t, http.MethodPatch, registrationPath, openBody, finance, adminClientHeader)
	require.Equal(t, http.StatusForbidden, rec.Code, "FINANCE 对 event_config 只读")

	rec = env.do(t, http.MethodPatch, registrationPath+"?lang=zh", openBody, ops, adminClientHeader)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	body := eventsDecode[httpx.ErrorBody](t, rec)
	require.Equal(t, apperr.CodeRegistrationNotReady, body.Error.Code)
	require.Equal(t, env.catalog.T(i18n.ZH, apperr.CodeRegistrationNotReady, nil), body.Error.Message)
	require.Equal(t, "这些组别还没有价格档：21K。", body.Error.Fields["priceRules"])
	require.Contains(t, body.Error.Fields, "paymentAccounts")

	var ruleID, fileID int64
	require.NoError(t, env.pool.QueryRow(ctx,
		`INSERT INTO price_rules (event_id, name, audience, price_cents) VALUES ($1, '{"en":"Std"}', 'ALL', 2500) RETURNING id`,
		ev.Id).Scan(&ruleID))
	_, err := env.pool.Exec(ctx, `INSERT INTO category_price_rules (category_id, price_rule_id) VALUES ($1, $2)`,
		ev.Categories[0].Id, ruleID)
	require.NoError(t, err)
	require.NoError(t, env.pool.QueryRow(ctx,
		`INSERT INTO files (storage_key, visibility, purpose, mime_type, size_bytes, sha256, uploaded_by_type)
		 VALUES ('2026/09/regswitch.png', 'PUBLIC', 'PAYMENT_QR', 'image/png', 10, '\x01', 'SYSTEM') RETURNING id`).Scan(&fileID))
	_, err = env.pool.Exec(ctx,
		`INSERT INTO payment_accounts (name, provider, account_name, account_no_masked, currency, qr_file_id, scope)
		 VALUES ('ABA USD', 'ABA', 'WERUN CO', '***123', 'USD', $1, 'ALL')`, fileID)
	require.NoError(t, err)

	rec = env.do(t, http.MethodPatch, registrationPath, openBody, ops, adminClientHeader)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	opened := eventsDecode[apigen.AdminEvent](t, rec)
	require.True(t, opened.RegistrationOpen)
	require.NotNil(t, opened.RegistrationOpensAt)
	require.Equal(t, "2026-09-20T01:00:00Z", opened.RegistrationOpensAt.UTC().Format(time.RFC3339))
	require.Nil(t, opened.RegistrationClosesAt)

	rec = env.do(t, http.MethodGet, "/api/admin/events/999999", nil, ops, nil)
	require.Equal(t, http.StatusNotFound, rec.Code)
	require.Equal(t, apperr.CodeEventNotFound, eventsDecode[httpx.ErrorBody](t, rec).Error.Code)
}
```

Run（colima 环境变量同 Step 3）：`cd api && go test ./internal/httpapi/ -run TestAdminEventDetailAndRegistrationSwitch`
Expected: 编译失败，`*Server does not implement apigen.StrictServerInterface (missing method AdminGetEvent)`。

- [ ] **Step 7: 实现 handler**

`api/internal/event/handlers.go`：在 `AdminPublishEvent` 之后插入：

```go
func (h *Handlers) AdminGetEvent(ctx context.Context, req apigen.AdminGetEventRequestObject) (apigen.AdminGetEventResponseObject, error) {
	ev, err := h.svc.GetAdmin(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	return apigen.AdminGetEvent200JSONResponse(toAdminEvent(ev)), nil
}

func (h *Handlers) AdminUpdateEventRegistration(ctx context.Context, req apigen.AdminUpdateEventRegistrationRequestObject) (apigen.AdminUpdateEventRegistrationResponseObject, error) {
	actor, ok := iam.StaffFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	ev, err := h.svc.UpdateRegistration(ctx, actor, req.Id, RegistrationInput{
		Open:     req.Body.Open,
		OpensAt:  req.Body.OpensAt,
		ClosesAt: req.Body.ClosesAt,
	})
	if err != nil {
		return nil, err
	}
	return apigen.AdminUpdateEventRegistration200JSONResponse(toAdminEvent(ev)), nil
}
```

`toAdminEvent` 的返回值整体替换为：

```go
	return apigen.AdminEvent{
		Id:                   e.ID,
		Slug:                 e.Slug,
		EventType:            apigen.AdminEventEventType(e.EventType),
		OrganizerType:        apigen.AdminEventOrganizerType(e.OrganizerType),
		Name:                 textToAPI(e.Name),
		City:                 e.City,
		RaceDate:             openapi_types.Date{Time: e.RaceDate},
		Timezone:             e.Timezone,
		Status:               apigen.AdminEventStatus(e.Status),
		PublicVisible:        e.PublicVisible,
		PublishedAt:          e.PublishedAt,
		RegistrationOpen:     e.RegistrationOpen,
		RegistrationOpensAt:  e.RegistrationOpensAt,
		RegistrationClosesAt: e.RegistrationClosesAt,
		Categories:           cats,
	}
```

Run（colima 环境变量同 Step 3）：`cd api && go test ./internal/event/ ./internal/httpapi/ -v -run 'TestAdmin|TestOps|TestService|TestValidate|TestCheck'`
Expected: PASS。

- [ ] **Step 8: 写 `money.ts` 的失败测试**

创建 `packages/api-client/src/money.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { formatUsd, parseUsdToCents } from "./index";

describe("formatUsd", () => {
  it.each([
    [2500, "$25.00"],
    [5, "$0.05"],
    [-5, "-$0.05"],
    [0, "$0.00"],
    [123456, "$1234.56"],
    [-250075, "-$2500.75"],
  ])("%i 分 → %s", (cents, expected) => {
    expect(formatUsd(cents)).toBe(expected);
  });
});

describe("parseUsdToCents", () => {
  it.each([
    ["25", 2500],
    ["25.5", 2550],
    ["25.50", 2550],
    [" 0.07 ", 7],
    ["0", 0],
    ["1999.99", 199999],
  ])("%j → %i", (input, expected) => {
    expect(parseUsdToCents(input)).toBe(expected);
  });

  it.each(["", " ", "abc", "25.505", "-1", "1e3", "25.", ".5", "$25", "1,000", "99999999999999"])(
    "%j → null",
    (input) => {
      expect(parseUsdToCents(input)).toBeNull();
    },
  );
});
```

Run: `pnpm --filter @werun/api-client test`
Expected: FAIL，`formatUsd is not a function`（`index.ts` 尚未导出）。

- [ ] **Step 9: 实现 `money.ts`**

创建 `packages/api-client/src/money.ts`：

```ts
const USD_INPUT = /^(\d{1,13})(?:\.(\d{1,2}))?$/;

/** 美分 → "$25.00"；负数 → "-$0.05"。不加千分位，便于与接口金额逐字比对 */
export function formatUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(abs / 100);
  const rest = abs % 100;
  return `${sign}$${dollars}.${String(rest).padStart(2, "0")}`;
}

/** 美元字符串 → 美分，按字符串解析不经过浮点。只接受非负数、至多两位小数；非法时返回 null */
export function parseUsdToCents(input: string): number | null {
  const match = USD_INPUT.exec(input.trim());
  if (!match) {
    return null;
  }
  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? "").padEnd(2, "0");
  return Number(whole) * 100 + Number(fraction);
}
```

`packages/api-client/src/index.ts` 在 `export { ApiError, ... } from "./errors";` 之后加一行：

```ts
export { formatUsd, parseUsdToCents } from "./money";
```

Run: `pnpm --filter @werun/api-client test && pnpm --filter @werun/api-client typecheck`
Expected: PASS（`money.test.ts` 23 个用例）。

- [ ] **Step 10: 写后台详情页的失败测试**

创建 `web/admin/src/test/form.ts`：

```ts
import userEvent, { PointerEventsCheckLevel } from "@testing-library/user-event";

export type FormUser = ReturnType<typeof userEvent.setup>;

/**
 * 表单测试专用的 user-event 实例：关闭 pointer-events 检查（原因见 app.test.tsx 的同名函数说明：
 * antd 注入的大量样式让每次 getComputedStyle 很慢，CI 上会超时）。
 */
export function setupFormUser(): FormUser {
  return userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
}

function byId(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`#${id}`);
  if (!element) {
    throw new Error(`找不到 #${id}`);
  }
  return element;
}

/** 按 antd 生成的 id（`<Form name>_<字段>`）聚焦后粘贴字段值 */
export async function fillField(user: FormUser, id: string, value: string): Promise<void> {
  await user.click(byId(id));
  await user.paste(value);
}

/** 先清空再粘贴，用于编辑已有值的输入框 */
export async function replaceField(user: FormUser, id: string, value: string): Promise<void> {
  const element = byId(id);
  await user.clear(element);
  await user.click(element);
  await user.paste(value);
}

/** 日期框粘贴后用 tab 失焦确认，避免在表单内按 Enter 触发原生隐式提交 */
export async function fillDateField(user: FormUser, id: string, value: string): Promise<void> {
  await fillField(user, id, value);
  await user.tab();
}
```

`web/admin/src/test/fixtures.ts` 中 `draftEvent` 的：

```ts
  status: "DRAFT",
  publicVisible: false,
  publishedAt: null,
```

改为：

```ts
  timezone: "Asia/Phnom_Penh",
  status: "DRAFT",
  publicVisible: false,
  publishedAt: null,
  registrationOpen: false,
  registrationOpensAt: null,
  registrationClosesAt: null,
```

并在 `draftEvent` 定义之后追加：

```ts
export const publishedEvent: Schemas["AdminEvent"] = {
  ...draftEvent,
  status: "PUBLISHED",
  publicVisible: true,
  publishedAt: "2026-09-14T03:00:00Z",
};
```

创建 `web/admin/src/pages/EventDetailPage.test.tsx`：

```tsx
import { screen, waitFor, within } from "@testing-library/react";
import dayjs from "dayjs";
import { beforeEach, describe, expect, it } from "vitest";
import { adminMe, draftEvent, jsonResponse, opsMe, publishedEvent } from "../test/fixtures";
import { fillDateField, setupFormUser } from "../test/form";
import { renderAdminApp } from "../test/renderAdminApp";

beforeEach(() => {
  window.localStorage.setItem("werun.lang", "en");
});

function patchRequest(requests: Request[]): Request | undefined {
  return requests.find(
    (request) => request.method === "PATCH" && new URL(request.url).pathname === "/api/admin/events/7/registration",
  );
}

describe("赛事详情", () => {
  it("从赛事列表点击名称进入详情页", async () => {
    const { router } = renderAdminApp("/events", {
      "GET /api/admin/me": () => jsonResponse(200, opsMe),
      "GET /api/admin/events": () => jsonResponse(200, { items: [draftEvent] }),
      "GET /api/admin/events/7": () => jsonResponse(200, draftEvent),
    });
    const user = setupFormUser();

    await user.click(await screen.findByTestId("event-open-phnom-penh-half-2026"));

    expect(await screen.findByRole("heading", { name: "Phnom Penh Half Marathon 2026" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/events/7");
    expect(screen.getByText("Asia/Phnom_Penh")).toBeInTheDocument();
    expect(screen.getByText("21K")).toBeInTheDocument();
    expect(screen.getByTestId("event-tab-basic")).toBeInTheDocument();
  });

  it("开放报名未就绪：显示服务端列出的每条原因", async () => {
    const { requests } = renderAdminApp("/events/7", {
      "GET /api/admin/me": () => jsonResponse(200, opsMe),
      "GET /api/admin/events/7": () => jsonResponse(200, publishedEvent),
      "PATCH /api/admin/events/7/registration": () =>
        jsonResponse(422, {
          error: {
            code: "REGISTRATION_NOT_READY",
            message: "Registration can't be opened yet. Fix the items listed below.",
            fields: {
              priceRules: "These categories have no price tier: 21K.",
              paymentAccounts: "There is no active USD payment account for this event's registration.",
            },
          },
        }),
    });
    const user = setupFormUser();

    await user.click(await screen.findByTestId("event-registration-switch"));
    await user.click(screen.getByTestId("event-registration-save"));

    const alert = await screen.findByTestId("event-registration-not-ready");
    expect(within(alert).getByText("Registration can't be opened yet. Fix the items listed below.")).toBeInTheDocument();
    expect(within(alert).getByText("These categories have no price tier: 21K.")).toBeInTheDocument();
    expect(
      within(alert).getByText("There is no active USD payment account for this event's registration."),
    ).toBeInTheDocument();
    expect(await patchRequest(requests)?.clone().json()).toEqual({ open: true, opensAt: null, closesAt: null });
    expect(patchRequest(requests)?.headers.get("X-WeRun-Client")).toBe("admin");
  });

  it("保存报名开关与开始时间", async () => {
    const opened = { ...publishedEvent, registrationOpen: true, registrationOpensAt: "2026-09-20T01:00:00Z" };
    const { requests } = renderAdminApp("/events/7", {
      "GET /api/admin/me": () => jsonResponse(200, opsMe),
      "GET /api/admin/events/7": () => jsonResponse(200, publishedEvent),
      "PATCH /api/admin/events/7/registration": () => jsonResponse(200, opened),
    });
    const user = setupFormUser();

    await user.click(await screen.findByTestId("event-registration-switch"));
    await fillDateField(user, "registration_opensAt", "2026-09-20 08:00");
    await user.click(screen.getByTestId("event-registration-save"));

    expect(await screen.findByText("Registration settings saved")).toBeInTheDocument();
    expect(screen.queryByTestId("event-registration-not-ready")).not.toBeInTheDocument();
    expect(await patchRequest(requests)?.clone().json()).toEqual({
      open: true,
      opensAt: dayjs("2026-09-20 08:00", "YYYY-MM-DD HH:mm").toISOString(),
      closesAt: null,
    });
    await waitFor(() => {
      expect(screen.getByTestId("event-registration-switch")).toHaveAttribute("aria-checked", "true");
    });
  });

  it("ADMIN 只读：开关不可操作，没有保存按钮", async () => {
    renderAdminApp("/events/7", {
      "GET /api/admin/me": () => jsonResponse(200, adminMe),
      "GET /api/admin/events/7": () => jsonResponse(200, publishedEvent),
    });

    expect(await screen.findByTestId("event-registration-switch")).toBeDisabled();
    expect(screen.queryByTestId("event-registration-save")).not.toBeInTheDocument();
  });
});
```

Run: `pnpm --filter @werun/admin test src/pages/EventDetailPage.test.tsx`
Expected: FAIL，第一个用例找不到 `event-open-phnom-penh-half-2026`；其余用例路由 `/events/7` 被 `*` 重定向到 `/events`，找不到 `event-registration-switch`。

- [ ] **Step 11: 实现查询、页面、路由与文案**

`web/admin/src/events/queries.ts` 末尾追加：

```ts
export function adminEventKey(id: number) {
  return ["admin", "events", id] as const;
}

export function useAdminEvent(id: number) {
  const api = useApi();
  return useQuery({
    queryKey: adminEventKey(id),
    queryFn: async () => unwrap(await api.GET("/admin/events/{id}", { params: { path: { id } } })),
    enabled: Number.isInteger(id) && id > 0,
  });
}

export function useUpdateEventRegistration(id: number) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: Schemas["UpdateEventRegistrationRequest"]) =>
      unwrap(await api.PATCH("/admin/events/{id}/registration", { params: { path: { id } }, body })),
    onSuccess: (event) => {
      queryClient.setQueryData(adminEventKey(id), event);
      return queryClient.invalidateQueries({ queryKey: ADMIN_EVENTS_KEY, exact: true });
    },
  });
}
```

创建 `web/admin/src/events/RegistrationCard.tsx`：

```tsx
import { ApiError, type Schemas } from "@werun/api-client";
import { App as AntdApp, Alert, Button, Card, Col, DatePicker, Form, Row, Switch } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useTranslation } from "react-i18next";
import { useUpdateEventRegistration } from "./queries";

interface RegistrationFormValues {
  open: boolean;
  opensAt?: Dayjs | null;
  closesAt?: Dayjs | null;
}

interface RegistrationCardProps {
  event: Schemas["AdminEvent"];
  canWrite: boolean;
}

export function RegistrationCard({ event, canWrite }: RegistrationCardProps) {
  const { t } = useTranslation("admin");
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<RegistrationFormValues>();
  const update = useUpdateEventRegistration(event.id);

  const error = update.error instanceof ApiError ? update.error : null;
  const notReady = error?.code === "REGISTRATION_NOT_READY" ? error : null;
  const otherError = update.error && !notReady && error?.code !== "VALIDATION_FAILED" ? update.error : null;

  const onFinish = (values: RegistrationFormValues) => {
    update.mutate(
      {
        open: values.open,
        opensAt: values.opensAt ? values.opensAt.toISOString() : null,
        closesAt: values.closesAt ? values.closesAt.toISOString() : null,
      },
      {
        onSuccess: () => void message.success(t("eventDetail.registration.saved")),
        onError: (err) => {
          if (err instanceof ApiError && err.code === "VALIDATION_FAILED") {
            form.setFields(
              Object.entries(err.fields).map(([name, text]) => ({
                name: name as keyof RegistrationFormValues,
                errors: [text],
              })),
            );
          }
        },
      },
    );
  };

  return (
    <Card title={t("eventDetail.registration.title")}>
      {notReady ? (
        <div data-testid="event-registration-not-ready" style={{ marginBottom: 16 }}>
          <Alert
            type="warning"
            showIcon
            message={notReady.message}
            description={
              <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                {Object.entries(notReady.fields).map(([field, text]) => (
                  <li key={field}>{text}</li>
                ))}
              </ul>
            }
          />
        </div>
      ) : null}
      {otherError ? <Alert type="error" showIcon message={otherError.message} style={{ marginBottom: 16 }} /> : null}
      <Form<RegistrationFormValues>
        form={form}
        name="registration"
        layout="vertical"
        onFinish={onFinish}
        disabled={!canWrite || update.isPending}
        initialValues={{
          open: event.registrationOpen,
          opensAt: event.registrationOpensAt ? dayjs(event.registrationOpensAt) : null,
          closesAt: event.registrationClosesAt ? dayjs(event.registrationClosesAt) : null,
        }}
      >
        <Form.Item name="open" label={t("eventDetail.registration.open")} valuePropName="checked">
          <Switch data-testid="event-registration-switch" />
        </Form.Item>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="opensAt" label={t("eventDetail.registration.opensAt")} extra={t("eventDetail.registration.timeHelp")}>
              <DatePicker showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="closesAt" label={t("eventDetail.registration.closesAt")} extra={t("eventDetail.registration.timeHelp")}>
              <DatePicker showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" style={{ width: "100%" }} />
            </Form.Item>
          </Col>
        </Row>
        {canWrite ? (
          <Button type="primary" htmlType="submit" loading={update.isPending} data-testid="event-registration-save">
            {t("eventDetail.registration.save")}
          </Button>
        ) : null}
      </Form>
    </Card>
  );
}
```

创建 `web/admin/src/pages/EventDetailPage.tsx`：

```tsx
import { ArrowLeftOutlined } from "@ant-design/icons";
import type { Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { Alert, Button, Card, Descriptions, Space, Spin, Table, Tabs, Tag, Typography, type TableProps, type TabsProps } from "antd";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate, useParams } from "react-router";
import { PERM_EVENT_CONFIG, can } from "../auth/can";
import { useMe } from "../auth/useMe";
import { RegistrationCard } from "../events/RegistrationCard";
import { pickText } from "../events/localize";
import { useAdminEvent } from "../events/queries";

type AdminCategory = Schemas["AdminCategory"];

export function EventDetailPage() {
  const { t } = useTranslation("admin");
  const lang = useLang();
  const navigate = useNavigate();
  const params = useParams();
  const eventId = Number(params.id);
  const { data: me } = useMe();
  const query = useAdminEvent(eventId);

  if (!Number.isInteger(eventId) || eventId <= 0) {
    return <Navigate to="/events" replace />;
  }
  if (query.isError) {
    return (
      <Alert
        type="error"
        showIcon
        message={query.error.message}
        action={
          <Button size="small" onClick={() => void navigate("/events")}>
            {t("eventDetail.back")}
          </Button>
        }
      />
    );
  }
  if (!query.data) {
    return <Spin />;
  }

  const event = query.data;
  const canWriteEvent = can(me?.permissions, PERM_EVENT_CONFIG, "write");

  const categoryColumns: TableProps<AdminCategory>["columns"] = [
    { title: t("eventDetail.categories.code"), dataIndex: "code", key: "code" },
    { title: t("eventDetail.categories.name"), key: "name", render: (_, category) => pickText(category.name, lang) },
    { title: t("eventDetail.categories.distanceM"), dataIndex: "distanceM", key: "distanceM" },
    { title: t("eventDetail.categories.capacity"), dataIndex: "capacity", key: "capacity" },
  ];

  const items: NonNullable<TabsProps["items"]> = [
    {
      key: "basic",
      label: <span data-testid="event-tab-basic">{t("eventDetail.tabBasic")}</span>,
      children: (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Card title={t("eventDetail.info.title")}>
            <Descriptions
              column={{ xs: 1, md: 2 }}
              items={[
                { key: "slug", label: t("eventDetail.info.slug"), children: event.slug },
                { key: "eventType", label: t("eventDetail.info.eventType"), children: t(`eventType.${event.eventType}`) },
                {
                  key: "status",
                  label: t("eventDetail.info.status"),
                  children: (
                    <Tag color={event.status === "PUBLISHED" ? "green" : "default"}>{t(`status.${event.status}`)}</Tag>
                  ),
                },
                { key: "raceDate", label: t("eventDetail.info.raceDate"), children: event.raceDate },
                { key: "city", label: t("eventDetail.info.city"), children: event.city },
                { key: "timezone", label: t("eventDetail.info.timezone"), children: event.timezone },
              ]}
            />
          </Card>
          <Card title={t("eventDetail.categories.title")}>
            <Table<AdminCategory>
              rowKey="id"
              columns={categoryColumns}
              dataSource={event.categories}
              pagination={false}
              scroll={{ x: 560 }}
            />
          </Card>
          <RegistrationCard event={event} canWrite={canWriteEvent} />
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Button type="link" icon={<ArrowLeftOutlined />} onClick={() => void navigate("/events")} style={{ paddingInline: 0 }}>
        {t("eventDetail.back")}
      </Button>
      <Typography.Title level={3} style={{ margin: 0 }}>
        {pickText(event.name, lang)}
      </Typography.Title>
      <Tabs items={items} />
    </Space>
  );
}
```

`web/admin/src/pages/EventsPage.tsx`：import 中 `import { useNavigate } from "react-router";` 改为 `import { Link, useNavigate } from "react-router";`；名称列：

```tsx
    { title: t("events.col.name"), key: "name", render: (_, event) => pickText(event.name, lang) },
```

改为：

```tsx
    {
      title: t("events.col.name"),
      key: "name",
      render: (_, event) => (
        <Link to={`/events/${event.id}`} data-testid={`event-open-${event.slug}`}>
          {pickText(event.name, lang)}
        </Link>
      ),
    },
```

`web/admin/src/routes.tsx`：import 中加入 `import { EventDetailPage } from "./pages/EventDetailPage";`；在 `events/new` 路由之后插入：

```tsx
          {
            path: "events/:id",
            element: (
              <RequirePermission permission={PERM_EVENT_CONFIG} access="read">
                <EventDetailPage />
              </RequirePermission>
            ),
          },
```

`packages/i18n/locales/zh/admin.json`，在 `"organizerType"` 条目之后（文件最后）补逗号并追加：

```json
  "eventDetail": {
    "back": "返回赛事列表",
    "tabBasic": "基本信息",
    "info": {
      "title": "基本信息",
      "slug": "链接标识",
      "eventType": "赛事类型",
      "status": "状态",
      "raceDate": "比赛日期",
      "city": "城市",
      "timezone": "时区"
    },
    "categories": { "title": "组别", "code": "代码", "name": "名称", "distanceM": "距离（米）", "capacity": "名额" },
    "registration": {
      "title": "报名设置",
      "open": "开放报名",
      "opensAt": "报名开始时间",
      "closesAt": "报名截止时间",
      "timeHelp": "留空表示不限",
      "save": "保存报名设置",
      "saved": "报名设置已保存"
    }
  }
```

`packages/i18n/locales/en/admin.json` 同位置：

```json
  "eventDetail": {
    "back": "Back to events",
    "tabBasic": "Overview",
    "info": {
      "title": "Overview",
      "slug": "URL slug",
      "eventType": "Event type",
      "status": "Status",
      "raceDate": "Race day",
      "city": "City",
      "timezone": "Time zone"
    },
    "categories": { "title": "Categories", "code": "Code", "name": "Name", "distanceM": "Distance (m)", "capacity": "Spots" },
    "registration": {
      "title": "Registration",
      "open": "Registration open",
      "opensAt": "Opens at",
      "closesAt": "Closes at",
      "timeHelp": "Leave empty for no limit",
      "save": "Save registration settings",
      "saved": "Registration settings saved"
    }
  }
```

`packages/i18n/locales/km/admin.json` 同位置：

```json
  "eventDetail": {
    "back": "ត្រឡប់ទៅបញ្ជីព្រឹត្តិការណ៍",
    "tabBasic": "ព័ត៌មានទូទៅ",
    "info": {
      "title": "ព័ត៌មានទូទៅ",
      "slug": "តំណ URL",
      "eventType": "ប្រភេទព្រឹត្តិការណ៍",
      "status": "ស្ថានភាព",
      "raceDate": "ថ្ងៃប្រកួត",
      "city": "ទីក្រុង",
      "timezone": "ល្វែងម៉ោង"
    },
    "categories": { "title": "ប្រភេទ", "code": "កូដ", "name": "ឈ្មោះ", "distanceM": "ចម្ងាយ (ម៉ែត្រ)", "capacity": "ចំនួនកន្លែង" },
    "registration": {
      "title": "ការចុះឈ្មោះ",
      "open": "បើកការចុះឈ្មោះ",
      "opensAt": "ពេលចាប់ផ្ដើមចុះឈ្មោះ",
      "closesAt": "ពេលបិទការចុះឈ្មោះ",
      "timeHelp": "ទុកទទេ ប្រសិនបើគ្មានកំណត់",
      "save": "រក្សាទុកការកំណត់ការចុះឈ្មោះ",
      "saved": "បានរក្សាទុកការកំណត់ការចុះឈ្មោះ"
    }
  }
```

Run: `pnpm --filter @werun/admin test`
Expected: PASS；`EventDetailPage.test.tsx` 4 个用例通过，原有 `app.test.tsx`、`can.test.ts`、`eventForm.test.ts` 继续通过。

- [ ] **Step 12: 全量检查**

Run（colima 环境变量同 Step 3）：

```bash
make gen && git status --porcelain
cd api && go test ./... && go tool golangci-lint run ./...
pnpm typecheck && pnpm lint && pnpm test && pnpm i18n:check
```

Expected：`make gen` 后除本任务已修改文件外无新变化；Go 测试与 lint 通过；前端类型检查、lint、测试通过，`i18n 检查通过`。

- [ ] **Step 13: 提交**

```bash
git add api/openapi/openapi.yaml api/internal/httpapi/apigen packages/api-client/src/schema.d.ts \
  api/db/queries/event.sql api/internal/event \
  api/internal/httpapi/events_http_test.go \
  api/internal/platform/apperr api/internal/platform/i18n \
  packages/api-client/src/money.ts packages/api-client/src/money.test.ts packages/api-client/src/index.ts \
  web/admin/src/pages/EventDetailPage.tsx web/admin/src/pages/EventDetailPage.test.tsx \
  web/admin/src/events/RegistrationCard.tsx web/admin/src/events/queries.ts \
  web/admin/src/pages/EventsPage.tsx web/admin/src/routes.tsx \
  web/admin/src/test/form.ts web/admin/src/test/fixtures.ts \
  packages/i18n/locales/zh/admin.json packages/i18n/locales/en/admin.json packages/i18n/locales/km/admin.json
git commit -m "$(cat <<'EOF'
feat: add admin event detail page with registration switch and readiness check

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
)"
```

---
### Task 4: 价格档

**Files:**
- Create: `api/internal/pricing/model.go`、`api/internal/pricing/service.go`、`api/internal/pricing/rules.go`、`api/internal/pricing/handlers.go`
- Create: `api/db/queries/pricing.sql`；Modify: `api/sqlc.yaml`；Generate: `api/internal/pricing/store/`
- Test: `api/internal/pricing/rules_test.go`、`api/internal/httpapi/pricing_http_test.go`
- Modify: `api/openapi/openapi.yaml`；Generate: `api/internal/httpapi/apigen/*`、`packages/api-client/src/schema.d.ts`
- Modify: `api/internal/httpapi/server.go`、`api/internal/httpapi/router.go`、`api/internal/httpapi/events_http_test.go`
- Modify: `api/cmd/werun/app.go`、`api/cmd/werun/router.go`
- Modify: `api/internal/platform/apperr/apperr.go`、`apperr_test.go`、`api/internal/platform/i18n/messages.{zh,en,km}.json`、`catalog_test.go`
- Create: `web/admin/src/pricing/queries.ts`、`web/admin/src/pricing/priceRuleForm.ts`、`web/admin/src/pricing/priceRuleForm.test.ts`、`web/admin/src/pricing/PricingTab.tsx`、`web/admin/src/pricing/PricingTab.test.tsx`
- Modify: `web/admin/src/pages/EventDetailPage.tsx`、`web/admin/src/test/fixtures.ts`、`packages/i18n/locales/{zh,en,km}/admin.json`

**Interfaces:**
- Consumes：`db.InTx`、`audit.Record`、`iam.Staff / StaffFrom`、`apperr.*`、`i18n.Text`、`httpx.MetaOf`；前端 `formatUsd`、`parseUsdToCents`、`toNamePath`（`events/eventForm.ts`）、`useAdminEvent`、`setupFormUser / fillField / replaceField`
- Produces（抄自契约 §3 与 §6、§7、§9、§10）：

```go
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
func NewService(pool *pgxpool.Pool, now func() time.Time) *Service
func (s *Service) ListPriceRules(ctx context.Context, eventID int64) ([]PriceRule, error)
func (s *Service) CreatePriceRule(ctx context.Context, actor iam.Staff, eventID int64, in PriceRuleInput) (PriceRule, error)
func (s *Service) UpdatePriceRule(ctx context.Context, actor iam.Staff, id int64, in PriceRuleInput) (PriceRule, error)
```

  - 本任务另外导出：`pricing.AudienceAll = "ALL"`、`pricing.AudienceLocal = "LOCAL"`、`pricing.ValidatePriceRule(in PriceRuleInput) error`、`pricing.NewHandlers(svc *Service) *Handlers`
  - `apperr.CodePriceRuleLocked = "PRICE_RULE_LOCKED"`（409）；字段文案 `field.quota_below_taken`（`{min}`）
  - OpenAPI：`adminListPriceRules`、`adminCreatePriceRule`、`adminUpdatePriceRule`；schema `PriceAudience`、`PriceRuleInput`、`PriceRule`、`PriceRuleList`
  - 审计 `price_rule.create` / `price_rule.update`（entity `price_rule`，`IsFinancial=false`，`EventID` 为赛事 id）
  - `httpapi.RouterDeps.Pricing *pricing.Service`、`type httpapi.PricingHandlers = pricing.Handlers`、`App.Pricing *pricing.Service`
  - 前端 testid 与表单：`event-tab-pricing`、`price-rule-create`、表单 `name="priceRule"`（字段 `name_zh`、`name_en`、`name_km`、`audience`、`priceUsd`、`quota`、`saleStartsAt`、`saleEndsAt`、`sortOrder`、`categoryIds`）、`price-rule-submit`、行 `price-rule-row-<id>`；另加编辑按钮 `price-rule-edit-<id>`

**价格档修改规则（spec §7）：** `used_count + reserved_count > 0` 时修改 `price_cents`、`audience` 或关联组别（按去重排序后的集合比较）返回 `PRICE_RULE_LOCKED`；`quota` 非空且小于 `used_count + reserved_count` 返回 `VALIDATION_FAILED`（字段 `quota`，`field.quota_below_taken`，参数 `min`）；名称、销售时间、排序随时可改；更新时 `category_price_rules` 整组替换；组别必须属于该价格档的赛事，否则 `VALIDATION_FAILED`（字段 `categoryIds`，`field.invalid`）。不提供删除。

- [ ] **Step 1: 写失败测试（校验 + 数据库）**

创建 `api/internal/pricing/rules_test.go`：

```go
package pricing_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/event"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/pricing"
)

func ptrTime(s string) *time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return &t
}

func ptrInt32(v int32) *int32 { return &v }

func fieldKeys(t *testing.T, err error) map[string]string {
	t.Helper()
	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	out := make(map[string]string, len(ae.Fields))
	for field, fe := range ae.Fields {
		out[field] = fe.Key
	}
	return out
}

func validRule(categoryIDs ...int64) pricing.PriceRuleInput {
	return pricing.PriceRuleInput{
		Name:         i18n.Text{i18n.ZH: "早鸟价", i18n.EN: "Early bird", i18n.KM: "តម្លៃទិញមុន"},
		Audience:     pricing.AudienceAll,
		PriceCents:   2500,
		Quota:        ptrInt32(100),
		SaleStartsAt: ptrTime("2026-09-20T00:00:00+07:00"),
		SaleEndsAt:   ptrTime("2026-10-01T00:00:00+07:00"),
		SortOrder:    1,
		CategoryIDs:  categoryIDs,
	}
}

func TestValidatePriceRule(t *testing.T) {
	require.NoError(t, pricing.ValidatePriceRule(validRule(1)))
	free := validRule(1)
	free.PriceCents = 0
	free.Quota = nil
	free.SaleStartsAt = nil
	require.NoError(t, pricing.ValidatePriceRule(free), "0 元档、不限量、只有结束时间都允许")

	cases := []struct {
		name   string
		mutate func(in *pricing.PriceRuleInput)
		field  string
		key    string
	}{
		{"缺高棉文名称", func(in *pricing.PriceRuleInput) { delete(in.Name, i18n.KM) }, "name.km", "field.required"},
		{"名称过长", func(in *pricing.PriceRuleInput) { in.Name[i18n.EN] = strings.Repeat("a", 61) }, "name.en", "field.too_long"},
		{"人群不在枚举内", func(in *pricing.PriceRuleInput) { in.Audience = "VIP" }, "audience", "field.invalid"},
		{"价格为负", func(in *pricing.PriceRuleInput) { in.PriceCents = -1 }, "priceCents", "field.invalid"},
		{"配额为负", func(in *pricing.PriceRuleInput) { in.Quota = ptrInt32(-1) }, "quota", "field.invalid"},
		{"结束不晚于开始", func(in *pricing.PriceRuleInput) { in.SaleEndsAt = in.SaleStartsAt }, "saleEndsAt", "field.ends_before_starts"},
		{"排序为负", func(in *pricing.PriceRuleInput) { in.SortOrder = -1 }, "sortOrder", "field.invalid"},
		{"没有关联组别", func(in *pricing.PriceRuleInput) { in.CategoryIDs = nil }, "categoryIds", "field.required"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := validRule(1)
			tc.mutate(&in)

			err := pricing.ValidatePriceRule(in)

			ae, ok := apperr.As(err)
			require.True(t, ok)
			require.Equal(t, apperr.CodeValidation, ae.Code)
			require.Equal(t, tc.key, fieldKeys(t, err)[tc.field], "fields=%v", fieldKeys(t, err))
		})
	}
}

type pricingFixture struct {
	svc     *pricing.Service
	pool    *pgxpool.Pool
	actor   iam.Staff
	event   event.Event
	other   event.Event
	cat21K  int64
	cat10K  int64
	otherID int64 // 其他赛事的组别
}

func newPricingFixture(t *testing.T) pricingFixture {
	t.Helper()
	ctx := context.Background()
	pool := dbtest.NewPool(t)
	iamSvc := iam.NewService(pool, []byte(strings.Repeat("s", 32)), iam.NewLoginLimiter(time.Now), time.Now)
	actor, err := iamSvc.CreateStaff(ctx, "ops.pricing", "Ops Pricing", iam.RoleOps, "Correct-Horse-Battery-9")
	require.NoError(t, err)

	events := event.NewService(pool)
	category := func(code string, distance int32) event.CategoryInput {
		return event.CategoryInput{
			Code:      code,
			Name:      i18n.Text{i18n.ZH: code, i18n.EN: code, i18n.KM: code},
			DistanceM: distance,
			Capacity:  500,
		}
	}
	in := event.CreateInput{
		Slug: "pphm-2026", EventType: event.TypeRace, OrganizerType: event.OrganizerOfficial,
		Name: i18n.Text{i18n.ZH: "金边半马", i18n.EN: "PP Half", i18n.KM: "ពាក់កណ្ដាលម៉ារ៉ាតុង"},
		City: "Phnom Penh", RaceDate: time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC),
		Categories: []event.CategoryInput{category("21K", 21097), category("10K", 10000)},
	}
	ev, err := events.Create(ctx, actor, in)
	require.NoError(t, err)
	in.Slug = "siem-reap-2026"
	in.Categories = []event.CategoryInput{category("5K", 5000)}
	other, err := events.Create(ctx, actor, in)
	require.NoError(t, err)

	return pricingFixture{
		svc: pricing.NewService(pool, time.Now), pool: pool, actor: actor, event: ev, other: other,
		cat21K: ev.Categories[0].ID, cat10K: ev.Categories[1].ID, otherID: other.Categories[0].ID,
	}
}

func (f pricingFixture) count(t *testing.T, sql string, args ...any) int {
	t.Helper()
	var n int
	require.NoError(t, f.pool.QueryRow(context.Background(), sql, args...).Scan(&n))
	return n
}

func TestCreateAndListPriceRules(t *testing.T) {
	f := newPricingFixture(t)
	ctx := context.Background()

	standard := validRule(f.cat10K, f.cat21K, f.cat21K)
	standard.Name = i18n.Text{i18n.ZH: "标准价", i18n.EN: "Standard", i18n.KM: "តម្លៃស្តង់ដារ"}
	standard.SortOrder = 2
	standard.Quota = nil
	created, err := f.svc.CreatePriceRule(ctx, f.actor, f.event.ID, standard)
	require.NoError(t, err)
	early, err := f.svc.CreatePriceRule(ctx, f.actor, f.event.ID, validRule(f.cat21K))
	require.NoError(t, err)

	assert.NotZero(t, created.ID)
	assert.Equal(t, f.event.ID, created.EventID)
	assert.Equal(t, []int64{min(f.cat21K, f.cat10K), max(f.cat21K, f.cat10K)}, created.Input.CategoryIDs, "去重并排序")
	assert.Nil(t, created.Input.Quota)
	assert.Equal(t, 1, f.count(t, `SELECT count(*) FROM price_rules WHERE id = $1 AND currency = 'USD'`, created.ID))
	assert.Equal(t, 2, f.count(t, `SELECT count(*) FROM category_price_rules WHERE price_rule_id = $1`, created.ID))
	assert.Equal(t, 2, f.count(t,
		`SELECT count(*) FROM audit_logs WHERE action = 'price_rule.create' AND entity_type = 'price_rule'
		   AND event_id = $1 AND actor_id = $2 AND NOT is_financial`, f.event.ID, f.actor.ID))

	list, err := f.svc.ListPriceRules(ctx, f.event.ID)
	require.NoError(t, err)
	require.Len(t, list, 2)
	assert.Equal(t, early.ID, list[0].ID, "按 sort_order 排序")
	assert.Equal(t, "Early bird", list[0].Input.Name[i18n.EN])
	assert.True(t, list[0].Input.SaleStartsAt.Equal(*validRule().SaleStartsAt))
	assert.Equal(t, []int64{f.cat21K}, list[0].Input.CategoryIDs)
	assert.Equal(t, created.Input.CategoryIDs, list[1].Input.CategoryIDs)

	empty, err := f.svc.ListPriceRules(ctx, f.other.ID)
	require.NoError(t, err)
	assert.Empty(t, empty)
}

func TestCreatePriceRuleRejectsUnknownEventAndForeignCategory(t *testing.T) {
	f := newPricingFixture(t)
	ctx := context.Background()

	_, err := f.svc.CreatePriceRule(ctx, f.actor, 999999, validRule(f.cat21K))
	ae, ok := apperr.As(err)
	require.True(t, ok)
	assert.Equal(t, apperr.CodeEventNotFound, ae.Code)

	_, err = f.svc.ListPriceRules(ctx, 999999)
	ae, ok = apperr.As(err)
	require.True(t, ok)
	assert.Equal(t, apperr.CodeEventNotFound, ae.Code)

	_, err = f.svc.CreatePriceRule(ctx, f.actor, f.event.ID, validRule(f.cat21K, f.otherID))
	assert.Equal(t, "field.invalid", fieldKeys(t, err)["categoryIds"])
	assert.Equal(t, 0, f.count(t, `SELECT count(*) FROM price_rules`))
	assert.Equal(t, 0, f.count(t, `SELECT count(*) FROM audit_logs WHERE action = 'price_rule.create'`))
}

func TestUpdatePriceRuleWithoutReservationsReplacesEverything(t *testing.T) {
	f := newPricingFixture(t)
	ctx := context.Background()
	rule, err := f.svc.CreatePriceRule(ctx, f.actor, f.event.ID, validRule(f.cat21K))
	require.NoError(t, err)

	changed := validRule(f.cat10K)
	changed.Audience = pricing.AudienceLocal
	changed.PriceCents = 1500
	changed.Quota = nil

	updated, err := f.svc.UpdatePriceRule(ctx, f.actor, rule.ID, changed)

	require.NoError(t, err)
	assert.Equal(t, pricing.AudienceLocal, updated.Input.Audience)
	assert.Equal(t, int64(1500), updated.Input.PriceCents)
	assert.Equal(t, []int64{f.cat10K}, updated.Input.CategoryIDs)
	assert.Equal(t, 1, f.count(t, `SELECT count(*) FROM category_price_rules WHERE price_rule_id = $1 AND category_id = $2`, rule.ID, f.cat10K))
	assert.Equal(t, 0, f.count(t, `SELECT count(*) FROM category_price_rules WHERE price_rule_id = $1 AND category_id = $2`, rule.ID, f.cat21K))
	assert.Equal(t, 1, f.count(t,
		`SELECT count(*) FROM audit_logs WHERE action = 'price_rule.update' AND entity_id = $1
		   AND before_data->>'priceCents' = '2500' AND after_data->>'priceCents' = '1500'`, rule.ID))

	_, err = f.svc.UpdatePriceRule(ctx, f.actor, 999999, changed)
	ae, ok := apperr.As(err)
	require.True(t, ok)
	assert.Equal(t, apperr.CodeNotFound, ae.Code)
	assert.Equal(t, http.StatusNotFound, ae.Status)
}

func TestUpdatePriceRuleLockedOnceTaken(t *testing.T) {
	f := newPricingFixture(t)
	ctx := context.Background()
	rule, err := f.svc.CreatePriceRule(ctx, f.actor, f.event.ID, validRule(f.cat21K, f.cat10K))
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE price_rules SET used_count = 1, reserved_count = 2 WHERE id = $1`, rule.ID)
	require.NoError(t, err)

	lockedCases := map[string]func(in *pricing.PriceRuleInput){
		"改价格":   func(in *pricing.PriceRuleInput) { in.PriceCents = 2400 },
		"改人群":   func(in *pricing.PriceRuleInput) { in.Audience = pricing.AudienceLocal },
		"改关联组别": func(in *pricing.PriceRuleInput) { in.CategoryIDs = []int64{f.cat21K} },
	}
	for name, mutate := range lockedCases {
		t.Run(name, func(t *testing.T) {
			in := validRule(f.cat21K, f.cat10K)
			mutate(&in)

			_, err := f.svc.UpdatePriceRule(ctx, f.actor, rule.ID, in)

			ae, ok := apperr.As(err)
			require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
			assert.Equal(t, apperr.CodePriceRuleLocked, ae.Code)
			assert.Equal(t, http.StatusConflict, ae.Status)
		})
	}

	belowTaken := validRule(f.cat10K, f.cat21K)
	belowTaken.Quota = ptrInt32(2)
	_, err = f.svc.UpdatePriceRule(ctx, f.actor, rule.ID, belowTaken)
	require.Equal(t, "field.quota_below_taken", fieldKeys(t, err)["quota"])
	ae, _ := apperr.As(err)
	assert.Equal(t, int32(3), ae.Fields["quota"].Params["min"])

	allowed := validRule(f.cat10K, f.cat21K) // 组别顺序不同但集合相同
	allowed.Name = i18n.Text{i18n.ZH: "早鸟价（延长）", i18n.EN: "Early bird (extended)", i18n.KM: "តម្លៃទិញមុន (បន្ថែម)"}
	allowed.SaleEndsAt = ptrTime("2026-10-15T00:00:00+07:00")
	allowed.SortOrder = 5
	allowed.Quota = ptrInt32(3)
	updated, err := f.svc.UpdatePriceRule(ctx, f.actor, rule.ID, allowed)

	require.NoError(t, err)
	assert.Equal(t, "Early bird (extended)", updated.Input.Name[i18n.EN])
	assert.Equal(t, int16(5), updated.Input.SortOrder)
	assert.Equal(t, int32(3), *updated.Input.Quota)
	assert.Equal(t, int32(1), updated.UsedCount)
	assert.Equal(t, int32(2), updated.ReservedCount)
	assert.Equal(t, 1, f.count(t, `SELECT count(*) FROM audit_logs WHERE action = 'price_rule.update'`))
}
```

Run（数据库测试需要 Docker；本机为 colima 时先 `export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true`）：
`cd api && go test ./internal/pricing/`
Expected: 编译失败，`no non-test Go files in .../internal/pricing`。

- [ ] **Step 2: 错误码与文案**

`api/internal/platform/apperr/apperr.go`：常量块在 `CodeRegistrationNotReady` 之后加 `CodePriceRuleLocked = "PRICE_RULE_LOCKED"`；`AllCodes` 在 `CodeRegistrationNotReady,` 之后加 `CodePriceRuleLocked,`；`apperr_test.go` 中 `assert.Len(t, apperr.AllCodes, 19)` 改为 `20`。

`messages.zh.json`：`"REGISTRATION_NOT_READY"` 一行之后插入 `"PRICE_RULE_LOCKED": "这个价格档已有报名占用，不能再修改价格、适用人群或关联组别。",`；`"field.ends_before_starts"` 一行末尾补逗号后追加 `"field.quota_below_taken": "不能少于已占用的 {min} 个名额。"`。

`messages.en.json`：`"PRICE_RULE_LOCKED": "This price tier already has registrations, so its price, audience and categories can't be changed.",`；`"field.quota_below_taken": "Can't be lower than the {min} spots already taken."`。

`messages.km.json`：`"PRICE_RULE_LOCKED": "កម្រិតតម្លៃនេះមានការចុះឈ្មោះរួចហើយ ដូច្នេះមិនអាចកែតម្លៃ ក្រុមអ្នកមានសិទ្ធិ ឬប្រភេទបានទេ។",`；`"field.quota_below_taken": "មិនអាចតិចជាង {min} កន្លែងដែលបានប្រើរួចហើយទេ។"`。

`catalog_test.go` key 列表在 `"field.ends_before_starts",` 之后加 `"field.quota_below_taken",`。

Run: `cd api && go test ./internal/platform/apperr/ ./internal/platform/i18n/`
Expected: 编译失败——常量尚未定义时报 `undefined`；加完常量与三语文案后 PASS。

- [ ] **Step 3: 查询与 sqlc**

创建 `api/db/queries/pricing.sql`：

```sql
-- name: EventExists :one
SELECT EXISTS (SELECT 1 FROM events WHERE id = @id);

-- name: ListCategoryIDsOfEvent :many
SELECT id FROM event_categories
WHERE event_id = @event_id
ORDER BY id;

-- name: InsertPriceRule :one
INSERT INTO price_rules (event_id, name, audience, price_cents, currency, quota, sale_starts_at, sale_ends_at, sort_order)
VALUES (@event_id, @name, @audience, @price_cents, 'USD', sqlc.narg(quota), sqlc.narg(sale_starts_at),
        sqlc.narg(sale_ends_at), @sort_order)
RETURNING *;

-- name: GetPriceRuleForUpdate :one
SELECT * FROM price_rules
WHERE id = @id
FOR UPDATE;

-- name: UpdatePriceRule :one
UPDATE price_rules
SET name = @name,
    audience = @audience,
    price_cents = @price_cents,
    quota = sqlc.narg(quota),
    sale_starts_at = sqlc.narg(sale_starts_at),
    sale_ends_at = sqlc.narg(sale_ends_at),
    sort_order = @sort_order,
    updated_at = now()
WHERE id = @id
RETURNING *;

-- name: ListPriceRulesByEvent :many
SELECT * FROM price_rules
WHERE event_id = @event_id
ORDER BY sort_order, id;

-- name: ListCategoryLinksByRuleIDs :many
SELECT category_id, price_rule_id FROM category_price_rules
WHERE price_rule_id = ANY(@rule_ids::bigint[])
ORDER BY price_rule_id, category_id;

-- name: DeleteCategoryLinksByRule :exec
DELETE FROM category_price_rules
WHERE price_rule_id = @price_rule_id;

-- name: InsertCategoryLink :exec
INSERT INTO category_price_rules (category_id, price_rule_id)
VALUES (@category_id, @price_rule_id);
```

`api/sqlc.yaml` 末尾追加 pricing 块（与 storage 块逐字相同，只改两行）：

```yaml
  - engine: postgresql
    schema: db/migrations
    queries: db/queries/pricing.sql
    gen:
      go:
        package: store
        out: internal/pricing/store
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

Run: `cd api && go tool sqlc generate`
Expected: 生成 `api/internal/pricing/store/`；`InsertPriceRuleParams{EventID int64; Name []byte; Audience string; PriceCents int64; Quota *int32; SaleStartsAt, SaleEndsAt *time.Time; SortOrder int16}`，`UpdatePriceRuleParams` 同上另含 `ID`，`ListCategoryLinksByRuleIDs(ctx, ruleIds []int64)` 返回元素带 `CategoryID`、`PriceRuleID` 字段。

- [ ] **Step 4: 实现 pricing 服务**

创建 `api/internal/pricing/model.go`：

```go
// Package pricing 是价格与优惠模块：价格档、优惠码的后台维护，以及下单算价（Task 11 起）。
package pricing

import (
	"time"

	"werun/api/internal/platform/i18n"
)

// price_rules.audience 的取值。
const (
	AudienceAll   = "ALL"
	AudienceLocal = "LOCAL"
)

// PriceRuleInput 是后台新建或修改价格档的输入。
type PriceRuleInput struct {
	Name         i18n.Text
	Audience     string
	PriceCents   int64
	Quota        *int32 // nil = 不限
	SaleStartsAt *time.Time
	SaleEndsAt   *time.Time
	SortOrder    int16
	CategoryIDs  []int64
}

// PriceRule 是价格档及其计数。
type PriceRule struct {
	ID, EventID   int64
	Input         PriceRuleInput
	UsedCount     int32
	ReservedCount int32
}
```

创建 `api/internal/pricing/service.go`：

```go
package pricing

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"werun/api/internal/audit"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/pricing/store"
)

var requiredLangs = []i18n.Lang{i18n.ZH, i18n.EN, i18n.KM}

// Service 是价格与优惠模块的业务入口。
type Service struct {
	pool *pgxpool.Pool
	now  func() time.Time
}

// NewService 创建服务；now 供算价与优惠码有效期判断使用（测试注入固定时间）。
func NewService(pool *pgxpool.Pool, now func() time.Time) *Service {
	return &Service{pool: pool, now: now}
}

func requireEvent(ctx context.Context, q *store.Queries, eventID int64) error {
	exists, err := q.EventExists(ctx, eventID)
	if err != nil {
		return fmt.Errorf("check event %d: %w", eventID, err)
	}
	if !exists {
		return apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
	}
	return nil
}

// normalizeIDs 返回去重、升序的副本。
func normalizeIDs(ids []int64) []int64 {
	out := slices.Clone(ids)
	slices.Sort(out)
	return slices.Compact(out)
}

func validationError() *apperr.Error {
	return apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)
}

func staffEntry(ctx context.Context, actor iam.Staff, action, entityType string, entityID int64, eventID *int64, summary string, before, after any) audit.Entry {
	actorID := actor.ID
	role := string(actor.Role)
	return audit.Entry{
		ActorType:  "STAFF",
		ActorID:    &actorID,
		ActorRole:  &role,
		Action:     action,
		EntityType: entityType,
		EntityID:   entityID,
		EventID:    eventID,
		Summary:    summary,
		Before:     before,
		After:      after,
		Meta:       httpx.MetaOf(ctx),
	}
}
```

创建 `api/internal/pricing/rules.go`：

```go
package pricing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/audit"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/pricing/store"
)

const priceRuleNameMaxLen = 60

// ValidatePriceRule 校验价格档输入，一次返回全部字段错误。组别归属在事务里另行检查。
func ValidatePriceRule(in PriceRuleInput) error {
	verr := validationError()
	failed := false
	add := func(field, key string, params map[string]any) {
		verr = verr.WithField(field, key, params)
		failed = true
	}

	for _, l := range requiredLangs {
		name := strings.TrimSpace(in.Name[l])
		switch {
		case name == "":
			add("name."+string(l), "field.required", nil)
		case utf8.RuneCountInString(name) > priceRuleNameMaxLen:
			add("name."+string(l), "field.too_long", map[string]any{"max": priceRuleNameMaxLen})
		}
	}
	if in.Audience != AudienceAll && in.Audience != AudienceLocal {
		add("audience", "field.invalid", nil)
	}
	if in.PriceCents < 0 {
		add("priceCents", "field.invalid", nil)
	}
	if in.Quota != nil && *in.Quota < 0 {
		add("quota", "field.invalid", nil)
	}
	if in.SaleStartsAt != nil && in.SaleEndsAt != nil && !in.SaleEndsAt.After(*in.SaleStartsAt) {
		add("saleEndsAt", "field.ends_before_starts", nil)
	}
	if in.SortOrder < 0 {
		add("sortOrder", "field.invalid", nil)
	}
	if len(in.CategoryIDs) == 0 {
		add("categoryIds", "field.required", nil)
	}

	if failed {
		return verr
	}
	return nil
}

// ListPriceRules 返回赛事的全部价格档（按排序、id）；赛事不存在返回 EVENT_NOT_FOUND。
func (s *Service) ListPriceRules(ctx context.Context, eventID int64) ([]PriceRule, error) {
	q := store.New(s.pool)
	if err := requireEvent(ctx, q, eventID); err != nil {
		return nil, err
	}
	rows, err := q.ListPriceRulesByEvent(ctx, eventID)
	if err != nil {
		return nil, fmt.Errorf("list price rules of event %d: %w", eventID, err)
	}
	ids := make([]int64, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.ID)
	}
	links, err := categoryIDsByRule(ctx, q, ids)
	if err != nil {
		return nil, err
	}
	out := make([]PriceRule, 0, len(rows))
	for _, r := range rows {
		rule, err := priceRuleFromRow(r, links[r.ID])
		if err != nil {
			return nil, err
		}
		out = append(out, rule)
	}
	return out, nil
}

// CreatePriceRule 新建价格档并关联组别，写审计 price_rule.create。
func (s *Service) CreatePriceRule(ctx context.Context, actor iam.Staff, eventID int64, in PriceRuleInput) (PriceRule, error) {
	if err := ValidatePriceRule(in); err != nil {
		return PriceRule{}, err
	}
	in.CategoryIDs = normalizeIDs(in.CategoryIDs)
	name, err := json.Marshal(in.Name)
	if err != nil {
		return PriceRule{}, fmt.Errorf("encode price rule name: %w", err)
	}

	var out PriceRule
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		if err := requireEvent(ctx, q, eventID); err != nil {
			return err
		}
		if err := requireCategoriesOf(ctx, q, eventID, in.CategoryIDs); err != nil {
			return err
		}
		row, err := q.InsertPriceRule(ctx, store.InsertPriceRuleParams{
			EventID:      eventID,
			Name:         name,
			Audience:     in.Audience,
			PriceCents:   in.PriceCents,
			Quota:        in.Quota,
			SaleStartsAt: in.SaleStartsAt,
			SaleEndsAt:   in.SaleEndsAt,
			SortOrder:    in.SortOrder,
		})
		if err != nil {
			return fmt.Errorf("insert price rule: %w", err)
		}
		if err := insertCategoryLinks(ctx, q, row.ID, in.CategoryIDs); err != nil {
			return err
		}
		rule, err := priceRuleFromRow(row, in.CategoryIDs)
		if err != nil {
			return err
		}
		out = rule
		return audit.Record(ctx, tx, staffEntry(ctx, actor, "price_rule.create", "price_rule", rule.ID, &rule.EventID,
			fmt.Sprintf("新建价格档 %d（%s，%d 分）", rule.ID, rule.Input.Audience, rule.Input.PriceCents),
			nil, priceRuleSnapshot(rule)))
	})
	if err != nil {
		return PriceRule{}, err
	}
	return out, nil
}

// UpdatePriceRule 锁定价格档后按 spec §7 的规则修改，写审计 price_rule.update。
func (s *Service) UpdatePriceRule(ctx context.Context, actor iam.Staff, id int64, in PriceRuleInput) (PriceRule, error) {
	if err := ValidatePriceRule(in); err != nil {
		return PriceRule{}, err
	}
	in.CategoryIDs = normalizeIDs(in.CategoryIDs)
	name, err := json.Marshal(in.Name)
	if err != nil {
		return PriceRule{}, fmt.Errorf("encode price rule name: %w", err)
	}

	var out PriceRule
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		row, err := q.GetPriceRuleForUpdate(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeNotFound)
		}
		if err != nil {
			return fmt.Errorf("lock price rule %d: %w", id, err)
		}
		links, err := categoryIDsByRule(ctx, q, []int64{id})
		if err != nil {
			return err
		}
		before, err := priceRuleFromRow(row, links[id])
		if err != nil {
			return err
		}
		if err := requireCategoriesOf(ctx, q, row.EventID, in.CategoryIDs); err != nil {
			return err
		}

		taken := row.UsedCount + row.ReservedCount
		categoriesChanged := !slices.Equal(before.Input.CategoryIDs, in.CategoryIDs)
		if taken > 0 && (in.PriceCents != row.PriceCents || in.Audience != row.Audience || categoriesChanged) {
			return apperr.New(http.StatusConflict, apperr.CodePriceRuleLocked)
		}
		if in.Quota != nil && *in.Quota < taken {
			return validationError().WithField("quota", "field.quota_below_taken", map[string]any{"min": taken})
		}

		updatedRow, err := q.UpdatePriceRule(ctx, store.UpdatePriceRuleParams{
			Name:         name,
			Audience:     in.Audience,
			PriceCents:   in.PriceCents,
			Quota:        in.Quota,
			SaleStartsAt: in.SaleStartsAt,
			SaleEndsAt:   in.SaleEndsAt,
			SortOrder:    in.SortOrder,
			ID:           id,
		})
		if err != nil {
			return fmt.Errorf("update price rule %d: %w", id, err)
		}
		if categoriesChanged {
			if err := q.DeleteCategoryLinksByRule(ctx, id); err != nil {
				return fmt.Errorf("delete category links of price rule %d: %w", id, err)
			}
			if err := insertCategoryLinks(ctx, q, id, in.CategoryIDs); err != nil {
				return err
			}
		}
		after, err := priceRuleFromRow(updatedRow, in.CategoryIDs)
		if err != nil {
			return err
		}
		out = after
		return audit.Record(ctx, tx, staffEntry(ctx, actor, "price_rule.update", "price_rule", after.ID, &after.EventID,
			fmt.Sprintf("修改价格档 %d", after.ID), priceRuleSnapshot(before), priceRuleSnapshot(after)))
	})
	if err != nil {
		return PriceRule{}, err
	}
	return out, nil
}

func requireCategoriesOf(ctx context.Context, q *store.Queries, eventID int64, categoryIDs []int64) error {
	own, err := q.ListCategoryIDsOfEvent(ctx, eventID)
	if err != nil {
		return fmt.Errorf("list categories of event %d: %w", eventID, err)
	}
	for _, id := range categoryIDs {
		if !slices.Contains(own, id) {
			return validationError().WithField("categoryIds", "field.invalid", nil)
		}
	}
	return nil
}

func categoryIDsByRule(ctx context.Context, q *store.Queries, ruleIDs []int64) (map[int64][]int64, error) {
	out := make(map[int64][]int64, len(ruleIDs))
	if len(ruleIDs) == 0 {
		return out, nil
	}
	rows, err := q.ListCategoryLinksByRuleIDs(ctx, ruleIDs)
	if err != nil {
		return nil, fmt.Errorf("list category links: %w", err)
	}
	for _, r := range rows {
		out[r.PriceRuleID] = append(out[r.PriceRuleID], r.CategoryID)
	}
	return out, nil
}

func insertCategoryLinks(ctx context.Context, q *store.Queries, ruleID int64, categoryIDs []int64) error {
	for _, categoryID := range categoryIDs {
		if err := q.InsertCategoryLink(ctx, store.InsertCategoryLinkParams{CategoryID: categoryID, PriceRuleID: ruleID}); err != nil {
			return fmt.Errorf("link category %d to price rule %d: %w", categoryID, ruleID, err)
		}
	}
	return nil
}

func priceRuleFromRow(r store.PriceRule, categoryIDs []int64) (PriceRule, error) {
	var name i18n.Text
	if err := json.Unmarshal(r.Name, &name); err != nil {
		return PriceRule{}, fmt.Errorf("decode name of price rule %d: %w", r.ID, err)
	}
	if categoryIDs == nil {
		categoryIDs = []int64{}
	}
	return PriceRule{
		ID:      r.ID,
		EventID: r.EventID,
		Input: PriceRuleInput{
			Name:         name,
			Audience:     r.Audience,
			PriceCents:   r.PriceCents,
			Quota:        r.Quota,
			SaleStartsAt: r.SaleStartsAt,
			SaleEndsAt:   r.SaleEndsAt,
			SortOrder:    r.SortOrder,
			CategoryIDs:  categoryIDs,
		},
		UsedCount:     r.UsedCount,
		ReservedCount: r.ReservedCount,
	}, nil
}

func priceRuleSnapshot(r PriceRule) map[string]any {
	return map[string]any{
		"name":         r.Input.Name,
		"audience":     r.Input.Audience,
		"priceCents":   r.Input.PriceCents,
		"quota":        r.Input.Quota,
		"saleStartsAt": r.Input.SaleStartsAt,
		"saleEndsAt":   r.Input.SaleEndsAt,
		"sortOrder":    r.Input.SortOrder,
		"categoryIds":  r.Input.CategoryIDs,
	}
}
```

（`Service.now` 在 Task 11 算价时读取；本任务只在 `NewService` 的复合字面量里写入，`unused` 检查把复合字面量中的字段视为已使用，不会报错。）

Run（colima 环境变量同 Step 1）：`cd api && go test ./internal/pricing/ -v`
Expected: `TestValidatePriceRule`（8 个子测试）、`TestCreateAndListPriceRules`、`TestCreatePriceRuleRejectsUnknownEventAndForeignCategory`、`TestUpdatePriceRuleWithoutReservationsReplacesEverything`、`TestUpdatePriceRuleLockedOnceTaken`（3 个子测试）全部 PASS。

- [ ] **Step 5: OpenAPI 与生成代码**

`api/openapi/openapi.yaml` 的 `paths` 末尾（`components:` 之前）追加：

```yaml
  /admin/events/{id}/price-rules:
    get:
      operationId: adminListPriceRules
      summary: 赛事的价格档列表（含关联组别与计数）
      x-permission: price_config
      x-access: read
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: integer
            format: int64
      responses:
        '200':
          description: 价格档列表
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/PriceRuleList'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
    post:
      operationId: adminCreatePriceRule
      summary: 新建价格档
      x-permission: price_config
      x-access: write
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
              $ref: '#/components/schemas/PriceRuleInput'
      responses:
        '201':
          description: 已创建
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/PriceRule'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
  /admin/price-rules/{id}:
    put:
      operationId: adminUpdatePriceRule
      summary: 修改价格档（已有占用时不可改价格、人群、关联组别）
      x-permission: price_config
      x-access: write
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
              $ref: '#/components/schemas/PriceRuleInput'
      responses:
        '200':
          description: 已保存
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/PriceRule'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
```

`components.schemas` 末尾追加：

```yaml
    PriceAudience:
      type: string
      enum: [ALL, LOCAL]
    PriceRuleInput:
      type: object
      required: [name, audience, priceCents, categoryIds]
      properties:
        name:
          $ref: '#/components/schemas/LocalizedText'
        audience:
          $ref: '#/components/schemas/PriceAudience'
        priceCents:
          type: integer
          format: int64
        quota:
          type: integer
          format: int32
          nullable: true
        saleStartsAt:
          type: string
          format: date-time
          nullable: true
        saleEndsAt:
          type: string
          format: date-time
          nullable: true
        sortOrder:
          type: integer
          format: int32
        categoryIds:
          type: array
          items:
            type: integer
            format: int64
    PriceRule:
      type: object
      required: [id, eventId, name, audience, priceCents, currency, quota, saleStartsAt, saleEndsAt, sortOrder, categoryIds, usedCount, reservedCount]
      properties:
        id:
          type: integer
          format: int64
        eventId:
          type: integer
          format: int64
        name:
          $ref: '#/components/schemas/LocalizedText'
        audience:
          $ref: '#/components/schemas/PriceAudience'
        priceCents:
          type: integer
          format: int64
        currency:
          type: string
        quota:
          type: integer
          format: int32
          nullable: true
        saleStartsAt:
          type: string
          format: date-time
          nullable: true
        saleEndsAt:
          type: string
          format: date-time
          nullable: true
        sortOrder:
          type: integer
          format: int32
        categoryIds:
          type: array
          items:
            type: integer
            format: int64
        usedCount:
          type: integer
          format: int32
        reservedCount:
          type: integer
          format: int32
    PriceRuleList:
      type: object
      required: [items]
      properties:
        items:
          type: array
          items:
            $ref: '#/components/schemas/PriceRule'
```

Run: `make gen`
Expected: `api.gen.go` 出现 `PriceAudience string`、`PriceRuleInput{Audience PriceAudience; CategoryIds []int64; Name LocalizedText; PriceCents int64; Quota *int32; SaleEndsAt, SaleStartsAt *time.Time; SortOrder *int32}`、`PriceRule{...; SortOrder int32; ...}`、三个 `Admin*PriceRule*RequestObject`；`permissions.gen.go` 增加三条 `price_config` 规则。`go build ./...` 此时因 `*Server` 缺少方法失败。

- [ ] **Step 6: 写接口的失败测试**

`api/internal/httpapi/events_http_test.go`：import 加入 `"werun/api/internal/pricing"`；`newEventsEnv` 中 `Events:  event.NewService(pool),` 之后加一行 `Pricing: pricing.NewService(pool, time.Now),`。

创建 `api/internal/httpapi/pricing_http_test.go`：

```go
package httpapi_test

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
)

func priceRuleBody(categoryIDs ...int64) map[string]any {
	return map[string]any{
		"name":         map[string]string{"zh": "早鸟价", "en": "Early bird", "km": "តម្លៃទិញមុន"},
		"audience":     "ALL",
		"priceCents":   2500,
		"quota":        100,
		"saleStartsAt": "2026-09-20T00:00:00+07:00",
		"saleEndsAt":   nil,
		"sortOrder":    1,
		"categoryIds":  categoryIDs,
	}
}

func TestPriceRulesHTTP(t *testing.T) {
	env := newEventsEnv(t)
	ops := env.sessionCookie(t, iam.RoleOps, "ops.pricehttp")
	finance := env.sessionCookie(t, iam.RoleFinance, "finance.pricehttp")
	support := env.sessionCookie(t, iam.RoleSupport, "support.pricehttp")
	ev := env.createPublishedEvent(t, ops)
	listPath := fmt.Sprintf("/api/admin/events/%d/price-rules", ev.Id)
	categoryID := ev.Categories[0].Id

	rec := env.do(t, http.MethodPost, listPath, priceRuleBody(categoryID), finance, adminClientHeader)
	require.Equal(t, http.StatusForbidden, rec.Code, "FINANCE 对 price_config 只读")

	rec = env.do(t, http.MethodPost, listPath, priceRuleBody(categoryID), ops, adminClientHeader)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	created := eventsDecode[apigen.PriceRule](t, rec)
	require.Equal(t, int64(2500), created.PriceCents)
	require.Equal(t, "USD", created.Currency)
	require.Equal(t, []int64{categoryID}, created.CategoryIds)
	require.Equal(t, int32(100), *created.Quota)
	require.Nil(t, created.SaleEndsAt)

	rec = env.do(t, http.MethodGet, listPath, nil, finance, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	list := eventsDecode[apigen.PriceRuleList](t, rec)
	require.Len(t, list.Items, 1)
	require.Equal(t, "Early bird", *list.Items[0].Name.En)

	rec = env.do(t, http.MethodGet, listPath, nil, support, nil)
	require.Equal(t, http.StatusForbidden, rec.Code, "SUPPORT 没有 price_config")

	invalid := priceRuleBody()
	invalid["priceCents"] = -1
	rec = env.do(t, http.MethodPost, listPath, invalid, ops, adminClientHeader)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	fields := eventsDecode[httpx.ErrorBody](t, rec).Error.Fields
	require.Contains(t, fields, "priceCents")
	require.Contains(t, fields, "categoryIds")

	tooBigSort := priceRuleBody(categoryID)
	tooBigSort["sortOrder"] = 40000
	rec = env.do(t, http.MethodPost, listPath, tooBigSort, ops, adminClientHeader)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	require.Contains(t, eventsDecode[httpx.ErrorBody](t, rec).Error.Fields, "sortOrder")

	updatePath := fmt.Sprintf("/api/admin/price-rules/%d", created.Id)
	changed := priceRuleBody(categoryID)
	changed["priceCents"] = 2200
	rec = env.do(t, http.MethodPut, updatePath, changed, ops, adminClientHeader)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, int64(2200), eventsDecode[apigen.PriceRule](t, rec).PriceCents)

	_, err := env.pool.Exec(t.Context(), `UPDATE price_rules SET reserved_count = 1 WHERE id = $1`, created.Id)
	require.NoError(t, err)
	changed["priceCents"] = 2000
	rec = env.do(t, http.MethodPut, updatePath, changed, ops, adminClientHeader)
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	require.Equal(t, apperr.CodePriceRuleLocked, eventsDecode[httpx.ErrorBody](t, rec).Error.Code)

	rec = env.do(t, http.MethodPut, "/api/admin/price-rules/999999", priceRuleBody(categoryID), ops, adminClientHeader)
	require.Equal(t, http.StatusNotFound, rec.Code)
}
```

Run（colima 环境变量同 Step 1）：`cd api && go test ./internal/httpapi/ -run TestPriceRulesHTTP`
Expected: 编译失败，`unknown field Pricing in struct literal of type httpapi.RouterDeps`。

- [ ] **Step 7: 实现 handler 并接入路由与 App**

创建 `api/internal/pricing/handlers.go`：

```go
package pricing

import (
	"context"
	"math"
	"net/http"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/i18n"
)

// Handlers 实现 apigen.StrictServerInterface 中价格档与优惠码相关的操作。
type Handlers struct {
	svc *Service
}

// NewHandlers 创建 handler。
func NewHandlers(svc *Service) *Handlers {
	return &Handlers{svc: svc}
}

func (h *Handlers) AdminListPriceRules(ctx context.Context, req apigen.AdminListPriceRulesRequestObject) (apigen.AdminListPriceRulesResponseObject, error) {
	rules, err := h.svc.ListPriceRules(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	items := make([]apigen.PriceRule, 0, len(rules))
	for _, r := range rules {
		items = append(items, toAPIPriceRule(r))
	}
	return apigen.AdminListPriceRules200JSONResponse{Items: items}, nil
}

func (h *Handlers) AdminCreatePriceRule(ctx context.Context, req apigen.AdminCreatePriceRuleRequestObject) (apigen.AdminCreatePriceRuleResponseObject, error) {
	actor, ok := iam.StaffFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	in, err := priceRuleInputFromAPI(*req.Body)
	if err != nil {
		return nil, err
	}
	rule, err := h.svc.CreatePriceRule(ctx, actor, req.Id, in)
	if err != nil {
		return nil, err
	}
	return apigen.AdminCreatePriceRule201JSONResponse(toAPIPriceRule(rule)), nil
}

func (h *Handlers) AdminUpdatePriceRule(ctx context.Context, req apigen.AdminUpdatePriceRuleRequestObject) (apigen.AdminUpdatePriceRuleResponseObject, error) {
	actor, ok := iam.StaffFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	in, err := priceRuleInputFromAPI(*req.Body)
	if err != nil {
		return nil, err
	}
	rule, err := h.svc.UpdatePriceRule(ctx, actor, req.Id, in)
	if err != nil {
		return nil, err
	}
	return apigen.AdminUpdatePriceRule200JSONResponse(toAPIPriceRule(rule)), nil
}

func priceRuleInputFromAPI(b apigen.PriceRuleInput) (PriceRuleInput, error) {
	var sortOrder int16
	if b.SortOrder != nil {
		if *b.SortOrder < 0 || *b.SortOrder > math.MaxInt16 {
			return PriceRuleInput{}, validationError().WithField("sortOrder", "field.invalid", nil)
		}
		sortOrder = int16(*b.SortOrder)
	}
	return PriceRuleInput{
		Name:         textFromAPI(b.Name),
		Audience:     string(b.Audience),
		PriceCents:   b.PriceCents,
		Quota:        b.Quota,
		SaleStartsAt: b.SaleStartsAt,
		SaleEndsAt:   b.SaleEndsAt,
		SortOrder:    sortOrder,
		CategoryIDs:  b.CategoryIds,
	}, nil
}

func toAPIPriceRule(r PriceRule) apigen.PriceRule {
	return apigen.PriceRule{
		Id:            r.ID,
		EventId:       r.EventID,
		Name:          textToAPI(r.Input.Name),
		Audience:      apigen.PriceAudience(r.Input.Audience),
		PriceCents:    r.Input.PriceCents,
		Currency:      "USD",
		Quota:         r.Input.Quota,
		SaleStartsAt:  r.Input.SaleStartsAt,
		SaleEndsAt:    r.Input.SaleEndsAt,
		SortOrder:     int32(r.Input.SortOrder),
		CategoryIds:   r.Input.CategoryIDs,
		UsedCount:     r.UsedCount,
		ReservedCount: r.ReservedCount,
	}
}

func textToAPI(t i18n.Text) apigen.LocalizedText {
	pick := func(l i18n.Lang) *string {
		v, ok := t[l]
		if !ok {
			return nil
		}
		return &v
	}
	return apigen.LocalizedText{Zh: pick(i18n.ZH), En: pick(i18n.EN), Km: pick(i18n.KM)}
}

func textFromAPI(l apigen.LocalizedText) i18n.Text {
	t := i18n.Text{}
	if l.Zh != nil {
		t[i18n.ZH] = *l.Zh
	}
	if l.En != nil {
		t[i18n.EN] = *l.En
	}
	if l.Km != nil {
		t[i18n.KM] = *l.Km
	}
	return t
}
```

`api/internal/httpapi/server.go` 整文件替换为：

```go
package httpapi

import (
	"werun/api/internal/event"
	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/pricing"
)

// 各模块的 handler 类型都叫 Handlers，直接嵌入会出现同名字段；
// 用别名嵌入，字段名即别名（IAMHandlers、EventHandlers……）。
type (
	IAMHandlers     = iam.Handlers
	EventHandlers   = event.Handlers
	PricingHandlers = pricing.Handlers
)

// Server 组合各模块的 handler，实现 apigen.StrictServerInterface。
// 新增模块时在这里嵌入该模块的 handler，并在 NewServer 中构造。
type Server struct {
	*HealthHandlers
	*IAMHandlers
	*EventHandlers
	*PricingHandlers
}

var _ apigen.StrictServerInterface = (*Server)(nil)

// NewServer 用路由依赖构造全部模块 handler。
func NewServer(d RouterDeps) *Server {
	return &Server{
		HealthHandlers:  NewHealthHandlers(d.Pool),
		IAMHandlers:     iam.NewHandlers(d.IAM, d.Env == "prod"),
		EventHandlers:   event.NewHandlers(d.Events),
		PricingHandlers: pricing.NewHandlers(d.Pricing),
	}
}
```

`api/internal/httpapi/router.go`：import 加入 `"werun/api/internal/pricing"`；`RouterDeps` 中 `Events  *event.Service` 之后加一行 `Pricing *pricing.Service`。

`api/cmd/werun/app.go`：import 加入 `"werun/api/internal/pricing"`；`App` 中 `Events   *event.Service` 之后加 `Pricing  *pricing.Service`；`Bootstrap` 中 `app.Events = event.NewService(app.Pool)` 之后加 `app.Pricing = pricing.NewService(app.Pool, time.Now)`。

`api/cmd/werun/router.go` 的 `RouterDeps` 字面量中 `Events:  app.Events,` 之后加 `Pricing: app.Pricing,`。

Run（colima 环境变量同 Step 1）：`cd api && gofmt -l ./internal ./cmd && go test ./internal/httpapi/ ./internal/pricing/ ./cmd/werun/`
Expected: `gofmt -l` 无输出；测试 PASS，含 `TestPriceRulesHTTP`。

- [ ] **Step 8: 写后台价格档的失败测试**

`web/admin/src/test/fixtures.ts`：

```ts
  permissions: { event_config: "write", event_publish: "write", order_view: "read" },
```

改为（与后端矩阵一致）：

```ts
  permissions: { event_config: "write", event_publish: "write", order_view: "read", price_config: "write" },
```

```ts
  permissions: { event_config: "read", event_publish: "read", access_manage: "write" },
```

改为：

```ts
  permissions: { event_config: "read", event_publish: "read", access_manage: "write", price_config: "read" },
```

文件末尾（`jsonResponse` 之前）追加：

```ts
export const earlyBirdRule: Schemas["PriceRule"] = {
  id: 31,
  eventId: 7,
  name: { zh: "早鸟价", en: "Early bird", km: "តម្លៃទិញមុន" },
  audience: "ALL",
  priceCents: 2500,
  currency: "USD",
  quota: 100,
  saleStartsAt: "2026-09-20T01:00:00Z",
  saleEndsAt: null,
  sortOrder: 1,
  categoryIds: [11],
  usedCount: 0,
  reservedCount: 0,
};
```

创建 `web/admin/src/pricing/priceRuleForm.test.ts`：

```ts
import dayjs from "dayjs";
import { describe, expect, it } from "vitest";
import { earlyBirdRule } from "../test/fixtures";
import {
  emptyPriceRule,
  fromPriceRule,
  isPriceRuleLocked,
  priceRuleFieldPath,
  toPriceRuleInput,
  type PriceRuleFormValues,
} from "./priceRuleForm";

describe("toPriceRuleInput", () => {
  it("美元字符串转分、去掉名称首尾空格、空值转 null", () => {
    const values: PriceRuleFormValues = {
      ...emptyPriceRule([11, 12]),
      name: { zh: " 早鸟价 ", en: "Early bird", km: "តម្លៃទិញមុន" },
      priceUsd: "25.5",
      saleStartsAt: dayjs("2026-09-20T01:00:00Z"),
    };

    expect(toPriceRuleInput(values)).toEqual({
      name: { zh: "早鸟价", en: "Early bird", km: "តម្លៃទិញមុន" },
      audience: "ALL",
      priceCents: 2550,
      quota: null,
      saleStartsAt: "2026-09-20T01:00:00.000Z",
      saleEndsAt: null,
      sortOrder: 0,
      categoryIds: [11, 12],
    });
  });

  it("价格无法解析时抛错（表单校验保证不会走到这里）", () => {
    expect(() => toPriceRuleInput({ ...emptyPriceRule([11]), priceUsd: "25.505" })).toThrow("invalid price");
  });
});

describe("fromPriceRule", () => {
  it("回填编辑表单", () => {
    const values = fromPriceRule(earlyBirdRule);

    expect(values.priceUsd).toBe("25.00");
    expect(values.quota).toBe(100);
    expect(values.saleStartsAt?.toISOString()).toBe("2026-09-20T01:00:00.000Z");
    expect(values.saleEndsAt).toBeNull();
    expect(values.categoryIds).toEqual([11]);
    expect(toPriceRuleInput(values).priceCents).toBe(2500);
  });
});

describe("isPriceRuleLocked 与字段映射", () => {
  it("已用或预留大于 0 时锁定", () => {
    expect(isPriceRuleLocked(undefined)).toBe(false);
    expect(isPriceRuleLocked(earlyBirdRule)).toBe(false);
    expect(isPriceRuleLocked({ ...earlyBirdRule, reservedCount: 1 })).toBe(true);
    expect(isPriceRuleLocked({ ...earlyBirdRule, usedCount: 2 })).toBe(true);
  });

  it("服务端字段映射到表单字段", () => {
    expect(priceRuleFieldPath("priceCents")).toEqual(["priceUsd"]);
    expect(priceRuleFieldPath("name.km")).toEqual(["name", "km"]);
    expect(priceRuleFieldPath("quota")).toEqual(["quota"]);
  });
});
```

创建 `web/admin/src/pricing/PricingTab.test.tsx`：

```tsx
import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { adminMe, earlyBirdRule, jsonResponse, opsMe, publishedEvent } from "../test/fixtures";
import { fillField, replaceField, setupFormUser } from "../test/form";
import { renderAdminApp } from "../test/renderAdminApp";

beforeEach(() => {
  window.localStorage.setItem("werun.lang", "en");
});

function findRequest(requests: Request[], method: string, pathname: string): Request | undefined {
  return requests.find((request) => request.method === method && new URL(request.url).pathname === pathname);
}

describe("价格档标签页", () => {
  it("OPS 新建价格档：请求体为分，默认关联全部组别，成功后列表出现新行", async () => {
    let created = false;
    const { requests } = renderAdminApp("/events/7", {
      "GET /api/admin/me": () => jsonResponse(200, opsMe),
      "GET /api/admin/events/7": () => jsonResponse(200, publishedEvent),
      "GET /api/admin/events/7/price-rules": () => jsonResponse(200, { items: created ? [earlyBirdRule] : [] }),
      "POST /api/admin/events/7/price-rules": () => {
        created = true;
        return jsonResponse(201, earlyBirdRule);
      },
    });
    const user = setupFormUser();

    await user.click(await screen.findByTestId("event-tab-pricing"));
    await user.click(await screen.findByTestId("price-rule-create"));
    await fillField(user, "priceRule_name_zh", "早鸟价");
    await fillField(user, "priceRule_name_en", "Early bird");
    await fillField(user, "priceRule_name_km", "តម្លៃទិញមុន");
    await fillField(user, "priceRule_priceUsd", "25");
    await fillField(user, "priceRule_quota", "100");
    await replaceField(user, "priceRule_sortOrder", "1");
    await user.click(screen.getByTestId("price-rule-submit"));

    const row = await screen.findByTestId("price-rule-row-31");
    expect(within(row).getByText("$25.00")).toBeInTheDocument();
    expect(within(row).getByText("21K")).toBeInTheDocument();
    const post = findRequest(requests, "POST", "/api/admin/events/7/price-rules");
    expect(post?.headers.get("X-WeRun-Client")).toBe("admin");
    expect(await post?.clone().json()).toEqual({
      name: { zh: "早鸟价", en: "Early bird", km: "តម្លៃទិញមុន" },
      audience: "ALL",
      priceCents: 2500,
      quota: 100,
      saleStartsAt: null,
      saleEndsAt: null,
      sortOrder: 1,
      categoryIds: [11],
    });
  });

  it("价格格式不对时不提交", async () => {
    const { requests } = renderAdminApp("/events/7", {
      "GET /api/admin/me": () => jsonResponse(200, opsMe),
      "GET /api/admin/events/7": () => jsonResponse(200, publishedEvent),
      "GET /api/admin/events/7/price-rules": () => jsonResponse(200, { items: [] }),
    });
    const user = setupFormUser();

    await user.click(await screen.findByTestId("event-tab-pricing"));
    await user.click(await screen.findByTestId("price-rule-create"));
    await fillField(user, "priceRule_name_zh", "早鸟价");
    await fillField(user, "priceRule_name_en", "Early bird");
    await fillField(user, "priceRule_name_km", "តម្លៃទិញមុន");
    await fillField(user, "priceRule_priceUsd", "25.505");
    await user.click(screen.getByTestId("price-rule-submit"));

    expect(await screen.findByText("Enter an amount such as 25 or 25.50")).toBeInTheDocument();
    expect(findRequest(requests, "POST", "/api/admin/events/7/price-rules")).toBeUndefined();
  });

  it("已有占用的价格档：价格、人群、组别不可编辑，仍可改名称", async () => {
    const taken = { ...earlyBirdRule, reservedCount: 3 };
    const { requests } = renderAdminApp("/events/7", {
      "GET /api/admin/me": () => jsonResponse(200, opsMe),
      "GET /api/admin/events/7": () => jsonResponse(200, publishedEvent),
      "GET /api/admin/events/7/price-rules": () => jsonResponse(200, { items: [taken] }),
      "PUT /api/admin/price-rules/31": () =>
        jsonResponse(200, { ...taken, name: { ...taken.name, en: "Early bird (extended)" } }),
    });
    const user = setupFormUser();

    await user.click(await screen.findByTestId("event-tab-pricing"));
    await user.click(await screen.findByTestId("price-rule-edit-31"));

    expect(await screen.findByText("This tier already has registrations. Price, audience and categories are locked.")).toBeInTheDocument();
    expect(document.querySelector("#priceRule_priceUsd")).toBeDisabled();
    expect(document.querySelector("#priceRule_audience")?.closest(".ant-select")).toHaveClass("ant-select-disabled");
    expect(document.querySelector("#priceRule_categoryIds")?.closest(".ant-select")).toHaveClass("ant-select-disabled");

    await replaceField(user, "priceRule_name_en", "Early bird (extended)");
    await user.click(screen.getByTestId("price-rule-submit"));

    expect(await screen.findByText("Price tier saved")).toBeInTheDocument();
    const put = findRequest(requests, "PUT", "/api/admin/price-rules/31");
    expect(await put?.clone().json()).toMatchObject({
      name: { zh: "早鸟价", en: "Early bird (extended)", km: "តម្លៃទិញមុន" },
      audience: "ALL",
      priceCents: 2500,
      categoryIds: [11],
    });
  });

  it("ADMIN 只读：能看价格档，没有新建与编辑按钮", async () => {
    renderAdminApp("/events/7", {
      "GET /api/admin/me": () => jsonResponse(200, adminMe),
      "GET /api/admin/events/7": () => jsonResponse(200, publishedEvent),
      "GET /api/admin/events/7/price-rules": () => jsonResponse(200, { items: [earlyBirdRule] }),
    });
    const user = setupFormUser();

    await user.click(await screen.findByTestId("event-tab-pricing"));

    expect(await screen.findByTestId("price-rule-row-31")).toBeInTheDocument();
    expect(screen.queryByTestId("price-rule-create")).not.toBeInTheDocument();
    expect(screen.queryByTestId("price-rule-edit-31")).not.toBeInTheDocument();
  });
});
```

Run: `pnpm --filter @werun/admin test src/pricing`
Expected: FAIL，`Failed to resolve import "./priceRuleForm"`；`PricingTab.test.tsx` 找不到 `event-tab-pricing`。

- [ ] **Step 9: 实现前端价格档**

创建 `web/admin/src/pricing/queries.ts`：

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@werun/api-client";
import { useApi } from "../api";

export function priceRulesKey(eventId: number) {
  return ["admin", "price-rules", eventId] as const;
}

export function usePriceRules(eventId: number) {
  const api = useApi();
  return useQuery({
    queryKey: priceRulesKey(eventId),
    queryFn: async () =>
      unwrap(await api.GET("/admin/events/{id}/price-rules", { params: { path: { id: eventId } } })).items,
  });
}

/** id 为 undefined 时新建，否则修改 */
export function useSavePriceRule(eventId: number) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id?: number; body: Schemas["PriceRuleInput"] }) =>
      id === undefined
        ? unwrap(await api.POST("/admin/events/{id}/price-rules", { params: { path: { id: eventId } }, body }))
        : unwrap(await api.PUT("/admin/price-rules/{id}", { params: { path: { id } }, body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: priceRulesKey(eventId) }),
  });
}
```

创建 `web/admin/src/pricing/priceRuleForm.ts`：

```ts
import { formatUsd, parseUsdToCents, type Schemas } from "@werun/api-client";
import dayjs, { type Dayjs } from "dayjs";
import { toNamePath, type LocalizedValues } from "../events/eventForm";

export interface PriceRuleFormValues {
  name: LocalizedValues;
  audience: Schemas["PriceAudience"];
  priceUsd: string;
  quota?: number | null;
  saleStartsAt?: Dayjs | null;
  saleEndsAt?: Dayjs | null;
  sortOrder?: number | null;
  categoryIds: number[];
}

/** 新建价格档的初始值：默认关联赛事全部组别 */
export function emptyPriceRule(categoryIds: number[]): PriceRuleFormValues {
  return {
    name: { zh: "", en: "", km: "" },
    audience: "ALL",
    priceUsd: "",
    quota: null,
    saleStartsAt: null,
    saleEndsAt: null,
    sortOrder: 0,
    categoryIds,
  };
}

export function fromPriceRule(rule: Schemas["PriceRule"]): PriceRuleFormValues {
  return {
    name: { zh: rule.name.zh ?? "", en: rule.name.en ?? "", km: rule.name.km ?? "" },
    audience: rule.audience,
    priceUsd: formatUsd(rule.priceCents).slice(1),
    quota: rule.quota,
    saleStartsAt: rule.saleStartsAt ? dayjs(rule.saleStartsAt) : null,
    saleEndsAt: rule.saleEndsAt ? dayjs(rule.saleEndsAt) : null,
    sortOrder: rule.sortOrder,
    categoryIds: [...rule.categoryIds],
  };
}

export function toPriceRuleInput(values: PriceRuleFormValues): Schemas["PriceRuleInput"] {
  const priceCents = parseUsdToCents(values.priceUsd);
  if (priceCents === null) {
    throw new Error(`invalid price: ${values.priceUsd}`);
  }
  return {
    name: { zh: values.name.zh.trim(), en: values.name.en.trim(), km: values.name.km.trim() },
    audience: values.audience,
    priceCents,
    quota: values.quota ?? null,
    saleStartsAt: values.saleStartsAt ? values.saleStartsAt.toISOString() : null,
    saleEndsAt: values.saleEndsAt ? values.saleEndsAt.toISOString() : null,
    sortOrder: values.sortOrder ?? 0,
    categoryIds: values.categoryIds,
  };
}

/** 已有报名占用（used + reserved > 0）时，价格、人群、关联组别不可编辑（spec §7） */
export function isPriceRuleLocked(rule: Schemas["PriceRule"] | undefined): boolean {
  return rule !== undefined && rule.usedCount + rule.reservedCount > 0;
}

/** 服务端字段路径 → 表单 NamePath；priceCents 对应表单里的 priceUsd */
export function priceRuleFieldPath(field: string): (string | number)[] {
  return field === "priceCents" ? ["priceUsd"] : toNamePath(field);
}
```

创建 `web/admin/src/pricing/PricingTab.tsx`：

```tsx
import { PlusOutlined } from "@ant-design/icons";
import { ApiError, formatUsd, parseUsdToCents, type Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import {
  Alert,
  App as AntdApp,
  Button,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  type TableProps,
} from "antd";
import dayjs from "dayjs";
import { useState, type HTMLAttributes } from "react";
import { useTranslation } from "react-i18next";
import { PERM_PRICE_CONFIG, can } from "../auth/can";
import { useMe } from "../auth/useMe";
import { pickText } from "../events/localize";
import {
  emptyPriceRule,
  fromPriceRule,
  isPriceRuleLocked,
  priceRuleFieldPath,
  toPriceRuleInput,
  type PriceRuleFormValues,
} from "./priceRuleForm";
import { usePriceRules, useSavePriceRule } from "./queries";

type AdminEvent = Schemas["AdminEvent"];
type PriceRule = Schemas["PriceRule"];

const NAME_LANGS = ["zh", "en", "km"] as const;
const NAME_LABEL_KEYS = { zh: "form.nameZh", en: "form.nameEn", km: "form.nameKm" } as const;

function formatTime(value: string | null): string {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "—";
}

export function PricingTab({ event }: { event: AdminEvent }) {
  const { t } = useTranslation("admin");
  const lang = useLang();
  const { data: me } = useMe();
  const rules = usePriceRules(event.id);
  const canWrite = can(me?.permissions, PERM_PRICE_CONFIG, "write");
  const [editing, setEditing] = useState<{ rule?: PriceRule } | null>(null);
  const codeById = new Map(event.categories.map((category) => [category.id, category.code]));

  const columns: TableProps<PriceRule>["columns"] = [
    { title: t("pricing.col.name"), key: "name", render: (_, rule) => pickText(rule.name, lang) },
    {
      title: t("pricing.col.audience"),
      key: "audience",
      render: (_, rule) => <Tag color={rule.audience === "LOCAL" ? "gold" : "blue"}>{t(`pricing.audience.${rule.audience}`)}</Tag>,
    },
    { title: t("pricing.col.price"), key: "price", render: (_, rule) => formatUsd(rule.priceCents) },
    {
      title: t("pricing.col.quota"),
      key: "quota",
      render: (_, rule) => `${rule.usedCount + rule.reservedCount} / ${rule.quota ?? t("pricing.unlimited")}`,
    },
    {
      title: t("pricing.col.sale"),
      key: "sale",
      render: (_, rule) => `${formatTime(rule.saleStartsAt)} ~ ${formatTime(rule.saleEndsAt)}`,
    },
    {
      title: t("pricing.col.categories"),
      key: "categories",
      render: (_, rule) => (
        <Space size={4} wrap>
          {rule.categoryIds.map((id) => (
            <Tag key={id}>{codeById.get(id) ?? id}</Tag>
          ))}
        </Space>
      ),
    },
    { title: t("pricing.col.sortOrder"), dataIndex: "sortOrder", key: "sortOrder" },
    {
      title: t("pricing.col.actions"),
      key: "actions",
      render: (_, rule) =>
        canWrite ? (
          <Button size="small" data-testid={`price-rule-edit-${rule.id}`} onClick={() => setEditing({ rule })}>
            {t("pricing.edit")}
          </Button>
        ) : null,
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space style={{ width: "100%", justifyContent: "space-between" }} wrap>
        <Typography.Text type="secondary">{t("pricing.hint")}</Typography.Text>
        {canWrite ? (
          <Button type="primary" icon={<PlusOutlined />} data-testid="price-rule-create" onClick={() => setEditing({})}>
            {t("pricing.create")}
          </Button>
        ) : null}
      </Space>
      {rules.isError ? <Alert type="error" showIcon message={rules.error.message} /> : null}
      <Table<PriceRule>
        rowKey="id"
        columns={columns}
        dataSource={rules.data ?? []}
        loading={rules.isPending}
        pagination={false}
        locale={{ emptyText: t("pricing.empty") }}
        scroll={{ x: 960 }}
        onRow={(rule) => ({ "data-testid": `price-rule-row-${rule.id}` }) as HTMLAttributes<HTMLElement>}
      />
      {editing ? <PriceRuleModal event={event} rule={editing.rule} onClose={() => setEditing(null)} /> : null}
    </Space>
  );
}

interface PriceRuleModalProps {
  event: AdminEvent;
  rule?: PriceRule;
  onClose: () => void;
}

function PriceRuleModal({ event, rule, onClose }: PriceRuleModalProps) {
  const { t } = useTranslation("admin");
  const lang = useLang();
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<PriceRuleFormValues>();
  const save = useSavePriceRule(event.id);
  const locked = isPriceRuleLocked(rule);
  const required = [{ required: true, message: t("form.required") }];
  const bannerError = save.error instanceof ApiError && save.error.code === "VALIDATION_FAILED" ? null : save.error;

  const onFinish = (values: PriceRuleFormValues) => {
    save.mutate(
      { id: rule?.id, body: toPriceRuleInput(values) },
      {
        onSuccess: () => {
          void message.success(t(rule ? "pricing.updated" : "pricing.created"));
          onClose();
        },
        onError: (error) => {
          if (error instanceof ApiError && error.code === "VALIDATION_FAILED") {
            form.setFields(
              Object.entries(error.fields).map(([field, text]) => ({
                name: priceRuleFieldPath(field),
                errors: [text],
              })) as Parameters<typeof form.setFields>[0],
            );
          }
        },
      },
    );
  };

  return (
    <Modal open title={t(rule ? "pricing.editTitle" : "pricing.createTitle")} onCancel={onClose} footer={null} width={760} maskClosable={false}>
      {bannerError ? <Alert type="error" showIcon message={bannerError.message} style={{ marginBottom: 16 }} /> : null}
      {locked ? <Alert type="info" showIcon message={t("pricing.lockedHint")} style={{ marginBottom: 16 }} /> : null}
      <Form<PriceRuleFormValues>
        form={form}
        name="priceRule"
        layout="vertical"
        onFinish={onFinish}
        disabled={save.isPending}
        initialValues={rule ? fromPriceRule(rule) : emptyPriceRule(event.categories.map((category) => category.id))}
      >
        <Typography.Text strong>{t("pricing.form.name")}</Typography.Text>
        <Row gutter={16}>
          {NAME_LANGS.map((l) => (
            <Col key={l} xs={24} md={8}>
              <Form.Item name={["name", l]} label={t(NAME_LABEL_KEYS[l])} rules={required}>
                <Input lang={l} />
              </Form.Item>
            </Col>
          ))}
        </Row>
        <Row gutter={16}>
          <Col xs={24} md={8}>
            <Form.Item name="audience" label={t("pricing.form.audience")} rules={required}>
              <Select
                disabled={locked}
                options={[
                  { value: "ALL", label: t("pricing.audience.ALL") },
                  { value: "LOCAL", label: t("pricing.audience.LOCAL") },
                ]}
              />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item
              name="priceUsd"
              label={t("pricing.form.priceUsd")}
              rules={[
                ...required,
                {
                  validator: (_: unknown, value: string | undefined) =>
                    !value || parseUsdToCents(value) !== null
                      ? Promise.resolve()
                      : Promise.reject(new Error(t("pricing.form.priceInvalid"))),
                },
              ]}
            >
              <Input addonBefore="$" inputMode="decimal" disabled={locked} />
            </Form.Item>
          </Col>
          <Col xs={12} md={4}>
            <Form.Item name="quota" label={t("pricing.form.quota")} extra={t("pricing.form.quotaHelp")}>
              <InputNumber min={0} precision={0} style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col xs={12} md={4}>
            <Form.Item name="sortOrder" label={t("pricing.form.sortOrder")}>
              <InputNumber min={0} max={32767} precision={0} style={{ width: "100%" }} />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="saleStartsAt" label={t("pricing.form.saleStartsAt")}>
              <DatePicker showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="saleEndsAt" label={t("pricing.form.saleEndsAt")}>
              <DatePicker showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" style={{ width: "100%" }} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="categoryIds" label={t("pricing.form.categoryIds")} rules={required}>
          <Select
            mode="multiple"
            disabled={locked}
            options={event.categories.map((category) => ({
              value: category.id,
              label: `${category.code} · ${pickText(category.name, lang)}`,
            }))}
          />
        </Form.Item>
        <Space>
          <Button onClick={onClose}>{t("pricing.cancel")}</Button>
          <Button type="primary" htmlType="submit" loading={save.isPending} data-testid="price-rule-submit">
            {t("pricing.submit")}
          </Button>
        </Space>
      </Form>
    </Modal>
  );
}
```

`web/admin/src/pages/EventDetailPage.tsx`：

```tsx
import { PERM_EVENT_CONFIG, can } from "../auth/can";
```

改为：

```tsx
import { PERM_EVENT_CONFIG, PERM_PRICE_CONFIG, can } from "../auth/can";
```

在 `import { useAdminEvent } from "../events/queries";` 之后加 `import { PricingTab } from "../pricing/PricingTab";`。把：

```tsx
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Button type="link"
```

改为：

```tsx
  ];
  if (can(me?.permissions, PERM_PRICE_CONFIG, "read")) {
    items.push({
      key: "pricing",
      label: <span data-testid="event-tab-pricing">{t("eventDetail.tabPricing")}</span>,
      children: <PricingTab event={event} />,
    });
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Button type="link"
```

`packages/i18n/locales/zh/admin.json`：`eventDetail` 中 `"tabBasic": "基本信息",` 之后加 `"tabPricing": "价格档",`；顶层在 `eventDetail` 之后追加：

```json
  "pricing": {
    "hint": "同一组别有多个可用价格档时，跑者自动获得最低价。",
    "create": "新建价格档",
    "createTitle": "新建价格档",
    "editTitle": "编辑价格档",
    "edit": "编辑",
    "empty": "还没有价格档",
    "created": "价格档已创建",
    "updated": "价格档已保存",
    "submit": "保存",
    "cancel": "取消",
    "lockedHint": "这个价格档已有报名占用，价格、适用人群和关联组别不能再修改。",
    "unlimited": "不限",
    "col": {
      "name": "名称",
      "audience": "适用人群",
      "price": "价格",
      "quota": "已占用 / 配额",
      "sale": "销售时间",
      "categories": "关联组别",
      "sortOrder": "排序",
      "actions": "操作"
    },
    "audience": { "ALL": "所有人", "LOCAL": "柬埔寨国籍" },
    "form": {
      "name": "名称",
      "audience": "适用人群",
      "priceUsd": "价格（美元）",
      "priceInvalid": "请输入金额，例如 25 或 25.50",
      "quota": "配额",
      "quotaHelp": "留空表示不限",
      "sortOrder": "排序",
      "saleStartsAt": "开始销售",
      "saleEndsAt": "停止销售",
      "categoryIds": "关联组别"
    }
  }
```

`packages/i18n/locales/en/admin.json`：`"tabPricing": "Price tiers",`；顶层追加：

```json
  "pricing": {
    "hint": "When several tiers apply to a category, runners automatically get the lowest price.",
    "create": "New price tier",
    "createTitle": "New price tier",
    "editTitle": "Edit price tier",
    "edit": "Edit",
    "empty": "No price tiers yet",
    "created": "Price tier created",
    "updated": "Price tier saved",
    "submit": "Save",
    "cancel": "Cancel",
    "lockedHint": "This tier already has registrations. Price, audience and categories are locked.",
    "unlimited": "Unlimited",
    "col": {
      "name": "Name",
      "audience": "Audience",
      "price": "Price",
      "quota": "Taken / quota",
      "sale": "Sale window",
      "categories": "Categories",
      "sortOrder": "Order",
      "actions": "Actions"
    },
    "audience": { "ALL": "Everyone", "LOCAL": "Cambodian nationals" },
    "form": {
      "name": "Name",
      "audience": "Audience",
      "priceUsd": "Price (USD)",
      "priceInvalid": "Enter an amount such as 25 or 25.50",
      "quota": "Quota",
      "quotaHelp": "Leave empty for no limit",
      "sortOrder": "Order",
      "saleStartsAt": "Sale starts",
      "saleEndsAt": "Sale ends",
      "categoryIds": "Categories"
    }
  }
```

`packages/i18n/locales/km/admin.json`：`"tabPricing": "កម្រិតតម្លៃ",`；顶层追加：

```json
  "pricing": {
    "hint": "ពេលប្រភេទមួយមានកម្រិតតម្លៃច្រើនដែលអាចប្រើបាន អ្នករត់នឹងទទួលបានតម្លៃទាបបំផុតដោយស្វ័យប្រវត្តិ។",
    "create": "បង្កើតកម្រិតតម្លៃ",
    "createTitle": "បង្កើតកម្រិតតម្លៃ",
    "editTitle": "កែកម្រិតតម្លៃ",
    "edit": "កែ",
    "empty": "មិនទាន់មានកម្រិតតម្លៃទេ",
    "created": "បានបង្កើតកម្រិតតម្លៃ",
    "updated": "បានរក្សាទុកកម្រិតតម្លៃ",
    "submit": "រក្សាទុក",
    "cancel": "បោះបង់",
    "lockedHint": "កម្រិតតម្លៃនេះមានការចុះឈ្មោះរួចហើយ។ មិនអាចកែតម្លៃ ក្រុមអ្នកមានសិទ្ធិ និងប្រភេទបានទេ។",
    "unlimited": "គ្មានកំណត់",
    "col": {
      "name": "ឈ្មោះ",
      "audience": "អ្នកមានសិទ្ធិ",
      "price": "តម្លៃ",
      "quota": "បានប្រើ / កូតា",
      "sale": "រយៈពេលលក់",
      "categories": "ប្រភេទ",
      "sortOrder": "លំដាប់",
      "actions": "សកម្មភាព"
    },
    "audience": { "ALL": "គ្រប់គ្នា", "LOCAL": "ពលរដ្ឋកម្ពុជា" },
    "form": {
      "name": "ឈ្មោះ",
      "audience": "អ្នកមានសិទ្ធិ",
      "priceUsd": "តម្លៃ (ដុល្លារ)",
      "priceInvalid": "សូមបញ្ចូលចំនួនទឹកប្រាក់ ឧទាហរណ៍ 25 ឬ 25.50",
      "quota": "កូតា",
      "quotaHelp": "ទុកទទេ ប្រសិនបើគ្មានកំណត់",
      "sortOrder": "លំដាប់",
      "saleStartsAt": "ចាប់ផ្ដើមលក់",
      "saleEndsAt": "បញ្ឈប់ការលក់",
      "categoryIds": "ប្រភេទ"
    }
  }
```

Run: `pnpm --filter @werun/admin test`
Expected: PASS；`priceRuleForm.test.ts` 5 个、`PricingTab.test.tsx` 4 个用例通过，已有测试不回归。

- [ ] **Step 10: 全量检查**

Run（colima 环境变量同 Step 1）：

```bash
make gen && git status --porcelain
cd api && go test ./... && go tool golangci-lint run ./...
pnpm typecheck && pnpm lint && pnpm test && pnpm i18n:check
```

Expected：生成代码与已修改文件一致，无额外变化；后端测试与 lint 通过；前端全部通过，`i18n 检查通过`。

- [ ] **Step 11: 提交**

```bash
git add api/internal/pricing api/db/queries/pricing.sql api/sqlc.yaml \
  api/openapi/openapi.yaml api/internal/httpapi/apigen packages/api-client/src/schema.d.ts \
  api/internal/httpapi/server.go api/internal/httpapi/router.go \
  api/internal/httpapi/events_http_test.go api/internal/httpapi/pricing_http_test.go \
  api/cmd/werun/app.go api/cmd/werun/router.go \
  api/internal/platform/apperr api/internal/platform/i18n \
  web/admin/src/pricing web/admin/src/pages/EventDetailPage.tsx web/admin/src/test/fixtures.ts \
  packages/i18n/locales/zh/admin.json packages/i18n/locales/en/admin.json packages/i18n/locales/km/admin.json
git commit -m "$(cat <<'EOF'
feat: add price tier management with reservation lock rules

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
)"
```

---
### Task 5: 优惠码

**Files:**
- Modify: `api/internal/pricing/model.go`、`api/internal/pricing/handlers.go`
- Create: `api/internal/pricing/coupons.go`；Test: `api/internal/pricing/coupons_test.go`、`api/internal/httpapi/coupons_http_test.go`
- Modify: `api/db/queries/pricing.sql`；Generate: `api/internal/pricing/store/`
- Modify: `api/openapi/openapi.yaml`；Generate: `api/internal/httpapi/apigen/*`、`packages/api-client/src/schema.d.ts`
- Modify: `api/internal/platform/apperr/apperr.go`、`apperr_test.go`、`api/internal/platform/i18n/messages.{zh,en,km}.json`、`catalog_test.go`
- Create: `web/admin/src/coupons/queries.ts`、`web/admin/src/coupons/couponForm.ts`、`web/admin/src/coupons/couponForm.test.ts`、`web/admin/src/coupons/CouponsTab.tsx`、`web/admin/src/coupons/CouponsTab.test.tsx`
- Modify: `web/admin/src/pages/EventDetailPage.tsx`、`web/admin/src/test/fixtures.ts`、`packages/i18n/locales/{zh,en,km}/admin.json`

**Interfaces:**
- Consumes：Task 4 的 `pricing.Service`、`requireEvent`、`validationError`、`staffEntry`、`requiredLangs`、`textToAPI / textFromAPI`；前端 `formatUsd`、`parseUsdToCents`、`toNamePath`、`setupFormUser / fillField / replaceField`、`useAdminEvent`
- Produces（抄自契约 §3）：

```go
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

  - 本任务另外导出：`pricing.DiscountPercent / DiscountAmount / DiscountWaiver`、`pricing.CouponActive / CouponDisabled`、`pricing.NormalizeCouponCode(s string) string`、`pricing.ValidateCoupon(in CouponInput) error`
  - `apperr.CodeCouponCodeTaken = "COUPON_CODE_TAKEN"`（409，`apperr.RegisterConstraint("coupons_code_key")`，附字段错误 `code`）；字段文案 `field.coupon_code_format`、`field.percent_range`
  - OpenAPI：`adminListCoupons`（`?eventId=`）、`adminCreateCoupon`、`adminUpdateCoupon`；schema `DiscountType`、`CouponStatus`、`Coupon`、`CreateCouponRequest`、`UpdateCouponRequest`、`CouponList`
  - 审计 `coupon.create` / `coupon.update`（entity `coupon`，`IsFinancial=false`，`EventID` 为优惠码绑定的赛事，可为 nil）
  - 前端：`event-tab-coupons`、`coupon-create`、表单 `name="coupon"`（字段 `code`、`discountType`、`discountValue`、`quota`、`minRunners`、`validFrom`、`validUntil`、`status`）、`coupon-submit`、行 `coupon-row-<CODE>`；另加编辑按钮 `coupon-edit-<CODE>`

**规则：** 优惠码去首尾空白转大写后须匹配 `^[A-Z0-9_-]{3,32}$`；`PERCENT` 值 1–100，`AMOUNT` 值 > 0（分），`WAIVER` 值必须为 0；`quota ≥ 1`；`minRunners` 为空或 1–10；`validUntil` 晚于 `validFrom`；`eventId` 非空时赛事必须存在（否则 `VALIDATION_FAILED`，字段 `eventId`）；修改时 `quota` 不得小于 `used_count + reserved_count`（`field.quota_below_taken`），`Code` 忽略（不可改）。停用用 `status = DISABLED`，不提供删除。

- [ ] **Step 1: 写失败测试（校验 + 数据库）**

创建 `api/internal/pricing/coupons_test.go`（复用同包 `rules_test.go` 中的 `newPricingFixture`、`fieldKeys`、`ptrTime`）：

```go
package pricing_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/pricing"
)

func ptrInt16(v int16) *int16 { return &v }

func validCoupon(eventID *int64) pricing.CouponInput {
	return pricing.CouponInput{
		Code:          "EARLY_2026",
		EventID:       eventID,
		DiscountType:  pricing.DiscountPercent,
		DiscountValue: 20,
		Quota:         50,
		MinRunners:    ptrInt16(2),
		ValidFrom:     ptrTime("2026-09-20T00:00:00+07:00"),
		ValidUntil:    ptrTime("2026-10-31T23:59:00+07:00"),
		Description:   i18n.Text{i18n.ZH: "早鸟两人同行", i18n.EN: "Early pair", i18n.KM: "គូទិញមុន"},
		Status:        pricing.CouponActive,
	}
}

func TestNormalizeCouponCode(t *testing.T) {
	assert.Equal(t, "EARLY_2026", pricing.NormalizeCouponCode("  early_2026\t"))
	assert.Equal(t, "RUN-KH", pricing.NormalizeCouponCode("run-kh"))
}

func TestValidateCoupon(t *testing.T) {
	require.NoError(t, pricing.ValidateCoupon(validCoupon(nil)))
	amount := validCoupon(nil)
	amount.DiscountType = pricing.DiscountAmount
	amount.DiscountValue = 500
	require.NoError(t, pricing.ValidateCoupon(amount))
	waiver := validCoupon(nil)
	waiver.DiscountType = pricing.DiscountWaiver
	waiver.DiscountValue = 0
	waiver.MinRunners = nil
	waiver.Description = nil
	require.NoError(t, pricing.ValidateCoupon(waiver))

	cases := []struct {
		name   string
		mutate func(in *pricing.CouponInput)
		field  string
		key    string
	}{
		{"太短", func(in *pricing.CouponInput) { in.Code = "AB" }, "code", "field.coupon_code_format"},
		{"含空格", func(in *pricing.CouponInput) { in.Code = "EARLY 2026" }, "code", "field.coupon_code_format"},
		{"太长", func(in *pricing.CouponInput) { in.Code = strings.Repeat("A", 33) }, "code", "field.coupon_code_format"},
		{"类型不在枚举内", func(in *pricing.CouponInput) { in.DiscountType = "BOGO" }, "discountType", "field.invalid"},
		{"百分比为 0", func(in *pricing.CouponInput) { in.DiscountValue = 0 }, "discountValue", "field.percent_range"},
		{"百分比超过 100", func(in *pricing.CouponInput) { in.DiscountValue = 101 }, "discountValue", "field.percent_range"},
		{"固定金额为 0", func(in *pricing.CouponInput) {
			in.DiscountType = pricing.DiscountAmount
			in.DiscountValue = 0
		}, "discountValue", "field.must_be_positive"},
		{"免单带金额", func(in *pricing.CouponInput) {
			in.DiscountType = pricing.DiscountWaiver
			in.DiscountValue = 5
		}, "discountValue", "field.invalid"},
		{"次数为 0", func(in *pricing.CouponInput) { in.Quota = 0 }, "quota", "field.must_be_positive"},
		{"最少人数 11", func(in *pricing.CouponInput) { in.MinRunners = ptrInt16(11) }, "minRunners", "field.invalid"},
		{"有效期倒置", func(in *pricing.CouponInput) { in.ValidUntil = ptrTime("2026-09-01T00:00:00+07:00") }, "validUntil", "field.ends_before_starts"},
		{"状态不在枚举内", func(in *pricing.CouponInput) { in.Status = "PAUSED" }, "status", "field.invalid"},
		{"说明过长", func(in *pricing.CouponInput) { in.Description[i18n.EN] = strings.Repeat("a", 201) }, "description.en", "field.too_long"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := validCoupon(nil)
			tc.mutate(&in)

			err := pricing.ValidateCoupon(in)

			require.Equal(t, tc.key, fieldKeys(t, err)[tc.field], "fields=%v", fieldKeys(t, err))
		})
	}
}

func TestCreateAndListCoupons(t *testing.T) {
	f := newPricingFixture(t)
	ctx := context.Background()

	eventCoupon := validCoupon(&f.event.ID)
	eventCoupon.Code = "  early_2026 "
	created, err := f.svc.CreateCoupon(ctx, f.actor, eventCoupon)
	require.NoError(t, err)
	global := validCoupon(nil)
	global.Code = "WERUN-FREE"
	global.DiscountType = pricing.DiscountWaiver
	global.DiscountValue = 0
	global.Description = nil
	_, err = f.svc.CreateCoupon(ctx, f.actor, global)
	require.NoError(t, err)

	assert.Equal(t, "EARLY_2026", created.Input.Code)
	assert.Equal(t, f.event.ID, *created.Input.EventID)
	assert.Equal(t, int16(2), *created.Input.MinRunners)
	assert.Equal(t, "Early pair", created.Input.Description[i18n.EN])
	assert.Equal(t, 1, f.count(t, `SELECT count(*) FROM coupons WHERE code = 'EARLY_2026' AND created_by = $1`, f.actor.ID))
	assert.Equal(t, 1, f.count(t,
		`SELECT count(*) FROM audit_logs WHERE action = 'coupon.create' AND entity_type = 'coupon'
		   AND entity_id = $1 AND event_id = $2 AND NOT is_financial`, created.ID, f.event.ID))
	assert.Equal(t, 1, f.count(t, `SELECT count(*) FROM audit_logs WHERE action = 'coupon.create' AND event_id IS NULL`))

	all, err := f.svc.ListCoupons(ctx, nil)
	require.NoError(t, err)
	assert.Len(t, all, 2)
	forEvent, err := f.svc.ListCoupons(ctx, &f.event.ID)
	require.NoError(t, err)
	require.Len(t, forEvent, 1)
	assert.Equal(t, "EARLY_2026", forEvent[0].Input.Code)
	forOther, err := f.svc.ListCoupons(ctx, &f.other.ID)
	require.NoError(t, err)
	assert.Empty(t, forOther)
	waiver, err := f.svc.ListCoupons(ctx, nil)
	require.NoError(t, err)
	for _, c := range waiver {
		if c.Input.Code == "WERUN-FREE" {
			assert.Nil(t, c.Input.Description)
			assert.Nil(t, c.Input.EventID)
		}
	}
}

func TestCreateCouponRejectsDuplicateCodeAndUnknownEvent(t *testing.T) {
	f := newPricingFixture(t)
	ctx := context.Background()
	_, err := f.svc.CreateCoupon(ctx, f.actor, validCoupon(nil))
	require.NoError(t, err)

	dup := validCoupon(&f.event.ID)
	dup.Code = "early_2026"
	_, err = f.svc.CreateCoupon(ctx, f.actor, dup)
	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	assert.Equal(t, apperr.CodeCouponCodeTaken, ae.Code)
	assert.Equal(t, http.StatusConflict, ae.Status)
	assert.Equal(t, apperr.CodeCouponCodeTaken, fieldKeys(t, err)["code"])

	missing := int64(999999)
	unknown := validCoupon(&missing)
	unknown.Code = "GHOST"
	_, err = f.svc.CreateCoupon(ctx, f.actor, unknown)
	assert.Equal(t, "field.invalid", fieldKeys(t, err)["eventId"])
	assert.Equal(t, 1, f.count(t, `SELECT count(*) FROM coupons`))
	assert.Equal(t, 1, f.count(t, `SELECT count(*) FROM audit_logs WHERE action = 'coupon.create'`))
}

func TestUpdateCoupon(t *testing.T) {
	f := newPricingFixture(t)
	ctx := context.Background()
	created, err := f.svc.CreateCoupon(ctx, f.actor, validCoupon(&f.event.ID))
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE coupons SET used_count = 2, reserved_count = 1 WHERE id = $1`, created.ID)
	require.NoError(t, err)

	below := validCoupon(&f.event.ID)
	below.Quota = 2
	_, err = f.svc.UpdateCoupon(ctx, f.actor, created.ID, below)
	require.Equal(t, "field.quota_below_taken", fieldKeys(t, err)["quota"])
	ae, _ := apperr.As(err)
	assert.Equal(t, int32(3), ae.Fields["quota"].Params["min"])

	changed := validCoupon(nil)
	changed.Code = "SOMETHING_ELSE"
	changed.Quota = 3
	changed.Status = pricing.CouponDisabled
	changed.DiscountType = pricing.DiscountAmount
	changed.DiscountValue = 300
	updated, err := f.svc.UpdateCoupon(ctx, f.actor, created.ID, changed)

	require.NoError(t, err)
	assert.Equal(t, "EARLY_2026", updated.Input.Code, "优惠码不可改")
	assert.Equal(t, pricing.CouponDisabled, updated.Input.Status)
	assert.Nil(t, updated.Input.EventID)
	assert.Equal(t, int64(300), updated.Input.DiscountValue)
	assert.Equal(t, int32(2), updated.UsedCount)
	assert.Equal(t, 1, f.count(t,
		`SELECT count(*) FROM audit_logs WHERE action = 'coupon.update' AND entity_id = $1
		   AND before_data->>'status' = 'ACTIVE' AND after_data->>'status' = 'DISABLED'`, created.ID))

	invalidCode := validCoupon(nil)
	invalidCode.Code = "x" // 修改时不校验 code
	_, err = f.svc.UpdateCoupon(ctx, f.actor, created.ID, invalidCode)
	require.NoError(t, err)

	_, err = f.svc.UpdateCoupon(ctx, f.actor, 999999, changed)
	ae, ok := apperr.As(err)
	require.True(t, ok)
	assert.Equal(t, apperr.CodeNotFound, ae.Code)
}
```

Run（数据库测试需要 Docker；本机为 colima 时先 `export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true`）：
`cd api && go test ./internal/pricing/ -run 'Coupon'`
Expected: 编译失败，`undefined: pricing.CouponInput`、`undefined: pricing.NormalizeCouponCode`。

- [ ] **Step 2: 错误码、文案、查询**

`apperr.go`：常量块在 `CodePriceRuleLocked` 之后加 `CodeCouponCodeTaken = "COUPON_CODE_TAKEN"`；`AllCodes` 在 `CodePriceRuleLocked,` 之后加 `CodeCouponCodeTaken,`；`apperr_test.go` 中 `assert.Len(t, apperr.AllCodes, 20)` 改为 `21`。

`messages.zh.json`：`"PRICE_RULE_LOCKED"` 一行之后插入 `"COUPON_CODE_TAKEN": "这个优惠码已经存在。",`；`"field.quota_below_taken"` 一行末尾补逗号后追加：

```json
  "field.coupon_code_format": "3–32 位大写字母、数字、下划线或连字符，例如 EARLY_2026。",
  "field.percent_range": "百分比必须在 1 到 100 之间。"
```

`messages.en.json`：`"COUPON_CODE_TAKEN": "This coupon code already exists.",`；

```json
  "field.coupon_code_format": "Use 3–32 uppercase letters, digits, underscores or hyphens, e.g. EARLY_2026.",
  "field.percent_range": "The percentage must be between 1 and 100."
```

`messages.km.json`：`"COUPON_CODE_TAKEN": "លេខកូដបញ្ចុះតម្លៃនេះមានរួចហើយ។",`；

```json
  "field.coupon_code_format": "ប្រើអក្សរធំ លេខ សញ្ញា _ ឬ - ចំនួន 3–32 តួ ឧទាហរណ៍ EARLY_2026។",
  "field.percent_range": "ភាគរយត្រូវតែនៅចន្លោះ 1 ដល់ 100។"
```

`catalog_test.go` key 列表在 `"field.quota_below_taken",` 之后加 `"field.coupon_code_format",`、`"field.percent_range",`。

`api/db/queries/pricing.sql` 末尾追加：

```sql
-- name: InsertCoupon :one
INSERT INTO coupons (code, event_id, discount_type, discount_value, quota, min_runners,
                     valid_from, valid_until, description, status, created_by)
VALUES (@code, sqlc.narg(event_id), @discount_type, @discount_value, @quota, sqlc.narg(min_runners),
        sqlc.narg(valid_from), sqlc.narg(valid_until), sqlc.narg(description), @status, @created_by)
RETURNING *;

-- name: GetCouponForUpdate :one
SELECT * FROM coupons
WHERE id = @id
FOR UPDATE;

-- name: UpdateCoupon :one
UPDATE coupons
SET event_id = sqlc.narg(event_id),
    discount_type = @discount_type,
    discount_value = @discount_value,
    quota = @quota,
    min_runners = sqlc.narg(min_runners),
    valid_from = sqlc.narg(valid_from),
    valid_until = sqlc.narg(valid_until),
    description = sqlc.narg(description),
    status = @status
WHERE id = @id
RETURNING *;

-- name: ListCoupons :many
SELECT * FROM coupons
WHERE (sqlc.narg(event_id)::bigint IS NULL OR event_id = sqlc.narg(event_id)::bigint)
ORDER BY created_at DESC, id DESC;
```

Run: `cd api && go tool sqlc generate && go test ./internal/platform/apperr/ ./internal/platform/i18n/`
Expected: 生成 `InsertCouponParams{Code string; EventID *int64; DiscountType string; DiscountValue int64; Quota int32; MinRunners *int16; ValidFrom, ValidUntil *time.Time; Description []byte; Status string; CreatedBy *int64}`、`UpdateCouponParams`（无 `Code`、`CreatedBy`，含 `ID`）、`ListCoupons(ctx, eventID *int64)`；apperr 与 i18n 测试 PASS。

- [ ] **Step 3: 实现优惠码服务**

`api/internal/pricing/model.go` 末尾追加：

```go
// coupons.discount_type 与 coupons.status 的取值。
const (
	DiscountPercent = "PERCENT"
	DiscountAmount  = "AMOUNT"
	DiscountWaiver  = "WAIVER"

	CouponActive   = "ACTIVE"
	CouponDisabled = "DISABLED"
)

// CouponInput 是后台新建或修改优惠码的输入。DiscountValue：PERCENT 为 1–100，AMOUNT 为分，WAIVER 为 0。
type CouponInput struct {
	Code          string
	EventID       *int64 // nil = 全场通用
	DiscountType  string
	DiscountValue int64
	Quota         int32
	MinRunners    *int16
	ValidFrom     *time.Time
	ValidUntil    *time.Time
	Description   i18n.Text // 可为 nil
	Status        string    // ACTIVE | DISABLED
}

// Coupon 是优惠码及其计数。
type Coupon struct {
	ID            int64
	Input         CouponInput
	UsedCount     int32
	ReservedCount int32
}
```

创建 `api/internal/pricing/coupons.go`：

```go
package pricing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/audit"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/pricing/store"
)

const (
	couponDescriptionMaxLen = 200
	couponMaxRunners        = 10
)

var couponCodePattern = regexp.MustCompile(`^[A-Z0-9_-]{3,32}$`)

func init() {
	apperr.RegisterConstraint("coupons_code_key", func() *apperr.Error {
		return apperr.New(http.StatusConflict, apperr.CodeCouponCodeTaken).
			WithField("code", apperr.CodeCouponCodeTaken, nil)
	})
}

// NormalizeCouponCode 去掉首尾空白并转大写。录入与下单时都先规范化。
func NormalizeCouponCode(s string) string {
	return strings.ToUpper(strings.TrimSpace(s))
}

// ValidateCoupon 校验新建优惠码的输入（Code 应已规范化），一次返回全部字段错误。
func ValidateCoupon(in CouponInput) error {
	return validateCoupon(in, true)
}

func validateCoupon(in CouponInput, withCode bool) error {
	verr := validationError()
	failed := false
	add := func(field, key string, params map[string]any) {
		verr = verr.WithField(field, key, params)
		failed = true
	}

	if withCode && !couponCodePattern.MatchString(in.Code) {
		add("code", "field.coupon_code_format", nil)
	}
	switch in.DiscountType {
	case DiscountPercent:
		if in.DiscountValue < 1 || in.DiscountValue > 100 {
			add("discountValue", "field.percent_range", nil)
		}
	case DiscountAmount:
		if in.DiscountValue <= 0 {
			add("discountValue", "field.must_be_positive", nil)
		}
	case DiscountWaiver:
		if in.DiscountValue != 0 {
			add("discountValue", "field.invalid", nil)
		}
	default:
		add("discountType", "field.invalid", nil)
	}
	if in.Quota < 1 {
		add("quota", "field.must_be_positive", nil)
	}
	if in.MinRunners != nil && (*in.MinRunners < 1 || *in.MinRunners > couponMaxRunners) {
		add("minRunners", "field.invalid", nil)
	}
	if in.ValidFrom != nil && in.ValidUntil != nil && !in.ValidUntil.After(*in.ValidFrom) {
		add("validUntil", "field.ends_before_starts", nil)
	}
	if in.Status != CouponActive && in.Status != CouponDisabled {
		add("status", "field.invalid", nil)
	}
	for _, l := range requiredLangs {
		if utf8.RuneCountInString(in.Description[l]) > couponDescriptionMaxLen {
			add("description."+string(l), "field.too_long", map[string]any{"max": couponDescriptionMaxLen})
		}
	}

	if failed {
		return verr
	}
	return nil
}

// ListCoupons：eventID 非 nil 时只返回绑定该赛事的优惠码，nil 时返回全部；按创建时间倒序。
func (s *Service) ListCoupons(ctx context.Context, eventID *int64) ([]Coupon, error) {
	rows, err := store.New(s.pool).ListCoupons(ctx, eventID)
	if err != nil {
		return nil, fmt.Errorf("list coupons: %w", err)
	}
	out := make([]Coupon, 0, len(rows))
	for _, r := range rows {
		c, err := couponFromRow(r)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, nil
}

// CreateCoupon 新建优惠码，写审计 coupon.create。优惠码重复返回 COUPON_CODE_TAKEN。
func (s *Service) CreateCoupon(ctx context.Context, actor iam.Staff, in CouponInput) (Coupon, error) {
	in.Code = NormalizeCouponCode(in.Code)
	if err := ValidateCoupon(in); err != nil {
		return Coupon{}, err
	}
	description, err := encodeDescription(in.Description)
	if err != nil {
		return Coupon{}, err
	}

	var out Coupon
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		if err := requireCouponEvent(ctx, q, in.EventID); err != nil {
			return err
		}
		actorID := actor.ID
		row, err := q.InsertCoupon(ctx, store.InsertCouponParams{
			Code:          in.Code,
			EventID:       in.EventID,
			DiscountType:  in.DiscountType,
			DiscountValue: in.DiscountValue,
			Quota:         in.Quota,
			MinRunners:    in.MinRunners,
			ValidFrom:     in.ValidFrom,
			ValidUntil:    in.ValidUntil,
			Description:   description,
			Status:        in.Status,
			CreatedBy:     &actorID,
		})
		if err != nil {
			return apperr.FromPG(err)
		}
		c, err := couponFromRow(row)
		if err != nil {
			return err
		}
		out = c
		return audit.Record(ctx, tx, staffEntry(ctx, actor, "coupon.create", "coupon", c.ID, c.Input.EventID,
			fmt.Sprintf("新建优惠码 %s（%s %d）", c.Input.Code, c.Input.DiscountType, c.Input.DiscountValue),
			nil, couponSnapshot(c)))
	})
	if err != nil {
		return Coupon{}, err
	}
	return out, nil
}

// UpdateCoupon 修改优惠码（Code 不可改，忽略 in.Code），写审计 coupon.update。
func (s *Service) UpdateCoupon(ctx context.Context, actor iam.Staff, id int64, in CouponInput) (Coupon, error) {
	if err := validateCoupon(in, false); err != nil {
		return Coupon{}, err
	}
	description, err := encodeDescription(in.Description)
	if err != nil {
		return Coupon{}, err
	}

	var out Coupon
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		row, err := q.GetCouponForUpdate(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeNotFound)
		}
		if err != nil {
			return fmt.Errorf("lock coupon %d: %w", id, err)
		}
		before, err := couponFromRow(row)
		if err != nil {
			return err
		}
		if err := requireCouponEvent(ctx, q, in.EventID); err != nil {
			return err
		}
		if taken := row.UsedCount + row.ReservedCount; in.Quota < taken {
			return validationError().WithField("quota", "field.quota_below_taken", map[string]any{"min": taken})
		}
		updatedRow, err := q.UpdateCoupon(ctx, store.UpdateCouponParams{
			EventID:       in.EventID,
			DiscountType:  in.DiscountType,
			DiscountValue: in.DiscountValue,
			Quota:         in.Quota,
			MinRunners:    in.MinRunners,
			ValidFrom:     in.ValidFrom,
			ValidUntil:    in.ValidUntil,
			Description:   description,
			Status:        in.Status,
			ID:            id,
		})
		if err != nil {
			return fmt.Errorf("update coupon %d: %w", id, err)
		}
		after, err := couponFromRow(updatedRow)
		if err != nil {
			return err
		}
		out = after
		return audit.Record(ctx, tx, staffEntry(ctx, actor, "coupon.update", "coupon", after.ID, after.Input.EventID,
			fmt.Sprintf("修改优惠码 %s", after.Input.Code), couponSnapshot(before), couponSnapshot(after)))
	})
	if err != nil {
		return Coupon{}, err
	}
	return out, nil
}

// requireCouponEvent：绑定的赛事不存在时返回字段错误（而不是 404，因为赛事 id 来自请求体）。
func requireCouponEvent(ctx context.Context, q *store.Queries, eventID *int64) error {
	if eventID == nil {
		return nil
	}
	exists, err := q.EventExists(ctx, *eventID)
	if err != nil {
		return fmt.Errorf("check event %d: %w", *eventID, err)
	}
	if !exists {
		return validationError().WithField("eventId", "field.invalid", nil)
	}
	return nil
}

func encodeDescription(t i18n.Text) ([]byte, error) {
	if t == nil {
		return nil, nil
	}
	b, err := json.Marshal(t)
	if err != nil {
		return nil, fmt.Errorf("encode coupon description: %w", err)
	}
	return b, nil
}

func couponFromRow(r store.Coupon) (Coupon, error) {
	var description i18n.Text
	if len(r.Description) > 0 {
		if err := json.Unmarshal(r.Description, &description); err != nil {
			return Coupon{}, fmt.Errorf("decode description of coupon %d: %w", r.ID, err)
		}
	}
	return Coupon{
		ID: r.ID,
		Input: CouponInput{
			Code:          r.Code,
			EventID:       r.EventID,
			DiscountType:  r.DiscountType,
			DiscountValue: r.DiscountValue,
			Quota:         r.Quota,
			MinRunners:    r.MinRunners,
			ValidFrom:     r.ValidFrom,
			ValidUntil:    r.ValidUntil,
			Description:   description,
			Status:        r.Status,
		},
		UsedCount:     r.UsedCount,
		ReservedCount: r.ReservedCount,
	}, nil
}

func couponSnapshot(c Coupon) map[string]any {
	return map[string]any{
		"code":          c.Input.Code,
		"eventId":       c.Input.EventID,
		"discountType":  c.Input.DiscountType,
		"discountValue": c.Input.DiscountValue,
		"quota":         c.Input.Quota,
		"minRunners":    c.Input.MinRunners,
		"validFrom":     c.Input.ValidFrom,
		"validUntil":    c.Input.ValidUntil,
		"status":        c.Input.Status,
	}
}
```

Run（colima 环境变量同 Step 1）：`cd api && go test ./internal/pricing/ -v`
Expected: 全部 PASS：`TestNormalizeCouponCode`、`TestValidateCoupon`（13 个子测试）、`TestCreateAndListCoupons`、`TestCreateCouponRejectsDuplicateCodeAndUnknownEvent`、`TestUpdateCoupon`，以及 Task 4 的价格档测试。

- [ ] **Step 4: OpenAPI 与生成代码**

`api/openapi/openapi.yaml` 的 `paths` 末尾追加：

```yaml
  /admin/coupons:
    get:
      operationId: adminListCoupons
      summary: 优惠码列表（eventId 为空时返回全部）
      x-permission: coupon_manage
      x-access: read
      parameters:
        - name: eventId
          in: query
          required: false
          schema:
            type: integer
            format: int64
      responses:
        '200':
          description: 优惠码列表
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/CouponList'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
    post:
      operationId: adminCreateCoupon
      summary: 新建优惠码（代码自动转大写）
      x-permission: coupon_manage
      x-access: write
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateCouponRequest'
      responses:
        '201':
          description: 已创建
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Coupon'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
  /admin/coupons/{id}:
    put:
      operationId: adminUpdateCoupon
      summary: 修改优惠码（代码不可改）
      x-permission: coupon_manage
      x-access: write
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
              $ref: '#/components/schemas/UpdateCouponRequest'
      responses:
        '200':
          description: 已保存
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Coupon'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
```

`components.schemas` 末尾追加：

```yaml
    DiscountType:
      type: string
      enum: [PERCENT, AMOUNT, WAIVER]
    CouponStatus:
      type: string
      enum: [ACTIVE, DISABLED]
    UpdateCouponRequest:
      type: object
      required: [discountType, discountValue, quota, status]
      properties:
        eventId:
          type: integer
          format: int64
          nullable: true
        discountType:
          $ref: '#/components/schemas/DiscountType'
        discountValue:
          type: integer
          format: int64
          description: PERCENT 为 1–100；AMOUNT 为美分；WAIVER 为 0
        quota:
          type: integer
          format: int32
        minRunners:
          type: integer
          format: int32
          nullable: true
        validFrom:
          type: string
          format: date-time
          nullable: true
        validUntil:
          type: string
          format: date-time
          nullable: true
        description:
          $ref: '#/components/schemas/LocalizedText'
        status:
          $ref: '#/components/schemas/CouponStatus'
    CreateCouponRequest:
      type: object
      required: [code, discountType, discountValue, quota, status]
      properties:
        code:
          type: string
        eventId:
          type: integer
          format: int64
          nullable: true
        discountType:
          $ref: '#/components/schemas/DiscountType'
        discountValue:
          type: integer
          format: int64
        quota:
          type: integer
          format: int32
        minRunners:
          type: integer
          format: int32
          nullable: true
        validFrom:
          type: string
          format: date-time
          nullable: true
        validUntil:
          type: string
          format: date-time
          nullable: true
        description:
          $ref: '#/components/schemas/LocalizedText'
        status:
          $ref: '#/components/schemas/CouponStatus'
    Coupon:
      type: object
      required: [id, code, eventId, discountType, discountValue, quota, minRunners, validFrom, validUntil, status, usedCount, reservedCount]
      properties:
        id:
          type: integer
          format: int64
        code:
          type: string
        eventId:
          type: integer
          format: int64
          nullable: true
        discountType:
          $ref: '#/components/schemas/DiscountType'
        discountValue:
          type: integer
          format: int64
        quota:
          type: integer
          format: int32
        minRunners:
          type: integer
          format: int32
          nullable: true
        validFrom:
          type: string
          format: date-time
          nullable: true
        validUntil:
          type: string
          format: date-time
          nullable: true
        description:
          $ref: '#/components/schemas/LocalizedText'
        status:
          $ref: '#/components/schemas/CouponStatus'
        usedCount:
          type: integer
          format: int32
        reservedCount:
          type: integer
          format: int32
    CouponList:
      type: object
      required: [items]
      properties:
        items:
          type: array
          items:
            $ref: '#/components/schemas/Coupon'
```

Run: `make gen`
Expected: `api.gen.go` 出现 `AdminListCouponsParams{EventId *int64}`、`CreateCouponRequest{Code string; Description *LocalizedText; DiscountType DiscountType; DiscountValue int64; EventId *int64; MinRunners *int32; Quota int32; Status CouponStatus; ValidFrom, ValidUntil *time.Time}`、`UpdateCouponRequest`（无 `Code`）、`Coupon`；`permissions.gen.go` 增加三条 `coupon_manage` 规则。`go build ./...` 因缺少 handler 方法失败。

- [ ] **Step 5: 写接口的失败测试**

创建 `api/internal/httpapi/coupons_http_test.go`：

```go
package httpapi_test

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
)

func couponBody(code string, eventID *int64) map[string]any {
	return map[string]any{
		"code":          code,
		"eventId":       eventID,
		"discountType":  "PERCENT",
		"discountValue": 20,
		"quota":         50,
		"minRunners":    2,
		"validFrom":     nil,
		"validUntil":    "2026-10-31T23:59:00+07:00",
		"status":        "ACTIVE",
	}
}

func TestCouponsHTTP(t *testing.T) {
	env := newEventsEnv(t)
	ops := env.sessionCookie(t, iam.RoleOps, "ops.couponhttp")
	support := env.sessionCookie(t, iam.RoleSupport, "support.couponhttp")
	ev := env.createPublishedEvent(t, ops)

	rec := env.do(t, http.MethodPost, "/api/admin/coupons", couponBody("early_2026", &ev.Id), support, adminClientHeader)
	require.Equal(t, http.StatusForbidden, rec.Code, "SUPPORT 对 coupon_manage 只读")

	rec = env.do(t, http.MethodPost, "/api/admin/coupons", couponBody("early_2026", &ev.Id), ops, adminClientHeader)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	created := eventsDecode[apigen.Coupon](t, rec)
	require.Equal(t, "EARLY_2026", created.Code)
	require.Equal(t, ev.Id, *created.EventId)
	require.Equal(t, int32(2), *created.MinRunners)
	require.Nil(t, created.Description)

	rec = env.do(t, http.MethodPost, "/api/admin/coupons", couponBody("WERUN_ALL", nil), ops, adminClientHeader)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	rec = env.do(t, http.MethodGet, fmt.Sprintf("/api/admin/coupons?eventId=%d", ev.Id), nil, support, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	list := eventsDecode[apigen.CouponList](t, rec)
	require.Len(t, list.Items, 1)
	require.Equal(t, "EARLY_2026", list.Items[0].Code)

	rec = env.do(t, http.MethodGet, "/api/admin/coupons", nil, support, nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Len(t, eventsDecode[apigen.CouponList](t, rec).Items, 2)

	rec = env.do(t, http.MethodPost, "/api/admin/coupons", couponBody("Early_2026", nil), ops, adminClientHeader)
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	dup := eventsDecode[httpx.ErrorBody](t, rec)
	require.Equal(t, apperr.CodeCouponCodeTaken, dup.Error.Code)
	require.Contains(t, dup.Error.Fields, "code")

	bad := couponBody("BIG_DEAL", nil)
	bad["discountValue"] = 150
	rec = env.do(t, http.MethodPost, "/api/admin/coupons", bad, ops, adminClientHeader)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	require.Contains(t, eventsDecode[httpx.ErrorBody](t, rec).Error.Fields, "discountValue")

	update := couponBody("IGNORED", &ev.Id)
	delete(update, "code")
	update["status"] = "DISABLED"
	rec = env.do(t, http.MethodPut, fmt.Sprintf("/api/admin/coupons/%d", created.Id), update, ops, adminClientHeader)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	updated := eventsDecode[apigen.Coupon](t, rec)
	require.Equal(t, "EARLY_2026", updated.Code)
	require.Equal(t, apigen.CouponStatus("DISABLED"), updated.Status)

	rec = env.do(t, http.MethodPut, "/api/admin/coupons/999999", update, ops, adminClientHeader)
	require.Equal(t, http.StatusNotFound, rec.Code)
}
```

Run（colima 环境变量同 Step 1）：`cd api && go test ./internal/httpapi/ -run TestCouponsHTTP`
Expected: 编译失败，`*Server does not implement apigen.StrictServerInterface (missing method AdminCreateCoupon)`。

- [ ] **Step 6: 实现 handler**

`api/internal/pricing/handlers.go` 末尾追加：

```go
func (h *Handlers) AdminListCoupons(ctx context.Context, req apigen.AdminListCouponsRequestObject) (apigen.AdminListCouponsResponseObject, error) {
	coupons, err := h.svc.ListCoupons(ctx, req.Params.EventId)
	if err != nil {
		return nil, err
	}
	items := make([]apigen.Coupon, 0, len(coupons))
	for _, c := range coupons {
		items = append(items, toAPICoupon(c))
	}
	return apigen.AdminListCoupons200JSONResponse{Items: items}, nil
}

func (h *Handlers) AdminCreateCoupon(ctx context.Context, req apigen.AdminCreateCouponRequestObject) (apigen.AdminCreateCouponResponseObject, error) {
	actor, ok := iam.StaffFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	b := req.Body
	in, err := couponInputFromAPI(b.EventId, string(b.DiscountType), b.DiscountValue, b.Quota, b.MinRunners,
		b.ValidFrom, b.ValidUntil, b.Description, string(b.Status))
	if err != nil {
		return nil, err
	}
	in.Code = b.Code
	c, err := h.svc.CreateCoupon(ctx, actor, in)
	if err != nil {
		return nil, err
	}
	return apigen.AdminCreateCoupon201JSONResponse(toAPICoupon(c)), nil
}

func (h *Handlers) AdminUpdateCoupon(ctx context.Context, req apigen.AdminUpdateCouponRequestObject) (apigen.AdminUpdateCouponResponseObject, error) {
	actor, ok := iam.StaffFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	b := req.Body
	in, err := couponInputFromAPI(b.EventId, string(b.DiscountType), b.DiscountValue, b.Quota, b.MinRunners,
		b.ValidFrom, b.ValidUntil, b.Description, string(b.Status))
	if err != nil {
		return nil, err
	}
	c, err := h.svc.UpdateCoupon(ctx, actor, req.Id, in)
	if err != nil {
		return nil, err
	}
	return apigen.AdminUpdateCoupon200JSONResponse(toAPICoupon(c)), nil
}

func couponInputFromAPI(eventID *int64, discountType string, discountValue int64, quota int32, minRunners *int32,
	validFrom, validUntil *time.Time, description *apigen.LocalizedText, status string,
) (CouponInput, error) {
	in := CouponInput{
		EventID:       eventID,
		DiscountType:  discountType,
		DiscountValue: discountValue,
		Quota:         quota,
		ValidFrom:     validFrom,
		ValidUntil:    validUntil,
		Status:        status,
	}
	if minRunners != nil {
		if *minRunners < math.MinInt16 || *minRunners > math.MaxInt16 {
			return CouponInput{}, validationError().WithField("minRunners", "field.invalid", nil)
		}
		v := int16(*minRunners)
		in.MinRunners = &v
	}
	if description != nil {
		in.Description = textFromAPI(*description)
	}
	return in, nil
}

func toAPICoupon(c Coupon) apigen.Coupon {
	out := apigen.Coupon{
		Id:            c.ID,
		Code:          c.Input.Code,
		EventId:       c.Input.EventID,
		DiscountType:  apigen.DiscountType(c.Input.DiscountType),
		DiscountValue: c.Input.DiscountValue,
		Quota:         c.Input.Quota,
		ValidFrom:     c.Input.ValidFrom,
		ValidUntil:    c.Input.ValidUntil,
		Status:        apigen.CouponStatus(c.Input.Status),
		UsedCount:     c.UsedCount,
		ReservedCount: c.ReservedCount,
	}
	if c.Input.MinRunners != nil {
		v := int32(*c.Input.MinRunners)
		out.MinRunners = &v
	}
	if c.Input.Description != nil {
		d := textToAPI(c.Input.Description)
		out.Description = &d
	}
	return out
}
```

`handlers.go` 的 import 块加入 `"time"`。

Run（colima 环境变量同 Step 1）：`cd api && go test ./internal/httpapi/ ./internal/pricing/`
Expected: PASS，含 `TestCouponsHTTP`。

- [ ] **Step 7: 写后台优惠码的失败测试**

`web/admin/src/test/fixtures.ts`：

```ts
  permissions: { event_config: "write", event_publish: "write", order_view: "read", price_config: "write" },
```

改为：

```ts
  permissions: {
    event_config: "write",
    event_publish: "write",
    order_view: "read",
    price_config: "write",
    coupon_manage: "write",
  },
```

```ts
  permissions: { event_config: "read", event_publish: "read", access_manage: "write", price_config: "read" },
```

改为：

```ts
  permissions: {
    event_config: "read",
    event_publish: "read",
    access_manage: "write",
    price_config: "read",
    coupon_manage: "read",
  },
```

在 `earlyBirdRule` 之后追加：

```ts
export const earlyCoupon: Schemas["Coupon"] = {
  id: 41,
  code: "EARLY_2026",
  eventId: 7,
  discountType: "PERCENT",
  discountValue: 20,
  quota: 50,
  minRunners: 2,
  validFrom: null,
  validUntil: "2026-10-31T16:59:00Z",
  status: "ACTIVE",
  usedCount: 3,
  reservedCount: 1,
};
```

创建 `web/admin/src/coupons/couponForm.test.ts`：

```ts
import dayjs from "dayjs";
import { describe, expect, it } from "vitest";
import { earlyCoupon } from "../test/fixtures";
import {
  emptyCoupon,
  formatDiscount,
  fromCoupon,
  parseDiscountValue,
  toCreateCouponRequest,
  toUpdateCouponRequest,
} from "./couponForm";

describe("parseDiscountValue", () => {
  it.each([
    ["PERCENT", "20", 20],
    ["PERCENT", " 100 ", 100],
    ["PERCENT", "0", null],
    ["PERCENT", "101", null],
    ["PERCENT", "12.5", null],
    ["AMOUNT", "5", 500],
    ["AMOUNT", "5.25", 525],
    ["AMOUNT", "0", null],
    ["AMOUNT", "abc", null],
    ["WAIVER", undefined, 0],
    ["WAIVER", "99", 0],
  ] as const)("%s %j → %j", (type, input, expected) => {
    expect(parseDiscountValue(type, input)).toBe(expected);
  });
});

describe("请求体转换", () => {
  it("新建：代码去空格转大写，固定金额按美元转分", () => {
    const body = toCreateCouponRequest(
      {
        ...emptyCoupon(),
        code: " run_kh ",
        discountType: "AMOUNT",
        discountValue: "5.5",
        quota: 10,
        validFrom: dayjs("2026-09-20T01:00:00Z"),
      },
      7,
    );

    expect(body).toEqual({
      code: "RUN_KH",
      eventId: 7,
      discountType: "AMOUNT",
      discountValue: 550,
      quota: 10,
      minRunners: null,
      validFrom: "2026-09-20T01:00:00.000Z",
      validUntil: null,
      status: "ACTIVE",
    });
  });

  it("修改：请求体不含代码，免单值为 0", () => {
    const body = toUpdateCouponRequest({ ...fromCoupon(earlyCoupon), discountType: "WAIVER", discountValue: "" }, 7);

    expect(body).not.toHaveProperty("code");
    expect(body).toMatchObject({ eventId: 7, discountType: "WAIVER", discountValue: 0, quota: 50, minRunners: 2 });
  });

  it("折扣值非法时抛错（表单校验保证不会走到这里）", () => {
    expect(() => toCreateCouponRequest({ ...emptyCoupon(), code: "ABC", discountValue: "0", quota: 1 }, 7)).toThrow(
      "invalid discount",
    );
  });

  it("fromCoupon 回填与 formatDiscount 展示", () => {
    expect(fromCoupon(earlyCoupon)).toMatchObject({ code: "EARLY_2026", discountValue: "20", quota: 50, minRunners: 2 });
    expect(fromCoupon({ ...earlyCoupon, discountType: "AMOUNT", discountValue: 500 }).discountValue).toBe("5.00");
    expect(formatDiscount(earlyCoupon, "Free")).toBe("20%");
    expect(formatDiscount({ discountType: "AMOUNT", discountValue: 250 }, "Free")).toBe("$2.50");
    expect(formatDiscount({ discountType: "WAIVER", discountValue: 0 }, "Free")).toBe("Free");
  });
});
```

创建 `web/admin/src/coupons/CouponsTab.test.tsx`：

```tsx
import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { adminMe, earlyCoupon, jsonResponse, opsMe, publishedEvent } from "../test/fixtures";
import { fillField, replaceField, setupFormUser } from "../test/form";
import { renderAdminApp } from "../test/renderAdminApp";

beforeEach(() => {
  window.localStorage.setItem("werun.lang", "en");
});

function findRequest(requests: Request[], method: string, pathname: string): Request | undefined {
  return requests.find((request) => request.method === method && new URL(request.url).pathname === pathname);
}

async function openCouponsTab(user: ReturnType<typeof setupFormUser>) {
  await user.click(await screen.findByTestId("event-tab-coupons"));
}

describe("优惠码标签页", () => {
  it("OPS 新建百分比优惠码：代码转大写并绑定当前赛事", async () => {
    let created = false;
    const { requests } = renderAdminApp("/events/7", {
      "GET /api/admin/me": () => jsonResponse(200, opsMe),
      "GET /api/admin/events/7": () => jsonResponse(200, publishedEvent),
      "GET /api/admin/coupons": () =>
        jsonResponse(200, { items: created ? [{ ...earlyCoupon, usedCount: 0, reservedCount: 0 }] : [] }),
      "POST /api/admin/coupons": () => {
        created = true;
        return jsonResponse(201, earlyCoupon);
      },
    });
    const user = setupFormUser();

    await openCouponsTab(user);
    await user.click(await screen.findByTestId("coupon-create"));
    await fillField(user, "coupon_code", "early_2026");
    await fillField(user, "coupon_discountValue", "20");
    await fillField(user, "coupon_quota", "50");
    await fillField(user, "coupon_minRunners", "2");
    await user.click(screen.getByTestId("coupon-submit"));

    const row = await screen.findByTestId("coupon-row-EARLY_2026");
    expect(within(row).getByText("20%")).toBeInTheDocument();
    const list = findRequest(requests, "GET", "/api/admin/coupons");
    expect(new URL(list!.url).searchParams.get("eventId")).toBe("7");
    expect(await findRequest(requests, "POST", "/api/admin/coupons")?.clone().json()).toEqual({
      code: "EARLY_2026",
      eventId: 7,
      discountType: "PERCENT",
      discountValue: 20,
      quota: 50,
      minRunners: 2,
      validFrom: null,
      validUntil: null,
      status: "ACTIVE",
    });
  });

  it("百分比超出范围时不提交", async () => {
    const { requests } = renderAdminApp("/events/7", {
      "GET /api/admin/me": () => jsonResponse(200, opsMe),
      "GET /api/admin/events/7": () => jsonResponse(200, publishedEvent),
      "GET /api/admin/coupons": () => jsonResponse(200, { items: [] }),
    });
    const user = setupFormUser();

    await openCouponsTab(user);
    await user.click(await screen.findByTestId("coupon-create"));
    await fillField(user, "coupon_code", "BIG_DEAL");
    await fillField(user, "coupon_discountValue", "150");
    await fillField(user, "coupon_quota", "5");
    await user.click(screen.getByTestId("coupon-submit"));

    expect(await screen.findByText("Enter a whole number from 1 to 100")).toBeInTheDocument();
    expect(findRequest(requests, "POST", "/api/admin/coupons")).toBeUndefined();
  });

  it("代码重复：服务端字段错误显示在代码输入框下", async () => {
    renderAdminApp("/events/7", {
      "GET /api/admin/me": () => jsonResponse(200, opsMe),
      "GET /api/admin/events/7": () => jsonResponse(200, publishedEvent),
      "GET /api/admin/coupons": () => jsonResponse(200, { items: [] }),
      "POST /api/admin/coupons": () =>
        jsonResponse(409, {
          error: {
            code: "COUPON_CODE_TAKEN",
            message: "This coupon code already exists.",
            fields: { code: "This coupon code already exists." },
          },
        }),
    });
    const user = setupFormUser();

    await openCouponsTab(user);
    await user.click(await screen.findByTestId("coupon-create"));
    await fillField(user, "coupon_code", "EARLY_2026");
    await fillField(user, "coupon_discountValue", "10");
    await fillField(user, "coupon_quota", "5");
    await user.click(screen.getByTestId("coupon-submit"));

    expect(await screen.findByText("This coupon code already exists.")).toBeInTheDocument();
    expect(screen.getByTestId("coupon-submit")).toBeInTheDocument();
  });

  it("编辑：代码不可改，请求体不含代码", async () => {
    const { requests } = renderAdminApp("/events/7", {
      "GET /api/admin/me": () => jsonResponse(200, opsMe),
      "GET /api/admin/events/7": () => jsonResponse(200, publishedEvent),
      "GET /api/admin/coupons": () => jsonResponse(200, { items: [earlyCoupon] }),
      "PUT /api/admin/coupons/41": () => jsonResponse(200, { ...earlyCoupon, quota: 60 }),
    });
    const user = setupFormUser();

    await openCouponsTab(user);
    await user.click(await screen.findByTestId("coupon-edit-EARLY_2026"));
    expect(document.querySelector("#coupon_code")).toBeDisabled();
    await replaceField(user, "coupon_quota", "60");
    await user.click(screen.getByTestId("coupon-submit"));

    expect(await screen.findByText("Coupon saved")).toBeInTheDocument();
    expect(await findRequest(requests, "PUT", "/api/admin/coupons/41")?.clone().json()).toEqual({
      eventId: 7,
      discountType: "PERCENT",
      discountValue: 20,
      quota: 60,
      minRunners: 2,
      validFrom: null,
      validUntil: "2026-10-31T16:59:00.000Z",
      status: "ACTIVE",
    });
  });

  it("ADMIN 只读：没有新建与编辑按钮", async () => {
    renderAdminApp("/events/7", {
      "GET /api/admin/me": () => jsonResponse(200, adminMe),
      "GET /api/admin/events/7": () => jsonResponse(200, publishedEvent),
      "GET /api/admin/coupons": () => jsonResponse(200, { items: [earlyCoupon] }),
    });
    const user = setupFormUser();

    await openCouponsTab(user);

    expect(await screen.findByTestId("coupon-row-EARLY_2026")).toBeInTheDocument();
    expect(screen.queryByTestId("coupon-create")).not.toBeInTheDocument();
    expect(screen.queryByTestId("coupon-edit-EARLY_2026")).not.toBeInTheDocument();
  });
});
```

Run: `pnpm --filter @werun/admin test src/coupons`
Expected: FAIL，`Failed to resolve import "./couponForm"`；`CouponsTab.test.tsx` 找不到 `event-tab-coupons`。

- [ ] **Step 8: 实现前端优惠码**

创建 `web/admin/src/coupons/queries.ts`：

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@werun/api-client";
import { useApi } from "../api";

export function couponsKey(eventId: number) {
  return ["admin", "coupons", eventId] as const;
}

export function useCoupons(eventId: number) {
  const api = useApi();
  return useQuery({
    queryKey: couponsKey(eventId),
    queryFn: async () => unwrap(await api.GET("/admin/coupons", { params: { query: { eventId } } })).items,
  });
}

export type SaveCouponInput =
  | { id: undefined; body: Schemas["CreateCouponRequest"] }
  | { id: number; body: Schemas["UpdateCouponRequest"] };

export function useSaveCoupon(eventId: number) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveCouponInput) =>
      input.id === undefined
        ? unwrap(await api.POST("/admin/coupons", { body: input.body }))
        : unwrap(await api.PUT("/admin/coupons/{id}", { params: { path: { id: input.id } }, body: input.body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: couponsKey(eventId) }),
  });
}
```

创建 `web/admin/src/coupons/couponForm.ts`：

```ts
import { formatUsd, parseUsdToCents, type Schemas } from "@werun/api-client";
import dayjs, { type Dayjs } from "dayjs";

type DiscountType = Schemas["DiscountType"];

export interface CouponFormValues {
  code: string;
  discountType: DiscountType;
  discountValue?: string;
  quota?: number | null;
  minRunners?: number | null;
  validFrom?: Dayjs | null;
  validUntil?: Dayjs | null;
  status: Schemas["CouponStatus"];
}

export function emptyCoupon(): CouponFormValues {
  return {
    code: "",
    discountType: "PERCENT",
    discountValue: "",
    quota: null,
    minRunners: null,
    validFrom: null,
    validUntil: null,
    status: "ACTIVE",
  };
}

/** 表单折扣值 → 接口值：PERCENT 为 1–100 的整数；AMOUNT 为美元字符串转分且大于 0；WAIVER 恒为 0。非法返回 null */
export function parseDiscountValue(type: DiscountType, input: string | undefined): number | null {
  if (type === "WAIVER") {
    return 0;
  }
  const text = (input ?? "").trim();
  if (type === "PERCENT") {
    if (!/^\d{1,3}$/.test(text)) {
      return null;
    }
    const percent = Number(text);
    return percent >= 1 && percent <= 100 ? percent : null;
  }
  const cents = parseUsdToCents(text);
  return cents !== null && cents > 0 ? cents : null;
}

export function fromCoupon(coupon: Schemas["Coupon"]): CouponFormValues {
  let discountValue = "";
  if (coupon.discountType === "PERCENT") {
    discountValue = String(coupon.discountValue);
  } else if (coupon.discountType === "AMOUNT") {
    discountValue = formatUsd(coupon.discountValue).slice(1);
  }
  return {
    code: coupon.code,
    discountType: coupon.discountType,
    discountValue,
    quota: coupon.quota,
    minRunners: coupon.minRunners,
    validFrom: coupon.validFrom ? dayjs(coupon.validFrom) : null,
    validUntil: coupon.validUntil ? dayjs(coupon.validUntil) : null,
    status: coupon.status,
  };
}

function commonFields(values: CouponFormValues) {
  const discountValue = parseDiscountValue(values.discountType, values.discountValue);
  if (discountValue === null) {
    throw new Error(`invalid discount: ${values.discountValue ?? ""}`);
  }
  return {
    discountType: values.discountType,
    discountValue,
    quota: values.quota ?? 0,
    minRunners: values.minRunners ?? null,
    validFrom: values.validFrom ? values.validFrom.toISOString() : null,
    validUntil: values.validUntil ? values.validUntil.toISOString() : null,
    status: values.status,
  };
}

export function toCreateCouponRequest(values: CouponFormValues, eventId: number): Schemas["CreateCouponRequest"] {
  return { code: values.code.trim().toUpperCase(), eventId, ...commonFields(values) };
}

export function toUpdateCouponRequest(values: CouponFormValues, eventId: number | null): Schemas["UpdateCouponRequest"] {
  return { eventId, ...commonFields(values) };
}

export function formatDiscount(
  coupon: Pick<Schemas["Coupon"], "discountType" | "discountValue">,
  waiverLabel: string,
): string {
  switch (coupon.discountType) {
    case "PERCENT":
      return `${coupon.discountValue}%`;
    case "AMOUNT":
      return formatUsd(coupon.discountValue);
    default:
      return waiverLabel;
  }
}
```

创建 `web/admin/src/coupons/CouponsTab.tsx`：

```tsx
import { PlusOutlined } from "@ant-design/icons";
import { ApiError, type Schemas } from "@werun/api-client";
import {
  Alert,
  App as AntdApp,
  Button,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  type TableProps,
} from "antd";
import dayjs from "dayjs";
import { useState, type HTMLAttributes } from "react";
import { useTranslation } from "react-i18next";
import { PERM_COUPON_MANAGE, can } from "../auth/can";
import { useMe } from "../auth/useMe";
import { toNamePath } from "../events/eventForm";
import {
  emptyCoupon,
  formatDiscount,
  fromCoupon,
  parseDiscountValue,
  toCreateCouponRequest,
  toUpdateCouponRequest,
  type CouponFormValues,
} from "./couponForm";
import { useCoupons, useSaveCoupon } from "./queries";

type AdminEvent = Schemas["AdminEvent"];
type Coupon = Schemas["Coupon"];

function formatTime(value: string | null): string {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "—";
}

export function CouponsTab({ event }: { event: AdminEvent }) {
  const { t } = useTranslation("admin");
  const { data: me } = useMe();
  const coupons = useCoupons(event.id);
  const canWrite = can(me?.permissions, PERM_COUPON_MANAGE, "write");
  const [editing, setEditing] = useState<{ coupon?: Coupon } | null>(null);

  const columns: TableProps<Coupon>["columns"] = [
    { title: t("coupons.col.code"), dataIndex: "code", key: "code" },
    {
      title: t("coupons.col.discount"),
      key: "discount",
      render: (_, coupon) => formatDiscount(coupon, t("coupons.discountType.WAIVER")),
    },
    {
      title: t("coupons.col.quota"),
      key: "quota",
      render: (_, coupon) => `${coupon.usedCount + coupon.reservedCount} / ${coupon.quota}`,
    },
    { title: t("coupons.col.minRunners"), key: "minRunners", render: (_, coupon) => coupon.minRunners ?? "—" },
    {
      title: t("coupons.col.validity"),
      key: "validity",
      render: (_, coupon) => `${formatTime(coupon.validFrom)} ~ ${formatTime(coupon.validUntil)}`,
    },
    {
      title: t("coupons.col.status"),
      key: "status",
      render: (_, coupon) => (
        <Tag color={coupon.status === "ACTIVE" ? "green" : "default"}>{t(`coupons.status.${coupon.status}`)}</Tag>
      ),
    },
    {
      title: t("coupons.col.actions"),
      key: "actions",
      render: (_, coupon) =>
        canWrite ? (
          <Button size="small" data-testid={`coupon-edit-${coupon.code}`} onClick={() => setEditing({ coupon })}>
            {t("coupons.edit")}
          </Button>
        ) : null,
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space style={{ width: "100%", justifyContent: "space-between" }} wrap>
        <Typography.Text type="secondary">{t("coupons.hint")}</Typography.Text>
        {canWrite ? (
          <Button type="primary" icon={<PlusOutlined />} data-testid="coupon-create" onClick={() => setEditing({})}>
            {t("coupons.create")}
          </Button>
        ) : null}
      </Space>
      {coupons.isError ? <Alert type="error" showIcon message={coupons.error.message} /> : null}
      <Table<Coupon>
        rowKey="id"
        columns={columns}
        dataSource={coupons.data ?? []}
        loading={coupons.isPending}
        pagination={false}
        locale={{ emptyText: t("coupons.empty") }}
        scroll={{ x: 900 }}
        onRow={(coupon) => ({ "data-testid": `coupon-row-${coupon.code}` }) as HTMLAttributes<HTMLElement>}
      />
      {editing ? <CouponModal event={event} coupon={editing.coupon} onClose={() => setEditing(null)} /> : null}
    </Space>
  );
}

interface CouponModalProps {
  event: AdminEvent;
  coupon?: Coupon;
  onClose: () => void;
}

function CouponModal({ event, coupon, onClose }: CouponModalProps) {
  const { t } = useTranslation("admin");
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<CouponFormValues>();
  const discountType = Form.useWatch("discountType", form) ?? coupon?.discountType ?? "PERCENT";
  const save = useSaveCoupon(event.id);
  const required = [{ required: true, message: t("form.required") }];
  const hasFieldErrors = save.error instanceof ApiError && Object.keys(save.error.fields).length > 0;
  const bannerError = save.error && !hasFieldErrors ? save.error : null;

  const onFinish = (values: CouponFormValues) => {
    const input = coupon
      ? { id: coupon.id, body: toUpdateCouponRequest(values, coupon.eventId) }
      : { id: undefined, body: toCreateCouponRequest(values, event.id) };
    save.mutate(input, {
      onSuccess: () => {
        void message.success(t(coupon ? "coupons.updated" : "coupons.created"));
        onClose();
      },
      onError: (error) => {
        if (error instanceof ApiError && Object.keys(error.fields).length > 0) {
          form.setFields(
            Object.entries(error.fields).map(([field, text]) => ({ name: toNamePath(field), errors: [text] })) as Parameters<
              typeof form.setFields
            >[0],
          );
        }
      },
    });
  };

  return (
    <Modal open title={t(coupon ? "coupons.editTitle" : "coupons.createTitle")} onCancel={onClose} footer={null} width={720} maskClosable={false}>
      {bannerError ? <Alert type="error" showIcon message={bannerError.message} style={{ marginBottom: 16 }} /> : null}
      <Form<CouponFormValues>
        form={form}
        name="coupon"
        layout="vertical"
        onFinish={onFinish}
        disabled={save.isPending}
        initialValues={coupon ? fromCoupon(coupon) : emptyCoupon()}
      >
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="code" label={t("coupons.form.code")} extra={t("coupons.form.codeHelp")} rules={required}>
              <Input disabled={coupon !== undefined} style={{ textTransform: "uppercase" }} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="status" label={t("coupons.form.status")} rules={required}>
              <Select
                options={[
                  { value: "ACTIVE", label: t("coupons.status.ACTIVE") },
                  { value: "DISABLED", label: t("coupons.status.DISABLED") },
                ]}
              />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="discountType" label={t("coupons.form.discountType")} rules={required}>
              <Select
                options={[
                  { value: "PERCENT", label: t("coupons.discountType.PERCENT") },
                  { value: "AMOUNT", label: t("coupons.discountType.AMOUNT") },
                  { value: "WAIVER", label: t("coupons.discountType.WAIVER") },
                ]}
              />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item
              name="discountValue"
              label={t("coupons.form.discountValue")}
              dependencies={["discountType"]}
              rules={[
                {
                  validator: (_: unknown, value: string | undefined) => {
                    if (parseDiscountValue(discountType, value) !== null) {
                      return Promise.resolve();
                    }
                    const key = discountType === "PERCENT" ? "coupons.form.percentInvalid" : "coupons.form.amountInvalid";
                    return Promise.reject(new Error(t(key)));
                  },
                },
              ]}
            >
              <Input
                inputMode="decimal"
                disabled={discountType === "WAIVER"}
                addonBefore={discountType === "AMOUNT" ? "$" : undefined}
                addonAfter={discountType === "PERCENT" ? "%" : undefined}
              />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col xs={12} md={12}>
            <Form.Item name="quota" label={t("coupons.form.quota")} rules={required}>
              <InputNumber min={1} precision={0} style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col xs={12} md={12}>
            <Form.Item name="minRunners" label={t("coupons.form.minRunners")} extra={t("coupons.form.minRunnersHelp")}>
              <InputNumber min={1} max={10} precision={0} style={{ width: "100%" }} />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="validFrom" label={t("coupons.form.validFrom")}>
              <DatePicker showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="validUntil" label={t("coupons.form.validUntil")}>
              <DatePicker showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" style={{ width: "100%" }} />
            </Form.Item>
          </Col>
        </Row>
        <Space>
          <Button onClick={onClose}>{t("coupons.cancel")}</Button>
          <Button type="primary" htmlType="submit" loading={save.isPending} data-testid="coupon-submit">
            {t("coupons.submit")}
          </Button>
        </Space>
      </Form>
    </Modal>
  );
}
```

`web/admin/src/pages/EventDetailPage.tsx`：

```tsx
import { PERM_EVENT_CONFIG, PERM_PRICE_CONFIG, can } from "../auth/can";
```

改为：

```tsx
import { PERM_COUPON_MANAGE, PERM_EVENT_CONFIG, PERM_PRICE_CONFIG, can } from "../auth/can";
```

在 `import { useMe } from "../auth/useMe";` 之后加 `import { CouponsTab } from "../coupons/CouponsTab";`。把：

```tsx
      children: <PricingTab event={event} />,
    });
  }
```

改为：

```tsx
      children: <PricingTab event={event} />,
    });
  }
  if (can(me?.permissions, PERM_COUPON_MANAGE, "read")) {
    items.push({
      key: "coupons",
      label: <span data-testid="event-tab-coupons">{t("eventDetail.tabCoupons")}</span>,
      children: <CouponsTab event={event} />,
    });
  }
```

`packages/i18n/locales/zh/admin.json`：`"tabPricing": "价格档",` 之后加 `"tabCoupons": "优惠码",`；顶层在 `pricing` 之后追加：

```json
  "coupons": {
    "hint": "这里新建的优惠码只能用于本赛事。",
    "create": "新建优惠码",
    "createTitle": "新建优惠码",
    "editTitle": "编辑优惠码",
    "edit": "编辑",
    "empty": "还没有优惠码",
    "created": "优惠码已创建",
    "updated": "优惠码已保存",
    "submit": "保存",
    "cancel": "取消",
    "col": {
      "code": "优惠码",
      "discount": "优惠",
      "quota": "已占用 / 次数",
      "minRunners": "最少人数",
      "validity": "有效期",
      "status": "状态",
      "actions": "操作"
    },
    "discountType": { "PERCENT": "按百分比", "AMOUNT": "固定金额", "WAIVER": "免单" },
    "status": { "ACTIVE": "启用", "DISABLED": "停用" },
    "form": {
      "code": "优惠码",
      "codeHelp": "3–32 位字母、数字、下划线或连字符，自动转为大写，保存后不能修改",
      "discountType": "优惠方式",
      "discountValue": "优惠值",
      "percentInvalid": "请输入 1 到 100 的整数",
      "amountInvalid": "请输入大于 0 的金额，例如 5 或 5.50",
      "quota": "可用次数",
      "minRunners": "最少参赛人数",
      "minRunnersHelp": "留空表示不限",
      "validFrom": "生效时间",
      "validUntil": "失效时间",
      "status": "状态"
    }
  }
```

`packages/i18n/locales/en/admin.json`：`"tabCoupons": "Coupons",`；顶层追加：

```json
  "coupons": {
    "hint": "Coupons created here only work for this event.",
    "create": "New coupon",
    "createTitle": "New coupon",
    "editTitle": "Edit coupon",
    "edit": "Edit",
    "empty": "No coupons yet",
    "created": "Coupon created",
    "updated": "Coupon saved",
    "submit": "Save",
    "cancel": "Cancel",
    "col": {
      "code": "Code",
      "discount": "Discount",
      "quota": "Taken / uses",
      "minRunners": "Min. runners",
      "validity": "Valid",
      "status": "Status",
      "actions": "Actions"
    },
    "discountType": { "PERCENT": "Percentage", "AMOUNT": "Fixed amount", "WAIVER": "Free entry" },
    "status": { "ACTIVE": "Active", "DISABLED": "Disabled" },
    "form": {
      "code": "Code",
      "codeHelp": "3–32 letters, digits, underscores or hyphens. Saved in uppercase and can't be changed later",
      "discountType": "Discount type",
      "discountValue": "Discount value",
      "percentInvalid": "Enter a whole number from 1 to 100",
      "amountInvalid": "Enter an amount above 0, such as 5 or 5.50",
      "quota": "Number of uses",
      "minRunners": "Minimum runners",
      "minRunnersHelp": "Leave empty for no minimum",
      "validFrom": "Valid from",
      "validUntil": "Valid until",
      "status": "Status"
    }
  }
```

`packages/i18n/locales/km/admin.json`：`"tabCoupons": "លេខកូដបញ្ចុះតម្លៃ",`；顶层追加：

```json
  "coupons": {
    "hint": "លេខកូដដែលបង្កើតនៅទីនេះ ប្រើបានតែសម្រាប់ព្រឹត្តិការណ៍នេះប៉ុណ្ណោះ។",
    "create": "បង្កើតលេខកូដ",
    "createTitle": "បង្កើតលេខកូដបញ្ចុះតម្លៃ",
    "editTitle": "កែលេខកូដបញ្ចុះតម្លៃ",
    "edit": "កែ",
    "empty": "មិនទាន់មានលេខកូដបញ្ចុះតម្លៃទេ",
    "created": "បានបង្កើតលេខកូដបញ្ចុះតម្លៃ",
    "updated": "បានរក្សាទុកលេខកូដបញ្ចុះតម្លៃ",
    "submit": "រក្សាទុក",
    "cancel": "បោះបង់",
    "col": {
      "code": "លេខកូដ",
      "discount": "ការបញ្ចុះតម្លៃ",
      "quota": "បានប្រើ / ចំនួនដង",
      "minRunners": "អ្នករត់អប្បបរមា",
      "validity": "សុពលភាព",
      "status": "ស្ថានភាព",
      "actions": "សកម្មភាព"
    },
    "discountType": { "PERCENT": "ភាគរយ", "AMOUNT": "ចំនួនថេរ", "WAIVER": "ឥតគិតថ្លៃ" },
    "status": { "ACTIVE": "កំពុងប្រើ", "DISABLED": "បានបិទ" },
    "form": {
      "code": "លេខកូដ",
      "codeHelp": "អក្សរ លេខ សញ្ញា _ ឬ - ចំនួន 3–32 តួ។ រក្សាទុកជាអក្សរធំ ហើយមិនអាចកែបានទេ",
      "discountType": "ប្រភេទបញ្ចុះតម្លៃ",
      "discountValue": "តម្លៃបញ្ចុះ",
      "percentInvalid": "សូមបញ្ចូលចំនួនគត់ពី 1 ដល់ 100",
      "amountInvalid": "សូមបញ្ចូលចំនួនទឹកប្រាក់ធំជាង 0 ឧទាហរណ៍ 5 ឬ 5.50",
      "quota": "ចំនួនដងដែលអាចប្រើ",
      "minRunners": "ចំនួនអ្នករត់អប្បបរមា",
      "minRunnersHelp": "ទុកទទេ ប្រសិនបើគ្មានកំណត់",
      "validFrom": "មានសុពលភាពចាប់ពី",
      "validUntil": "មានសុពលភាពរហូតដល់",
      "status": "ស្ថានភាព"
    }
  }
```

Run: `pnpm --filter @werun/admin test`
Expected: PASS；`couponForm.test.ts` 15 个、`CouponsTab.test.tsx` 5 个用例通过，其余测试不回归。

- [ ] **Step 9: 全量检查**

Run（colima 环境变量同 Step 1）：

```bash
make gen && git status --porcelain
cd api && go test ./... && go tool golangci-lint run ./...
pnpm typecheck && pnpm lint && pnpm test && pnpm i18n:check
```

Expected：生成代码无额外变化；后端测试与 lint 通过；前端全部通过，`i18n 检查通过`。

- [ ] **Step 10: 提交**

```bash
git add api/internal/pricing api/db/queries/pricing.sql \
  api/openapi/openapi.yaml api/internal/httpapi/apigen packages/api-client/src/schema.d.ts \
  api/internal/httpapi/coupons_http_test.go \
  api/internal/platform/apperr api/internal/platform/i18n \
  web/admin/src/coupons web/admin/src/pages/EventDetailPage.tsx web/admin/src/test/fixtures.ts \
  packages/i18n/locales/zh/admin.json packages/i18n/locales/en/admin.json packages/i18n/locales/km/admin.json
git commit -m "$(cat <<'EOF'
feat: add coupon management for events

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
)"
```

---
### Task 6: 收款账户

**Files:**
- Create: `api/internal/payment/model.go`、`service.go`、`accounts.go`、`files.go`、`handlers.go`
- Create: `api/db/queries/payment.sql`；Modify: `api/sqlc.yaml`；Generate: `api/internal/payment/store/`
- Test: `api/internal/payment/accounts_test.go`、`api/internal/httpapi/payment_accounts_http_test.go`
- Modify: `api/openapi/openapi.yaml`；Generate: `api/internal/httpapi/apigen/*`、`packages/api-client/src/schema.d.ts`
- Modify: `api/internal/httpapi/server.go`、`router.go`、`events_http_test.go`；`api/cmd/werun/app.go`、`router.go`
- Create: `web/admin/src/payments/queries.ts`、`web/admin/src/payments/accountForm.ts`、`web/admin/src/payments/accountForm.test.ts`、`web/admin/src/pages/PaymentAccountsPage.tsx`、`web/admin/src/pages/PaymentAccountsPage.test.tsx`
- Modify: `web/admin/src/routes.tsx`、`web/admin/src/layout/AppLayout.tsx`、`web/admin/src/test/fixtures.ts`、`packages/i18n/locales/{zh,en,km}/admin.json`

**Interfaces:**
- Consumes：Task 1 的 `storage.Store / ReadImage / NewKey / InsertFile / GetFile / ErrNotFound / MaxQRBytes / VisibilityPublic / PurposePaymentQR`、`App.Store`；`db.InTx`、`audit.Record`、`iam.StaffFrom`、`httpx.Gin / MetaOf`；前端 `useAdminEvents`、`pickText`、`toNamePath`、`setupFormUser / fillField / replaceField`
- Produces（契约 §3；本任务按调度要求使用不含 `orders` 的签名，Task 15 追加 `orders *registration.Service` 参数，Task 20 追加 `notifier`）：

```go
type AccountInput struct {
	Name, Provider, AccountName, AccountNoMasked string // Provider: ABA | ACLEDA | WING | BAKONG | OTHER
	Scope   string // REGISTRATION | MERCH | ALL
	EventID *int64
	Active  bool
}
type Account struct { ID int64; Input AccountInput; Currency string; QRFileID int64; CreatedAt time.Time }
func NewService(pool *pgxpool.Pool, files storage.Store, now func() time.Time) *Service
func (s *Service) ListAccounts(ctx context.Context) ([]Account, error)
func (s *Service) CreateAccount(ctx context.Context, actor iam.Staff, in AccountInput, qr io.Reader) (Account, error) // qr 必填
func (s *Service) UpdateAccount(ctx context.Context, actor iam.Staff, id int64, in AccountInput, qr io.Reader) (Account, error) // qr 为 nil 时不换
func (s *Service) OpenPublicFile(ctx context.Context, id int64) (storage.File, io.ReadCloser, error)  // 非 PUBLIC 返回 NOT_FOUND
func (s *Service) OpenPrivateFile(ctx context.Context, id int64) (storage.File, io.ReadCloser, error)
```

  - 本任务另外导出：`payment.ValidateAccount(in AccountInput) error`、`payment.NewHandlers(svc *Service) *Handlers`、常量 `payment.ScopeRegistration / ScopeMerch / ScopeAll`
  - OpenAPI：`adminListPaymentAccounts`、`adminCreatePaymentAccount`（multipart）、`adminUpdatePaymentAccount`（multipart）、`getPublicFile`（`GET /files/{id}`，`image/*` 二进制）；schema `PaymentProvider`、`PaymentAccountScope`、`PaymentAccount`、`PaymentAccountList`
  - 审计 `payment_account.create` / `payment_account.update`（entity `payment_account`，`IsFinancial=true`，`EventID` 为绑定赛事，可为 nil）
  - `httpapi.RouterDeps.Payment *payment.Service`、`type httpapi.PaymentHandlers = payment.Handlers`、`App.Payment *payment.Service`
  - 后台：路由 `/payment-accounts`（`payment_account_manage` read）、菜单项；testid `payment-account-create`、表单 `name="paymentAccount"`（字段 `name`、`provider`、`accountName`、`accountNoMasked`、`scope`、`eventId`、`active`）、`payment-account-qr-input`、`payment-account-submit`、行 `payment-account-row-<id>`；另加编辑按钮 `payment-account-edit-<id>`

**规则：** 币种恒为 `USD`；二维码 ≤ 2 MB，按内容识别 JPEG/PNG/WebP；存储为 `files`（`PUBLIC`、`PAYMENT_QR`、`uploaded_by_type='STAFF'`）；先写存储再开事务，事务失败时尽力删除刚写入的文件（删除失败只记日志）；换二维码时新建 `files` 行，旧行与旧文件保留；`OpenPrivateFile` 供后台使用，不区分可见性。

- [ ] **Step 1: 写服务的失败测试（数据库）**

创建 `api/internal/payment/accounts_test.go`：

```go
package payment_test

import (
	"bytes"
	"context"
	"image"
	"image/png"
	"io"
	"io/fs"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/event"
	"werun/api/internal/iam"
	"werun/api/internal/payment"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/storage"
)

func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, w, h))))
	return buf.Bytes()
}

func fieldKeys(t *testing.T, err error) map[string]string {
	t.Helper()
	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	out := make(map[string]string, len(ae.Fields))
	for field, fe := range ae.Fields {
		out[field] = fe.Key
	}
	return out
}

type accountsFixture struct {
	svc   *payment.Service
	pool  *pgxpool.Pool
	disk  *storage.Disk
	root  string
	actor iam.Staff
	event event.Event
}

func newAccountsFixture(t *testing.T) accountsFixture {
	t.Helper()
	ctx := context.Background()
	pool := dbtest.NewPool(t)
	root := t.TempDir()
	disk, err := storage.NewDisk(root)
	require.NoError(t, err)
	iamSvc := iam.NewService(pool, []byte(strings.Repeat("s", 32)), iam.NewLoginLimiter(time.Now), time.Now)
	actor, err := iamSvc.CreateStaff(ctx, "finance.accounts", "Finance Accounts", iam.RoleFinance, "Correct-Horse-Battery-9")
	require.NoError(t, err)
	ev, err := event.NewService(pool).Create(ctx, actor, event.CreateInput{
		Slug: "pphm-2026", EventType: event.TypeRace, OrganizerType: event.OrganizerOfficial,
		Name: i18n.Text{i18n.ZH: "金边半马", i18n.EN: "PP Half", i18n.KM: "ពាក់កណ្ដាលម៉ារ៉ាតុង"},
		City: "Phnom Penh", RaceDate: time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC),
	})
	require.NoError(t, err)
	now := func() time.Time { return time.Date(2026, 9, 14, 3, 0, 0, 0, time.UTC) }
	return accountsFixture{svc: payment.NewService(pool, disk, now), pool: pool, disk: disk, root: root, actor: actor, event: ev}
}

func (f accountsFixture) count(t *testing.T, sql string, args ...any) int {
	t.Helper()
	var n int
	require.NoError(t, f.pool.QueryRow(context.Background(), sql, args...).Scan(&n))
	return n
}

// storedFiles 统计存储根目录下的普通文件数。
func (f accountsFixture) storedFiles(t *testing.T) int {
	t.Helper()
	n := 0
	require.NoError(t, filepath.WalkDir(f.root, func(_ string, d fs.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() {
			n++
		}
		return err
	}))
	return n
}

func validAccount(eventID *int64) payment.AccountInput {
	return payment.AccountInput{
		Name:            " ABA USD 主收款户 ",
		Provider:        "ABA",
		AccountName:     "WERUN SPORTS CO LTD",
		AccountNoMasked: "*** *** 123",
		Scope:           payment.ScopeRegistration,
		EventID:         eventID,
		Active:          true,
	}
}

func TestValidateAccount(t *testing.T) {
	require.NoError(t, payment.ValidateAccount(validAccount(nil)))

	cases := []struct {
		name   string
		mutate func(in *payment.AccountInput)
		field  string
		key    string
	}{
		{"名称为空", func(in *payment.AccountInput) { in.Name = "  " }, "name", "field.required"},
		{"名称过长", func(in *payment.AccountInput) { in.Name = strings.Repeat("a", 81) }, "name", "field.too_long"},
		{"渠道不在枚举内", func(in *payment.AccountInput) { in.Provider = "PAYPAL" }, "provider", "field.invalid"},
		{"户名为空", func(in *payment.AccountInput) { in.AccountName = "" }, "accountName", "field.required"},
		{"尾号过长", func(in *payment.AccountInput) { in.AccountNoMasked = strings.Repeat("*", 33) }, "accountNoMasked", "field.too_long"},
		{"范围不在枚举内", func(in *payment.AccountInput) { in.Scope = "DONATION" }, "scope", "field.invalid"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := validAccount(nil)
			tc.mutate(&in)
			require.Equal(t, tc.key, fieldKeys(t, payment.ValidateAccount(in))[tc.field])
		})
	}
}

func TestCreateAccountStoresPublicQRAndAudits(t *testing.T) {
	f := newAccountsFixture(t)
	ctx := context.Background()
	qr := pngBytes(t, 4, 4)

	acc, err := f.svc.CreateAccount(ctx, f.actor, validAccount(&f.event.ID), bytes.NewReader(qr))

	require.NoError(t, err)
	assert.NotZero(t, acc.ID)
	assert.Equal(t, "ABA USD 主收款户", acc.Input.Name, "去掉首尾空白")
	assert.Equal(t, "USD", acc.Currency)
	assert.Equal(t, f.event.ID, *acc.Input.EventID)
	assert.True(t, acc.Input.Active)
	assert.False(t, acc.CreatedAt.IsZero())
	assert.Equal(t, 1, f.count(t,
		`SELECT count(*) FROM files WHERE id = $1 AND visibility = 'PUBLIC' AND purpose = 'PAYMENT_QR'
		   AND uploaded_by_type = 'STAFF' AND uploaded_by_id = $2 AND mime_type = 'image/png'
		   AND storage_key LIKE '2026/09/%.png'`, acc.QRFileID, f.actor.ID))
	assert.Equal(t, 1, f.count(t,
		`SELECT count(*) FROM audit_logs WHERE action = 'payment_account.create' AND entity_type = 'payment_account'
		   AND entity_id = $1 AND event_id = $2 AND is_financial`, acc.ID, f.event.ID))

	file, rc, err := f.svc.OpenPublicFile(ctx, acc.QRFileID)
	require.NoError(t, err)
	body, err := io.ReadAll(rc)
	require.NoError(t, err)
	require.NoError(t, rc.Close())
	assert.Equal(t, qr, body)
	assert.Equal(t, "image/png", file.MIME)
	assert.Equal(t, int64(len(qr)), file.SizeBytes)

	list, err := f.svc.ListAccounts(ctx)
	require.NoError(t, err)
	require.Len(t, list, 1)
	assert.Equal(t, acc.ID, list[0].ID)
}

func TestCreateAccountRejectsBadInputWithoutLeavingFiles(t *testing.T) {
	f := newAccountsFixture(t)
	ctx := context.Background()

	_, err := f.svc.CreateAccount(ctx, f.actor, validAccount(nil), nil)
	assert.Equal(t, "field.required", fieldKeys(t, err)["qr"])

	_, err = f.svc.CreateAccount(ctx, f.actor, validAccount(nil), strings.NewReader("definitely not an image"))
	ae, ok := apperr.As(err)
	require.True(t, ok)
	assert.Equal(t, apperr.CodeFileTypeNotAllowed, ae.Code)

	tooBig := append(pngBytes(t, 2, 2), make([]byte, storage.MaxQRBytes)...)
	_, err = f.svc.CreateAccount(ctx, f.actor, validAccount(nil), bytes.NewReader(tooBig))
	ae, ok = apperr.As(err)
	require.True(t, ok)
	assert.Equal(t, apperr.CodeFileTooLarge, ae.Code)
	assert.Equal(t, http.StatusRequestEntityTooLarge, ae.Status)

	missing := int64(999999)
	_, err = f.svc.CreateAccount(ctx, f.actor, validAccount(&missing), bytes.NewReader(pngBytes(t, 2, 2)))
	assert.Equal(t, "field.invalid", fieldKeys(t, err)["eventId"])

	assert.Equal(t, 0, f.count(t, `SELECT count(*) FROM payment_accounts`))
	assert.Equal(t, 0, f.count(t, `SELECT count(*) FROM files`))
	assert.Equal(t, 0, f.storedFiles(t), "事务失败后删除已写入存储的文件")
}

func TestUpdateAccountKeepsOrReplacesQR(t *testing.T) {
	f := newAccountsFixture(t)
	ctx := context.Background()
	acc, err := f.svc.CreateAccount(ctx, f.actor, validAccount(nil), bytes.NewReader(pngBytes(t, 4, 4)))
	require.NoError(t, err)

	renamed := validAccount(&f.event.ID)
	renamed.Name = "ABA USD 备用"
	renamed.Active = false
	renamed.Scope = payment.ScopeAll
	kept, err := f.svc.UpdateAccount(ctx, f.actor, acc.ID, renamed, nil)
	require.NoError(t, err)
	assert.Equal(t, acc.QRFileID, kept.QRFileID)
	assert.Equal(t, "ABA USD 备用", kept.Input.Name)
	assert.False(t, kept.Input.Active)
	assert.Equal(t, payment.ScopeAll, kept.Input.Scope)

	replaced, err := f.svc.UpdateAccount(ctx, f.actor, acc.ID, renamed, bytes.NewReader(pngBytes(t, 8, 8)))
	require.NoError(t, err)
	assert.NotEqual(t, acc.QRFileID, replaced.QRFileID)
	assert.Equal(t, 2, f.count(t, `SELECT count(*) FROM files WHERE purpose = 'PAYMENT_QR'`), "旧二维码文件行保留")
	assert.Equal(t, 2, f.storedFiles(t))
	_, oldRC, err := f.svc.OpenPublicFile(ctx, acc.QRFileID)
	require.NoError(t, err)
	require.NoError(t, oldRC.Close())
	assert.Equal(t, 2, f.count(t,
		`SELECT count(*) FROM audit_logs WHERE action = 'payment_account.update' AND entity_id = $1 AND is_financial`, acc.ID))
	assert.Equal(t, 1, f.count(t,
		`SELECT count(*) FROM audit_logs WHERE action = 'payment_account.update'
		   AND before_data->>'active' = 'true' AND after_data->>'active' = 'false'`))

	_, err = f.svc.UpdateAccount(ctx, f.actor, 999999, renamed, bytes.NewReader(pngBytes(t, 2, 2)))
	ae, ok := apperr.As(err)
	require.True(t, ok)
	assert.Equal(t, apperr.CodeNotFound, ae.Code)
	assert.Equal(t, 2, f.storedFiles(t), "失败的更新不留下新文件")
}

func TestOpenFilesByVisibility(t *testing.T) {
	f := newAccountsFixture(t)
	ctx := context.Background()
	require.NoError(t, f.disk.Put(ctx, "2026/09/private.png", bytes.NewReader([]byte("proof"))))
	var privateID, danglingID int64
	require.NoError(t, f.pool.QueryRow(ctx,
		`INSERT INTO files (storage_key, visibility, purpose, mime_type, size_bytes, sha256, uploaded_by_type)
		 VALUES ('2026/09/private.png', 'PRIVATE', 'PAYMENT_PROOF', 'image/png', 5, '\x01', 'USER') RETURNING id`).Scan(&privateID))
	require.NoError(t, f.pool.QueryRow(ctx,
		`INSERT INTO files (storage_key, visibility, purpose, mime_type, size_bytes, sha256, uploaded_by_type)
		 VALUES ('2026/09/gone.png', 'PUBLIC', 'PAYMENT_QR', 'image/png', 5, '\x02', 'STAFF') RETURNING id`).Scan(&danglingID))

	notFound := func(err error) {
		t.Helper()
		ae, ok := apperr.As(err)
		require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
		assert.Equal(t, apperr.CodeNotFound, ae.Code)
	}

	_, _, err := f.svc.OpenPublicFile(ctx, privateID)
	notFound(err)
	_, _, err = f.svc.OpenPublicFile(ctx, 999999)
	notFound(err)
	_, _, err = f.svc.OpenPublicFile(ctx, danglingID)
	notFound(err)

	file, rc, err := f.svc.OpenPrivateFile(ctx, privateID)
	require.NoError(t, err)
	defer rc.Close()
	body, err := io.ReadAll(rc)
	require.NoError(t, err)
	assert.Equal(t, "proof", string(body))
	assert.Equal(t, "PRIVATE", file.Visibility)
}
```

Run（数据库测试需要 Docker；本机为 colima 时先 `export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true`）：
`cd api && go test ./internal/payment/`
Expected: 编译失败，`no non-test Go files in .../internal/payment`。

- [ ] **Step 2: 查询与 sqlc**

创建 `api/db/queries/payment.sql`：

```sql
-- name: EventExists :one
SELECT EXISTS (SELECT 1 FROM events WHERE id = @id);

-- name: InsertPaymentAccount :one
INSERT INTO payment_accounts (name, provider, account_name, account_no_masked, currency, qr_file_id,
                              scope, event_id, active, created_by)
VALUES (@name, @provider, @account_name, @account_no_masked, 'USD', @qr_file_id,
        @scope, sqlc.narg(event_id), @active, @created_by)
RETURNING *;

-- name: GetPaymentAccountForUpdate :one
SELECT * FROM payment_accounts
WHERE id = @id
FOR UPDATE;

-- name: UpdatePaymentAccount :one
UPDATE payment_accounts
SET name = @name,
    provider = @provider,
    account_name = @account_name,
    account_no_masked = @account_no_masked,
    currency = 'USD',
    qr_file_id = @qr_file_id,
    scope = @scope,
    event_id = sqlc.narg(event_id),
    active = @active
WHERE id = @id
RETURNING *;

-- name: ListPaymentAccounts :many
SELECT * FROM payment_accounts
ORDER BY active DESC, id;
```

`api/sqlc.yaml` 末尾追加 payment 块（与 pricing 块逐字相同，只改 `queries: db/queries/payment.sql` 与 `out: internal/payment/store`）：

```yaml
  - engine: postgresql
    schema: db/migrations
    queries: db/queries/payment.sql
    gen:
      go:
        package: store
        out: internal/payment/store
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

Run: `cd api && go tool sqlc generate`
Expected: 生成 `api/internal/payment/store/`；`InsertPaymentAccountParams{Name, Provider, AccountName, AccountNoMasked string; QrFileID int64; Scope string; EventID *int64; Active bool; CreatedBy *int64}`，`UpdatePaymentAccountParams` 另含 `ID`、不含 `CreatedBy`。

- [ ] **Step 3: 实现 payment 服务**

创建 `api/internal/payment/model.go`：

```go
// Package payment 是收款模块：收款账户、文件读取，以及凭证上传与审核（Task 15 起）。
package payment

import "time"

// payment_accounts.provider 与 scope 的取值。
const (
	ProviderABA    = "ABA"
	ProviderACLEDA = "ACLEDA"
	ProviderWing   = "WING"
	ProviderBakong = "BAKONG"
	ProviderOther  = "OTHER"

	ScopeRegistration = "REGISTRATION"
	ScopeMerch        = "MERCH"
	ScopeAll          = "ALL"
)

// AccountInput 是后台新建或修改收款账户的输入。币种恒为 USD，不由输入决定。
type AccountInput struct {
	Name, Provider, AccountName, AccountNoMasked string
	Scope                                        string
	EventID                                      *int64 // nil = 全局
	Active                                       bool
}

// Account 是收款账户。
type Account struct {
	ID        int64
	Input     AccountInput
	Currency  string
	QRFileID  int64
	CreatedAt time.Time
}
```

创建 `api/internal/payment/service.go`：

```go
package payment

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"werun/api/internal/audit"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/storage"
)

// Service 是收款模块的业务入口。
type Service struct {
	pool  *pgxpool.Pool
	files storage.Store
	now   func() time.Time
}

// NewService 创建服务。Task 15 追加 orders 参数，Task 20 追加 notifier 参数。
func NewService(pool *pgxpool.Pool, files storage.Store, now func() time.Time) *Service {
	return &Service{pool: pool, files: files, now: now}
}

func validationError() *apperr.Error {
	return apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)
}

// discardFile 在事务失败后尽力删除已写入存储的文件；失败只记日志。
func (s *Service) discardFile(ctx context.Context, key string) {
	if err := s.files.Delete(context.WithoutCancel(ctx), key); err != nil {
		slog.WarnContext(ctx, "discard uploaded file failed", "storage_key", key, "error", err)
	}
}

func staffEntry(ctx context.Context, actor iam.Staff, action string, entityID int64, eventID *int64, summary string, before, after any) audit.Entry {
	actorID := actor.ID
	role := string(actor.Role)
	return audit.Entry{
		ActorType:   "STAFF",
		ActorID:     &actorID,
		ActorRole:   &role,
		Action:      action,
		EntityType:  "payment_account",
		EntityID:    entityID,
		EventID:     eventID,
		IsFinancial: true,
		Summary:     summary,
		Before:      before,
		After:       after,
		Meta:        httpx.MetaOf(ctx),
	}
}
```

创建 `api/internal/payment/accounts.go`：

```go
package payment

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/audit"
	"werun/api/internal/iam"
	"werun/api/internal/payment/store"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/storage"
)

const (
	accountTextMaxLen     = 80
	accountNoMaskedMaxLen = 32
)

var (
	providers = []string{ProviderABA, ProviderACLEDA, ProviderWing, ProviderBakong, ProviderOther}
	scopes    = []string{ScopeRegistration, ScopeMerch, ScopeAll}
)

// ValidateAccount 校验收款账户输入（文本应已去掉首尾空白），一次返回全部字段错误。
func ValidateAccount(in AccountInput) error {
	if verr := validateAccount(in, false); verr != nil {
		return verr
	}
	return nil
}

func validateAccount(in AccountInput, qrMissing bool) *apperr.Error {
	verr := validationError()
	failed := false
	add := func(field, key string, params map[string]any) {
		verr = verr.WithField(field, key, params)
		failed = true
	}
	text := func(field, value string, maxLen int) {
		switch {
		case value == "":
			add(field, "field.required", nil)
		case utf8.RuneCountInString(value) > maxLen:
			add(field, "field.too_long", map[string]any{"max": maxLen})
		}
	}

	text("name", in.Name, accountTextMaxLen)
	text("accountName", in.AccountName, accountTextMaxLen)
	text("accountNoMasked", in.AccountNoMasked, accountNoMaskedMaxLen)
	if !slices.Contains(providers, in.Provider) {
		add("provider", "field.invalid", nil)
	}
	if !slices.Contains(scopes, in.Scope) {
		add("scope", "field.invalid", nil)
	}
	if qrMissing {
		add("qr", "field.required", nil)
	}
	if failed {
		return verr
	}
	return nil
}

func normalizeAccount(in AccountInput) AccountInput {
	in.Name = strings.TrimSpace(in.Name)
	in.Provider = strings.TrimSpace(in.Provider)
	in.AccountName = strings.TrimSpace(in.AccountName)
	in.AccountNoMasked = strings.TrimSpace(in.AccountNoMasked)
	in.Scope = strings.TrimSpace(in.Scope)
	return in
}

// ListAccounts 返回全部收款账户，启用的在前。
func (s *Service) ListAccounts(ctx context.Context) ([]Account, error) {
	rows, err := store.New(s.pool).ListPaymentAccounts(ctx)
	if err != nil {
		return nil, fmt.Errorf("list payment accounts: %w", err)
	}
	out := make([]Account, 0, len(rows))
	for _, r := range rows {
		out = append(out, accountFromRow(r))
	}
	return out, nil
}

// CreateAccount 保存二维码并新建收款账户，写审计 payment_account.create。
func (s *Service) CreateAccount(ctx context.Context, actor iam.Staff, in AccountInput, qr io.Reader) (Account, error) {
	in = normalizeAccount(in)
	if verr := validateAccount(in, qr == nil); verr != nil {
		return Account{}, verr
	}
	img, key, err := s.storeQR(ctx, qr)
	if err != nil {
		return Account{}, err
	}

	var out Account
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		if err := requireAccountEvent(ctx, q, in.EventID); err != nil {
			return err
		}
		fileID, err := storage.InsertFile(ctx, tx, qrRecord(key, img, actor))
		if err != nil {
			return err
		}
		actorID := actor.ID
		row, err := q.InsertPaymentAccount(ctx, store.InsertPaymentAccountParams{
			Name:            in.Name,
			Provider:        in.Provider,
			AccountName:     in.AccountName,
			AccountNoMasked: in.AccountNoMasked,
			QrFileID:        fileID,
			Scope:           in.Scope,
			EventID:         in.EventID,
			Active:          in.Active,
			CreatedBy:       &actorID,
		})
		if err != nil {
			return fmt.Errorf("insert payment account: %w", err)
		}
		out = accountFromRow(row)
		return audit.Record(ctx, tx, staffEntry(ctx, actor, "payment_account.create", out.ID, out.Input.EventID,
			fmt.Sprintf("新建收款账户 %s（%s %s）", out.Input.Name, out.Input.Provider, out.Input.AccountNoMasked),
			nil, accountSnapshot(out)))
	})
	if err != nil {
		s.discardFile(ctx, key)
		return Account{}, err
	}
	return out, nil
}

// UpdateAccount 修改收款账户；qr 非 nil 时新建二维码文件行（旧文件保留），写审计 payment_account.update。
func (s *Service) UpdateAccount(ctx context.Context, actor iam.Staff, id int64, in AccountInput, qr io.Reader) (Account, error) {
	in = normalizeAccount(in)
	if verr := validateAccount(in, false); verr != nil {
		return Account{}, verr
	}
	var img storage.Image
	var key string
	if qr != nil {
		var err error
		if img, key, err = s.storeQR(ctx, qr); err != nil {
			return Account{}, err
		}
	}

	var out Account
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		row, err := q.GetPaymentAccountForUpdate(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeNotFound)
		}
		if err != nil {
			return fmt.Errorf("lock payment account %d: %w", id, err)
		}
		before := accountFromRow(row)
		if err := requireAccountEvent(ctx, q, in.EventID); err != nil {
			return err
		}
		qrFileID := row.QrFileID
		if key != "" {
			if qrFileID, err = storage.InsertFile(ctx, tx, qrRecord(key, img, actor)); err != nil {
				return err
			}
		}
		updated, err := q.UpdatePaymentAccount(ctx, store.UpdatePaymentAccountParams{
			Name:            in.Name,
			Provider:        in.Provider,
			AccountName:     in.AccountName,
			AccountNoMasked: in.AccountNoMasked,
			QrFileID:        qrFileID,
			Scope:           in.Scope,
			EventID:         in.EventID,
			Active:          in.Active,
			ID:              id,
		})
		if err != nil {
			return fmt.Errorf("update payment account %d: %w", id, err)
		}
		out = accountFromRow(updated)
		return audit.Record(ctx, tx, staffEntry(ctx, actor, "payment_account.update", out.ID, out.Input.EventID,
			fmt.Sprintf("修改收款账户 %s", out.Input.Name), accountSnapshot(before), accountSnapshot(out)))
	})
	if err != nil {
		if key != "" {
			s.discardFile(ctx, key)
		}
		return Account{}, err
	}
	return out, nil
}

// storeQR 校验二维码图片并写入存储，返回图片与存储键。
func (s *Service) storeQR(ctx context.Context, qr io.Reader) (storage.Image, string, error) {
	img, err := storage.ReadImage(qr, storage.MaxQRBytes)
	if err != nil {
		return storage.Image{}, "", err
	}
	key := storage.NewKey(s.now(), img.Ext)
	if err := s.files.Put(ctx, key, bytes.NewReader(img.Data)); err != nil {
		return storage.Image{}, "", fmt.Errorf("store payment qr: %w", err)
	}
	return img, key, nil
}

func qrRecord(key string, img storage.Image, actor iam.Staff) storage.FileRecord {
	return storage.FileRecord{
		StorageKey:     key,
		Visibility:     storage.VisibilityPublic,
		Purpose:        storage.PurposePaymentQR,
		Image:          img,
		UploadedByType: "STAFF",
		UploadedByID:   actor.ID,
	}
}

func requireAccountEvent(ctx context.Context, q *store.Queries, eventID *int64) error {
	if eventID == nil {
		return nil
	}
	exists, err := q.EventExists(ctx, *eventID)
	if err != nil {
		return fmt.Errorf("check event %d: %w", *eventID, err)
	}
	if !exists {
		return validationError().WithField("eventId", "field.invalid", nil)
	}
	return nil
}

func accountFromRow(r store.PaymentAccount) Account {
	return Account{
		ID: r.ID,
		Input: AccountInput{
			Name:            r.Name,
			Provider:        r.Provider,
			AccountName:     r.AccountName,
			AccountNoMasked: r.AccountNoMasked,
			Scope:           r.Scope,
			EventID:         r.EventID,
			Active:          r.Active,
		},
		Currency:  r.Currency,
		QRFileID:  r.QrFileID,
		CreatedAt: r.CreatedAt,
	}
}

func accountSnapshot(a Account) map[string]any {
	return map[string]any{
		"name":            a.Input.Name,
		"provider":        a.Input.Provider,
		"accountName":     a.Input.AccountName,
		"accountNoMasked": a.Input.AccountNoMasked,
		"scope":           a.Input.Scope,
		"eventId":         a.Input.EventID,
		"active":          a.Input.Active,
		"currency":        a.Currency,
		"qrFileId":        a.QRFileID,
	}
}
```

创建 `api/internal/payment/files.go`：

```go
package payment

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/storage"
)

// OpenPublicFile 打开 PUBLIC 文件（收款二维码）；私有、不存在或存储里缺失都返回 NOT_FOUND。调用方负责关闭。
func (s *Service) OpenPublicFile(ctx context.Context, id int64) (storage.File, io.ReadCloser, error) {
	file, err := storage.GetFile(ctx, s.pool, id)
	if err != nil {
		return storage.File{}, nil, err
	}
	if file.Visibility != storage.VisibilityPublic {
		return storage.File{}, nil, apperr.New(http.StatusNotFound, apperr.CodeNotFound)
	}
	return s.open(ctx, file)
}

// OpenPrivateFile 供后台（已鉴权的员工接口）打开任意可见性的文件。调用方负责关闭。
func (s *Service) OpenPrivateFile(ctx context.Context, id int64) (storage.File, io.ReadCloser, error) {
	file, err := storage.GetFile(ctx, s.pool, id)
	if err != nil {
		return storage.File{}, nil, err
	}
	return s.open(ctx, file)
}

func (s *Service) open(ctx context.Context, file storage.File) (storage.File, io.ReadCloser, error) {
	rc, err := s.files.Open(ctx, file.StorageKey)
	if errors.Is(err, storage.ErrNotFound) {
		return storage.File{}, nil, apperr.New(http.StatusNotFound, apperr.CodeNotFound).Wrap(err)
	}
	if err != nil {
		return storage.File{}, nil, fmt.Errorf("open file %d: %w", file.ID, err)
	}
	return file, rc, nil
}
```

Run（colima 环境变量同 Step 1）：`cd api && go test ./internal/payment/ -v`
Expected: `TestValidateAccount`（6 个子测试）、`TestCreateAccountStoresPublicQRAndAudits`、`TestCreateAccountRejectsBadInputWithoutLeavingFiles`、`TestUpdateAccountKeepsOrReplacesQR`、`TestOpenFilesByVisibility` 全部 PASS。

- [ ] **Step 4: OpenAPI 与生成代码**

`api/openapi/openapi.yaml` 的 `paths` 末尾追加：

```yaml
  /files/{id}:
    get:
      operationId: getPublicFile
      summary: 公开文件（收款二维码）；私有或不存在返回 404；响应头 Cache-Control public, max-age=86400
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: integer
            format: int64
      responses:
        '200':
          description: 图片内容
          content:
            image/*:
              schema:
                type: string
                format: binary
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
  /admin/payment-accounts:
    get:
      operationId: adminListPaymentAccounts
      summary: 收款账户列表
      x-permission: payment_account_manage
      x-access: read
      responses:
        '200':
          description: 收款账户列表
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/PaymentAccountList'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
    post:
      operationId: adminCreatePaymentAccount
      summary: 新建收款账户（上传二维码，币种固定 USD）
      x-permission: payment_account_manage
      x-access: write
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema:
              type: object
              required: [name, provider, accountName, accountNoMasked, scope, active, qr]
              properties:
                name:
                  type: string
                provider:
                  $ref: '#/components/schemas/PaymentProvider'
                accountName:
                  type: string
                accountNoMasked:
                  type: string
                scope:
                  $ref: '#/components/schemas/PaymentAccountScope'
                eventId:
                  type: string
                  description: 绑定的赛事 id；空串或缺省表示全局
                active:
                  type: string
                  enum: ['true', 'false']
                qr:
                  type: string
                  format: binary
                  description: 收款二维码图片，JPEG / PNG / WebP，≤ 2 MB
      responses:
        '201':
          description: 已创建
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/PaymentAccount'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
  /admin/payment-accounts/{id}:
    put:
      operationId: adminUpdatePaymentAccount
      summary: 修改收款账户（带 qr 时更换二维码，旧文件保留）
      x-permission: payment_account_manage
      x-access: write
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
          multipart/form-data:
            schema:
              type: object
              required: [name, provider, accountName, accountNoMasked, scope, active]
              properties:
                name:
                  type: string
                provider:
                  $ref: '#/components/schemas/PaymentProvider'
                accountName:
                  type: string
                accountNoMasked:
                  type: string
                scope:
                  $ref: '#/components/schemas/PaymentAccountScope'
                eventId:
                  type: string
                  description: 绑定的赛事 id；空串或缺省表示全局
                active:
                  type: string
                  enum: ['true', 'false']
                qr:
                  type: string
                  format: binary
      responses:
        '200':
          description: 已保存
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/PaymentAccount'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
```

`components.schemas` 末尾追加：

```yaml
    PaymentProvider:
      type: string
      enum: [ABA, ACLEDA, WING, BAKONG, OTHER]
    PaymentAccountScope:
      type: string
      enum: [REGISTRATION, MERCH, ALL]
    PaymentAccount:
      type: object
      required: [id, name, provider, accountName, accountNoMasked, currency, qrFileId, scope, eventId, active, createdAt]
      properties:
        id:
          type: integer
          format: int64
        name:
          type: string
        provider:
          $ref: '#/components/schemas/PaymentProvider'
        accountName:
          type: string
        accountNoMasked:
          type: string
        currency:
          type: string
        qrFileId:
          type: integer
          format: int64
          description: 二维码地址为 /api/files/{qrFileId}
        scope:
          $ref: '#/components/schemas/PaymentAccountScope'
        eventId:
          type: integer
          format: int64
          nullable: true
        active:
          type: boolean
        createdAt:
          type: string
          format: date-time
    PaymentAccountList:
      type: object
      required: [items]
      properties:
        items:
          type: array
          items:
            $ref: '#/components/schemas/PaymentAccount'
```

Run: `make gen`
Expected: `api.gen.go` 出现 `AdminCreatePaymentAccountRequestObject{Body *multipart.Reader}`、`AdminUpdatePaymentAccountRequestObject{Id int64; Body *multipart.Reader}`、`GetPublicFile200ImageResponse{Body io.Reader; ContentType string; ContentLength int64}`、`PaymentAccount{...; QrFileId int64; ...}`；`permissions.gen.go` 增加三条 `payment_account_manage` 规则与 `"GetPublicFile": {Kind: AuthNone}`（`/files/` 不以 `/admin/` 开头，按公开接口处理）。`go build ./...` 因缺少 handler 失败。

- [ ] **Step 5: 写接口的失败测试**

`api/internal/httpapi/events_http_test.go`：import 加入 `"werun/api/internal/payment"` 与 `"werun/api/internal/platform/storage"`；`newEventsEnv` 中 `iamSvc := ...` 之后插入：

```go
	files, err := storage.NewDisk(t.TempDir())
	require.NoError(t, err)
```

`RouterDeps` 字面量中 `Pricing: pricing.NewService(pool, time.Now),` 之后加 `Payment: payment.NewService(pool, files, time.Now),`。

创建 `api/internal/httpapi/payment_accounts_http_test.go`：

```go
package httpapi_test

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
)

func testPNG(t *testing.T, size int) []byte {
	t.Helper()
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, size, size))))
	return buf.Bytes()
}

// accountForm 构造 multipart 请求体；qr 为 nil 时不带文件 part。
func accountForm(t *testing.T, fields map[string]string, qr []byte) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	for name, value := range fields {
		require.NoError(t, w.WriteField(name, value))
	}
	if qr != nil {
		part, err := w.CreateFormFile("qr", "qr.png")
		require.NoError(t, err)
		_, err = part.Write(qr)
		require.NoError(t, err)
	}
	require.NoError(t, w.Close())
	return &body, w.FormDataContentType()
}

func accountFields(eventID string) map[string]string {
	return map[string]string{
		"name":            "ABA USD 主收款户",
		"provider":        "ABA",
		"accountName":     "WERUN SPORTS CO LTD",
		"accountNoMasked": "*** 123",
		"scope":           "REGISTRATION",
		"eventId":         eventID,
		"active":          "true",
	}
}

func (e eventsEnv) doRaw(t *testing.T, method, path string, body io.Reader, contentType string, cookie *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequestWithContext(context.Background(), method, path, body)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set(httpx.HeaderClient, "admin")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	return rec
}

func TestPaymentAccountsHTTP(t *testing.T) {
	env := newEventsEnv(t)
	ops := env.sessionCookie(t, iam.RoleOps, "ops.accounthttp")
	finance := env.sessionCookie(t, iam.RoleFinance, "finance.accounthttp")
	support := env.sessionCookie(t, iam.RoleSupport, "support.accounthttp")
	ev := env.createPublishedEvent(t, ops)
	qr := testPNG(t, 6)

	body, ct := accountForm(t, accountFields(""), qr)
	rec := env.doRaw(t, http.MethodPost, "/api/admin/payment-accounts", body, ct, ops)
	require.Equal(t, http.StatusForbidden, rec.Code, "OPS 对 payment_account_manage 只读")

	body, ct = accountForm(t, accountFields(fmt.Sprint(ev.Id)), qr)
	rec = env.doRaw(t, http.MethodPost, "/api/admin/payment-accounts", body, ct, finance)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	created := eventsDecode[apigen.PaymentAccount](t, rec)
	require.Equal(t, "USD", created.Currency)
	require.Equal(t, ev.Id, *created.EventId)
	require.True(t, created.Active)
	require.NotZero(t, created.QrFileId)

	rec = env.do(t, http.MethodGet, "/api/admin/payment-accounts", nil, ops, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Len(t, eventsDecode[apigen.PaymentAccountList](t, rec).Items, 1)
	rec = env.do(t, http.MethodGet, "/api/admin/payment-accounts", nil, support, nil)
	require.Equal(t, http.StatusForbidden, rec.Code, "SUPPORT 没有 payment_account_manage")

	qrPath := fmt.Sprintf("/api/files/%d", created.QrFileId)
	rec = env.do(t, http.MethodGet, qrPath, nil, nil, nil)
	require.Equal(t, http.StatusOK, rec.Code, "公开文件不需要登录")
	require.Equal(t, "image/png", rec.Header().Get("Content-Type"))
	require.Equal(t, "public, max-age=86400", rec.Header().Get("Cache-Control"))
	require.Equal(t, fmt.Sprint(len(qr)), rec.Header().Get("Content-Length"))
	require.Equal(t, qr, rec.Body.Bytes())

	update := accountFields("")
	update["name"] = "ABA USD 备用"
	update["active"] = "false"
	body, ct = accountForm(t, update, nil)
	updatePath := fmt.Sprintf("/api/admin/payment-accounts/%d", created.Id)
	rec = env.doRaw(t, http.MethodPut, updatePath, body, ct, finance)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	kept := eventsDecode[apigen.PaymentAccount](t, rec)
	require.Equal(t, created.QrFileId, kept.QrFileId, "不带 qr 时不换二维码")
	require.Nil(t, kept.EventId)
	require.False(t, kept.Active)

	body, ct = accountForm(t, update, testPNG(t, 9))
	rec = env.doRaw(t, http.MethodPut, updatePath, body, ct, finance)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NotEqual(t, created.QrFileId, eventsDecode[apigen.PaymentAccount](t, rec).QrFileId)
	require.Equal(t, http.StatusOK, env.do(t, http.MethodGet, qrPath, nil, nil, nil).Code, "旧二维码仍可访问")

	invalid := accountFields("")
	invalid["provider"] = "PAYPAL"
	invalid["active"] = "maybe"
	body, ct = accountForm(t, invalid, qr)
	rec = env.doRaw(t, http.MethodPost, "/api/admin/payment-accounts", body, ct, finance)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	require.Contains(t, eventsDecode[httpx.ErrorBody](t, rec).Error.Fields, "active")

	invalid["active"] = "true"
	body, ct = accountForm(t, invalid, qr)
	rec = env.doRaw(t, http.MethodPost, "/api/admin/payment-accounts", body, ct, finance)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	require.Contains(t, eventsDecode[httpx.ErrorBody](t, rec).Error.Fields, "provider")

	body, ct = accountForm(t, accountFields(""), nil)
	rec = env.doRaw(t, http.MethodPost, "/api/admin/payment-accounts", body, ct, finance)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	require.Contains(t, eventsDecode[httpx.ErrorBody](t, rec).Error.Fields, "qr")

	body, ct = accountForm(t, accountFields(""), []byte("%PDF-1.7 not an image"))
	rec = env.doRaw(t, http.MethodPost, "/api/admin/payment-accounts", body, ct, finance)
	require.Equal(t, http.StatusUnsupportedMediaType, rec.Code, rec.Body.String())
	require.Equal(t, apperr.CodeFileTypeNotAllowed, eventsDecode[httpx.ErrorBody](t, rec).Error.Code)

	// 3 MB：没超过 6 MiB 请求体上限，但超过二维码 2 MB 上限
	body, ct = accountForm(t, accountFields(""), append(testPNG(t, 2), make([]byte, 3<<20)...))
	rec = env.doRaw(t, http.MethodPost, "/api/admin/payment-accounts", body, ct, finance)
	require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code, rec.Body.String())
	require.Equal(t, apperr.CodeFileTooLarge, eventsDecode[httpx.ErrorBody](t, rec).Error.Code)

	rec = env.doRaw(t, http.MethodPost, "/api/admin/payment-accounts", strings.NewReader(`{"name":"x"}`), "application/json", finance)
	require.Equal(t, http.StatusBadRequest, rec.Code, "不是 multipart 请求")

	var privateID int64
	require.NoError(t, env.pool.QueryRow(context.Background(),
		`INSERT INTO files (storage_key, visibility, purpose, mime_type, size_bytes, sha256, uploaded_by_type)
		 VALUES ('2026/09/private-proof.png', 'PRIVATE', 'PAYMENT_PROOF', 'image/png', 5, '\x01', 'USER') RETURNING id`).Scan(&privateID))
	rec = env.do(t, http.MethodGet, fmt.Sprintf("/api/files/%d", privateID), nil, nil, nil)
	require.Equal(t, http.StatusNotFound, rec.Code)
	require.Empty(t, rec.Header().Get("Cache-Control"))
	rec = env.do(t, http.MethodGet, "/api/files/999999", nil, nil, nil)
	require.Equal(t, http.StatusNotFound, rec.Code)
}
```

Run（colima 环境变量同 Step 1）：`cd api && go test ./internal/httpapi/ -run TestPaymentAccountsHTTP`
Expected: 编译失败，`unknown field Payment in struct literal of type httpapi.RouterDeps`。

- [ ] **Step 6: 实现 handler 并接入路由与 App**

创建 `api/internal/payment/handlers.go`：

```go
package payment

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/storage"
)

// maxTextPartBytes 是 multipart 文本字段的最大长度。
const maxTextPartBytes = 1024

// Handlers 实现 apigen.StrictServerInterface 中收款相关的操作。
type Handlers struct {
	svc *Service
}

// NewHandlers 创建 handler。
func NewHandlers(svc *Service) *Handlers {
	return &Handlers{svc: svc}
}

func (h *Handlers) AdminListPaymentAccounts(ctx context.Context, _ apigen.AdminListPaymentAccountsRequestObject) (apigen.AdminListPaymentAccountsResponseObject, error) {
	accounts, err := h.svc.ListAccounts(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]apigen.PaymentAccount, 0, len(accounts))
	for _, a := range accounts {
		items = append(items, toAPIAccount(a))
	}
	return apigen.AdminListPaymentAccounts200JSONResponse{Items: items}, nil
}

func (h *Handlers) AdminCreatePaymentAccount(ctx context.Context, req apigen.AdminCreatePaymentAccountRequestObject) (apigen.AdminCreatePaymentAccountResponseObject, error) {
	actor, ok := iam.StaffFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	form, err := readAccountForm(req.Body)
	if err != nil {
		return nil, err
	}
	acc, err := h.svc.CreateAccount(ctx, actor, form.input, form.qr)
	if err != nil {
		return nil, err
	}
	return apigen.AdminCreatePaymentAccount201JSONResponse(toAPIAccount(acc)), nil
}

func (h *Handlers) AdminUpdatePaymentAccount(ctx context.Context, req apigen.AdminUpdatePaymentAccountRequestObject) (apigen.AdminUpdatePaymentAccountResponseObject, error) {
	actor, ok := iam.StaffFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	form, err := readAccountForm(req.Body)
	if err != nil {
		return nil, err
	}
	acc, err := h.svc.UpdateAccount(ctx, actor, req.Id, form.input, form.qr)
	if err != nil {
		return nil, err
	}
	return apigen.AdminUpdatePaymentAccount200JSONResponse(toAPIAccount(acc)), nil
}

func (h *Handlers) GetPublicFile(ctx context.Context, req apigen.GetPublicFileRequestObject) (apigen.GetPublicFileResponseObject, error) {
	file, rc, err := h.svc.OpenPublicFile(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	// 响应头不在 OpenAPI 中声明（契约补充 9），生成的响应写出前由 gin 带上
	if c, ok := httpx.Gin(ctx); ok {
		c.Header("Cache-Control", "public, max-age=86400")
	}
	return apigen.GetPublicFile200ImageResponse{Body: rc, ContentType: file.MIME, ContentLength: file.SizeBytes}, nil
}

type accountForm struct {
	input AccountInput
	qr    io.Reader // 没有 qr part 或内容为空时为 nil
}

// readAccountForm 逐个读取 multipart part：qr 最多读 MaxQRBytes+1 字节（超限由 ReadImage 报 FILE_TOO_LARGE），
// 其余为文本字段。active 缺省为 true，eventId 空串表示全局。
func readAccountForm(r *multipart.Reader) (accountForm, error) {
	form := accountForm{input: AccountInput{Active: true}}
	verr := validationError()
	failed := false
	for {
		part, err := r.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return accountForm{}, multipartError(err)
		}
		name := part.FormName()
		if name == "qr" {
			data, err := io.ReadAll(io.LimitReader(part, storage.MaxQRBytes+1))
			if err != nil {
				return accountForm{}, multipartError(err)
			}
			if len(data) > 0 {
				form.qr = bytes.NewReader(data)
			}
			continue
		}
		raw, err := io.ReadAll(io.LimitReader(part, maxTextPartBytes+1))
		if err != nil {
			return accountForm{}, multipartError(err)
		}
		if len(raw) > maxTextPartBytes {
			return accountForm{}, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
		}
		value := string(raw)
		switch name {
		case "name":
			form.input.Name = value
		case "provider":
			form.input.Provider = value
		case "accountName":
			form.input.AccountName = value
		case "accountNoMasked":
			form.input.AccountNoMasked = value
		case "scope":
			form.input.Scope = value
		case "eventId":
			trimmed := strings.TrimSpace(value)
			if trimmed == "" {
				form.input.EventID = nil
				continue
			}
			id, err := strconv.ParseInt(trimmed, 10, 64)
			if err != nil || id <= 0 {
				verr = verr.WithField("eventId", "field.invalid", nil)
				failed = true
				continue
			}
			form.input.EventID = &id
		case "active":
			switch value {
			case "true":
				form.input.Active = true
			case "false":
				form.input.Active = false
			default:
				verr = verr.WithField("active", "field.invalid", nil)
				failed = true
			}
		}
	}
	if failed {
		return accountForm{}, verr
	}
	return form, nil
}

func multipartError(err error) error {
	var mbe *http.MaxBytesError
	if errors.As(err, &mbe) {
		return apperr.New(http.StatusRequestEntityTooLarge, apperr.CodeFileTooLarge).
			WithParams(map[string]any{"maxMB": storage.MaxQRBytes >> 20}).Wrap(err)
	}
	return apperr.New(http.StatusBadRequest, apperr.CodeBadRequest).Wrap(err)
}

func toAPIAccount(a Account) apigen.PaymentAccount {
	return apigen.PaymentAccount{
		Id:              a.ID,
		Name:            a.Input.Name,
		Provider:        apigen.PaymentProvider(a.Input.Provider),
		AccountName:     a.Input.AccountName,
		AccountNoMasked: a.Input.AccountNoMasked,
		Currency:        a.Currency,
		QrFileId:        a.QRFileID,
		Scope:           apigen.PaymentAccountScope(a.Input.Scope),
		EventId:         a.Input.EventID,
		Active:          a.Input.Active,
		CreatedAt:       a.CreatedAt,
	}
}
```

`api/internal/httpapi/server.go`：import 加入 `"werun/api/internal/payment"`；类型别名块加 `PaymentHandlers = payment.Handlers`；`Server` 结构体末尾加 `*PaymentHandlers`；`NewServer` 字面量末尾加 `PaymentHandlers: payment.NewHandlers(d.Payment),`（`gofmt` 对齐）。

`api/internal/httpapi/router.go`：import 加入 `"werun/api/internal/payment"`；`RouterDeps` 中 `Pricing *pricing.Service` 之后加 `Payment *payment.Service`。

`api/cmd/werun/app.go`：import 加入 `"werun/api/internal/payment"`；`App` 中 `Pricing  *pricing.Service` 之后加 `Payment  *payment.Service`；`Bootstrap` 中 `app.Pricing = ...` 之后加 `app.Payment = payment.NewService(app.Pool, app.Store, time.Now)`。

`api/cmd/werun/router.go` 的字面量中 `Pricing: app.Pricing,` 之后加 `Payment: app.Payment,`。

Run（colima 环境变量同 Step 1）：`cd api && gofmt -l ./internal ./cmd && go test ./internal/httpapi/ ./internal/payment/ ./cmd/werun/`
Expected: `gofmt -l` 无输出；测试 PASS，含 `TestPaymentAccountsHTTP`。

- [ ] **Step 7: 写后台收款账户页的失败测试**

`web/admin/src/test/fixtures.ts`：`opsMe` 权限中

```ts
    coupon_manage: "write",
  },
```

改为：

```ts
    coupon_manage: "write",
    payment_account_manage: "read",
  },
```

`adminMe` 权限中

```ts
    coupon_manage: "read",
  },
```

改为：

```ts
    coupon_manage: "read",
    payment_account_manage: "read",
  },
```

在 `photographerMe` 之后追加：

```ts
export const financeMe: Schemas["Me"] = {
  staff: { id: 3, username: "finance.mao", fullName: "Maolin Tep", role: "FINANCE" },
  permissions: {
    event_config: "read",
    order_view: "read",
    price_config: "read",
    coupon_manage: "read",
    payment_account_manage: "write",
    proof_review: "write",
  },
};
```

在 `earlyCoupon` 之后追加：

```ts
export const abaAccount: Schemas["PaymentAccount"] = {
  id: 5,
  name: "ABA USD 主收款户",
  provider: "ABA",
  accountName: "WERUN SPORTS CO LTD",
  accountNoMasked: "*** 123",
  currency: "USD",
  qrFileId: 88,
  scope: "REGISTRATION",
  eventId: null,
  active: true,
  createdAt: "2026-09-14T03:00:00Z",
};
```

创建 `web/admin/src/payments/accountForm.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { abaAccount } from "../test/fixtures";
import { emptyAccount, fromAccount, publicFileUrl, toAccountFormData } from "./accountForm";

describe("toAccountFormData", () => {
  it("文本字段去空格，全局账户 eventId 为空串，带二维码文件", () => {
    const qr = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
    const form = toAccountFormData(
      { ...emptyAccount(), name: " ABA USD ", accountName: " WERUN CO ", accountNoMasked: " *** 123 " },
      qr,
    );

    expect(form.get("name")).toBe("ABA USD");
    expect(form.get("provider")).toBe("ABA");
    expect(form.get("accountName")).toBe("WERUN CO");
    expect(form.get("accountNoMasked")).toBe("*** 123");
    expect(form.get("scope")).toBe("REGISTRATION");
    expect(form.get("eventId")).toBe("");
    expect(form.get("active")).toBe("true");
    expect(form.get("qr")).not.toBeNull();
    expect([...form.keys()].at(-1)).toBe("qr");
  });

  it("绑定赛事、停用、不换二维码", () => {
    const form = toAccountFormData({ ...fromAccount(abaAccount), eventId: 7, active: false }, null);

    expect(form.get("eventId")).toBe("7");
    expect(form.get("active")).toBe("false");
    expect(form.has("qr")).toBe(false);
  });

  it("fromAccount 回填与公开文件地址", () => {
    expect(fromAccount(abaAccount)).toEqual({
      name: "ABA USD 主收款户",
      provider: "ABA",
      accountName: "WERUN SPORTS CO LTD",
      accountNoMasked: "*** 123",
      scope: "REGISTRATION",
      eventId: null,
      active: true,
    });
    expect(publicFileUrl(88)).toBe("/api/files/88");
  });
});
```

创建 `web/admin/src/pages/PaymentAccountsPage.test.tsx`：

```tsx
import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  abaAccount,
  financeMe,
  jsonResponse,
  opsMe,
  photographerMe,
  publishedEvent,
} from "../test/fixtures";
import { fillField, replaceField, setupFormUser } from "../test/form";
import { renderAdminApp } from "../test/renderAdminApp";

beforeEach(() => {
  window.localStorage.setItem("werun.lang", "en");
});

function findRequest(requests: Request[], method: string, pathname: string): Request | undefined {
  return requests.find((request) => request.method === method && new URL(request.url).pathname === pathname);
}

function qrFile(): File {
  return new File([new Uint8Array([137, 80, 78, 71])], "qr.png", { type: "image/png" });
}

async function fillAccountForm(user: ReturnType<typeof setupFormUser>) {
  await fillField(user, "paymentAccount_name", "ABA USD 主收款户");
  await fillField(user, "paymentAccount_accountName", "WERUN SPORTS CO LTD");
  await fillField(user, "paymentAccount_accountNoMasked", "*** 123");
}

describe("收款账户页", () => {
  it("FINANCE 新建收款账户：以 multipart 上传二维码", async () => {
    let created = false;
    const { requests } = renderAdminApp("/payment-accounts", {
      "GET /api/admin/me": () => jsonResponse(200, financeMe),
      "GET /api/admin/events": () => jsonResponse(200, { items: [publishedEvent] }),
      "GET /api/admin/payment-accounts": () => jsonResponse(200, { items: created ? [abaAccount] : [] }),
      "POST /api/admin/payment-accounts": () => {
        created = true;
        return jsonResponse(201, abaAccount);
      },
    });
    const user = setupFormUser();

    expect(await screen.findByRole("menuitem", { name: /Payment accounts/ })).toBeInTheDocument();
    await user.click(await screen.findByTestId("payment-account-create"));
    await fillAccountForm(user);
    await user.upload(screen.getByTestId("payment-account-qr-input"), qrFile());
    await user.click(screen.getByTestId("payment-account-submit"));

    const row = await screen.findByTestId("payment-account-row-5");
    expect(within(row).getByText("*** 123")).toBeInTheDocument();
    const post = findRequest(requests, "POST", "/api/admin/payment-accounts");
    expect(post?.headers.get("Content-Type")).toMatch(/^multipart\/form-data; boundary=/);
    expect(post?.headers.get("X-WeRun-Client")).toBe("admin");
    const form = await post!.clone().formData();
    expect(form.get("name")).toBe("ABA USD 主收款户");
    expect(form.get("provider")).toBe("ABA");
    expect(form.get("accountName")).toBe("WERUN SPORTS CO LTD");
    expect(form.get("accountNoMasked")).toBe("*** 123");
    expect(form.get("scope")).toBe("REGISTRATION");
    expect(form.get("eventId")).toBe("");
    expect(form.get("active")).toBe("true");
    const qr = form.get("qr") as Blob;
    expect(qr.type).toBe("image/png");
    expect(qr.size).toBe(4);
  });

  it("新建时没有选择二维码：提示并且不提交", async () => {
    const { requests } = renderAdminApp("/payment-accounts", {
      "GET /api/admin/me": () => jsonResponse(200, financeMe),
      "GET /api/admin/events": () => jsonResponse(200, { items: [] }),
      "GET /api/admin/payment-accounts": () => jsonResponse(200, { items: [] }),
    });
    const user = setupFormUser();

    await user.click(await screen.findByTestId("payment-account-create"));
    await fillAccountForm(user);
    await user.click(screen.getByTestId("payment-account-submit"));

    expect(await screen.findByText("Upload the payment QR code")).toBeInTheDocument();
    expect(findRequest(requests, "POST", "/api/admin/payment-accounts")).toBeUndefined();
  });

  it("服务端返回文件太大时显示错误", async () => {
    renderAdminApp("/payment-accounts", {
      "GET /api/admin/me": () => jsonResponse(200, financeMe),
      "GET /api/admin/events": () => jsonResponse(200, { items: [] }),
      "GET /api/admin/payment-accounts": () => jsonResponse(200, { items: [] }),
      "POST /api/admin/payment-accounts": () =>
        jsonResponse(413, { error: { code: "FILE_TOO_LARGE", message: "The file is too large. The limit is 2 MB." } }),
    });
    const user = setupFormUser();

    await user.click(await screen.findByTestId("payment-account-create"));
    await fillAccountForm(user);
    await user.upload(screen.getByTestId("payment-account-qr-input"), qrFile());
    await user.click(screen.getByTestId("payment-account-submit"));

    expect(await screen.findByText("The file is too large. The limit is 2 MB.")).toBeInTheDocument();
  });

  it("编辑时不选新图片：请求体不带 qr", async () => {
    const { requests } = renderAdminApp("/payment-accounts", {
      "GET /api/admin/me": () => jsonResponse(200, financeMe),
      "GET /api/admin/events": () => jsonResponse(200, { items: [publishedEvent] }),
      "GET /api/admin/payment-accounts": () => jsonResponse(200, { items: [abaAccount] }),
      "PUT /api/admin/payment-accounts/5": () => jsonResponse(200, { ...abaAccount, name: "ABA USD 备用" }),
    });
    const user = setupFormUser();

    await user.click(await screen.findByTestId("payment-account-edit-5"));
    await replaceField(user, "paymentAccount_name", "ABA USD 备用");
    await user.click(screen.getByTestId("payment-account-submit"));

    expect(await screen.findByText("Payment account saved")).toBeInTheDocument();
    const form = await findRequest(requests, "PUT", "/api/admin/payment-accounts/5")!.clone().formData();
    expect(form.get("name")).toBe("ABA USD 备用");
    expect(form.get("qr")).toBeNull();
  });

  it("OPS 只读：能看列表与二维码，没有新建与编辑按钮", async () => {
    renderAdminApp("/payment-accounts", {
      "GET /api/admin/me": () => jsonResponse(200, opsMe),
      "GET /api/admin/events": () => jsonResponse(200, { items: [] }),
      "GET /api/admin/payment-accounts": () => jsonResponse(200, { items: [abaAccount] }),
    });

    const row = await screen.findByTestId("payment-account-row-5");
    expect(within(row).getByRole("img")).toHaveAttribute("src", "/api/files/88");
    expect(within(row).getByText("All events")).toBeInTheDocument();
    expect(screen.queryByTestId("payment-account-create")).not.toBeInTheDocument();
    expect(screen.queryByTestId("payment-account-edit-5")).not.toBeInTheDocument();
  });

  it("没有权限的角色：菜单不显示，直接访问显示 403", async () => {
    renderAdminApp("/payment-accounts", {
      "GET /api/admin/me": () => jsonResponse(200, photographerMe),
    });

    expect(await screen.findByTestId("forbidden-page")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Payment accounts/ })).not.toBeInTheDocument();
  });
});
```

Run: `pnpm --filter @werun/admin test src/payments src/pages/PaymentAccountsPage.test.tsx`
Expected: FAIL，`Failed to resolve import "./accountForm"`；页面测试中 `/payment-accounts` 被 `*` 路由重定向到 `/events`，找不到 `payment-account-create`。

- [ ] **Step 8: 实现前端收款账户**

创建 `web/admin/src/payments/accountForm.ts`：

```ts
import type { Schemas } from "@werun/api-client";

export interface PaymentAccountFormValues {
  name: string;
  provider: Schemas["PaymentProvider"];
  accountName: string;
  accountNoMasked: string;
  scope: Schemas["PaymentAccountScope"];
  eventId?: number | null;
  active: boolean;
}

export function emptyAccount(): PaymentAccountFormValues {
  return {
    name: "",
    provider: "ABA",
    accountName: "",
    accountNoMasked: "",
    scope: "REGISTRATION",
    eventId: null,
    active: true,
  };
}

export function fromAccount(account: Schemas["PaymentAccount"]): PaymentAccountFormValues {
  return {
    name: account.name,
    provider: account.provider,
    accountName: account.accountName,
    accountNoMasked: account.accountNoMasked,
    scope: account.scope,
    eventId: account.eventId,
    active: account.active,
  };
}

/** multipart 请求体：文本字段在前，qr 放最后；qr 为 null 时不带文件（修改时表示不换二维码） */
export function toAccountFormData(values: PaymentAccountFormValues, qr: Blob | null): FormData {
  const form = new FormData();
  form.append("name", values.name.trim());
  form.append("provider", values.provider);
  form.append("accountName", values.accountName.trim());
  form.append("accountNoMasked", values.accountNoMasked.trim());
  form.append("scope", values.scope);
  form.append("eventId", values.eventId == null ? "" : String(values.eventId));
  form.append("active", values.active ? "true" : "false");
  if (qr) {
    form.append("qr", qr);
  }
  return form;
}

/** 公开文件（收款二维码）地址，对应 getPublicFile */
export function publicFileUrl(fileId: number): string {
  return `/api/files/${fileId}`;
}
```

创建 `web/admin/src/payments/queries.ts`：

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap, type paths } from "@werun/api-client";
import { useApi } from "../api";

type CreateBody = paths["/admin/payment-accounts"]["post"]["requestBody"]["content"]["multipart/form-data"];
type UpdateBody = paths["/admin/payment-accounts/{id}"]["put"]["requestBody"]["content"]["multipart/form-data"];

export const PAYMENT_ACCOUNTS_KEY = ["admin", "payment-accounts"] as const;

export function usePaymentAccounts() {
  const api = useApi();
  return useQuery({
    queryKey: PAYMENT_ACCOUNTS_KEY,
    queryFn: async () => unwrap(await api.GET("/admin/payment-accounts")).items,
  });
}

/**
 * multipart 接口：openapi-fetch 的 body 类型是 schema 描述的对象，这里实际发送 FormData，
 * 通过 bodySerializer 原样交给 fetch；body 是 FormData 时 openapi-fetch 不设置 Content-Type，由浏览器带上 boundary。
 */
export function useSavePaymentAccount() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, form }: { id?: number; form: FormData }) =>
      id === undefined
        ? unwrap(
            await api.POST("/admin/payment-accounts", {
              body: form as unknown as CreateBody,
              bodySerializer: () => form,
            }),
          )
        : unwrap(
            await api.PUT("/admin/payment-accounts/{id}", {
              params: { path: { id } },
              body: form as unknown as UpdateBody,
              bodySerializer: () => form,
            }),
          ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PAYMENT_ACCOUNTS_KEY }),
  });
}
```

创建 `web/admin/src/pages/PaymentAccountsPage.tsx`：

```tsx
import { PlusOutlined, UploadOutlined } from "@ant-design/icons";
import { ApiError, type Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import {
  Alert,
  App as AntdApp,
  Button,
  Col,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  Upload,
  type TableProps,
  type UploadFile,
} from "antd";
import { useState, type HTMLAttributes } from "react";
import { useTranslation } from "react-i18next";
import { PERM_PAYMENT_ACCOUNT_MANAGE, can } from "../auth/can";
import { useMe } from "../auth/useMe";
import { toNamePath } from "../events/eventForm";
import { pickText } from "../events/localize";
import { useAdminEvents } from "../events/queries";
import {
  emptyAccount,
  fromAccount,
  publicFileUrl,
  toAccountFormData,
  type PaymentAccountFormValues,
} from "../payments/accountForm";
import { usePaymentAccounts, useSavePaymentAccount } from "../payments/queries";

type PaymentAccount = Schemas["PaymentAccount"];
type AdminEvent = Schemas["AdminEvent"];

const PROVIDERS = ["ABA", "ACLEDA", "WING", "BAKONG", "OTHER"] as const;
const SCOPES = ["REGISTRATION", "MERCH", "ALL"] as const;

export function PaymentAccountsPage() {
  const { t } = useTranslation("admin");
  const lang = useLang();
  const { data: me } = useMe();
  const accounts = usePaymentAccounts();
  const events = useAdminEvents();
  const canWrite = can(me?.permissions, PERM_PAYMENT_ACCOUNT_MANAGE, "write");
  const [editing, setEditing] = useState<{ account?: PaymentAccount } | null>(null);

  const eventLabel = (eventId: number | null): string => {
    if (eventId === null) {
      return t("paymentAccounts.global");
    }
    const found = events.data?.find((event) => event.id === eventId);
    return found ? pickText(found.name, lang) : `#${eventId}`;
  };

  const columns: TableProps<PaymentAccount>["columns"] = [
    {
      title: t("paymentAccounts.col.qr"),
      key: "qr",
      render: (_, account) => (
        <img
          src={publicFileUrl(account.qrFileId)}
          alt={account.name}
          width={48}
          height={48}
          style={{ objectFit: "contain", border: "1px solid var(--line)", borderRadius: 4 }}
        />
      ),
    },
    { title: t("paymentAccounts.col.name"), dataIndex: "name", key: "name" },
    {
      title: t("paymentAccounts.col.provider"),
      key: "provider",
      render: (_, account) => t(`paymentAccounts.provider.${account.provider}`),
    },
    { title: t("paymentAccounts.col.accountName"), dataIndex: "accountName", key: "accountName" },
    { title: t("paymentAccounts.col.accountNoMasked"), dataIndex: "accountNoMasked", key: "accountNoMasked" },
    {
      title: t("paymentAccounts.col.scope"),
      key: "scope",
      render: (_, account) => <Tag>{t(`paymentAccounts.scope.${account.scope}`)}</Tag>,
    },
    { title: t("paymentAccounts.col.event"), key: "event", render: (_, account) => eventLabel(account.eventId) },
    {
      title: t("paymentAccounts.col.status"),
      key: "status",
      render: (_, account) =>
        account.active ? (
          <Tag color="green">{t("paymentAccounts.active")}</Tag>
        ) : (
          <Tag>{t("paymentAccounts.inactive")}</Tag>
        ),
    },
    {
      title: t("paymentAccounts.col.actions"),
      key: "actions",
      render: (_, account) =>
        canWrite ? (
          <Button size="small" data-testid={`payment-account-edit-${account.id}`} onClick={() => setEditing({ account })}>
            {t("paymentAccounts.edit")}
          </Button>
        ) : null,
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space style={{ width: "100%", justifyContent: "space-between" }} wrap>
        <Typography.Title level={3} style={{ margin: 0 }}>
          {t("paymentAccounts.title")}
        </Typography.Title>
        {canWrite ? (
          <Button type="primary" icon={<PlusOutlined />} data-testid="payment-account-create" onClick={() => setEditing({})}>
            {t("paymentAccounts.create")}
          </Button>
        ) : null}
      </Space>
      <Typography.Text type="secondary">{t("paymentAccounts.currencyNote")}</Typography.Text>
      {accounts.isError ? <Alert type="error" showIcon message={accounts.error.message} /> : null}
      <Table<PaymentAccount>
        rowKey="id"
        columns={columns}
        dataSource={accounts.data ?? []}
        loading={accounts.isPending}
        pagination={false}
        locale={{ emptyText: t("paymentAccounts.empty") }}
        scroll={{ x: 1100 }}
        onRow={(account) => ({ "data-testid": `payment-account-row-${account.id}` }) as HTMLAttributes<HTMLElement>}
      />
      {editing ? (
        <PaymentAccountModal account={editing.account} events={events.data ?? []} onClose={() => setEditing(null)} />
      ) : null}
    </Space>
  );
}

interface PaymentAccountModalProps {
  account?: PaymentAccount;
  events: AdminEvent[];
  onClose: () => void;
}

function PaymentAccountModal({ account, events, onClose }: PaymentAccountModalProps) {
  const { t } = useTranslation("admin");
  const lang = useLang();
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<PaymentAccountFormValues>();
  const save = useSavePaymentAccount();
  const [qrFile, setQrFile] = useState<File | null>(null);
  const [qrMissing, setQrMissing] = useState(false);
  const required = [{ required: true, message: t("form.required") }];

  const apiError = save.error instanceof ApiError ? save.error : null;
  const hasFieldErrors = apiError !== null && Object.keys(apiError.fields).length > 0;
  const bannerError = save.error && !hasFieldErrors ? save.error : null;
  const qrServerError = apiError?.fields.qr;

  const onFinish = (values: PaymentAccountFormValues) => {
    if (!account && !qrFile) {
      setQrMissing(true);
      return;
    }
    save.mutate(
      { id: account?.id, form: toAccountFormData(values, qrFile) },
      {
        onSuccess: () => {
          void message.success(t(account ? "paymentAccounts.updated" : "paymentAccounts.created"));
          onClose();
        },
        onError: (error) => {
          if (!(error instanceof ApiError)) {
            return;
          }
          const fieldEntries = Object.entries(error.fields).filter(([field]) => field !== "qr");
          if (fieldEntries.length > 0) {
            form.setFields(
              fieldEntries.map(([field, text]) => ({ name: toNamePath(field), errors: [text] })) as Parameters<
                typeof form.setFields
              >[0],
            );
          }
        },
      },
    );
  };

  const fileList: UploadFile[] = qrFile ? [{ uid: "qr", name: qrFile.name, status: "done" }] : [];
  const qrHelp = qrMissing
    ? t("paymentAccounts.form.qrRequired")
    : (qrServerError ?? t(account ? "paymentAccounts.form.qrKeepHelp" : "paymentAccounts.form.qrHelp"));

  return (
    <Modal
      open
      title={t(account ? "paymentAccounts.editTitle" : "paymentAccounts.createTitle")}
      onCancel={onClose}
      footer={null}
      width={720}
      maskClosable={false}
    >
      {bannerError ? <Alert type="error" showIcon message={bannerError.message} style={{ marginBottom: 16 }} /> : null}
      <Form<PaymentAccountFormValues>
        form={form}
        name="paymentAccount"
        layout="vertical"
        onFinish={onFinish}
        disabled={save.isPending}
        initialValues={account ? fromAccount(account) : emptyAccount()}
      >
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="name" label={t("paymentAccounts.form.name")} extra={t("paymentAccounts.form.nameHelp")} rules={required}>
              <Input />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="provider" label={t("paymentAccounts.form.provider")} rules={required}>
              <Select options={PROVIDERS.map((p) => ({ value: p, label: t(`paymentAccounts.provider.${p}`) }))} />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="accountName" label={t("paymentAccounts.form.accountName")} rules={required}>
              <Input />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item
              name="accountNoMasked"
              label={t("paymentAccounts.form.accountNoMasked")}
              extra={t("paymentAccounts.form.accountNoMaskedHelp")}
              rules={required}
            >
              <Input />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col xs={24} md={8}>
            <Form.Item name="scope" label={t("paymentAccounts.form.scope")} rules={required}>
              <Select options={SCOPES.map((s) => ({ value: s, label: t(`paymentAccounts.scope.${s}`) }))} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="eventId" label={t("paymentAccounts.form.eventId")} extra={t("paymentAccounts.form.eventIdHelp")}>
              <Select
                allowClear
                placeholder={t("paymentAccounts.global")}
                options={events.map((event) => ({ value: event.id, label: pickText(event.name, lang) }))}
              />
            </Form.Item>
          </Col>
          <Col xs={24} md={4}>
            <Form.Item name="active" label={t("paymentAccounts.form.active")} valuePropName="checked">
              <Switch />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item
          label={t("paymentAccounts.form.qr")}
          required={!account}
          validateStatus={qrMissing || qrServerError ? "error" : undefined}
          help={qrHelp}
        >
          <Space align="start">
            {account && !qrFile ? (
              <img
                src={publicFileUrl(account.qrFileId)}
                alt={account.name}
                width={64}
                height={64}
                style={{ objectFit: "contain", border: "1px solid var(--line)", borderRadius: 4 }}
              />
            ) : null}
            <Upload
              accept="image/png,image/jpeg,image/webp"
              maxCount={1}
              fileList={fileList}
              data-testid="payment-account-qr-input"
              beforeUpload={(file) => {
                setQrFile(file);
                setQrMissing(false);
                return false;
              }}
              onRemove={() => setQrFile(null)}
            >
              <Button icon={<UploadOutlined />}>{t("paymentAccounts.form.chooseQr")}</Button>
            </Upload>
          </Space>
        </Form.Item>
        <Space>
          <Button onClick={onClose}>{t("paymentAccounts.cancel")}</Button>
          <Button type="primary" htmlType="submit" loading={save.isPending} data-testid="payment-account-submit">
            {t("paymentAccounts.submit")}
          </Button>
        </Space>
      </Form>
    </Modal>
  );
}
```

（`Upload` 的 `data-testid` 经 antd 传给 rc-upload，由 `pickAttrs(..., { data: true })` 落到隐藏的 `<input type="file">` 上，Playwright 可直接 `setInputFiles`。）

`web/admin/src/routes.tsx`：import 中

```tsx
import { PERM_EVENT_CONFIG } from "./auth/can";
```

改为：

```tsx
import { PERM_EVENT_CONFIG, PERM_PAYMENT_ACCOUNT_MANAGE } from "./auth/can";
```

加入 `import { PaymentAccountsPage } from "./pages/PaymentAccountsPage";`；在 `events/:id` 路由之后插入：

```tsx
          {
            path: "payment-accounts",
            element: (
              <RequirePermission permission={PERM_PAYMENT_ACCOUNT_MANAGE} access="read">
                <PaymentAccountsPage />
              </RequirePermission>
            ),
          },
```

`web/admin/src/layout/AppLayout.tsx`：

```tsx
import { CalendarOutlined, LogoutOutlined } from "@ant-design/icons";
```

改为：

```tsx
import { CalendarOutlined, LogoutOutlined, WalletOutlined } from "@ant-design/icons";
```

```tsx
import { PERM_EVENT_CONFIG, can, type Access } from "../auth/can";
```

改为：

```tsx
import { PERM_EVENT_CONFIG, PERM_PAYMENT_ACCOUNT_MANAGE, can, type Access } from "../auth/can";
```

`MENU` 数组：

```tsx
  { key: "/events", labelKey: "events.title", permission: PERM_EVENT_CONFIG, access: "read", icon: <CalendarOutlined /> },
];
```

改为：

```tsx
  { key: "/events", labelKey: "events.title", permission: PERM_EVENT_CONFIG, access: "read", icon: <CalendarOutlined /> },
  {
    key: "/payment-accounts",
    labelKey: "paymentAccounts.title",
    permission: PERM_PAYMENT_ACCOUNT_MANAGE,
    access: "read",
    icon: <WalletOutlined />,
  },
];
```

`packages/i18n/locales/zh/admin.json` 顶层在 `coupons` 之后追加：

```json
  "paymentAccounts": {
    "title": "收款账户",
    "create": "新建收款账户",
    "createTitle": "新建收款账户",
    "editTitle": "编辑收款账户",
    "edit": "编辑",
    "empty": "还没有收款账户",
    "created": "收款账户已创建",
    "updated": "收款账户已保存",
    "submit": "保存",
    "cancel": "取消",
    "global": "所有赛事",
    "active": "启用",
    "inactive": "停用",
    "currencyNote": "收款币种固定为美元（USD）。跑者下单时优先使用绑定该赛事的启用账户，其次使用所有赛事通用的账户。",
    "col": {
      "qr": "二维码",
      "name": "名称",
      "provider": "渠道",
      "accountName": "户名",
      "accountNoMasked": "账号尾号",
      "scope": "用途",
      "event": "适用赛事",
      "status": "状态",
      "actions": "操作"
    },
    "provider": { "ABA": "ABA", "ACLEDA": "ACLEDA", "WING": "Wing", "BAKONG": "Bakong", "OTHER": "其他" },
    "scope": { "REGISTRATION": "报名", "MERCH": "周边", "ALL": "报名与周边" },
    "form": {
      "name": "名称",
      "nameHelp": "只在后台显示，例如 ABA USD 主收款户",
      "provider": "渠道",
      "accountName": "户名",
      "accountNoMasked": "账号尾号",
      "accountNoMaskedHelp": "只填打码后的账号，例如 *** 123",
      "scope": "用途",
      "eventId": "适用赛事",
      "eventIdHelp": "留空表示所有赛事都可以使用",
      "active": "启用",
      "qr": "收款二维码",
      "qrHelp": "PNG、JPG 或 WebP，不超过 2 MB",
      "qrKeepHelp": "不选择新图片则保留当前二维码",
      "qrRequired": "请上传收款二维码",
      "chooseQr": "选择图片"
    }
  }
```

`packages/i18n/locales/en/admin.json` 顶层追加：

```json
  "paymentAccounts": {
    "title": "Payment accounts",
    "create": "New payment account",
    "createTitle": "New payment account",
    "editTitle": "Edit payment account",
    "edit": "Edit",
    "empty": "No payment accounts yet",
    "created": "Payment account created",
    "updated": "Payment account saved",
    "submit": "Save",
    "cancel": "Cancel",
    "global": "All events",
    "active": "Active",
    "inactive": "Inactive",
    "currencyNote": "Payments are collected in US dollars (USD). Orders use an active account bound to the event first, then an account shared by all events.",
    "col": {
      "qr": "QR code",
      "name": "Name",
      "provider": "Provider",
      "accountName": "Account name",
      "accountNoMasked": "Account ending",
      "scope": "Used for",
      "event": "Event",
      "status": "Status",
      "actions": "Actions"
    },
    "provider": { "ABA": "ABA", "ACLEDA": "ACLEDA", "WING": "Wing", "BAKONG": "Bakong", "OTHER": "Other" },
    "scope": { "REGISTRATION": "Registration", "MERCH": "Merchandise", "ALL": "Registration and merchandise" },
    "form": {
      "name": "Name",
      "nameHelp": "Shown only in admin, e.g. ABA USD main account",
      "provider": "Provider",
      "accountName": "Account name",
      "accountNoMasked": "Account ending",
      "accountNoMaskedHelp": "Enter the masked number only, e.g. *** 123",
      "scope": "Used for",
      "eventId": "Event",
      "eventIdHelp": "Leave empty to use it for all events",
      "active": "Active",
      "qr": "Payment QR code",
      "qrHelp": "PNG, JPG or WebP, up to 2 MB",
      "qrKeepHelp": "Keep the current QR code unless you choose a new image",
      "qrRequired": "Upload the payment QR code",
      "chooseQr": "Choose image"
    }
  }
```

`packages/i18n/locales/km/admin.json` 顶层追加：

```json
  "paymentAccounts": {
    "title": "គណនីទទួលប្រាក់",
    "create": "បង្កើតគណនីទទួលប្រាក់",
    "createTitle": "បង្កើតគណនីទទួលប្រាក់",
    "editTitle": "កែគណនីទទួលប្រាក់",
    "edit": "កែ",
    "empty": "មិនទាន់មានគណនីទទួលប្រាក់ទេ",
    "created": "បានបង្កើតគណនីទទួលប្រាក់",
    "updated": "បានរក្សាទុកគណនីទទួលប្រាក់",
    "submit": "រក្សាទុក",
    "cancel": "បោះបង់",
    "global": "គ្រប់ព្រឹត្តិការណ៍",
    "active": "កំពុងប្រើ",
    "inactive": "បានបិទ",
    "currencyNote": "ការទទួលប្រាក់ប្រើតែប្រាក់ដុល្លារអាមេរិក (USD)។ ការបញ្ជាទិញប្រើគណនីដែលភ្ជាប់នឹងព្រឹត្តិការណ៍ជាមុន បន្ទាប់មកប្រើគណនីរួមសម្រាប់គ្រប់ព្រឹត្តិការណ៍។",
    "col": {
      "qr": "កូដ QR",
      "name": "ឈ្មោះ",
      "provider": "ធនាគារ/សេវា",
      "accountName": "ឈ្មោះគណនី",
      "accountNoMasked": "លេខគណនីខ្ទង់ចុងក្រោយ",
      "scope": "ប្រើសម្រាប់",
      "event": "ព្រឹត្តិការណ៍",
      "status": "ស្ថានភាព",
      "actions": "សកម្មភាព"
    },
    "provider": { "ABA": "ABA", "ACLEDA": "ACLEDA", "WING": "Wing", "BAKONG": "Bakong", "OTHER": "ផ្សេងៗ" },
    "scope": { "REGISTRATION": "ការចុះឈ្មោះ", "MERCH": "ទំនិញ", "ALL": "ការចុះឈ្មោះ និងទំនិញ" },
    "form": {
      "name": "ឈ្មោះ",
      "nameHelp": "បង្ហាញតែក្នុងប្រព័ន្ធគ្រប់គ្រង ឧទាហរណ៍ ABA USD គណនីចម្បង",
      "provider": "ធនាគារ/សេវា",
      "accountName": "ឈ្មោះគណនី",
      "accountNoMasked": "លេខគណនីខ្ទង់ចុងក្រោយ",
      "accountNoMaskedHelp": "បញ្ចូលតែលេខដែលបានបិទបាំង ឧទាហរណ៍ *** 123",
      "scope": "ប្រើសម្រាប់",
      "eventId": "ព្រឹត្តិការណ៍",
      "eventIdHelp": "ទុកទទេ ដើម្បីប្រើសម្រាប់គ្រប់ព្រឹត្តិការណ៍",
      "active": "កំពុងប្រើ",
      "qr": "កូដ QR ទទួលប្រាក់",
      "qrHelp": "PNG, JPG ឬ WebP មិនលើស 2 MB",
      "qrKeepHelp": "បើមិនជ្រើសរូបភាពថ្មី នឹងរក្សាកូដ QR បច្ចុប្បន្ន",
      "qrRequired": "សូមផ្ទុកកូដ QR ទទួលប្រាក់",
      "chooseQr": "ជ្រើសរូបភាព"
    }
  }
```

Run: `pnpm --filter @werun/admin test`
Expected: PASS；`accountForm.test.ts` 3 个、`PaymentAccountsPage.test.tsx` 6 个用例通过；`app.test.tsx` 等已有测试不回归（OPS 的菜单多出 “Payment accounts”，现有断言不受影响）。

- [ ] **Step 9: 全量检查**

Run（colima 环境变量同 Step 1）：

```bash
make gen && git status --porcelain
cd api && go mod tidy && git -C .. diff --exit-code api/go.mod api/go.sum
cd api && go test ./... && go tool golangci-lint run ./...
pnpm typecheck && pnpm lint && pnpm test && pnpm i18n:check && pnpm build
docker compose -f deploy/compose.yaml --env-file .env.example config --quiet
```

Expected：生成代码无额外变化；`go.mod` / `go.sum` 已整洁；后端测试与 lint 通过；前端类型检查、lint、测试、`i18n 检查通过`、构建成功；compose 配置校验通过。

- [ ] **Step 10: 提交**

```bash
git add api/internal/payment api/db/queries/payment.sql api/sqlc.yaml \
  api/openapi/openapi.yaml api/internal/httpapi/apigen packages/api-client/src/schema.d.ts \
  api/internal/httpapi/server.go api/internal/httpapi/router.go \
  api/internal/httpapi/events_http_test.go api/internal/httpapi/payment_accounts_http_test.go \
  api/cmd/werun/app.go api/cmd/werun/router.go \
  web/admin/src/payments web/admin/src/pages/PaymentAccountsPage.tsx web/admin/src/pages/PaymentAccountsPage.test.tsx \
  web/admin/src/routes.tsx web/admin/src/layout/AppLayout.tsx web/admin/src/test/fixtures.ts \
  packages/i18n/locales/zh/admin.json packages/i18n/locales/en/admin.json packages/i18n/locales/km/admin.json
git commit -m "$(cat <<'EOF'
feat: add payment accounts with QR upload and public file endpoint

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
)"
```
