# 第 4 段：凭证与审核（Task 15–19）

> `00-overview.md` 的 Global Constraints、「与 spec 的实现调整」和「跨任务契约」对本文件每个任务都生效；本文件使用的名字、签名、operationId、错误码、审计 action、testid、路由、文案命名空间均以它为准。下面「契约补充」只列 00-overview 没有写到、而本段必须用到的内容。

**前置状态**：Task 1–14 已按 00-overview 完成。特别是：

- `payment.NewService(pool *pgxpool.Pool, files storage.Store, now func() time.Time)`（Task 6，尚无 `orders` 参数）、`OpenPublicFile`、`OpenPrivateFile` 可用，`db/queries/payment.sql` 与 `internal/payment/store` 已存在；
- `registration.NewService`、`ConfirmPaid`、`GetMyOrder`、`CancelOrder`（Task 12–13）可用，`db/queries/registration.sql` 与 `internal/registration/store` 已存在；
- `runner.SignInitData`、`(*runner.Service).LoginTelegram / Authenticate`、`runner.UserFrom`（Task 7）可用；
- `httpapi.RouterDeps` 已有 `Runner`、`Pricing`、`Registration`、`Payment` 字段；
- 后台 `can.ts` 已导出 `PERM_PROOF_REVIEW`、`PERM_ORDER_VIEW`；api-client 已导出 `formatUsd`、`parseUsdToCents`；
- 用户端（Task 10、14）：`RequireRunner` 布局路由下有 `orders/:orderNo`（`OrderDetailPage`，已有状态、金额、去付款与二次确认取消）；`web/user/src/orders/api.ts` 的 `useMyOrder`、`useCancelOrder`；`web/user/src/format.ts` 的 `pickText`、`formatDateTime`；测试辅助 `web/user/src/test/runner.ts` 的 `signInRunner`、`routeHandler` 与 `web/user/src/test/orderFixtures.ts` 的 `orderDetail(overrides)`；`GET /app/orders/{orderNo}` 响应为 `Schemas["OrderDetail"]`（`eventName`、`participants[].categoryName` 为 `LocalizedText`，`lastRejection` 为可选 `OrderRejection{code, reason?, reviewedAt}`）。

---

## 契约补充

1. **`payment.(*Service).OpenProofFile`**（Task 17 新增导出方法）

   ```go
   // OpenProofFile 只打开被 payment_proofs.file_id 引用的文件；其他文件（含收款二维码）一律 NOT_FOUND(404)。
   func (s *Service) OpenProofFile(ctx context.Context, id int64) (storage.File, io.ReadCloser, error)
   ```

   原因：任务要求 `adminGetFile` 只返回 `PAYMENT_PROOF` 文件，而契约里的 `storage.File` 没有 `Purpose` 字段、`OpenPrivateFile` 也没有约定按用途过滤。`adminGetFile` 的 handler 调用它，内部校验后委托 `OpenPrivateFile`。

2. **`registration.AdminOrderDetailToAPI`**（Task 16 新增导出函数）

   ```go
   func AdminOrderDetailToAPI(d AdminOrderDetail) apigen.AdminOrderDetail
   ```

   原因：`adminGetOrder`（registration 的 handler）与 `adminGetProof / adminApproveProof / adminRejectProof`（payment 的 handler，响应 `ProofDetail.order`）返回同一个 JSON 结构，转换函数只写一份。

3. **`registration.ConfirmPaid` 接受 `PROOF_SUBMITTED`**：Task 17 在 `status = 'PROOF_SUBMITTED'` 的订单上调用 `ConfirmPaid(ctx, tx, orderID, receivedAt)`。它的订单条件更新必须同时接受 `PENDING_PAYMENT`（0 元订单）与 `PROOF_SUBMITTED`，且要求 `reservation_state = 'RESERVED'`。Task 17 Step 1 核对，不满足时按该步骤修改。

4. **测试辅助包 `internal/payment/paytest`**（Task 15 新建，仅供 `_test.go` 导入）：导出 `Env`/`NewEnv`、`Clock`、`RecordingStore`、`Fixture`/`SeedEvent`、`SeedUser`、`SeedStaff`、`OrderSpec`/`OrderRef`/`SeedOrder`、`SeedProof`、`PNG`、`Count`，常量 `BotToken`、`PriceCents`、`CouponDiscountCents`。Task 20、21 修改 `payment.NewService` / `registration.NewService` 签名时同步修改 `paytest.NewEnv`。

5. **`idgen.Retry` 在事务内使用时，`fn` 自己开保存点**：PostgreSQL 事务里一条语句失败后整个事务不可再用，所以本段在 `idgen.Retry` 的 `fn` 中通过 `tx.Begin(ctx)`（pgx 在事务内即 `SAVEPOINT`）执行插入，失败时回滚到保存点，由 `idgen.Retry` 判断是否重试。`idgen` 本身不改。

6. **HTTP 状态**：`appSubmitProof` 成功返回 `201`；`adminApproveProof`、`adminRejectProof` 成功返回 `200` + `ProofDetail`；`adminGetFile` 成功返回 `200` + 图片字节，响应头 `Cache-Control: private, no-store`。

---

## 执行前核对

本段要改 Task 6、12–14 写的文件，下面这些名字 00-overview 没有写死。先执行核对命令；实际名字不同时，把本文件代码里的**调用点**改成实际名字（不改契约里的名字）。

```bash
cd api
grep -n "type Service struct" -A 6 internal/payment/service.go          # 假定字段 pool、files、now
grep -n "type Handlers struct" -A 3 internal/payment/handlers.go         # 假定字段 svc
grep -n "type Service struct" -A 8 internal/registration/service.go     # 假定字段 pool
grep -n "func (s \*Service) loadDetail\|func decodeText" internal/registration/*.go   # Task 12–13 包内函数，Task 16 复用
grep -n "MarkOrderPaid" -A 10 db/queries/registration.sql                # ConfirmPaid 的条件须含 PROOF_SUBMITTED（契约补充 3）
grep -n "type Handlers struct" -A 3 internal/registration/handlers.go    # 假定字段 svc
grep -n "^-- name:" db/queries/registration.sql db/queries/payment.sql   # 本段新增的查询名不得与已有重名（见各任务 SQL）
grep -rn "func inSavepoint\|func normalizeTxnRef\|func proofFromRow\|func proofToAPI\|func readProofForm\|func orderFromLockedRow\|func escapeLike\|func adminTextToAPI" internal/payment internal/registration   # 应无输出
grep -n "Runner \|Pricing \|Registration \|Payment " internal/httpapi/router.go   # RouterDeps 字段
grep -n "assert.Len(t, apperr.AllCodes" internal/platform/apperr/apperr_test.go  # Task 14 结束时应为 33
grep -n "payment.NewService(" -r . | grep -v "^./internal/payment/service.go"    # Task 15 需要改的调用点
cd ..
grep -n "orders/:orderNo\|RequireRunner" web/user/src/routes.tsx
grep -n "export function useMyOrder\|export function useCancelOrder" web/user/src/orders/api.ts
grep -n "export function pickText\|export function formatDateTime" web/user/src/format.ts
grep -n "export function signInRunner\|export function routeHandler" web/user/src/test/runner.ts
grep -n "export function orderDetail" web/user/src/test/orderFixtures.ts
grep -n "setIsCancelling\|const \[confirming, setConfirming\]\|data-testid=\"form-error\"" web/user/src/pages/OrderDetailPage.tsx
grep -n "PERM_PROOF_REVIEW\|PERM_ORDER_VIEW" web/admin/src/auth/can.ts
grep -n '        OrderDetail: {' -A 3 packages/api-client/src/schema.d.ts
```

数据库测试需要 Docker；本机为 colima 时，本文件所有 `go test` 命令前先执行：

```bash
export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true
```

---

### Task 15: 上传凭证

**Files:**
- Modify: `api/internal/platform/apperr/apperr.go`（新增 `CodeOrderExpired`、`CodeProofTxnRefUsed`）
- Modify: `api/internal/platform/apperr/apperr_test.go`（错误码数量 33 → 35）
- Modify: `api/internal/platform/i18n/messages.zh.json`、`messages.en.json`、`messages.km.json`
- Modify: `api/db/queries/registration.sql`（追加 2 个查询）
- Modify: `api/db/queries/payment.sql`（追加 1 个查询）
- Generate: `api/internal/registration/store/`、`api/internal/payment/store/`
- Create: `api/internal/registration/locks.go`
- Modify: `api/internal/payment/service.go`（`Service` 增加 `orders`，`NewService` 改签名）
- Create: `api/internal/payment/proofs.go`
- Create: `api/internal/payment/proofs_internal_test.go`
- Create: `api/internal/payment/paytest/paytest.go`
- Create: `api/internal/payment/proofs_test.go`
- Modify: `api/openapi/openapi.yaml`（新增 `appSubmitProof`、`SubmitProofForm`、`Proof`）
- Generate: `api/internal/httpapi/apigen/api.gen.go`、`api/internal/httpapi/apigen/permissions.gen.go`、`packages/api-client/src/schema.d.ts`
- Create: `api/internal/payment/proof_handlers.go`
- Modify: `api/cmd/werun/app.go`（先建 `Registration` 再建 `Payment`）
- Modify: Task 6 中所有调用 `payment.NewService(` 的测试文件（核对命令列出的位置）
- Create: `api/internal/httpapi/payment_env_test.go`
- Create: `api/internal/httpapi/proofs_http_test.go`

**Interfaces:**
- Consumes:
  - `storage.ReadImage(r io.Reader, maxBytes int64) (Image, error)`、`storage.NewKey(now time.Time, ext string) string`、`storage.InsertFile(ctx, tx, FileRecord) (int64, error)`、`storage.CountOtherFilesWithSHA256(ctx, tx, sha []byte, purpose string, excludeID int64) (int64, error)`、`storage.Store`、`storage.NewDisk(root string) (*Disk, error)`、`storage.ErrNotFound`、`storage.MaxProofBytes`
  - `idgen.Code(prefix string) string`、`idgen.PrefixProof`、`idgen.PrefixOrder`、`idgen.PrefixRegistration`、`idgen.TicketCode() string`、`idgen.Retry(constraint string, fn func() error) error`
  - `piicrypt.New(key []byte) (*Cipher, error)`
  - `runner.User`、`runner.NewService(pool, sessionSecret, botToken, pii, now) *Service`、`runner.SignInitData(botToken string, u TelegramUser, authDate time.Time) string`、`(*runner.Service).LoginTelegram(ctx, initData string, meta httpx.Meta) (Session, error)`、`runner.UserFrom(ctx) (User, bool)`
  - `pricing.NewService(pool *pgxpool.Pool, now func() time.Time) *Service`
  - `registration.NewService(pool, runners, prices, now) *Service`、`registration.Order`
  - `db.InTx`、`audit.Record`、`audit.Entry`、`apperr.*`、`httpx.Meta`、`httpx.MetaOf`、`dbtest.NewPool`
- Produces:
  - `func (s *registration.Service) LockOrderByNo(ctx context.Context, tx pgx.Tx, orderNo string) (Order, error)`
  - `func (s *registration.Service) MarkProofSubmitted(ctx context.Context, tx pgx.Tx, orderID int64) error`
  - `func payment.NewService(pool *pgxpool.Pool, files storage.Store, orders *registration.Service, now func() time.Time) *Service`
  - `payment.SubmitProofInput`、`payment.Proof`（字段同 00-overview）
  - `func (s *payment.Service) SubmitProof(ctx context.Context, u runner.User, orderNo string, in SubmitProofInput, meta httpx.Meta) (Proof, error)`
  - 约束映射 `payment_proofs_txn_ref_uniq` → `PROOF_TXN_REF_USED`(409，字段 `bankTxnRef`)
  - 错误码 `CodeOrderExpired = "ORDER_EXPIRED"`(409)、`CodeProofTxnRefUsed = "PROOF_TXN_REF_USED"`(409)
  - 审计 `payment_proof.submit`（`ActorType = "USER"`，`IsFinancial = true`）
  - OpenAPI `appSubmitProof`（`POST /app/orders/{orderNo}/proofs`，`x-auth: app`，multipart），schema `SubmitProofForm`、`Proof`
  - `(*payment.Handlers).AppSubmitProof`
  - 测试包 `paytest`（契约补充 4）

**要点**

- 字段级错误用 422 `VALIDATION_FAILED`，字段名：`file`、`bankTxnRef`、`declaredAmountCents`、`declaredPaidAt`、`payerName`。
- 事务内顺序与 spec 6.2 一致：锁订单 → 归属（他人订单返回 `ORDER_NOT_FOUND`）→ 状态（`ORDER_STATE_CONFLICT`）→ 截止时间（`deadline_at <= now` 返回 `ORDER_EXPIRED`）→ 交易号与金额校验 → 写 `files` → 重复截图检测 → 写凭证 → 订单改 `PROOF_SUBMITTED` → 审计。事务返回任何错误都尽力删除已写入存储的文件。
- 并发同交易号：两单各锁自己的订单行，插入 `payment_proofs` 时第二个事务在部分唯一索引上等待第一个提交，随后得到唯一冲突，映射为 `PROOF_TXN_REF_USED`。

- [ ] **Step 1: 执行「执行前核对」中的命令，记下与假定不同的名字**

Run: 上文「执行前核对」代码块。
Expected: `assert.Len(t, apperr.AllCodes, 33)`；`inSavepoint` 等函数名 grep 无输出；其余名字与假定一致，或已记下实际名字。

- [ ] **Step 2: 把错误码数量测试改为 35，确认失败**

`api/internal/platform/apperr/apperr_test.go`：

```go
	assert.Len(t, apperr.AllCodes, 33)
```

改为：

```go
	assert.Len(t, apperr.AllCodes, 35)
```

Run: `cd api && go test ./internal/platform/apperr/ -run TestAllCodesAreUnique`
Expected: FAIL，`"[...]" should have 35 item(s), but has 33`。

- [ ] **Step 3: 新增错误码常量，确认文案完整性测试失败**

`api/internal/platform/apperr/apperr.go` 的常量块，在最后一个常量（Task 13 的 `CodeOrderNotFound`）之后追加（gofmt 会重新对齐等号）：

```go
	CodeOrderExpired            = "ORDER_EXPIRED"
	CodeProofTxnRefUsed         = "PROOF_TXN_REF_USED"
```

`AllCodes` 末尾（`CodeOrderNotFound,` 之后）追加：

```go
	CodeOrderExpired,
	CodeProofTxnRefUsed,
```

Run: `cd api && gofmt -w internal/platform/apperr/apperr.go && go test ./internal/platform/apperr/ ./internal/platform/i18n/`
Expected: `apperr` 包 PASS；`i18n` 包 FAIL，`TestEmbeddedCatalogCoversAllCodesAndFieldKeys` 报 `missing ORDER_EXPIRED for zh`、`missing PROOF_TXN_REF_USED for zh` 等。

- [ ] **Step 4: 补三语文案，确认通过**

`api/internal/platform/i18n/messages.zh.json`，把

```json
  "field.required": "必填。",
```

改为

```json
  "ORDER_EXPIRED": "订单已过截止时间，请重新报名。",
  "PROOF_TXN_REF_USED": "这个交易号已被其他凭证或到账记录使用，请核对后重新填写。",
  "field.required": "必填。",
```

`api/internal/platform/i18n/messages.en.json`，把

```json
  "field.required": "Required.",
```

改为

```json
  "ORDER_EXPIRED": "This order has passed its deadline. Please register again.",
  "PROOF_TXN_REF_USED": "This transaction reference is already used by another payment proof or receipt. Check it and try again.",
  "field.required": "Required.",
```

`api/internal/platform/i18n/messages.km.json`，把

```json
  "field.required": "ត្រូវតែបំពេញ។",
```

改为

```json
  "ORDER_EXPIRED": "ការបញ្ជាទិញនេះហួសពេលកំណត់ហើយ។ សូមចុះឈ្មោះម្ដងទៀត។",
  "PROOF_TXN_REF_USED": "លេខប្រតិបត្តិការនេះត្រូវបានប្រើដោយភស្តុតាងបង់ប្រាក់ ឬកំណត់ត្រាទទួលប្រាក់ផ្សេងរួចហើយ។ សូមពិនិត្យ ហើយបញ្ចូលម្ដងទៀត។",
  "field.required": "ត្រូវតែបំពេញ។",
```

Run: `cd api && go test ./internal/platform/apperr/ ./internal/platform/i18n/`
Expected: 两个包 `ok`。

- [ ] **Step 5: 追加 sqlc 查询并生成**

在 `api/db/queries/registration.sql` 文件末尾追加：

```sql
-- name: LockRegOrderByNo :one
SELECT * FROM reg_orders
WHERE order_no = @order_no
FOR UPDATE;

-- name: SetOrderProofSubmitted :execrows
UPDATE reg_orders
SET status = 'PROOF_SUBMITTED',
    deadline_at = NULL,
    version = version + 1
WHERE id = @id
  AND reservation_state = 'RESERVED'
  AND status IN ('PENDING_PAYMENT', 'PROOF_REJECTED');
```

在 `api/db/queries/payment.sql` 文件末尾追加：

```sql
-- name: InsertPaymentProof :one
INSERT INTO payment_proofs (
  proof_no, reg_order_id, payment_account_id, file_id, submitted_by_user_id,
  declared_amount_cents, declared_currency, bank_txn_ref, declared_paid_at, payer_name, dup_file_hit
) VALUES (
  @proof_no, sqlc.arg(reg_order_id)::bigint, @payment_account_id, @file_id, sqlc.arg(submitted_by_user_id)::bigint,
  @declared_amount_cents, 'USD', @bank_txn_ref, @declared_paid_at, @payer_name, @dup_file_hit
)
RETURNING *;
```

Run: `cd api && go tool sqlc generate && grep -n "func (q \*Queries) LockRegOrderByNo\|func (q \*Queries) SetOrderProofSubmitted" internal/registration/store/*.go && grep -n "type InsertPaymentProofParams struct" -A 12 internal/payment/store/payment.sql.go`
Expected: 生成成功；`LockRegOrderByNo(ctx context.Context, orderNo string) (RegOrder, error)`、`SetOrderProofSubmitted(ctx context.Context, id int64) (int64, error)`；`InsertPaymentProofParams` 含 `RegOrderID int64`、`SubmittedByUserID int64`、`DeclaredPaidAt *time.Time`、`PayerName *string`、`DupFileHit bool`。

- [ ] **Step 6: 新建测试辅助包 `paytest`**

创建 `api/internal/payment/paytest/paytest.go`：

```go
// Package paytest 为凭证、审核与订单查询的测试准备数据库数据和服务。只允许在 _test.go 中导入。
package paytest

import (
	"bytes"
	"cmp"
	"context"
	"crypto/rand"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"werun/api/internal/iam"
	"werun/api/internal/payment"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/idgen"
	"werun/api/internal/platform/piicrypt"
	"werun/api/internal/platform/storage"
	"werun/api/internal/pricing"
	"werun/api/internal/registration"
	"werun/api/internal/runner"
)

const (
	// BotToken 是测试用的机器人 token，runner 服务与 SignInitData 共用。
	BotToken = "123456:paytest-token"
	// PriceCents 是 SeedEvent 建的价格档单价。
	PriceCents int64 = 2500
	// CouponDiscountCents 是 SeedEvent 建的固定金额优惠码减免。
	CouponDiscountCents int64 = 500
)

var (
	sessionSecret = []byte(strings.Repeat("s", 32))
	piiKey        = []byte("0123456789abcdef0123456789abcdef")
)

// Clock 是可前进的测试时钟，所有服务共用。
type Clock struct {
	mu  sync.Mutex
	now time.Time
}

func NewClock(t time.Time) *Clock { return &Clock{now: t.UTC()} }

func (c *Clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *Clock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

// RecordingStore 包装真实的磁盘存储，记录 Put 与 Delete 的键。
type RecordingStore struct {
	storage.Store
	mu      sync.Mutex
	puts    []string
	deletes []string
}

func (s *RecordingStore) Put(ctx context.Context, key string, r io.Reader) error {
	s.mu.Lock()
	s.puts = append(s.puts, key)
	s.mu.Unlock()
	return s.Store.Put(ctx, key, r)
}

func (s *RecordingStore) Delete(ctx context.Context, key string) error {
	s.mu.Lock()
	s.deletes = append(s.deletes, key)
	s.mu.Unlock()
	return s.Store.Delete(ctx, key)
}

func (s *RecordingStore) Puts() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.puts)
}

func (s *RecordingStore) Deletes() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.deletes)
}

// Env 是一套连到独立测试库的服务。
type Env struct {
	Pool     *pgxpool.Pool
	Store    *RecordingStore
	Clock    *Clock
	IAM      *iam.Service
	Runners  *runner.Service
	Prices   *pricing.Service
	Orders   *registration.Service
	Payments *payment.Service
}

func NewEnv(t testing.TB) *Env {
	t.Helper()
	pool := dbtest.NewPool(t)
	disk, err := storage.NewDisk(t.TempDir())
	require.NoError(t, err)
	pii, err := piicrypt.New(piiKey)
	require.NoError(t, err)

	clock := NewClock(time.Now().Truncate(time.Second))
	files := &RecordingStore{Store: disk}
	runners := runner.NewService(pool, sessionSecret, BotToken, pii, clock.Now)
	prices := pricing.NewService(pool, clock.Now)
	orders := registration.NewService(pool, runners, prices, clock.Now)
	return &Env{
		Pool:     pool,
		Store:    files,
		Clock:    clock,
		IAM:      iam.NewService(pool, sessionSecret, iam.NewLoginLimiter(time.Now), time.Now),
		Runners:  runners,
		Prices:   prices,
		Orders:   orders,
		Payments: payment.NewService(pool, files, orders, clock.Now),
	}
}

// Fixture 是一场已发布、开放报名的 RACE 赛事，带一个组别、一个价格档、一个优惠码和一个收款账户。
type Fixture struct {
	EventID, CategoryID, PriceRuleID, CouponID, AccountID, QRFileID int64
}

func SeedEvent(t testing.TB, pool *pgxpool.Pool) Fixture {
	t.Helper()
	ctx := context.Background()
	suffix := idgen.Code("")
	var fx Fixture

	require.NoError(t, pool.QueryRow(ctx, `
		INSERT INTO events (slug, event_type, organizer_type, name, city, race_date, status, registration_open, public_visible, published_at)
		VALUES ($1, 'RACE', 'OFFICIAL',
		        '{"zh":"金边半程马拉松 2026","en":"Phnom Penh Half Marathon 2026","km":"ម៉ារ៉ាតុងពាក់កណ្ដាលភ្នំពេញ ២០២៦"}',
		        'Phnom Penh', DATE '2026-11-15', 'PUBLISHED', true, true, now())
		RETURNING id`, "paytest-"+strings.ToLower(suffix)).Scan(&fx.EventID))
	require.NoError(t, pool.QueryRow(ctx, `
		INSERT INTO event_categories (event_id, code, name, distance_m, capacity)
		VALUES ($1, '21K', '{"zh":"半程 21K","en":"Half Marathon 21K","km":"ពាក់កណ្ដាលម៉ារ៉ាតុង 21K"}', 21097, 100)
		RETURNING id`, fx.EventID).Scan(&fx.CategoryID))
	require.NoError(t, pool.QueryRow(ctx, `
		INSERT INTO price_rules (event_id, name, audience, price_cents)
		VALUES ($1, '{"zh":"标准价","en":"Standard","km":"តម្លៃស្តង់ដារ"}', 'ALL', $2)
		RETURNING id`, fx.EventID, PriceCents).Scan(&fx.PriceRuleID))
	_, err := pool.Exec(ctx, `INSERT INTO category_price_rules (category_id, price_rule_id) VALUES ($1, $2)`, fx.CategoryID, fx.PriceRuleID)
	require.NoError(t, err)
	require.NoError(t, pool.QueryRow(ctx, `
		INSERT INTO coupons (code, event_id, discount_type, discount_value, quota)
		VALUES ($1, $2, 'AMOUNT', $3, 10)
		RETURNING id`, "PAY"+suffix, fx.EventID, CouponDiscountCents).Scan(&fx.CouponID))
	fx.QRFileID = seedFile(t, pool, "PUBLIC", "PAYMENT_QR")
	require.NoError(t, pool.QueryRow(ctx, `
		INSERT INTO payment_accounts (name, provider, account_name, account_no_masked, currency, qr_file_id, scope)
		VALUES ('ABA USD 主收款户', 'ABA', 'WERUN SPORTS CO LTD', '*** *** 123', 'USD', $1, 'REGISTRATION')
		RETURNING id`, fx.QRFileID).Scan(&fx.AccountID))
	return fx
}

// SeedUser 直接写 users 行，返回对应的 runner.User。
func SeedUser(t testing.TB, pool *pgxpool.Pool, telegramID int64, name string) runner.User {
	t.Helper()
	username := fmt.Sprintf("runner%d", telegramID)
	var id int64
	require.NoError(t, pool.QueryRow(context.Background(), `
		INSERT INTO users (telegram_user_id, telegram_username, display_name, locale)
		VALUES ($1, $2, $3, 'en')
		RETURNING id`, telegramID, username, name).Scan(&id))
	return runner.User{ID: id, TelegramUserID: telegramID, TelegramUsername: username, DisplayName: name, Locale: "en"}
}

// SeedStaff 直接写 staff 行（不可登录），用于服务层测试的操作人。
func SeedStaff(t testing.TB, pool *pgxpool.Pool, role iam.Role) iam.Staff {
	t.Helper()
	username := "paytest." + strings.ToLower(string(role)) + "." + strings.ToLower(idgen.Code(""))
	fullName := "Paytest " + string(role)
	var id int64
	require.NoError(t, pool.QueryRow(context.Background(), `
		INSERT INTO staff (username, full_name, role, password_hash)
		VALUES ($1, $2, $3, 'paytest-no-login')
		RETURNING id`, username, fullName, string(role)).Scan(&id))
	return iam.Staff{ID: id, Username: username, FullName: fullName, Role: role}
}

// OrderSpec 描述要直接写入数据库的订单。零值为 1 人、无优惠码、识别分 1 分的待付款订单。
type OrderSpec struct {
	Status       string     // "" | PENDING_PAYMENT | PROOF_SUBMITTED | PROOF_REJECTED
	DeadlineAt   *time.Time // nil 时：PENDING_PAYMENT 为 now+30m，PROOF_REJECTED 为 now+24h，PROOF_SUBMITTED 为 NULL
	Participants int        // 0 视为 1
	WithCoupon   bool
	IdentOffset  int64  // 0 视为 1
	BuyerName    string // "" 视为 "Sokha Chan"
	BuyerPhone   string // "" 视为 "+85512345678"
}

type OrderRef struct {
	ID              int64
	OrderNo         string
	ListAmountCents int64
	DiscountCents   int64
	AmountCents     int64
}

// SeedOrder 写订单、参赛人快照、待确认报名，并按人数占用组别与价格档的 reserved_count；WithCoupon 时同时占用优惠码并写核销行。
func SeedOrder(t testing.TB, env *Env, fx Fixture, u runner.User, spec OrderSpec) OrderRef {
	t.Helper()
	ctx := context.Background()
	status := cmp.Or(spec.Status, "PENDING_PAYMENT")
	participants := max(spec.Participants, 1)
	ident := cmp.Or(spec.IdentOffset, 1)
	buyerName := cmp.Or(spec.BuyerName, "Sokha Chan")
	buyerPhone := cmp.Or(spec.BuyerPhone, "+85512345678")

	var deadline *time.Time
	switch status {
	case "PENDING_PAYMENT":
		d := env.Clock.Now().Add(30 * time.Minute)
		deadline = &d
	case "PROOF_REJECTED":
		d := env.Clock.Now().Add(24 * time.Hour)
		deadline = &d
	case "PROOF_SUBMITTED":
	default:
		t.Fatalf("paytest: SeedOrder 不支持状态 %s", status)
	}
	if spec.DeadlineAt != nil {
		deadline = spec.DeadlineAt
	}

	list := int64(participants) * PriceCents
	var couponID *int64
	var couponDiscount int64
	if spec.WithCoupon {
		couponID = &fx.CouponID
		couponDiscount = CouponDiscountCents
	}
	discount := couponDiscount + ident
	ref := OrderRef{OrderNo: idgen.Code(idgen.PrefixOrder), ListAmountCents: list, DiscountCents: discount, AmountCents: list - discount}

	require.NoError(t, env.Pool.QueryRow(ctx, `
		INSERT INTO reg_orders (order_no, event_id, buyer_user_id, buyer_name, buyer_phone_e164, status, reservation_state,
		                        list_amount_cents, discount_cents, ident_offset_cents, amount_cents, currency,
		                        coupon_id, payment_account_id, deadline_at, source)
		VALUES ($1, $2, $3, $4, $5, $6, 'RESERVED', $7, $8, $9, $10, 'USD', $11, $12, $13, 'TELEGRAM')
		RETURNING id`,
		ref.OrderNo, fx.EventID, u.ID, buyerName, buyerPhone, status,
		list, discount, ident, ref.AmountCents, couponID, fx.AccountID, deadline).Scan(&ref.ID))

	for i := range participants {
		paid := PriceCents
		name := buyerName
		if i == 0 {
			paid -= discount
		} else {
			name = fmt.Sprintf("%s %d", buyerName, i+1)
		}
		var participantID int64
		require.NoError(t, env.Pool.QueryRow(ctx, `
			INSERT INTO order_participants (order_id, category_id, price_rule_id, audience, list_price_cents, paid_cents, snapshot_name)
			VALUES ($1, $2, $3, 'ALL', $4, $5, $6)
			RETURNING id`, ref.ID, fx.CategoryID, fx.PriceRuleID, PriceCents, paid, name).Scan(&participantID))
		_, err := env.Pool.Exec(ctx, `
			INSERT INTO registrations (reg_no, order_participant_id, event_id, category_id, status, ticket_code, user_id,
			                           full_name, gender, birth_date, nationality, id_type, phone_e164,
			                           emergency_name, emergency_phone, tshirt_size)
			VALUES ($1, $2, $3, $4, 'PENDING', $5, $6, $7, 'F', DATE '1994-03-12', 'KH', 'NATIONAL_ID', $8,
			        'Dara Chan', '+85598765432', 'M')`,
			idgen.Code(idgen.PrefixRegistration), participantID, fx.EventID, fx.CategoryID, idgen.TicketCode(), u.ID, name, buyerPhone)
		require.NoError(t, err)
	}

	_, err := env.Pool.Exec(ctx, `UPDATE event_categories SET reserved_count = reserved_count + $2 WHERE id = $1`, fx.CategoryID, participants)
	require.NoError(t, err)
	_, err = env.Pool.Exec(ctx, `UPDATE price_rules SET reserved_count = reserved_count + $2 WHERE id = $1`, fx.PriceRuleID, participants)
	require.NoError(t, err)
	if spec.WithCoupon {
		_, err = env.Pool.Exec(ctx, `UPDATE coupons SET reserved_count = reserved_count + 1 WHERE id = $1`, fx.CouponID)
		require.NoError(t, err)
		_, err = env.Pool.Exec(ctx, `
			INSERT INTO coupon_redemptions (order_id, coupon_id, state, discount_cents)
			VALUES ($1, $2, 'RESERVED', $3)`, ref.ID, fx.CouponID, CouponDiscountCents)
		require.NoError(t, err)
	}
	return ref
}

// SeedProof 直接写一份凭证。status 为 REJECTED 时原因码 UNREADABLE、说明「截图看不清」；REJECTED / APPROVED 会建一个审核员。
func SeedProof(t testing.TB, env *Env, fx Fixture, order OrderRef, u runner.User, status, txnRef string, createdAt time.Time) int64 {
	t.Helper()
	var reviewedBy *int64
	var reviewedAt *time.Time
	var rejectCode, rejectReason *string
	switch status {
	case "SUBMITTED":
	case "APPROVED", "REJECTED":
		reviewer := SeedStaff(t, env.Pool, iam.RoleFinance)
		at := createdAt.Add(10 * time.Minute)
		reviewedBy, reviewedAt = &reviewer.ID, &at
		if status == "REJECTED" {
			code, reason := "UNREADABLE", "截图看不清"
			rejectCode, rejectReason = &code, &reason
		}
	default:
		t.Fatalf("paytest: SeedProof 不支持状态 %s", status)
	}
	fileID := seedFile(t, env.Pool, "PRIVATE", "PAYMENT_PROOF")
	var id int64
	require.NoError(t, env.Pool.QueryRow(context.Background(), `
		INSERT INTO payment_proofs (proof_no, reg_order_id, payment_account_id, file_id, submitted_by_user_id,
		                            declared_amount_cents, declared_currency, bank_txn_ref, status,
		                            reviewed_by, reviewed_at, reject_code, reject_reason, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, 'USD', $7, $8, $9, $10, $11, $12, $13)
		RETURNING id`,
		idgen.Code(idgen.PrefixProof), order.ID, fx.AccountID, fileID, u.ID, order.AmountCents, txnRef, status,
		reviewedBy, reviewedAt, rejectCode, rejectReason, createdAt).Scan(&id))
	return id
}

// PNG 返回一张 8×8 的纯色 PNG；shade 不同，内容与 sha256 就不同。
func PNG(t testing.TB, shade uint8) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for x := range 8 {
		for y := range 8 {
			img.Set(x, y, color.RGBA{R: shade, G: 64, B: 128, A: 255})
		}
	}
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, img))
	return buf.Bytes()
}

// Count 执行返回单个整数的查询。
func Count(t testing.TB, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	require.NoError(t, pool.QueryRow(context.Background(), sql, args...).Scan(&n))
	return n
}

func seedFile(t testing.TB, pool *pgxpool.Pool, visibility, purpose string) int64 {
	t.Helper()
	sha := make([]byte, 32)
	_, err := rand.Read(sha)
	require.NoError(t, err)
	var id int64
	require.NoError(t, pool.QueryRow(context.Background(), `
		INSERT INTO files (storage_key, visibility, purpose, mime_type, size_bytes, sha256, width, height, uploaded_by_type)
		VALUES ($1, $2, $3, 'image/png', 128, $4, 8, 8, 'SYSTEM')
		RETURNING id`, "paytest/"+strings.ToLower(idgen.Code(""))+".png", visibility, purpose, sha).Scan(&id))
	return id
}
```

Run: `cd api && go vet ./internal/payment/paytest/`
Expected: 编译失败，报 `too many arguments in call to payment.NewService`（`NewService` 仍是 Task 6 的三参数签名）。这是下一步要改的。

- [ ] **Step 7: 写服务层失败测试**

创建 `api/internal/payment/proofs_internal_test.go`：

```go
package payment

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestNormalizeTxnRefRemovesAllWhitespaceAndUppercases(t *testing.T) {
	require.Equal(t, "ABA778899", normalizeTxnRef(" aba 7788\t99\n"))
	require.Equal(t, "AB-12", normalizeTxnRef("ab-12"))
	require.Equal(t, "ABCD", normalizeTxnRef("\u3000ab\u3000cd"))
	require.Empty(t, normalizeTxnRef(""))
}
```

创建 `api/internal/payment/proofs_test.go`：

```go
package payment_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"werun/api/internal/payment"
	"werun/api/internal/payment/paytest"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/storage"
)

var testMeta = httpx.Meta{RequestID: "req-proof-test", IP: "203.0.113.7", UserAgent: "proofs-test"}

func proofInput(file []byte, txnRef string, amount int64) payment.SubmitProofInput {
	return payment.SubmitProofInput{File: bytes.NewReader(file), BankTxnRef: txnRef, DeclaredAmountCents: amount}
}

func requireAppErr(t *testing.T, err error, code string, status int) *apperr.Error {
	t.Helper()
	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	require.Equal(t, code, ae.Code)
	require.Equal(t, status, ae.Status)
	return ae
}

func orderState(t *testing.T, env *paytest.Env, orderID int64) (string, *time.Time) {
	t.Helper()
	var status string
	var deadline *time.Time
	require.NoError(t, env.Pool.QueryRow(context.Background(),
		`SELECT status, deadline_at FROM reg_orders WHERE id = $1`, orderID).Scan(&status, &deadline))
	return status, deadline
}

func TestSubmitProofMovesOrderToReview(t *testing.T) {
	env := paytest.NewEnv(t)
	ctx := context.Background()
	fx := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7001, "Sokha Chan")
	order := paytest.SeedOrder(t, env, fx, u, paytest.OrderSpec{})
	img := paytest.PNG(t, 10)
	paidAt := env.Clock.Now().Add(-5 * time.Minute)
	payer := "SOKHA CHAN"
	in := proofInput(img, "  aba 7788\t99 ", order.AmountCents)
	in.DeclaredPaidAt = &paidAt
	in.PayerName = &payer

	proof, err := env.Payments.SubmitProof(ctx, u, strings.ToLower(order.OrderNo), in, testMeta)

	require.NoError(t, err)
	require.True(t, strings.HasPrefix(proof.ProofNo, "PF"))
	require.Len(t, proof.ProofNo, 10)
	require.Equal(t, "ABA778899", proof.BankTxnRef)
	require.Equal(t, "SUBMITTED", proof.Status)
	require.Equal(t, order.ID, proof.OrderID)
	require.Equal(t, order.OrderNo, proof.OrderNo)
	require.Equal(t, fx.AccountID, proof.PaymentAccountID)
	require.Equal(t, order.AmountCents, proof.DeclaredAmountCents)
	require.False(t, proof.DupFileHit)
	require.NotNil(t, proof.DeclaredPaidAt)
	require.True(t, proof.DeclaredPaidAt.Equal(paidAt))
	require.Equal(t, &payer, proof.PayerName)
	require.Nil(t, proof.ReviewedAt)

	status, deadline := orderState(t, env, order.ID)
	require.Equal(t, "PROOF_SUBMITTED", status)
	require.Nil(t, deadline)

	var key, visibility, purpose, uploadedByType string
	var uploadedByID int64
	require.NoError(t, env.Pool.QueryRow(ctx, `
		SELECT storage_key, visibility, purpose, uploaded_by_type, uploaded_by_id FROM files WHERE id = $1`, proof.FileID).
		Scan(&key, &visibility, &purpose, &uploadedByType, &uploadedByID))
	require.Equal(t, "PRIVATE", visibility)
	require.Equal(t, "PAYMENT_PROOF", purpose)
	require.Equal(t, "USER", uploadedByType)
	require.Equal(t, u.ID, uploadedByID)
	require.Equal(t, []string{key}, env.Store.Puts())
	require.Empty(t, env.Store.Deletes())

	rc, err := env.Store.Open(ctx, key)
	require.NoError(t, err)
	stored, err := io.ReadAll(rc)
	require.NoError(t, rc.Close())
	require.NoError(t, err)
	require.Equal(t, img, stored)

	require.Equal(t, 1, paytest.Count(t, env.Pool, `
		SELECT count(*) FROM audit_logs
		WHERE action = 'payment_proof.submit' AND entity_type = 'payment_proof' AND entity_id = $1
		  AND actor_type = 'USER' AND actor_id = $2 AND is_financial AND request_id = 'req-proof-test'`, proof.ID, u.ID))
}

func TestSubmitProofAfterRejectionAllowsSameTxnRef(t *testing.T) {
	env := paytest.NewEnv(t)
	fx := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7002, "Sokha Chan")
	order := paytest.SeedOrder(t, env, fx, u, paytest.OrderSpec{Status: "PROOF_REJECTED"})
	paytest.SeedProof(t, env, fx, order, u, "REJECTED", "ABA778899", env.Clock.Now().Add(-2*time.Hour))

	proof, err := env.Payments.SubmitProof(context.Background(), u, order.OrderNo,
		proofInput(paytest.PNG(t, 11), "ABA 778899", order.AmountCents), testMeta)

	require.NoError(t, err)
	require.Equal(t, "ABA778899", proof.BankTxnRef)
	status, deadline := orderState(t, env, order.ID)
	require.Equal(t, "PROOF_SUBMITTED", status)
	require.Nil(t, deadline)
	require.Equal(t, 2, paytest.Count(t, env.Pool, `SELECT count(*) FROM payment_proofs WHERE reg_order_id = $1`, order.ID))
}

func TestSubmitProofExpiredOrder(t *testing.T) {
	env := paytest.NewEnv(t)
	fx := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7003, "Sokha Chan")
	past := env.Clock.Now().Add(-time.Minute)
	order := paytest.SeedOrder(t, env, fx, u, paytest.OrderSpec{DeadlineAt: &past})

	_, err := env.Payments.SubmitProof(context.Background(), u, order.OrderNo,
		proofInput(paytest.PNG(t, 12), "ABA778899", order.AmountCents), testMeta)

	requireAppErr(t, err, apperr.CodeOrderExpired, http.StatusConflict)
	status, _ := orderState(t, env, order.ID)
	require.Equal(t, "PENDING_PAYMENT", status)
	require.Equal(t, 0, paytest.Count(t, env.Pool, `SELECT count(*) FROM payment_proofs`))
	require.Len(t, env.Store.Puts(), 1)
	require.Equal(t, env.Store.Puts(), env.Store.Deletes())
}

func TestSubmitProofOnOthersOrderIsNotFound(t *testing.T) {
	env := paytest.NewEnv(t)
	ctx := context.Background()
	fx := paytest.SeedEvent(t, env.Pool)
	owner := paytest.SeedUser(t, env.Pool, 7004, "Sokha Chan")
	stranger := paytest.SeedUser(t, env.Pool, 7005, "Dara Meas")
	order := paytest.SeedOrder(t, env, fx, owner, paytest.OrderSpec{})

	_, err := env.Payments.SubmitProof(ctx, stranger, order.OrderNo,
		proofInput(paytest.PNG(t, 13), "ABA778899", order.AmountCents), testMeta)
	requireAppErr(t, err, apperr.CodeOrderNotFound, http.StatusNotFound)

	_, err = env.Payments.SubmitProof(ctx, owner, "WR00000000",
		proofInput(paytest.PNG(t, 13), "ABA778899", order.AmountCents), testMeta)
	requireAppErr(t, err, apperr.CodeOrderNotFound, http.StatusNotFound)

	status, _ := orderState(t, env, order.ID)
	require.Equal(t, "PENDING_PAYMENT", status)
	require.Equal(t, env.Store.Puts(), env.Store.Deletes())
}

func TestSubmitProofRequiresPayableOrderState(t *testing.T) {
	env := paytest.NewEnv(t)
	fx := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7006, "Sokha Chan")
	order := paytest.SeedOrder(t, env, fx, u, paytest.OrderSpec{Status: "PROOF_SUBMITTED"})

	_, err := env.Payments.SubmitProof(context.Background(), u, order.OrderNo,
		proofInput(paytest.PNG(t, 14), "ABA778899", order.AmountCents), testMeta)

	requireAppErr(t, err, apperr.CodeOrderStateConflict, http.StatusConflict)
	require.Equal(t, 0, paytest.Count(t, env.Pool, `SELECT count(*) FROM payment_proofs`))
}

func TestSubmitProofValidatesFields(t *testing.T) {
	env := paytest.NewEnv(t)
	fx := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7007, "Sokha Chan")
	order := paytest.SeedOrder(t, env, fx, u, paytest.OrderSpec{})
	longName := strings.Repeat("N", 101)

	cases := []struct {
		name  string
		in    payment.SubmitProofInput
		field string
		key   string
	}{
		{"交易号为空", proofInput(paytest.PNG(t, 20), "   ", order.AmountCents), "bankTxnRef", "field.required"},
		{"交易号去空白后不足 4 位", proofInput(paytest.PNG(t, 21), "ab 1", order.AmountCents), "bankTxnRef", "field.invalid"},
		{"交易号超过 64 位", proofInput(paytest.PNG(t, 22), strings.Repeat("A", 65), order.AmountCents), "bankTxnRef", "field.invalid"},
		{"金额为 0", proofInput(paytest.PNG(t, 23), "ABA778899", 0), "declaredAmountCents", "field.must_be_positive"},
		{"付款人超过 100 字", func() payment.SubmitProofInput {
			in := proofInput(paytest.PNG(t, 24), "ABA778899", order.AmountCents)
			in.PayerName = &longName
			return in
		}(), "payerName", "field.too_long"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := env.Payments.SubmitProof(context.Background(), u, order.OrderNo, tc.in, testMeta)
			ae := requireAppErr(t, err, apperr.CodeValidation, http.StatusUnprocessableEntity)
			require.Equal(t, tc.key, ae.Fields[tc.field].Key)
		})
	}
	require.Equal(t, 0, paytest.Count(t, env.Pool, `SELECT count(*) FROM payment_proofs`))
	require.Equal(t, 0, paytest.Count(t, env.Pool, `SELECT count(*) FROM files WHERE purpose = 'PAYMENT_PROOF'`))
	require.Len(t, env.Store.Puts(), len(cases))
	require.ElementsMatch(t, env.Store.Puts(), env.Store.Deletes())
}

func TestSubmitProofRejectsNonImageBeforeStoring(t *testing.T) {
	env := paytest.NewEnv(t)
	fx := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7008, "Sokha Chan")
	order := paytest.SeedOrder(t, env, fx, u, paytest.OrderSpec{})

	_, err := env.Payments.SubmitProof(context.Background(), u, order.OrderNo,
		proofInput([]byte("definitely not an image"), "ABA778899", order.AmountCents), testMeta)

	requireAppErr(t, err, apperr.CodeFileTypeNotAllowed, http.StatusUnsupportedMediaType)
	require.Empty(t, env.Store.Puts())
}

func TestSubmitProofSameTxnRefConcurrentlyOnlyOneSucceeds(t *testing.T) {
	env := paytest.NewEnv(t)
	ctx := context.Background()
	fx := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7009, "Sokha Chan")
	orders := []paytest.OrderRef{
		paytest.SeedOrder(t, env, fx, u, paytest.OrderSpec{IdentOffset: 1}),
		paytest.SeedOrder(t, env, fx, u, paytest.OrderSpec{IdentOffset: 2}),
	}
	images := [][]byte{paytest.PNG(t, 30), paytest.PNG(t, 31)}

	var wg sync.WaitGroup
	start := make(chan struct{})
	errs := make([]error, len(orders))
	for i, o := range orders {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, errs[i] = env.Payments.SubmitProof(ctx, u, o.OrderNo, proofInput(images[i], "ABA-CONCURRENT-01", o.AmountCents), testMeta)
		}()
	}
	close(start)
	wg.Wait()

	succeeded := 0
	for _, err := range errs {
		if err == nil {
			succeeded++
			continue
		}
		ae := requireAppErr(t, err, apperr.CodeProofTxnRefUsed, http.StatusConflict)
		require.Equal(t, apperr.CodeProofTxnRefUsed, ae.Fields["bankTxnRef"].Key)
	}
	require.Equal(t, 1, succeeded)
	require.Equal(t, 1, paytest.Count(t, env.Pool, `SELECT count(*) FROM payment_proofs WHERE bank_txn_ref = 'ABA-CONCURRENT-01'`))
	require.Equal(t, 1, paytest.Count(t, env.Pool, `SELECT count(*) FROM reg_orders WHERE status = 'PROOF_SUBMITTED'`))
	require.Equal(t, 1, paytest.Count(t, env.Pool, `SELECT count(*) FROM reg_orders WHERE status = 'PENDING_PAYMENT'`))
	require.Len(t, env.Store.Puts(), 2)
	require.Len(t, env.Store.Deletes(), 1)
}

func TestSubmitProofFlagsIdenticalScreenshotOnAnotherOrder(t *testing.T) {
	env := paytest.NewEnv(t)
	ctx := context.Background()
	fx := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7010, "Sokha Chan")
	first := paytest.SeedOrder(t, env, fx, u, paytest.OrderSpec{IdentOffset: 1})
	second := paytest.SeedOrder(t, env, fx, u, paytest.OrderSpec{IdentOffset: 2})
	img := paytest.PNG(t, 40)

	p1, err := env.Payments.SubmitProof(ctx, u, first.OrderNo, proofInput(img, "ABA-FIRST-001", first.AmountCents), testMeta)
	require.NoError(t, err)
	p2, err := env.Payments.SubmitProof(ctx, u, second.OrderNo, proofInput(img, "ABA-SECOND-002", second.AmountCents), testMeta)
	require.NoError(t, err)

	require.False(t, p1.DupFileHit)
	require.True(t, p2.DupFileHit)
	require.Equal(t, 1, paytest.Count(t, env.Pool, `SELECT count(*) FROM payment_proofs WHERE id = $1 AND dup_file_hit`, p2.ID))
}

func TestSubmitProofRollbackDeletesStoredFile(t *testing.T) {
	env := paytest.NewEnv(t)
	ctx := context.Background()
	fx := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7011, "Sokha Chan")
	first := paytest.SeedOrder(t, env, fx, u, paytest.OrderSpec{IdentOffset: 1})
	second := paytest.SeedOrder(t, env, fx, u, paytest.OrderSpec{IdentOffset: 2})

	_, err := env.Payments.SubmitProof(ctx, u, first.OrderNo, proofInput(paytest.PNG(t, 50), "ABA-DUP-REF-9", first.AmountCents), testMeta)
	require.NoError(t, err)
	_, err = env.Payments.SubmitProof(ctx, u, second.OrderNo, proofInput(paytest.PNG(t, 51), "aba-dup-ref-9", second.AmountCents), testMeta)

	requireAppErr(t, err, apperr.CodeProofTxnRefUsed, http.StatusConflict)
	puts := env.Store.Puts()
	require.Len(t, puts, 2)
	require.Equal(t, []string{puts[1]}, env.Store.Deletes())
	_, openErr := env.Store.Open(ctx, puts[1])
	require.True(t, errors.Is(openErr, storage.ErrNotFound), "回滚后文件应被删除，得到 %v", openErr)
	require.Equal(t, 1, paytest.Count(t, env.Pool, `SELECT count(*) FROM files WHERE purpose = 'PAYMENT_PROOF'`))
	status, deadline := orderState(t, env, second.ID)
	require.Equal(t, "PENDING_PAYMENT", status)
	require.NotNil(t, deadline)
}
```

- [ ] **Step 8: 运行测试，确认失败**

Run: `cd api && go test ./internal/payment/ -run 'TestSubmitProof|TestNormalizeTxnRef' -v`
Expected: 编译失败，报 `undefined: normalizeTxnRef`、`undefined: payment.SubmitProofInput`、`too many arguments in call to payment.NewService`。

- [ ] **Step 9: 实现 `registration` 的锁单与状态更新**

创建 `api/internal/registration/locks.go`：

```go
package registration

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/registration/store"
)

// LockOrderByNo 在调用方事务里锁定订单行（FOR UPDATE）。订单号不区分大小写；不存在返回 ORDER_NOT_FOUND。
func (s *Service) LockOrderByNo(ctx context.Context, tx pgx.Tx, orderNo string) (Order, error) {
	row, err := store.New(tx).LockRegOrderByNo(ctx, strings.ToUpper(strings.TrimSpace(orderNo)))
	if errors.Is(err, pgx.ErrNoRows) {
		return Order{}, apperr.New(http.StatusNotFound, apperr.CodeOrderNotFound)
	}
	if err != nil {
		return Order{}, fmt.Errorf("lock order %q: %w", orderNo, err)
	}
	return orderFromLockedRow(row), nil
}

// MarkProofSubmitted 把待付款或被驳回的订单改为审核中并清空截止时间；状态不符返回 ORDER_STATE_CONFLICT。
func (s *Service) MarkProofSubmitted(ctx context.Context, tx pgx.Tx, orderID int64) error {
	n, err := store.New(tx).SetOrderProofSubmitted(ctx, orderID)
	if err != nil {
		return fmt.Errorf("mark order %d proof submitted: %w", orderID, err)
	}
	if n != 1 {
		return apperr.New(http.StatusConflict, apperr.CodeOrderStateConflict)
	}
	return nil
}

func orderFromLockedRow(r store.RegOrder) Order {
	o := Order{
		ID:               r.ID,
		EventID:          r.EventID,
		OrderNo:          r.OrderNo,
		Status:           r.Status,
		ReservationState: r.ReservationState,
		ListAmountCents:  r.ListAmountCents,
		DiscountCents:    r.DiscountCents,
		IdentOffsetCents: int64(r.IdentOffsetCents),
		AmountCents:      r.AmountCents,
		Currency:         r.Currency,
		DeadlineAt:       r.DeadlineAt,
		PaidAt:           r.PaidAt,
		CreatedAt:        r.CreatedAt,
	}
	if r.BuyerUserID != nil {
		o.BuyerUserID = *r.BuyerUserID
	}
	if r.PaymentAccountID != nil {
		o.PaymentAccountID = *r.PaymentAccountID
	}
	return o
}
```

- [ ] **Step 10: 修改 `payment.NewService` 签名**

`api/internal/payment/service.go`：把 Task 6 的 `Service` 结构体与 `NewService` 函数整体替换为下面的定义（保留文件中其他内容；import 增加 `"werun/api/internal/registration"`）：

```go
// Service 是收款模块的业务入口：收款账户、凭证上传与审核。
type Service struct {
	pool   *pgxpool.Pool
	files  storage.Store
	orders *registration.Service
	now    func() time.Time
}

// NewService 创建收款服务。orders 用于在收款事务内锁单与改订单状态；只维护收款账户的调用方可以传 nil。
func NewService(pool *pgxpool.Pool, files storage.Store, orders *registration.Service, now func() time.Time) *Service {
	return &Service{pool: pool, files: files, orders: orders, now: now}
}
```

把核对命令列出的每个 `payment.NewService(pool, X, now)` 测试调用改为 `payment.NewService(pool, X, nil, now)`（Task 6 的收款账户测试不需要 `orders`）。

`api/cmd/werun/app.go`：删除 Task 6 写的

```go
	app.Payment = payment.NewService(app.Pool, app.Store, time.Now)
```

在 Task 12 写的 `app.Registration = registration.NewService(...)` 一行之后加入

```go
	app.Payment = payment.NewService(app.Pool, app.Store, app.Registration, time.Now)
```

- [ ] **Step 11: 实现 `SubmitProof`**

创建 `api/internal/payment/proofs.go`：

```go
package payment

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/audit"
	"werun/api/internal/payment/store"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/idgen"
	"werun/api/internal/platform/storage"
	"werun/api/internal/runner"
)

func init() {
	apperr.RegisterConstraint("payment_proofs_txn_ref_uniq", func() *apperr.Error {
		return apperr.New(http.StatusConflict, apperr.CodeProofTxnRefUsed).
			WithField("bankTxnRef", apperr.CodeProofTxnRefUsed, nil)
	})
}

const (
	constraintProofNo = "payment_proofs_proof_no_key"

	orderPendingPayment = "PENDING_PAYMENT"
	orderProofSubmitted = "PROOF_SUBMITTED"
	orderProofRejected  = "PROOF_REJECTED"

	proofStatusSubmitted = "SUBMITTED"
	proofStatusApproved  = "APPROVED"
	proofStatusRejected  = "REJECTED"

	purposePaymentProof = "PAYMENT_PROOF"

	minTxnRefLen    = 4
	maxTxnRefLen    = 64
	maxPayerNameLen = 100
)

// SubmitProofInput 是跑者上传凭证的输入。File 为原始图片流，其余为表单字段原值。
type SubmitProofInput struct {
	File                io.Reader
	BankTxnRef          string
	DeclaredAmountCents int64
	DeclaredPaidAt      *time.Time
	PayerName           *string
}

// Proof 是一份付款凭证。OrderNo 取自所属报名订单。
type Proof struct {
	ID, OrderID, PaymentAccountID, FileID int64
	ProofNo, OrderNo, BankTxnRef, Status  string
	DeclaredAmountCents                   int64
	DeclaredPaidAt                        *time.Time
	PayerName                             *string
	DupFileHit                            bool
	RejectCode                            *string
	RejectReason                          *string
	ReviewedBy                            *int64
	ReviewedAt                            *time.Time
	CreatedAt                             time.Time
}

// SubmitProof 按 spec 6.2 上传凭证：事务外读图并写存储，事务内锁单、校验、写文件与凭证、订单改为审核中、写审计。
// 事务失败时尽力删除已写入存储的文件，删除失败只记日志。
func (s *Service) SubmitProof(ctx context.Context, u runner.User, orderNo string, in SubmitProofInput, meta httpx.Meta) (Proof, error) {
	if in.File == nil {
		return Proof{}, apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation).WithField("file", "field.required", nil)
	}
	img, err := storage.ReadImage(in.File, storage.MaxProofBytes)
	if err != nil {
		return Proof{}, err
	}
	now := s.now()
	key := storage.NewKey(now, img.Ext)
	if err := s.files.Put(ctx, key, bytes.NewReader(img.Data)); err != nil {
		return Proof{}, fmt.Errorf("store proof file: %w", err)
	}

	var out Proof
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		order, err := s.orders.LockOrderByNo(ctx, tx, orderNo)
		if err != nil {
			return err
		}
		if order.BuyerUserID != u.ID {
			return apperr.New(http.StatusNotFound, apperr.CodeOrderNotFound)
		}
		if order.Status != orderPendingPayment && order.Status != orderProofRejected {
			return apperr.New(http.StatusConflict, apperr.CodeOrderStateConflict)
		}
		if order.DeadlineAt != nil && !order.DeadlineAt.After(now) {
			return apperr.New(http.StatusConflict, apperr.CodeOrderExpired)
		}

		txnRef := normalizeTxnRef(in.BankTxnRef)
		payerName := trimOptional(in.PayerName)
		if err := validateSubmit(txnRef, in.DeclaredAmountCents, payerName); err != nil {
			return err
		}

		fileID, err := storage.InsertFile(ctx, tx, storage.FileRecord{
			StorageKey:     key,
			Visibility:     "PRIVATE",
			Purpose:        purposePaymentProof,
			Image:          img,
			UploadedByType: "USER",
			UploadedByID:   u.ID,
		})
		if err != nil {
			return fmt.Errorf("insert proof file: %w", err)
		}
		dups, err := storage.CountOtherFilesWithSHA256(ctx, tx, img.SHA256[:], purposePaymentProof, fileID)
		if err != nil {
			return fmt.Errorf("count duplicate proof files: %w", err)
		}

		var declaredPaidAt *time.Time
		if in.DeclaredPaidAt != nil {
			t := in.DeclaredPaidAt.UTC()
			declaredPaidAt = &t
		}
		var row store.PaymentProof
		err = idgen.Retry(constraintProofNo, func() error {
			return inSavepoint(ctx, tx, func(q *store.Queries) error {
				var insertErr error
				row, insertErr = q.InsertPaymentProof(ctx, store.InsertPaymentProofParams{
					ProofNo:             idgen.Code(idgen.PrefixProof),
					RegOrderID:          order.ID,
					PaymentAccountID:    order.PaymentAccountID,
					FileID:              fileID,
					SubmittedByUserID:   u.ID,
					DeclaredAmountCents: in.DeclaredAmountCents,
					BankTxnRef:          txnRef,
					DeclaredPaidAt:      declaredPaidAt,
					PayerName:           payerName,
					DupFileHit:          dups > 0,
				})
				return insertErr
			})
		})
		if err != nil {
			return apperr.FromPG(err)
		}
		if err := s.orders.MarkProofSubmitted(ctx, tx, order.ID); err != nil {
			return err
		}

		out = proofFromRow(row, order.OrderNo)
		actorID := u.ID
		eventID := order.EventID
		return audit.Record(ctx, tx, audit.Entry{
			ActorType:   "USER",
			ActorID:     &actorID,
			Action:      "payment_proof.submit",
			EntityType:  "payment_proof",
			EntityID:    out.ID,
			EventID:     &eventID,
			IsFinancial: true,
			Summary:     fmt.Sprintf("订单 %s 上传付款凭证 %s", order.OrderNo, out.ProofNo),
			Before:      map[string]any{"orderStatus": order.Status},
			After: map[string]any{
				"orderNo":             order.OrderNo,
				"orderStatus":         orderProofSubmitted,
				"proofNo":             out.ProofNo,
				"bankTxnRef":          out.BankTxnRef,
				"declaredAmountCents": out.DeclaredAmountCents,
				"dupFileHit":          out.DupFileHit,
				"fileId":              fileID,
			},
			Meta: meta,
		})
	})
	if err != nil {
		if delErr := s.files.Delete(context.WithoutCancel(ctx), key); delErr != nil {
			slog.WarnContext(ctx, "delete orphan proof file", "storage_key", key, "error", delErr)
		}
		return Proof{}, err
	}
	return out, nil
}

func validateSubmit(txnRef string, declaredAmountCents int64, payerName *string) error {
	verr := apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)
	switch n := utf8.RuneCountInString(txnRef); {
	case n == 0:
		verr = verr.WithField("bankTxnRef", "field.required", nil)
	case n < minTxnRefLen || n > maxTxnRefLen:
		verr = verr.WithField("bankTxnRef", "field.invalid", nil)
	}
	if declaredAmountCents <= 0 {
		verr = verr.WithField("declaredAmountCents", "field.must_be_positive", nil)
	}
	if payerName != nil && utf8.RuneCountInString(*payerName) > maxPayerNameLen {
		verr = verr.WithField("payerName", "field.too_long", map[string]any{"max": maxPayerNameLen})
	}
	if len(verr.Fields) > 0 {
		return verr
	}
	return nil
}

// normalizeTxnRef 去掉所有 Unicode 空白后转大写。
func normalizeTxnRef(s string) string {
	return strings.ToUpper(strings.Join(strings.Fields(s), ""))
}

func trimOptional(p *string) *string {
	if p == nil {
		return nil
	}
	v := strings.TrimSpace(*p)
	if v == "" {
		return nil
	}
	return &v
}

// inSavepoint 在保存点里执行 fn：失败时回滚到保存点，外层事务仍可继续使用（供 idgen.Retry 重试）。
func inSavepoint(ctx context.Context, tx pgx.Tx, fn func(q *store.Queries) error) error {
	sp, err := tx.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin savepoint: %w", err)
	}
	if err := fn(store.New(sp)); err != nil {
		if rbErr := sp.Rollback(ctx); rbErr != nil {
			return errors.Join(err, fmt.Errorf("rollback savepoint: %w", rbErr))
		}
		return err
	}
	if err := sp.Commit(ctx); err != nil {
		return fmt.Errorf("release savepoint: %w", err)
	}
	return nil
}

func proofFromRow(r store.PaymentProof, orderNo string) Proof {
	p := Proof{
		ID:                  r.ID,
		PaymentAccountID:    r.PaymentAccountID,
		FileID:              r.FileID,
		ProofNo:             r.ProofNo,
		OrderNo:             orderNo,
		BankTxnRef:          r.BankTxnRef,
		Status:              r.Status,
		DeclaredAmountCents: r.DeclaredAmountCents,
		DeclaredPaidAt:      r.DeclaredPaidAt,
		PayerName:           r.PayerName,
		DupFileHit:          r.DupFileHit,
		RejectCode:          r.RejectCode,
		RejectReason:        r.RejectReason,
		ReviewedBy:          r.ReviewedBy,
		ReviewedAt:          r.ReviewedAt,
		CreatedAt:           r.CreatedAt,
	}
	if r.RegOrderID != nil {
		p.OrderID = *r.RegOrderID
	}
	return p
}
```

- [ ] **Step 12: 运行服务层测试，确认通过；并发用例连续跑 5 次**

Run: `cd api && go test ./internal/payment/ -run 'TestSubmitProof|TestNormalizeTxnRef' -v`
Expected: `TestNormalizeTxnRefRemovesAllWhitespaceAndUppercases`、`TestSubmitProofMovesOrderToReview`、`TestSubmitProofAfterRejectionAllowsSameTxnRef`、`TestSubmitProofExpiredOrder`、`TestSubmitProofOnOthersOrderIsNotFound`、`TestSubmitProofRequiresPayableOrderState`、`TestSubmitProofValidatesFields`（5 个子测试）、`TestSubmitProofRejectsNonImageBeforeStoring`、`TestSubmitProofSameTxnRefConcurrentlyOnlyOneSucceeds`、`TestSubmitProofFlagsIdenticalScreenshotOnAnotherOrder`、`TestSubmitProofRollbackDeletesStoredFile` 全部 PASS。

Run: `cd api && go test ./internal/payment/ -run TestSubmitProofSameTxnRefConcurrentlyOnlyOneSucceeds -count=5`
Expected: `ok`（5 次均通过）。

Run: `cd api && go build ./... && go test ./internal/payment/... ./cmd/werun/`
Expected: 编译通过；Task 6 的收款账户测试在改为四参数后仍 PASS。

- [ ] **Step 13: 写 HTTP 测试环境与失败的 multipart 测试**

创建 `api/internal/httpapi/payment_env_test.go`（Task 16、17 的 HTTP 测试共用）：

```go
package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"werun/api/internal/event"
	"werun/api/internal/httpapi"
	"werun/api/internal/iam"
	"werun/api/internal/payment/paytest"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/logx"
	"werun/api/internal/runner"
)

type paymentHTTPEnv struct {
	*paytest.Env
	router  http.Handler
	catalog *i18n.Catalog
}

func newPaymentHTTPEnv(t *testing.T) paymentHTTPEnv {
	t.Helper()
	gin.SetMode(gin.TestMode)
	env := paytest.NewEnv(t)
	catalog, err := i18n.LoadCatalog()
	require.NoError(t, err)
	router := httpapi.NewRouter(httpapi.RouterDeps{
		Log:          logx.New("error", io.Discard),
		Catalog:      catalog,
		Pool:         env.Pool,
		IAM:          env.IAM,
		Events:       event.NewService(env.Pool),
		Runner:       env.Runners,
		Pricing:      env.Prices,
		Registration: env.Orders,
		Payment:      env.Payments,
		Env:          "dev",
	})
	return paymentHTTPEnv{Env: env, router: router, catalog: catalog}
}

func (e paymentHTTPEnv) staffCookie(t *testing.T, role iam.Role, username string) *http.Cookie {
	t.Helper()
	const password = "Correct-Horse-Battery-9"
	ctx := context.Background()
	_, err := e.IAM.CreateStaff(ctx, username, "HTTP "+string(role), role, password)
	require.NoError(t, err)
	token, _, err := e.IAM.Login(ctx, username, password, httpx.Meta{IP: "127.0.0.1", UserAgent: "payment-http-test"})
	require.NoError(t, err)
	return &http.Cookie{Name: iam.CookieName, Value: token}
}

func (e paymentHTTPEnv) runnerToken(t *testing.T, telegramID int64, name string) (string, runner.User) {
	t.Helper()
	initData := runner.SignInitData(paytest.BotToken, runner.TelegramUser{
		ID:           telegramID,
		FirstName:    name,
		Username:     fmt.Sprintf("runner%d", telegramID),
		LanguageCode: "en",
	}, e.Clock.Now())
	session, err := e.Runners.LoginTelegram(context.Background(), initData, httpx.Meta{IP: "127.0.0.1", UserAgent: "payment-http-test"})
	require.NoError(t, err)
	return session.Token, session.User
}

// adminRequest 发 JSON 请求；非 GET 自动带 X-WeRun-Client: admin。
func (e paymentHTTPEnv) adminRequest(t *testing.T, method, path string, body any, cookie *http.Cookie) *httptest.ResponseRecorder {
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
	if method != http.MethodGet {
		req.Header.Set(httpx.HeaderClient, "admin")
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	return rec
}

func (e paymentHTTPEnv) uploadProof(t *testing.T, orderNo string, body io.Reader, contentType, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/app/orders/"+orderNo+"/proofs", body)
	req.Header.Set("Content-Type", contentType)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	return rec
}

// proofForm 先写文本字段、最后写文件（file 为 nil 时不写文件）。
func proofForm(t *testing.T, file []byte, fields map[string]string) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	for _, k := range slices.Sorted(maps.Keys(fields)) {
		require.NoError(t, w.WriteField(k, fields[k]))
	}
	if file != nil {
		fw, err := w.CreateFormFile("file", "receipt.png")
		require.NoError(t, err)
		_, err = fw.Write(file)
		require.NoError(t, err)
	}
	require.NoError(t, w.Close())
	return &buf, w.FormDataContentType()
}

func paymentDecode[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &v), rec.Body.String())
	return v
}
```

创建 `api/internal/httpapi/proofs_http_test.go`：

```go
package httpapi_test

import (
	"bytes"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/payment/paytest"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
)

func TestRunnerUploadsProofWithMultipart(t *testing.T) {
	env := newPaymentHTTPEnv(t)
	fx := paytest.SeedEvent(t, env.Pool)
	token, u := env.runnerToken(t, 7101, "Sokha")
	order := paytest.SeedOrder(t, env.Env, fx, u, paytest.OrderSpec{})

	body, contentType := proofForm(t, paytest.PNG(t, 42), map[string]string{
		"bankTxnRef":          "aba 5566 77",
		"declaredAmountCents": strconv.FormatInt(order.AmountCents, 10),
		"declaredPaidAt":      "2026-09-14T09:30:00+07:00",
		"payerName":           "SOKHA",
	})
	rec := env.uploadProof(t, order.OrderNo, body, contentType, token)

	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	got := paymentDecode[apigen.Proof](t, rec)
	require.Equal(t, "ABA556677", got.BankTxnRef)
	require.Equal(t, apigen.ProofStatusSUBMITTED, got.Status)
	require.Equal(t, order.OrderNo, got.OrderNo)
	require.Equal(t, order.AmountCents, got.DeclaredAmountCents)
	require.NotNil(t, got.DeclaredPaidAt)
	require.Equal(t, "2026-09-14T02:30:00Z", got.DeclaredPaidAt.UTC().Format(time.RFC3339))
	require.NotNil(t, got.PayerName)
	require.Equal(t, "SOKHA", *got.PayerName)
	require.Equal(t, 1, paytest.Count(t, env.Pool, `SELECT count(*) FROM reg_orders WHERE id = $1 AND status = 'PROOF_SUBMITTED'`, order.ID))
}

func TestProofUploadRejectsBadRequests(t *testing.T) {
	env := newPaymentHTTPEnv(t)
	fx := paytest.SeedEvent(t, env.Pool)
	token, u := env.runnerToken(t, 7102, "Sokha")
	order := paytest.SeedOrder(t, env.Env, fx, u, paytest.OrderSpec{})
	fields := map[string]string{"bankTxnRef": "ABA556677", "declaredAmountCents": strconv.FormatInt(order.AmountCents, 10)}

	t.Run("非图片返回 415", func(t *testing.T) {
		body, contentType := proofForm(t, []byte("plain text pretending to be a screenshot"), fields)
		rec := env.uploadProof(t, order.OrderNo, body, contentType, token)
		require.Equal(t, http.StatusUnsupportedMediaType, rec.Code, rec.Body.String())
		require.Equal(t, apperr.CodeFileTypeNotAllowed, paymentDecode[httpx.ErrorBody](t, rec).Error.Code)
	})

	t.Run("图片超过 5 MB 返回 413", func(t *testing.T) {
		big := append(paytest.PNG(t, 43), bytes.Repeat([]byte{0}, 5<<20)...)
		body, contentType := proofForm(t, big, fields)
		rec := env.uploadProof(t, order.OrderNo, body, contentType, token)
		require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code, rec.Body.String())
		require.Equal(t, apperr.CodeFileTooLarge, paymentDecode[httpx.ErrorBody](t, rec).Error.Code)
	})

	t.Run("请求体超过 6 MiB 返回 413", func(t *testing.T) {
		huge := append(paytest.PNG(t, 44), bytes.Repeat([]byte{0}, 7<<20)...)
		body, contentType := proofForm(t, huge, fields)
		rec := env.uploadProof(t, order.OrderNo, body, contentType, token)
		require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code, rec.Body.String())
		require.Equal(t, apperr.CodeFileTooLarge, paymentDecode[httpx.ErrorBody](t, rec).Error.Code)
	})

	t.Run("缺少文件与金额格式错误返回 422", func(t *testing.T) {
		body, contentType := proofForm(t, nil, map[string]string{"bankTxnRef": "ABA556677", "declaredAmountCents": "12.50"})
		rec := env.uploadProof(t, order.OrderNo, body, contentType, token)
		require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
		errBody := paymentDecode[httpx.ErrorBody](t, rec)
		require.Equal(t, apperr.CodeValidation, errBody.Error.Code)
		require.Contains(t, errBody.Error.Fields, "file")
		require.Contains(t, errBody.Error.Fields, "declaredAmountCents")
	})

	t.Run("没有令牌返回 401", func(t *testing.T) {
		body, contentType := proofForm(t, paytest.PNG(t, 45), fields)
		rec := env.uploadProof(t, order.OrderNo, body, contentType, "")
		require.Equal(t, http.StatusUnauthorized, rec.Code, rec.Body.String())
		require.Equal(t, apperr.CodeUnauthenticated, paymentDecode[httpx.ErrorBody](t, rec).Error.Code)
	})

	require.Equal(t, 0, paytest.Count(t, env.Pool, `SELECT count(*) FROM payment_proofs`))
}
```

- [ ] **Step 14: 在 openapi.yaml 中新增 `appSubmitProof` 并生成**

`api/openapi/openapi.yaml`：在 `components:` 这一行之前（`paths` 的末尾）插入：

```yaml
  /app/orders/{orderNo}/proofs:
    post:
      operationId: appSubmitProof
      summary: 上传付款凭证（截图 + 交易号），订单进入审核
      x-auth: app
      parameters:
        - name: orderNo
          in: path
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema:
              $ref: '#/components/schemas/SubmitProofForm'
      responses:
        '201':
          description: 凭证已提交
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Proof'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
```

在文件末尾（`components.schemas` 下，缩进 4 格）追加：

```yaml
    SubmitProofForm:
      type: object
      required: [file, bankTxnRef, declaredAmountCents]
      properties:
        file:
          type: string
          format: binary
          description: JPEG / PNG / WebP 截图，不超过 5 MB
        bankTxnRef:
          type: string
          description: 回执交易号；服务端去掉空白并转大写，长度 4–64
        declaredAmountCents:
          type: integer
          format: int64
        declaredPaidAt:
          type: string
          format: date-time
        payerName:
          type: string
    Proof:
      type: object
      required: [id, proofNo, orderId, orderNo, paymentAccountId, fileId, status, bankTxnRef, declaredAmountCents, declaredPaidAt, payerName, dupFileHit, rejectCode, rejectReason, reviewedBy, reviewedAt, createdAt]
      properties:
        id: { type: integer, format: int64 }
        proofNo: { type: string }
        orderId: { type: integer, format: int64 }
        orderNo: { type: string }
        paymentAccountId: { type: integer, format: int64 }
        fileId: { type: integer, format: int64 }
        status:
          type: string
          enum: [SUBMITTED, APPROVED, REJECTED, WITHDRAWN]
        bankTxnRef: { type: string }
        declaredAmountCents: { type: integer, format: int64 }
        declaredPaidAt: { type: string, format: date-time, nullable: true }
        payerName: { type: string, nullable: true }
        dupFileHit: { type: boolean }
        rejectCode: { type: string, nullable: true }
        rejectReason: { type: string, nullable: true }
        reviewedBy: { type: integer, format: int64, nullable: true }
        reviewedAt: { type: string, format: date-time, nullable: true }
        createdAt: { type: string, format: date-time }
```

Run: `make gen && cd api && go build ./...`
Expected: 生成成功；`go build` 失败，报 `*Server does not implement apigen.StrictServerInterface (missing method AppSubmitProof)`。`grep -n "AppSubmitProof\"" api/internal/httpapi/apigen/permissions.gen.go` 输出 `"AppSubmitProof": {Kind: AuthApp}`；`grep -n "Body \*multipart.Reader" api/internal/httpapi/apigen/api.gen.go` 能看到 `AppSubmitProofRequestObject` 的 `Body *multipart.Reader`。

- [ ] **Step 15: 实现 handler**

创建 `api/internal/payment/proof_handlers.go`：

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
	"time"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/storage"
	"werun/api/internal/runner"
)

// maxProofFieldBytes 是凭证表单单个文本字段的读取上限。
const maxProofFieldBytes = 1024

func (h *Handlers) AppSubmitProof(ctx context.Context, req apigen.AppSubmitProofRequestObject) (apigen.AppSubmitProofResponseObject, error) {
	u, ok := runner.UserFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	in, err := readProofForm(req.Body)
	if err != nil {
		return nil, err
	}
	proof, err := h.svc.SubmitProof(ctx, u, req.OrderNo, in, httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AppSubmitProof201JSONResponse(proofToAPI(proof)), nil
}

// readProofForm 逐个读取 multipart part：file 最多读 MaxProofBytes+1 字节（超限由 storage.ReadImage 报 FILE_TOO_LARGE），
// 文本字段各最多 1 KiB；未知 part 跳过。请求体超过 6 MiB 时 http.MaxBytesReader 报错，映射为 FILE_TOO_LARGE。
func readProofForm(r *multipart.Reader) (SubmitProofInput, error) {
	var in SubmitProofInput
	var file []byte
	haveFile := false
	fields := map[string]string{}
	for {
		part, err := r.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return in, multipartError(err)
		}
		name := part.FormName()
		switch name {
		case "file":
			data, err := io.ReadAll(io.LimitReader(part, storage.MaxProofBytes+1))
			if err != nil {
				return in, multipartError(err)
			}
			file, haveFile = data, true
		case "bankTxnRef", "declaredAmountCents", "declaredPaidAt", "payerName":
			data, err := io.ReadAll(io.LimitReader(part, maxProofFieldBytes+1))
			if err != nil {
				return in, multipartError(err)
			}
			if len(data) > maxProofFieldBytes {
				return in, apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation).
					WithField(name, "field.too_long", map[string]any{"max": maxProofFieldBytes})
			}
			fields[name] = string(data)
		}
		if err := part.Close(); err != nil {
			return in, multipartError(err)
		}
	}

	verr := apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)
	if haveFile {
		in.File = bytes.NewReader(file)
	} else {
		verr = verr.WithField("file", "field.required", nil)
	}
	in.BankTxnRef = fields["bankTxnRef"]
	switch amount := strings.TrimSpace(fields["declaredAmountCents"]); {
	case amount == "":
		verr = verr.WithField("declaredAmountCents", "field.required", nil)
	default:
		cents, err := strconv.ParseInt(amount, 10, 64)
		if err != nil {
			verr = verr.WithField("declaredAmountCents", "field.invalid", nil)
		}
		in.DeclaredAmountCents = cents
	}
	if v := strings.TrimSpace(fields["declaredPaidAt"]); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			verr = verr.WithField("declaredPaidAt", "field.invalid", nil)
		} else {
			in.DeclaredPaidAt = &t
		}
	}
	if v, ok := fields["payerName"]; ok {
		in.PayerName = &v
	}
	if len(verr.Fields) > 0 {
		return SubmitProofInput{}, verr
	}
	return in, nil
}

func multipartError(err error) error {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return apperr.New(http.StatusRequestEntityTooLarge, apperr.CodeFileTooLarge).Wrap(err)
	}
	return apperr.New(http.StatusBadRequest, apperr.CodeBadRequest).Wrap(err)
}

func proofToAPI(p Proof) apigen.Proof {
	return apigen.Proof{
		Id:                  p.ID,
		ProofNo:             p.ProofNo,
		OrderId:             p.OrderID,
		OrderNo:             p.OrderNo,
		PaymentAccountId:    p.PaymentAccountID,
		FileId:              p.FileID,
		Status:              apigen.ProofStatus(p.Status),
		BankTxnRef:          p.BankTxnRef,
		DeclaredAmountCents: p.DeclaredAmountCents,
		DeclaredPaidAt:      p.DeclaredPaidAt,
		PayerName:           p.PayerName,
		DupFileHit:          p.DupFileHit,
		RejectCode:          p.RejectCode,
		RejectReason:        p.RejectReason,
		ReviewedBy:          p.ReviewedBy,
		ReviewedAt:          p.ReviewedAt,
		CreatedAt:           p.CreatedAt,
	}
}
```

`AppSubmitProof` 挂在 Task 6 的 `payment.Handlers` 上，`httpapi.Server` 已嵌入 `PaymentHandlers`，无需改 `server.go`。

- [ ] **Step 16: 运行 HTTP 测试，确认通过**

Run: `cd api && go test ./internal/httpapi/ -run 'TestRunnerUploadsProofWithMultipart|TestProofUploadRejectsBadRequests' -v`
Expected: `TestRunnerUploadsProofWithMultipart` PASS；`TestProofUploadRejectsBadRequests` 的 5 个子测试全部 PASS。

- [ ] **Step 17: 全量检查**

Run: `make gen && git diff --exit-code -- api/internal/httpapi/apigen api/internal/registration/store api/internal/payment/store packages/api-client/src/schema.d.ts`
Expected: 退出码 0（生成代码已是最新）。

Run: `cd api && go test ./... && go tool golangci-lint run ./...`
Expected: 全部包 `ok`；golangci-lint 输出 `0 issues.`（其中包含 permgen 的 `OperationAuths` 完整性测试）。

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过（只多了 `schema.d.ts` 的类型，前端代码未改）。

- [ ] **Step 18: 提交**

```bash
git add api/internal/platform/apperr/apperr.go api/internal/platform/apperr/apperr_test.go \
  api/internal/platform/i18n/messages.zh.json api/internal/platform/i18n/messages.en.json api/internal/platform/i18n/messages.km.json \
  api/db/queries/registration.sql api/db/queries/payment.sql \
  api/internal/registration/store api/internal/registration/locks.go \
  api/internal/payment/store api/internal/payment/service.go api/internal/payment/proofs.go \
  api/internal/payment/proofs_internal_test.go api/internal/payment/proofs_test.go \
  api/internal/payment/paytest/paytest.go api/internal/payment/proof_handlers.go \
  api/internal/payment api/internal/httpapi/payment_env_test.go api/internal/httpapi/proofs_http_test.go \
  api/internal/httpapi/apigen api/openapi/openapi.yaml api/cmd/werun/app.go \
  packages/api-client/src/schema.d.ts
git commit -m "$(cat <<'EOF'
feat(api): let runners upload payment proofs with screenshot and transaction ref

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
)"
```

说明：`api/internal/payment` 目录一并加入，是为了带上 Step 10 改成四参数的 Task 6 测试文件；如果 Task 6 的 HTTP 测试（`api/internal/httpapi/*_test.go`）里也有 `payment.NewService(` 调用，把那些文件路径追加到 `git add`。

---
### Task 16: 后台订单查询

**Files:**
- Modify: `api/db/queries/registration.sql`（追加 6 个查询）
- Generate: `api/internal/registration/store/`
- Create: `api/internal/registration/admin.go`
- Create: `api/internal/registration/admin_test.go`
- Modify: `api/openapi/openapi.yaml`（新增 `adminListOrders`、`adminGetOrder` 与 8 个 schema）
- Generate: `api/internal/httpapi/apigen/api.gen.go`、`api/internal/httpapi/apigen/permissions.gen.go`、`packages/api-client/src/schema.d.ts`
- Create: `api/internal/registration/admin_handlers.go`
- Create: `api/internal/httpapi/orders_http_test.go`

**Interfaces:**
- Consumes:
  - Task 12–13 的包内函数 `func (s *Service) loadDetail(ctx context.Context, q *store.Queries, orderID int64) (OrderDetail, error)` 与 `func decodeText(raw []byte, what string) (i18n.Text, error)`
  - `registration.OrderDetail`、`OrderParticipant`、`PaymentAccountView`、`LastRejection`、`OrderSummary`（00-overview）
  - `orderFromLockedRow`（Task 15，`internal/registration/locks.go`）
  - `paytest.NewEnv / SeedEvent / SeedUser / SeedOrder / SeedProof / Count`（Task 15）
  - `iam.PermOrderView`（`order_view`：ADMIN、OPS、FINANCE、SUPPORT、RACE_SUPERVISOR、RACE_STAFF 为 R，PHOTOGRAPHER 无）
- Produces:
  - `registration.AdminOrderFilter`、`AdminOrderDetail`、`ProofHistoryItem`、`ReceiptItem`、`AppliedCoupon`（字段同 00-overview）
  - `func (s *registration.Service) AdminListOrders(ctx context.Context, f AdminOrderFilter) ([]OrderSummary, int64, error)`
  - `func (s *registration.Service) AdminGetOrder(ctx context.Context, id int64) (AdminOrderDetail, error)`
  - `func registration.AdminOrderDetailToAPI(d AdminOrderDetail) apigen.AdminOrderDetail`（契约补充 2）
  - OpenAPI `adminListOrders`（`GET /admin/orders`）、`adminGetOrder`（`GET /admin/orders/{id}`），均 `x-permission: order_view`、`x-access: read`
  - schema `AdminOrderSummary`、`AdminOrderList`、`AdminOrderDetail`、`AdminOrderParticipant`、`AdminOrderPaymentAccount`、`AdminLastRejection`、`AdminProofHistoryItem`、`AdminReceiptItem`、`AdminAppliedCoupon`
  - `(*registration.Handlers).AdminListOrders`、`(*registration.Handlers).AdminGetOrder`

**要点**

- 列表筛选：`eventId` 精确；`status` 必须是订单 8 个状态之一，否则 `VALIDATION_FAILED`（字段 `status`）；`q` 去首尾空白后，匹配 `order_no = upper(q)`、`buyer_phone_e164` 包含 `q`、`buyer_name ILIKE %q%` 三者之一（`%`、`_`、`\` 先转义）。`limit` 缺省或 ≤ 0 取 20，大于 100 取 100；`offset` < 0 取 0。按 `created_at DESC, id DESC` 排序，同时返回满足条件的总数。
- 详情复用 Task 13 的包内函数 `loadDetail` 组装 `OrderDetail`（与跑者端 `GetMyOrder` 同一份组装逻辑），再补买家姓名与手机、凭证历史（新到旧）、到账记录（按到账时间）与优惠码核销。

- [ ] **Step 1: 追加 sqlc 查询并生成**

在 `api/db/queries/registration.sql` 文件末尾追加：

```sql
-- name: AdminListRegOrders :many
SELECT sqlc.embed(o),
       e.slug AS event_slug,
       e.name AS event_name,
       (SELECT count(*) FROM order_participants op WHERE op.order_id = o.id)::int AS participant_count
FROM reg_orders o
JOIN events e ON e.id = o.event_id
WHERE (sqlc.narg(event_id)::bigint IS NULL OR o.event_id = sqlc.narg(event_id)::bigint)
  AND (sqlc.arg(status)::text = '' OR o.status = sqlc.arg(status)::text)
  AND (sqlc.arg(q)::text = ''
       OR o.order_no = upper(sqlc.arg(q)::text)
       OR o.buyer_phone_e164 LIKE ('%' || sqlc.arg(q_like)::text || '%') ESCAPE '\'
       OR o.buyer_name ILIKE ('%' || sqlc.arg(q_like)::text || '%') ESCAPE '\')
ORDER BY o.created_at DESC, o.id DESC
LIMIT sqlc.arg(row_limit)::int OFFSET sqlc.arg(row_offset)::int;

-- name: AdminCountRegOrders :one
SELECT count(*)
FROM reg_orders o
WHERE (sqlc.narg(event_id)::bigint IS NULL OR o.event_id = sqlc.narg(event_id)::bigint)
  AND (sqlc.arg(status)::text = '' OR o.status = sqlc.arg(status)::text)
  AND (sqlc.arg(q)::text = ''
       OR o.order_no = upper(sqlc.arg(q)::text)
       OR o.buyer_phone_e164 LIKE ('%' || sqlc.arg(q_like)::text || '%') ESCAPE '\'
       OR o.buyer_name ILIKE ('%' || sqlc.arg(q_like)::text || '%') ESCAPE '\');

-- name: AdminGetRegOrderBuyer :one
SELECT buyer_name, buyer_phone_e164
FROM reg_orders
WHERE id = @id;

-- name: AdminListOrderProofs :many
SELECT id, proof_no, status, bank_txn_ref, declared_amount_cents, reject_code, created_at, reviewed_at
FROM payment_proofs
WHERE reg_order_id = sqlc.arg(order_id)::bigint
ORDER BY created_at DESC, id DESC;

-- name: AdminListOrderReceipts :many
SELECT id, txn_ref, amount_cents, received_at, match_status
FROM payment_receipts
WHERE reg_order_id = sqlc.arg(order_id)::bigint
ORDER BY received_at, id;

-- name: AdminGetOrderCoupon :one
SELECT c.code, cr.discount_cents, cr.state
FROM coupon_redemptions cr
JOIN coupons c ON c.id = cr.coupon_id
WHERE cr.order_id = @order_id;
```

Run: `cd api && go tool sqlc generate && grep -n "type AdminListRegOrdersParams struct" -A 8 internal/registration/store/registration.sql.go && grep -n "type AdminListRegOrdersRow struct" -A 5 internal/registration/store/registration.sql.go`
Expected: `AdminListRegOrdersParams{EventID *int64; Status string; Q string; QLike string; RowLimit int32; RowOffset int32}`；`AdminListRegOrdersRow{RegOrder RegOrder; EventSlug string; EventName []byte; ParticipantCount int32}`。

- [ ] **Step 2: 写服务层失败测试**

创建 `api/internal/registration/admin_test.go`：

```go
package registration_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"werun/api/internal/payment/paytest"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/registration"
)

func orderNos(items []registration.OrderSummary) []string {
	out := make([]string, 0, len(items))
	for _, it := range items {
		out = append(out, it.OrderNo)
	}
	return out
}

func TestAdminListOrdersFiltersSearchesAndPaginates(t *testing.T) {
	env := paytest.NewEnv(t)
	ctx := context.Background()
	fxA := paytest.SeedEvent(t, env.Pool)
	fxB := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7201, "Sokha Chan")
	o1 := paytest.SeedOrder(t, env, fxA, u, paytest.OrderSpec{BuyerName: "Sokha Chan", BuyerPhone: "+85512000001"})
	o2 := paytest.SeedOrder(t, env, fxA, u, paytest.OrderSpec{Status: "PROOF_SUBMITTED", Participants: 2, BuyerName: "Dara Meas", BuyerPhone: "+85512000002"})
	o3 := paytest.SeedOrder(t, env, fxB, u, paytest.OrderSpec{BuyerName: "Vanna_Test", BuyerPhone: "+85598000003"})
	for i, o := range []paytest.OrderRef{o1, o2, o3} {
		_, err := env.Pool.Exec(ctx, `UPDATE reg_orders SET created_at = $2 WHERE id = $1`,
			o.ID, env.Clock.Now().Add(time.Duration(i-10)*time.Minute))
		require.NoError(t, err)
	}

	list := func(f registration.AdminOrderFilter) ([]string, int64) {
		t.Helper()
		items, total, err := env.Orders.AdminListOrders(ctx, f)
		require.NoError(t, err)
		return orderNos(items), total
	}

	got, total := list(registration.AdminOrderFilter{})
	require.Equal(t, []string{o3.OrderNo, o2.OrderNo, o1.OrderNo}, got)
	require.EqualValues(t, 3, total)

	got, total = list(registration.AdminOrderFilter{EventID: &fxA.EventID})
	require.Equal(t, []string{o2.OrderNo, o1.OrderNo}, got)
	require.EqualValues(t, 2, total)

	items, total, err := env.Orders.AdminListOrders(ctx, registration.AdminOrderFilter{Status: "PROOF_SUBMITTED"})
	require.NoError(t, err)
	require.EqualValues(t, 1, total)
	require.Len(t, items, 1)
	require.Equal(t, o2.OrderNo, items[0].OrderNo)
	require.Equal(t, 2, items[0].ParticipantCount)
	require.Equal(t, o2.AmountCents, items[0].AmountCents)
	require.True(t, strings.HasPrefix(items[0].EventSlug, "paytest-"))
	require.Equal(t, "Phnom Penh Half Marathon 2026", items[0].EventName[i18n.EN])

	got, _ = list(registration.AdminOrderFilter{Query: " " + strings.ToLower(o1.OrderNo) + " "})
	require.Equal(t, []string{o1.OrderNo}, got)
	got, _ = list(registration.AdminOrderFilter{Query: "98000"})
	require.Equal(t, []string{o3.OrderNo}, got)
	got, _ = list(registration.AdminOrderFilter{Query: "dara"})
	require.Equal(t, []string{o2.OrderNo}, got)
	got, _ = list(registration.AdminOrderFilter{Query: "_"})
	require.Equal(t, []string{o3.OrderNo}, got, "下划线必须按字面匹配")

	got, total = list(registration.AdminOrderFilter{Limit: 2})
	require.Equal(t, []string{o3.OrderNo, o2.OrderNo}, got)
	require.EqualValues(t, 3, total)
	got, total = list(registration.AdminOrderFilter{Limit: 2, Offset: 2})
	require.Equal(t, []string{o1.OrderNo}, got)
	require.EqualValues(t, 3, total)
	got, _ = list(registration.AdminOrderFilter{Limit: 500, Offset: -3})
	require.Len(t, got, 3)

	_, _, err = env.Orders.AdminListOrders(ctx, registration.AdminOrderFilter{Status: "BOGUS"})
	ae, ok := apperr.As(err)
	require.True(t, ok)
	require.Equal(t, apperr.CodeValidation, ae.Code)
	require.Equal(t, "field.invalid", ae.Fields["status"].Key)
}

func TestAdminGetOrderIncludesBuyerProofsReceiptsAndCoupon(t *testing.T) {
	env := paytest.NewEnv(t)
	ctx := context.Background()
	fx := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7202, "Sokha Chan")
	order := paytest.SeedOrder(t, env, fx, u, paytest.OrderSpec{Status: "PROOF_SUBMITTED", WithCoupon: true, BuyerPhone: "+85512000009"})
	rejectedID := paytest.SeedProof(t, env, fx, order, u, "REJECTED", "ABA-OLD-001", env.Clock.Now().Add(-3*time.Hour))
	submittedID := paytest.SeedProof(t, env, fx, order, u, "SUBMITTED", "ABA-NEW-002", env.Clock.Now().Add(-time.Hour))
	_, err := env.Pool.Exec(ctx, `
		INSERT INTO payment_receipts (payment_account_id, txn_ref, amount_cents, currency, received_at, reg_order_id, match_status, recorded_by_type)
		VALUES ($1, 'ABA-BANK-777', $2, 'USD', $3, $4, 'APPLIED', 'SYSTEM')`,
		fx.AccountID, order.AmountCents, env.Clock.Now().Add(-30*time.Minute), order.ID)
	require.NoError(t, err)

	detail, err := env.Orders.AdminGetOrder(ctx, order.ID)

	require.NoError(t, err)
	require.Equal(t, order.OrderNo, detail.OrderNo)
	require.Equal(t, "PROOF_SUBMITTED", detail.Status)
	require.Equal(t, "Sokha Chan", detail.BuyerName)
	require.Equal(t, "+85512000009", detail.BuyerPhone)
	require.Equal(t, order.AmountCents, detail.AmountCents)
	require.Equal(t, fx.AccountID, detail.PaymentAccount.ID)
	require.Len(t, detail.Participants, 1)
	require.Equal(t, "Sokha Chan", detail.Participants[0].FullName)

	require.Len(t, detail.Proofs, 2)
	require.Equal(t, submittedID, detail.Proofs[0].ID)
	require.Equal(t, "SUBMITTED", detail.Proofs[0].Status)
	require.Equal(t, rejectedID, detail.Proofs[1].ID)
	require.Equal(t, "REJECTED", detail.Proofs[1].Status)
	require.NotNil(t, detail.Proofs[1].RejectCode)
	require.Equal(t, "UNREADABLE", *detail.Proofs[1].RejectCode)
	require.NotNil(t, detail.Proofs[1].ReviewedAt)

	require.Len(t, detail.Receipts, 1)
	require.Equal(t, "ABA-BANK-777", detail.Receipts[0].TxnRef)
	require.Equal(t, "APPLIED", detail.Receipts[0].MatchStatus)

	require.NotNil(t, detail.Coupon)
	require.Equal(t, paytest.CouponDiscountCents, detail.Coupon.DiscountCents)
	require.Equal(t, "RESERVED", detail.Coupon.State)
	require.True(t, strings.HasPrefix(detail.Coupon.Code, "PAY"))
}

func TestAdminGetOrderWithoutCouponOrProofs(t *testing.T) {
	env := paytest.NewEnv(t)
	fx := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7203, "Sokha Chan")
	order := paytest.SeedOrder(t, env, fx, u, paytest.OrderSpec{})

	detail, err := env.Orders.AdminGetOrder(context.Background(), order.ID)

	require.NoError(t, err)
	require.Nil(t, detail.Coupon)
	require.NotNil(t, detail.Proofs)
	require.Empty(t, detail.Proofs)
	require.NotNil(t, detail.Receipts)
	require.Empty(t, detail.Receipts)
}

func TestAdminGetOrderUnknown(t *testing.T) {
	env := paytest.NewEnv(t)

	_, err := env.Orders.AdminGetOrder(context.Background(), 999999)

	ae, ok := apperr.As(err)
	require.True(t, ok)
	require.Equal(t, apperr.CodeOrderNotFound, ae.Code)
	require.Equal(t, http.StatusNotFound, ae.Status)
}
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `cd api && go test ./internal/registration/ -run 'TestAdminListOrders|TestAdminGetOrder' -v`
Expected: 编译失败，报 `env.Orders.AdminListOrders undefined`、`undefined: registration.AdminOrderFilter`。

- [ ] **Step 4: 实现后台查询**

创建 `api/internal/registration/admin.go`：

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

	"werun/api/internal/platform/apperr"
	"werun/api/internal/registration/store"
)

const (
	adminOrdersDefaultLimit int32 = 20
	adminOrdersMaxLimit     int32 = 100
)

var adminOrderStatuses = map[string]bool{
	"PENDING_PAYMENT": true, "PROOF_SUBMITTED": true, "PROOF_REJECTED": true, "PAID": true,
	"PARTIALLY_REFUNDED": true, "REFUNDED": true, "EXPIRED": true, "CANCELLED": true,
}

// AdminOrderFilter 是后台订单列表的筛选条件。Status 为空表示不限；Query 匹配订单号、手机号或买家姓名。
type AdminOrderFilter struct {
	EventID       *int64
	Status        string
	Query         string
	Limit, Offset int32
}

// AdminOrderDetail 是后台订单详情：跑者可见的订单详情加买家、凭证历史、到账记录与优惠码。
type AdminOrderDetail struct {
	OrderDetail
	BuyerName, BuyerPhone string
	Proofs                []ProofHistoryItem
	Receipts              []ReceiptItem
	Coupon                *AppliedCoupon
}

type ProofHistoryItem struct {
	ID                          int64
	ProofNo, Status, BankTxnRef string
	DeclaredAmountCents         int64
	RejectCode                  *string
	CreatedAt                   time.Time
	ReviewedAt                  *time.Time
}

type ReceiptItem struct {
	ID          int64
	TxnRef      string
	AmountCents int64
	ReceivedAt  time.Time
	MatchStatus string
}

type AppliedCoupon struct {
	Code          string
	DiscountCents int64
	State         string
}

// AdminListOrders 按条件分页列出订单（创建时间倒序），并返回满足条件的总数。
func (s *Service) AdminListOrders(ctx context.Context, f AdminOrderFilter) ([]OrderSummary, int64, error) {
	status := strings.ToUpper(strings.TrimSpace(f.Status))
	if status != "" && !adminOrderStatuses[status] {
		return nil, 0, apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation).WithField("status", "field.invalid", nil)
	}
	limit := f.Limit
	if limit <= 0 {
		limit = adminOrdersDefaultLimit
	}
	limit = min(limit, adminOrdersMaxLimit)
	offset := max(f.Offset, 0)
	query := strings.TrimSpace(f.Query)
	like := escapeLike(query)

	q := store.New(s.pool)
	rows, err := q.AdminListRegOrders(ctx, store.AdminListRegOrdersParams{
		EventID: f.EventID, Status: status, Q: query, QLike: like, RowLimit: limit, RowOffset: offset,
	})
	if err != nil {
		return nil, 0, fmt.Errorf("admin list orders: %w", err)
	}
	total, err := q.AdminCountRegOrders(ctx, store.AdminCountRegOrdersParams{
		EventID: f.EventID, Status: status, Q: query, QLike: like,
	})
	if err != nil {
		return nil, 0, fmt.Errorf("admin count orders: %w", err)
	}

	items := make([]OrderSummary, 0, len(rows))
	for _, r := range rows {
		name, err := decodeText(r.EventName, "event name")
		if err != nil {
			return nil, 0, err
		}
		items = append(items, OrderSummary{
			Order:            orderFromLockedRow(r.RegOrder),
			EventSlug:        r.EventSlug,
			EventName:        name,
			ParticipantCount: int(r.ParticipantCount),
		})
	}
	return items, total, nil
}

// AdminGetOrder 返回后台订单详情；不存在返回 ORDER_NOT_FOUND。
func (s *Service) AdminGetOrder(ctx context.Context, id int64) (AdminOrderDetail, error) {
	q := store.New(s.pool)
	buyer, err := q.AdminGetRegOrderBuyer(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return AdminOrderDetail{}, apperr.New(http.StatusNotFound, apperr.CodeOrderNotFound)
	}
	if err != nil {
		return AdminOrderDetail{}, fmt.Errorf("get order %d: %w", id, err)
	}
	detail, err := s.loadDetail(ctx, q, id)
	if err != nil {
		return AdminOrderDetail{}, err
	}
	out := AdminOrderDetail{OrderDetail: detail, BuyerName: buyer.BuyerName, BuyerPhone: buyer.BuyerPhoneE164}

	proofs, err := q.AdminListOrderProofs(ctx, id)
	if err != nil {
		return AdminOrderDetail{}, fmt.Errorf("list proofs of order %d: %w", id, err)
	}
	out.Proofs = make([]ProofHistoryItem, 0, len(proofs))
	for _, p := range proofs {
		out.Proofs = append(out.Proofs, ProofHistoryItem{
			ID: p.ID, ProofNo: p.ProofNo, Status: p.Status, BankTxnRef: p.BankTxnRef,
			DeclaredAmountCents: p.DeclaredAmountCents, RejectCode: p.RejectCode,
			CreatedAt: p.CreatedAt, ReviewedAt: p.ReviewedAt,
		})
	}

	receipts, err := q.AdminListOrderReceipts(ctx, id)
	if err != nil {
		return AdminOrderDetail{}, fmt.Errorf("list receipts of order %d: %w", id, err)
	}
	out.Receipts = make([]ReceiptItem, 0, len(receipts))
	for _, r := range receipts {
		out.Receipts = append(out.Receipts, ReceiptItem{
			ID: r.ID, TxnRef: r.TxnRef, AmountCents: r.AmountCents, ReceivedAt: r.ReceivedAt, MatchStatus: r.MatchStatus,
		})
	}

	coupon, err := q.AdminGetOrderCoupon(ctx, id)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
	case err != nil:
		return AdminOrderDetail{}, fmt.Errorf("get coupon of order %d: %w", id, err)
	default:
		out.Coupon = &AppliedCoupon{Code: coupon.Code, DiscountCents: coupon.DiscountCents, State: coupon.State}
	}
	return out, nil
}

// escapeLike 转义 LIKE 通配符，配合 SQL 中的 ESCAPE '\'。
func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `cd api && go test ./internal/registration/ -run 'TestAdminListOrders|TestAdminGetOrder' -v`
Expected: `TestAdminListOrdersFiltersSearchesAndPaginates`、`TestAdminGetOrderIncludesBuyerProofsReceiptsAndCoupon`、`TestAdminGetOrderWithoutCouponOrProofs`、`TestAdminGetOrderUnknown` 全部 PASS。

- [ ] **Step 6: 写 HTTP 失败测试**

创建 `api/internal/httpapi/orders_http_test.go`：

```go
package httpapi_test

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/payment/paytest"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
)

func TestFinanceListsAndOpensOrders(t *testing.T) {
	env := newPaymentHTTPEnv(t)
	fx := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7301, "Sokha Chan")
	order := paytest.SeedOrder(t, env.Env, fx, u, paytest.OrderSpec{WithCoupon: true})
	paytest.SeedOrder(t, env.Env, fx, u, paytest.OrderSpec{Status: "PROOF_SUBMITTED"})
	finance := env.staffCookie(t, iam.RoleFinance, "finance.orders")

	query := url.Values{
		"eventId": {fmt.Sprint(fx.EventID)},
		"status":  {"PENDING_PAYMENT"},
		"q":       {strings.ToLower(order.OrderNo)},
		"limit":   {"10"},
	}
	rec := env.adminRequest(t, http.MethodGet, "/api/admin/orders?"+query.Encode(), nil, finance)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	list := paymentDecode[apigen.AdminOrderList](t, rec)
	require.EqualValues(t, 1, list.Total)
	require.Len(t, list.Items, 1)
	require.Equal(t, order.OrderNo, list.Items[0].OrderNo)
	require.Equal(t, apigen.AdminOrderSummaryStatusPENDINGPAYMENT, list.Items[0].Status)
	require.NotNil(t, list.Items[0].EventName.En)
	require.Equal(t, "Phnom Penh Half Marathon 2026", *list.Items[0].EventName.En)
	require.EqualValues(t, 1, list.Items[0].ParticipantCount)

	rec = env.adminRequest(t, http.MethodGet, fmt.Sprintf("/api/admin/orders/%d", order.ID), nil, finance)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	detail := paymentDecode[apigen.AdminOrderDetail](t, rec)
	require.Equal(t, order.OrderNo, detail.OrderNo)
	require.Equal(t, order.AmountCents, detail.AmountCents)
	require.Len(t, detail.Participants, 1)
	require.NotNil(t, detail.Coupon)
	require.Equal(t, apigen.AdminAppliedCouponStateRESERVED, detail.Coupon.State)
	require.Empty(t, detail.Proofs)
	require.Equal(t, fx.AccountID, detail.PaymentAccount.Id)

	rec = env.adminRequest(t, http.MethodGet, "/api/admin/orders/999999", nil, finance)
	require.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())
	require.Equal(t, apperr.CodeOrderNotFound, paymentDecode[httpx.ErrorBody](t, rec).Error.Code)

	rec = env.adminRequest(t, http.MethodGet, "/api/admin/orders?status=BOGUS", nil, finance)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
}

func TestPhotographerCannotViewOrders(t *testing.T) {
	env := newPaymentHTTPEnv(t)
	fx := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7302, "Sokha Chan")
	order := paytest.SeedOrder(t, env.Env, fx, u, paytest.OrderSpec{})
	photographer := env.staffCookie(t, iam.RolePhotographer, "photog.orders")

	for _, path := range []string{"/api/admin/orders", fmt.Sprintf("/api/admin/orders/%d", order.ID)} {
		rec := env.adminRequest(t, http.MethodGet, path, nil, photographer)
		require.Equal(t, http.StatusForbidden, rec.Code, "%s: %s", path, rec.Body.String())
		require.Equal(t, apperr.CodeForbidden, paymentDecode[httpx.ErrorBody](t, rec).Error.Code)
	}

	rec := env.adminRequest(t, http.MethodGet, "/api/admin/orders", nil, nil)
	require.Equal(t, http.StatusUnauthorized, rec.Code, rec.Body.String())
}
```

- [ ] **Step 7: 在 openapi.yaml 中新增订单接口并生成**

在 `components:` 这一行之前插入：

```yaml
  /admin/orders:
    get:
      operationId: adminListOrders
      summary: 后台订单列表（按赛事、状态、订单号 / 手机号 / 买家姓名筛选，创建时间倒序）
      x-permission: order_view
      x-access: read
      parameters:
        - name: eventId
          in: query
          required: false
          schema:
            type: integer
            format: int64
        - name: status
          in: query
          required: false
          schema:
            type: string
            enum: [PENDING_PAYMENT, PROOF_SUBMITTED, PROOF_REJECTED, PAID, PARTIALLY_REFUNDED, REFUNDED, EXPIRED, CANCELLED]
        - name: q
          in: query
          required: false
          schema:
            type: string
            maxLength: 64
        - name: limit
          in: query
          required: false
          schema:
            type: integer
            format: int32
            minimum: 1
            maximum: 100
        - name: offset
          in: query
          required: false
          schema:
            type: integer
            format: int32
            minimum: 0
      responses:
        '200':
          description: 订单列表与总数
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AdminOrderList'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
  /admin/orders/{id}:
    get:
      operationId: adminGetOrder
      summary: 后台订单详情（金额构成、参赛人、凭证历史、到账记录）
      x-permission: order_view
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
          description: 订单详情
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AdminOrderDetail'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
```

在文件末尾追加：

```yaml
    AdminOrderSummary:
      type: object
      required: [id, orderNo, eventId, eventSlug, eventName, status, listAmountCents, discountCents, identOffsetCents, amountCents, currency, participantCount, deadlineAt, paidAt, createdAt]
      properties:
        id: { type: integer, format: int64 }
        orderNo: { type: string }
        eventId: { type: integer, format: int64 }
        eventSlug: { type: string }
        eventName:
          $ref: '#/components/schemas/LocalizedText'
        status:
          type: string
          enum: [PENDING_PAYMENT, PROOF_SUBMITTED, PROOF_REJECTED, PAID, PARTIALLY_REFUNDED, REFUNDED, EXPIRED, CANCELLED]
        listAmountCents: { type: integer, format: int64 }
        discountCents: { type: integer, format: int64 }
        identOffsetCents: { type: integer, format: int64 }
        amountCents: { type: integer, format: int64 }
        currency: { type: string }
        participantCount: { type: integer, format: int32 }
        deadlineAt: { type: string, format: date-time, nullable: true }
        paidAt: { type: string, format: date-time, nullable: true }
        createdAt: { type: string, format: date-time }
    AdminOrderList:
      type: object
      required: [items, total]
      properties:
        items:
          type: array
          items:
            $ref: '#/components/schemas/AdminOrderSummary'
        total: { type: integer, format: int64 }
    AdminOrderParticipant:
      type: object
      required: [registrationId, regNo, categoryId, categoryName, fullName, priceRuleId, listPriceCents, paidCents, registrationStatus, ticketCode]
      properties:
        registrationId: { type: integer, format: int64 }
        regNo: { type: string }
        categoryId: { type: integer, format: int64 }
        categoryName:
          $ref: '#/components/schemas/LocalizedText'
        fullName: { type: string }
        priceRuleId: { type: integer, format: int64 }
        listPriceCents: { type: integer, format: int64 }
        paidCents: { type: integer, format: int64 }
        registrationStatus:
          type: string
          enum: [PENDING, CONFIRMED, CANCELLED]
        ticketCode: { type: string, nullable: true }
    AdminOrderPaymentAccount:
      type: object
      required: [id, name, provider, accountName, accountNoMasked, qrFileId]
      properties:
        id: { type: integer, format: int64 }
        name: { type: string }
        provider: { type: string }
        accountName: { type: string }
        accountNoMasked: { type: string }
        qrFileId: { type: integer, format: int64 }
    AdminLastRejection:
      type: object
      required: [code, reason, reviewedAt]
      properties:
        code: { type: string }
        reason: { type: string, nullable: true }
        reviewedAt: { type: string, format: date-time }
    AdminProofHistoryItem:
      type: object
      required: [id, proofNo, status, bankTxnRef, declaredAmountCents, rejectCode, createdAt, reviewedAt]
      properties:
        id: { type: integer, format: int64 }
        proofNo: { type: string }
        status:
          type: string
          enum: [SUBMITTED, APPROVED, REJECTED, WITHDRAWN]
        bankTxnRef: { type: string }
        declaredAmountCents: { type: integer, format: int64 }
        rejectCode: { type: string, nullable: true }
        createdAt: { type: string, format: date-time }
        reviewedAt: { type: string, format: date-time, nullable: true }
    AdminReceiptItem:
      type: object
      required: [id, txnRef, amountCents, receivedAt, matchStatus]
      properties:
        id: { type: integer, format: int64 }
        txnRef: { type: string }
        amountCents: { type: integer, format: int64 }
        receivedAt: { type: string, format: date-time }
        matchStatus:
          type: string
          enum: [APPLIED, EXCEPTION, UNMATCHED]
    AdminAppliedCoupon:
      type: object
      required: [code, discountCents, state]
      properties:
        code: { type: string }
        discountCents: { type: integer, format: int64 }
        state:
          type: string
          enum: [RESERVED, CONSUMED, RELEASED]
    AdminOrderDetail:
      type: object
      required: [id, orderNo, eventId, eventSlug, eventName, eventTimezone, status, reservationState, buyerName, buyerPhone, listAmountCents, discountCents, identOffsetCents, amountCents, currency, deadlineAt, paidAt, createdAt, paymentAccount, participants, proofs, receipts]
      properties:
        id: { type: integer, format: int64 }
        orderNo: { type: string }
        eventId: { type: integer, format: int64 }
        eventSlug: { type: string }
        eventName:
          $ref: '#/components/schemas/LocalizedText'
        eventTimezone: { type: string }
        status:
          type: string
          enum: [PENDING_PAYMENT, PROOF_SUBMITTED, PROOF_REJECTED, PAID, PARTIALLY_REFUNDED, REFUNDED, EXPIRED, CANCELLED]
        reservationState:
          type: string
          enum: [RESERVED, CONSUMED, RELEASED]
        buyerName: { type: string }
        buyerPhone: { type: string }
        listAmountCents: { type: integer, format: int64 }
        discountCents: { type: integer, format: int64 }
        identOffsetCents: { type: integer, format: int64 }
        amountCents: { type: integer, format: int64 }
        currency: { type: string }
        deadlineAt: { type: string, format: date-time, nullable: true }
        paidAt: { type: string, format: date-time, nullable: true }
        createdAt: { type: string, format: date-time }
        paymentAccount:
          $ref: '#/components/schemas/AdminOrderPaymentAccount'
        lastRejection:
          $ref: '#/components/schemas/AdminLastRejection'
        coupon:
          $ref: '#/components/schemas/AdminAppliedCoupon'
        participants:
          type: array
          items:
            $ref: '#/components/schemas/AdminOrderParticipant'
        proofs:
          type: array
          items:
            $ref: '#/components/schemas/AdminProofHistoryItem'
        receipts:
          type: array
          items:
            $ref: '#/components/schemas/AdminReceiptItem'
```

`lastRejection`、`coupon` 不在 `required` 中：没有时省略该字段（Go 侧为指针加 `omitempty`，TS 侧为可选属性）。

Run: `make gen && cd api && go build ./...`
Expected: `go build` 失败，报 `*Server does not implement apigen.StrictServerInterface (missing method AdminGetOrder)`（或 `AdminListOrders`）；`permissions.gen.go` 含 `"AdminListOrders": {Kind: AuthPermission, Permission: "order_view", Access: "read"}`。

- [ ] **Step 8: 实现 handler 与转换函数**

创建 `api/internal/registration/admin_handlers.go`：

```go
package registration

import (
	"context"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/platform/i18n"
)

func (h *Handlers) AdminListOrders(ctx context.Context, req apigen.AdminListOrdersRequestObject) (apigen.AdminListOrdersResponseObject, error) {
	f := AdminOrderFilter{EventID: req.Params.EventId}
	if req.Params.Status != nil {
		f.Status = string(*req.Params.Status)
	}
	if req.Params.Q != nil {
		f.Query = *req.Params.Q
	}
	if req.Params.Limit != nil {
		f.Limit = *req.Params.Limit
	}
	if req.Params.Offset != nil {
		f.Offset = *req.Params.Offset
	}
	items, total, err := h.svc.AdminListOrders(ctx, f)
	if err != nil {
		return nil, err
	}
	out := make([]apigen.AdminOrderSummary, 0, len(items))
	for _, o := range items {
		out = append(out, apigen.AdminOrderSummary{
			Id:               o.ID,
			OrderNo:          o.OrderNo,
			EventId:          o.EventID,
			EventSlug:        o.EventSlug,
			EventName:        adminTextToAPI(o.EventName),
			Status:           apigen.AdminOrderSummaryStatus(o.Status),
			ListAmountCents:  o.ListAmountCents,
			DiscountCents:    o.DiscountCents,
			IdentOffsetCents: o.IdentOffsetCents,
			AmountCents:      o.AmountCents,
			Currency:         o.Currency,
			ParticipantCount: int32(o.ParticipantCount),
			DeadlineAt:       o.DeadlineAt,
			PaidAt:           o.PaidAt,
			CreatedAt:        o.CreatedAt,
		})
	}
	return apigen.AdminListOrders200JSONResponse{Items: out, Total: total}, nil
}

func (h *Handlers) AdminGetOrder(ctx context.Context, req apigen.AdminGetOrderRequestObject) (apigen.AdminGetOrderResponseObject, error) {
	d, err := h.svc.AdminGetOrder(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	return apigen.AdminGetOrder200JSONResponse(AdminOrderDetailToAPI(d)), nil
}

// AdminOrderDetailToAPI 把后台订单详情转换为 OpenAPI 结构；payment 的凭证详情接口复用。
func AdminOrderDetailToAPI(d AdminOrderDetail) apigen.AdminOrderDetail {
	participants := make([]apigen.AdminOrderParticipant, 0, len(d.Participants))
	for _, p := range d.Participants {
		participants = append(participants, apigen.AdminOrderParticipant{
			RegistrationId:     p.RegistrationID,
			RegNo:              p.RegNo,
			CategoryId:         p.CategoryID,
			CategoryName:       adminTextToAPI(p.CategoryName),
			FullName:           p.FullName,
			PriceRuleId:        p.PriceRuleID,
			ListPriceCents:     p.ListPriceCents,
			PaidCents:          p.PaidCents,
			RegistrationStatus: apigen.AdminOrderParticipantRegistrationStatus(p.RegistrationStatus),
			TicketCode:         p.TicketCode,
		})
	}
	proofs := make([]apigen.AdminProofHistoryItem, 0, len(d.Proofs))
	for _, p := range d.Proofs {
		proofs = append(proofs, apigen.AdminProofHistoryItem{
			Id:                  p.ID,
			ProofNo:             p.ProofNo,
			Status:              apigen.AdminProofHistoryItemStatus(p.Status),
			BankTxnRef:          p.BankTxnRef,
			DeclaredAmountCents: p.DeclaredAmountCents,
			RejectCode:          p.RejectCode,
			CreatedAt:           p.CreatedAt,
			ReviewedAt:          p.ReviewedAt,
		})
	}
	receipts := make([]apigen.AdminReceiptItem, 0, len(d.Receipts))
	for _, r := range d.Receipts {
		receipts = append(receipts, apigen.AdminReceiptItem{
			Id:          r.ID,
			TxnRef:      r.TxnRef,
			AmountCents: r.AmountCents,
			ReceivedAt:  r.ReceivedAt,
			MatchStatus: apigen.AdminReceiptItemMatchStatus(r.MatchStatus),
		})
	}
	out := apigen.AdminOrderDetail{
		Id:               d.ID,
		OrderNo:          d.OrderNo,
		EventId:          d.EventID,
		EventSlug:        d.EventSlug,
		EventName:        adminTextToAPI(d.EventName),
		EventTimezone:    d.EventTimezone,
		Status:           apigen.AdminOrderDetailStatus(d.Status),
		ReservationState: apigen.AdminOrderDetailReservationState(d.ReservationState),
		BuyerName:        d.BuyerName,
		BuyerPhone:       d.BuyerPhone,
		ListAmountCents:  d.ListAmountCents,
		DiscountCents:    d.DiscountCents,
		IdentOffsetCents: d.IdentOffsetCents,
		AmountCents:      d.AmountCents,
		Currency:         d.Currency,
		DeadlineAt:       d.DeadlineAt,
		PaidAt:           d.PaidAt,
		CreatedAt:        d.CreatedAt,
		PaymentAccount: apigen.AdminOrderPaymentAccount{
			Id:              d.PaymentAccount.ID,
			Name:            d.PaymentAccount.Name,
			Provider:        d.PaymentAccount.Provider,
			AccountName:     d.PaymentAccount.AccountName,
			AccountNoMasked: d.PaymentAccount.AccountNoMasked,
			QrFileId:        d.PaymentAccount.QRFileID,
		},
		Participants: participants,
		Proofs:       proofs,
		Receipts:     receipts,
	}
	if d.LastRejection != nil {
		out.LastRejection = &apigen.AdminLastRejection{
			Code:       d.LastRejection.Code,
			Reason:     d.LastRejection.Reason,
			ReviewedAt: d.LastRejection.ReviewedAt,
		}
	}
	if d.Coupon != nil {
		out.Coupon = &apigen.AdminAppliedCoupon{
			Code:          d.Coupon.Code,
			DiscountCents: d.Coupon.DiscountCents,
			State:         apigen.AdminAppliedCouponState(d.Coupon.State),
		}
	}
	return out
}

func adminTextToAPI(t i18n.Text) apigen.LocalizedText {
	pick := func(l i18n.Lang) *string {
		v, ok := t[l]
		if !ok {
			return nil
		}
		return &v
	}
	return apigen.LocalizedText{Zh: pick(i18n.ZH), En: pick(i18n.EN), Km: pick(i18n.KM)}
}
```

- [ ] **Step 9: 运行 HTTP 测试，确认通过**

Run: `cd api && go test ./internal/httpapi/ -run 'TestFinanceListsAndOpensOrders|TestPhotographerCannotViewOrders' -v`
Expected: 两个测试 PASS。

- [ ] **Step 10: 全量检查**

Run: `make gen && git diff --exit-code -- api/internal/httpapi/apigen api/internal/registration/store packages/api-client/src/schema.d.ts`
Expected: 退出码 0。

Run: `cd api && go test ./... && go tool golangci-lint run ./...`
Expected: 全部 `ok`；`0 issues.`。

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过。

- [ ] **Step 11: 提交**

```bash
git add api/db/queries/registration.sql api/internal/registration/store \
  api/internal/registration/admin.go api/internal/registration/admin_test.go api/internal/registration/admin_handlers.go \
  api/openapi/openapi.yaml api/internal/httpapi/apigen api/internal/httpapi/orders_http_test.go \
  packages/api-client/src/schema.d.ts
git commit -m "$(cat <<'EOF'
feat(api): add admin order list and detail with proofs, receipts and coupon

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
)"
```

---
### Task 17: 审核通过与驳回

**Files:**
- Modify: `api/internal/platform/apperr/apperr.go`（新增 `CodeReceivedAmountTooLow`）
- Modify: `api/internal/platform/apperr/apperr_test.go`（错误码数量 35 → 36）
- Modify: `api/internal/platform/i18n/messages.zh.json`、`messages.en.json`、`messages.km.json`
- Modify: `api/db/queries/registration.sql`（追加 2 个查询）
- Modify（仅当 Step 1 核对不满足契约补充 3 时）: Task 12 中 `ConfirmPaid` 使用的订单条件更新查询
- Modify: `api/db/queries/payment.sql`（追加 8 个查询）
- Generate: `api/internal/registration/store/`、`api/internal/payment/store/`
- Modify（整文件替换）: `api/internal/registration/locks.go`
- Create: `api/internal/payment/review.go`
- Create: `api/internal/payment/review_test.go`
- Modify: `api/openapi/openapi.yaml`（新增 5 个操作与 5 个 schema）
- Generate: `api/internal/httpapi/apigen/api.gen.go`、`api/internal/httpapi/apigen/permissions.gen.go`、`packages/api-client/src/schema.d.ts`
- Create: `api/internal/payment/review_handlers.go`
- Create: `api/internal/httpapi/review_http_test.go`

**Interfaces:**
- Consumes:
  - `(*registration.Service).ConfirmPaid(ctx, tx, orderID int64, paidAt time.Time) error`（Task 12，契约补充 3）
  - `(*registration.Service).AdminGetOrder(ctx, id int64) (AdminOrderDetail, error)`、`registration.AdminOrderDetailToAPI`（Task 16）
  - `(*payment.Service).OpenPrivateFile(ctx, id int64) (storage.File, io.ReadCloser, error)`（Task 6）
  - `settings.LoadPayment(ctx, q) (Payment, error)`（`ReviewSLA`、`ReuploadWindow`）
  - `idgen.Retry`、`idgen.Code(idgen.PrefixException)`、`money.Cents`
  - `inSavepoint`、`proofFromRow`、`proofToAPI`、`trimOptional`、状态常量（Task 15，`internal/payment/proofs.go`、`proof_handlers.go`）
  - `iam.Staff`、`iam.StaffFrom`、`httpx.Gin`
- Produces:
  - `func (s *registration.Service) LockOrderByID(ctx context.Context, tx pgx.Tx, id int64) (Order, error)`
  - `func (s *registration.Service) MarkProofRejected(ctx context.Context, tx pgx.Tx, orderID int64, deadline time.Time) error`
  - `payment.ProofQueueItem`、`payment.ProofDetail`、`payment.ApproveInput`、`payment.RejectInput`（字段同 00-overview）
  - `func (s *payment.Service) ListProofs(ctx context.Context, status string) ([]ProofQueueItem, error)`
  - `func (s *payment.Service) GetProof(ctx context.Context, id int64) (ProofDetail, error)`
  - `func (s *payment.Service) ApproveProof(ctx context.Context, actor iam.Staff, id int64, in ApproveInput, meta httpx.Meta) (ProofDetail, error)`
  - `func (s *payment.Service) RejectProof(ctx context.Context, actor iam.Staff, id int64, in RejectInput, meta httpx.Meta) (ProofDetail, error)`
  - `func (s *payment.Service) OpenProofFile(ctx context.Context, id int64) (storage.File, io.ReadCloser, error)`（契约补充 1）
  - 错误码 `CodeReceivedAmountTooLow = "RECEIVED_AMOUNT_TOO_LOW"`(422，参数 `amountDue`)
  - 约束映射 `payment_receipts_payment_account_id_txn_ref_key` → `PROOF_TXN_REF_USED`(409)
  - 审计 `payment_proof.approve`、`payment_proof.reject`（`ActorType = "STAFF"`，`IsFinancial = true`）
  - OpenAPI `adminListProofs`、`adminGetProof`（`proof_review` read）、`adminApproveProof`、`adminRejectProof`（`proof_review` write）、`adminGetFile`（`proof_review` read）；schema `ProofQueueItem`、`ProofQueue`、`ProofDetail`、`ApproveProofRequest`、`RejectProofRequest`
  - `(*payment.Handlers).AdminListProofs / AdminGetProof / AdminApproveProof / AdminRejectProof / AdminGetFile`

**要点**

- 本任务不推送。Task 20 会在 `ApproveProof`、`RejectProof` 事务回调里「`audit.Record(... "payment_proof.approve"/"payment_proof.reject" ...)` 的错误检查之后、`return nil` 之前」插入推送，并使用变量 `order`（`LockOrderByID` 返回值）、方法参数 `id` 与 `in`，所以回调保持这一结构与这些变量名，`RejectProof` 把规范化后的原因码与说明写回 `in`。
- 锁顺序：先无锁读凭证拿到订单 ID → `LockOrderByID` 锁订单 → `FOR UPDATE` 锁凭证 → 校验凭证 `SUBMITTED` 且订单 `PROOF_SUBMITTED`，否则 `ORDER_STATE_CONFLICT`。与上传凭证（先锁订单再写凭证）顺序一致，避免死锁。
- `payment_receipts` 的 `UNIQUE (payment_account_id, txn_ref)` 未命名，PostgreSQL 生成的约束名为 `payment_receipts_payment_account_id_txn_ref_key`；Step 4 用 SQL 核对。
- 字段级错误：通过 `receivedAmountCents`、`receivedAt`、`note`；驳回 `rejectCode`、`rejectReason`；队列 `status`。`receivedAt` 不得晚于服务器时间 5 分钟以上（防止误填未来时间）。

- [ ] **Step 1: 核对 `ConfirmPaid` 接受 `PROOF_SUBMITTED`（契约补充 3）**

Run: `cd api && grep -rn "func (s \*Service) ConfirmPaid" -A 25 internal/registration/ && grep -n "PAID" db/queries/registration.sql`
Expected: `ConfirmPaid` 使用的订单条件更新（`UPDATE reg_orders SET status = 'PAID' ...`）的 `WHERE` 同时允许 `PENDING_PAYMENT` 与 `PROOF_SUBMITTED`，并要求 `reservation_state = 'RESERVED'`。

不满足时，把该查询的 `WHERE` 子句改为：

```sql
WHERE id = @id
  AND reservation_state = 'RESERVED'
  AND status IN ('PENDING_PAYMENT', 'PROOF_SUBMITTED')
```

然后 `cd api && go tool sqlc generate && go test ./internal/registration/`，确认 Task 12 的 0 元订单测试仍通过。

- [ ] **Step 2: 把错误码数量测试改为 36，确认失败**

`api/internal/platform/apperr/apperr_test.go`：

```go
	assert.Len(t, apperr.AllCodes, 35)
```

改为：

```go
	assert.Len(t, apperr.AllCodes, 36)
```

Run: `cd api && go test ./internal/platform/apperr/ -run TestAllCodesAreUnique`
Expected: FAIL，`should have 36 item(s), but has 35`。

- [ ] **Step 3: 新增错误码与三语文案，确认通过**

`api/internal/platform/apperr/apperr.go` 常量块，在 `CodeProofTxnRefUsed` 一行之后追加：

```go
	CodeReceivedAmountTooLow    = "RECEIVED_AMOUNT_TOO_LOW"
```

`AllCodes` 中，在 `CodeProofTxnRefUsed,` 一行之后追加：

```go
	CodeReceivedAmountTooLow,
```

`messages.zh.json`：把

```json
  "PROOF_TXN_REF_USED": "这个交易号已被其他凭证或到账记录使用，请核对后重新填写。",
```

改为

```json
  "PROOF_TXN_REF_USED": "这个交易号已被其他凭证或到账记录使用，请核对后重新填写。",
  "RECEIVED_AMOUNT_TOO_LOW": "到账金额少于应付金额 {amountDue}，不能通过；金额不符请驳回。",
```

`messages.en.json`：把

```json
  "PROOF_TXN_REF_USED": "This transaction reference is already used by another payment proof or receipt. Check it and try again.",
```

改为

```json
  "PROOF_TXN_REF_USED": "This transaction reference is already used by another payment proof or receipt. Check it and try again.",
  "RECEIVED_AMOUNT_TOO_LOW": "The received amount is less than the amount due ({amountDue}). Reject the proof as an amount mismatch instead.",
```

`messages.km.json`：把

```json
  "PROOF_TXN_REF_USED": "លេខប្រតិបត្តិការនេះត្រូវបានប្រើដោយភស្តុតាងបង់ប្រាក់ ឬកំណត់ត្រាទទួលប្រាក់ផ្សេងរួចហើយ។ សូមពិនិត្យ ហើយបញ្ចូលម្ដងទៀត។",
```

改为

```json
  "PROOF_TXN_REF_USED": "លេខប្រតិបត្តិការនេះត្រូវបានប្រើដោយភស្តុតាងបង់ប្រាក់ ឬកំណត់ត្រាទទួលប្រាក់ផ្សេងរួចហើយ។ សូមពិនិត្យ ហើយបញ្ចូលម្ដងទៀត។",
  "RECEIVED_AMOUNT_TOO_LOW": "ចំនួនទឹកប្រាក់ដែលបានទទួលតិចជាងចំនួនត្រូវបង់ ({amountDue})។ មិនអាចអនុម័តបានទេ សូមបដិសេធដោយហេតុផលចំនួនទឹកប្រាក់មិនត្រូវគ្នា។",
```

Run: `cd api && gofmt -w internal/platform/apperr/apperr.go && go test ./internal/platform/apperr/ ./internal/platform/i18n/`
Expected: 两个包 `ok`。

- [ ] **Step 4: 核对到账唯一约束名**

Run:

```bash
docker run -d --rm --name werun-pg-task17 -e POSTGRES_USER=werun -e POSTGRES_PASSWORD=werun -e POSTGRES_DB=werun -p 55433:5432 postgres:16-alpine
sleep 5
(set -a; . ./.env; set +a; cd api && WERUN_DATABASE_URL='postgres://werun:werun@127.0.0.1:55433/werun?sslmode=disable' go run ./cmd/werun migrate up)
docker exec werun-pg-task17 psql -U werun -d werun -Atc "SELECT conname FROM pg_constraint WHERE conrelid = 'payment_receipts'::regclass AND contype = 'u' ORDER BY conname"
docker exec werun-pg-task17 psql -U werun -d werun -Atc "SELECT conname FROM pg_constraint WHERE conrelid = 'payment_exceptions'::regclass AND contype = 'u'"
docker rm -f werun-pg-task17
```

（在仓库根目录执行；`.env` 提供其余必填变量，`WERUN_DATABASE_URL` 被临时库覆盖。）
Expected: 第一条输出 `payment_receipts_payment_account_id_txn_ref_key` 与 `payment_receipts_proof_id_key`；第二条输出 `payment_exceptions_exception_no_key`。名字不同时改 Step 7 中两个常量。

- [ ] **Step 5: 追加 sqlc 查询并生成**

在 `api/db/queries/registration.sql` 文件末尾追加：

```sql
-- name: LockRegOrderByID :one
SELECT * FROM reg_orders
WHERE id = @id
FOR UPDATE;

-- name: SetOrderProofRejected :execrows
UPDATE reg_orders
SET status = 'PROOF_REJECTED',
    deadline_at = sqlc.arg(deadline_at)::timestamptz,
    version = version + 1
WHERE id = @id
  AND reservation_state = 'RESERVED'
  AND status = 'PROOF_SUBMITTED';
```

在 `api/db/queries/payment.sql` 文件末尾追加：

```sql
-- name: GetPaymentProofForReview :one
SELECT sqlc.embed(p), o.order_no
FROM payment_proofs p
JOIN reg_orders o ON o.id = p.reg_order_id
WHERE p.id = @id;

-- name: LockPaymentProof :one
SELECT * FROM payment_proofs
WHERE id = @id
FOR UPDATE;

-- name: MarkPaymentProofApproved :execrows
UPDATE payment_proofs
SET status = 'APPROVED',
    reviewed_by = sqlc.arg(reviewed_by)::bigint,
    reviewed_at = sqlc.arg(reviewed_at)::timestamptz
WHERE id = @id AND status = 'SUBMITTED';

-- name: MarkPaymentProofRejected :execrows
UPDATE payment_proofs
SET status = 'REJECTED',
    reviewed_by = sqlc.arg(reviewed_by)::bigint,
    reviewed_at = sqlc.arg(reviewed_at)::timestamptz,
    reject_code = sqlc.arg(reject_code)::text,
    reject_reason = sqlc.narg(reject_reason)::text
WHERE id = @id AND status = 'SUBMITTED';

-- name: InsertPaymentReceipt :one
INSERT INTO payment_receipts (
  payment_account_id, txn_ref, amount_cents, currency, received_at,
  proof_id, reg_order_id, match_status, recorded_by_type, recorded_by
) VALUES (
  @payment_account_id, @txn_ref, @amount_cents, 'USD', @received_at,
  sqlc.arg(proof_id)::bigint, sqlc.arg(reg_order_id)::bigint, @match_status, 'STAFF', sqlc.arg(recorded_by)::bigint
)
RETURNING id;

-- name: InsertPaymentException :one
INSERT INTO payment_exceptions (exception_no, domain, type, reg_order_id, receipt_id, amount_cents, status, note)
VALUES (@exception_no, 'REGISTRATION', 'OVERPAID', sqlc.arg(reg_order_id)::bigint, @receipt_id, @amount_cents, 'OPEN', sqlc.narg(note)::text)
RETURNING id;

-- name: ListProofQueue :many
SELECT sqlc.embed(p), o.order_no, o.amount_cents AS order_amount_cents, e.name AS event_name
FROM payment_proofs p
JOIN reg_orders o ON o.id = p.reg_order_id
JOIN events e ON e.id = o.event_id
WHERE p.status = @status
ORDER BY p.created_at, p.id
LIMIT 500;

-- name: IsProofFile :one
SELECT EXISTS (SELECT 1 FROM payment_proofs WHERE file_id = @file_id);
```

Run: `cd api && go tool sqlc generate && grep -n "func (q \*Queries) \(LockRegOrderByID\|SetOrderProofRejected\)" internal/registration/store/*.go && grep -n "func (q \*Queries) \(GetPaymentProofForReview\|LockPaymentProof\|MarkPaymentProofApproved\|MarkPaymentProofRejected\|InsertPaymentReceipt\|InsertPaymentException\|ListProofQueue\|IsProofFile\)" internal/payment/store/*.go`
Expected: 10 个方法都存在；`IsProofFile(ctx context.Context, fileID int64) (bool, error)`；`ListProofQueue(ctx context.Context, status string) ([]ListProofQueueRow, error)`，`ListProofQueueRow` 含 `PaymentProof PaymentProof`、`OrderNo string`、`OrderAmountCents int64`、`EventName []byte`。

- [ ] **Step 6: 写服务层失败测试**

创建 `api/internal/payment/review_test.go`：

```go
package payment_test

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"werun/api/internal/iam"
	"werun/api/internal/payment"
	"werun/api/internal/payment/paytest"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/money"
	"werun/api/internal/runner"
)

type reviewCase struct {
	env     *paytest.Env
	fx      paytest.Fixture
	finance iam.Staff
}

func newReviewCase(t *testing.T) reviewCase {
	t.Helper()
	env := paytest.NewEnv(t)
	return reviewCase{env: env, fx: paytest.SeedEvent(t, env.Pool), finance: paytest.SeedStaff(t, env.Pool, iam.RoleFinance)}
}

// submitted 建订单并通过 SubmitProof 上传一份申报金额等于应付的凭证；截图颜色由 telegramID 决定。
func (c reviewCase) submitted(t *testing.T, telegramID int64, spec paytest.OrderSpec) (runner.User, paytest.OrderRef, payment.Proof) {
	t.Helper()
	u := paytest.SeedUser(t, c.env.Pool, telegramID, "Sokha Chan")
	order := paytest.SeedOrder(t, c.env, c.fx, u, spec)
	proof, err := c.env.Payments.SubmitProof(context.Background(), u, order.OrderNo,
		proofInput(paytest.PNG(t, uint8(telegramID%251)), "TXN"+order.OrderNo, order.AmountCents), testMeta)
	require.NoError(t, err)
	return u, order, proof
}

func counters(t *testing.T, env *paytest.Env, table string, id int64) [2]int {
	t.Helper()
	var used, reserved int
	require.NoError(t, env.Pool.QueryRow(context.Background(),
		`SELECT used_count, reserved_count FROM `+table+` WHERE id = $1`, id).Scan(&used, &reserved))
	return [2]int{used, reserved}
}

func TestApproveExactAmountConfirmsOrderAndConsumesCounters(t *testing.T) {
	c := newReviewCase(t)
	ctx := context.Background()
	_, order, proof := c.submitted(t, 7501, paytest.OrderSpec{WithCoupon: true})
	receivedAt := c.env.Clock.Now().Add(-10 * time.Minute)

	detail, err := c.env.Payments.ApproveProof(ctx, c.finance, proof.ID,
		payment.ApproveInput{ReceivedAmountCents: order.AmountCents, ReceivedAt: receivedAt}, testMeta)

	require.NoError(t, err)
	require.Equal(t, proof.ID, detail.ID)
	require.Equal(t, "APPROVED", detail.Status)
	require.NotNil(t, detail.ReviewedBy)
	require.Equal(t, c.finance.ID, *detail.ReviewedBy)
	require.NotNil(t, detail.ReviewedAt)
	require.Equal(t, "PAID", detail.Order.Status)

	var status, reservation string
	var paidAt, deadline *time.Time
	require.NoError(t, c.env.Pool.QueryRow(ctx,
		`SELECT status, reservation_state, paid_at, deadline_at FROM reg_orders WHERE id = $1`, order.ID).
		Scan(&status, &reservation, &paidAt, &deadline))
	require.Equal(t, "PAID", status)
	require.Equal(t, "CONSUMED", reservation)
	require.NotNil(t, paidAt)
	require.True(t, paidAt.Equal(receivedAt), "paid_at 应等于到账时间")
	require.Nil(t, deadline)

	require.Equal(t, 1, paytest.Count(t, c.env.Pool, `
		SELECT count(*) FROM registrations r JOIN order_participants op ON op.id = r.order_participant_id
		WHERE op.order_id = $1 AND r.status = 'CONFIRMED' AND r.confirmed_at IS NOT NULL`, order.ID))
	require.Equal(t, [2]int{1, 0}, counters(t, c.env, "event_categories", c.fx.CategoryID))
	require.Equal(t, [2]int{1, 0}, counters(t, c.env, "price_rules", c.fx.PriceRuleID))
	require.Equal(t, [2]int{1, 0}, counters(t, c.env, "coupons", c.fx.CouponID))
	require.Equal(t, 1, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM coupon_redemptions WHERE order_id = $1 AND state = 'CONSUMED'`, order.ID))

	var matchStatus, txnRef string
	var amount, recordedBy int64
	require.NoError(t, c.env.Pool.QueryRow(ctx,
		`SELECT match_status, amount_cents, txn_ref, recorded_by FROM payment_receipts WHERE proof_id = $1`, proof.ID).
		Scan(&matchStatus, &amount, &txnRef, &recordedBy))
	require.Equal(t, "APPLIED", matchStatus)
	require.Equal(t, order.AmountCents, amount)
	require.Equal(t, proof.BankTxnRef, txnRef)
	require.Equal(t, c.finance.ID, recordedBy)
	require.Equal(t, 0, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM payment_exceptions`))

	require.Equal(t, 1, paytest.Count(t, c.env.Pool, `
		SELECT count(*) FROM audit_logs
		WHERE action = 'payment_proof.approve' AND entity_type = 'payment_proof' AND entity_id = $1
		  AND actor_type = 'STAFF' AND actor_id = $2 AND actor_role = 'FINANCE' AND is_financial`, proof.ID, c.finance.ID))
}

func TestApproveOverpaidRecordsOpenException(t *testing.T) {
	c := newReviewCase(t)
	ctx := context.Background()
	_, order, proof := c.submitted(t, 7502, paytest.OrderSpec{})
	note := "客户多转了 1.50 美元"

	detail, err := c.env.Payments.ApproveProof(ctx, c.finance, proof.ID, payment.ApproveInput{
		ReceivedAmountCents: order.AmountCents + 150, ReceivedAt: c.env.Clock.Now(), Note: &note,
	}, testMeta)

	require.NoError(t, err)
	require.Equal(t, "PAID", detail.Order.Status)

	var receiptID, receiptAmount int64
	var matchStatus string
	require.NoError(t, c.env.Pool.QueryRow(ctx,
		`SELECT id, amount_cents, match_status FROM payment_receipts WHERE proof_id = $1`, proof.ID).
		Scan(&receiptID, &receiptAmount, &matchStatus))
	require.Equal(t, "EXCEPTION", matchStatus)
	require.Equal(t, order.AmountCents+150, receiptAmount)

	var exceptionNo, domain, typ, status string
	var exAmount, exReceipt int64
	var exNote *string
	require.NoError(t, c.env.Pool.QueryRow(ctx, `
		SELECT exception_no, domain, type, status, amount_cents, receipt_id, note
		FROM payment_exceptions WHERE reg_order_id = $1`, order.ID).
		Scan(&exceptionNo, &domain, &typ, &status, &exAmount, &exReceipt, &exNote))
	require.True(t, strings.HasPrefix(exceptionNo, "EX"))
	require.Len(t, exceptionNo, 10)
	require.Equal(t, "REGISTRATION", domain)
	require.Equal(t, "OVERPAID", typ)
	require.Equal(t, "OPEN", status)
	require.EqualValues(t, 150, exAmount)
	require.Equal(t, receiptID, exReceipt)
	require.Equal(t, &note, exNote)
}

func TestApproveUnderpaidChangesNothing(t *testing.T) {
	c := newReviewCase(t)
	ctx := context.Background()
	_, order, proof := c.submitted(t, 7503, paytest.OrderSpec{})

	_, err := c.env.Payments.ApproveProof(ctx, c.finance, proof.ID,
		payment.ApproveInput{ReceivedAmountCents: order.AmountCents - 1, ReceivedAt: c.env.Clock.Now()}, testMeta)

	ae := requireAppErr(t, err, apperr.CodeReceivedAmountTooLow, http.StatusUnprocessableEntity)
	require.Equal(t, money.Cents(order.AmountCents).String(), ae.Params["amountDue"])
	require.Equal(t, apperr.CodeReceivedAmountTooLow, ae.Fields["receivedAmountCents"].Key)
	require.Equal(t, 1, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM payment_proofs WHERE id = $1 AND status = 'SUBMITTED' AND reviewed_by IS NULL`, proof.ID))
	require.Equal(t, 1, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM reg_orders WHERE id = $1 AND status = 'PROOF_SUBMITTED' AND reservation_state = 'RESERVED'`, order.ID))
	require.Equal(t, 0, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM payment_receipts`))
	require.Equal(t, [2]int{0, 1}, counters(t, c.env, "event_categories", c.fx.CategoryID))
	require.Equal(t, 0, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM audit_logs WHERE action = 'payment_proof.approve'`))
}

func TestReviewAfterApprovalConflicts(t *testing.T) {
	c := newReviewCase(t)
	ctx := context.Background()
	_, order, proof := c.submitted(t, 7504, paytest.OrderSpec{})
	in := payment.ApproveInput{ReceivedAmountCents: order.AmountCents, ReceivedAt: c.env.Clock.Now()}
	_, err := c.env.Payments.ApproveProof(ctx, c.finance, proof.ID, in, testMeta)
	require.NoError(t, err)

	_, err = c.env.Payments.ApproveProof(ctx, c.finance, proof.ID, in, testMeta)
	requireAppErr(t, err, apperr.CodeOrderStateConflict, http.StatusConflict)
	_, err = c.env.Payments.RejectProof(ctx, c.finance, proof.ID, payment.RejectInput{Code: "UNREADABLE"}, testMeta)
	requireAppErr(t, err, apperr.CodeOrderStateConflict, http.StatusConflict)

	require.Equal(t, 1, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM payment_receipts`))
	require.Equal(t, [2]int{1, 0}, counters(t, c.env, "event_categories", c.fx.CategoryID))
}

func TestApproveRejectsTxnRefAlreadyReceived(t *testing.T) {
	c := newReviewCase(t)
	ctx := context.Background()
	_, order, proof := c.submitted(t, 7505, paytest.OrderSpec{})
	_, err := c.env.Pool.Exec(ctx, `
		INSERT INTO payment_receipts (payment_account_id, txn_ref, amount_cents, currency, received_at, match_status, recorded_by_type)
		VALUES ($1, $2, 999, 'USD', now(), 'UNMATCHED', 'SYSTEM')`, c.fx.AccountID, proof.BankTxnRef)
	require.NoError(t, err)

	_, err = c.env.Payments.ApproveProof(ctx, c.finance, proof.ID,
		payment.ApproveInput{ReceivedAmountCents: order.AmountCents, ReceivedAt: c.env.Clock.Now()}, testMeta)

	requireAppErr(t, err, apperr.CodeProofTxnRefUsed, http.StatusConflict)
	require.Equal(t, 1, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM payment_proofs WHERE id = $1 AND status = 'SUBMITTED'`, proof.ID))
	require.Equal(t, 1, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM reg_orders WHERE id = $1 AND status = 'PROOF_SUBMITTED'`, order.ID))
	require.Equal(t, 1, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM payment_receipts`))
}

func TestApproveValidatesInput(t *testing.T) {
	c := newReviewCase(t)
	_, order, proof := c.submitted(t, 7506, paytest.OrderSpec{})
	longNote := strings.Repeat("备", 501)
	now := c.env.Clock.Now()

	cases := []struct {
		name  string
		in    payment.ApproveInput
		field string
		key   string
	}{
		{"到账金额为 0", payment.ApproveInput{ReceivedAmountCents: 0, ReceivedAt: now}, "receivedAmountCents", "field.must_be_positive"},
		{"缺少到账时间", payment.ApproveInput{ReceivedAmountCents: order.AmountCents}, "receivedAt", "field.required"},
		{"到账时间在未来", payment.ApproveInput{ReceivedAmountCents: order.AmountCents, ReceivedAt: now.Add(time.Hour)}, "receivedAt", "field.invalid"},
		{"备注超过 500 字", payment.ApproveInput{ReceivedAmountCents: order.AmountCents, ReceivedAt: now, Note: &longNote}, "note", "field.too_long"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := c.env.Payments.ApproveProof(context.Background(), c.finance, proof.ID, tc.in, testMeta)
			ae := requireAppErr(t, err, apperr.CodeValidation, http.StatusUnprocessableEntity)
			require.Equal(t, tc.key, ae.Fields[tc.field].Key)
		})
	}

	_, err := c.env.Payments.ApproveProof(context.Background(), c.finance, 999999,
		payment.ApproveInput{ReceivedAmountCents: order.AmountCents, ReceivedAt: now}, testMeta)
	requireAppErr(t, err, apperr.CodeNotFound, http.StatusNotFound)
}

func TestRejectOpensReuploadWindow(t *testing.T) {
	c := newReviewCase(t)
	ctx := context.Background()
	_, order, proof := c.submitted(t, 7507, paytest.OrderSpec{})
	reason := "  看不清金额  "

	detail, err := c.env.Payments.RejectProof(ctx, c.finance, proof.ID, payment.RejectInput{Code: "unreadable", Reason: &reason}, testMeta)

	require.NoError(t, err)
	require.Equal(t, "REJECTED", detail.Status)
	require.NotNil(t, detail.RejectCode)
	require.Equal(t, "UNREADABLE", *detail.RejectCode)
	require.NotNil(t, detail.RejectReason)
	require.Equal(t, "看不清金额", *detail.RejectReason)
	require.Equal(t, "PROOF_REJECTED", detail.Order.Status)
	wantDeadline := c.env.Clock.Now().Add(24 * time.Hour)
	require.NotNil(t, detail.Order.DeadlineAt)
	require.True(t, detail.Order.DeadlineAt.Equal(wantDeadline), "重传截止应为 now+24h，得到 %v", detail.Order.DeadlineAt)

	var deadline *time.Time
	require.NoError(t, c.env.Pool.QueryRow(ctx, `SELECT deadline_at FROM reg_orders WHERE id = $1`, order.ID).Scan(&deadline))
	require.NotNil(t, deadline)
	require.True(t, deadline.Equal(wantDeadline))
	require.Equal(t, [2]int{0, 1}, counters(t, c.env, "event_categories", c.fx.CategoryID))
	require.Equal(t, 1, paytest.Count(t, c.env.Pool, `
		SELECT count(*) FROM audit_logs
		WHERE action = 'payment_proof.reject' AND entity_id = $1 AND actor_id = $2 AND is_financial`, proof.ID, c.finance.ID))
}

func TestRejectValidatesCodeAndReason(t *testing.T) {
	c := newReviewCase(t)
	_, _, proof := c.submitted(t, 7508, paytest.OrderSpec{})
	blank := "   "
	long := strings.Repeat("理", 501)

	cases := []struct {
		name  string
		in    payment.RejectInput
		field string
		key   string
	}{
		{"未知原因码", payment.RejectInput{Code: "LOST"}, "rejectCode", "field.invalid"},
		{"OTHER 不填说明", payment.RejectInput{Code: "OTHER"}, "rejectReason", "field.required"},
		{"OTHER 说明全是空白", payment.RejectInput{Code: "OTHER", Reason: &blank}, "rejectReason", "field.required"},
		{"说明超过 500 字", payment.RejectInput{Code: "UNREADABLE", Reason: &long}, "rejectReason", "field.too_long"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := c.env.Payments.RejectProof(context.Background(), c.finance, proof.ID, tc.in, testMeta)
			ae := requireAppErr(t, err, apperr.CodeValidation, http.StatusUnprocessableEntity)
			require.Equal(t, tc.key, ae.Fields[tc.field].Key)
		})
	}
	require.Equal(t, 1, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM payment_proofs WHERE id = $1 AND status = 'SUBMITTED'`, proof.ID))
}

func TestReuploadAfterRejectionThenApprove(t *testing.T) {
	c := newReviewCase(t)
	ctx := context.Background()
	u, order, first := c.submitted(t, 7509, paytest.OrderSpec{})
	_, err := c.env.Payments.RejectProof(ctx, c.finance, first.ID, payment.RejectInput{Code: "AMOUNT_MISMATCH"}, testMeta)
	require.NoError(t, err)

	c.env.Clock.Advance(time.Hour)
	second, err := c.env.Payments.SubmitProof(ctx, u, order.OrderNo,
		proofInput(paytest.PNG(t, 222), first.BankTxnRef, order.AmountCents), testMeta)
	require.NoError(t, err)
	detail, err := c.env.Payments.ApproveProof(ctx, c.finance, second.ID,
		payment.ApproveInput{ReceivedAmountCents: order.AmountCents, ReceivedAt: c.env.Clock.Now()}, testMeta)

	require.NoError(t, err)
	require.Equal(t, "PAID", detail.Order.Status)
	require.Len(t, detail.Order.Proofs, 2)
	require.Equal(t, second.ID, detail.Order.Proofs[0].ID)
	require.Equal(t, "APPROVED", detail.Order.Proofs[0].Status)
	require.Equal(t, first.ID, detail.Order.Proofs[1].ID)
	require.Equal(t, "REJECTED", detail.Order.Proofs[1].Status)
	require.Len(t, detail.Order.Receipts, 1)
	require.Equal(t, [2]int{1, 0}, counters(t, c.env, "event_categories", c.fx.CategoryID))
}

func TestListProofsQueueOrderAndSLA(t *testing.T) {
	c := newReviewCase(t)
	ctx := context.Background()
	_, order, p1 := c.submitted(t, 7510, paytest.OrderSpec{})
	_, _, p2 := c.submitted(t, 7511, paytest.OrderSpec{})
	_, _, p3 := c.submitted(t, 7512, paytest.OrderSpec{})
	now := c.env.Clock.Now()
	for id, at := range map[int64]time.Time{p1.ID: now.Add(-25 * time.Hour), p2.ID: now.Add(-2 * time.Hour), p3.ID: now.Add(-time.Hour)} {
		_, err := c.env.Pool.Exec(ctx, `UPDATE payment_proofs SET created_at = $2 WHERE id = $1`, id, at)
		require.NoError(t, err)
	}
	_, err := c.env.Payments.RejectProof(ctx, c.finance, p3.ID, payment.RejectInput{Code: "NOT_RECEIVED"}, testMeta)
	require.NoError(t, err)

	items, err := c.env.Payments.ListProofs(ctx, "")
	require.NoError(t, err)
	require.Len(t, items, 2)
	require.Equal(t, p1.ID, items[0].ID)
	require.Equal(t, p2.ID, items[1].ID)
	require.True(t, items[0].OverSLA)
	require.False(t, items[1].OverSLA)
	require.Equal(t, order.AmountCents, items[0].AmountCents)
	require.Equal(t, order.OrderNo, items[0].OrderNo)
	require.Equal(t, "Phnom Penh Half Marathon 2026", items[0].EventName[i18n.EN])
	require.True(t, items[0].WaitingSince.Equal(now.Add(-25*time.Hour)))

	rejected, err := c.env.Payments.ListProofs(ctx, "rejected")
	require.NoError(t, err)
	require.Len(t, rejected, 1)
	require.Equal(t, p3.ID, rejected[0].ID)
	require.False(t, rejected[0].OverSLA)

	_, err = c.env.Payments.ListProofs(ctx, "WITHDRAWN")
	ae := requireAppErr(t, err, apperr.CodeValidation, http.StatusUnprocessableEntity)
	require.Equal(t, "field.invalid", ae.Fields["status"].Key)
}

func TestGetProofAndOpenProofFile(t *testing.T) {
	c := newReviewCase(t)
	ctx := context.Background()
	_, order, proof := c.submitted(t, 7513, paytest.OrderSpec{})

	detail, err := c.env.Payments.GetProof(ctx, proof.ID)
	require.NoError(t, err)
	require.Equal(t, order.OrderNo, detail.OrderNo)
	require.Equal(t, order.ID, detail.Order.ID)
	require.Len(t, detail.Order.Proofs, 1)

	_, err = c.env.Payments.GetProof(ctx, 999999)
	requireAppErr(t, err, apperr.CodeNotFound, http.StatusNotFound)

	file, body, err := c.env.Payments.OpenProofFile(ctx, proof.FileID)
	require.NoError(t, err)
	data, err := io.ReadAll(body)
	require.NoError(t, body.Close())
	require.NoError(t, err)
	require.Equal(t, "image/png", file.MIME)
	require.Equal(t, paytest.PNG(t, uint8(7513%251)), data)

	_, _, err = c.env.Payments.OpenProofFile(ctx, c.fx.QRFileID)
	requireAppErr(t, err, apperr.CodeNotFound, http.StatusNotFound)
}
```

- [ ] **Step 7: 运行测试，确认失败**

Run: `cd api && go test ./internal/payment/ -run 'TestApprove|TestReject|TestReview|TestReupload|TestListProofs|TestGetProof' -v`
Expected: 编译失败，报 `c.env.Payments.ApproveProof undefined`、`undefined: payment.ApproveInput`、`undefined: payment.RejectInput`。

- [ ] **Step 8: 整文件替换 `registration/locks.go`**

`api/internal/registration/locks.go` 替换为：

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

	"werun/api/internal/platform/apperr"
	"werun/api/internal/registration/store"
)

// LockOrderByNo 在调用方事务里锁定订单行（FOR UPDATE）。订单号不区分大小写；不存在返回 ORDER_NOT_FOUND。
func (s *Service) LockOrderByNo(ctx context.Context, tx pgx.Tx, orderNo string) (Order, error) {
	row, err := store.New(tx).LockRegOrderByNo(ctx, strings.ToUpper(strings.TrimSpace(orderNo)))
	if errors.Is(err, pgx.ErrNoRows) {
		return Order{}, apperr.New(http.StatusNotFound, apperr.CodeOrderNotFound)
	}
	if err != nil {
		return Order{}, fmt.Errorf("lock order %q: %w", orderNo, err)
	}
	return orderFromLockedRow(row), nil
}

// LockOrderByID 在调用方事务里按主键锁定订单行；不存在返回 ORDER_NOT_FOUND。
func (s *Service) LockOrderByID(ctx context.Context, tx pgx.Tx, id int64) (Order, error) {
	row, err := store.New(tx).LockRegOrderByID(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Order{}, apperr.New(http.StatusNotFound, apperr.CodeOrderNotFound)
	}
	if err != nil {
		return Order{}, fmt.Errorf("lock order %d: %w", id, err)
	}
	return orderFromLockedRow(row), nil
}

// MarkProofSubmitted 把待付款或被驳回的订单改为审核中并清空截止时间；状态不符返回 ORDER_STATE_CONFLICT。
func (s *Service) MarkProofSubmitted(ctx context.Context, tx pgx.Tx, orderID int64) error {
	n, err := store.New(tx).SetOrderProofSubmitted(ctx, orderID)
	if err != nil {
		return fmt.Errorf("mark order %d proof submitted: %w", orderID, err)
	}
	if n != 1 {
		return apperr.New(http.StatusConflict, apperr.CodeOrderStateConflict)
	}
	return nil
}

// MarkProofRejected 把审核中的订单改为被驳回，并设置重传截止时间；状态不符返回 ORDER_STATE_CONFLICT。
func (s *Service) MarkProofRejected(ctx context.Context, tx pgx.Tx, orderID int64, deadline time.Time) error {
	n, err := store.New(tx).SetOrderProofRejected(ctx, store.SetOrderProofRejectedParams{ID: orderID, DeadlineAt: deadline.UTC()})
	if err != nil {
		return fmt.Errorf("mark order %d proof rejected: %w", orderID, err)
	}
	if n != 1 {
		return apperr.New(http.StatusConflict, apperr.CodeOrderStateConflict)
	}
	return nil
}

func orderFromLockedRow(r store.RegOrder) Order {
	o := Order{
		ID:               r.ID,
		EventID:          r.EventID,
		OrderNo:          r.OrderNo,
		Status:           r.Status,
		ReservationState: r.ReservationState,
		ListAmountCents:  r.ListAmountCents,
		DiscountCents:    r.DiscountCents,
		IdentOffsetCents: int64(r.IdentOffsetCents),
		AmountCents:      r.AmountCents,
		Currency:         r.Currency,
		DeadlineAt:       r.DeadlineAt,
		PaidAt:           r.PaidAt,
		CreatedAt:        r.CreatedAt,
	}
	if r.BuyerUserID != nil {
		o.BuyerUserID = *r.BuyerUserID
	}
	if r.PaymentAccountID != nil {
		o.PaymentAccountID = *r.PaymentAccountID
	}
	return o
}
```

- [ ] **Step 9: 实现审核服务**

创建 `api/internal/payment/review.go`：

```go
package payment

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/audit"
	"werun/api/internal/iam"
	"werun/api/internal/payment/store"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/idgen"
	"werun/api/internal/platform/money"
	"werun/api/internal/platform/settings"
	"werun/api/internal/platform/storage"
	"werun/api/internal/registration"
)

func init() {
	apperr.RegisterConstraint(constraintReceiptTxnRef, func() *apperr.Error {
		return apperr.New(http.StatusConflict, apperr.CodeProofTxnRefUsed)
	})
}

const (
	constraintReceiptTxnRef = "payment_receipts_payment_account_id_txn_ref_key"
	constraintExceptionNo   = "payment_exceptions_exception_no_key"

	maxReviewTextLen = 500
	// receivedAtFutureTolerance 是到账时间允许晚于服务器时间的最大偏差（财务电脑时钟误差）。
	receivedAtFutureTolerance = 5 * time.Minute
)

var (
	rejectCodes = map[string]bool{
		"NOT_RECEIVED": true, "AMOUNT_MISMATCH": true, "DUPLICATE_TXN": true, "UNREADABLE": true,
		"WRONG_ACCOUNT": true, "FRAUD": true, "OTHER": true,
	}
	queueStatuses = map[string]bool{proofStatusSubmitted: true, proofStatusApproved: true, proofStatusRejected: true}
)

// ProofQueueItem 是审核队列中的一行。
type ProofQueueItem struct {
	Proof
	AmountCents  int64
	EventName    i18n.Text
	WaitingSince time.Time
	OverSLA      bool
}

// ProofDetail 是凭证详情：凭证本身加所属订单的后台详情。
type ProofDetail struct {
	Proof
	Order registration.AdminOrderDetail
}

type ApproveInput struct {
	ReceivedAmountCents int64
	ReceivedAt          time.Time
	Note                *string
}

type RejectInput struct {
	Code   string
	Reason *string
}

// ListProofs 列出某个状态的凭证（空串为 SUBMITTED），按提交时间升序；待审且等待超过 payment.review_sla_hours 的标记 OverSLA。
func (s *Service) ListProofs(ctx context.Context, status string) ([]ProofQueueItem, error) {
	status = strings.ToUpper(strings.TrimSpace(status))
	if status == "" {
		status = proofStatusSubmitted
	}
	if !queueStatuses[status] {
		return nil, apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation).WithField("status", "field.invalid", nil)
	}
	cfg, err := settings.LoadPayment(ctx, s.pool)
	if err != nil {
		return nil, fmt.Errorf("load payment settings: %w", err)
	}
	rows, err := store.New(s.pool).ListProofQueue(ctx, status)
	if err != nil {
		return nil, fmt.Errorf("list proof queue: %w", err)
	}
	now := s.now()
	items := make([]ProofQueueItem, 0, len(rows))
	for _, r := range rows {
		var name i18n.Text
		if err := json.Unmarshal(r.EventName, &name); err != nil {
			return nil, fmt.Errorf("decode event name of proof %d: %w", r.PaymentProof.ID, err)
		}
		p := proofFromRow(r.PaymentProof, r.OrderNo)
		items = append(items, ProofQueueItem{
			Proof:        p,
			AmountCents:  r.OrderAmountCents,
			EventName:    name,
			WaitingSince: p.CreatedAt,
			OverSLA:      p.Status == proofStatusSubmitted && now.Sub(p.CreatedAt) > cfg.ReviewSLA,
		})
	}
	return items, nil
}

// GetProof 返回凭证与所属订单详情；不存在（或不属于报名订单）返回 NOT_FOUND。
func (s *Service) GetProof(ctx context.Context, id int64) (ProofDetail, error) {
	row, err := store.New(s.pool).GetPaymentProofForReview(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ProofDetail{}, apperr.New(http.StatusNotFound, apperr.CodeNotFound)
	}
	if err != nil {
		return ProofDetail{}, fmt.Errorf("get proof %d: %w", id, err)
	}
	p := proofFromRow(row.PaymentProof, row.OrderNo)
	order, err := s.orders.AdminGetOrder(ctx, p.OrderID)
	if err != nil {
		return ProofDetail{}, err
	}
	return ProofDetail{Proof: p, Order: order}, nil
}

// ApproveProof 按 spec 6.3 通过凭证：写到账记录（多付时登记 OVERPAID 异常），订单确认付款并核销名额，写审计。
func (s *Service) ApproveProof(ctx context.Context, actor iam.Staff, id int64, in ApproveInput, meta httpx.Meta) (ProofDetail, error) {
	note := trimOptional(in.Note)
	if err := s.validateApprove(in, note); err != nil {
		return ProofDetail{}, err
	}
	receivedAt := in.ReceivedAt.UTC()

	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		proof, order, err := s.lockForReview(ctx, tx, q, id)
		if err != nil {
			return err
		}
		if in.ReceivedAmountCents < order.AmountCents {
			params := map[string]any{"amountDue": money.Cents(order.AmountCents).String()}
			return apperr.New(http.StatusUnprocessableEntity, apperr.CodeReceivedAmountTooLow).
				WithParams(params).
				WithField("receivedAmountCents", apperr.CodeReceivedAmountTooLow, params)
		}

		n, err := q.MarkPaymentProofApproved(ctx, store.MarkPaymentProofApprovedParams{
			ID: proof.ID, ReviewedBy: actor.ID, ReviewedAt: s.now(),
		})
		if err != nil {
			return fmt.Errorf("approve proof %d: %w", proof.ID, err)
		}
		if n != 1 {
			return apperr.New(http.StatusConflict, apperr.CodeOrderStateConflict)
		}

		overpaid := in.ReceivedAmountCents - order.AmountCents
		matchStatus := "APPLIED"
		if overpaid > 0 {
			matchStatus = "EXCEPTION"
		}
		receiptID, err := q.InsertPaymentReceipt(ctx, store.InsertPaymentReceiptParams{
			PaymentAccountID: proof.PaymentAccountID,
			TxnRef:           proof.BankTxnRef,
			AmountCents:      in.ReceivedAmountCents,
			ReceivedAt:       receivedAt,
			ProofID:          proof.ID,
			RegOrderID:       order.ID,
			MatchStatus:      matchStatus,
			RecordedBy:       actor.ID,
		})
		if err != nil {
			return apperr.FromPG(err)
		}

		after := map[string]any{
			"proofStatus":         proofStatusApproved,
			"orderStatus":         "PAID",
			"receivedAmountCents": in.ReceivedAmountCents,
			"receivedAt":          receivedAt,
			"receiptId":           receiptID,
			"matchStatus":         matchStatus,
		}
		if note != nil {
			after["note"] = *note
		}
		if overpaid > 0 {
			var exceptionNo string
			err := idgen.Retry(constraintExceptionNo, func() error {
				return inSavepoint(ctx, tx, func(sq *store.Queries) error {
					exceptionNo = idgen.Code(idgen.PrefixException)
					_, insertErr := sq.InsertPaymentException(ctx, store.InsertPaymentExceptionParams{
						ExceptionNo: exceptionNo,
						RegOrderID:  order.ID,
						ReceiptID:   receiptID,
						AmountCents: overpaid,
						Note:        note,
					})
					return insertErr
				})
			})
			if err != nil {
				return apperr.FromPG(err)
			}
			after["overpaidCents"] = overpaid
			after["exceptionNo"] = exceptionNo
		}

		if err := s.orders.ConfirmPaid(ctx, tx, order.ID, receivedAt); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, reviewAudit(actor, "payment_proof.approve", proof, order,
			fmt.Sprintf("通过凭证 %s，订单 %s 到账 %s", proof.ProofNo, order.OrderNo, money.Cents(in.ReceivedAmountCents)),
			after, meta)); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return ProofDetail{}, err
	}
	return s.GetProof(ctx, id)
}

// RejectProof 按 spec 6.4 驳回凭证：订单改为被驳回并开放重传期，写审计。
func (s *Service) RejectProof(ctx context.Context, actor iam.Staff, id int64, in RejectInput, meta httpx.Meta) (ProofDetail, error) {
	// 规范化结果写回 in：事务内以及之后使用 in 的代码（Task 20 的推送）拿到的都是规范化后的原因码与说明。
	in.Code = strings.ToUpper(strings.TrimSpace(in.Code))
	in.Reason = trimOptional(in.Reason)
	code, reason := in.Code, in.Reason
	if err := validateReject(code, reason); err != nil {
		return ProofDetail{}, err
	}

	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		proof, order, err := s.lockForReview(ctx, tx, q, id)
		if err != nil {
			return err
		}
		cfg, err := settings.LoadPayment(ctx, tx)
		if err != nil {
			return fmt.Errorf("load payment settings: %w", err)
		}
		now := s.now()
		n, err := q.MarkPaymentProofRejected(ctx, store.MarkPaymentProofRejectedParams{
			ID: proof.ID, ReviewedBy: actor.ID, ReviewedAt: now, RejectCode: code, RejectReason: reason,
		})
		if err != nil {
			return fmt.Errorf("reject proof %d: %w", proof.ID, err)
		}
		if n != 1 {
			return apperr.New(http.StatusConflict, apperr.CodeOrderStateConflict)
		}
		deadline := now.Add(cfg.ReuploadWindow)
		if err := s.orders.MarkProofRejected(ctx, tx, order.ID, deadline); err != nil {
			return err
		}

		after := map[string]any{
			"proofStatus": proofStatusRejected,
			"orderStatus": orderProofRejected,
			"rejectCode":  code,
			"deadlineAt":  deadline.UTC(),
		}
		if reason != nil {
			after["rejectReason"] = *reason
		}
		if err := audit.Record(ctx, tx, reviewAudit(actor, "payment_proof.reject", proof, order,
			fmt.Sprintf("驳回凭证 %s（%s），订单 %s 可重传至 %s", proof.ProofNo, code, order.OrderNo, deadline.UTC().Format(time.RFC3339)),
			after, meta)); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return ProofDetail{}, err
	}
	return s.GetProof(ctx, id)
}

// OpenProofFile 只打开被凭证引用的文件；其他文件一律 NOT_FOUND。
func (s *Service) OpenProofFile(ctx context.Context, id int64) (storage.File, io.ReadCloser, error) {
	ok, err := store.New(s.pool).IsProofFile(ctx, id)
	if err != nil {
		return storage.File{}, nil, fmt.Errorf("check proof file %d: %w", id, err)
	}
	if !ok {
		return storage.File{}, nil, apperr.New(http.StatusNotFound, apperr.CodeNotFound)
	}
	return s.OpenPrivateFile(ctx, id)
}

// lockForReview 先锁订单再锁凭证（与上传凭证的加锁顺序一致），并校验凭证待审、订单审核中。
func (s *Service) lockForReview(ctx context.Context, tx pgx.Tx, q *store.Queries, id int64) (store.PaymentProof, registration.Order, error) {
	ref, err := q.GetPaymentProofForReview(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return store.PaymentProof{}, registration.Order{}, apperr.New(http.StatusNotFound, apperr.CodeNotFound)
	}
	if err != nil {
		return store.PaymentProof{}, registration.Order{}, fmt.Errorf("read proof %d: %w", id, err)
	}
	order, err := s.orders.LockOrderByID(ctx, tx, *ref.PaymentProof.RegOrderID)
	if err != nil {
		return store.PaymentProof{}, registration.Order{}, err
	}
	proof, err := q.LockPaymentProof(ctx, id)
	if err != nil {
		return store.PaymentProof{}, registration.Order{}, fmt.Errorf("lock proof %d: %w", id, err)
	}
	if proof.Status != proofStatusSubmitted || order.Status != orderProofSubmitted {
		return store.PaymentProof{}, registration.Order{}, apperr.New(http.StatusConflict, apperr.CodeOrderStateConflict)
	}
	return proof, order, nil
}

func (s *Service) validateApprove(in ApproveInput, note *string) error {
	verr := apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)
	if in.ReceivedAmountCents <= 0 {
		verr = verr.WithField("receivedAmountCents", "field.must_be_positive", nil)
	}
	switch {
	case in.ReceivedAt.IsZero():
		verr = verr.WithField("receivedAt", "field.required", nil)
	case in.ReceivedAt.After(s.now().Add(receivedAtFutureTolerance)):
		verr = verr.WithField("receivedAt", "field.invalid", nil)
	}
	if note != nil && utf8.RuneCountInString(*note) > maxReviewTextLen {
		verr = verr.WithField("note", "field.too_long", map[string]any{"max": maxReviewTextLen})
	}
	if len(verr.Fields) > 0 {
		return verr
	}
	return nil
}

func validateReject(code string, reason *string) error {
	verr := apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)
	if !rejectCodes[code] {
		verr = verr.WithField("rejectCode", "field.invalid", nil)
	}
	switch {
	case code == "OTHER" && reason == nil:
		verr = verr.WithField("rejectReason", "field.required", nil)
	case reason != nil && utf8.RuneCountInString(*reason) > maxReviewTextLen:
		verr = verr.WithField("rejectReason", "field.too_long", map[string]any{"max": maxReviewTextLen})
	}
	if len(verr.Fields) > 0 {
		return verr
	}
	return nil
}

func reviewAudit(actor iam.Staff, action string, proof store.PaymentProof, order registration.Order, summary string, after map[string]any, meta httpx.Meta) audit.Entry {
	actorID := actor.ID
	role := string(actor.Role)
	eventID := order.EventID
	return audit.Entry{
		ActorType:   "STAFF",
		ActorID:     &actorID,
		ActorRole:   &role,
		Action:      action,
		EntityType:  "payment_proof",
		EntityID:    proof.ID,
		EventID:     &eventID,
		IsFinancial: true,
		Summary:     summary,
		Before: map[string]any{
			"proofStatus":         proof.Status,
			"orderStatus":         order.Status,
			"orderNo":             order.OrderNo,
			"bankTxnRef":          proof.BankTxnRef,
			"declaredAmountCents": proof.DeclaredAmountCents,
			"amountCents":         order.AmountCents,
		},
		After: after,
		Meta:  meta,
	}
}
```

- [ ] **Step 10: 运行服务层测试，确认通过**

Run: `cd api && go test ./internal/payment/ -run 'TestApprove|TestReject|TestReview|TestReupload|TestListProofs|TestGetProof' -v`
Expected: `TestApproveExactAmountConfirmsOrderAndConsumesCounters`、`TestApproveOverpaidRecordsOpenException`、`TestApproveUnderpaidChangesNothing`、`TestReviewAfterApprovalConflicts`、`TestApproveRejectsTxnRefAlreadyReceived`、`TestApproveValidatesInput`（4 个子测试）、`TestRejectOpensReuploadWindow`、`TestRejectValidatesCodeAndReason`（4 个子测试）、`TestReuploadAfterRejectionThenApprove`、`TestListProofsQueueOrderAndSLA`、`TestGetProofAndOpenProofFile` 全部 PASS。

Run: `cd api && go test ./internal/payment/... ./internal/registration/...`
Expected: `ok`（Task 15、16 的测试不受影响）。

- [ ] **Step 11: 写 HTTP 失败测试**

创建 `api/internal/httpapi/review_http_test.go`：

```go
package httpapi_test

import (
	"fmt"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/payment/paytest"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
)

func uploadForReview(t *testing.T, env paymentHTTPEnv, token string, order paytest.OrderRef, img []byte, txnRef string) apigen.Proof {
	t.Helper()
	body, contentType := proofForm(t, img, map[string]string{
		"bankTxnRef":          txnRef,
		"declaredAmountCents": strconv.FormatInt(order.AmountCents, 10),
	})
	rec := env.uploadProof(t, order.OrderNo, body, contentType, token)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	return paymentDecode[apigen.Proof](t, rec)
}

func TestFinanceReviewsProofsOverHTTP(t *testing.T) {
	env := newPaymentHTTPEnv(t)
	fx := paytest.SeedEvent(t, env.Pool)
	token, u := env.runnerToken(t, 7601, "Sokha")
	orderA := paytest.SeedOrder(t, env.Env, fx, u, paytest.OrderSpec{IdentOffset: 1})
	orderB := paytest.SeedOrder(t, env.Env, fx, u, paytest.OrderSpec{IdentOffset: 2})
	imgA := paytest.PNG(t, 101)
	proofA := uploadForReview(t, env, token, orderA, imgA, "ABA-HTTP-A01")
	proofB := uploadForReview(t, env, token, orderB, paytest.PNG(t, 102), "ABA-HTTP-B02")
	finance := env.staffCookie(t, iam.RoleFinance, "finance.review")

	rec := env.adminRequest(t, http.MethodGet, "/api/admin/proofs", nil, finance)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	queue := paymentDecode[apigen.ProofQueue](t, rec)
	require.Len(t, queue.Items, 2)
	require.Equal(t, proofA.Id, queue.Items[0].Proof.Id)
	require.Equal(t, proofB.Id, queue.Items[1].Proof.Id)
	require.Equal(t, orderA.AmountCents, queue.Items[0].AmountCents)
	require.False(t, queue.Items[0].OverSla)

	rec = env.adminRequest(t, http.MethodGet, fmt.Sprintf("/api/admin/proofs/%d", proofA.Id), nil, finance)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	detail := paymentDecode[apigen.ProofDetail](t, rec)
	require.Equal(t, orderA.OrderNo, detail.Order.OrderNo)
	require.Equal(t, apigen.AdminOrderDetailStatusPROOFSUBMITTED, detail.Order.Status)

	rec = env.adminRequest(t, http.MethodPost, fmt.Sprintf("/api/admin/proofs/%d/approve", proofA.Id), map[string]any{
		"receivedAmountCents": orderA.AmountCents,
		"receivedAt":          env.Clock.Now().Format(time.RFC3339),
	}, finance)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	approved := paymentDecode[apigen.ProofDetail](t, rec)
	require.Equal(t, apigen.ProofStatusAPPROVED, approved.Proof.Status)
	require.Equal(t, apigen.AdminOrderDetailStatusPAID, approved.Order.Status)
	require.Len(t, approved.Order.Receipts, 1)

	rec = env.adminRequest(t, http.MethodPost, fmt.Sprintf("/api/admin/proofs/%d/approve", proofA.Id), map[string]any{
		"receivedAmountCents": orderA.AmountCents,
		"receivedAt":          env.Clock.Now().Format(time.RFC3339),
	}, finance)
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	require.Equal(t, apperr.CodeOrderStateConflict, paymentDecode[httpx.ErrorBody](t, rec).Error.Code)

	rec = env.adminRequest(t, http.MethodPost, fmt.Sprintf("/api/admin/proofs/%d/reject", proofB.Id), map[string]any{
		"rejectCode": "OTHER",
	}, finance)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	require.Contains(t, paymentDecode[httpx.ErrorBody](t, rec).Error.Fields, "rejectReason")

	rec = env.adminRequest(t, http.MethodPost, fmt.Sprintf("/api/admin/proofs/%d/reject", proofB.Id), map[string]any{
		"rejectCode":   "UNREADABLE",
		"rejectReason": "截图模糊",
	}, finance)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	rejected := paymentDecode[apigen.ProofDetail](t, rec)
	require.Equal(t, apigen.ProofStatusREJECTED, rejected.Proof.Status)
	require.Equal(t, apigen.AdminOrderDetailStatusPROOFREJECTED, rejected.Order.Status)
	require.NotNil(t, rejected.Order.DeadlineAt)

	rec = env.adminRequest(t, http.MethodGet, fmt.Sprintf("/api/admin/files/%d", proofA.FileId), nil, finance)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, "image/png", rec.Header().Get("Content-Type"))
	require.Equal(t, "private, no-store", rec.Header().Get("Cache-Control"))
	require.Equal(t, imgA, rec.Body.Bytes())

	rec = env.adminRequest(t, http.MethodGet, fmt.Sprintf("/api/admin/files/%d", fx.QRFileID), nil, finance)
	require.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())
	require.Equal(t, apperr.CodeNotFound, paymentDecode[httpx.ErrorBody](t, rec).Error.Code)
}

func TestProofReviewPermissions(t *testing.T) {
	env := newPaymentHTTPEnv(t)
	fx := paytest.SeedEvent(t, env.Pool)
	token, u := env.runnerToken(t, 7602, "Sokha")
	order := paytest.SeedOrder(t, env.Env, fx, u, paytest.OrderSpec{})
	proof := uploadForReview(t, env, token, order, paytest.PNG(t, 103), "ABA-HTTP-C03")
	support := env.staffCookie(t, iam.RoleSupport, "support.review")
	photographer := env.staffCookie(t, iam.RolePhotographer, "photog.review")

	for _, path := range []string{
		"/api/admin/proofs",
		fmt.Sprintf("/api/admin/proofs/%d", proof.Id),
		fmt.Sprintf("/api/admin/files/%d", proof.FileId),
	} {
		rec := env.adminRequest(t, http.MethodGet, path, nil, support)
		require.Equal(t, http.StatusOK, rec.Code, "SUPPORT 读 %s: %s", path, rec.Body.String())
		rec = env.adminRequest(t, http.MethodGet, path, nil, photographer)
		require.Equal(t, http.StatusForbidden, rec.Code, "PHOTOGRAPHER 读 %s: %s", path, rec.Body.String())
	}

	rec := env.adminRequest(t, http.MethodPost, fmt.Sprintf("/api/admin/proofs/%d/approve", proof.Id), map[string]any{
		"receivedAmountCents": order.AmountCents,
		"receivedAt":          env.Clock.Now().Format(time.RFC3339),
	}, support)
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	require.Equal(t, apperr.CodeForbidden, paymentDecode[httpx.ErrorBody](t, rec).Error.Code)

	rec = env.adminRequest(t, http.MethodPost, fmt.Sprintf("/api/admin/proofs/%d/reject", proof.Id), map[string]any{
		"rejectCode": "UNREADABLE",
	}, support)
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())

	require.Equal(t, 1, paytest.Count(t, env.Pool, `SELECT count(*) FROM payment_proofs WHERE id = $1 AND status = 'SUBMITTED'`, proof.Id))
}
```

- [ ] **Step 12: 在 openapi.yaml 中新增审核接口并生成**

在 `components:` 这一行之前插入：

```yaml
  /admin/proofs:
    get:
      operationId: adminListProofs
      summary: 凭证审核队列（默认待审，按提交时间升序）
      x-permission: proof_review
      x-access: read
      parameters:
        - name: status
          in: query
          required: false
          schema:
            type: string
            enum: [SUBMITTED, APPROVED, REJECTED]
      responses:
        '200':
          description: 凭证列表
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ProofQueue'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
  /admin/proofs/{id}:
    get:
      operationId: adminGetProof
      summary: 凭证详情（含订单、参赛人、历史凭证）
      x-permission: proof_review
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
          description: 凭证详情
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ProofDetail'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
  /admin/proofs/{id}/approve:
    post:
      operationId: adminApproveProof
      summary: 审核通过（登记到账，多付登记异常，订单确认）
      x-permission: proof_review
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
              $ref: '#/components/schemas/ApproveProofRequest'
      responses:
        '200':
          description: 已通过
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ProofDetail'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
  /admin/proofs/{id}/reject:
    post:
      operationId: adminRejectProof
      summary: 驳回凭证（订单进入重传期）
      x-permission: proof_review
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
              $ref: '#/components/schemas/RejectProofRequest'
      responses:
        '200':
          description: 已驳回
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ProofDetail'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
  /admin/files/{id}:
    get:
      operationId: adminGetFile
      summary: 凭证截图原图（仅被凭证引用的私有文件；Cache-Control private, no-store）
      x-permission: proof_review
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
          description: 图片字节
          content:
            'image/*':
              schema:
                type: string
                format: binary
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
```

在文件末尾追加：

```yaml
    ProofQueueItem:
      type: object
      required: [proof, amountCents, eventName, waitingSince, overSla]
      properties:
        proof:
          $ref: '#/components/schemas/Proof'
        amountCents: { type: integer, format: int64 }
        eventName:
          $ref: '#/components/schemas/LocalizedText'
        waitingSince: { type: string, format: date-time }
        overSla: { type: boolean }
    ProofQueue:
      type: object
      required: [items]
      properties:
        items:
          type: array
          items:
            $ref: '#/components/schemas/ProofQueueItem'
    ProofDetail:
      type: object
      required: [proof, order]
      properties:
        proof:
          $ref: '#/components/schemas/Proof'
        order:
          $ref: '#/components/schemas/AdminOrderDetail'
    ApproveProofRequest:
      type: object
      required: [receivedAmountCents, receivedAt]
      properties:
        receivedAmountCents: { type: integer, format: int64, minimum: 1 }
        receivedAt: { type: string, format: date-time }
        note: { type: string, nullable: true, maxLength: 500 }
    RejectProofRequest:
      type: object
      required: [rejectCode]
      properties:
        rejectCode:
          type: string
          enum: [NOT_RECEIVED, AMOUNT_MISMATCH, DUPLICATE_TXN, UNREADABLE, WRONG_ACCOUNT, FRAUD, OTHER]
        rejectReason: { type: string, nullable: true, maxLength: 500 }
```

Run: `make gen && cd api && go build ./... ; grep -n "type AdminGetFile200ImageResponse struct" -A 4 internal/httpapi/apigen/api.gen.go`
Expected: `go build` 失败，报 `*Server does not implement apigen.StrictServerInterface (missing method AdminApproveProof)` 等；`AdminGetFile200ImageResponse` 含 `Body io.Reader`、`ContentType string`、`ContentLength int64`。

- [ ] **Step 13: 实现审核 handler**

创建 `api/internal/payment/review_handlers.go`：

```go
package payment

import (
	"context"
	"net/http"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/registration"
)

func (h *Handlers) AdminListProofs(ctx context.Context, req apigen.AdminListProofsRequestObject) (apigen.AdminListProofsResponseObject, error) {
	status := ""
	if req.Params.Status != nil {
		status = string(*req.Params.Status)
	}
	items, err := h.svc.ListProofs(ctx, status)
	if err != nil {
		return nil, err
	}
	out := make([]apigen.ProofQueueItem, 0, len(items))
	for _, it := range items {
		out = append(out, apigen.ProofQueueItem{
			Proof:        proofToAPI(it.Proof),
			AmountCents:  it.AmountCents,
			EventName:    proofTextToAPI(it.EventName),
			WaitingSince: it.WaitingSince,
			OverSla:      it.OverSLA,
		})
	}
	return apigen.AdminListProofs200JSONResponse{Items: out}, nil
}

func (h *Handlers) AdminGetProof(ctx context.Context, req apigen.AdminGetProofRequestObject) (apigen.AdminGetProofResponseObject, error) {
	d, err := h.svc.GetProof(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	return apigen.AdminGetProof200JSONResponse(proofDetailToAPI(d)), nil
}

func (h *Handlers) AdminApproveProof(ctx context.Context, req apigen.AdminApproveProofRequestObject) (apigen.AdminApproveProofResponseObject, error) {
	actor, ok := iam.StaffFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	d, err := h.svc.ApproveProof(ctx, actor, req.Id, ApproveInput{
		ReceivedAmountCents: req.Body.ReceivedAmountCents,
		ReceivedAt:          req.Body.ReceivedAt,
		Note:                req.Body.Note,
	}, httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AdminApproveProof200JSONResponse(proofDetailToAPI(d)), nil
}

func (h *Handlers) AdminRejectProof(ctx context.Context, req apigen.AdminRejectProofRequestObject) (apigen.AdminRejectProofResponseObject, error) {
	actor, ok := iam.StaffFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	d, err := h.svc.RejectProof(ctx, actor, req.Id, RejectInput{
		Code:   string(req.Body.RejectCode),
		Reason: req.Body.RejectReason,
	}, httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AdminRejectProof200JSONResponse(proofDetailToAPI(d)), nil
}

func (h *Handlers) AdminGetFile(ctx context.Context, req apigen.AdminGetFileRequestObject) (apigen.AdminGetFileResponseObject, error) {
	file, body, err := h.svc.OpenProofFile(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	if c, ok := httpx.Gin(ctx); ok {
		c.Header("Cache-Control", "private, no-store")
	}
	// strict 响应写完后会关闭实现了 io.ReadCloser 的 Body。
	return apigen.AdminGetFile200ImageResponse{Body: body, ContentType: file.MIME, ContentLength: file.SizeBytes}, nil
}

func proofDetailToAPI(d ProofDetail) apigen.ProofDetail {
	return apigen.ProofDetail{Proof: proofToAPI(d.Proof), Order: registration.AdminOrderDetailToAPI(d.Order)}
}

func proofTextToAPI(t i18n.Text) apigen.LocalizedText {
	pick := func(l i18n.Lang) *string {
		v, ok := t[l]
		if !ok {
			return nil
		}
		return &v
	}
	return apigen.LocalizedText{Zh: pick(i18n.ZH), En: pick(i18n.EN), Km: pick(i18n.KM)}
}
```

- [ ] **Step 14: 运行 HTTP 测试，确认通过**

Run: `cd api && go test ./internal/httpapi/ -run 'TestFinanceReviewsProofsOverHTTP|TestProofReviewPermissions' -v`
Expected: 两个测试 PASS。

- [ ] **Step 15: 全量检查**

Run: `make gen && git diff --exit-code -- api/internal/httpapi/apigen api/internal/registration/store api/internal/payment/store packages/api-client/src/schema.d.ts`
Expected: 退出码 0。

Run: `cd api && go test ./... && go tool golangci-lint run ./...`
Expected: 全部 `ok`；`0 issues.`。

Run: `cd api && go test ./internal/payment/ -run TestSubmitProofSameTxnRefConcurrentlyOnlyOneSucceeds -count=5`
Expected: `ok`。

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过。

- [ ] **Step 16: 提交**

```bash
git add api/internal/platform/apperr/apperr.go api/internal/platform/apperr/apperr_test.go \
  api/internal/platform/i18n/messages.zh.json api/internal/platform/i18n/messages.en.json api/internal/platform/i18n/messages.km.json \
  api/db/queries/registration.sql api/db/queries/payment.sql \
  api/internal/registration api/internal/payment/store \
  api/internal/payment/review.go api/internal/payment/review_test.go api/internal/payment/review_handlers.go \
  api/openapi/openapi.yaml api/internal/httpapi/apigen api/internal/httpapi/review_http_test.go \
  packages/api-client/src/schema.d.ts
git commit -m "$(cat <<'EOF'
feat(api): add proof review queue, approve with receipts and reject with reupload window

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
)"
```

`api/internal/registration` 整目录加入，是为了带上 Step 1 可能修改的 `ConfirmPaid` 查询所在文件与重新生成的 store。

---
### Task 18: 用户端付款与上传

**Files:**
- Modify: `web/user/package.json`（新增 `qrcode`、`@types/qrcode`）
- Modify: `pnpm-lock.yaml`
- Create: `web/user/src/pay/proofForm.ts`
- Create: `web/user/src/pay/proofForm.test.ts`
- Create: `web/user/src/pay/useCountdown.ts`
- Create: `web/user/src/pay/useCountdown.test.ts`
- Create: `web/user/src/pay/queries.ts`
- Create: `web/user/src/components/TicketQr.tsx`
- Create: `web/user/src/orders/OrderStatePanel.tsx`
- Create: `web/user/src/pages/Pay.module.css`
- Create: `web/user/src/pages/PayPage.tsx`
- Create: `web/user/src/pages/ProofUploadPage.tsx`
- Modify: `web/user/src/pages/OrderDetailPage.tsx`（Task 14 的页面，改 4 处）
- Modify: `web/user/src/routes.tsx`（新增 2 条路由）
- Modify: `packages/i18n/locales/zh/user.json`、`packages/i18n/locales/en/user.json`、`packages/i18n/locales/km/user.json`
- Create: `web/user/src/pages/PayPage.test.tsx`
- Create: `web/user/src/pages/ProofUploadPage.test.tsx`
- Create: `web/user/src/pages/OrderDetailPage.states.test.tsx`

**Interfaces:**
- Consumes:
  - `formatUsd(cents: number): string`、`parseUsdToCents(input: string): number | null`、`unwrap`、`ApiError`、`Schemas["OrderDetail"]`（`@werun/api-client`）
  - Task 14：`useMyOrder(orderNo)`（查询键 `["orders", orderNo]`）、`useCancelOrder(orderNo)`（`web/user/src/orders/api.ts`）；`pickText(text, lang)`、`formatDateTime(iso, lang)`（`web/user/src/format.ts`）；`OrderDetailPage`（`order-status`、`order-deadline`、`order-pay`、二次确认取消 `order-cancel` / `order-cancel-confirm` / `order-cancel-keep`、`form-error`）；测试辅助 `signInRunner()`、`routeHandler(routes)`（`web/user/src/test/runner.ts`）与 `orderDetail(overrides)`（`web/user/src/test/orderFixtures.ts`：订单号 `WR7K2M9QXA`、应付 3999、识别分 1、截止 `2026-09-14T03:30:00Z`、参赛人 Chan Sophea 与 Lim Dara、收款户名 `WERUN CO LTD`、尾号 `*** *** 123`、二维码文件 9、赛事 `phnom-penh-half-2026`）
  - Task 10：`RequireRunner` 布局路由、`renderApp(path, handler)`、`jsonResponse`
  - `useApi()`、`useLang()`、`QueryState`、`NotFoundPage`、`Page.module.css`
  - 接口 `appSubmitProof`（Task 15，`multipart/form-data`，成功 201）
- Produces:
  - 路由 `/orders/:orderNo/pay` → `PayPage`、`/orders/:orderNo/proof` → `ProofUploadPage`（均在 `RequireRunner` 布局路由内）
  - testid：付款页 `pay-qr`、`pay-amount`、`pay-order-no`、`pay-countdown`、`pay-upload-link`（另有 `pay-copy-order-no`、`pay-expired`）；上传页 `proof-file-input`、`proof-txn-ref`、`proof-amount`、`proof-paid-at`、`proof-submit`（另有 `form-error`、`proof-reregister`）；订单详情 `order-reject-reason`、`order-reupload`、`order-ticket-qr`（另有 `order-countdown`、`order-reviewing`、`order-register-again`）
  - 文案 `user.pay.*`、`user.proof.*`、`user.orders.panel.*`、`user.orders.rejectCode.*`
  - `useSubmitProof(orderNo)`（`web/user/src/pay/queries.ts`）、`TicketQr`、`OrderStatePanel`、`useCountdown` / `formatCountdown`、`validateProofForm` / `toProofFormData`

**要点**

- 付款页、上传页复用 Task 14 的 `useMyOrder`，与订单详情共用查询缓存；上传成功后使 `["orders"]` 前缀的查询失效，再跳到订单详情。
- 表单用 `FormData`，通过 openapi-fetch 的 `bodySerializer` 发出：openapi-fetch 0.17 对 `FormData` 不设置 `Content-Type`，浏览器自动带 boundary（`node_modules/openapi-fetch/dist/index.mjs` 中 `serializedBody instanceof FormData` 分支）。openapi-typescript 7 把 `format: binary` 生成为 `string`，所以 `body` 只用于类型检查（`file` 传文件名），真正的请求体是 `bodySerializer` 返回的 `FormData`。
- 倒计时以 `deadlineAt` 与 `Date.now()` 计算，每秒刷新；到 0 时付款页切换为过期提示并隐藏上传入口。组件测试只伪造 `setInterval`、`clearInterval`、`Date`，Testing Library 的 `findBy*` 仍依靠真实 `setTimeout` 与 MutationObserver 工作。
- Vitest 4 的 jsdom 环境会把 jsdom 的 `FormData` / `File` 转换为 Node 版本再构造 `Request`，测试可直接 `await request.clone().formData()` 读取提交内容。
- 订单详情只做增量修改：Task 14 已有的状态、金额、去付款、二次确认取消保持不变；新增待付款 / 被驳回的倒计时，以及 `OrderStatePanel` 渲染审核中、驳回原因与重传、已确认参赛凭证二维码、已过期、已取消。Task 14 的 `OrderDetailPage.test.tsx` 必须继续通过。
- 参赛凭证二维码用 `qrcode.toDataURL(ticketCode)` 在本地生成；测试里 `vi.mock("qrcode")` 固定输出。

- [ ] **Step 1: 查询并锁定 `qrcode` 版本**

Run: `npm view qrcode version && npm view @types/qrcode version`
Expected: 输出两个版本号（编写本计划时为 `1.5.4` 与 `1.5.6`）。下面命令中的版本号替换为实际输出。

Run: `pnpm --filter @werun/user add qrcode@1.5.4 --save-exact && pnpm --filter @werun/user add -D @types/qrcode@1.5.6 --save-exact`
Expected: `web/user/package.json` 的 `dependencies` 出现 `"qrcode": "1.5.4"`，`devDependencies` 出现 `"@types/qrcode": "1.5.6"`（无 `^`）；`pnpm-lock.yaml` 更新。

- [ ] **Step 2: 写表单校验与倒计时的失败单元测试**

创建 `web/user/src/pay/proofForm.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { MAX_PROOF_BYTES, centsToInput, normalizeTxnRef, toProofFormData, validateProofForm } from "./proofForm";

function imageFile(type = "image/png", size = 128, name = "receipt.png"): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe("normalizeTxnRef", () => {
  it("去掉所有空白并转大写", () => {
    expect(normalizeTxnRef(" aba 7788\t99\n")).toBe("ABA778899");
    expect(normalizeTxnRef("　ab-12")).toBe("AB-12");
  });
});

describe("centsToInput", () => {
  it("按整数分拼出两位小数", () => {
    expect(centsToInput(3999)).toBe("39.99");
    expect(centsToInput(5)).toBe("0.05");
    expect(centsToInput(100000)).toBe("1000.00");
  });
});

describe("validateProofForm", () => {
  it("合法输入：交易号规范化、金额转分、付款时间转 ISO", () => {
    const file = imageFile();
    const result = validateProofForm({ file, txnRef: "aba 7788 99", amount: "39.99", paidAt: "2026-09-14T10:30" });
    expect(result).toEqual({
      ok: true,
      value: {
        file,
        bankTxnRef: "ABA778899",
        declaredAmountCents: 3999,
        declaredPaidAt: new Date("2026-09-14T10:30").toISOString(),
      },
    });
  });

  it("付款时间留空时为 null", () => {
    const result = validateProofForm({ file: imageFile("image/webp"), txnRef: "ABCD", amount: "10", paidAt: "" });
    expect(result.ok && result.value.declaredPaidAt).toBeNull();
  });

  it("逐项返回文案 key", () => {
    expect(validateProofForm({ file: null, txnRef: "ab 1", amount: "0", paidAt: "not-a-date" })).toEqual({
      ok: false,
      errors: {
        file: "proof.error.fileRequired",
        txnRef: "proof.error.txnRefLength",
        amount: "proof.error.amountInvalid",
        paidAt: "proof.error.paidAtInvalid",
      },
    });
  });

  it("文件类型与大小", () => {
    const gif = validateProofForm({ file: imageFile("image/gif"), txnRef: "ABCD", amount: "1", paidAt: "" });
    expect(gif.ok ? null : gif.errors.file).toBe("proof.error.fileType");

    const big = validateProofForm({ file: imageFile("image/jpeg", MAX_PROOF_BYTES + 1), txnRef: "ABCD", amount: "1", paidAt: "" });
    expect(big.ok ? null : big.errors.file).toBe("proof.error.fileTooLarge");

    const limit = validateProofForm({ file: imageFile("image/jpeg", MAX_PROOF_BYTES), txnRef: "ABCD", amount: "1", paidAt: "" });
    expect(limit.ok).toBe(true);
  });

  it("交易号超过 64 位、金额超过两位小数都不通过", () => {
    const result = validateProofForm({ file: imageFile(), txnRef: "A".repeat(65), amount: "1.234", paidAt: "" });
    expect(result.ok ? null : result.errors).toEqual({
      txnRef: "proof.error.txnRefLength",
      amount: "proof.error.amountInvalid",
    });
  });
});

describe("toProofFormData", () => {
  it("文本字段在前，文件最后；没有付款时间时不带该字段", () => {
    const file = imageFile();
    const form = toProofFormData({ file, bankTxnRef: "ABA778899", declaredAmountCents: 3999, declaredPaidAt: null });
    expect([...form.keys()]).toEqual(["bankTxnRef", "declaredAmountCents", "file"]);
    expect(form.get("declaredAmountCents")).toBe("3999");
    expect((form.get("file") as File).name).toBe("receipt.png");
  });
});
```

创建 `web/user/src/pay/useCountdown.test.ts`：

```ts
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatCountdown, useCountdown } from "./useCountdown";

describe("formatCountdown", () => {
  it("不足一小时显示 mm:ss，超过一小时显示 h:mm:ss", () => {
    expect(formatCountdown(0)).toBe("00:00");
    expect(formatCountdown(5)).toBe("00:05");
    expect(formatCountdown(1800)).toBe("30:00");
    expect(formatCountdown(3599)).toBe("59:59");
    expect(formatCountdown(3661)).toBe("1:01:01");
    expect(formatCountdown(86400)).toBe("24:00:00");
  });
});

describe("useCountdown", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-09-14T03:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("每秒递减，到期后停在 0", () => {
    const { result } = renderHook(() => useCountdown("2026-09-14T03:00:02Z"));
    expect(result.current).toBe(2);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(1);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).toBe(0);
  });

  it("没有截止时间时返回 null", () => {
    const { result } = renderHook(() => useCountdown(null));
    expect(result.current).toBeNull();
  });
});
```

- [ ] **Step 3: 运行单元测试，确认失败**

Run: `pnpm --filter @werun/user test -- src/pay`
Expected: FAIL，报 `Failed to resolve import "./proofForm"`、`Failed to resolve import "./useCountdown"`。

- [ ] **Step 4: 实现表单校验与倒计时**

创建 `web/user/src/pay/proofForm.ts`：

```ts
import { parseUsdToCents } from "@werun/api-client";

export const MAX_PROOF_BYTES = 5 * 1024 * 1024;
export const PROOF_ACCEPT = "image/jpeg,image/png,image/webp";

const PROOF_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MIN_TXN_REF = 4;
const MAX_TXN_REF = 64;

export interface ProofFormInput {
  file: File | null;
  txnRef: string;
  amount: string;
  /** datetime-local 的原值，如 "2026-09-14T10:30"；空串表示不填 */
  paidAt: string;
}

export interface ProofSubmission {
  file: File;
  bankTxnRef: string;
  declaredAmountCents: number;
  declaredPaidAt: string | null;
}

export type ProofField = "file" | "txnRef" | "amount" | "paidAt";

/** 值为 user 命名空间下的文案 key */
export type ProofFormErrors = Partial<Record<ProofField, string>>;

export type ProofValidation = { ok: true; value: ProofSubmission } | { ok: false; errors: ProofFormErrors };

/** 与服务端一致：去掉所有空白后转大写 */
export function normalizeTxnRef(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

/** 3999 → "39.99"；只用整数运算 */
export function centsToInput(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const rest = Math.abs(cents % 100);
  return `${whole}.${String(rest).padStart(2, "0")}`;
}

export function validateProofForm(input: ProofFormInput): ProofValidation {
  const errors: ProofFormErrors = {};

  if (!input.file) {
    errors.file = "proof.error.fileRequired";
  } else if (!PROOF_MIME_TYPES.has(input.file.type)) {
    errors.file = "proof.error.fileType";
  } else if (input.file.size > MAX_PROOF_BYTES) {
    errors.file = "proof.error.fileTooLarge";
  }

  const bankTxnRef = normalizeTxnRef(input.txnRef);
  const refLength = [...bankTxnRef].length;
  if (refLength < MIN_TXN_REF || refLength > MAX_TXN_REF) {
    errors.txnRef = "proof.error.txnRefLength";
  }

  const cents = parseUsdToCents(input.amount.trim());
  if (cents === null || cents <= 0) {
    errors.amount = "proof.error.amountInvalid";
  }

  let declaredPaidAt: string | null = null;
  if (input.paidAt.trim() !== "") {
    const date = new Date(input.paidAt);
    if (Number.isNaN(date.getTime())) {
      errors.paidAt = "proof.error.paidAtInvalid";
    } else {
      declaredPaidAt = date.toISOString();
    }
  }

  if (Object.keys(errors).length > 0 || !input.file || cents === null) {
    return { ok: false, errors };
  }
  return { ok: true, value: { file: input.file, bankTxnRef, declaredAmountCents: cents, declaredPaidAt } };
}

/** 文本字段在前、文件最后，服务端按顺序流式读取 */
export function toProofFormData(submission: ProofSubmission): FormData {
  const form = new FormData();
  form.append("bankTxnRef", submission.bankTxnRef);
  form.append("declaredAmountCents", String(submission.declaredAmountCents));
  if (submission.declaredPaidAt) {
    form.append("declaredPaidAt", submission.declaredPaidAt);
  }
  form.append("file", submission.file, submission.file.name);
  return form;
}
```

创建 `web/user/src/pay/useCountdown.ts`：

```ts
import { useEffect, useState } from "react";

/** 距 deadlineAt 的剩余秒数（不小于 0），每秒刷新；deadlineAt 为空或无法解析时返回 null */
export function useCountdown(deadlineAt: string | null | undefined): number | null {
  const parsed = deadlineAt ? Date.parse(deadlineAt) : Number.NaN;
  const deadline = Number.isNaN(parsed) ? null : parsed;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (deadline === null) {
      return undefined;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);

  if (deadline === null) {
    return null;
  }
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

export function formatCountdown(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}
```

- [ ] **Step 5: 运行单元测试，确认通过**

Run: `pnpm --filter @werun/user test -- src/pay`
Expected: `proofForm.test.ts`（8 个用例）与 `useCountdown.test.ts`（3 个用例）全部通过。

- [ ] **Step 6: 写页面的失败测试**

创建 `web/user/src/pages/PayPage.test.tsx`：

```tsx
import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "../test/fixtures";
import { orderDetail } from "../test/orderFixtures";
import { renderApp } from "../test/renderApp";
import { routeHandler, signInRunner } from "../test/runner";

const ORDER_NO = "WR7K2M9QXA";
const ORDER_KEY = `GET /api/app/orders/${ORDER_NO}`;
const PATH = `/orders/${ORDER_NO}/pay`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-09-14T03:00:00Z"));
  window.localStorage.setItem("werun.lang", "en");
  signInRunner();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PayPage", () => {
  it("显示收款码、户名、应付金额与识别分说明、订单号和上传入口", async () => {
    renderApp(PATH, routeHandler({ [ORDER_KEY]: () => jsonResponse(200, orderDetail()) }));

    expect(await screen.findByTestId("pay-qr")).toHaveAttribute("src", "/api/files/9");
    expect(screen.getByTestId("pay-amount")).toHaveTextContent("$39.99");
    expect(
      screen.getByText("Please transfer exactly this amount. The odd cents (1¢ off) help us identify your order."),
    ).toBeInTheDocument();
    expect(screen.getByText("WERUN CO LTD")).toBeInTheDocument();
    expect(screen.getByText("*** *** 123")).toBeInTheDocument();
    expect(screen.getByText("Phnom Penh Half Marathon 2026")).toBeInTheDocument();
    expect(screen.getByTestId("pay-order-no")).toHaveTextContent(ORDER_NO);
    expect(screen.getByTestId("pay-countdown")).toHaveTextContent("30:00");
    expect(screen.getByTestId("pay-upload-link")).toHaveAttribute("href", `/orders/${ORDER_NO}/proof`);
  });

  it("没有识别分时显示普通金额说明", async () => {
    renderApp(
      PATH,
      routeHandler({ [ORDER_KEY]: () => jsonResponse(200, orderDetail({ identOffsetCents: 0, discountCents: 1000, amountCents: 4000 })) }),
    );

    expect(await screen.findByTestId("pay-amount")).toHaveTextContent("$40.00");
    expect(screen.getByText("Please transfer exactly this amount.")).toBeInTheDocument();
  });

  it("倒计时每秒刷新，归零后显示过期并隐藏上传入口", async () => {
    renderApp(PATH, routeHandler({ [ORDER_KEY]: () => jsonResponse(200, orderDetail({ deadlineAt: "2026-09-14T03:00:05Z" })) }));

    expect(await screen.findByTestId("pay-countdown")).toHaveTextContent("00:05");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId("pay-countdown")).toHaveTextContent("00:04");
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.getByTestId("pay-expired")).toHaveTextContent("The payment window has closed");
    expect(screen.queryByTestId("pay-countdown")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pay-upload-link")).not.toBeInTheDocument();
  });

  it("凭证审核中的订单跳回订单详情", async () => {
    const { router } = renderApp(
      PATH,
      routeHandler({ [ORDER_KEY]: () => jsonResponse(200, orderDetail({ status: "PROOF_SUBMITTED", deadlineAt: null })) }),
    );

    expect(await screen.findByTestId("order-status")).toHaveAttribute("data-status", "PROOF_SUBMITTED");
    expect(router.state.location.pathname).toBe(`/orders/${ORDER_NO}`);
  });
});
```

创建 `web/user/src/pages/ProofUploadPage.test.tsx`：

```tsx
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { jsonResponse } from "../test/fixtures";
import { orderDetail } from "../test/orderFixtures";
import { renderApp } from "../test/renderApp";
import { routeHandler, signInRunner } from "../test/runner";

const ORDER_NO = "WR7K2M9QXA";
const ORDER_KEY = `GET /api/app/orders/${ORDER_NO}`;
const SUBMIT_KEY = `POST /api/app/orders/${ORDER_NO}/proofs`;
const PATH = `/orders/${ORDER_NO}/proof`;

function receipt(name = "receipt.png", type = "image/png", size = 64): File {
  return new File([new Uint8Array(size)], name, { type });
}

function isSubmit(request: Request): boolean {
  return request.method === "POST" && new URL(request.url).pathname === `/api/app/orders/${ORDER_NO}/proofs`;
}

beforeEach(() => {
  window.localStorage.setItem("werun.lang", "en");
  signInRunner();
});

describe("ProofUploadPage", () => {
  it("金额默认带出应付；以 multipart 提交后进入订单详情", async () => {
    let submitted = false;
    const user = userEvent.setup();
    const { requests, router } = renderApp(
      PATH,
      routeHandler({
        [ORDER_KEY]: () =>
          jsonResponse(200, submitted ? orderDetail({ status: "PROOF_SUBMITTED", deadlineAt: null }) : orderDetail()),
        [SUBMIT_KEY]: () => {
          submitted = true;
          return jsonResponse(201, { id: 301, proofNo: "PF8H2K4M6N", status: "SUBMITTED" });
        },
      }),
    );

    const fileInput = await screen.findByTestId("proof-file-input");
    expect(fileInput).toHaveAttribute("accept", "image/jpeg,image/png,image/webp");
    expect(screen.getByTestId("proof-amount")).toHaveValue("39.99");
    expect(screen.getByTestId("proof-paid-at")).toHaveAttribute("type", "datetime-local");

    await user.upload(fileInput, receipt());
    await user.type(screen.getByTestId("proof-txn-ref"), "aba 7788 99");
    await user.click(screen.getByTestId("proof-submit"));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/orders/${ORDER_NO}`));
    const post = requests.find(isSubmit);
    expect(post).toBeDefined();
    expect(post!.headers.get("Content-Type")).toMatch(/^multipart\/form-data; boundary=/);
    const form = await post!.clone().formData();
    expect(form.get("bankTxnRef")).toBe("ABA778899");
    expect(form.get("declaredAmountCents")).toBe("3999");
    expect(form.get("declaredPaidAt")).toBeNull();
    const sent = form.get("file");
    expect(typeof sent).not.toBe("string");
    expect((sent as File).name).toBe("receipt.png");
    expect(await screen.findByTestId("order-reviewing")).toBeInTheDocument();
    expect(screen.getByTestId("order-status")).toHaveAttribute("data-status", "PROOF_SUBMITTED");
  });

  it("文件超过 5 MB 时提示且不发请求", async () => {
    const user = userEvent.setup();
    const { requests } = renderApp(PATH, routeHandler({ [ORDER_KEY]: () => jsonResponse(200, orderDetail()) }));

    await user.upload(await screen.findByTestId("proof-file-input"), receipt("big.png", "image/png", 5 * 1024 * 1024 + 1));
    await user.type(screen.getByTestId("proof-txn-ref"), "ABA778899");
    await user.click(screen.getByTestId("proof-submit"));

    expect(await screen.findByText("The image must be 5 MB or smaller")).toBeInTheDocument();
    expect(requests.some(isSubmit)).toBe(false);
  });

  it("文件类型、交易号、金额不合规时逐项提示", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { requests } = renderApp(PATH, routeHandler({ [ORDER_KEY]: () => jsonResponse(200, orderDetail()) }));

    await user.upload(await screen.findByTestId("proof-file-input"), receipt("receipt.gif", "image/gif"));
    await user.type(screen.getByTestId("proof-txn-ref"), "ab 1");
    await user.clear(screen.getByTestId("proof-amount"));
    await user.type(screen.getByTestId("proof-amount"), "0");
    await user.click(screen.getByTestId("proof-submit"));

    expect(await screen.findByText("Only JPG, PNG or WebP images are accepted")).toBeInTheDocument();
    expect(screen.getByText("The transaction reference must be 4–64 characters, not counting spaces")).toBeInTheDocument();
    expect(screen.getByText("Enter an amount above 0 with at most two decimals")).toBeInTheDocument();
    expect(requests.some(isSubmit)).toBe(false);
  });

  it("交易号已被使用：显示错误码文案与字段错误，停留在上传页", async () => {
    const user = userEvent.setup();
    const { router } = renderApp(
      PATH,
      routeHandler({
        [ORDER_KEY]: () => jsonResponse(200, orderDetail()),
        [SUBMIT_KEY]: () =>
          jsonResponse(409, {
            error: { code: "PROOF_TXN_REF_USED", message: "server text", fields: { bankTxnRef: "Already used by another proof" } },
          }),
      }),
    );

    await user.upload(await screen.findByTestId("proof-file-input"), receipt());
    await user.type(screen.getByTestId("proof-txn-ref"), "ABA778899");
    await user.click(screen.getByTestId("proof-submit"));

    expect(await screen.findByTestId("form-error")).toHaveTextContent(
      "This transaction reference has already been submitted. Check it and try again.",
    );
    expect(screen.getByText("Already used by another proof")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(PATH);
  });

  it("订单已过期：提示过期并给出重新报名入口", async () => {
    const user = userEvent.setup();
    renderApp(
      PATH,
      routeHandler({
        [ORDER_KEY]: () => jsonResponse(200, orderDetail()),
        [SUBMIT_KEY]: () => jsonResponse(409, { error: { code: "ORDER_EXPIRED", message: "server text" } }),
      }),
    );

    await user.upload(await screen.findByTestId("proof-file-input"), receipt());
    await user.type(screen.getByTestId("proof-txn-ref"), "ABA778899");
    await user.click(screen.getByTestId("proof-submit"));

    expect(await screen.findByTestId("form-error")).toHaveTextContent("This order has expired. Please register again.");
    expect(screen.getByTestId("proof-reregister")).toHaveAttribute("href", "/events/phnom-penh-half-2026/register");
  });
});
```

创建 `web/user/src/pages/OrderDetailPage.states.test.tsx`：

```tsx
import type { Schemas } from "@werun/api-client";
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "../test/fixtures";
import { orderDetail } from "../test/orderFixtures";
import { renderApp } from "../test/renderApp";
import { routeHandler, signInRunner } from "../test/runner";

vi.mock("qrcode", () => ({
  toDataURL: vi.fn(async (text: string) => `data:image/png;base64,${btoa(text)}`),
}));

const ORDER_NO = "WR7K2M9QXA";
const TICKETS = ["7K3M9Q2A4D6F8H1J3K5M7N9P2Q4R6S8T", "2Q4R6S8T7K3M9Q2A4D6F8H1J3K5M7N9P"];

function renderOrder(order: Schemas["OrderDetail"]) {
  return renderApp(`/orders/${ORDER_NO}`, routeHandler({ [`GET /api/app/orders/${ORDER_NO}`]: () => jsonResponse(200, order) }));
}

beforeEach(() => {
  window.localStorage.setItem("werun.lang", "en");
  signInRunner();
});

describe("OrderDetailPage 各状态面板", () => {
  it("待付款：显示倒计时，不显示其他状态面板", async () => {
    renderOrder(orderDetail());

    expect(await screen.findByTestId("order-countdown")).toBeInTheDocument();
    expect(screen.queryByTestId("order-reviewing")).not.toBeInTheDocument();
    expect(screen.queryByTestId("order-reject-reason")).not.toBeInTheDocument();
    expect(screen.queryByTestId("order-ticket-qr")).not.toBeInTheDocument();
  });

  it("审核中：显示审核提示，没有付款、重传入口和倒计时", async () => {
    renderOrder(orderDetail({ status: "PROOF_SUBMITTED", deadlineAt: null }));

    expect(await screen.findByTestId("order-reviewing")).toHaveTextContent("Finance usually reviews it within 24 hours");
    expect(screen.queryByTestId("order-pay")).not.toBeInTheDocument();
    expect(screen.queryByTestId("order-reupload")).not.toBeInTheDocument();
    expect(screen.queryByTestId("order-countdown")).not.toBeInTheDocument();
  });

  it("被驳回：显示原因码文案、说明与重传截止时间，重新上传指向上传页", async () => {
    renderOrder(
      orderDetail({
        status: "PROOF_REJECTED",
        deadlineAt: "2026-09-15T03:00:00Z",
        lastRejection: { code: "UNREADABLE", reason: "Amount is cut off", reviewedAt: "2026-09-14T03:00:00Z" },
      }),
    );

    const reason = await screen.findByTestId("order-reject-reason");
    expect(reason).toHaveTextContent("Screenshot unreadable");
    expect(reason).toHaveTextContent("Reason: Amount is cut off");
    expect(reason).toHaveTextContent("Upload a new proof by");
    expect(screen.getByTestId("order-reupload")).toHaveAttribute("href", `/orders/${ORDER_NO}/proof`);
    expect(screen.getByTestId("order-pay")).toBeInTheDocument();
  });

  it("已确认：每位参赛人一张参赛凭证二维码", async () => {
    const participants = orderDetail().participants.map((participant, i) => ({
      ...participant,
      registrationStatus: "CONFIRMED" as const,
      ticketCode: TICKETS[i],
    }));
    renderOrder(orderDetail({ status: "PAID", deadlineAt: null, paidAt: "2026-09-14T04:00:00Z", participants }));

    const qrs = await screen.findAllByTestId("order-ticket-qr");
    expect(qrs).toHaveLength(2);
    expect(qrs[0]).toHaveAttribute("src", `data:image/png;base64,${btoa(TICKETS[0]!)}`);
    expect(qrs[1]).toHaveAttribute("alt", "Race ticket for Lim Dara");
    expect(screen.getByText("Your registration is confirmed. Show the ticket below on race day.")).toBeInTheDocument();
  });

  it("已过期：显示过期说明与重新报名入口", async () => {
    renderOrder(orderDetail({ status: "EXPIRED", deadlineAt: null }));

    expect(await screen.findByText("This order has expired and the spots were released.")).toBeInTheDocument();
    expect(screen.getByTestId("order-register-again")).toHaveAttribute("href", "/events/phnom-penh-half-2026/register");
    expect(screen.queryByTestId("order-ticket-qr")).not.toBeInTheDocument();
  });

  it("已取消：只显示取消说明", async () => {
    renderOrder(orderDetail({ status: "CANCELLED", deadlineAt: null }));

    expect(await screen.findByText("This order was cancelled.")).toBeInTheDocument();
    expect(screen.queryByTestId("order-pay")).not.toBeInTheDocument();
    expect(screen.queryByTestId("order-cancel")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 7: 运行页面测试，确认失败**

Run: `pnpm --filter @werun/user test -- src/pages/PayPage.test.tsx src/pages/ProofUploadPage.test.tsx src/pages/OrderDetailPage.states.test.tsx`
Expected: FAIL。路由表还没有 `/orders/:orderNo/pay`、`/orders/:orderNo/proof`，两页测试渲染 404 页面，报 `Unable to find an element by: [data-testid="pay-qr"]`、`[data-testid="proof-file-input"]`；状态测试报找不到 `order-countdown`、`order-reviewing`、`order-reject-reason`、`order-ticket-qr` 等。

- [ ] **Step 8: 补三语文案**

`packages/i18n/locales/zh/user.json`：顶层追加 `pay`、`proof` 两个对象；在 Task 14 已有的 `orders` 对象内追加 `panel`、`rejectCode` 两个对象（`orders` 原有 key 保持不变）：

```json
{
  "pay": {
    "title": "付款",
    "scanQr": "打开银行 App 扫描上方二维码转账",
    "qrAlt": "收款二维码",
    "accountName": "收款户名",
    "accountNo": "收款账号",
    "amount": "应付金额",
    "amountHint": "请按此金额准确转账。",
    "amountHintIdent": "请按此金额准确转账，尾数（已优惠 {{cents}} 美分）用于识别你的订单。",
    "orderNo": "转账备注填写订单号",
    "copy": "复制",
    "copied": "已复制",
    "countdown": "剩余付款时间",
    "expired": "付款时间已到，订单即将失效。如果已经付款，请尽快联系客服。",
    "upload": "我已付款，上传凭证",
    "backToOrder": "查看订单"
  },
  "proof": {
    "title": "上传付款凭证",
    "intro": "上传转账成功页面的截图，并填写交易号。",
    "file": "付款截图",
    "fileHelp": "JPG、PNG 或 WebP，不超过 5 MB",
    "txnRef": "交易号",
    "txnRefHelp": "银行回执上的交易号（Transaction ID / Reference）",
    "amount": "付款金额（美元）",
    "paidAt": "付款时间（可不填）",
    "submit": "提交凭证",
    "submitting": "提交中…",
    "reregister": "重新报名",
    "error": {
      "fileRequired": "请选择付款截图",
      "fileType": "只支持 JPG、PNG、WebP 图片",
      "fileTooLarge": "图片不能超过 5 MB",
      "txnRefLength": "交易号需为 4–64 个字符（不含空格）",
      "amountInvalid": "请输入大于 0 的金额，最多两位小数",
      "paidAtInvalid": "付款时间格式不正确"
    },
    "serverError": {
      "ORDER_EXPIRED": "订单已过期，请重新报名。",
      "PROOF_TXN_REF_USED": "这个交易号已经提交过，请核对后重新填写。",
      "FILE_TOO_LARGE": "图片超过 5 MB，请压缩后重试。",
      "FILE_TYPE_NOT_ALLOWED": "无法识别这张图片，请上传 JPG、PNG 或 WebP 截图。",
      "ORDER_STATE_CONFLICT": "这个订单现在不能上传凭证，请刷新后查看订单状态。"
    }
  },
  "orders": {
    "panel": {
      "reviewing": "凭证已提交，财务通常在 24 小时内完成审核，结果会通过 Telegram 通知你。",
      "rejectedTitle": "凭证未通过审核",
      "rejectReason": "原因：{{reason}}",
      "reuploadBy": "请在 {{deadline}} 前重新上传",
      "reupload": "重新上传凭证",
      "paid": "报名已确认，比赛当天出示下面的参赛凭证。",
      "ticketAlt": "{{name}} 的参赛凭证",
      "expired": "订单已过期，名额已释放。",
      "registerAgain": "重新报名",
      "cancelled": "订单已取消。"
    },
    "rejectCode": {
      "NOT_RECEIVED": "未收到这笔款项",
      "AMOUNT_MISMATCH": "金额不符",
      "DUPLICATE_TXN": "交易号重复",
      "UNREADABLE": "截图看不清",
      "WRONG_ACCOUNT": "转错账户",
      "FRAUD": "凭证存疑",
      "OTHER": "其他原因"
    }
  }
}
```

`packages/i18n/locales/en/user.json`，按同样位置追加：

```json
{
  "pay": {
    "title": "Payment",
    "scanQr": "Open your banking app and scan the QR code above",
    "qrAlt": "Payment QR code",
    "accountName": "Account name",
    "accountNo": "Account number",
    "amount": "Amount due",
    "amountHint": "Please transfer exactly this amount.",
    "amountHintIdent": "Please transfer exactly this amount. The odd cents ({{cents}}¢ off) help us identify your order.",
    "orderNo": "Put this order number in the transfer note",
    "copy": "Copy",
    "copied": "Copied",
    "countdown": "Time left to pay",
    "expired": "The payment window has closed and this order will expire. If you already paid, contact support.",
    "upload": "I've paid — upload proof",
    "backToOrder": "View order"
  },
  "proof": {
    "title": "Upload payment proof",
    "intro": "Upload a screenshot of the successful transfer and enter the transaction reference.",
    "file": "Payment screenshot",
    "fileHelp": "JPG, PNG or WebP, up to 5 MB",
    "txnRef": "Transaction reference",
    "txnRefHelp": "The Transaction ID or Reference on your bank receipt",
    "amount": "Amount paid (USD)",
    "paidAt": "Payment time (optional)",
    "submit": "Submit proof",
    "submitting": "Submitting…",
    "reregister": "Register again",
    "error": {
      "fileRequired": "Choose a payment screenshot",
      "fileType": "Only JPG, PNG or WebP images are accepted",
      "fileTooLarge": "The image must be 5 MB or smaller",
      "txnRefLength": "The transaction reference must be 4–64 characters, not counting spaces",
      "amountInvalid": "Enter an amount above 0 with at most two decimals",
      "paidAtInvalid": "The payment time is not valid"
    },
    "serverError": {
      "ORDER_EXPIRED": "This order has expired. Please register again.",
      "PROOF_TXN_REF_USED": "This transaction reference has already been submitted. Check it and try again.",
      "FILE_TOO_LARGE": "The image is larger than 5 MB. Compress it and try again.",
      "FILE_TYPE_NOT_ALLOWED": "We couldn't read this image. Upload a JPG, PNG or WebP screenshot.",
      "ORDER_STATE_CONFLICT": "Proof can't be uploaded for this order right now. Refresh to see its status."
    }
  },
  "orders": {
    "panel": {
      "reviewing": "Your proof is in. Finance usually reviews it within 24 hours and we'll notify you on Telegram.",
      "rejectedTitle": "Your proof wasn't accepted",
      "rejectReason": "Reason: {{reason}}",
      "reuploadBy": "Upload a new proof by {{deadline}}",
      "reupload": "Upload new proof",
      "paid": "Your registration is confirmed. Show the ticket below on race day.",
      "ticketAlt": "Race ticket for {{name}}",
      "expired": "This order has expired and the spots were released.",
      "registerAgain": "Register again",
      "cancelled": "This order was cancelled."
    },
    "rejectCode": {
      "NOT_RECEIVED": "Payment not received",
      "AMOUNT_MISMATCH": "Amount doesn't match",
      "DUPLICATE_TXN": "Duplicate transaction",
      "UNREADABLE": "Screenshot unreadable",
      "WRONG_ACCOUNT": "Paid to the wrong account",
      "FRAUD": "Proof looks suspicious",
      "OTHER": "Other reason"
    }
  }
}
```

`packages/i18n/locales/km/user.json`，按同样位置追加：

```json
{
  "pay": {
    "title": "ការបង់ប្រាក់",
    "scanQr": "បើកកម្មវិធីធនាគាររបស់អ្នក ហើយស្កេនកូដ QR ខាងលើ",
    "qrAlt": "កូដ QR សម្រាប់បង់ប្រាក់",
    "accountName": "ឈ្មោះគណនី",
    "accountNo": "លេខគណនី",
    "amount": "ចំនួនទឹកប្រាក់ត្រូវបង់",
    "amountHint": "សូមផ្ទេរប្រាក់ចំនួននេះឱ្យបានត្រឹមត្រូវ។",
    "amountHintIdent": "សូមផ្ទេរប្រាក់ចំនួននេះឱ្យបានត្រឹមត្រូវ។ សេនចុងក្រោយ (បញ្ចុះ {{cents}} សេន) ជួយយើងស្គាល់ការបញ្ជាទិញរបស់អ្នក។",
    "orderNo": "សូមសរសេរលេខបញ្ជាទិញនេះក្នុងកំណត់ចំណាំផ្ទេរប្រាក់",
    "copy": "ចម្លង",
    "copied": "បានចម្លង",
    "countdown": "ពេលវេលានៅសល់សម្រាប់បង់ប្រាក់",
    "expired": "ពេលវេលាបង់ប្រាក់បានផុតហើយ ការបញ្ជាទិញនេះនឹងផុតសុពលភាព។ ប្រសិនបើអ្នកបានបង់ប្រាក់រួចហើយ សូមទាក់ទងផ្នែកសេវាអតិថិជន។",
    "upload": "ខ្ញុំបានបង់ប្រាក់ហើយ — ផ្ញើភស្តុតាង",
    "backToOrder": "មើលការបញ្ជាទិញ"
  },
  "proof": {
    "title": "ផ្ញើភស្តុតាងបង់ប្រាក់",
    "intro": "សូមផ្ញើរូបថតអេក្រង់នៃការផ្ទេរប្រាក់ជោគជ័យ ហើយបញ្ចូលលេខប្រតិបត្តិការ។",
    "file": "រូបថតអេក្រង់ការបង់ប្រាក់",
    "fileHelp": "JPG, PNG ឬ WebP មិនលើស 5 MB",
    "txnRef": "លេខប្រតិបត្តិការ",
    "txnRefHelp": "លេខ Transaction ID ឬ Reference នៅលើបង្កាន់ដៃធនាគារ",
    "amount": "ចំនួនទឹកប្រាក់បានបង់ (ដុល្លារ)",
    "paidAt": "ពេលវេលាបង់ប្រាក់ (មិនចាំបាច់)",
    "submit": "ដាក់ស្នើភស្តុតាង",
    "submitting": "កំពុងដាក់ស្នើ…",
    "reregister": "ចុះឈ្មោះម្ដងទៀត",
    "error": {
      "fileRequired": "សូមជ្រើសរើសរូបថតអេក្រង់ការបង់ប្រាក់",
      "fileType": "ទទួលយកតែរូបភាព JPG, PNG ឬ WebP ប៉ុណ្ណោះ",
      "fileTooLarge": "រូបភាពមិនអាចលើសពី 5 MB ទេ",
      "txnRefLength": "លេខប្រតិបត្តិការត្រូវមាន 4–64 តួអក្សរ (មិនរាប់ដកឃ្លា)",
      "amountInvalid": "សូមបញ្ចូលចំនួនធំជាង 0 មិនលើសពីរខ្ទង់ទសភាគ",
      "paidAtInvalid": "ពេលវេលាបង់ប្រាក់មិនត្រឹមត្រូវ"
    },
    "serverError": {
      "ORDER_EXPIRED": "ការបញ្ជាទិញនេះផុតសុពលភាពហើយ។ សូមចុះឈ្មោះម្ដងទៀត។",
      "PROOF_TXN_REF_USED": "លេខប្រតិបត្តិការនេះត្រូវបានដាក់ស្នើរួចហើយ។ សូមពិនិត្យ ហើយបញ្ចូលម្ដងទៀត។",
      "FILE_TOO_LARGE": "រូបភាពធំជាង 5 MB។ សូមបង្រួម ហើយព្យាយាមម្ដងទៀត។",
      "FILE_TYPE_NOT_ALLOWED": "យើងមិនអាចអានរូបភាពនេះបានទេ។ សូមផ្ញើរូបថតអេក្រង់ JPG, PNG ឬ WebP។",
      "ORDER_STATE_CONFLICT": "មិនអាចផ្ញើភស្តុតាងសម្រាប់ការបញ្ជាទិញនេះបានទេពេលនេះ។ សូមផ្ទុកឡើងវិញ ដើម្បីមើលស្ថានភាព។"
    }
  },
  "orders": {
    "panel": {
      "reviewing": "ភស្តុតាងរបស់អ្នកបានទទួលហើយ។ ផ្នែកហិរញ្ញវត្ថុជាធម្មតាពិនិត្យក្នុងរយៈពេល 24 ម៉ោង ហើយយើងនឹងជូនដំណឹងតាម Telegram។",
      "rejectedTitle": "ភស្តុតាងរបស់អ្នកមិនត្រូវបានទទួលយកទេ",
      "rejectReason": "មូលហេតុ៖ {{reason}}",
      "reuploadBy": "សូមផ្ញើភស្តុតាងថ្មីមុន {{deadline}}",
      "reupload": "ផ្ញើភស្តុតាងថ្មី",
      "paid": "ការចុះឈ្មោះរបស់អ្នកត្រូវបានបញ្ជាក់។ សូមបង្ហាញសំបុត្រខាងក្រោមនៅថ្ងៃប្រកួត។",
      "ticketAlt": "សំបុត្រប្រកួតសម្រាប់ {{name}}",
      "expired": "ការបញ្ជាទិញនេះផុតសុពលភាព ហើយកន្លែងត្រូវបានដោះលែង។",
      "registerAgain": "ចុះឈ្មោះម្ដងទៀត",
      "cancelled": "ការបញ្ជាទិញនេះត្រូវបានលុបចោល។"
    },
    "rejectCode": {
      "NOT_RECEIVED": "មិនទាន់ទទួលបានប្រាក់",
      "AMOUNT_MISMATCH": "ចំនួនទឹកប្រាក់មិនត្រូវគ្នា",
      "DUPLICATE_TXN": "ប្រតិបត្តិការស្ទួន",
      "UNREADABLE": "រូបថតអេក្រង់មើលមិនច្បាស់",
      "WRONG_ACCOUNT": "បានផ្ទេរទៅគណនីខុស",
      "FRAUD": "ភស្តុតាងគួរឱ្យសង្ស័យ",
      "OTHER": "មូលហេតុផ្សេងទៀត"
    }
  }
}
```

Run: `pnpm i18n:check`
Expected: `i18n 检查通过：3 个命名空间，三种语言 key 一致`。

- [ ] **Step 9: 实现提交、二维码、状态面板、两个页面，并接入订单详情与路由**

创建 `web/user/src/pay/queries.ts`：

```ts
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "@werun/api-client";
import { useApi } from "../api";
import { toProofFormData, type ProofSubmission } from "./proofForm";

export function useSubmitProof(orderNo: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (submission: ProofSubmission) =>
      unwrap(
        await api.POST("/app/orders/{orderNo}/proofs", {
          params: { path: { orderNo } },
          // openapi-typescript 把 format: binary 生成为 string；body 只做类型检查，实际请求体是 bodySerializer 返回的 FormData
          body: {
            file: submission.file.name,
            bankTxnRef: submission.bankTxnRef,
            declaredAmountCents: submission.declaredAmountCents,
            ...(submission.declaredPaidAt ? { declaredPaidAt: submission.declaredPaidAt } : {}),
          },
          bodySerializer: () => toProofFormData(submission),
        }),
      ),
    // 订单列表（["orders"]）与 Task 14 的订单详情（["orders", orderNo]）都需要刷新
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["orders"] }),
  });
}
```

创建 `web/user/src/components/TicketQr.tsx`：

```tsx
import { toDataURL } from "qrcode";
import { useEffect, useState } from "react";
import styles from "../pages/Pay.module.css";

/** 参赛凭证二维码：内容为 ticketCode，本地生成，不请求网络 */
export function TicketQr({ code, label }: { code: string; label: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    toDataURL(code, { errorCorrectionLevel: "M", margin: 1, width: 240 })
      .then((url) => {
        if (active) {
          setSrc(url);
        }
      })
      .catch(() => {
        if (active) {
          setSrc(null);
        }
      });
    return () => {
      active = false;
    };
  }, [code]);

  if (!src) {
    return <div className={styles.qrPlaceholder} aria-busy="true" />;
  }
  return (
    <img
      data-testid="order-ticket-qr"
      data-ticket-code={code}
      className={styles.ticketQr}
      src={src}
      alt={label}
      width={240}
      height={240}
    />
  );
}
```

创建 `web/user/src/orders/OrderStatePanel.tsx`：

```tsx
import type { Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { TicketQr } from "../components/TicketQr";
import { formatDateTime, pickText } from "../format";
import styles from "../pages/Pay.module.css";

/** 订单详情里按状态显示的说明与操作；待付款、部分退款、已退款不显示 */
export function OrderStatePanel({ order }: { order: Schemas["OrderDetail"] }) {
  const { t } = useTranslation("user");
  const lang = useLang();

  switch (order.status) {
    case "PROOF_SUBMITTED":
      return (
        <section className={styles.notice}>
          <p data-testid="order-reviewing">{t("orders.panel.reviewing")}</p>
        </section>
      );
    case "PROOF_REJECTED":
      return (
        <section className={styles.rejectBox}>
          <h2 className={styles.sectionTitle}>{t("orders.panel.rejectedTitle")}</h2>
          <div data-testid="order-reject-reason">
            {order.lastRejection ? (
              <>
                <p>
                  <strong>{t(`orders.rejectCode.${order.lastRejection.code}`)}</strong>
                </p>
                {order.lastRejection.reason ? (
                  <p>{t("orders.panel.rejectReason", { reason: order.lastRejection.reason })}</p>
                ) : null}
              </>
            ) : null}
            {order.deadlineAt ? (
              <p>{t("orders.panel.reuploadBy", { deadline: formatDateTime(order.deadlineAt, lang) })}</p>
            ) : null}
          </div>
          <Link to={`/orders/${order.orderNo}/proof`} data-testid="order-reupload" className={styles.primary}>
            {t("orders.panel.reupload")}
          </Link>
        </section>
      );
    case "PAID":
      return (
        <section className={styles.section}>
          <p>{t("orders.panel.paid")}</p>
          <ul className={styles.ticketList}>
            {order.participants.map((participant) =>
              participant.ticketCode ? (
                <li key={participant.regNo} className={styles.ticket}>
                  <div>
                    <strong>{participant.fullName}</strong>
                    <p className={styles.help}>
                      {pickText(participant.categoryName, lang)} · {participant.regNo}
                    </p>
                  </div>
                  <TicketQr code={participant.ticketCode} label={t("orders.panel.ticketAlt", { name: participant.fullName })} />
                </li>
              ) : null,
            )}
          </ul>
        </section>
      );
    case "EXPIRED":
      return (
        <section className={styles.notice}>
          <p>{t("orders.panel.expired")}</p>
          <Link to={`/events/${order.eventSlug}/register`} data-testid="order-register-again" className={styles.primary}>
            {t("orders.panel.registerAgain")}
          </Link>
        </section>
      );
    case "CANCELLED":
      return (
        <section className={styles.notice}>
          <p>{t("orders.panel.cancelled")}</p>
        </section>
      );
    default:
      return null;
  }
}
```

创建 `web/user/src/pages/Pay.module.css`：

```css
.panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 560px;
}

.label {
  font-size: 13px;
  color: var(--ink-mute);
}

.amount,
.qrWrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--card);
}

.amountValue {
  font-family: var(--mono);
  font-size: 34px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  color: var(--brand);
}

.hint,
.help {
  font-size: 14px;
  color: var(--ink-mid);
}

.qrWrap {
  align-items: center;
  gap: 8px;
}

.qr {
  width: min(280px, 100%);
  height: auto;
  aspect-ratio: 1;
  object-fit: contain;
}

.rows {
  display: grid;
  gap: 8px;
}

.row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.row dt {
  font-size: 14px;
  color: var(--ink-mute);
}

.row dd {
  margin: 0;
  text-align: right;
}

.mono {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

.orderNoCell {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.copy {
  min-height: 36px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 100px;
  background: var(--card);
  color: var(--brand);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.countdownRow {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
}

.countdown {
  font-family: var(--mono);
  font-size: 20px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.expired,
.formError,
.rejectBox {
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--stop-tint);
  color: var(--stop);
}

.rejectBox,
.notice,
.section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 16px 0;
}

.notice {
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--card);
}

.sectionTitle {
  font-size: 17px;
  font-weight: 700;
}

.primary,
.primaryButton {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  align-self: flex-start;
  min-height: 48px;
  padding: 0 20px;
  border: 0;
  border-radius: 100px;
  background: var(--brand);
  color: var(--card);
  font: inherit;
  font-weight: 700;
  text-decoration: none;
  cursor: pointer;
}

.primaryButton:disabled {
  opacity: 0.6;
  cursor: progress;
}

.secondary {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  align-self: flex-start;
  min-height: 44px;
  padding: 0 18px;
  border: 1px solid var(--brand);
  border-radius: 100px;
  background: var(--card);
  color: var(--brand);
  font-weight: 600;
  text-decoration: none;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.input {
  min-height: 44px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--card);
  font: inherit;
}

.fieldError {
  font-size: 13px;
  color: var(--stop);
}

.ticketList {
  display: grid;
  gap: 12px;
  padding: 0;
  list-style: none;
}

.ticket {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--card);
}

.ticketQr,
.qrPlaceholder {
  width: 200px;
  height: 200px;
}

.qrPlaceholder {
  border-radius: 8px;
  background: var(--sunk);
}
```

创建 `web/user/src/pages/PayPage.tsx`：

```tsx
import { ApiError, formatUsd, type Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useParams } from "react-router";
import { QueryState } from "../components/QueryState";
import { pickText } from "../format";
import { useMyOrder } from "../orders/api";
import { formatCountdown, useCountdown } from "../pay/useCountdown";
import { NotFoundPage } from "./NotFoundPage";
import styles from "./Pay.module.css";
import pageStyles from "./Page.module.css";

const PAYABLE_STATUSES = new Set<string>(["PENDING_PAYMENT", "PROOF_REJECTED"]);

export function PayPage() {
  const { orderNo = "" } = useParams();
  const order = useMyOrder(orderNo);

  if (order.error instanceof ApiError && order.error.status === 404) {
    return <NotFoundPage />;
  }
  return <QueryState query={order}>{(data) => <PayContent order={data} />}</QueryState>;
}

function PayContent({ order }: { order: Schemas["OrderDetail"] }) {
  const { t } = useTranslation("user");
  const lang = useLang();
  const remaining = useCountdown(order.deadlineAt);
  const [copied, setCopied] = useState(false);

  if (!PAYABLE_STATUSES.has(order.status)) {
    return <Navigate to={`/orders/${order.orderNo}`} replace />;
  }

  const expired = remaining === 0;
  const copyOrderNo = async () => {
    try {
      await navigator.clipboard.writeText(order.orderNo);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <article className={styles.panel}>
      <h1 className={pageStyles.title}>{t("pay.title")}</h1>
      <p className={pageStyles.muted}>{pickText(order.eventName, lang)}</p>

      <section className={styles.amount}>
        <span className={styles.label}>{t("pay.amount")}</span>
        <strong data-testid="pay-amount" className={styles.amountValue}>
          {formatUsd(order.amountCents)}
        </strong>
        <p className={styles.hint}>
          {order.identOffsetCents > 0 ? t("pay.amountHintIdent", { cents: order.identOffsetCents }) : t("pay.amountHint")}
        </p>
      </section>

      <div className={styles.qrWrap}>
        <img
          data-testid="pay-qr"
          className={styles.qr}
          src={`/api/files/${order.paymentAccount.qrFileId}`}
          alt={t("pay.qrAlt")}
          width={280}
          height={280}
        />
        <p className={pageStyles.muted}>{t("pay.scanQr")}</p>
      </div>

      <dl className={styles.rows}>
        <div className={styles.row}>
          <dt>{t("pay.accountName")}</dt>
          <dd>{order.paymentAccount.accountName}</dd>
        </div>
        <div className={styles.row}>
          <dt>{t("pay.accountNo")}</dt>
          <dd className={styles.mono}>{order.paymentAccount.accountNoMasked}</dd>
        </div>
        <div className={styles.row}>
          <dt>{t("pay.orderNo")}</dt>
          <dd className={styles.orderNoCell}>
            <span data-testid="pay-order-no" className={styles.mono}>
              {order.orderNo}
            </span>
            <button type="button" data-testid="pay-copy-order-no" className={styles.copy} onClick={() => void copyOrderNo()}>
              {copied ? t("pay.copied") : t("pay.copy")}
            </button>
          </dd>
        </div>
      </dl>

      {expired ? (
        <p data-testid="pay-expired" className={styles.expired} role="alert">
          {t("pay.expired")}
        </p>
      ) : (
        <>
          {remaining !== null ? (
            <p className={styles.countdownRow}>
              <span>{t("pay.countdown")}</span>
              <strong data-testid="pay-countdown" className={styles.countdown}>
                {formatCountdown(remaining)}
              </strong>
            </p>
          ) : null}
          <Link to={`/orders/${order.orderNo}/proof`} data-testid="pay-upload-link" className={styles.primary}>
            {t("pay.upload")}
          </Link>
        </>
      )}

      <Link to={`/orders/${order.orderNo}`} className={styles.secondary}>
        {t("pay.backToOrder")}
      </Link>
    </article>
  );
}
```

创建 `web/user/src/pages/ProofUploadPage.tsx`：

```tsx
import { ApiError, formatUsd, type Schemas } from "@werun/api-client";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import { QueryState } from "../components/QueryState";
import { useMyOrder } from "../orders/api";
import { PROOF_ACCEPT, centsToInput, validateProofForm, type ProofField } from "../pay/proofForm";
import { useSubmitProof } from "../pay/queries";
import { NotFoundPage } from "./NotFoundPage";
import styles from "./Pay.module.css";
import pageStyles from "./Page.module.css";

const PAYABLE_STATUSES = new Set<string>(["PENDING_PAYMENT", "PROOF_REJECTED"]);

/** 服务端字段名 → 表单字段 */
const SERVER_FIELDS: Record<string, ProofField> = {
  file: "file",
  bankTxnRef: "txnRef",
  declaredAmountCents: "amount",
  declaredPaidAt: "paidAt",
};

/** 需要专门提示的错误码；其余错误显示服务端返回的文案 */
const SERVER_ERROR_KEYS: Record<string, string> = {
  ORDER_EXPIRED: "proof.serverError.ORDER_EXPIRED",
  PROOF_TXN_REF_USED: "proof.serverError.PROOF_TXN_REF_USED",
  FILE_TOO_LARGE: "proof.serverError.FILE_TOO_LARGE",
  FILE_TYPE_NOT_ALLOWED: "proof.serverError.FILE_TYPE_NOT_ALLOWED",
  ORDER_STATE_CONFLICT: "proof.serverError.ORDER_STATE_CONFLICT",
};

type FieldMessages = Partial<Record<ProofField, string>>;

export function ProofUploadPage() {
  const { orderNo = "" } = useParams();
  const order = useMyOrder(orderNo);

  if (order.error instanceof ApiError && order.error.status === 404) {
    return <NotFoundPage />;
  }
  return <QueryState query={order}>{(data) => <ProofForm order={data} />}</QueryState>;
}

function ProofForm({ order }: { order: Schemas["OrderDetail"] }) {
  const { t } = useTranslation("user");
  const navigate = useNavigate();
  const submit = useSubmitProof(order.orderNo);
  const [file, setFile] = useState<File | null>(null);
  const [txnRef, setTxnRef] = useState("");
  const [amount, setAmount] = useState(() => centsToInput(order.amountCents));
  const [paidAt, setPaidAt] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldMessages>({});
  const [formError, setFormError] = useState<{ message: string; expired: boolean } | null>(null);

  if (!PAYABLE_STATUSES.has(order.status)) {
    return <Navigate to={`/orders/${order.orderNo}`} replace />;
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    const result = validateProofForm({ file, txnRef, amount, paidAt });
    if (!result.ok) {
      setFieldErrors(Object.fromEntries(Object.entries(result.errors).map(([field, key]) => [field, t(key)])));
      return;
    }
    setFieldErrors({});
    submit.mutate(result.value, {
      onSuccess: () => {
        void navigate(`/orders/${order.orderNo}`, { replace: true });
      },
      onError: (error) => {
        if (!(error instanceof ApiError)) {
          setFormError({ message: error.message, expired: false });
          return;
        }
        const mapped: FieldMessages = {};
        for (const [serverField, text] of Object.entries(error.fields)) {
          const field = SERVER_FIELDS[serverField];
          if (field) {
            mapped[field] = text;
          }
        }
        setFieldErrors(mapped);
        const key = SERVER_ERROR_KEYS[error.code];
        setFormError({ message: key ? t(key) : error.message, expired: error.code === "ORDER_EXPIRED" });
      },
    });
  };

  return (
    <article className={styles.panel}>
      <h1 className={pageStyles.title}>{t("proof.title")}</h1>
      <p className={pageStyles.muted}>{t("proof.intro")}</p>
      <p className={styles.hint}>
        {t("pay.amount")}：<strong className={styles.mono}>{formatUsd(order.amountCents)}</strong> ·{" "}
        <span className={styles.mono}>{order.orderNo}</span>
      </p>

      <form className={styles.form} onSubmit={onSubmit} noValidate>
        <label className={styles.field}>
          <span className={styles.label}>{t("proof.file")}</span>
          <input
            type="file"
            data-testid="proof-file-input"
            accept={PROOF_ACCEPT}
            aria-invalid={fieldErrors.file ? true : undefined}
            onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
          />
          <span className={styles.help}>{t("proof.fileHelp")}</span>
          {fieldErrors.file ? (
            <span className={styles.fieldError} role="alert">
              {fieldErrors.file}
            </span>
          ) : null}
        </label>

        <label className={styles.field}>
          <span className={styles.label}>{t("proof.txnRef")}</span>
          <input
            type="text"
            data-testid="proof-txn-ref"
            className={styles.input}
            value={txnRef}
            autoComplete="off"
            autoCapitalize="characters"
            maxLength={128}
            aria-invalid={fieldErrors.txnRef ? true : undefined}
            onChange={(event) => setTxnRef(event.currentTarget.value)}
          />
          <span className={styles.help}>{t("proof.txnRefHelp")}</span>
          {fieldErrors.txnRef ? (
            <span className={styles.fieldError} role="alert">
              {fieldErrors.txnRef}
            </span>
          ) : null}
        </label>

        <label className={styles.field}>
          <span className={styles.label}>{t("proof.amount")}</span>
          <input
            type="text"
            inputMode="decimal"
            data-testid="proof-amount"
            className={styles.input}
            value={amount}
            aria-invalid={fieldErrors.amount ? true : undefined}
            onChange={(event) => setAmount(event.currentTarget.value)}
          />
          {fieldErrors.amount ? (
            <span className={styles.fieldError} role="alert">
              {fieldErrors.amount}
            </span>
          ) : null}
        </label>

        <label className={styles.field}>
          <span className={styles.label}>{t("proof.paidAt")}</span>
          <input
            type="datetime-local"
            data-testid="proof-paid-at"
            className={styles.input}
            value={paidAt}
            aria-invalid={fieldErrors.paidAt ? true : undefined}
            onChange={(event) => setPaidAt(event.currentTarget.value)}
          />
          {fieldErrors.paidAt ? (
            <span className={styles.fieldError} role="alert">
              {fieldErrors.paidAt}
            </span>
          ) : null}
        </label>

        {formError ? (
          <div data-testid="form-error" className={styles.formError} role="alert">
            <p>{formError.message}</p>
            {formError.expired ? (
              <Link to={`/events/${order.eventSlug}/register`} data-testid="proof-reregister">
                {t("proof.reregister")}
              </Link>
            ) : null}
          </div>
        ) : null}

        <button type="submit" data-testid="proof-submit" className={styles.primaryButton} disabled={submit.isPending}>
          {submit.isPending ? t("proof.submitting") : t("proof.submit")}
        </button>
      </form>
    </article>
  );
}
```

`web/user/src/pages/OrderDetailPage.tsx`（Task 14 创建）改 4 处：

1）把

```tsx
import { useCancelOrder, useMyOrder } from "../orders/api";
import orders from "../orders/Orders.module.css";
```

改为

```tsx
import { useCancelOrder, useMyOrder } from "../orders/api";
import orders from "../orders/Orders.module.css";
import { OrderStatePanel } from "../orders/OrderStatePanel";
import { formatCountdown, useCountdown } from "../pay/useCountdown";
```

2）把

```tsx
// Task 18 在此补全审核中、驳回原因与重传、已确认参赛凭证、过期等状态
```

改为

```tsx
// 审核中、驳回原因与重传、已确认参赛凭证、已过期、已取消的说明由 OrderStatePanel 渲染
```

并把

```tsx
  const canPay = order.status === "PENDING_PAYMENT" || order.status === "PROOF_REJECTED";
  const canCancel = order.status === "PENDING_PAYMENT";
```

改为

```tsx
  const canPay = order.status === "PENDING_PAYMENT" || order.status === "PROOF_REJECTED";
  const canCancel = order.status === "PENDING_PAYMENT";
  const remaining = useCountdown(canPay ? order.deadlineAt : null);
```

3）把

```tsx
        {canPay && order.deadlineAt ? (
          <span data-testid="order-deadline">{t("orders.deadline", { time: formatDateTime(order.deadlineAt, lang) })}</span>
        ) : null}
      </p>
```

改为

```tsx
        {canPay && order.deadlineAt ? (
          <span data-testid="order-deadline">{t("orders.deadline", { time: formatDateTime(order.deadlineAt, lang) })}</span>
        ) : null}
        {canPay && remaining !== null ? (
          <span data-testid="order-countdown" aria-label={t("pay.countdown")}>
            {formatCountdown(remaining)}
          </span>
        ) : null}
      </p>
```

4）把

```tsx
      {cancel.error ? (
```

改为

```tsx
      <OrderStatePanel order={order} />

      {cancel.error ? (
```

`web/user/src/routes.tsx`：在 `import { OrderDetailPage } from "./pages/OrderDetailPage";` 之后加入

```tsx
import { PayPage } from "./pages/PayPage";
import { ProofUploadPage } from "./pages/ProofUploadPage";
```

并把 `RequireRunner` 布局路由 `children` 中的

```tsx
          { path: "orders/:orderNo", element: <OrderDetailPage /> },
```

改为

```tsx
          { path: "orders/:orderNo", element: <OrderDetailPage /> },
          { path: "orders/:orderNo/pay", element: <PayPage /> },
          { path: "orders/:orderNo/proof", element: <ProofUploadPage /> },
```

- [ ] **Step 10: 运行页面测试，确认通过（含 Task 14 的订单详情测试）**

Run: `pnpm --filter @werun/user test -- src/pages/PayPage.test.tsx src/pages/ProofUploadPage.test.tsx src/pages/OrderDetailPage.states.test.tsx src/pages/OrderDetailPage.test.tsx src/pay`
Expected: `PayPage.test.tsx`（4 个用例）、`ProofUploadPage.test.tsx`（5 个用例）、`OrderDetailPage.states.test.tsx`（6 个用例）、Task 14 的 `OrderDetailPage.test.tsx`（5 个用例）、`src/pay` 下 11 个用例全部通过。

- [ ] **Step 11: 全量检查**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm i18n:check`
Expected: 全部通过。

- [ ] **Step 12: 提交**

```bash
git add web/user/package.json pnpm-lock.yaml \
  web/user/src/pay web/user/src/components/TicketQr.tsx web/user/src/orders/OrderStatePanel.tsx \
  web/user/src/pages/Pay.module.css web/user/src/pages/PayPage.tsx web/user/src/pages/ProofUploadPage.tsx \
  web/user/src/pages/OrderDetailPage.tsx web/user/src/pages/PayPage.test.tsx web/user/src/pages/ProofUploadPage.test.tsx \
  web/user/src/pages/OrderDetailPage.states.test.tsx web/user/src/routes.tsx \
  packages/i18n/locales/zh/user.json packages/i18n/locales/en/user.json packages/i18n/locales/km/user.json
git commit -m "$(cat <<'EOF'
feat(user): add payment page, proof upload and order state panel with ticket QR

Adds qrcode 1.5.4 and @types/qrcode 1.5.6.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
)"
```

提交信息第二段的版本号必须改成 Step 1 实际锁定的版本。

---
### Task 19: 后台审核与订单页面

**Files:**
- Create: `web/admin/src/orders/format.ts`
- Create: `web/admin/src/orders/format.test.ts`
- Create: `web/admin/src/orders/queries.ts`
- Create: `web/admin/src/orders/OrderStatusTag.tsx`
- Create: `web/admin/src/orders/OrderSections.tsx`
- Create: `web/admin/src/proofs/queries.ts`
- Create: `web/admin/src/proofs/ProofStatusTag.tsx`
- Create: `web/admin/src/proofs/ApproveProofModal.tsx`
- Create: `web/admin/src/proofs/RejectProofModal.tsx`
- Create: `web/admin/src/pages/ProofsPage.tsx`
- Create: `web/admin/src/pages/ProofDetailPage.tsx`
- Create: `web/admin/src/pages/OrdersPage.tsx`
- Create: `web/admin/src/pages/OrderDetailPage.tsx`
- Modify: `web/admin/src/routes.tsx`（新增 4 条路由）
- Modify: `web/admin/src/layout/AppLayout.tsx`（新增 2 个菜单项）
- Modify: `packages/i18n/locales/zh/admin.json`、`packages/i18n/locales/en/admin.json`、`packages/i18n/locales/km/admin.json`
- Create: `web/admin/src/test/reviewFixtures.ts`
- Create: `web/admin/src/review.test.tsx`
- Create: `web/admin/src/orders.test.tsx`

**Interfaces:**
- Consumes:
  - `formatUsd`、`parseUsdToCents`、`unwrap`、`ApiError`、`Schemas`（`@werun/api-client`）
  - `Schemas["ProofQueueItem" | "ProofQueue" | "ProofDetail" | "Proof" | "ApproveProofRequest" | "RejectProofRequest"]`（Task 17）、`Schemas["AdminOrderSummary" | "AdminOrderList" | "AdminOrderDetail"]`（Task 16）
  - `can`、`PERM_PROOF_REVIEW`、`PERM_ORDER_VIEW`、`PERM_EVENT_CONFIG`（`web/admin/src/auth/can.ts`）、`useMe`、`RequirePermission`、`pickText`、`useApi`
  - `renderAdminApp`、`jsonResponse`、`photographerMe`、`draftEvent`（`web/admin/src/test/*`）
- Produces:
  - 路由 `/proofs`（`ProofsPage`）、`/proofs/:id`（`ProofDetailPage`）——`proof_review` read；`/orders`（`OrdersPage`）、`/orders/:id`（`OrderDetailPage`）——`order_view` read
  - `AppLayout` 菜单：`/proofs`（`proofs.title`，`proof_review` read）、`/orders`（`orders.title`，`order_view` read）
  - testid / 表单：`proof-row-<proofNo>`（带 `data-over-sla`）、`proof-status`（`data-status`）、`proof-image`、`proof-approve-open`、表单 `name="approve"`（`receivedUsd`、`receivedAt`、`note`）、`proof-approve-submit`、`proof-approve-too-low`、`proof-reject-open`、表单 `name="reject"`（`rejectCode`、`rejectReason`）、`proof-reject-submit`、`order-row-<orderNo>`、`order-status`（`data-status`）、表单 `name="orderFilter"`（`eventId`、`status`、`q`）、`order-filter-submit`、`order-ident-offset`、`order-amount`
  - 文案 `admin.proofs.*`、`admin.orders.*`

**要点**

- 通过弹窗：`receivedUsd` 默认填申报金额，`receivedAt` 默认填申报付款时间（没有则当前时间）；`Form.useWatch` 实时解析金额，解析失败或小于应付时提交按钮禁用，小于应付时显示 `proof-approve-too-low` 提示；多付时显示多付提示但允许提交。
- 驳回弹窗：`rejectReason` 的校验依赖 `rejectCode`，选 `OTHER` 时必填；最长 500 字。
- 审核按钮只在当前员工有 `proof_review` 写权限、凭证 `SUBMITTED` 且订单 `PROOF_SUBMITTED` 时显示。
- antd `Table` 的 `onRow` 返回 `HTMLAttributes`，对象字面量里写 `"data-testid"` 会触发多余属性检查（TS2353），所以用 `rowProps()` 通过 `Object.assign` 附加 `data-*` 属性（已用本仓库的 TypeScript 5.9 与 `@types/react` 验证可通过类型检查）。
- antd `Image` 把其余属性放在外层 `div` 上，所以 `proof-image` 在包裹元素上，测试通过 `within(...).getByRole("img")` 检查 `src`。
- 订单列表只在有 `event_config` 读权限时请求赛事列表并显示赛事筛选（SUPPORT 没有该权限）。

- [ ] **Step 1: 写格式化工具的失败测试**

创建 `web/admin/src/orders/format.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { centsToUsdInput, rowProps, waitingParts } from "./format";

describe("centsToUsdInput", () => {
  it("整数分转成两位小数的美元字符串", () => {
    expect(centsToUsdInput(2451)).toBe("24.51");
    expect(centsToUsdInput(5)).toBe("0.05");
    expect(centsToUsdInput(100000)).toBe("1000.00");
  });
});

describe("waitingParts", () => {
  it("按分钟向下取整拆成小时与分钟，未来时间记为 0", () => {
    const now = Date.parse("2026-09-15T04:10:59Z");
    expect(waitingParts("2026-09-14T03:00:00Z", now)).toEqual({ hours: 25, minutes: 10 });
    expect(waitingParts("2026-09-15T04:02:00Z", now)).toEqual({ hours: 0, minutes: 8 });
    expect(waitingParts("2026-09-15T05:00:00Z", now)).toEqual({ hours: 0, minutes: 0 });
  });
});

describe("rowProps", () => {
  it("在行属性上附加 data-testid 与 data-* 属性", () => {
    const onClick = () => undefined;
    expect(rowProps("proof-row-PF1", { onClick }, { "data-over-sla": "true" })).toEqual({
      onClick,
      "data-testid": "proof-row-PF1",
      "data-over-sla": "true",
    });
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @werun/admin test -- src/orders/format.test.ts`
Expected: FAIL，报 `Failed to resolve import "./format"`。

- [ ] **Step 3: 实现格式化工具**

创建 `web/admin/src/orders/format.ts`：

```ts
import dayjs from "dayjs";
import type { HTMLAttributes } from "react";

/** 2451 → "24.51"；只用整数运算 */
export function centsToUsdInput(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const rest = Math.abs(cents % 100);
  return `${whole}.${String(rest).padStart(2, "0")}`;
}

/** 按浏览器时区显示到分钟；空值显示破折号 */
export function formatDateTime(iso: string | null | undefined): string {
  return iso ? dayjs(iso).format("YYYY-MM-DD HH:mm") : "—";
}

export function waitingParts(sinceIso: string, nowMs: number): { hours: number; minutes: number } {
  const totalMinutes = Math.max(0, Math.floor((nowMs - Date.parse(sinceIso)) / 60_000));
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}

/** antd Table onRow 用：对象字面量里写 data-* 会触发多余属性检查，这里用 Object.assign 附加 */
export function rowProps(
  testId: string,
  attrs: HTMLAttributes<HTMLElement>,
  data: Record<`data-${string}`, string> = {},
): HTMLAttributes<HTMLElement> {
  return Object.assign(attrs, { "data-testid": testId }, data);
}
```

Run: `pnpm --filter @werun/admin test -- src/orders/format.test.ts`
Expected: 3 个用例通过。

- [ ] **Step 4: 写页面测试夹具与失败的组件测试**

创建 `web/admin/src/test/reviewFixtures.ts`：

```ts
import type { Schemas } from "@werun/api-client";

export const ORDER_NO = "WR7K3M9Q2A";

export const reviewerMe: Schemas["Me"] = {
  staff: { id: 5, username: "finance.lina", fullName: "Lina Sok", role: "FINANCE" },
  permissions: { event_config: "read", order_view: "read", proof_review: "write", payment_account_manage: "write" },
};

export const supportMe: Schemas["Me"] = {
  staff: { id: 6, username: "support.dara", fullName: "Dara Meas", role: "SUPPORT" },
  permissions: { order_view: "read", proof_review: "read", coupon_manage: "read" },
};

const eventName: Schemas["LocalizedText"] = {
  zh: "金边半程马拉松 2026",
  en: "Phnom Penh Half Marathon 2026",
  km: "ម៉ារ៉ាតុងពាក់កណ្ដាលភ្នំពេញ ២០២៦",
};

export const orderDetail: Schemas["AdminOrderDetail"] = {
  id: 501,
  orderNo: ORDER_NO,
  eventId: 7,
  eventSlug: "phnom-penh-half-2026",
  eventName,
  eventTimezone: "Asia/Phnom_Penh",
  status: "PROOF_SUBMITTED",
  reservationState: "RESERVED",
  buyerName: "Sokha Chan",
  buyerPhone: "+85512345678",
  listAmountCents: 2500,
  discountCents: 49,
  identOffsetCents: 49,
  amountCents: 2451,
  currency: "USD",
  deadlineAt: null,
  paidAt: null,
  createdAt: "2026-09-14T02:40:00Z",
  paymentAccount: {
    id: 3,
    name: "ABA USD 主收款户",
    provider: "ABA",
    accountName: "WERUN SPORTS CO LTD",
    accountNoMasked: "*** *** 123",
    qrFileId: 31,
  },
  participants: [
    {
      registrationId: 801,
      regNo: "RG4D6F8H1J",
      categoryId: 11,
      categoryName: { zh: "半程 21K", en: "Half Marathon 21K", km: "ពាក់កណ្ដាលម៉ារ៉ាតុង 21K" },
      fullName: "Sokha Chan",
      priceRuleId: 21,
      listPriceCents: 2500,
      paidCents: 2451,
      registrationStatus: "PENDING",
      ticketCode: null,
    },
  ],
  proofs: [
    {
      id: 301,
      proofNo: "PF8H2K4M6N",
      status: "SUBMITTED",
      bankTxnRef: "ABA778899",
      declaredAmountCents: 2451,
      rejectCode: null,
      createdAt: "2026-09-14T02:56:00Z",
      reviewedAt: null,
    },
  ],
  receipts: [],
};

export const submittedProof: Schemas["Proof"] = {
  id: 301,
  proofNo: "PF8H2K4M6N",
  orderId: 501,
  orderNo: ORDER_NO,
  paymentAccountId: 3,
  fileId: 88,
  status: "SUBMITTED",
  bankTxnRef: "ABA778899",
  declaredAmountCents: 2451,
  declaredPaidAt: "2026-09-14T02:55:00Z",
  payerName: "SOKHA CHAN",
  dupFileHit: false,
  rejectCode: null,
  rejectReason: null,
  reviewedBy: null,
  reviewedAt: null,
  createdAt: "2026-09-14T02:56:00Z",
};

export const proofDetail: Schemas["ProofDetail"] = { proof: submittedProof, order: orderDetail };

export const approvedDetail: Schemas["ProofDetail"] = {
  proof: { ...submittedProof, status: "APPROVED", reviewedBy: 5, reviewedAt: "2026-09-14T03:10:00Z" },
  order: {
    ...orderDetail,
    status: "PAID",
    reservationState: "CONSUMED",
    paidAt: "2026-09-14T02:55:00Z",
    proofs: [{ ...orderDetail.proofs[0]!, status: "APPROVED", reviewedAt: "2026-09-14T03:10:00Z" }],
    receipts: [{ id: 91, txnRef: "ABA778899", amountCents: 2451, receivedAt: "2026-09-14T02:55:00Z", matchStatus: "APPLIED" }],
  },
};

export const rejectedDetail: Schemas["ProofDetail"] = {
  proof: {
    ...submittedProof,
    status: "REJECTED",
    rejectCode: "OTHER",
    rejectReason: "Paid to a personal account",
    reviewedBy: 5,
    reviewedAt: "2026-09-14T03:10:00Z",
  },
  order: { ...orderDetail, status: "PROOF_REJECTED", deadlineAt: "2026-09-15T03:10:00Z" },
};

export const queueItems: Schemas["ProofQueueItem"][] = [
  { proof: submittedProof, amountCents: 2451, eventName, waitingSince: "2026-09-13T02:56:00Z", overSla: true },
  {
    proof: {
      ...submittedProof,
      id: 302,
      proofNo: "PF3J5L7P9R",
      orderId: 502,
      orderNo: "WR2B4C6D8E",
      fileId: 89,
      bankTxnRef: "ACL123456",
      declaredAmountCents: 3000,
      dupFileHit: true,
      createdAt: "2026-09-14T02:00:00Z",
    },
    amountCents: 2999,
    eventName,
    waitingSince: "2026-09-14T02:00:00Z",
    overSla: false,
  },
];

export const orderSummary: Schemas["AdminOrderSummary"] = {
  id: 501,
  orderNo: ORDER_NO,
  eventId: 7,
  eventSlug: "phnom-penh-half-2026",
  eventName,
  status: "PROOF_SUBMITTED",
  listAmountCents: 2500,
  discountCents: 49,
  identOffsetCents: 49,
  amountCents: 2451,
  currency: "USD",
  participantCount: 1,
  deadlineAt: null,
  paidAt: null,
  createdAt: "2026-09-14T02:40:00Z",
};
```

创建 `web/admin/src/review.test.tsx`：

```tsx
import { screen, waitFor, within } from "@testing-library/react";
import userEvent, { PointerEventsCheckLevel } from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { jsonResponse, photographerMe } from "./test/fixtures";
import { renderAdminApp } from "./test/renderAdminApp";
import {
  ORDER_NO,
  approvedDetail,
  reviewerMe,
  proofDetail,
  queueItems,
  rejectedDetail,
  supportMe,
} from "./test/reviewFixtures";

beforeEach(() => {
  window.localStorage.setItem("werun.lang", "en");
});

/** antd 表单交互关闭 pointer-events 检查，原因见 app.test.tsx */
function setupFormUser() {
  return userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
}

/** 等 antd 弹窗里的表单项渲染出来 */
async function findField<T extends HTMLElement>(id: string): Promise<T> {
  return waitFor(() => {
    const element = document.querySelector<T>(`#${id}`);
    if (!element) {
      throw new Error(`#${id} 尚未渲染`);
    }
    return element;
  });
}

describe("凭证队列", () => {
  it("默认请求待审凭证：超时行高亮、重复截图有标记，点击行进入详情", async () => {
    const { router, requests } = renderAdminApp("/proofs", {
      "GET /api/admin/me": () => jsonResponse(200, reviewerMe),
      "GET /api/admin/proofs": () => jsonResponse(200, { items: queueItems }),
      "GET /api/admin/proofs/301": () => jsonResponse(200, proofDetail),
    });

    const overdue = await screen.findByTestId("proof-row-PF8H2K4M6N");
    expect(overdue).toHaveAttribute("data-over-sla", "true");
    expect(within(overdue).getByText("Overdue")).toBeInTheDocument();
    expect(overdue).toHaveTextContent("$24.51");
    const duplicate = screen.getByTestId("proof-row-PF3J5L7P9R");
    expect(duplicate).toHaveAttribute("data-over-sla", "false");
    expect(within(duplicate).getByText("Duplicate screenshot")).toBeInTheDocument();
    const listRequest = requests.find((request) => new URL(request.url).pathname === "/api/admin/proofs");
    expect(new URL(listRequest!.url).searchParams.get("status")).toBe("SUBMITTED");

    await setupFormUser().click(overdue);

    await waitFor(() => expect(router.state.location.pathname).toBe("/proofs/301"));
    expect(await screen.findByTestId("proof-status")).toHaveAttribute("data-status", "SUBMITTED");
  });

  it("切换到已驳回后按新状态重新请求", async () => {
    const { requests } = renderAdminApp("/proofs", {
      "GET /api/admin/me": () => jsonResponse(200, reviewerMe),
      "GET /api/admin/proofs": () => jsonResponse(200, { items: queueItems }),
    });
    await screen.findByTestId("proof-row-PF8H2K4M6N");

    await setupFormUser().click(screen.getByText("Rejected"));

    await waitFor(() => {
      const statuses = requests
        .filter((request) => new URL(request.url).pathname === "/api/admin/proofs")
        .map((request) => new URL(request.url).searchParams.get("status"));
      expect(statuses).toContain("REJECTED");
    });
  });

  it("菜单按权限显示凭证审核与订单", async () => {
    renderAdminApp("/proofs", {
      "GET /api/admin/me": () => jsonResponse(200, reviewerMe),
      "GET /api/admin/proofs": () => jsonResponse(200, { items: [] }),
    });
    expect(await screen.findByRole("menuitem", { name: /Payment review/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Orders/ })).toBeInTheDocument();
  });

  it("摄影师没有 proof_review：显示 403 且菜单不显示凭证审核", async () => {
    renderAdminApp("/proofs", {
      "GET /api/admin/me": () => jsonResponse(200, photographerMe),
    });
    expect(await screen.findByTestId("forbidden-page")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Payment review/ })).not.toBeInTheDocument();
  });
});

describe("凭证详情", () => {
  it("显示截图与申报信息；到账金额小于应付时通过按钮不可用并提示", async () => {
    renderAdminApp("/proofs/301", {
      "GET /api/admin/me": () => jsonResponse(200, reviewerMe),
      "GET /api/admin/proofs/301": () => jsonResponse(200, proofDetail),
    });

    const image = await screen.findByTestId("proof-image");
    expect(within(image).getByRole("img")).toHaveAttribute("src", "/api/admin/files/88");
    expect(screen.getAllByText(ORDER_NO).length).toBeGreaterThan(0);
    expect(screen.getByText("SOKHA CHAN")).toBeInTheDocument();

    const user = setupFormUser();
    await user.click(screen.getByTestId("proof-approve-open"));
    const amount = await findField<HTMLInputElement>("approve_receivedUsd");
    expect(amount).toHaveValue("24.51");
    await waitFor(() => expect(screen.getByTestId("proof-approve-submit")).toBeEnabled());

    await user.clear(amount);
    await user.paste("24.50");

    await waitFor(() => expect(screen.getByTestId("proof-approve-submit")).toBeDisabled());
    expect(screen.getByTestId("proof-approve-too-low")).toHaveTextContent("$24.51");
  });

  it("按申报金额通过：请求体正确，成功后状态变为已通过并隐藏审核按钮", async () => {
    let approved = false;
    const { requests } = renderAdminApp("/proofs/301", {
      "GET /api/admin/me": () => jsonResponse(200, reviewerMe),
      "GET /api/admin/proofs/301": () => jsonResponse(200, approved ? approvedDetail : proofDetail),
      "POST /api/admin/proofs/301/approve": () => {
        approved = true;
        return jsonResponse(200, approvedDetail);
      },
    });

    const user = setupFormUser();
    await user.click(await screen.findByTestId("proof-approve-open"));
    await findField("approve_receivedUsd");
    await waitFor(() => expect(screen.getByTestId("proof-approve-submit")).toBeEnabled());
    await user.click(screen.getByTestId("proof-approve-submit"));

    await waitFor(() => expect(screen.getByTestId("proof-status")).toHaveAttribute("data-status", "APPROVED"));
    expect(screen.queryByTestId("proof-approve-open")).not.toBeInTheDocument();
    const post = requests.find((request) => request.method === "POST");
    expect(post?.headers.get("X-WeRun-Client")).toBe("admin");
    expect(await post?.clone().json()).toEqual({
      receivedAmountCents: 2451,
      receivedAt: "2026-09-14T02:55:00.000Z",
      note: null,
    });
  });

  it("驳回选「其他原因」时说明必填，填写后提交", async () => {
    let rejected = false;
    const { requests } = renderAdminApp("/proofs/301", {
      "GET /api/admin/me": () => jsonResponse(200, reviewerMe),
      "GET /api/admin/proofs/301": () => jsonResponse(200, rejected ? rejectedDetail : proofDetail),
      "POST /api/admin/proofs/301/reject": () => {
        rejected = true;
        return jsonResponse(200, rejectedDetail);
      },
    });

    const user = setupFormUser();
    await user.click(await screen.findByTestId("proof-reject-open"));
    await user.click(await findField("reject_rejectCode"));
    await user.click(await screen.findByTitle("Other"));
    await user.click(screen.getByTestId("proof-reject-submit"));

    expect(await screen.findByText("Explain the reason when choosing Other")).toBeInTheDocument();
    expect(requests.some((request) => request.method === "POST")).toBe(false);

    await user.click(await findField("reject_rejectReason"));
    await user.paste("Paid to a personal account");
    await user.click(screen.getByTestId("proof-reject-submit"));

    await waitFor(() => expect(screen.getByTestId("proof-status")).toHaveAttribute("data-status", "REJECTED"));
    const post = requests.find((request) => request.method === "POST");
    expect(new URL(post!.url).pathname).toBe("/api/admin/proofs/301/reject");
    expect(await post!.clone().json()).toEqual({ rejectCode: "OTHER", rejectReason: "Paid to a personal account" });
  });

  it("SUPPORT 只读：能看详情，看不到通过与驳回按钮", async () => {
    renderAdminApp("/proofs/301", {
      "GET /api/admin/me": () => jsonResponse(200, supportMe),
      "GET /api/admin/proofs/301": () => jsonResponse(200, proofDetail),
    });

    expect(await screen.findByTestId("proof-status")).toHaveAttribute("data-status", "SUBMITTED");
    expect(screen.getByTestId("proof-image")).toBeInTheDocument();
    expect(screen.queryByTestId("proof-approve-open")).not.toBeInTheDocument();
    expect(screen.queryByTestId("proof-reject-open")).not.toBeInTheDocument();
  });
});
```

创建 `web/admin/src/orders.test.tsx`：

```tsx
import { screen, waitFor } from "@testing-library/react";
import userEvent, { PointerEventsCheckLevel } from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { draftEvent, jsonResponse, photographerMe } from "./test/fixtures";
import { renderAdminApp } from "./test/renderAdminApp";
import { ORDER_NO, reviewerMe, orderDetail, orderSummary, supportMe } from "./test/reviewFixtures";

beforeEach(() => {
  window.localStorage.setItem("werun.lang", "en");
});

function setupFormUser() {
  return userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
}

describe("订单", () => {
  it("按关键字查询订单，点击行进入详情显示金额构成、识别分与凭证记录", async () => {
    const { requests, router } = renderAdminApp("/orders", {
      "GET /api/admin/me": () => jsonResponse(200, reviewerMe),
      "GET /api/admin/events": () => jsonResponse(200, { items: [draftEvent] }),
      "GET /api/admin/orders": () => jsonResponse(200, { items: [orderSummary], total: 1 }),
      "GET /api/admin/orders/501": () => jsonResponse(200, orderDetail),
    });

    await screen.findByTestId(`order-row-${ORDER_NO}`);
    const user = setupFormUser();
    await user.click(document.querySelector<HTMLElement>("#orderFilter_q")!);
    await user.paste("+85512");
    await user.click(screen.getByTestId("order-filter-submit"));

    await waitFor(() => {
      const last = requests.filter((request) => new URL(request.url).pathname === "/api/admin/orders").at(-1)!;
      const params = new URL(last.url).searchParams;
      expect(params.get("q")).toBe("+85512");
      expect(params.get("limit")).toBe("20");
      expect(params.get("offset")).toBe("0");
    });

    await user.click(await screen.findByTestId(`order-row-${ORDER_NO}`));

    await waitFor(() => expect(router.state.location.pathname).toBe("/orders/501"));
    expect(await screen.findByTestId("order-status")).toHaveAttribute("data-status", "PROOF_SUBMITTED");
    expect(screen.getByTestId("order-ident-offset")).toHaveTextContent("$0.49");
    expect(screen.getByTestId("order-amount")).toHaveTextContent("$24.51");
    expect(screen.getByText("PF8H2K4M6N")).toBeInTheDocument();
    expect(screen.getByText("+85512345678")).toBeInTheDocument();
  });

  it("SUPPORT 没有赛事权限：不请求赛事列表，仍能查看订单", async () => {
    const { requests } = renderAdminApp("/orders", {
      "GET /api/admin/me": () => jsonResponse(200, supportMe),
      "GET /api/admin/orders": () => jsonResponse(200, { items: [orderSummary], total: 1 }),
    });

    expect(await screen.findByTestId(`order-row-${ORDER_NO}`)).toBeInTheDocument();
    expect(requests.some((request) => new URL(request.url).pathname === "/api/admin/events")).toBe(false);
    expect(document.querySelector("#orderFilter_eventId")).toBeNull();
  });

  it("摄影师没有 order_view：显示 403 且菜单不显示订单", async () => {
    renderAdminApp("/orders", {
      "GET /api/admin/me": () => jsonResponse(200, photographerMe),
    });

    expect(await screen.findByTestId("forbidden-page")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Orders/ })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 5: 运行组件测试，确认失败**

Run: `pnpm --filter @werun/admin test -- src/review.test.tsx src/orders.test.tsx`
Expected: FAIL。路由表还没有 `/proofs`、`/orders`，页面被 `*` 重定向到 `/events`，报 `Unable to find an element by: [data-testid="proof-row-PF8H2K4M6N"]`、`[data-testid="order-row-WR7K3M9Q2A"]`，菜单断言找不到 `Payment review`。

- [ ] **Step 6: 补三语文案**

`packages/i18n/locales/zh/admin.json` 顶层追加 `proofs`、`orders` 两个对象：

```json
{
  "proofs": {
    "title": "凭证审核",
    "required": "必填",
    "status": { "SUBMITTED": "待审核", "APPROVED": "已通过", "REJECTED": "已驳回", "WITHDRAWN": "已撤回" },
    "col": {
      "proofNo": "凭证号",
      "orderNo": "订单号",
      "event": "赛事",
      "amount": "应付",
      "declared": "申报金额",
      "txnRef": "交易号",
      "waiting": "等待时长",
      "status": "状态"
    },
    "dupTag": "重复截图",
    "overSla": "已超时",
    "waitingMinutes": "{{minutes}} 分钟",
    "waitingHours": "{{hours}} 小时 {{minutes}} 分钟",
    "empty": "没有凭证",
    "detail": {
      "screenshot": "付款截图",
      "declared": "申报信息",
      "declaredAmount": "申报金额",
      "declaredPaidAt": "申报付款时间",
      "payerName": "付款人",
      "submittedAt": "提交时间",
      "reviewedAt": "审核时间",
      "rejectReason": "驳回说明",
      "notFound": "找不到这份凭证",
      "back": "返回队列",
      "current": "当前"
    },
    "approve": {
      "open": "通过",
      "title": "确认到账",
      "receivedUsd": "到账金额（美元）",
      "receivedAt": "到账时间",
      "note": "备注",
      "submit": "确认通过",
      "tooLow": "到账金额少于应付 {{amount}}，不能通过；请以「金额不符」驳回。",
      "overpaid": "多付 {{amount}}，通过后会登记一条多付异常。",
      "invalidAmount": "请输入正确的美元金额，最多两位小数",
      "success": "已通过，订单已确认"
    },
    "reject": {
      "open": "驳回",
      "title": "驳回凭证",
      "code": "驳回原因",
      "reason": "给跑者的说明",
      "reasonRequired": "选择「其他原因」时必须填写说明",
      "reasonTooLong": "说明不能超过 500 个字符",
      "submit": "确认驳回",
      "success": "已驳回，跑者可以重新上传"
    },
    "rejectCode": {
      "NOT_RECEIVED": "未收到款项",
      "AMOUNT_MISMATCH": "金额不符",
      "DUPLICATE_TXN": "交易号重复",
      "UNREADABLE": "截图看不清",
      "WRONG_ACCOUNT": "转错账户",
      "FRAUD": "疑似伪造",
      "OTHER": "其他原因"
    }
  },
  "orders": {
    "title": "订单",
    "filter": { "event": "赛事", "status": "状态", "q": "订单号、手机号或姓名", "submit": "查询", "reset": "重置" },
    "status": {
      "PENDING_PAYMENT": "待付款",
      "PROOF_SUBMITTED": "凭证审核中",
      "PROOF_REJECTED": "凭证被驳回",
      "PAID": "已付款",
      "PARTIALLY_REFUNDED": "部分退款",
      "REFUNDED": "已退款",
      "EXPIRED": "已过期",
      "CANCELLED": "已取消"
    },
    "col": {
      "orderNo": "订单号",
      "event": "赛事",
      "buyer": "买家",
      "participants": "人数",
      "amount": "应付",
      "status": "状态",
      "createdAt": "下单时间"
    },
    "empty": "没有符合条件的订单",
    "total": "共 {{total}} 单",
    "detail": {
      "title": "订单信息",
      "orderNo": "订单号",
      "event": "赛事",
      "buyer": "买家",
      "phone": "手机号",
      "createdAt": "下单时间",
      "deadlineAt": "当前截止时间",
      "paidAt": "付款时间",
      "paymentAccount": "收款账户",
      "amounts": "金额构成",
      "listAmount": "原价合计",
      "couponDiscount": "优惠码 {{code}}",
      "identOffset": "识别分",
      "discount": "优惠合计",
      "amount": "应付",
      "participants": "参赛人",
      "proofs": "凭证记录",
      "receipts": "到账记录",
      "notFound": "找不到这个订单",
      "back": "返回列表"
    },
    "participant": {
      "name": "姓名",
      "category": "组别",
      "regNo": "报名号",
      "listPrice": "原价",
      "paid": "分摊实付",
      "status": "报名状态"
    },
    "registrationStatus": { "PENDING": "待确认", "CONFIRMED": "已确认", "CANCELLED": "已取消" },
    "receipt": { "txnRef": "交易号", "amount": "到账金额", "receivedAt": "到账时间", "match": "匹配结果" },
    "matchStatus": { "APPLIED": "已入账", "EXCEPTION": "异常", "UNMATCHED": "未匹配" },
    "couponState": { "RESERVED": "已占用", "CONSUMED": "已核销", "RELEASED": "已释放" }
  }
}
```

`packages/i18n/locales/en/admin.json` 顶层追加：

```json
{
  "proofs": {
    "title": "Payment review",
    "required": "Required",
    "status": { "SUBMITTED": "Pending review", "APPROVED": "Approved", "REJECTED": "Rejected", "WITHDRAWN": "Withdrawn" },
    "col": {
      "proofNo": "Proof no.",
      "orderNo": "Order no.",
      "event": "Event",
      "amount": "Amount due",
      "declared": "Declared",
      "txnRef": "Transaction ref",
      "waiting": "Waiting",
      "status": "Status"
    },
    "dupTag": "Duplicate screenshot",
    "overSla": "Overdue",
    "waitingMinutes": "{{minutes}} min",
    "waitingHours": "{{hours}} h {{minutes}} min",
    "empty": "No proofs",
    "detail": {
      "screenshot": "Payment screenshot",
      "declared": "Declared by runner",
      "declaredAmount": "Declared amount",
      "declaredPaidAt": "Declared payment time",
      "payerName": "Payer",
      "submittedAt": "Submitted",
      "reviewedAt": "Reviewed",
      "rejectReason": "Rejection note",
      "notFound": "Proof not found",
      "back": "Back to queue",
      "current": "Current"
    },
    "approve": {
      "open": "Approve",
      "title": "Confirm payment received",
      "receivedUsd": "Received amount (USD)",
      "receivedAt": "Received at",
      "note": "Note",
      "submit": "Approve payment",
      "tooLow": "The received amount is below the amount due ({{amount}}). Reject it as an amount mismatch instead.",
      "overpaid": "Overpaid by {{amount}}. Approving records an overpayment exception.",
      "invalidAmount": "Enter a valid USD amount with at most two decimals",
      "success": "Approved — the order is confirmed"
    },
    "reject": {
      "open": "Reject",
      "title": "Reject proof",
      "code": "Reason",
      "reason": "Note to runner",
      "reasonRequired": "Explain the reason when choosing Other",
      "reasonTooLong": "Keep the note within 500 characters",
      "submit": "Reject proof",
      "success": "Rejected — the runner can upload again"
    },
    "rejectCode": {
      "NOT_RECEIVED": "Payment not received",
      "AMOUNT_MISMATCH": "Amount mismatch",
      "DUPLICATE_TXN": "Duplicate transaction",
      "UNREADABLE": "Unreadable screenshot",
      "WRONG_ACCOUNT": "Wrong account",
      "FRAUD": "Suspected fraud",
      "OTHER": "Other"
    }
  },
  "orders": {
    "title": "Orders",
    "filter": { "event": "Event", "status": "Status", "q": "Order no., phone or name", "submit": "Search", "reset": "Reset" },
    "status": {
      "PENDING_PAYMENT": "Awaiting payment",
      "PROOF_SUBMITTED": "Proof under review",
      "PROOF_REJECTED": "Proof rejected",
      "PAID": "Paid",
      "PARTIALLY_REFUNDED": "Partially refunded",
      "REFUNDED": "Refunded",
      "EXPIRED": "Expired",
      "CANCELLED": "Cancelled"
    },
    "col": {
      "orderNo": "Order no.",
      "event": "Event",
      "buyer": "Buyer",
      "participants": "Runners",
      "amount": "Amount due",
      "status": "Status",
      "createdAt": "Created"
    },
    "empty": "No matching orders",
    "total": "{{total}} orders",
    "detail": {
      "title": "Order",
      "orderNo": "Order no.",
      "event": "Event",
      "buyer": "Buyer",
      "phone": "Phone",
      "createdAt": "Created",
      "deadlineAt": "Current deadline",
      "paidAt": "Paid at",
      "paymentAccount": "Payment account",
      "amounts": "Amount breakdown",
      "listAmount": "List total",
      "couponDiscount": "Coupon {{code}}",
      "identOffset": "Identification cents",
      "discount": "Total discount",
      "amount": "Amount due",
      "participants": "Participants",
      "proofs": "Proof history",
      "receipts": "Receipts",
      "notFound": "Order not found",
      "back": "Back to orders"
    },
    "participant": {
      "name": "Name",
      "category": "Category",
      "regNo": "Registration no.",
      "listPrice": "List price",
      "paid": "Paid share",
      "status": "Status"
    },
    "registrationStatus": { "PENDING": "Pending", "CONFIRMED": "Confirmed", "CANCELLED": "Cancelled" },
    "receipt": { "txnRef": "Transaction ref", "amount": "Amount", "receivedAt": "Received at", "match": "Match" },
    "matchStatus": { "APPLIED": "Applied", "EXCEPTION": "Exception", "UNMATCHED": "Unmatched" },
    "couponState": { "RESERVED": "Reserved", "CONSUMED": "Used", "RELEASED": "Released" }
  }
}
```

`packages/i18n/locales/km/admin.json` 顶层追加：

```json
{
  "proofs": {
    "title": "ពិនិត្យភស្តុតាងបង់ប្រាក់",
    "required": "ត្រូវបំពេញ",
    "status": { "SUBMITTED": "រង់ចាំពិនិត្យ", "APPROVED": "បានអនុម័ត", "REJECTED": "បានបដិសេធ", "WITHDRAWN": "បានដកវិញ" },
    "col": {
      "proofNo": "លេខភស្តុតាង",
      "orderNo": "លេខបញ្ជាទិញ",
      "event": "ព្រឹត្តិការណ៍",
      "amount": "ត្រូវបង់",
      "declared": "ចំនួនបានប្រកាស",
      "txnRef": "លេខប្រតិបត្តិការ",
      "waiting": "រយៈពេលរង់ចាំ",
      "status": "ស្ថានភាព"
    },
    "dupTag": "រូបថតស្ទួន",
    "overSla": "ហួសពេល",
    "waitingMinutes": "{{minutes}} នាទី",
    "waitingHours": "{{hours}} ម៉ោង {{minutes}} នាទី",
    "empty": "មិនមានភស្តុតាងទេ",
    "detail": {
      "screenshot": "រូបថតអេក្រង់ការបង់ប្រាក់",
      "declared": "ព័ត៌មានដែលអ្នករត់បានប្រកាស",
      "declaredAmount": "ចំនួនបានប្រកាស",
      "declaredPaidAt": "ពេលបង់ប្រាក់បានប្រកាស",
      "payerName": "អ្នកបង់ប្រាក់",
      "submittedAt": "ពេលដាក់ស្នើ",
      "reviewedAt": "ពេលពិនិត្យ",
      "rejectReason": "កំណត់ចំណាំបដិសេធ",
      "notFound": "រកមិនឃើញភស្តុតាងនេះទេ",
      "back": "ត្រឡប់ទៅបញ្ជីរង់ចាំ",
      "current": "បច្ចុប្បន្ន"
    },
    "approve": {
      "open": "អនុម័ត",
      "title": "បញ្ជាក់ការទទួលប្រាក់",
      "receivedUsd": "ចំនួនទឹកប្រាក់បានទទួល (ដុល្លារ)",
      "receivedAt": "ពេលទទួលប្រាក់",
      "note": "កំណត់ចំណាំ",
      "submit": "អនុម័តការបង់ប្រាក់",
      "tooLow": "ចំនួនទឹកប្រាក់បានទទួលតិចជាងចំនួនត្រូវបង់ ({{amount}})។ សូមបដិសេធដោយហេតុផល «ចំនួនទឹកប្រាក់មិនត្រូវគ្នា»។",
      "overpaid": "បង់លើស {{amount}}។ ការអនុម័តនឹងកត់ត្រាករណីលើកលែងការបង់លើស។",
      "invalidAmount": "សូមបញ្ចូលចំនួនដុល្លារឱ្យត្រឹមត្រូវ មិនលើសពីរខ្ទង់ទសភាគ",
      "success": "បានអនុម័ត — ការបញ្ជាទិញត្រូវបានបញ្ជាក់"
    },
    "reject": {
      "open": "បដិសេធ",
      "title": "បដិសេធភស្តុតាង",
      "code": "មូលហេតុ",
      "reason": "កំណត់ចំណាំទៅអ្នករត់",
      "reasonRequired": "សូមពន្យល់មូលហេតុ នៅពេលជ្រើសរើស «ផ្សេងទៀត»",
      "reasonTooLong": "កំណត់ចំណាំមិនអាចលើស 500 តួអក្សរ",
      "submit": "បដិសេធភស្តុតាង",
      "success": "បានបដិសេធ — អ្នករត់អាចផ្ញើម្ដងទៀត"
    },
    "rejectCode": {
      "NOT_RECEIVED": "មិនទាន់ទទួលបានប្រាក់",
      "AMOUNT_MISMATCH": "ចំនួនទឹកប្រាក់មិនត្រូវគ្នា",
      "DUPLICATE_TXN": "ប្រតិបត្តិការស្ទួន",
      "UNREADABLE": "រូបថតមើលមិនច្បាស់",
      "WRONG_ACCOUNT": "គណនីខុស",
      "FRAUD": "សង្ស័យក្លែងបន្លំ",
      "OTHER": "ផ្សេងទៀត"
    }
  },
  "orders": {
    "title": "ការបញ្ជាទិញ",
    "filter": { "event": "ព្រឹត្តិការណ៍", "status": "ស្ថានភាព", "q": "លេខបញ្ជាទិញ លេខទូរស័ព្ទ ឬឈ្មោះ", "submit": "ស្វែងរក", "reset": "កំណត់ឡើងវិញ" },
    "status": {
      "PENDING_PAYMENT": "រង់ចាំការបង់ប្រាក់",
      "PROOF_SUBMITTED": "កំពុងពិនិត្យភស្តុតាង",
      "PROOF_REJECTED": "ភស្តុតាងត្រូវបានបដិសេធ",
      "PAID": "បានបង់ប្រាក់",
      "PARTIALLY_REFUNDED": "បានសងប្រាក់វិញមួយផ្នែក",
      "REFUNDED": "បានសងប្រាក់វិញ",
      "EXPIRED": "ផុតសុពលភាព",
      "CANCELLED": "បានលុបចោល"
    },
    "col": {
      "orderNo": "លេខបញ្ជាទិញ",
      "event": "ព្រឹត្តិការណ៍",
      "buyer": "អ្នកទិញ",
      "participants": "ចំនួនអ្នករត់",
      "amount": "ត្រូវបង់",
      "status": "ស្ថានភាព",
      "createdAt": "ពេលបង្កើត"
    },
    "empty": "មិនមានការបញ្ជាទិញត្រូវគ្នាទេ",
    "total": "សរុប {{total}} ការបញ្ជាទិញ",
    "detail": {
      "title": "ការបញ្ជាទិញ",
      "orderNo": "លេខបញ្ជាទិញ",
      "event": "ព្រឹត្តិការណ៍",
      "buyer": "អ្នកទិញ",
      "phone": "លេខទូរស័ព្ទ",
      "createdAt": "ពេលបង្កើត",
      "deadlineAt": "ពេលកំណត់បច្ចុប្បន្ន",
      "paidAt": "ពេលបង់ប្រាក់",
      "paymentAccount": "គណនីទទួលប្រាក់",
      "amounts": "ការបែងចែកចំនួនទឹកប្រាក់",
      "listAmount": "តម្លៃដើមសរុប",
      "couponDiscount": "កូដបញ្ចុះតម្លៃ {{code}}",
      "identOffset": "សេនសម្គាល់",
      "discount": "បញ្ចុះតម្លៃសរុប",
      "amount": "ត្រូវបង់",
      "participants": "អ្នកចូលរួម",
      "proofs": "ប្រវត្តិភស្តុតាង",
      "receipts": "កំណត់ត្រាទទួលប្រាក់",
      "notFound": "រកមិនឃើញការបញ្ជាទិញនេះទេ",
      "back": "ត្រឡប់ទៅបញ្ជី"
    },
    "participant": {
      "name": "ឈ្មោះ",
      "category": "ប្រភេទ",
      "regNo": "លេខចុះឈ្មោះ",
      "listPrice": "តម្លៃដើម",
      "paid": "ចំណែកបានបង់",
      "status": "ស្ថានភាព"
    },
    "registrationStatus": { "PENDING": "កំពុងរង់ចាំ", "CONFIRMED": "បានបញ្ជាក់", "CANCELLED": "បានលុបចោល" },
    "receipt": { "txnRef": "លេខប្រតិបត្តិការ", "amount": "ចំនួនទឹកប្រាក់", "receivedAt": "ពេលទទួល", "match": "លទ្ធផលផ្គូផ្គង" },
    "matchStatus": { "APPLIED": "បានកត់ត្រា", "EXCEPTION": "ករណីលើកលែង", "UNMATCHED": "មិនទាន់ផ្គូផ្គង" },
    "couponState": { "RESERVED": "បានកក់", "CONSUMED": "បានប្រើ", "RELEASED": "បានដោះលែង" }
  }
}
```

Run: `pnpm i18n:check`
Expected: `i18n 检查通过：3 个命名空间，三种语言 key 一致`。

- [ ] **Step 7: 实现查询与共用组件**

创建 `web/admin/src/orders/queries.ts`：

```ts
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@werun/api-client";
import { useApi } from "../api";

export type AdminOrderStatus = Schemas["AdminOrderSummary"]["status"];

export const ORDER_STATUSES: readonly AdminOrderStatus[] = [
  "PENDING_PAYMENT",
  "PROOF_SUBMITTED",
  "PROOF_REJECTED",
  "PAID",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
  "EXPIRED",
  "CANCELLED",
];

export const ORDER_PAGE_SIZE = 20;
export const ADMIN_ORDERS_KEY = ["admin", "orders"] as const;

export interface AdminOrderFilter {
  eventId?: number;
  status?: AdminOrderStatus;
  q?: string;
  page: number;
}

export function useAdminOrders(filter: AdminOrderFilter) {
  const api = useApi();
  return useQuery({
    queryKey: [...ADMIN_ORDERS_KEY, "list", filter],
    queryFn: async () =>
      unwrap(
        await api.GET("/admin/orders", {
          params: {
            query: {
              eventId: filter.eventId,
              status: filter.status,
              q: filter.q,
              limit: ORDER_PAGE_SIZE,
              offset: (filter.page - 1) * ORDER_PAGE_SIZE,
            },
          },
        }),
      ),
    placeholderData: keepPreviousData,
  });
}

export function useAdminOrder(id: number) {
  const api = useApi();
  return useQuery({
    queryKey: [...ADMIN_ORDERS_KEY, "detail", id],
    queryFn: async () => unwrap(await api.GET("/admin/orders/{id}", { params: { path: { id } } })),
    enabled: Number.isInteger(id) && id > 0,
  });
}

/** 订单筛选用的赛事下拉；没有 event_config 读权限时不请求 */
export function useEventOptions(enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ["admin", "events", "options"],
    queryFn: async () => unwrap(await api.GET("/admin/events")).items,
    enabled,
  });
}
```

创建 `web/admin/src/proofs/queries.ts`：

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@werun/api-client";
import { useApi } from "../api";
import { ADMIN_ORDERS_KEY } from "../orders/queries";

export const PROOF_FILTER_STATUSES = ["SUBMITTED", "APPROVED", "REJECTED"] as const;
export type ProofFilterStatus = (typeof PROOF_FILTER_STATUSES)[number];

export const PROOFS_KEY = ["admin", "proofs"] as const;

export function adminFileUrl(fileId: number): string {
  return `/api/admin/files/${fileId}`;
}

export function useProofQueue(status: ProofFilterStatus) {
  const api = useApi();
  return useQuery({
    queryKey: [...PROOFS_KEY, "queue", status],
    queryFn: async () => unwrap(await api.GET("/admin/proofs", { params: { query: { status } } })).items,
  });
}

export function useProof(id: number) {
  const api = useApi();
  return useQuery({
    queryKey: [...PROOFS_KEY, "detail", id],
    queryFn: async () => unwrap(await api.GET("/admin/proofs/{id}", { params: { path: { id } } })),
    enabled: Number.isInteger(id) && id > 0,
  });
}

function useAfterReview(id: number) {
  const queryClient = useQueryClient();
  return (detail: Schemas["ProofDetail"]) => {
    queryClient.setQueryData([...PROOFS_KEY, "detail", id], detail);
    void queryClient.invalidateQueries({ queryKey: PROOFS_KEY });
    void queryClient.invalidateQueries({ queryKey: ADMIN_ORDERS_KEY });
  };
}

export function useApproveProof(id: number) {
  const api = useApi();
  const afterReview = useAfterReview(id);
  return useMutation({
    mutationFn: async (body: Schemas["ApproveProofRequest"]) =>
      unwrap(await api.POST("/admin/proofs/{id}/approve", { params: { path: { id } }, body })),
    onSuccess: afterReview,
  });
}

export function useRejectProof(id: number) {
  const api = useApi();
  const afterReview = useAfterReview(id);
  return useMutation({
    mutationFn: async (body: Schemas["RejectProofRequest"]) =>
      unwrap(await api.POST("/admin/proofs/{id}/reject", { params: { path: { id } }, body })),
    onSuccess: afterReview,
  });
}
```

创建 `web/admin/src/proofs/ProofStatusTag.tsx`：

```tsx
import type { Schemas } from "@werun/api-client";
import { Tag } from "antd";
import { useTranslation } from "react-i18next";

type ProofStatus = Schemas["Proof"]["status"];

const COLORS: Record<ProofStatus, string> = {
  SUBMITTED: "gold",
  APPROVED: "green",
  REJECTED: "red",
  WITHDRAWN: "default",
};

export function ProofStatusTag({ status, testId }: { status: ProofStatus; testId?: string }) {
  const { t } = useTranslation("admin");
  return (
    <Tag color={COLORS[status]} data-testid={testId} data-status={status}>
      {t(`proofs.status.${status}`)}
    </Tag>
  );
}
```

创建 `web/admin/src/orders/OrderStatusTag.tsx`：

```tsx
import { Tag } from "antd";
import { useTranslation } from "react-i18next";
import type { AdminOrderStatus } from "./queries";

const COLORS: Record<AdminOrderStatus, string> = {
  PENDING_PAYMENT: "gold",
  PROOF_SUBMITTED: "blue",
  PROOF_REJECTED: "red",
  PAID: "green",
  PARTIALLY_REFUNDED: "purple",
  REFUNDED: "purple",
  EXPIRED: "default",
  CANCELLED: "default",
};

export function OrderStatusTag({ status, testId }: { status: AdminOrderStatus; testId?: string }) {
  const { t } = useTranslation("admin");
  return (
    <Tag color={COLORS[status]} data-testid={testId} data-status={status}>
      {t(`orders.status.${status}`)}
    </Tag>
  );
}
```

创建 `web/admin/src/orders/OrderSections.tsx`：

```tsx
import { formatUsd, type Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { Card, Descriptions, Table, Tag, Typography, type DescriptionsProps, type TableProps } from "antd";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { PERM_PROOF_REVIEW, can } from "../auth/can";
import { useMe } from "../auth/useMe";
import { pickText } from "../events/localize";
import { ProofStatusTag } from "../proofs/ProofStatusTag";
import { formatDateTime } from "./format";

type OrderDetail = Schemas["AdminOrderDetail"];
type Participant = OrderDetail["participants"][number];
type ProofItem = OrderDetail["proofs"][number];
type Receipt = OrderDetail["receipts"][number];

const REGISTRATION_COLORS: Record<Participant["registrationStatus"], string> = {
  PENDING: "gold",
  CONFIRMED: "green",
  CANCELLED: "default",
};

const MATCH_COLORS: Record<Receipt["matchStatus"], string> = {
  APPLIED: "green",
  EXCEPTION: "orange",
  UNMATCHED: "default",
};

export function OrderOverviewCard({ order }: { order: OrderDetail }) {
  const { t } = useTranslation("admin");
  const lang = useLang();
  const items: DescriptionsProps["items"] = [
    { key: "orderNo", label: t("orders.detail.orderNo"), children: <Typography.Text copyable>{order.orderNo}</Typography.Text> },
    { key: "event", label: t("orders.detail.event"), children: pickText(order.eventName, lang) },
    { key: "buyer", label: t("orders.detail.buyer"), children: order.buyerName },
    { key: "phone", label: t("orders.detail.phone"), children: order.buyerPhone },
    { key: "createdAt", label: t("orders.detail.createdAt"), children: formatDateTime(order.createdAt) },
    { key: "deadlineAt", label: t("orders.detail.deadlineAt"), children: formatDateTime(order.deadlineAt) },
    { key: "paidAt", label: t("orders.detail.paidAt"), children: formatDateTime(order.paidAt) },
    {
      key: "paymentAccount",
      label: t("orders.detail.paymentAccount"),
      children: `${order.paymentAccount.name} · ${order.paymentAccount.accountNoMasked}`,
    },
  ];
  return (
    <Card title={t("orders.detail.title")}>
      <Descriptions column={{ xs: 1, md: 2 }} items={items} />
    </Card>
  );
}

export function OrderAmountsCard({ order }: { order: OrderDetail }) {
  const { t } = useTranslation("admin");
  const items: DescriptionsProps["items"] = [
    { key: "listAmount", label: t("orders.detail.listAmount"), children: formatUsd(order.listAmountCents) },
  ];
  if (order.coupon) {
    items.push({
      key: "coupon",
      label: t("orders.detail.couponDiscount", { code: order.coupon.code }),
      children: (
        <span>
          {formatUsd(-order.coupon.discountCents)} <Tag>{t(`orders.couponState.${order.coupon.state}`)}</Tag>
        </span>
      ),
    });
  }
  items.push(
    {
      key: "identOffset",
      label: t("orders.detail.identOffset"),
      children: <span data-testid="order-ident-offset">{formatUsd(order.identOffsetCents)}</span>,
    },
    { key: "discount", label: t("orders.detail.discount"), children: formatUsd(-order.discountCents) },
    {
      key: "amount",
      label: t("orders.detail.amount"),
      children: (
        <span data-testid="order-amount">
          <Typography.Text strong>{formatUsd(order.amountCents)}</Typography.Text>
        </span>
      ),
    },
  );
  return (
    <Card title={t("orders.detail.amounts")}>
      <Descriptions column={1} items={items} />
    </Card>
  );
}

export function OrderParticipantsCard({ order }: { order: OrderDetail }) {
  const { t } = useTranslation("admin");
  const lang = useLang();
  const columns: TableProps<Participant>["columns"] = [
    { title: t("orders.participant.name"), dataIndex: "fullName", key: "fullName" },
    { title: t("orders.participant.category"), key: "category", render: (_, p) => pickText(p.categoryName, lang) },
    { title: t("orders.participant.regNo"), dataIndex: "regNo", key: "regNo" },
    { title: t("orders.participant.listPrice"), key: "listPrice", align: "right", render: (_, p) => formatUsd(p.listPriceCents) },
    { title: t("orders.participant.paid"), key: "paid", align: "right", render: (_, p) => formatUsd(p.paidCents) },
    {
      title: t("orders.participant.status"),
      key: "status",
      render: (_, p) => (
        <Tag color={REGISTRATION_COLORS[p.registrationStatus]}>{t(`orders.registrationStatus.${p.registrationStatus}`)}</Tag>
      ),
    },
  ];
  return (
    <Card title={t("orders.detail.participants")}>
      <Table<Participant>
        rowKey="registrationId"
        size="small"
        columns={columns}
        dataSource={order.participants}
        pagination={false}
        scroll={{ x: 640 }}
      />
    </Card>
  );
}

export function OrderProofsCard({ order, currentProofId }: { order: OrderDetail; currentProofId?: number }) {
  const { t } = useTranslation("admin");
  const { data: me } = useMe();
  const canOpenProof = can(me?.permissions, PERM_PROOF_REVIEW, "read");
  const columns: TableProps<ProofItem>["columns"] = [
    {
      title: t("proofs.col.proofNo"),
      key: "proofNo",
      render: (_, p) => (
        <span>
          {canOpenProof && p.id !== currentProofId ? <Link to={`/proofs/${p.id}`}>{p.proofNo}</Link> : p.proofNo}
          {p.id === currentProofId ? <Tag style={{ marginInlineStart: 8 }}>{t("proofs.detail.current")}</Tag> : null}
        </span>
      ),
    },
    { title: t("proofs.col.status"), key: "status", render: (_, p) => <ProofStatusTag status={p.status} /> },
    { title: t("proofs.col.txnRef"), dataIndex: "bankTxnRef", key: "bankTxnRef" },
    { title: t("proofs.col.declared"), key: "declared", align: "right", render: (_, p) => formatUsd(p.declaredAmountCents) },
    {
      title: t("proofs.reject.code"),
      key: "rejectCode",
      render: (_, p) => (p.rejectCode ? t(`proofs.rejectCode.${p.rejectCode}`) : "—"),
    },
    { title: t("proofs.detail.submittedAt"), key: "createdAt", render: (_, p) => formatDateTime(p.createdAt) },
    { title: t("proofs.detail.reviewedAt"), key: "reviewedAt", render: (_, p) => formatDateTime(p.reviewedAt) },
  ];
  return (
    <Card title={t("orders.detail.proofs")}>
      <Table<ProofItem>
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={order.proofs}
        pagination={false}
        scroll={{ x: 760 }}
        locale={{ emptyText: t("proofs.empty") }}
      />
    </Card>
  );
}

export function OrderReceiptsCard({ order }: { order: OrderDetail }) {
  const { t } = useTranslation("admin");
  const columns: TableProps<Receipt>["columns"] = [
    { title: t("orders.receipt.txnRef"), dataIndex: "txnRef", key: "txnRef" },
    { title: t("orders.receipt.amount"), key: "amount", align: "right", render: (_, r) => formatUsd(r.amountCents) },
    { title: t("orders.receipt.receivedAt"), key: "receivedAt", render: (_, r) => formatDateTime(r.receivedAt) },
    {
      title: t("orders.receipt.match"),
      key: "match",
      render: (_, r) => <Tag color={MATCH_COLORS[r.matchStatus]}>{t(`orders.matchStatus.${r.matchStatus}`)}</Tag>,
    },
  ];
  return (
    <Card title={t("orders.detail.receipts")}>
      <Table<Receipt> rowKey="id" size="small" columns={columns} dataSource={order.receipts} pagination={false} scroll={{ x: 560 }} />
    </Card>
  );
}
```

创建 `web/admin/src/proofs/ApproveProofModal.tsx`：

```tsx
import { ApiError, formatUsd, parseUsdToCents, type Schemas } from "@werun/api-client";
import { Alert, App as AntdApp, Button, DatePicker, Form, Input, Modal, Space } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useTranslation } from "react-i18next";
import { centsToUsdInput } from "../orders/format";
import { useApproveProof } from "./queries";

interface ApproveValues {
  receivedUsd: string;
  receivedAt: Dayjs;
  note?: string;
}

/** 服务端字段名 → 表单字段 */
const SERVER_FIELDS: [string, keyof ApproveValues][] = [
  ["receivedAmountCents", "receivedUsd"],
  ["receivedAt", "receivedAt"],
  ["note", "note"],
];

interface ApproveProofModalProps {
  proof: Schemas["Proof"];
  amountCents: number;
  onClose: () => void;
}

export function ApproveProofModal({ proof, amountCents, onClose }: ApproveProofModalProps) {
  const { t } = useTranslation("admin");
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<ApproveValues>();
  const approve = useApproveProof(proof.id);

  const receivedUsd = Form.useWatch("receivedUsd", form);
  const cents = parseUsdToCents((receivedUsd ?? "").trim());
  const tooLow = cents !== null && cents < amountCents;
  const overpaid = cents !== null && cents > amountCents ? cents - amountCents : 0;

  const onFinish = (values: ApproveValues) => {
    const received = parseUsdToCents(values.receivedUsd.trim());
    if (received === null || received < amountCents) {
      return;
    }
    const note = values.note?.trim();
    approve.mutate(
      { receivedAmountCents: received, receivedAt: values.receivedAt.toISOString(), note: note ? note : null },
      {
        onSuccess: () => {
          void message.success(t("proofs.approve.success"));
          onClose();
        },
        onError: (error) => {
          if (error instanceof ApiError) {
            const fields = SERVER_FIELDS.flatMap(([server, local]) => {
              const text = error.fields[server];
              return text ? [{ name: local, errors: [text] }] : [];
            });
            if (fields.length > 0) {
              form.setFields(fields);
              return;
            }
          }
          void message.error(error.message);
        },
      },
    );
  };

  return (
    <Modal open title={t("proofs.approve.title")} onCancel={onClose} footer={null} maskClosable={false}>
      <Form<ApproveValues>
        form={form}
        name="approve"
        layout="vertical"
        onFinish={onFinish}
        disabled={approve.isPending}
        initialValues={{
          receivedUsd: centsToUsdInput(proof.declaredAmountCents),
          receivedAt: proof.declaredPaidAt ? dayjs(proof.declaredPaidAt) : dayjs(),
        }}
      >
        <Form.Item
          name="receivedUsd"
          label={t("proofs.approve.receivedUsd")}
          extra={t("orders.detail.amount") + " " + formatUsd(amountCents)}
          rules={[
            { required: true, message: t("proofs.required") },
            {
              validator: (_, value: string | undefined) =>
                parseUsdToCents((value ?? "").trim()) === null
                  ? Promise.reject(new Error(t("proofs.approve.invalidAmount")))
                  : Promise.resolve(),
            },
          ]}
        >
          <Input prefix="$" inputMode="decimal" autoComplete="off" />
        </Form.Item>
        {tooLow ? (
          <Alert
            data-testid="proof-approve-too-low"
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
            message={t("proofs.approve.tooLow", { amount: formatUsd(amountCents) })}
          />
        ) : null}
        {overpaid > 0 ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message={t("proofs.approve.overpaid", { amount: formatUsd(overpaid) })}
          />
        ) : null}
        <Form.Item name="receivedAt" label={t("proofs.approve.receivedAt")} rules={[{ required: true, message: t("proofs.required") }]}>
          <DatePicker showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="note" label={t("proofs.approve.note")}>
          <Input.TextArea rows={2} maxLength={500} />
        </Form.Item>
        <Space style={{ width: "100%", justifyContent: "flex-end" }}>
          <Button onClick={onClose}>{t("common:action.back")}</Button>
          <Button
            type="primary"
            htmlType="submit"
            data-testid="proof-approve-submit"
            disabled={cents === null || tooLow}
            loading={approve.isPending}
          >
            {t("proofs.approve.submit")}
          </Button>
        </Space>
      </Form>
    </Modal>
  );
}
```

创建 `web/admin/src/proofs/RejectProofModal.tsx`：

```tsx
import { ApiError, type Schemas } from "@werun/api-client";
import { App as AntdApp, Button, Form, Input, Modal, Select, Space } from "antd";
import { useTranslation } from "react-i18next";
import { useRejectProof } from "./queries";

type RejectCode = Schemas["RejectProofRequest"]["rejectCode"];

const REJECT_CODES: readonly RejectCode[] = [
  "NOT_RECEIVED",
  "AMOUNT_MISMATCH",
  "DUPLICATE_TXN",
  "UNREADABLE",
  "WRONG_ACCOUNT",
  "FRAUD",
  "OTHER",
];

interface RejectValues {
  rejectCode: RejectCode;
  rejectReason?: string;
}

export function RejectProofModal({ proofId, onClose }: { proofId: number; onClose: () => void }) {
  const { t } = useTranslation("admin");
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<RejectValues>();
  const reject = useRejectProof(proofId);

  const onFinish = (values: RejectValues) => {
    const reason = values.rejectReason?.trim();
    reject.mutate(
      { rejectCode: values.rejectCode, rejectReason: reason ? reason : null },
      {
        onSuccess: () => {
          void message.success(t("proofs.reject.success"));
          onClose();
        },
        onError: (error) => {
          if (error instanceof ApiError) {
            const fields = (["rejectCode", "rejectReason"] as const).flatMap((name) => {
              const text = error.fields[name];
              return text ? [{ name, errors: [text] }] : [];
            });
            if (fields.length > 0) {
              form.setFields(fields);
              return;
            }
          }
          void message.error(error.message);
        },
      },
    );
  };

  return (
    <Modal open title={t("proofs.reject.title")} onCancel={onClose} footer={null} maskClosable={false}>
      <Form<RejectValues> form={form} name="reject" layout="vertical" onFinish={onFinish} disabled={reject.isPending}>
        <Form.Item name="rejectCode" label={t("proofs.reject.code")} rules={[{ required: true, message: t("proofs.required") }]}>
          <Select options={REJECT_CODES.map((code) => ({ value: code, label: t(`proofs.rejectCode.${code}`) }))} />
        </Form.Item>
        <Form.Item
          name="rejectReason"
          label={t("proofs.reject.reason")}
          dependencies={["rejectCode"]}
          rules={[
            ({ getFieldValue }) => ({
              validator: (_, value: string | undefined) =>
                getFieldValue("rejectCode") === "OTHER" && !(value ?? "").trim()
                  ? Promise.reject(new Error(t("proofs.reject.reasonRequired")))
                  : Promise.resolve(),
            }),
            { max: 500, message: t("proofs.reject.reasonTooLong") },
          ]}
        >
          <Input.TextArea rows={3} maxLength={500} showCount />
        </Form.Item>
        <Space style={{ width: "100%", justifyContent: "flex-end" }}>
          <Button onClick={onClose}>{t("common:action.back")}</Button>
          <Button type="primary" danger htmlType="submit" data-testid="proof-reject-submit" loading={reject.isPending}>
            {t("proofs.reject.submit")}
          </Button>
        </Space>
      </Form>
    </Modal>
  );
}
```

- [ ] **Step 8: 实现四个页面、路由与菜单**

创建 `web/admin/src/pages/ProofsPage.tsx`：

```tsx
import { formatUsd, type Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { Alert, Button, Segmented, Space, Table, Tag, Typography, type TableProps } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { pickText } from "../events/localize";
import { formatDateTime, rowProps, waitingParts } from "../orders/format";
import { ProofStatusTag } from "../proofs/ProofStatusTag";
import { PROOF_FILTER_STATUSES, useProofQueue, type ProofFilterStatus } from "../proofs/queries";

type QueueItem = Schemas["ProofQueueItem"];

export function ProofsPage() {
  const { t } = useTranslation("admin");
  const lang = useLang();
  const navigate = useNavigate();
  const [status, setStatus] = useState<ProofFilterStatus>("SUBMITTED");
  const queue = useProofQueue(status);
  const now = Date.now();

  const waitingText = (item: QueueItem) => {
    if (item.proof.status !== "SUBMITTED") {
      return formatDateTime(item.proof.createdAt);
    }
    const { hours, minutes } = waitingParts(item.waitingSince, now);
    return hours > 0 ? t("proofs.waitingHours", { hours, minutes }) : t("proofs.waitingMinutes", { minutes });
  };

  const columns: TableProps<QueueItem>["columns"] = [
    {
      title: t("proofs.col.proofNo"),
      key: "proofNo",
      render: (_, item) => <Typography.Text strong>{item.proof.proofNo}</Typography.Text>,
    },
    { title: t("proofs.col.orderNo"), key: "orderNo", render: (_, item) => item.proof.orderNo },
    { title: t("proofs.col.event"), key: "event", render: (_, item) => pickText(item.eventName, lang) },
    { title: t("proofs.col.amount"), key: "amount", align: "right", render: (_, item) => formatUsd(item.amountCents) },
    {
      title: t("proofs.col.declared"),
      key: "declared",
      align: "right",
      render: (_, item) => (
        <Typography.Text type={item.proof.declaredAmountCents < item.amountCents ? "danger" : undefined}>
          {formatUsd(item.proof.declaredAmountCents)}
        </Typography.Text>
      ),
    },
    {
      title: t("proofs.col.txnRef"),
      key: "txnRef",
      render: (_, item) => (
        <Space size={4} wrap>
          <Typography.Text code>{item.proof.bankTxnRef}</Typography.Text>
          {item.proof.dupFileHit ? <Tag color="orange">{t("proofs.dupTag")}</Tag> : null}
        </Space>
      ),
    },
    {
      title: t("proofs.col.waiting"),
      key: "waiting",
      render: (_, item) => (
        <Space size={4} wrap>
          <span>{waitingText(item)}</span>
          {item.overSla ? <Tag color="red">{t("proofs.overSla")}</Tag> : null}
        </Space>
      ),
    },
    { title: t("proofs.col.status"), key: "status", render: (_, item) => <ProofStatusTag status={item.proof.status} /> },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space style={{ width: "100%", justifyContent: "space-between" }} wrap>
        <Typography.Title level={3} style={{ margin: 0 }}>
          {t("proofs.title")}
        </Typography.Title>
        <Segmented<ProofFilterStatus>
          value={status}
          onChange={setStatus}
          options={PROOF_FILTER_STATUSES.map((value) => ({ value, label: t(`proofs.status.${value}`) }))}
        />
      </Space>
      {queue.isError ? (
        <Alert
          type="error"
          showIcon
          message={t("common:state.error")}
          action={
            <Button size="small" onClick={() => void queue.refetch()}>
              {t("common:action.retry")}
            </Button>
          }
        />
      ) : null}
      <Table<QueueItem>
        rowKey={(item) => item.proof.id}
        columns={columns}
        dataSource={queue.data ?? []}
        loading={queue.isPending}
        pagination={false}
        locale={{ emptyText: t("proofs.empty") }}
        scroll={{ x: 1000 }}
        onRow={(item) =>
          rowProps(
            `proof-row-${item.proof.proofNo}`,
            {
              onClick: () => void navigate(`/proofs/${item.proof.id}`),
              style: { cursor: "pointer", background: item.overSla ? "var(--stop-tint)" : undefined },
            },
            { "data-over-sla": String(item.overSla) },
          )
        }
      />
    </Space>
  );
}
```

创建 `web/admin/src/pages/ProofDetailPage.tsx`：

```tsx
import { ApiError, formatUsd } from "@werun/api-client";
import { Alert, Button, Card, Col, Descriptions, Image, Row, Space, Tag, Typography, type DescriptionsProps } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { PERM_PROOF_REVIEW, can } from "../auth/can";
import { useMe } from "../auth/useMe";
import { formatDateTime } from "../orders/format";
import { OrderOverviewCard, OrderParticipantsCard, OrderProofsCard } from "../orders/OrderSections";
import { OrderStatusTag } from "../orders/OrderStatusTag";
import { ApproveProofModal } from "../proofs/ApproveProofModal";
import { ProofStatusTag } from "../proofs/ProofStatusTag";
import { RejectProofModal } from "../proofs/RejectProofModal";
import { adminFileUrl, useProof } from "../proofs/queries";

export function ProofDetailPage() {
  const { id = "" } = useParams();
  const proofId = Number(id);
  const { t } = useTranslation("admin");
  const navigate = useNavigate();
  const { data: me } = useMe();
  const detail = useProof(proofId);
  const [dialog, setDialog] = useState<"approve" | "reject" | null>(null);
  const canReview = can(me?.permissions, PERM_PROOF_REVIEW, "write");

  const backButton = <Button onClick={() => void navigate("/proofs")}>{t("proofs.detail.back")}</Button>;

  if (!Number.isInteger(proofId) || proofId <= 0 || (detail.error instanceof ApiError && detail.error.status === 404)) {
    return <Alert type="warning" showIcon message={t("proofs.detail.notFound")} action={backButton} />;
  }
  if (detail.isError) {
    return <Alert type="error" showIcon message={detail.error.message} action={backButton} />;
  }
  if (detail.isPending) {
    return <Card loading />;
  }

  const { proof, order } = detail.data;
  const reviewable = canReview && proof.status === "SUBMITTED" && order.status === "PROOF_SUBMITTED";

  const declaredItems: DescriptionsProps["items"] = [
    {
      key: "declaredAmount",
      label: t("proofs.detail.declaredAmount"),
      children: (
        <Typography.Text strong type={proof.declaredAmountCents < order.amountCents ? "danger" : undefined}>
          {formatUsd(proof.declaredAmountCents)}
        </Typography.Text>
      ),
    },
    { key: "amount", label: t("orders.detail.amount"), children: formatUsd(order.amountCents) },
    { key: "txnRef", label: t("proofs.col.txnRef"), children: <Typography.Text code copyable>{proof.bankTxnRef}</Typography.Text> },
    { key: "declaredPaidAt", label: t("proofs.detail.declaredPaidAt"), children: formatDateTime(proof.declaredPaidAt) },
    { key: "payerName", label: t("proofs.detail.payerName"), children: proof.payerName ?? "—" },
    { key: "submittedAt", label: t("proofs.detail.submittedAt"), children: formatDateTime(proof.createdAt) },
    { key: "orderStatus", label: t("orders.col.status"), children: <OrderStatusTag status={order.status} /> },
  ];
  if (proof.reviewedAt) {
    declaredItems.push({ key: "reviewedAt", label: t("proofs.detail.reviewedAt"), children: formatDateTime(proof.reviewedAt) });
  }
  if (proof.rejectCode) {
    declaredItems.push(
      { key: "rejectCode", label: t("proofs.reject.code"), children: t(`proofs.rejectCode.${proof.rejectCode}`) },
      { key: "rejectReason", label: t("proofs.detail.rejectReason"), children: proof.rejectReason ?? "—" },
    );
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space style={{ width: "100%", justifyContent: "space-between" }} wrap>
        <Space wrap>
          {backButton}
          <Typography.Title level={3} style={{ margin: 0 }}>
            {proof.proofNo}
          </Typography.Title>
          <ProofStatusTag status={proof.status} testId="proof-status" />
          {proof.dupFileHit ? <Tag color="orange">{t("proofs.dupTag")}</Tag> : null}
        </Space>
        {reviewable ? (
          <Space>
            <Button danger data-testid="proof-reject-open" onClick={() => setDialog("reject")}>
              {t("proofs.reject.open")}
            </Button>
            <Button type="primary" data-testid="proof-approve-open" onClick={() => setDialog("approve")}>
              {t("proofs.approve.open")}
            </Button>
          </Space>
        ) : null}
      </Space>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={10}>
          <Card title={t("proofs.detail.screenshot")}>
            <Image
              data-testid="proof-image"
              src={adminFileUrl(proof.fileId)}
              alt={t("proofs.detail.screenshot")}
              width="100%"
              style={{ maxHeight: 640, objectFit: "contain" }}
            />
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Card title={t("proofs.detail.declared")}>
              <Descriptions column={{ xs: 1, md: 2 }} items={declaredItems} />
            </Card>
            <OrderOverviewCard order={order} />
          </Space>
        </Col>
      </Row>

      <OrderParticipantsCard order={order} />
      <OrderProofsCard order={order} currentProofId={proof.id} />

      {dialog === "approve" ? (
        <ApproveProofModal proof={proof} amountCents={order.amountCents} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === "reject" ? <RejectProofModal proofId={proof.id} onClose={() => setDialog(null)} /> : null}
    </Space>
  );
}
```

创建 `web/admin/src/pages/OrdersPage.tsx`：

```tsx
import { formatUsd, type Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { Alert, Button, Form, Input, Select, Space, Table, Typography, type TableProps } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { PERM_EVENT_CONFIG, can } from "../auth/can";
import { useMe } from "../auth/useMe";
import { pickText } from "../events/localize";
import { formatDateTime, rowProps } from "../orders/format";
import { OrderStatusTag } from "../orders/OrderStatusTag";
import {
  ORDER_PAGE_SIZE,
  ORDER_STATUSES,
  useAdminOrders,
  useEventOptions,
  type AdminOrderFilter,
  type AdminOrderStatus,
} from "../orders/queries";

type OrderSummary = Schemas["AdminOrderSummary"];

interface FilterValues {
  eventId?: number;
  status?: AdminOrderStatus;
  q?: string;
}

export function OrdersPage() {
  const { t } = useTranslation("admin");
  const lang = useLang();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const canSeeEvents = can(me?.permissions, PERM_EVENT_CONFIG, "read");
  const events = useEventOptions(canSeeEvents);
  const [form] = Form.useForm<FilterValues>();
  const [filter, setFilter] = useState<AdminOrderFilter>({ page: 1 });
  const orders = useAdminOrders(filter);

  const columns: TableProps<OrderSummary>["columns"] = [
    {
      title: t("orders.col.orderNo"),
      key: "orderNo",
      render: (_, order) => <Typography.Text strong>{order.orderNo}</Typography.Text>,
    },
    { title: t("orders.col.event"), key: "event", render: (_, order) => pickText(order.eventName, lang) },
    { title: t("orders.col.participants"), dataIndex: "participantCount", key: "participantCount", align: "right" },
    { title: t("orders.col.amount"), key: "amount", align: "right", render: (_, order) => formatUsd(order.amountCents) },
    { title: t("orders.col.status"), key: "status", render: (_, order) => <OrderStatusTag status={order.status} /> },
    { title: t("orders.col.createdAt"), key: "createdAt", render: (_, order) => formatDateTime(order.createdAt) },
  ];

  const onFinish = (values: FilterValues) => {
    const q = values.q?.trim();
    setFilter({ eventId: values.eventId, status: values.status, q: q ? q : undefined, page: 1 });
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Typography.Title level={3} style={{ margin: 0 }}>
        {t("orders.title")}
      </Typography.Title>

      <Form<FilterValues> form={form} name="orderFilter" layout="inline" onFinish={onFinish} style={{ rowGap: 12 }}>
        {canSeeEvents ? (
          <Form.Item name="eventId" label={t("orders.filter.event")}>
            <Select
              allowClear
              style={{ minWidth: 220 }}
              loading={events.isPending}
              options={(events.data ?? []).map((event) => ({ value: event.id, label: pickText(event.name, lang) }))}
            />
          </Form.Item>
        ) : null}
        <Form.Item name="status" label={t("orders.filter.status")}>
          <Select
            allowClear
            style={{ minWidth: 180 }}
            options={ORDER_STATUSES.map((status) => ({ value: status, label: t(`orders.status.${status}`) }))}
          />
        </Form.Item>
        <Form.Item name="q">
          <Input allowClear placeholder={t("orders.filter.q")} style={{ width: 240 }} />
        </Form.Item>
        <Space>
          <Button type="primary" htmlType="submit" data-testid="order-filter-submit">
            {t("orders.filter.submit")}
          </Button>
          <Button
            onClick={() => {
              form.resetFields();
              setFilter({ page: 1 });
            }}
          >
            {t("orders.filter.reset")}
          </Button>
        </Space>
      </Form>

      {orders.isError ? <Alert type="error" showIcon message={orders.error.message} /> : null}

      <Table<OrderSummary>
        rowKey="id"
        columns={columns}
        dataSource={orders.data?.items ?? []}
        loading={orders.isFetching}
        locale={{ emptyText: t("orders.empty") }}
        scroll={{ x: 900 }}
        pagination={{
          current: filter.page,
          pageSize: ORDER_PAGE_SIZE,
          total: orders.data?.total ?? 0,
          showSizeChanger: false,
          showTotal: (total) => t("orders.total", { total }),
          onChange: (page) => setFilter((previous) => ({ ...previous, page })),
        }}
        onRow={(order) =>
          rowProps(`order-row-${order.orderNo}`, {
            onClick: () => void navigate(`/orders/${order.id}`),
            style: { cursor: "pointer" },
          })
        }
      />
    </Space>
  );
}
```

创建 `web/admin/src/pages/OrderDetailPage.tsx`：

```tsx
import { ApiError } from "@werun/api-client";
import { Alert, Button, Card, Space, Typography } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import {
  OrderAmountsCard,
  OrderOverviewCard,
  OrderParticipantsCard,
  OrderProofsCard,
  OrderReceiptsCard,
} from "../orders/OrderSections";
import { OrderStatusTag } from "../orders/OrderStatusTag";
import { useAdminOrder } from "../orders/queries";

export function OrderDetailPage() {
  const { id = "" } = useParams();
  const orderId = Number(id);
  const { t } = useTranslation("admin");
  const navigate = useNavigate();
  const order = useAdminOrder(orderId);

  const backButton = <Button onClick={() => void navigate("/orders")}>{t("orders.detail.back")}</Button>;

  if (!Number.isInteger(orderId) || orderId <= 0 || (order.error instanceof ApiError && order.error.status === 404)) {
    return <Alert type="warning" showIcon message={t("orders.detail.notFound")} action={backButton} />;
  }
  if (order.isError) {
    return <Alert type="error" showIcon message={order.error.message} action={backButton} />;
  }
  if (order.isPending) {
    return <Card loading />;
  }

  const data = order.data;
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap>
        {backButton}
        <Typography.Title level={3} style={{ margin: 0 }}>
          {data.orderNo}
        </Typography.Title>
        <OrderStatusTag status={data.status} testId="order-status" />
      </Space>
      <OrderOverviewCard order={data} />
      <OrderAmountsCard order={data} />
      <OrderParticipantsCard order={data} />
      <OrderProofsCard order={data} />
      <OrderReceiptsCard order={data} />
    </Space>
  );
}
```

`web/admin/src/routes.tsx`：
- 在 `../auth/can` 的导入中加入 `PERM_ORDER_VIEW`、`PERM_PROOF_REVIEW`；
- 增加导入：

```tsx
import { OrderDetailPage } from "./pages/OrderDetailPage";
import { OrdersPage } from "./pages/OrdersPage";
import { ProofDetailPage } from "./pages/ProofDetailPage";
import { ProofsPage } from "./pages/ProofsPage";
```

- 把

```tsx
          { path: "*", element: <Navigate to="/events" replace /> },
```

改为

```tsx
          {
            path: "proofs",
            element: (
              <RequirePermission permission={PERM_PROOF_REVIEW} access="read">
                <ProofsPage />
              </RequirePermission>
            ),
          },
          {
            path: "proofs/:id",
            element: (
              <RequirePermission permission={PERM_PROOF_REVIEW} access="read">
                <ProofDetailPage />
              </RequirePermission>
            ),
          },
          {
            path: "orders",
            element: (
              <RequirePermission permission={PERM_ORDER_VIEW} access="read">
                <OrdersPage />
              </RequirePermission>
            ),
          },
          {
            path: "orders/:id",
            element: (
              <RequirePermission permission={PERM_ORDER_VIEW} access="read">
                <OrderDetailPage />
              </RequirePermission>
            ),
          },
          { path: "*", element: <Navigate to="/events" replace /> },
```

`web/admin/src/layout/AppLayout.tsx`：
- 在 `@ant-design/icons` 的导入中加入 `AuditOutlined`、`ProfileOutlined`；
- 在 `../auth/can` 的导入中加入 `PERM_ORDER_VIEW`、`PERM_PROOF_REVIEW`；
- 在 `MENU` 数组的最后一项之后追加：

```tsx
  { key: "/proofs", labelKey: "proofs.title", permission: PERM_PROOF_REVIEW, access: "read", icon: <AuditOutlined /> },
  { key: "/orders", labelKey: "orders.title", permission: PERM_ORDER_VIEW, access: "read", icon: <ProfileOutlined /> },
```

- [ ] **Step 9: 运行组件测试，确认通过**

Run: `pnpm --filter @werun/admin test -- src/review.test.tsx src/orders.test.tsx src/orders/format.test.ts`
Expected: `review.test.tsx`（8 个用例）、`orders.test.tsx`（3 个用例）、`format.test.ts`（3 个用例）全部通过。

- [ ] **Step 10: 全量检查**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm i18n:check`
Expected: 全部通过；`web/admin/src/app.test.tsx` 等已有测试不受影响。

Run: `cd api && go test ./... && go tool golangci-lint run ./...`
Expected: 全部 `ok`；`0 issues.`（本任务未改后端，确认主干仍然绿色）。

- [ ] **Step 11: 提交**

```bash
git add web/admin/src/orders web/admin/src/proofs \
  web/admin/src/pages/ProofsPage.tsx web/admin/src/pages/ProofDetailPage.tsx \
  web/admin/src/pages/OrdersPage.tsx web/admin/src/pages/OrderDetailPage.tsx \
  web/admin/src/routes.tsx web/admin/src/layout/AppLayout.tsx \
  web/admin/src/test/reviewFixtures.ts web/admin/src/review.test.tsx web/admin/src/orders.test.tsx \
  packages/i18n/locales/zh/admin.json packages/i18n/locales/en/admin.json packages/i18n/locales/km/admin.json
git commit -m "$(cat <<'EOF'
feat(admin): add proof review queue and detail with approve/reject, and order list and detail pages

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
)"
```
