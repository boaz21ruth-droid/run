# 第 3 段：算价与下单（Task 11–14）

> `00-overview.md` 的 Global Constraints、「与 spec 的实现调整」和「跨任务契约」对本文件每个任务都生效；本文件使用的名字、签名、operationId、错误码、审计 action、testid、路由、文案命名空间均以那里为准。下面「契约补充」只列出契约没写到、而本段必须确定的内容。

**前置状态**：Task 1–10 已按 00-overview 完成（平台包 `storage`/`piicrypt`/`idgen`/`settings`、迁移 0010、新权限、`pricing` 价格档与优惠码后台、`payment` 收款账户、`runner` 登录/参赛人/同意书、用户端 `AuthProvider`/`RequireRunner`/会话与 `getAuthToken`）。

**数据库命令说明**：凡是 `go test` 涉及 `dbtest` 的命令，本机为 colima 时在命令前加 `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true`（下文统一写成 `$DBENV`，执行前先 `export DBENV='DOCKER_HOST=unix://'$HOME'/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true'`，命令形如 `cd api && env $DBENV go test …`；非 colima 时 `DBENV` 设为空串）。

## 契约补充

1. **`CATEGORY_SOLD_OUT`、`PRICE_TIER_SOLD_OUT` 提前到 Task 11 引入**（错误码表写的是 Task 12）。原因：`pricing.Reserve` 在 Task 11 实现并测试，0 行时必须返回这两个码。HTTP 状态仍为 409。
2. **`ORDER_STATE_CONFLICT` 提前到 Task 12 引入**（表中为 Task 13）。原因：Task 12 实现的 `ConfirmPaid` 在条件更新影响 0 行时必须返回它。`ORDER_NOT_FOUND` 仍在 Task 13。
3. **字段文案 key 的引入任务**：`field.too_young`、`field.category_unavailable`、`field.coupon_invalid` 在 Task 11 加入 `messages.*.json`；`field.duplicate_id_no`、`field.already_registered` 在 Task 12 加入。
4. **新增测试专用包 `api/internal/testfixture`**（Task 11 创建，Task 12、13 扩充）：用原生 SQL 造赛事、组别、价格档、优惠码、收款账户、跑者、订单等数据，供 `pricing`、`registration`、`httpapi` 的数据库测试共用。只被 `_test.go` 引用。
5. **幂等响应的存储形式**：`idempotency_keys.response_code = 201`，`response_body` = `apigen.OrderDetail` 的 JSON。重放时 `CreateOrder` 把它解码并经 `orderDetailFromAPI` 转回 `registration.OrderDetail`，handler 再转成同一份 JSON 返回 201。为使重放结果与请求语言无关，`OrderDetail`/`OrderSummary` 里的 `eventName`、`categoryName` 使用 `LocalizedText`（三语）而不是按语言挑好的字符串。并发同键请求靠 `INSERT … ON CONFLICT DO UPDATE … WHERE expires_at <= now` 在主键上串行：后到的请求等先到的事务结束后读到已存响应。
6. **锁顺序**（实现细节，写在这里是为了 Task 15、17、21 调用 `ConfirmPaid`/`ReleaseOrder` 时保持一致、避免死锁）：下单事务依次持有 `events` 行 `FOR SHARE` → 幂等键行 → 每个证件号哈希的事务级 advisory 锁（单 bigint 键 `hashtextextended('<eventId>:<hex(hash)>', 7302)`，按哈希字节序加锁，防止两个并发订单同时通过「已报名」检查）→ 收款账户 advisory 锁 `pg_advisory_xact_lock(7301, accountId)` → `event_categories`（id 升序）→ `price_rules`（id 升序）→ `coupons`。`Consume`/`Release` 也按 组别 → 价格档 → 优惠码 且 id 升序更新。spec 6.1 第 1 步「锁赛事行」用 `FOR SHARE` 实现：阻止后台同时关闭报名，又不让同一赛事的订单互相串行。
7. **`pricing` 新查询名统一带 `Quote`/`Reserve`/`Consume`/`Release`/`Order…Seats` 前缀**，避免与 Task 4、5 已在 `db/queries/pricing.sql` 中定义的查询重名。
8. **OpenAPI 新 schema 名**（Task 12、13）：`QuoteRequest`、`QuoteParticipantInput`、`Quote`、`QuoteParticipant`、`CreateOrderRequest`、`OrderParticipantInput`、`OrderProfileInput`、`OrderConsentInput`、`OrderStatus`、`OrderDetail`、`OrderParticipant`、`OrderPaymentAccount`、`OrderRejection`、`OrderSummary`、`OrderList`。下单请求里的资料与同意书使用本段自己的 `OrderProfileInput`、`OrderConsentInput`，不引用 Task 8、9 的 schema，避免名字耦合。
9. **`App` 构造顺序**（Task 12）：`Bootstrap` 中 `app.Registration` 在 `app.Payment` 之前构造，为 Task 15 做准备。本任务不改 `payment.NewService` 的调用：Task 6 的签名是 `NewService(pool, files, now)`，由 Task 15 改为 `NewService(pool, files, orders, now)` 并传入 `app.Registration`（见总览 `payment` 契约下方的签名演进说明）。
10. **本段前端依赖 Task 8、9、10 的以下形状**（契约只给了 Go 类型，JSON 按「小驼峰」规则推得；Task 14 Step 1 先核对，形状不同则以生成的 `schema.d.ts` 为准改本段对应的读取代码）：
    - `GET /app/profiles` → `{ items: RunnerProfile[] }`，`RunnerProfile` 至少含 `id`、`fullName`、`birthDate`（`YYYY-MM-DD`）、`nationality`、`idNoMasked`。
    - `GET /app/consents?purpose=REGISTRATION&lang=` → `{ version, lang, effectiveDate, fullText, items: [{ key, title, description }] }`。
    - `GET /app/me` → `{ id, telegramUserId, telegramUsername, displayName, locale }`；`POST /app/auth/telegram` → `{ token, expiresAt, user }`。
    - `routes.tsx` 中需要登录的页面放在布局路由 `{ element: <RequireRunner />, children: [...] }` 的 `children` 里；`RequireRunner` 在 `sessionStorage` 有未过期的 `werun.appToken` 且有 `werun.devInitData`（开发/测试环境）时直接渲染子路由。
    - 组件测试的 `renderApp` 已按 `main.tsx` 传入 `getAuthToken`。

---

### Task 11: 算价与计数

**Files:**
- Create: `api/internal/pricing/quote.go`（纯函数 + `Quote`）
- Create: `api/internal/pricing/counters.go`（`Reserve`、`RecordRedemption`、`Consume`、`Release`）
- Test: `api/internal/pricing/quote_test.go`（纯函数单元测试）
- Test: `api/internal/pricing/quote_db_test.go`（数据库测试）
- Modify: `api/db/queries/pricing.sql`（末尾追加查询）
- Generate: `api/internal/pricing/store/`
- Create: `api/internal/testfixture/fixture.go`
- Modify: `api/internal/platform/apperr/apperr.go`、`api/internal/platform/apperr/apperr_test.go`
- Modify: `api/internal/platform/i18n/messages.zh.json`、`messages.en.json`、`messages.km.json`、`api/internal/platform/i18n/catalog_test.go`

**Interfaces:**
- Consumes:
  - `settings.LoadPayment(ctx, q interface{ QueryRow(context.Context, string, ...any) pgx.Row }) (Payment, error)`，`Payment.IdentOffsetMaxCents`
  - `pricing.NewService(pool *pgxpool.Pool, now func() time.Time) *Service`（Task 4）
  - `runner.NewService(pool, sessionSecret, botToken, pii, now)`、`(*runner.Service).PublishConsent`、`runner.ProfileData`、`runner.User`、`runner.ConsentAcceptance`、`piicrypt.New`（Task 1、7–9，`testfixture` 使用）
  - `db.InTx`、`dbtest.NewPool`、`apperr.*`
- Produces（全部照抄契约）:

```go
type ParticipantInput struct { CategoryID int64; Nationality string; BirthDate time.Time }
type QuoteInput struct { EventID int64; RaceDate time.Time; CouponCode string; Participants []ParticipantInput; Now time.Time; PaymentAccountID *int64 }
type ParticipantQuote struct { CategoryID, PriceRuleID int64; Audience string; ListPriceCents int64; PaidCents int64 }
type Quote struct { Participants []ParticipantQuote; ListAmountCents int64; CouponID *int64; CouponDiscountCents int64; IdentOffsetCents int64; DiscountCents int64; AmountCents int64; Currency string }
func (s *Service) Quote(ctx context.Context, tx pgx.Tx, in QuoteInput) (Quote, error)
func (s *Service) Reserve(ctx context.Context, tx pgx.Tx, q Quote) error
func (s *Service) RecordRedemption(ctx context.Context, tx pgx.Tx, orderID int64, q Quote) error
func (s *Service) Consume(ctx context.Context, tx pgx.Tx, orderID int64) error
func (s *Service) Release(ctx context.Context, tx pgx.Tx, orderID int64) error
type TierCandidate struct { PriceRuleID int64; Audience string; PriceCents int64; Quota *int32; UsedCount int32; ReservedCount int32; SaleStartsAt *time.Time; SaleEndsAt *time.Time; SortOrder int16 }
func SelectTier(cands []TierCandidate, nationality string, now time.Time, takenInOrder map[int64]int) (TierCandidate, bool)
func AgeOn(birth, raceDate time.Time) int
type CouponRule struct { DiscountType string; DiscountValue int64 }
func CouponDiscount(c CouponRule, listAmount int64) int64
func Allocate(listPrices []int64, discount int64) []int64
func PickIdentOffset(amountAfterCoupon int64, taken map[int64]bool, maxCents int64) int64
```

  - 错误码 `CodeCouponInvalid`(422)、`CodeCouponExhausted`(409)、`CodeCategorySoldOut`(409)、`CodePriceTierSoldOut`(409)；字段文案 `field.too_young`、`field.category_unavailable`、`field.coupon_invalid`。
  - `testfixture` 包（见 Step 9）。

**数据库事实**（`0002_events.sql`、`0003_registration.sql`、`0005_payments.sql`）：
- `event_categories`：`capacity`、`used_count`、`reserved_count`（`int`，`CHECK >= 0`），`min_age smallint`，约束 `event_categories_no_oversell CHECK (used_count + reserved_count <= capacity)`。
- `price_rules`：`audience IN ('ALL','LOCAL')`，`price_cents bigint`，`quota int NULL`（NULL = 不限），`sale_starts_at`/`sale_ends_at` 可空，`sort_order smallint`，`price_rules_no_oversell`。
- `category_price_rules (category_id, price_rule_id)` 主键。
- `coupons`：`code UNIQUE`（存大写），`event_id` 可空，`discount_type IN ('PERCENT','AMOUNT','WAIVER')`，`quota int NOT NULL`，`used_count`/`reserved_count` **没有** `>= 0` 约束（所以减法必须带条件），`min_runners smallint NULL`，`valid_from`/`valid_until` 可空，`status IN ('ACTIVE','DISABLED')`，`coupons_no_overuse`。
- `coupon_redemptions (order_id PK, coupon_id, state IN ('RESERVED','CONSUMED','RELEASED'), discount_cents, updated_at)`，没有 `updated_at` 触发器。
- `order_participants (order_id, category_id, price_rule_id, audience, list_price_cents, paid_cents, snapshot_name)`，不可改、不可删。
- `reg_orders.amount_cents`、`payment_account_id`、`status`；`CHECK (amount_cents = list_amount_cents - discount_cents)`，`CHECK (reservation_state <> 'RESERVED' OR status IN ('PENDING_PAYMENT','PROOF_SUBMITTED','PROOF_REJECTED'))`，`CHECK (status <> 'PAID' OR paid_at IS NOT NULL)`。
- `pg_advisory_xact_lock(int4, int4)` 与 `pg_advisory_xact_lock(int8)` 的键空间互不重叠（PostgreSQL 文档 “Advisory Lock Functions”）。

- [ ] **Step 1: 写纯函数的失败测试**

创建 `api/internal/pricing/quote_test.go`：

```go
package pricing_test

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"werun/api/internal/pricing"
)

func day(s string) time.Time {
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		panic(err)
	}
	return t
}

func at(s string) *time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return &t
}

func quota(n int32) *int32 { return &n }

func TestSelectTier(t *testing.T) {
	now := *at("2026-09-14T10:00:00Z")
	early := pricing.TierCandidate{PriceRuleID: 1, Audience: "ALL", PriceCents: 2000, Quota: quota(2), SaleEndsAt: at("2026-10-01T00:00:00Z")}
	standard := pricing.TierCandidate{PriceRuleID: 2, Audience: "ALL", PriceCents: 3000}
	local := pricing.TierCandidate{PriceRuleID: 3, Audience: "LOCAL", PriceCents: 1500}

	cases := []struct {
		name     string
		cands    []pricing.TierCandidate
		nat      string
		taken    map[int64]int
		wantID   int64
		wantFind bool
	}{
		{"本地人取最便宜的本地价", []pricing.TierCandidate{early, standard, local}, "KH", nil, 3, true},
		{"外国人不能用本地价", []pricing.TierCandidate{early, standard, local}, "US", nil, 1, true},
		{"未开售的档跳过", []pricing.TierCandidate{{PriceRuleID: 4, Audience: "ALL", PriceCents: 100, SaleStartsAt: at("2026-09-15T00:00:00Z")}, standard}, "US", nil, 2, true},
		{"开售时间等于现在可以买", []pricing.TierCandidate{{PriceRuleID: 4, Audience: "ALL", PriceCents: 100, SaleStartsAt: at("2026-09-14T10:00:00Z")}, standard}, "US", nil, 4, true},
		{"截止时间等于现在不能买", []pricing.TierCandidate{{PriceRuleID: 4, Audience: "ALL", PriceCents: 100, SaleEndsAt: at("2026-09-14T10:00:00Z")}, standard}, "US", nil, 2, true},
		{"配额被占满跳过", []pricing.TierCandidate{{PriceRuleID: 1, Audience: "ALL", PriceCents: 2000, Quota: quota(2), UsedCount: 1, ReservedCount: 1}, standard}, "US", nil, 2, true},
		{"本单已选人数计入配额", []pricing.TierCandidate{early, standard}, "US", map[int64]int{1: 2}, 2, true},
		{"本单已选但配额仍有余", []pricing.TierCandidate{early, standard}, "US", map[int64]int{1: 1}, 1, true},
		{"同价取 sort_order 小的", []pricing.TierCandidate{{PriceRuleID: 5, Audience: "ALL", PriceCents: 3000, SortOrder: 2}, {PriceRuleID: 6, Audience: "ALL", PriceCents: 3000, SortOrder: 1}}, "US", nil, 6, true},
		{"同价同序取 id 小的", []pricing.TierCandidate{{PriceRuleID: 8, Audience: "ALL", PriceCents: 3000}, {PriceRuleID: 7, Audience: "ALL", PriceCents: 3000}}, "US", nil, 7, true},
		{"没有候选", []pricing.TierCandidate{local}, "US", nil, 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := pricing.SelectTier(tc.cands, tc.nat, now, tc.taken)
			require.Equal(t, tc.wantFind, ok)
			require.Equal(t, tc.wantID, got.PriceRuleID)
		})
	}
}

func TestAgeOn(t *testing.T) {
	cases := []struct {
		name  string
		birth string
		race  string
		want  int
	}{
		{"比赛当天生日满岁", "2010-11-15", "2026-11-15", 16},
		{"比赛前一天还差一天", "2010-11-16", "2026-11-15", 15},
		{"2 月 29 日出生，非闰年 2 月 28 日未满岁", "2008-02-29", "2026-02-28", 17},
		{"2 月 29 日出生，非闰年 3 月 1 日满岁", "2008-02-29", "2026-03-01", 18},
		{"2 月 29 日出生，闰年 2 月 29 日满岁", "2008-02-29", "2028-02-29", 20},
		{"2 月 29 日出生，闰年 2 月 28 日未满岁", "2008-02-29", "2028-02-28", 19},
		{"刚好等于最低年龄", "2008-11-15", "2026-11-15", 18},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, pricing.AgeOn(day(tc.birth), day(tc.race)))
		})
	}
}

func TestCouponDiscount(t *testing.T) {
	cases := []struct {
		name string
		rule pricing.CouponRule
		list int64
		want int64
	}{
		{"百分比向下取整", pricing.CouponRule{DiscountType: "PERCENT", DiscountValue: 15}, 3333, 499},
		{"百分比 100", pricing.CouponRule{DiscountType: "PERCENT", DiscountValue: 100}, 5000, 5000},
		{"固定金额小于原价", pricing.CouponRule{DiscountType: "AMOUNT", DiscountValue: 500}, 5000, 500},
		{"固定金额超过原价按原价", pricing.CouponRule{DiscountType: "AMOUNT", DiscountValue: 9000}, 5000, 5000},
		{"免单", pricing.CouponRule{DiscountType: "WAIVER"}, 5000, 5000},
		{"原价为 0", pricing.CouponRule{DiscountType: "PERCENT", DiscountValue: 50}, 0, 0},
		{"未知类型不减免", pricing.CouponRule{DiscountType: "BOGUS", DiscountValue: 50}, 5000, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, pricing.CouponDiscount(tc.rule, tc.list))
		})
	}
}

func TestAllocate(t *testing.T) {
	cases := []struct {
		name     string
		prices   []int64
		discount int64
		want     []int64
	}{
		{"无优惠", []int64{2500, 3000}, 0, []int64{2500, 3000}},
		{"余数大的先补", []int64{1800, 2000, 3000}, 682, []int64{1620, 1799, 2699}},
		{"余数相同按参赛人顺序", []int64{2500, 2500}, 1001, []int64{1999, 2000}},
		{"三人同价补两分", []int64{1000, 1000, 1000}, 2, []int64{999, 999, 1000}},
		{"全额减免", []int64{1200, 800}, 2000, []int64{0, 0}},
		{"原价为 0", []int64{0, 0}, 0, []int64{0, 0}},
		{"有人原价为 0", []int64{0, 3000}, 1, []int64{0, 2999}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := pricing.Allocate(tc.prices, tc.discount)
			require.Equal(t, tc.want, got)
			var list, paid int64
			for i := range tc.prices {
				list += tc.prices[i]
				paid += got[i]
			}
			if list > 0 {
				require.Equal(t, list-tc.discount, paid, "分摊后总额必须等于应付")
			}
		})
	}
}

func TestPickIdentOffset(t *testing.T) {
	cases := []struct {
		name   string
		amount int64
		taken  map[int64]bool
		max    int64
		want   int64
	}{
		{"没有占用取 1", 5000, nil, 50, 1},
		{"跳过已占用金额", 5000, map[int64]bool{4999: true, 4998: true}, 50, 3},
		{"全部占用为 0", 5000, map[int64]bool{4999: true, 4998: true, 4997: true}, 3, 0},
		{"应付 1 分为 0", 1, nil, 50, 0},
		{"应付 2 分只能减 1", 2, map[int64]bool{1: true}, 50, 0},
		{"上限超过 50 按 50", 100, map[int64]bool{}, 80, 1},
		{"上限 0 为 0", 5000, nil, 0, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, pricing.PickIdentOffset(tc.amount, tc.taken, tc.max))
		})
	}

	taken := map[int64]bool{}
	for i := int64(1); i <= 50; i++ {
		taken[10000-i] = true
	}
	require.Equal(t, int64(0), pricing.PickIdentOffset(10000, taken, 80), "上限封顶 50：1..50 全占用时不能取 51")
}
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd api && go test ./internal/pricing/ -run 'TestSelectTier|TestAgeOn|TestCouponDiscount|TestAllocate|TestPickIdentOffset'`
Expected: 编译失败，`undefined: pricing.SelectTier`（以及 `AgeOn`、`CouponRule` 等）。

- [ ] **Step 3: 实现纯函数**

创建 `api/internal/pricing/quote.go`（本步只放纯函数与类型，Step 12 再追加 `Quote` 方法）：

```go
package pricing

import (
	"slices"
	"time"
)

const (
	localNationality         = "KH"
	identOffsetCapCents int64 = 50
	identLockNamespace        = 7301
	quoteCurrency             = "USD"
)

// ParticipantInput 是算价需要的参赛人信息。
type ParticipantInput struct {
	CategoryID  int64
	Nationality string
	BirthDate   time.Time
}

// QuoteInput 是算价输入。PaymentAccountID 为 nil 时是预览：不选识别分、不加锁。
type QuoteInput struct {
	EventID          int64
	RaceDate         time.Time
	CouponCode       string
	Participants     []ParticipantInput
	Now              time.Time
	PaymentAccountID *int64
}

// ParticipantQuote 是单个参赛人的价格快照。
type ParticipantQuote struct {
	CategoryID, PriceRuleID int64
	Audience                string
	ListPriceCents          int64
	PaidCents               int64
}

// Quote 是整单算价结果。
type Quote struct {
	Participants        []ParticipantQuote
	ListAmountCents     int64
	CouponID            *int64
	CouponDiscountCents int64
	IdentOffsetCents    int64
	DiscountCents       int64
	AmountCents         int64
	Currency            string
}

// TierCandidate 是某个组别可用的一档价格。
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

// CouponRule 是优惠码的减免规则。
type CouponRule struct {
	DiscountType  string // PERCENT | AMOUNT | WAIVER
	DiscountValue int64
}

// SelectTier 按 spec 5 第 1 步选价格档：人群、销售时间、配额（含本单已选人数）都满足的候选中，
// 取价格最低的；同价取 sort_order 小的，再同取 id 小的。
func SelectTier(cands []TierCandidate, nationality string, now time.Time, takenInOrder map[int64]int) (TierCandidate, bool) {
	var best TierCandidate
	found := false
	for _, c := range cands {
		switch c.Audience {
		case "ALL":
		case "LOCAL":
			if nationality != localNationality {
				continue
			}
		default:
			continue
		}
		if c.SaleStartsAt != nil && c.SaleStartsAt.After(now) {
			continue
		}
		if c.SaleEndsAt != nil && !c.SaleEndsAt.After(now) {
			continue
		}
		if c.Quota != nil &&
			int64(c.UsedCount)+int64(c.ReservedCount)+int64(takenInOrder[c.PriceRuleID]) >= int64(*c.Quota) {
			continue
		}
		if !found || tierLess(c, best) {
			best = c
			found = true
		}
	}
	return best, found
}

func tierLess(a, b TierCandidate) bool {
	if a.PriceCents != b.PriceCents {
		return a.PriceCents < b.PriceCents
	}
	if a.SortOrder != b.SortOrder {
		return a.SortOrder < b.SortOrder
	}
	return a.PriceRuleID < b.PriceRuleID
}

// AgeOn 返回 raceDate 当天的周岁。2 月 29 日出生者在非闰年按 3 月 1 日满岁。
// 两个参数都是日期（UTC 零点），只看年月日。
func AgeOn(birth, raceDate time.Time) int {
	by, bm, bd := birth.Date()
	ry, rm, rd := raceDate.Date()
	if bm == time.February && bd == 29 && !isLeapYear(ry) {
		bm, bd = time.March, 1
	}
	age := ry - by
	if rm < bm || (rm == bm && rd < bd) {
		age--
	}
	return age
}

func isLeapYear(y int) bool {
	return y%4 == 0 && (y%100 != 0 || y%400 == 0)
}

// CouponDiscount 计算优惠码减免：PERCENT 向下取整，AMOUNT 不超过原价，WAIVER 全免。
func CouponDiscount(c CouponRule, listAmount int64) int64 {
	if listAmount <= 0 {
		return 0
	}
	switch c.DiscountType {
	case "PERCENT":
		return listAmount * min(max(c.DiscountValue, 0), 100) / 100
	case "AMOUNT":
		return min(max(c.DiscountValue, 0), listAmount)
	case "WAIVER":
		return listAmount
	}
	return 0
}

// Allocate 把整单减免按原价比例分摊到每人，返回每人 paid_cents。
// 先按 floor(discount × price / list) 分摊，剩余的分按被舍去的余数从大到小逐分补齐，余数相同按参赛人顺序；
// 结果之和恒等于 list − discount。原价合计为 0 时每人 0。
func Allocate(listPrices []int64, discount int64) []int64 {
	paid := make([]int64, len(listPrices))
	var total int64
	for _, p := range listPrices {
		total += p
	}
	if total <= 0 {
		return paid
	}
	discount = min(max(discount, 0), total)

	type remainder struct {
		idx int
		rem int64
	}
	rems := make([]remainder, 0, len(listPrices))
	var allocated int64
	for i, p := range listPrices {
		share := discount * p / total
		paid[i] = p - share
		allocated += share
		rems = append(rems, remainder{idx: i, rem: discount * p % total})
	}
	slices.SortStableFunc(rems, func(a, b remainder) int {
		switch {
		case a.rem > b.rem:
			return -1
		case a.rem < b.rem:
			return 1
		}
		return 0
	})
	for k := int64(0); k < discount-allocated; k++ {
		paid[rems[k].idx]--
	}
	return paid
}

// PickIdentOffset 在 1..min(maxCents, 50, amount−1) 中找最小的 n，使 amount−n 不在 taken 中；找不到返回 0。
func PickIdentOffset(amountAfterCoupon int64, taken map[int64]bool, maxCents int64) int64 {
	limit := min(maxCents, identOffsetCapCents, amountAfterCoupon-1)
	for n := int64(1); n <= limit; n++ {
		if !taken[amountAfterCoupon-n] {
			return n
		}
	}
	return 0
}
```

> 若 Task 4/5 的 `pricing` 包里已有同名的未导出常量（`localNationality`、`quoteCurrency` 等），编译会报 `redeclared`：此时删掉本文件里重复的那一行，沿用已有常量（值必须相同）。

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd api && go test ./internal/pricing/ -run 'TestSelectTier|TestAgeOn|TestCouponDiscount|TestAllocate|TestPickIdentOffset' -v`
Expected: 5 个测试及全部子测试 PASS。

- [ ] **Step 5: 提交纯函数**

```bash
git add api/internal/pricing/quote.go api/internal/pricing/quote_test.go
git commit -m "$(cat <<'EOF'
feat(api): add pricing tier selection, age, coupon, allocation and ident offset functions

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
)"
```

- [ ] **Step 6: 写错误码与文案的失败测试**

修改 `api/internal/platform/apperr/apperr_test.go` 的 `TestAllCodesAreUnique` 末尾断言（Task 10 结束时为 23 个错误码：脚手架 16 个 + Task 1、3、4、5、7、9 的 7 个）：

```go
	assert.Len(t, apperr.AllCodes, 23)
```

改为：

```go
	assert.Len(t, apperr.AllCodes, 27)
```

修改 `api/internal/platform/i18n/catalog_test.go` 的 `TestEmbeddedCatalogCoversAllCodesAndFieldKeys`，在 `"field.category_incomplete",` 之后加入三行：

```go
		"field.too_young",
		"field.category_unavailable",
		"field.coupon_invalid",
```

并在该测试末尾（`field.too_long` 断言之后）加一行：

```go
	assert.Equal(t, "Must be at least 16 on race day.", cat.T(EN, "field.too_young", map[string]any{"minAge": 16}))
```

Run: `cd api && go test ./internal/platform/apperr/ ./internal/platform/i18n/`
Expected: FAIL：`TestAllCodesAreUnique` 报 `should have 27 item(s), but has 23`；`TestEmbeddedCatalogCoversAllCodesAndFieldKeys` 报 `missing field.too_young for zh` 等。

- [ ] **Step 7: 加错误码与三语文案**

`api/internal/platform/apperr/apperr.go`：在错误码 `const` 块末尾追加：

```go
	CodeCouponInvalid    = "COUPON_INVALID"
	CodeCouponExhausted  = "COUPON_EXHAUSTED"
	CodeCategorySoldOut  = "CATEGORY_SOLD_OUT"
	CodePriceTierSoldOut = "PRICE_TIER_SOLD_OUT"
```

在 `AllCodes` 切片末尾追加：

```go
	CodeCouponInvalid,
	CodeCouponExhausted,
	CodeCategorySoldOut,
	CodePriceTierSoldOut,
```

`api/internal/platform/i18n/messages.zh.json` 加入以下键（与已有键并列，保持合法 JSON）：

```json
  "COUPON_INVALID": "优惠码不可用。",
  "COUPON_EXHAUSTED": "优惠码已被用完。",
  "CATEGORY_SOLD_OUT": "该组别名额已满。",
  "PRICE_TIER_SOLD_OUT": "当前价格档刚刚售罄，请重新确认费用。",
  "field.too_young": "比赛当天须年满 {minAge} 岁。",
  "field.category_unavailable": "该组别当前不可报名。",
  "field.coupon_invalid": "优惠码不可用。"
```

`messages.en.json`：

```json
  "COUPON_INVALID": "This coupon code can't be used.",
  "COUPON_EXHAUSTED": "This coupon code has been fully used.",
  "CATEGORY_SOLD_OUT": "This category is sold out.",
  "PRICE_TIER_SOLD_OUT": "The current price tier just sold out. Please check the price again.",
  "field.too_young": "Must be at least {minAge} on race day.",
  "field.category_unavailable": "This category isn't available right now.",
  "field.coupon_invalid": "This coupon code can't be used."
```

`messages.km.json`：

```json
  "COUPON_INVALID": "មិនអាចប្រើលេខកូដបញ្ចុះតម្លៃនេះបានទេ។",
  "COUPON_EXHAUSTED": "លេខកូដបញ្ចុះតម្លៃនេះត្រូវបានប្រើអស់ហើយ។",
  "CATEGORY_SOLD_OUT": "ប្រភេទនេះពេញហើយ។",
  "PRICE_TIER_SOLD_OUT": "កម្រិតតម្លៃបច្ចុប្បន្នទើបតែលក់អស់។ សូមពិនិត្យតម្លៃម្តងទៀត។",
  "field.too_young": "ត្រូវមានអាយុយ៉ាងតិច {minAge} ឆ្នាំនៅថ្ងៃប្រកួត។",
  "field.category_unavailable": "ប្រភេទនេះមិនអាចចុះឈ្មោះបាននៅពេលនេះទេ។",
  "field.coupon_invalid": "មិនអាចប្រើលេខកូដបញ្ចុះតម្លៃនេះបានទេ។"
```

Run: `cd api && go test ./internal/platform/apperr/ ./internal/platform/i18n/`
Expected: `ok` ×2。

- [ ] **Step 8: 追加算价与计数查询并生成**

在 `api/db/queries/pricing.sql` 末尾追加：

```sql
-- name: QuoteListCategories :many
SELECT id, min_age
FROM event_categories
WHERE event_id = @event_id AND id = ANY(@category_ids::bigint[]);

-- name: QuoteListTierCandidates :many
SELECT cpr.category_id,
       pr.id AS price_rule_id,
       pr.audience,
       pr.price_cents,
       pr.quota,
       pr.used_count,
       pr.reserved_count,
       pr.sale_starts_at,
       pr.sale_ends_at,
       pr.sort_order
FROM category_price_rules cpr
JOIN price_rules pr ON pr.id = cpr.price_rule_id
WHERE pr.event_id = @event_id
  AND cpr.category_id = ANY(@category_ids::bigint[])
ORDER BY cpr.category_id, pr.id;

-- name: QuoteGetCouponByCode :one
SELECT id, event_id, discount_type, discount_value, quota, used_count, reserved_count,
       min_runners, valid_from, valid_until, status
FROM coupons
WHERE code = @code;

-- name: QuoteLockPaymentAccount :exec
SELECT pg_advisory_xact_lock(7301, @payment_account_id::int);

-- name: QuoteListOpenOrderAmounts :many
SELECT amount_cents
FROM reg_orders
WHERE payment_account_id = @payment_account_id::bigint
  AND status IN ('PENDING_PAYMENT', 'PROOF_SUBMITTED', 'PROOF_REJECTED');

-- name: ReserveCategorySeats :execrows
UPDATE event_categories
SET reserved_count = reserved_count + @seats::int
WHERE id = @id
  AND used_count + reserved_count + @seats::int <= capacity;

-- name: ReservePriceRuleSeats :execrows
UPDATE price_rules
SET reserved_count = reserved_count + @seats::int
WHERE id = @id
  AND (quota IS NULL OR used_count + reserved_count + @seats::int <= quota);

-- name: ReserveCouponUse :execrows
UPDATE coupons
SET reserved_count = reserved_count + 1
WHERE id = @id
  AND status = 'ACTIVE'
  AND used_count + reserved_count + 1 <= quota;

-- name: InsertCouponRedemption :exec
INSERT INTO coupon_redemptions (order_id, coupon_id, state, discount_cents)
VALUES (@order_id, @coupon_id, 'RESERVED', @discount_cents);

-- name: ListOrderCategorySeats :many
SELECT category_id, count(*)::int AS seats
FROM order_participants
WHERE order_id = @order_id
GROUP BY category_id
ORDER BY category_id;

-- name: ListOrderPriceRuleSeats :many
SELECT price_rule_id, count(*)::int AS seats
FROM order_participants
WHERE order_id = @order_id
GROUP BY price_rule_id
ORDER BY price_rule_id;

-- name: ConsumeCategorySeats :execrows
UPDATE event_categories
SET reserved_count = reserved_count - @seats::int,
    used_count = used_count + @seats::int
WHERE id = @id AND reserved_count >= @seats::int;

-- name: ConsumePriceRuleSeats :execrows
UPDATE price_rules
SET reserved_count = reserved_count - @seats::int,
    used_count = used_count + @seats::int
WHERE id = @id AND reserved_count >= @seats::int;

-- name: ReleaseCategorySeats :execrows
UPDATE event_categories
SET reserved_count = reserved_count - @seats::int
WHERE id = @id AND reserved_count >= @seats::int;

-- name: ReleasePriceRuleSeats :execrows
UPDATE price_rules
SET reserved_count = reserved_count - @seats::int
WHERE id = @id AND reserved_count >= @seats::int;

-- name: MarkCouponRedemption :one
UPDATE coupon_redemptions
SET state = @to_state::text, updated_at = now()
WHERE order_id = @order_id AND state = 'RESERVED'
RETURNING coupon_id;

-- name: ConsumeCouponUse :execrows
UPDATE coupons
SET reserved_count = reserved_count - 1,
    used_count = used_count + 1
WHERE id = @id AND reserved_count >= 1;

-- name: ReleaseCouponUse :execrows
UPDATE coupons
SET reserved_count = reserved_count - 1
WHERE id = @id AND reserved_count >= 1;
```

Run: `cd api && go tool sqlc generate && go build ./internal/pricing/...`
Expected: 无输出、退出码 0；`internal/pricing/store/pricing.sql.go` 出现 `QuoteListTierCandidatesRow`（字段 `CategoryID int64`、`PriceRuleID int64`、`Quota *int32`、`SaleStartsAt *time.Time`、`SortOrder int16`）、`ReserveCategorySeatsParams{Seats int32; ID int64}`、`func (q *Queries) QuoteLockPaymentAccount(ctx context.Context, paymentAccountID int32) error`、`func (q *Queries) QuoteListOpenOrderAmounts(ctx context.Context, paymentAccountID int64) ([]int64, error)`、`ListOrderCategorySeatsRow{CategoryID int64; Seats int32}`。用 `grep -n "type QuoteListCategoriesParams" -A3 internal/pricing/store/pricing.sql.go` 确认切片参数字段名为 `CategoryIds`（后续代码按此名字写）。

- [ ] **Step 9: 创建共用测试数据包 `testfixture`**

创建 `api/internal/testfixture/fixture.go`：

```go
// Package testfixture 用原生 SQL 为数据库测试造数据。只能被 _test.go 引用。
package testfixture

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/piicrypt"
	"werun/api/internal/runner"
)

const (
	BotToken       = "123456:fixture-bot-token"
	SessionSecret  = "fixture-session-secret-0123456789abcdef"
	PIIKey         = "0123456789abcdef0123456789abcdef"
	ConsentVersion = "REG-TEST-v1"
)

// Ptr 返回 v 的指针。
func Ptr[T any](v T) *T { return &v }

// Day 解析 YYYY-MM-DD 为 UTC 零点。
func Day(s string) time.Time {
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		panic(err)
	}
	return t
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func scanID(t testing.TB, pool *pgxpool.Pool, sql string, args ...any) int64 {
	t.Helper()
	var id int64
	require.NoError(t, pool.QueryRow(context.Background(), sql, args...).Scan(&id), sql)
	return id
}

// Exec 执行一条语句。
func Exec(t testing.TB, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	_, err := pool.Exec(context.Background(), sql, args...)
	require.NoError(t, err, sql)
}

// Count 执行 SELECT count(*) 类查询。
func Count(t testing.TB, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	require.NoError(t, pool.QueryRow(context.Background(), sql, args...).Scan(&n), sql)
	return n
}

// Counts 是一行计数。
type Counts struct {
	Used     int32
	Reserved int32
}

// CountersOf 读取 event_categories / price_rules / coupons 的 used_count 与 reserved_count。
func CountersOf(t testing.TB, pool *pgxpool.Pool, table string, id int64) Counts {
	t.Helper()
	switch table {
	case "event_categories", "price_rules", "coupons":
	default:
		t.Fatalf("testfixture: unsupported table %q", table)
	}
	var c Counts
	require.NoError(t, pool.QueryRow(context.Background(),
		"SELECT used_count, reserved_count FROM "+table+" WHERE id = $1", id).Scan(&c.Used, &c.Reserved))
	return c
}

// SetSetting 修改 system_settings 的值（jsonValue 为 JSON 文本，如 "5"）。
func SetSetting(t testing.TB, pool *pgxpool.Pool, key, jsonValue string) {
	t.Helper()
	Exec(t, pool, `UPDATE system_settings SET value = $2::jsonb WHERE key = $1`, key, jsonValue)
}

type CategoryOpts struct {
	Code     string
	Capacity int32
	MinAge   int16
}

type EventOpts struct {
	Slug             string
	RaceDate         time.Time // 零值时为 2026-11-15
	RegistrationOpen bool
	Categories       []CategoryOpts
}

type Event struct {
	ID          int64
	Slug        string
	RaceDate    time.Time
	CategoryIDs []int64
}

// RaceEvent 建一个已发布、公开展示的 RACE 赛事及其组别（组别三语名为 "<code> 组" / "<code> run" / "ការរត់ <code>"）。
func RaceEvent(t testing.TB, pool *pgxpool.Pool, o EventOpts) Event {
	t.Helper()
	if o.RaceDate.IsZero() {
		o.RaceDate = Day("2026-11-15")
	}
	const name = `{"zh":"金边半程马拉松 2026","en":"Phnom Penh Half Marathon 2026","km":"ម៉ារ៉ាតុងពាក់កណ្ដាលភ្នំពេញ ២០២៦"}`
	id := scanID(t, pool, `INSERT INTO events
		(slug, event_type, organizer_type, name, city, race_date, status, registration_open, public_visible, published_at)
		VALUES ($1, 'RACE', 'OFFICIAL', $2::jsonb, 'Phnom Penh', $3, 'PUBLISHED', $4, true, now())
		RETURNING id`, o.Slug, name, o.RaceDate, o.RegistrationOpen)
	ev := Event{ID: id, Slug: o.Slug, RaceDate: o.RaceDate}
	for i, c := range o.Categories {
		catName := fmt.Sprintf(`{"zh":"%[1]s 组","en":"%[1]s run","km":"ការរត់ %[1]s"}`, c.Code)
		cid := scanID(t, pool, `INSERT INTO event_categories
			(event_id, code, name, distance_m, capacity, min_age, sort_order, start_at, cutoff_at)
			VALUES ($1, $2, $3::jsonb, 21097, $4, $5, $6, '2026-11-15T06:00:00+07:00', '2026-11-15T09:30:00+07:00')
			RETURNING id`, id, c.Code, catName, c.Capacity, c.MinAge, int16(i))
		ev.CategoryIDs = append(ev.CategoryIDs, cid)
	}
	return ev
}

type PriceRuleOpts struct {
	Audience     string // 空串为 ALL
	PriceCents   int64
	Quota        *int32
	SaleStartsAt *time.Time
	SaleEndsAt   *time.Time
	SortOrder    int16
	CategoryIDs  []int64
}

// PriceRule 建价格档并关联组别。
func PriceRule(t testing.TB, pool *pgxpool.Pool, eventID int64, o PriceRuleOpts) int64 {
	t.Helper()
	if o.Audience == "" {
		o.Audience = "ALL"
	}
	id := scanID(t, pool, `INSERT INTO price_rules
		(event_id, name, audience, price_cents, quota, sale_starts_at, sale_ends_at, sort_order)
		VALUES ($1, '{"zh":"价格档","en":"Tier","km":"កម្រិតតម្លៃ"}'::jsonb, $2, $3, $4, $5, $6, $7)
		RETURNING id`, eventID, o.Audience, o.PriceCents, o.Quota, o.SaleStartsAt, o.SaleEndsAt, o.SortOrder)
	for _, cid := range o.CategoryIDs {
		Exec(t, pool, `INSERT INTO category_price_rules (category_id, price_rule_id) VALUES ($1, $2)`, cid, id)
	}
	return id
}

type CouponOpts struct {
	Code          string // 存大写
	EventID       *int64
	DiscountType  string
	DiscountValue int64
	Quota         int32
	MinRunners    *int16
	ValidFrom     *time.Time
	ValidUntil    *time.Time
	Status        string // 空串为 ACTIVE
}

// Coupon 建优惠码。
func Coupon(t testing.TB, pool *pgxpool.Pool, o CouponOpts) int64 {
	t.Helper()
	if o.Status == "" {
		o.Status = "ACTIVE"
	}
	return scanID(t, pool, `INSERT INTO coupons
		(code, event_id, discount_type, discount_value, quota, min_runners, valid_from, valid_until, status)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id`, o.Code, o.EventID, o.DiscountType, o.DiscountValue, o.Quota, o.MinRunners, o.ValidFrom, o.ValidUntil, o.Status)
}

// PaymentAccount 建一个启用的 USD 报名收款账户（附带 PUBLIC 二维码文件行）。
func PaymentAccount(t testing.TB, pool *pgxpool.Pool, eventID *int64) int64 {
	t.Helper()
	sha := make([]byte, 32)
	_, _ = rand.Read(sha)
	fileID := scanID(t, pool, `INSERT INTO files
		(storage_key, visibility, purpose, mime_type, size_bytes, sha256, width, height, uploaded_by_type)
		VALUES ($1, 'PUBLIC', 'PAYMENT_QR', 'image/png', 68, $2, 1, 1, 'STAFF')
		RETURNING id`, "2026/09/"+randHex(16)+".png", sha)
	return scanID(t, pool, `INSERT INTO payment_accounts
		(name, provider, account_name, account_no_masked, currency, qr_file_id, scope, event_id, active)
		VALUES ('ABA USD 主收款户', 'ABA', 'WERUN CO LTD', '*** *** 123', 'USD', $1, 'REGISTRATION', $2, true)
		RETURNING id`, fileID, eventID)
}

// Runner 建一个 Telegram 跑者账号。
func Runner(t testing.TB, pool *pgxpool.Pool, telegramID int64, name string) runner.User {
	t.Helper()
	username := "runner" + strconv.FormatInt(telegramID, 10)
	id := scanID(t, pool, `INSERT INTO users (telegram_user_id, telegram_username, display_name, locale)
		VALUES ($1, $2, $3, 'zh') RETURNING id`, telegramID, username, name)
	return runner.User{ID: id, TelegramUserID: telegramID, TelegramUsername: username, DisplayName: name, Locale: "zh"}
}

// PII 返回用固定测试密钥构造的证件号加密器。
func PII(t testing.TB) *piicrypt.Cipher {
	t.Helper()
	c, err := piicrypt.New([]byte(PIIKey))
	require.NoError(t, err)
	return c
}

// RunnerService 构造 runner.Service。
func RunnerService(t testing.TB, pool *pgxpool.Pool, now func() time.Time) *runner.Service {
	t.Helper()
	return runner.NewService(pool, []byte(SessionSecret), BotToken, PII(t), now)
}

// RegistrationConsent 发布中文 REGISTRATION 同意书 REG-TEST-v1（勾选项 rules、health、terms），返回全部勾选的签署输入。
func RegistrationConsent(t testing.TB, svc *runner.Service) runner.ConsentAcceptance {
	t.Helper()
	err := svc.PublishConsent(context.Background(), runner.PublishConsentInput{
		Purpose:       "REGISTRATION",
		Version:       ConsentVersion,
		Lang:          "zh",
		EffectiveDate: Day("2026-01-01"),
		FullText:      "# 报名同意书\n\n参赛者确认身体状况适合参赛，并遵守赛事规程。",
		Items: []runner.ConsentItem{
			{Key: "rules", Title: "遵守赛事规程", Description: "我已阅读并同意遵守赛事规程。"},
			{Key: "health", Title: "健康声明", Description: "我确认身体状况适合参加本次比赛。"},
			{Key: "terms", Title: "报名条款", Description: "我同意报名条款与隐私说明。"},
		},
	})
	require.NoError(t, err)
	return runner.ConsentAcceptance{Version: ConsentVersion, Lang: "zh", CheckedItems: []string{"rules", "health", "terms"}}
}

// Profile 返回一份可以通过 runner.ValidateProfile 的参赛资料。
func Profile(fullName, idNo, nationality, birthDate string) runner.ProfileData {
	return runner.ProfileData{
		FullName:       fullName,
		Gender:         "F",
		BirthDate:      Day(birthDate),
		Nationality:    nationality,
		IDType:         "PASSPORT",
		IDNo:           idNo,
		Phone:          "+85512345678",
		EmergencyName:  "Sok Dara",
		EmergencyPhone: "+85598765432",
		TShirtSize:     "M",
	}
}

type OrderParticipantOpts struct {
	CategoryID     int64
	PriceRuleID    int64
	ListPriceCents int64
	PaidCents      int64
}

type OrderOpts struct {
	EventID          int64
	BuyerUserID      *int64
	PaymentAccountID *int64
	Status           string // 空串为 PENDING_PAYMENT
	AmountCents      int64
	Participants     []OrderParticipantOpts
}

// Order 直接写一张订单（list_amount = amount，discount = 0）及其参赛人行，不改任何计数。
func Order(t testing.TB, pool *pgxpool.Pool, o OrderOpts) int64 {
	t.Helper()
	if o.Status == "" {
		o.Status = "PENDING_PAYMENT"
	}
	reservation := "RESERVED"
	var paidAt *time.Time
	switch o.Status {
	case "PAID":
		reservation = "CONSUMED"
		paidAt = Ptr(time.Now())
	case "EXPIRED", "CANCELLED":
		reservation = "RELEASED"
	}
	id := scanID(t, pool, `INSERT INTO reg_orders
		(order_no, event_id, buyer_user_id, buyer_name, buyer_phone_e164, status, reservation_state,
		 list_amount_cents, amount_cents, payment_account_id, paid_at, source)
		VALUES ($1, $2, $3, 'Fixture Buyer', '+85512000000', $4, $5, $6, $6, $7, $8, 'TELEGRAM')
		RETURNING id`, "WRFX"+randHex(4), o.EventID, o.BuyerUserID, o.Status, reservation, o.AmountCents, o.PaymentAccountID, paidAt)
	for _, p := range o.Participants {
		Exec(t, pool, `INSERT INTO order_participants
			(order_id, category_id, price_rule_id, audience, list_price_cents, paid_cents, snapshot_name)
			VALUES ($1, $2, $3, 'ALL', $4, $5, 'Fixture Runner')`, id, p.CategoryID, p.PriceRuleID, p.ListPriceCents, p.PaidCents)
	}
	return id
}
```

Run: `cd api && go vet ./internal/testfixture/`
Expected: 无输出。

- [ ] **Step 10: 写算价与计数的数据库失败测试**

创建 `api/internal/pricing/quote_db_test.go`：

```go
package pricing_test

import (
	"context"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/pricing"
	fx "werun/api/internal/testfixture"
)

var quoteNow = *at("2026-09-14T03:00:00Z")

func newPricing(t *testing.T) (*pgxpool.Pool, *pricing.Service) {
	t.Helper()
	pool := dbtest.NewPool(t)
	return pool, pricing.NewService(pool, func() time.Time { return quoteNow })
}

func quoteInTx(t *testing.T, pool *pgxpool.Pool, svc *pricing.Service, in pricing.QuoteInput) (pricing.Quote, error) {
	t.Helper()
	var out pricing.Quote
	err := db.InTx(context.Background(), pool, func(tx pgx.Tx) error {
		q, err := svc.Quote(context.Background(), tx, in)
		out = q
		return err
	})
	return out, err
}

func runTx(pool *pgxpool.Pool, fn func(ctx context.Context, tx pgx.Tx) error) error {
	ctx := context.Background()
	return db.InTx(ctx, pool, func(tx pgx.Tx) error { return fn(ctx, tx) })
}

func requireAppErr(t *testing.T, err error, code string, status int) *apperr.Error {
	t.Helper()
	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	require.Equal(t, code, ae.Code)
	require.Equal(t, status, ae.Status)
	return ae
}

func TestQuoteSelectsTiersAppliesCouponAndIdentOffset(t *testing.T) {
	pool, svc := newPricing(t)
	ev := fx.RaceEvent(t, pool, fx.EventOpts{Slug: "quote-run", RegistrationOpen: true,
		Categories: []fx.CategoryOpts{{Code: "21K", Capacity: 100, MinAge: 16}}})
	cat := ev.CategoryIDs[0]
	local := fx.PriceRule(t, pool, ev.ID, fx.PriceRuleOpts{Audience: "LOCAL", PriceCents: 1800, CategoryIDs: []int64{cat}})
	early := fx.PriceRule(t, pool, ev.ID, fx.PriceRuleOpts{PriceCents: 2000, Quota: fx.Ptr[int32](1),
		SaleEndsAt: at("2026-10-01T00:00:00Z"), CategoryIDs: []int64{cat}})
	standard := fx.PriceRule(t, pool, ev.ID, fx.PriceRuleOpts{PriceCents: 3000, CategoryIDs: []int64{cat}})
	couponID := fx.Coupon(t, pool, fx.CouponOpts{Code: "RUN10", EventID: &ev.ID, DiscountType: "PERCENT", DiscountValue: 10, Quota: 5})
	account := fx.PaymentAccount(t, pool, nil)
	fx.Order(t, pool, fx.OrderOpts{EventID: ev.ID, PaymentAccountID: &account, Status: "PENDING_PAYMENT", AmountCents: 6119})
	fx.Order(t, pool, fx.OrderOpts{EventID: ev.ID, PaymentAccountID: &account, Status: "PAID", AmountCents: 6118})

	in := pricing.QuoteInput{
		EventID:    ev.ID,
		RaceDate:   ev.RaceDate,
		CouponCode: " run10 ",
		Participants: []pricing.ParticipantInput{
			{CategoryID: cat, Nationality: "KH", BirthDate: day("1990-05-01")},
			{CategoryID: cat, Nationality: "US", BirthDate: day("1988-01-01")},
			{CategoryID: cat, Nationality: "us", BirthDate: day("1995-12-31")},
		},
		Now:              quoteNow,
		PaymentAccountID: &account,
	}

	q, err := quoteInTx(t, pool, svc, in)

	require.NoError(t, err)
	require.Equal(t, []pricing.ParticipantQuote{
		{CategoryID: cat, PriceRuleID: local, Audience: "LOCAL", ListPriceCents: 1800, PaidCents: 1620},
		{CategoryID: cat, PriceRuleID: early, Audience: "ALL", ListPriceCents: 2000, PaidCents: 1799},
		{CategoryID: cat, PriceRuleID: standard, Audience: "ALL", ListPriceCents: 3000, PaidCents: 2699},
	}, q.Participants)
	require.Equal(t, int64(6800), q.ListAmountCents)
	require.Equal(t, &couponID, q.CouponID)
	require.Equal(t, int64(680), q.CouponDiscountCents)
	require.Equal(t, int64(2), q.IdentOffsetCents, "6119 被待付款订单占用，6118 属于已付款订单不算占用")
	require.Equal(t, int64(682), q.DiscountCents)
	require.Equal(t, int64(6118), q.AmountCents)
	require.Equal(t, "USD", q.Currency)
	require.Equal(t, fx.Counts{}, fx.CountersOf(t, pool, "price_rules", early), "算价不改计数")

	in.PaymentAccountID = nil
	preview, err := quoteInTx(t, pool, svc, in)
	require.NoError(t, err)
	require.Equal(t, int64(0), preview.IdentOffsetCents)
	require.Equal(t, int64(6120), preview.AmountCents)
	require.Equal(t, []int64{1620, 1800, 2700},
		[]int64{preview.Participants[0].PaidCents, preview.Participants[1].PaidCents, preview.Participants[2].PaidCents})
}

func TestQuoteIdentOffsetHonoursSettingMax(t *testing.T) {
	pool, svc := newPricing(t)
	ev := fx.RaceEvent(t, pool, fx.EventOpts{Slug: "ident-max", Categories: []fx.CategoryOpts{{Code: "10K", Capacity: 10}}})
	fx.PriceRule(t, pool, ev.ID, fx.PriceRuleOpts{PriceCents: 2500, CategoryIDs: ev.CategoryIDs})
	account := fx.PaymentAccount(t, pool, &ev.ID)
	fx.Order(t, pool, fx.OrderOpts{EventID: ev.ID, PaymentAccountID: &account, Status: "PROOF_REJECTED", AmountCents: 2499})
	fx.SetSetting(t, pool, "payment.ident_offset_max_cents", "1")

	q, err := quoteInTx(t, pool, svc, pricing.QuoteInput{EventID: ev.ID, RaceDate: ev.RaceDate, Now: quoteNow, PaymentAccountID: &account,
		Participants: []pricing.ParticipantInput{{CategoryID: ev.CategoryIDs[0], Nationality: "US", BirthDate: day("1990-01-01")}}})

	require.NoError(t, err)
	require.Equal(t, int64(0), q.IdentOffsetCents)
	require.Equal(t, int64(2500), q.AmountCents)
}

func TestQuoteReportsAgeAndCategoryFieldErrors(t *testing.T) {
	pool, svc := newPricing(t)
	ev := fx.RaceEvent(t, pool, fx.EventOpts{Slug: "age-run", Categories: []fx.CategoryOpts{
		{Code: "21K", Capacity: 100, MinAge: 16},
		{Code: "5K", Capacity: 100},
	}})
	other := fx.RaceEvent(t, pool, fx.EventOpts{Slug: "other-run", Categories: []fx.CategoryOpts{{Code: "10K", Capacity: 100}}})
	fx.PriceRule(t, pool, ev.ID, fx.PriceRuleOpts{PriceCents: 2500, CategoryIDs: []int64{ev.CategoryIDs[0]}})
	fx.PriceRule(t, pool, other.ID, fx.PriceRuleOpts{PriceCents: 1000, CategoryIDs: other.CategoryIDs})

	_, err := quoteInTx(t, pool, svc, pricing.QuoteInput{EventID: ev.ID, RaceDate: ev.RaceDate, Now: quoteNow,
		Participants: []pricing.ParticipantInput{
			{CategoryID: ev.CategoryIDs[0], Nationality: "KH", BirthDate: day("2012-01-01")},
			{CategoryID: other.CategoryIDs[0], Nationality: "KH", BirthDate: day("1990-01-01")},
			{CategoryID: ev.CategoryIDs[1], Nationality: "KH", BirthDate: day("1990-01-01")},
		}})

	ae := requireAppErr(t, err, apperr.CodeValidation, http.StatusUnprocessableEntity)
	require.Equal(t, apperr.FieldError{Key: "field.too_young", Params: map[string]any{"minAge": 16}}, ae.Fields["participants[0].birthDate"])
	require.Equal(t, "field.category_unavailable", ae.Fields["participants[1].categoryId"].Key, "别的赛事的组别")
	require.Equal(t, "field.category_unavailable", ae.Fields["participants[2].categoryId"].Key, "没有关联价格档的组别")
}

func TestQuoteCouponRules(t *testing.T) {
	pool, svc := newPricing(t)
	ev := fx.RaceEvent(t, pool, fx.EventOpts{Slug: "coupon-run", Categories: []fx.CategoryOpts{{Code: "21K", Capacity: 100}}})
	other := fx.RaceEvent(t, pool, fx.EventOpts{Slug: "coupon-other", Categories: []fx.CategoryOpts{{Code: "10K", Capacity: 100}}})
	fx.PriceRule(t, pool, ev.ID, fx.PriceRuleOpts{PriceCents: 2500, CategoryIDs: ev.CategoryIDs})
	fx.Coupon(t, pool, fx.CouponOpts{Code: "OTHER1", EventID: &other.ID, DiscountType: "PERCENT", DiscountValue: 10, Quota: 5})
	fx.Coupon(t, pool, fx.CouponOpts{Code: "OFF1", DiscountType: "PERCENT", DiscountValue: 10, Quota: 5, Status: "DISABLED"})
	fx.Coupon(t, pool, fx.CouponOpts{Code: "OLD1", DiscountType: "PERCENT", DiscountValue: 10, Quota: 5, ValidUntil: at("2026-09-01T00:00:00Z")})
	fx.Coupon(t, pool, fx.CouponOpts{Code: "SOON1", DiscountType: "PERCENT", DiscountValue: 10, Quota: 5, ValidFrom: at("2026-10-01T00:00:00Z")})
	fx.Coupon(t, pool, fx.CouponOpts{Code: "TRIO1", DiscountType: "PERCENT", DiscountValue: 10, Quota: 5, MinRunners: fx.Ptr[int16](3)})
	fx.Coupon(t, pool, fx.CouponOpts{Code: "USED1", DiscountType: "PERCENT", DiscountValue: 10, Quota: 1})
	fx.Exec(t, pool, `UPDATE coupons SET reserved_count = 1 WHERE code = 'USED1'`)
	global := fx.Coupon(t, pool, fx.CouponOpts{Code: "GLOBAL1", DiscountType: "AMOUNT", DiscountValue: 700, Quota: 5,
		ValidFrom: at("2026-09-01T00:00:00Z"), ValidUntil: at("2026-09-30T00:00:00Z")})

	in := func(code string) pricing.QuoteInput {
		return pricing.QuoteInput{EventID: ev.ID, RaceDate: ev.RaceDate, Now: quoteNow, CouponCode: code,
			Participants: []pricing.ParticipantInput{
				{CategoryID: ev.CategoryIDs[0], Nationality: "US", BirthDate: day("1990-01-01")},
				{CategoryID: ev.CategoryIDs[0], Nationality: "US", BirthDate: day("1991-01-01")},
			}}
	}

	for _, code := range []string{"NOPE", "other1", "OFF1", "OLD1", "SOON1", "TRIO1"} {
		t.Run("不可用 "+code, func(t *testing.T) {
			_, err := quoteInTx(t, pool, svc, in(code))
			ae := requireAppErr(t, err, apperr.CodeCouponInvalid, http.StatusUnprocessableEntity)
			require.Equal(t, "field.coupon_invalid", ae.Fields["couponCode"].Key)
		})
	}
	t.Run("次数用完", func(t *testing.T) {
		_, err := quoteInTx(t, pool, svc, in("used1"))
		requireAppErr(t, err, apperr.CodeCouponExhausted, http.StatusConflict)
	})
	t.Run("全场通用固定金额码", func(t *testing.T) {
		q, err := quoteInTx(t, pool, svc, in("global1"))
		require.NoError(t, err)
		require.Equal(t, &global, q.CouponID)
		require.Equal(t, int64(700), q.CouponDiscountCents)
		require.Equal(t, int64(4300), q.AmountCents)
		require.Equal(t, int64(2150), q.Participants[0].PaidCents)
		require.Equal(t, int64(2150), q.Participants[1].PaidCents)
	})
}

type counterFixture struct {
	pool   *pgxpool.Pool
	svc    *pricing.Service
	ev     fx.Event
	rule   int64
	coupon int64
}

func newCounterFixture(t *testing.T, capacity int32, ruleQuota *int32, couponQuota int32) counterFixture {
	t.Helper()
	pool, svc := newPricing(t)
	ev := fx.RaceEvent(t, pool, fx.EventOpts{Slug: "counter-run", Categories: []fx.CategoryOpts{{Code: "21K", Capacity: capacity}}})
	rule := fx.PriceRule(t, pool, ev.ID, fx.PriceRuleOpts{PriceCents: 2500, Quota: ruleQuota, CategoryIDs: ev.CategoryIDs})
	coupon := fx.Coupon(t, pool, fx.CouponOpts{Code: "RUN20", EventID: &ev.ID, DiscountType: "PERCENT", DiscountValue: 20, Quota: couponQuota})
	return counterFixture{pool: pool, svc: svc, ev: ev, rule: rule, coupon: coupon}
}

func (f counterFixture) quote(n int, withCoupon bool) pricing.Quote {
	q := pricing.Quote{Currency: "USD"}
	for range n {
		q.Participants = append(q.Participants, pricing.ParticipantQuote{
			CategoryID: f.ev.CategoryIDs[0], PriceRuleID: f.rule, Audience: "ALL", ListPriceCents: 2500, PaidCents: 2000})
		q.ListAmountCents += 2500
	}
	if withCoupon {
		id := f.coupon
		q.CouponID = &id
		q.CouponDiscountCents = q.ListAmountCents / 5
	}
	q.DiscountCents = q.CouponDiscountCents
	q.AmountCents = q.ListAmountCents - q.DiscountCents
	return q
}

func (f counterFixture) order(t *testing.T, q pricing.Quote) int64 {
	t.Helper()
	opts := fx.OrderOpts{EventID: f.ev.ID, AmountCents: q.AmountCents}
	for _, p := range q.Participants {
		opts.Participants = append(opts.Participants, fx.OrderParticipantOpts{
			CategoryID: p.CategoryID, PriceRuleID: p.PriceRuleID, ListPriceCents: p.ListPriceCents, PaidCents: p.PaidCents})
	}
	return fx.Order(t, f.pool, opts)
}

func (f counterFixture) requireCounts(t *testing.T, cat, rule, coupon fx.Counts) {
	t.Helper()
	require.Equal(t, cat, fx.CountersOf(t, f.pool, "event_categories", f.ev.CategoryIDs[0]), "组别计数")
	require.Equal(t, rule, fx.CountersOf(t, f.pool, "price_rules", f.rule), "价格档计数")
	require.Equal(t, coupon, fx.CountersOf(t, f.pool, "coupons", f.coupon), "优惠码计数")
}

func TestReserveConsumeAndReleaseMoveCounters(t *testing.T) {
	f := newCounterFixture(t, 10, fx.Ptr[int32](5), 3)
	q := f.quote(2, true)

	require.NoError(t, runTx(f.pool, func(ctx context.Context, tx pgx.Tx) error { return f.svc.Reserve(ctx, tx, q) }))
	f.requireCounts(t, fx.Counts{Reserved: 2}, fx.Counts{Reserved: 2}, fx.Counts{Reserved: 1})

	orderA := f.order(t, q)
	require.NoError(t, runTx(f.pool, func(ctx context.Context, tx pgx.Tx) error { return f.svc.RecordRedemption(ctx, tx, orderA, q) }))
	require.Equal(t, 1, fx.Count(t, f.pool,
		`SELECT count(*) FROM coupon_redemptions WHERE order_id = $1 AND coupon_id = $2 AND state = 'RESERVED' AND discount_cents = 1000`, orderA, f.coupon))

	require.NoError(t, runTx(f.pool, func(ctx context.Context, tx pgx.Tx) error { return f.svc.Consume(ctx, tx, orderA) }))
	f.requireCounts(t, fx.Counts{Used: 2}, fx.Counts{Used: 2}, fx.Counts{Used: 1})
	require.Equal(t, 1, fx.Count(t, f.pool, `SELECT count(*) FROM coupon_redemptions WHERE order_id = $1 AND state = 'CONSUMED'`, orderA))

	q2 := f.quote(1, true)
	require.NoError(t, runTx(f.pool, func(ctx context.Context, tx pgx.Tx) error { return f.svc.Reserve(ctx, tx, q2) }))
	orderB := f.order(t, q2)
	require.NoError(t, runTx(f.pool, func(ctx context.Context, tx pgx.Tx) error { return f.svc.RecordRedemption(ctx, tx, orderB, q2) }))
	f.requireCounts(t, fx.Counts{Used: 2, Reserved: 1}, fx.Counts{Used: 2, Reserved: 1}, fx.Counts{Used: 1, Reserved: 1})

	require.NoError(t, runTx(f.pool, func(ctx context.Context, tx pgx.Tx) error { return f.svc.Release(ctx, tx, orderB) }))
	f.requireCounts(t, fx.Counts{Used: 2}, fx.Counts{Used: 2}, fx.Counts{Used: 1})
	require.Equal(t, 1, fx.Count(t, f.pool, `SELECT count(*) FROM coupon_redemptions WHERE order_id = $1 AND state = 'RELEASED'`, orderB))

	err := runTx(f.pool, func(ctx context.Context, tx pgx.Tx) error { return f.svc.Release(ctx, tx, orderB) })
	require.Error(t, err, "预留已经释放过，再释放不能把计数减成负数")
	f.requireCounts(t, fx.Counts{Used: 2}, fx.Counts{Used: 2}, fx.Counts{Used: 1})
}

func TestRecordRedemptionWithoutCouponDoesNothing(t *testing.T) {
	f := newCounterFixture(t, 10, nil, 3)
	q := f.quote(1, false)
	orderID := f.order(t, q)

	require.NoError(t, runTx(f.pool, func(ctx context.Context, tx pgx.Tx) error { return f.svc.RecordRedemption(ctx, tx, orderID, q) }))

	require.Equal(t, 0, fx.Count(t, f.pool, `SELECT count(*) FROM coupon_redemptions`))
}

func TestReserveSoldOutErrorsRollBackAllCounters(t *testing.T) {
	f := newCounterFixture(t, 1, fx.Ptr[int32](1), 1)

	fx.Exec(t, f.pool, `UPDATE event_categories SET reserved_count = 1 WHERE id = $1`, f.ev.CategoryIDs[0])
	err := runTx(f.pool, func(ctx context.Context, tx pgx.Tx) error { return f.svc.Reserve(ctx, tx, f.quote(1, true)) })
	requireAppErr(t, err, apperr.CodeCategorySoldOut, http.StatusConflict)
	f.requireCounts(t, fx.Counts{Reserved: 1}, fx.Counts{}, fx.Counts{})

	fx.Exec(t, f.pool, `UPDATE event_categories SET reserved_count = 0 WHERE id = $1`, f.ev.CategoryIDs[0])
	fx.Exec(t, f.pool, `UPDATE price_rules SET used_count = 1 WHERE id = $1`, f.rule)
	err = runTx(f.pool, func(ctx context.Context, tx pgx.Tx) error { return f.svc.Reserve(ctx, tx, f.quote(1, true)) })
	requireAppErr(t, err, apperr.CodePriceTierSoldOut, http.StatusConflict)
	f.requireCounts(t, fx.Counts{}, fx.Counts{Used: 1}, fx.Counts{})

	fx.Exec(t, f.pool, `UPDATE price_rules SET used_count = 0 WHERE id = $1`, f.rule)
	fx.Exec(t, f.pool, `UPDATE coupons SET used_count = 1 WHERE id = $1`, f.coupon)
	err = runTx(f.pool, func(ctx context.Context, tx pgx.Tx) error { return f.svc.Reserve(ctx, tx, f.quote(1, true)) })
	requireAppErr(t, err, apperr.CodeCouponExhausted, http.StatusConflict)
	f.requireCounts(t, fx.Counts{}, fx.Counts{}, fx.Counts{Used: 1})
}

func TestReserveLastSeatConcurrently(t *testing.T) {
	f := newCounterFixture(t, 1, nil, 1)
	q := f.quote(1, false)

	const workers = 20
	var (
		wg      sync.WaitGroup
		success atomic.Int32
		mu      sync.Mutex
		errs    []error
	)
	start := make(chan struct{})
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			err := runTx(f.pool, func(ctx context.Context, tx pgx.Tx) error { return f.svc.Reserve(ctx, tx, q) })
			if err == nil {
				success.Add(1)
				return
			}
			mu.Lock()
			errs = append(errs, err)
			mu.Unlock()
		}()
	}
	close(start)
	wg.Wait()

	require.EqualValues(t, 1, success.Load())
	require.Len(t, errs, workers-1)
	for _, err := range errs {
		requireAppErr(t, err, apperr.CodeCategorySoldOut, http.StatusConflict)
	}
	f.requireCounts(t, fx.Counts{Reserved: 1}, fx.Counts{Reserved: 1}, fx.Counts{})
}
```

- [ ] **Step 11: 运行数据库测试，确认失败**

Run: `cd api && env $DBENV go test ./internal/pricing/ -run 'TestQuote|TestReserve|TestRecordRedemption'`
Expected: 编译失败：`svc.Quote undefined (type *pricing.Service has no field or method Quote)`、`svc.Reserve undefined` 等。

- [ ] **Step 12: 实现 `Quote` 与计数方法**

把 `api/internal/pricing/quote.go` 的 import 块替换为：

```go
import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/settings"
	"werun/api/internal/pricing/store"
)
```

在 `quote.go` 末尾追加：

```go
// Quote 在调用方事务里按 spec 5 算价。PaymentAccountID 非空且扣除优惠码后仍需付款时，
// 先对收款账户加事务级 advisory 锁，再从该账户未完成订单的应付金额中避开，选出识别分。
func (s *Service) Quote(ctx context.Context, tx pgx.Tx, in QuoteInput) (Quote, error) {
	q := store.New(tx)

	categoryIDs := make([]int64, 0, len(in.Participants))
	for _, p := range in.Participants {
		if !slices.Contains(categoryIDs, p.CategoryID) {
			categoryIDs = append(categoryIDs, p.CategoryID)
		}
	}
	catRows, err := q.QuoteListCategories(ctx, store.QuoteListCategoriesParams{EventID: in.EventID, CategoryIds: categoryIDs})
	if err != nil {
		return Quote{}, fmt.Errorf("quote: list categories: %w", err)
	}
	minAges := make(map[int64]int, len(catRows))
	for _, c := range catRows {
		minAges[c.ID] = int(c.MinAge)
	}
	tierRows, err := q.QuoteListTierCandidates(ctx, store.QuoteListTierCandidatesParams{EventID: in.EventID, CategoryIds: categoryIDs})
	if err != nil {
		return Quote{}, fmt.Errorf("quote: list price tiers: %w", err)
	}
	cands := make(map[int64][]TierCandidate, len(categoryIDs))
	for _, r := range tierRows {
		cands[r.CategoryID] = append(cands[r.CategoryID], TierCandidate{
			PriceRuleID:   r.PriceRuleID,
			Audience:      r.Audience,
			PriceCents:    r.PriceCents,
			Quota:         r.Quota,
			UsedCount:     r.UsedCount,
			ReservedCount: r.ReservedCount,
			SaleStartsAt:  r.SaleStartsAt,
			SaleEndsAt:    r.SaleEndsAt,
			SortOrder:     r.SortOrder,
		})
	}

	out := Quote{Currency: quoteCurrency, Participants: make([]ParticipantQuote, 0, len(in.Participants))}
	verr := apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)
	failed := false
	taken := map[int64]int{}
	for i, p := range in.Participants {
		prefix := fmt.Sprintf("participants[%d].", i)
		minAge, ok := minAges[p.CategoryID]
		if !ok {
			verr = verr.WithField(prefix+"categoryId", "field.category_unavailable", nil)
			failed = true
			continue
		}
		if AgeOn(p.BirthDate, in.RaceDate) < minAge {
			verr = verr.WithField(prefix+"birthDate", "field.too_young", map[string]any{"minAge": minAge})
			failed = true
		}
		tier, ok := SelectTier(cands[p.CategoryID], strings.ToUpper(strings.TrimSpace(p.Nationality)), in.Now, taken)
		if !ok {
			verr = verr.WithField(prefix+"categoryId", "field.category_unavailable", nil)
			failed = true
			continue
		}
		taken[tier.PriceRuleID]++
		out.Participants = append(out.Participants, ParticipantQuote{
			CategoryID:     p.CategoryID,
			PriceRuleID:    tier.PriceRuleID,
			Audience:       tier.Audience,
			ListPriceCents: tier.PriceCents,
		})
		out.ListAmountCents += tier.PriceCents
	}
	if failed {
		return Quote{}, verr
	}

	if code := strings.ToUpper(strings.TrimSpace(in.CouponCode)); code != "" {
		id, rule, err := checkCoupon(ctx, q, code, in)
		if err != nil {
			return Quote{}, err
		}
		out.CouponID = &id
		out.CouponDiscountCents = CouponDiscount(rule, out.ListAmountCents)
	}

	afterCoupon := out.ListAmountCents - out.CouponDiscountCents
	if in.PaymentAccountID != nil && afterCoupon > 0 {
		offset, err := pickIdentOffsetLocked(ctx, tx, q, *in.PaymentAccountID, afterCoupon)
		if err != nil {
			return Quote{}, err
		}
		out.IdentOffsetCents = offset
	}
	out.DiscountCents = out.CouponDiscountCents + out.IdentOffsetCents
	out.AmountCents = out.ListAmountCents - out.DiscountCents

	prices := make([]int64, len(out.Participants))
	for i, p := range out.Participants {
		prices[i] = p.ListPriceCents
	}
	for i, paid := range Allocate(prices, out.DiscountCents) {
		out.Participants[i].PaidCents = paid
	}
	return out, nil
}

// checkCoupon 校验优惠码（code 已转大写）。不可用返回 COUPON_INVALID（字段 couponCode），次数用完返回 COUPON_EXHAUSTED。
func checkCoupon(ctx context.Context, q *store.Queries, code string, in QuoteInput) (int64, CouponRule, error) {
	invalid := apperr.New(http.StatusUnprocessableEntity, apperr.CodeCouponInvalid).
		WithField("couponCode", "field.coupon_invalid", nil)
	c, err := q.QuoteGetCouponByCode(ctx, code)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, CouponRule{}, invalid
	}
	if err != nil {
		return 0, CouponRule{}, fmt.Errorf("quote: load coupon: %w", err)
	}
	if c.Status != "ACTIVE" ||
		(c.EventID != nil && *c.EventID != in.EventID) ||
		(c.ValidFrom != nil && c.ValidFrom.After(in.Now)) ||
		(c.ValidUntil != nil && !c.ValidUntil.After(in.Now)) ||
		(c.MinRunners != nil && int(*c.MinRunners) > len(in.Participants)) {
		return 0, CouponRule{}, invalid
	}
	if int64(c.UsedCount)+int64(c.ReservedCount) >= int64(c.Quota) {
		return 0, CouponRule{}, apperr.New(http.StatusConflict, apperr.CodeCouponExhausted)
	}
	return c.ID, CouponRule{DiscountType: c.DiscountType, DiscountValue: c.DiscountValue}, nil
}

func pickIdentOffsetLocked(ctx context.Context, tx pgx.Tx, q *store.Queries, accountID, afterCoupon int64) (int64, error) {
	if err := q.QuoteLockPaymentAccount(ctx, int32(accountID)); err != nil {
		return 0, fmt.Errorf("quote: lock payment account %d: %w", accountID, err)
	}
	amounts, err := q.QuoteListOpenOrderAmounts(ctx, accountID)
	if err != nil {
		return 0, fmt.Errorf("quote: list open order amounts: %w", err)
	}
	pay, err := settings.LoadPayment(ctx, tx)
	if err != nil {
		return 0, fmt.Errorf("quote: load payment settings: %w", err)
	}
	taken := make(map[int64]bool, len(amounts))
	for _, a := range amounts {
		taken[a] = true
	}
	return PickIdentOffset(afterCoupon, taken, pay.IdentOffsetMaxCents), nil
}
```

创建 `api/internal/pricing/counters.go`：

```go
package pricing

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/pricing/store"
)

// 组别、价格档、优惠码三类计数只由本文件修改（免费活动报名除外）。
// 所有更新都按 组别 → 价格档 → 优惠码、同类按 id 升序执行，避免并发事务互相死锁。

type seatCount struct {
	id    int64
	seats int32
}

func groupSeats(q Quote, key func(ParticipantQuote) int64) []seatCount {
	counts := map[int64]int32{}
	for _, p := range q.Participants {
		counts[key(p)]++
	}
	out := make([]seatCount, 0, len(counts))
	for id, n := range counts {
		out = append(out, seatCount{id: id, seats: n})
	}
	slices.SortFunc(out, func(a, b seatCount) int { return cmp.Compare(a.id, b.id) })
	return out
}

// Reserve 按合并人数对组别、价格档做条件预留，有优惠码时预留一次使用；任何一条影响 0 行即返回对应 409 错误，
// 由调用方回滚整个事务。
func (s *Service) Reserve(ctx context.Context, tx pgx.Tx, q Quote) error {
	st := store.New(tx)
	for _, c := range groupSeats(q, func(p ParticipantQuote) int64 { return p.CategoryID }) {
		n, err := st.ReserveCategorySeats(ctx, store.ReserveCategorySeatsParams{Seats: c.seats, ID: c.id})
		if err != nil {
			return fmt.Errorf("reserve category %d: %w", c.id, err)
		}
		if n == 0 {
			return apperr.New(http.StatusConflict, apperr.CodeCategorySoldOut)
		}
	}
	for _, r := range groupSeats(q, func(p ParticipantQuote) int64 { return p.PriceRuleID }) {
		n, err := st.ReservePriceRuleSeats(ctx, store.ReservePriceRuleSeatsParams{Seats: r.seats, ID: r.id})
		if err != nil {
			return fmt.Errorf("reserve price rule %d: %w", r.id, err)
		}
		if n == 0 {
			return apperr.New(http.StatusConflict, apperr.CodePriceTierSoldOut)
		}
	}
	if q.CouponID != nil {
		n, err := st.ReserveCouponUse(ctx, *q.CouponID)
		if err != nil {
			return fmt.Errorf("reserve coupon %d: %w", *q.CouponID, err)
		}
		if n == 0 {
			return apperr.New(http.StatusConflict, apperr.CodeCouponExhausted)
		}
	}
	return nil
}

// RecordRedemption 在订单写入后记录优惠码核销（RESERVED）；没有优惠码时什么都不做。
func (s *Service) RecordRedemption(ctx context.Context, tx pgx.Tx, orderID int64, q Quote) error {
	if q.CouponID == nil {
		return nil
	}
	err := store.New(tx).InsertCouponRedemption(ctx, store.InsertCouponRedemptionParams{
		OrderID:       orderID,
		CouponID:      *q.CouponID,
		DiscountCents: q.CouponDiscountCents,
	})
	if err != nil {
		return fmt.Errorf("record coupon redemption for order %d: %w", orderID, err)
	}
	return nil
}

// Consume 把订单占用的名额从 reserved 转入 used，核销记录改为 CONSUMED。
// 调用方必须先用订单上的 reservation_state 条件更新保证每张订单只调用一次。
func (s *Service) Consume(ctx context.Context, tx pgx.Tx, orderID int64) error {
	return moveCounters(ctx, store.New(tx), orderID, true)
}

// Release 释放订单占用的名额，核销记录改为 RELEASED。调用约束同 Consume。
func (s *Service) Release(ctx context.Context, tx pgx.Tx, orderID int64) error {
	return moveCounters(ctx, store.New(tx), orderID, false)
}

func moveCounters(ctx context.Context, q *store.Queries, orderID int64, consume bool) error {
	verb := "release"
	if consume {
		verb = "consume"
	}

	cats, err := q.ListOrderCategorySeats(ctx, orderID)
	if err != nil {
		return fmt.Errorf("%s: list category seats of order %d: %w", verb, orderID, err)
	}
	for _, c := range cats {
		var n int64
		if consume {
			n, err = q.ConsumeCategorySeats(ctx, store.ConsumeCategorySeatsParams{Seats: c.Seats, ID: c.CategoryID})
		} else {
			n, err = q.ReleaseCategorySeats(ctx, store.ReleaseCategorySeatsParams{Seats: c.Seats, ID: c.CategoryID})
		}
		if err != nil {
			return fmt.Errorf("%s category %d: %w", verb, c.CategoryID, err)
		}
		if n == 0 {
			return fmt.Errorf("%s category %d for order %d: fewer than %d reserved seats", verb, c.CategoryID, orderID, c.Seats)
		}
	}

	rules, err := q.ListOrderPriceRuleSeats(ctx, orderID)
	if err != nil {
		return fmt.Errorf("%s: list price rule seats of order %d: %w", verb, orderID, err)
	}
	for _, r := range rules {
		var n int64
		if consume {
			n, err = q.ConsumePriceRuleSeats(ctx, store.ConsumePriceRuleSeatsParams{Seats: r.Seats, ID: r.PriceRuleID})
		} else {
			n, err = q.ReleasePriceRuleSeats(ctx, store.ReleasePriceRuleSeatsParams{Seats: r.Seats, ID: r.PriceRuleID})
		}
		if err != nil {
			return fmt.Errorf("%s price rule %d: %w", verb, r.PriceRuleID, err)
		}
		if n == 0 {
			return fmt.Errorf("%s price rule %d for order %d: fewer than %d reserved seats", verb, r.PriceRuleID, orderID, r.Seats)
		}
	}

	state := "RELEASED"
	if consume {
		state = "CONSUMED"
	}
	couponID, err := q.MarkCouponRedemption(ctx, store.MarkCouponRedemptionParams{ToState: state, OrderID: orderID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("%s coupon redemption of order %d: %w", verb, orderID, err)
	}
	var n int64
	if consume {
		n, err = q.ConsumeCouponUse(ctx, couponID)
	} else {
		n, err = q.ReleaseCouponUse(ctx, couponID)
	}
	if err != nil {
		return fmt.Errorf("%s coupon %d: %w", verb, couponID, err)
	}
	if n == 0 {
		return fmt.Errorf("%s coupon %d for order %d: no reserved use", verb, couponID, orderID)
	}
	return nil
}
```

> `TestReserveConsumeAndReleaseMoveCounters` 最后一次 `Release` 的失败来自 `ListOrderCategorySeats` 仍返回 1 行而 `reserved_count` 已为 0，条件更新影响 0 行；核销记录此时已是 RELEASED 不会再改。整个事务回滚，计数不变。

- [ ] **Step 13: 运行数据库测试，确认通过并验证并发稳定**

Run: `cd api && env $DBENV go test ./internal/pricing/ -run 'TestQuote|TestReserve|TestRecordRedemption' -v`
Expected: `TestQuoteSelectsTiersAppliesCouponAndIdentOffset`、`TestQuoteIdentOffsetHonoursSettingMax`、`TestQuoteReportsAgeAndCategoryFieldErrors`、`TestQuoteCouponRules`（8 个子测试）、`TestReserveConsumeAndReleaseMoveCounters`、`TestRecordRedemptionWithoutCouponDoesNothing`、`TestReserveSoldOutErrorsRollBackAllCounters`、`TestReserveLastSeatConcurrently` 全部 PASS。

Run: `cd api && env $DBENV go test ./internal/pricing/ -run TestReserveLastSeatConcurrently -count=5`
Expected: `ok`（5 次全部通过）。

- [ ] **Step 14: 全量检查并提交**

Run: `cd api && env $DBENV go test ./... && go tool golangci-lint run ./...`
Expected: 所有包 `ok`；golangci-lint 输出 `0 issues.`。

```bash
git add api/db/queries/pricing.sql api/internal/pricing api/internal/testfixture \
  api/internal/platform/apperr api/internal/platform/i18n
git commit -m "$(cat <<'EOF'
feat(api): quote registrations and reserve, consume and release pricing counters

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
)"
```

---

### Task 12: 下单

**Files:**
- Create: `api/db/queries/registration.sql`
- Modify: `api/sqlc.yaml`（追加 registration 段）
- Generate: `api/internal/registration/store/`
- Create: `api/internal/registration/model.go`
- Create: `api/internal/registration/service.go`
- Create: `api/internal/registration/create.go`
- Create: `api/internal/registration/orders.go`（本任务只放 `loadDetail`，Task 13 追加）
- Create: `api/internal/registration/handlers.go`
- Test: `api/internal/registration/create_internal_test.go`（无数据库）
- Test: `api/internal/registration/create_test.go`（数据库）
- Modify: `api/openapi/openapi.yaml`（`appQuote`、`appCreateOrder` 及 schema；`PublicEvent`、`PublicCategory` 加字段）
- Generate: `api/internal/httpapi/apigen/api.gen.go`、`permissions.gen.go`、`packages/api-client/src/schema.d.ts`
- Modify: `api/internal/event/model.go`、`api/internal/event/service.go`、`api/internal/event/handlers.go`、`api/internal/event/service_test.go`、`api/internal/httpapi/events_http_test.go`
- Modify: `api/internal/httpapi/server.go`、`api/internal/httpapi/router.go`、`api/cmd/werun/app.go`、`api/cmd/werun/router.go`
- Test: `api/internal/httpapi/registration_http_test.go`
- Modify: `api/internal/platform/apperr/apperr.go`、`apperr_test.go`、`api/internal/platform/i18n/messages.{zh,en,km}.json`、`catalog_test.go`
- Modify: `web/user/src/test/fixtures.ts`

**Interfaces:**
- Consumes:
  - Task 11：`pricing.Quote/Reserve/RecordRedemption/Consume`、`pricing.QuoteInput`、`pricing.ParticipantInput`、`pricing.Quote`、`testfixture.*`
  - `runner.ValidateProfile(p ProfileData, fieldPrefix string) error`、`(*runner.Service).LoadProfileForOrder(ctx, tx, u, id, fieldPrefix) (ProfileData, error)`、`CreateProfileTx(ctx, tx, u, p) (int64, error)`、`SignConsent(ctx, tx, u, acc, meta, link) error`、`PII() *piicrypt.Cipher`、`CreateProfile`、`LoginTelegram`、`SignInitData`、`runner.UserFrom(ctx)`、`runner.ConsentLink{RegOrderID *int64}`
  - `piicrypt.NormalizeIDNo`、`(*Cipher).Encrypt/Hash`；`idgen.Code/TicketCode/Retry`、`idgen.PrefixOrder/PrefixRegistration`；`settings.LoadPayment`（`UploadWindow`）
  - `audit.Record`、`db.InTx`、`httpx.Meta/MetaOf`
- Produces（照抄契约，另加契约补充 2、5、8）:

```go
type OrderParticipantInput struct { CategoryID int64; ProfileID *int64; Profile *runner.ProfileData; SaveAsProfile bool }
type CreateOrderInput struct { EventSlug string; CouponCode string; Consent runner.ConsentAcceptance; Participants []OrderParticipantInput; IdempotencyKey string }
type QuotePreviewInput struct { CouponCode string; Participants []pricing.ParticipantInput }
type Order struct { ID, EventID, BuyerUserID int64; OrderNo, Status, ReservationState string; ListAmountCents, DiscountCents, IdentOffsetCents, AmountCents int64; Currency string; PaymentAccountID int64; DeadlineAt, PaidAt *time.Time; CreatedAt time.Time }
type OrderParticipant struct { RegistrationID int64; RegNo string; CategoryID int64; CategoryName i18n.Text; FullName string; PriceRuleID, ListPriceCents, PaidCents int64; RegistrationStatus string; TicketCode *string }
type PaymentAccountView struct { ID int64; Name, Provider, AccountName, AccountNoMasked string; QRFileID int64 }
type LastRejection struct { Code string; Reason *string; ReviewedAt time.Time }
type OrderDetail struct { Order; EventSlug string; EventName i18n.Text; EventTimezone string; Participants []OrderParticipant; PaymentAccount PaymentAccountView; LastRejection *LastRejection }
type OrderSummary struct { Order; EventSlug string; EventName i18n.Text; ParticipantCount int }
func NewService(pool *pgxpool.Pool, runners *runner.Service, prices *pricing.Service, now func() time.Time) *Service
func (s *Service) PreviewQuote(ctx context.Context, u runner.User, slug string, in QuotePreviewInput) (pricing.Quote, error)
func (s *Service) CreateOrder(ctx context.Context, u runner.User, in CreateOrderInput, meta httpx.Meta) (OrderDetail, error)
func (s *Service) ConfirmPaid(ctx context.Context, tx pgx.Tx, orderID int64, paidAt time.Time) error
func NewHandlers(svc *Service) *Handlers // AppQuote、AppCreateOrder
```

  - 错误码：`CodeRegistrationClosed`(409)、`CodeAlreadyRegistered`(409)、`CodePaymentAccountUnavailable`(503)、`CodeIdempotencyKeyReused`(422)、`CodeOrderStateConflict`(409)；字段文案 `field.duplicate_id_no`、`field.already_registered`。
  - 审计 `reg_order.create`、`reg_order.paid_zero`（`entity_type = reg_order`，`ActorType = USER`，`IsFinancial = true`）。
  - `httpapi.RegistrationHandlers = registration.Handlers`、`RouterDeps.Registration`、`App.Registration`。
  - 公开赛事接口字段（调整 #8）：`PublicEvent.id/eventType/registrationOpen/registrationOpensAt/registrationClosesAt`、`PublicCategory.id/minAge/soldOut`。

**数据库事实**（`0001`、`0003`、`0005`、`0009`、`0010`）：
- `idempotency_keys` 主键 `(scope, subject, key)`，`request_hash bytea`，`response_code int NULL`，`response_body jsonb NULL`，`expires_at NOT NULL`。
- `reg_orders`：`order_no UNIQUE`（约束名 `reg_orders_order_no_key`），`source IN (...,'TELEGRAM')`，`ident_offset_cents smallint BETWEEN 0 AND 50`，触发器 `reg_orders_event_type` 要求赛事为 RACE；`payment_account_id` 可空。
- `registrations`：`reg_no UNIQUE`（`registrations_reg_no_key`）、`ticket_code UNIQUE`（`registrations_ticket_code_key`）、`order_participant_id UNIQUE`，`CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL))`，`id_type`、`phone_e164`、`email`、`emergency_*`、`tshirt_size` 可空。
- 唯一约束冲突会让 PostgreSQL 事务进入 aborted 状态，所以 `idgen.Retry` 包住的插入必须在保存点里执行（pgx `tx.Begin(ctx)` 即 `SAVEPOINT`，失败时回滚到保存点）。
- `payment_accounts`：`active`、`currency IN ('USD','KHR')`、`scope IN ('REGISTRATION','MERCH','ALL')`、`event_id` 可空。
- `payment_proofs`：`reg_order_id`、`status`、`reject_code`、`reject_reason`、`reviewed_at`。
- `registration_consents (signature_id, reg_order_id, free_signup_id)`，`disclaimer_signatures.user_id`。

**oapi-codegen v2.8.0 已核对**：必填请求头缺失时，生成的 gin 包装器在进入 strict 中间件之前调用 `ErrorHandler(c, err, 400)`（本项目转成 `BAD_REQUEST`），所以「缺 `Idempotency-Key`」先于鉴权返回 400；请求头参数进入 `AppCreateOrderRequestObject.Params.IdempotencyKey`（`string`）。生成器不校验 `minLength`/`pattern`，格式由服务层校验。

- [ ] **Step 1: 写错误码与文案的失败测试**

`api/internal/platform/apperr/apperr_test.go`：`assert.Len(t, apperr.AllCodes, 27)` 改为 `assert.Len(t, apperr.AllCodes, 32)`。

`api/internal/platform/i18n/catalog_test.go`：在 `"field.coupon_invalid",` 之后加入：

```go
		"field.duplicate_id_no",
		"field.already_registered",
```

Run: `cd api && go test ./internal/platform/apperr/ ./internal/platform/i18n/`
Expected: FAIL：`should have 32 item(s), but has 27`；`missing field.duplicate_id_no for zh`。

- [ ] **Step 2: 加错误码与三语文案**

`apperr.go` 错误码 `const` 块末尾追加：

```go
	CodeRegistrationClosed        = "REGISTRATION_CLOSED"
	CodeAlreadyRegistered         = "ALREADY_REGISTERED"
	CodePaymentAccountUnavailable = "PAYMENT_ACCOUNT_UNAVAILABLE"
	CodeIdempotencyKeyReused      = "IDEMPOTENCY_KEY_REUSED"
	CodeOrderStateConflict        = "ORDER_STATE_CONFLICT"
```

`AllCodes` 末尾追加：

```go
	CodeRegistrationClosed,
	CodeAlreadyRegistered,
	CodePaymentAccountUnavailable,
	CodeIdempotencyKeyReused,
	CodeOrderStateConflict,
```

`messages.zh.json` 加入：

```json
  "REGISTRATION_CLOSED": "报名未开放或已截止。",
  "ALREADY_REGISTERED": "有参赛人已报名本赛事。",
  "PAYMENT_ACCOUNT_UNAVAILABLE": "暂时无法收款，请稍后再试。",
  "IDEMPOTENCY_KEY_REUSED": "这次提交与之前的请求内容不一致，请刷新页面后重试。",
  "ORDER_STATE_CONFLICT": "订单当前状态不允许这个操作。",
  "field.duplicate_id_no": "同一订单里证件号不能重复。",
  "field.already_registered": "该证件号已报名本赛事。"
```

`messages.en.json` 加入：

```json
  "REGISTRATION_CLOSED": "Registration is not open.",
  "ALREADY_REGISTERED": "A participant is already registered for this event.",
  "PAYMENT_ACCOUNT_UNAVAILABLE": "Payments are temporarily unavailable. Please try again later.",
  "IDEMPOTENCY_KEY_REUSED": "This submission doesn't match the earlier request. Please refresh the page and try again.",
  "ORDER_STATE_CONFLICT": "This action isn't allowed for the order's current status.",
  "field.duplicate_id_no": "The same ID number appears twice in this order.",
  "field.already_registered": "This ID number is already registered for this event."
```

`messages.km.json` 加入：

```json
  "REGISTRATION_CLOSED": "ការចុះឈ្មោះមិនទាន់បើក ឬបានបិទហើយ។",
  "ALREADY_REGISTERED": "មានអ្នកចូលរួមម្នាក់បានចុះឈ្មោះក្នុងព្រឹត្តិការណ៍នេះរួចហើយ។",
  "PAYMENT_ACCOUNT_UNAVAILABLE": "មិនអាចទទួលការបង់ប្រាក់បានជាបណ្ដោះអាសន្ន។ សូមព្យាយាមម្តងទៀតនៅពេលក្រោយ។",
  "IDEMPOTENCY_KEY_REUSED": "ការដាក់ស្នើនេះមិនដូចសំណើមុនទេ។ សូមផ្ទុកទំព័រឡើងវិញ ហើយព្យាយាមម្តងទៀត។",
  "ORDER_STATE_CONFLICT": "ស្ថានភាពបច្ចុប្បន្ននៃការបញ្ជាទិញមិនអនុញ្ញាតឱ្យធ្វើសកម្មភាពនេះទេ។",
  "field.duplicate_id_no": "លេខអត្តសញ្ញាណដូចគ្នាមិនអាចប្រើពីរដងក្នុងការបញ្ជាទិញតែមួយបានទេ។",
  "field.already_registered": "លេខអត្តសញ្ញាណនេះបានចុះឈ្មោះក្នុងព្រឹត្តិការណ៍នេះរួចហើយ។"
```

Run: `cd api && go test ./internal/platform/apperr/ ./internal/platform/i18n/`
Expected: `ok` ×2。

- [ ] **Step 3: 写 registration 查询并生成 store**

创建 `api/db/queries/registration.sql`：

```sql
-- name: ClaimIdempotencyKey :one
-- 新键直接插入；已过期的同名键被覆盖；未过期的同名键不返回行（并等待持有它的事务结束）。
INSERT INTO idempotency_keys (key, scope, subject, request_hash, created_at, expires_at)
VALUES (@key, @scope, @subject, @request_hash, @now, @expires_at)
ON CONFLICT (scope, subject, key) DO UPDATE
SET request_hash = EXCLUDED.request_hash,
    response_code = NULL,
    response_body = NULL,
    created_at = EXCLUDED.created_at,
    expires_at = EXCLUDED.expires_at
WHERE idempotency_keys.expires_at <= EXCLUDED.created_at
RETURNING key;

-- name: GetIdempotencyKey :one
SELECT request_hash, response_code, response_body
FROM idempotency_keys
WHERE scope = @scope AND subject = @subject AND key = @key;

-- name: SaveIdempotencyResponse :exec
UPDATE idempotency_keys
SET response_code = @response_code::int, response_body = @response_body::jsonb
WHERE scope = @scope AND subject = @subject AND key = @key;

-- name: LockEventForOrder :one
SELECT id, slug, event_type, status, registration_open, registration_opens_at, registration_closes_at, race_date
FROM events
WHERE slug = @slug
FOR SHARE;

-- name: GetEventForQuote :one
SELECT id, event_type, status, race_date
FROM events
WHERE slug = @slug;

-- name: LockIDNoHash :exec
SELECT pg_advisory_xact_lock(hashtextextended(@event_id::bigint::text || ':' || encode(@id_no_hash::bytea, 'hex'), 7302));

-- name: ListRegisteredIDNoHashes :many
SELECT id_no_hash
FROM registrations
WHERE event_id = @event_id::bigint
  AND status IN ('PENDING', 'CONFIRMED')
  AND id_no_hash = ANY(@hashes::bytea[]);

-- name: SelectRegistrationPaymentAccount :one
SELECT id
FROM payment_accounts
WHERE active
  AND currency = 'USD'
  AND scope IN ('REGISTRATION', 'ALL')
  AND (event_id = @event_id::bigint OR event_id IS NULL)
ORDER BY (event_id IS NULL), id
LIMIT 1;

-- name: InsertRegOrder :one
INSERT INTO reg_orders (
  order_no, event_id, buyer_user_id, buyer_name, buyer_phone_e164, buyer_email,
  status, reservation_state, list_amount_cents, discount_cents, ident_offset_cents, amount_cents,
  currency, coupon_id, payment_account_id, deadline_at, source
) VALUES (
  @order_no, @event_id, @buyer_user_id, @buyer_name, @buyer_phone_e164, @buyer_email,
  'PENDING_PAYMENT', 'RESERVED', @list_amount_cents, @discount_cents, @ident_offset_cents, @amount_cents,
  'USD', @coupon_id, @payment_account_id, @deadline_at, 'TELEGRAM'
)
RETURNING id;

-- name: InsertOrderParticipant :one
INSERT INTO order_participants (order_id, category_id, price_rule_id, audience, list_price_cents, paid_cents, snapshot_name)
VALUES (@order_id, @category_id, @price_rule_id, @audience, @list_price_cents, @paid_cents, @snapshot_name)
RETURNING id;

-- name: InsertRegistration :one
INSERT INTO registrations (
  reg_no, order_participant_id, event_id, category_id, status, ticket_code, user_id,
  full_name, gender, birth_date, nationality, id_type, id_no_enc, id_no_hash,
  phone_e164, email, emergency_name, emergency_phone, tshirt_size
) VALUES (
  @reg_no, @order_participant_id, @event_id, @category_id, 'PENDING', @ticket_code, @user_id,
  @full_name, @gender, @birth_date, @nationality, @id_type, @id_no_enc, @id_no_hash,
  @phone_e164, @email, @emergency_name, @emergency_phone, @tshirt_size
)
RETURNING id;

-- name: MarkOrderPaid :execrows
UPDATE reg_orders
SET status = 'PAID',
    paid_at = @paid_at::timestamptz,
    deadline_at = NULL,
    reservation_state = 'CONSUMED',
    version = version + 1
WHERE id = @id
  AND reservation_state = 'RESERVED'
  AND (status = 'PROOF_SUBMITTED' OR (status = 'PENDING_PAYMENT' AND amount_cents = 0));

-- name: ConfirmOrderRegistrations :execrows
UPDATE registrations r
SET status = 'CONFIRMED', confirmed_at = @confirmed_at::timestamptz, version = r.version + 1
FROM order_participants op
WHERE op.id = r.order_participant_id
  AND op.order_id = @order_id::bigint
  AND r.status = 'PENDING';

-- name: GetOrderDetailByID :one
SELECT o.id, o.order_no, o.event_id, o.buyer_user_id, o.status, o.reservation_state,
       o.list_amount_cents, o.discount_cents, o.ident_offset_cents, o.amount_cents, o.currency,
       o.payment_account_id, o.deadline_at, o.paid_at, o.created_at,
       e.slug AS event_slug, e.name AS event_name, e.timezone AS event_timezone
FROM reg_orders o
JOIN events e ON e.id = o.event_id
WHERE o.id = @id;

-- name: ListOrderParticipantDetails :many
SELECT r.id AS registration_id, r.reg_no, op.category_id, ec.name AS category_name, r.full_name,
       op.price_rule_id, op.list_price_cents, op.paid_cents, r.status AS registration_status, r.ticket_code
FROM order_participants op
JOIN registrations r ON r.order_participant_id = op.id
JOIN event_categories ec ON ec.id = op.category_id
WHERE op.order_id = @order_id
ORDER BY op.id;

-- name: GetOrderPaymentAccount :one
SELECT id, name, provider, account_name, account_no_masked, qr_file_id
FROM payment_accounts
WHERE id = @id;

-- name: GetLastRejectedProof :one
SELECT reject_code, reject_reason, reviewed_at
FROM payment_proofs
WHERE reg_order_id = @reg_order_id::bigint AND status = 'REJECTED'
ORDER BY reviewed_at DESC, id DESC
LIMIT 1;
```

在 `api/sqlc.yaml` 的 `sql:` 列表末尾追加：

```yaml
  - engine: postgresql
    schema: db/migrations
    queries: db/queries/registration.sql
    gen:
      go:
        package: store
        out: internal/registration/store
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

Run: `cd api && go tool sqlc generate && go build ./internal/registration/store/`
Expected: 退出码 0。核对生成结果（后续代码依赖这些名字）：

```bash
cd api
grep -n "type InsertRegOrderParams" -A15 internal/registration/store/registration.sql.go      # IdentOffsetCents int16；BuyerUserID/CouponID/PaymentAccountID *int64；BuyerEmail *string；DeadlineAt *time.Time
grep -n "type InsertRegistrationParams" -A20 internal/registration/store/registration.sql.go  # UserID *int64；IDType/PhoneE164/Email/EmergencyName/EmergencyPhone/TshirtSize *string；IDNoEnc/IDNoHash []byte
grep -n "type LockIDNoHashParams\|type ListRegisteredIDNoHashesParams" -A3 internal/registration/store/registration.sql.go  # EventID int64；IDNoHash []byte；Hashes [][]byte
grep -n "func (q \*Queries) SelectRegistrationPaymentAccount\|func (q \*Queries) GetLastRejectedProof\|func (q \*Queries) ConfirmOrderRegistrations" internal/registration/store/registration.sql.go
```

- [ ] **Step 4: 在 OpenAPI 中加入算价、下单接口与公开赛事字段，并生成**

在 `api/openapi/openapi.yaml` 的 `paths:` 段末尾（`components:` 一行之前）追加：

```yaml
  /app/events/{slug}/quote:
    post:
      operationId: appQuote
      summary: 报名算价预览（不占名额、不选识别分）
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
              $ref: '#/components/schemas/QuoteRequest'
      responses:
        '200':
          description: 算价结果
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Quote'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
  /app/orders:
    post:
      operationId: appCreateOrder
      summary: 下单并占名额；应付为 0 时直接确认
      x-auth: app
      parameters:
        - name: Idempotency-Key
          in: header
          required: true
          description: 8–64 位 [A-Za-z0-9_-]；同一次提交重试时保持不变
          schema:
            type: string
            minLength: 8
            maxLength: 64
            pattern: '^[A-Za-z0-9_-]+$'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateOrderRequest'
      responses:
        '201':
          description: 已下单（同键同请求体重放时返回首次响应）
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/OrderDetail'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
```

把 `components.schemas` 中的 `PublicCategory` 与 `PublicEvent` 两个 schema 整段替换为：

```yaml
    PublicCategory:
      type: object
      required: [id, code, name, distanceM, capacity, startAt, cutoffAt, minAge, soldOut]
      properties:
        id:
          type: integer
          format: int64
        code:
          type: string
        name:
          type: string
        distanceM:
          type: integer
          format: int32
        capacity:
          type: integer
          format: int32
        startAt:
          type: string
          format: date-time
        cutoffAt:
          type: string
          format: date-time
        minAge:
          type: integer
          format: int32
        soldOut:
          type: boolean
          description: used_count + reserved_count >= capacity
    PublicEvent:
      type: object
      required: [id, slug, eventType, name, city, raceDate, registrationOpen, registrationOpensAt, registrationClosesAt, categories]
      properties:
        id:
          type: integer
          format: int64
        slug:
          type: string
        eventType:
          type: string
          enum: [RACE, FREE_ACTIVITY]
        name:
          type: string
        city:
          type: string
        raceDate:
          type: string
          format: date
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
        categories:
          type: array
          items:
            $ref: '#/components/schemas/PublicCategory'
```

在 `components.schemas` 末尾追加：

```yaml
    QuoteParticipantInput:
      type: object
      required: [categoryId, nationality, birthDate]
      properties:
        categoryId:
          type: integer
          format: int64
        nationality:
          type: string
          minLength: 2
          maxLength: 2
        birthDate:
          type: string
          format: date
    QuoteRequest:
      type: object
      required: [participants]
      properties:
        couponCode:
          type: string
          maxLength: 64
        participants:
          type: array
          minItems: 1
          maxItems: 10
          items:
            $ref: '#/components/schemas/QuoteParticipantInput'
    QuoteParticipant:
      type: object
      required: [categoryId, priceRuleId, audience, listPriceCents, paidCents]
      properties:
        categoryId:
          type: integer
          format: int64
        priceRuleId:
          type: integer
          format: int64
        audience:
          type: string
          enum: [ALL, LOCAL]
        listPriceCents:
          type: integer
          format: int64
        paidCents:
          type: integer
          format: int64
    Quote:
      type: object
      required: [participants, listAmountCents, couponApplied, couponDiscountCents, identOffsetCents, discountCents, amountCents, currency]
      properties:
        participants:
          type: array
          items:
            $ref: '#/components/schemas/QuoteParticipant'
        listAmountCents:
          type: integer
          format: int64
        couponApplied:
          type: boolean
        couponDiscountCents:
          type: integer
          format: int64
        identOffsetCents:
          type: integer
          format: int64
        discountCents:
          type: integer
          format: int64
        amountCents:
          type: integer
          format: int64
        currency:
          type: string
    OrderProfileInput:
      type: object
      required: [fullName, gender, birthDate, nationality, idType, idNo, phone, emergencyName, emergencyPhone, tshirtSize]
      properties:
        fullName:
          type: string
        gender:
          type: string
          enum: [M, F, X]
        birthDate:
          type: string
          format: date
        nationality:
          type: string
        idType:
          type: string
          enum: [NATIONAL_ID, PASSPORT, OTHER]
        idNo:
          type: string
        phone:
          type: string
        email:
          type: string
        emergencyName:
          type: string
        emergencyPhone:
          type: string
        tshirtSize:
          type: string
          enum: [XS, S, M, L, XL, XXL]
    OrderParticipantInput:
      type: object
      required: [categoryId]
      description: profileId 与 profile 二选一
      properties:
        categoryId:
          type: integer
          format: int64
        profileId:
          type: integer
          format: int64
        profile:
          $ref: '#/components/schemas/OrderProfileInput'
        saveAsProfile:
          type: boolean
    OrderConsentInput:
      type: object
      required: [version, lang, checkedItems]
      properties:
        version:
          type: string
        lang:
          type: string
          enum: [zh, en, km]
        checkedItems:
          type: array
          items:
            type: string
    CreateOrderRequest:
      type: object
      required: [eventSlug, consent, participants]
      properties:
        eventSlug:
          type: string
        couponCode:
          type: string
          maxLength: 64
        consent:
          $ref: '#/components/schemas/OrderConsentInput'
        participants:
          type: array
          minItems: 1
          maxItems: 10
          items:
            $ref: '#/components/schemas/OrderParticipantInput'
    OrderStatus:
      type: string
      enum: [PENDING_PAYMENT, PROOF_SUBMITTED, PROOF_REJECTED, PAID, PARTIALLY_REFUNDED, REFUNDED, EXPIRED, CANCELLED]
    OrderParticipant:
      type: object
      required: [regNo, categoryId, categoryName, fullName, priceRuleId, listPriceCents, paidCents, registrationStatus]
      properties:
        regNo:
          type: string
        categoryId:
          type: integer
          format: int64
        categoryName:
          $ref: '#/components/schemas/LocalizedText'
        fullName:
          type: string
        priceRuleId:
          type: integer
          format: int64
        listPriceCents:
          type: integer
          format: int64
        paidCents:
          type: integer
          format: int64
        registrationStatus:
          type: string
          enum: [PENDING, CONFIRMED, CANCELLED]
        ticketCode:
          type: string
          description: 仅 CONFIRMED 时返回
    OrderPaymentAccount:
      type: object
      required: [id, name, provider, accountName, accountNoMasked, qrFileId]
      properties:
        id:
          type: integer
          format: int64
        name:
          type: string
        provider:
          type: string
        accountName:
          type: string
        accountNoMasked:
          type: string
        qrFileId:
          type: integer
          format: int64
    OrderRejection:
      type: object
      required: [code, reviewedAt]
      properties:
        code:
          type: string
        reason:
          type: string
        reviewedAt:
          type: string
          format: date-time
    OrderDetail:
      type: object
      required: [orderNo, status, eventSlug, eventName, eventTimezone, listAmountCents, discountCents, identOffsetCents, amountCents, currency, deadlineAt, paidAt, createdAt, participants, paymentAccount]
      properties:
        orderNo:
          type: string
        status:
          $ref: '#/components/schemas/OrderStatus'
        eventSlug:
          type: string
        eventName:
          $ref: '#/components/schemas/LocalizedText'
        eventTimezone:
          type: string
        listAmountCents:
          type: integer
          format: int64
        discountCents:
          type: integer
          format: int64
          description: 优惠码减免 + 识别分
        identOffsetCents:
          type: integer
          format: int64
        amountCents:
          type: integer
          format: int64
        currency:
          type: string
        deadlineAt:
          type: string
          format: date-time
          nullable: true
        paidAt:
          type: string
          format: date-time
          nullable: true
        createdAt:
          type: string
          format: date-time
        participants:
          type: array
          items:
            $ref: '#/components/schemas/OrderParticipant'
        paymentAccount:
          $ref: '#/components/schemas/OrderPaymentAccount'
        lastRejection:
          $ref: '#/components/schemas/OrderRejection'
```

Run: `make gen`
Expected: 生成成功；`api/internal/httpapi/apigen/permissions.gen.go` 出现 `"AppCreateOrder": {Kind: AuthApp}` 与 `"AppQuote": {Kind: AuthApp}`；`api.gen.go` 出现 `type AppCreateOrderParams struct { IdempotencyKey string ... }`、`type QuoteParticipantAudience string`、`type OrderProfileInputGender string`、`type OrderProfileInputIdType string`、`type OrderProfileInputTshirtSize string`、`type OrderConsentInputLang string`、`type OrderParticipantRegistrationStatus string`、`type OrderStatus string`、`type PublicEventEventType string`。

Run: `cd api && go build ./...`
Expected: 失败：`*Server does not implement StrictServerInterface (missing method AppCreateOrder)`。（`PublicEvent`、`PublicCategory` 新字段是值类型，旧的 `toPublicEvent` 仍能编译，由 Step 9 的测试驱动补齐。）

- [ ] **Step 5: 写下单的失败测试（无数据库部分）**

创建 `api/internal/registration/create_internal_test.go`：

```go
package registration

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/runner"
)

func ptr[T any](v T) *T { return &v }

func validCreateInput() CreateOrderInput {
	return CreateOrderInput{
		EventSlug:      " pphm-2026 ",
		CouponCode:     " run20 ",
		IdempotencyKey: "0f8e1c2a-7b1d-4c55-9e0e-1a2b3c4d5e6f",
		Consent:        runner.ConsentAcceptance{Version: "REG-TEST-v1", Lang: "zh", CheckedItems: []string{"terms", "rules", "health"}},
		Participants: []OrderParticipantInput{
			{
				CategoryID: 11,
				Profile: &runner.ProfileData{
					FullName: "Chan Sophea", Gender: "F", BirthDate: time.Date(1990, 5, 1, 0, 0, 0, 0, time.UTC),
					Nationality: "kh", IDType: "PASSPORT", IDNo: "n0 1234-567", Phone: "+85512345678",
					EmergencyName: "Sok Dara", EmergencyPhone: "+85598765432", TShirtSize: "M",
				},
				SaveAsProfile: true,
			},
			{CategoryID: 11, ProfileID: ptr(int64(5)), SaveAsProfile: true},
		},
	}
}

func TestNormalizeCreateInputCleansValues(t *testing.T) {
	in := validCreateInput()

	out, err := normalizeCreateInput(in)

	require.NoError(t, err)
	require.Equal(t, "pphm-2026", out.EventSlug)
	require.Equal(t, "RUN20", out.CouponCode)
	require.Equal(t, []string{"health", "rules", "terms"}, out.Consent.CheckedItems)
	require.Equal(t, "N01234567", out.Participants[0].Profile.IDNo)
	require.Equal(t, "KH", out.Participants[0].Profile.Nationality)
	require.True(t, out.Participants[0].SaveAsProfile)
	require.Equal(t, int64(5), *out.Participants[1].ProfileID)
	require.False(t, out.Participants[1].SaveAsProfile, "选常用参赛人时 saveAsProfile 无意义，归一为 false")
	require.Equal(t, "n0 1234-567", in.Participants[0].Profile.IDNo, "不修改调用方的输入")
	require.Equal(t, []string{"terms", "rules", "health"}, in.Consent.CheckedItems)
}

func TestNormalizeCreateInputReportsFieldErrors(t *testing.T) {
	eleven := make([]OrderParticipantInput, 11)
	for i := range eleven {
		eleven[i] = OrderParticipantInput{CategoryID: 11, ProfileID: ptr(int64(i + 1))}
	}
	cases := []struct {
		name   string
		mutate func(in *CreateOrderInput)
		field  string
		key    string
	}{
		{"幂等键太短", func(in *CreateOrderInput) { in.IdempotencyKey = "short" }, "idempotencyKey", "field.invalid"},
		{"幂等键含空格", func(in *CreateOrderInput) { in.IdempotencyKey = "has space in it" }, "idempotencyKey", "field.invalid"},
		{"幂等键超过 64 位", func(in *CreateOrderInput) { in.IdempotencyKey = fmt.Sprintf("%065d", 0) }, "idempotencyKey", "field.invalid"},
		{"赛事为空", func(in *CreateOrderInput) { in.EventSlug = "  " }, "eventSlug", "field.required"},
		{"没有参赛人", func(in *CreateOrderInput) { in.Participants = nil }, "participants", "field.invalid"},
		{"超过 10 人", func(in *CreateOrderInput) { in.Participants = eleven }, "participants", "field.invalid"},
		{"缺组别", func(in *CreateOrderInput) { in.Participants[0].CategoryID = 0 }, "participants[0].categoryId", "field.required"},
		{"既没选常用参赛人也没填资料", func(in *CreateOrderInput) { in.Participants[1].ProfileID = nil }, "participants[1].profileId", "field.required"},
		{"同时给了两种", func(in *CreateOrderInput) {
			in.Participants[1].Profile = in.Participants[0].Profile
		}, "participants[1].profileId", "field.invalid"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := validCreateInput()
			tc.mutate(&in)

			_, err := normalizeCreateInput(in)

			ae, ok := apperr.As(err)
			require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
			require.Equal(t, apperr.CodeValidation, ae.Code)
			require.Equal(t, http.StatusUnprocessableEntity, ae.Status)
			require.Equal(t, tc.key, ae.Fields[tc.field].Key, "fields=%v", ae.Fields)
		})
	}

	t.Run("资料校验沿用 runner.ValidateProfile 并带参赛人前缀", func(t *testing.T) {
		in := validCreateInput()
		in.Participants[0].Profile.FullName = ""

		_, err := normalizeCreateInput(in)

		ae, ok := apperr.As(err)
		require.True(t, ok)
		require.Contains(t, ae.Fields, "participants[0].fullName")
	})
}

func TestRequestHashIgnoresKeyItemOrderAndFormatting(t *testing.T) {
	a := validCreateInput()
	b := validCreateInput()
	b.IdempotencyKey = "another-key-123"
	b.CouponCode = "RUN20"
	b.Consent.CheckedItems = []string{"health", "terms", "rules"}
	b.Participants[0].Profile.IDNo = "N01234567"
	c := validCreateInput()
	c.Participants[0].CategoryID = 12

	hash := func(in CreateOrderInput) []byte {
		t.Helper()
		norm, err := normalizeCreateInput(in)
		require.NoError(t, err)
		h, err := requestHash(norm)
		require.NoError(t, err)
		require.Len(t, h, 32)
		return h
	}

	require.Equal(t, hash(a), hash(b))
	require.NotEqual(t, hash(a), hash(c))
}

func TestRegistrationOpen(t *testing.T) {
	now := time.Date(2026, 9, 14, 3, 0, 0, 0, time.UTC)
	before := now.Add(-time.Minute)
	after := now.Add(time.Minute)
	cases := []struct {
		name      string
		status    string
		eventType string
		open      bool
		opensAt   *time.Time
		closesAt  *time.Time
		want      bool
	}{
		{"已发布、开放、不限时间", "PUBLISHED", "RACE", true, nil, nil, true},
		{"开关关闭", "PUBLISHED", "RACE", false, nil, nil, false},
		{"草稿", "DRAFT", "RACE", true, nil, nil, false},
		{"免费活动不走订单", "PUBLISHED", "FREE_ACTIVITY", true, nil, nil, false},
		{"尚未开始", "PUBLISHED", "RACE", true, &after, nil, false},
		{"开始时间等于现在", "PUBLISHED", "RACE", true, &now, nil, true},
		{"已截止", "PUBLISHED", "RACE", true, nil, &before, false},
		{"截止时间等于现在", "PUBLISHED", "RACE", true, nil, &now, false},
		{"时间窗内", "PUBLISHED", "RACE", true, &before, &after, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, registrationOpen(tc.status, tc.eventType, tc.open, tc.opensAt, tc.closesAt, now))
		})
	}
}

func TestOrderDetailAPIRoundTrip(t *testing.T) {
	zh, en, km := "金边半程马拉松 2026", "Phnom Penh Half Marathon 2026", "ម៉ារ៉ាតុងពាក់កណ្ដាលភ្នំពេញ ២០២៦"
	catZh, catEn, catKm := "21K 组", "21K run", "ការរត់ 21K"
	deadline := time.Date(2026, 9, 14, 3, 30, 0, 0, time.UTC)
	reviewed := time.Date(2026, 9, 14, 4, 0, 0, 0, time.UTC)
	reason := "截图看不清"
	ticket := "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
	original := apigen.OrderDetail{
		OrderNo:          "WR0A1B2C3D",
		Status:           apigen.OrderStatus("PROOF_REJECTED"),
		EventSlug:        "pphm-2026",
		EventName:        apigen.LocalizedText{Zh: &zh, En: &en, Km: &km},
		EventTimezone:    "Asia/Phnom_Penh",
		ListAmountCents:  5000,
		DiscountCents:    1001,
		IdentOffsetCents: 1,
		AmountCents:      3999,
		Currency:         "USD",
		DeadlineAt:       &deadline,
		CreatedAt:        deadline.Add(-30 * time.Minute),
		Participants: []apigen.OrderParticipant{
			{RegNo: "RG0A1B2C3D", CategoryId: 11, CategoryName: apigen.LocalizedText{Zh: &catZh, En: &catEn, Km: &catKm},
				FullName: "Chan Sophea", PriceRuleId: 7, ListPriceCents: 2500, PaidCents: 1999,
				RegistrationStatus: apigen.OrderParticipantRegistrationStatus("CONFIRMED"), TicketCode: &ticket},
		},
		PaymentAccount: apigen.OrderPaymentAccount{Id: 3, Name: "ABA USD 主收款户", Provider: "ABA", AccountName: "WERUN CO LTD", AccountNoMasked: "*** *** 123", QrFileId: 9},
		LastRejection:  &apigen.OrderRejection{Code: "UNREADABLE", Reason: &reason, ReviewedAt: reviewed},
	}

	require.Equal(t, original, toAPIOrderDetail(orderDetailFromAPI(original)))
}
```

- [ ] **Step 6: 写下单的数据库失败测试**

创建 `api/internal/registration/create_test.go`：

```go
package registration_test

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/pricing"
	"werun/api/internal/registration"
	"werun/api/internal/runner"
	fx "werun/api/internal/testfixture"
)

var testMeta = httpx.Meta{RequestID: "req-registration-test", IP: "203.0.113.7", UserAgent: "registration-test"}

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

type orderEnv struct {
	pool    *pgxpool.Pool
	clock   *fakeClock
	runners *runner.Service
	svc     *registration.Service
	event   fx.Event
	rule    int64
	account int64
	consent runner.ConsentAcceptance
	user    runner.User
}

func newOrderEnv(t *testing.T, capacity int32) orderEnv {
	t.Helper()
	pool := dbtest.NewPool(t)
	clock := &fakeClock{now: time.Date(2026, 9, 14, 3, 0, 0, 0, time.UTC)}
	runners := fx.RunnerService(t, pool, clock.Now)
	prices := pricing.NewService(pool, clock.Now)
	ev := fx.RaceEvent(t, pool, fx.EventOpts{Slug: "pphm-2026", RegistrationOpen: true,
		Categories: []fx.CategoryOpts{{Code: "21K", Capacity: capacity, MinAge: 16}}})
	return orderEnv{
		pool:    pool,
		clock:   clock,
		runners: runners,
		svc:     registration.NewService(pool, runners, prices, clock.Now),
		event:   ev,
		rule:    fx.PriceRule(t, pool, ev.ID, fx.PriceRuleOpts{PriceCents: 2500, CategoryIDs: ev.CategoryIDs}),
		account: fx.PaymentAccount(t, pool, &ev.ID),
		consent: fx.RegistrationConsent(t, runners),
		user:    fx.Runner(t, pool, 900001, "Dara"),
	}
}

func (e orderEnv) input(key string, profiles ...runner.ProfileData) registration.CreateOrderInput {
	in := registration.CreateOrderInput{EventSlug: e.event.Slug, Consent: e.consent, IdempotencyKey: key}
	for _, p := range profiles {
		in.Participants = append(in.Participants, registration.OrderParticipantInput{CategoryID: e.event.CategoryIDs[0], Profile: &p})
	}
	return in
}

func (e orderEnv) counts(t *testing.T, table string, id int64) fx.Counts {
	t.Helper()
	return fx.CountersOf(t, e.pool, table, id)
}

func requireAppErr(t *testing.T, err error, code string, status int) *apperr.Error {
	t.Helper()
	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	require.Equal(t, code, ae.Code)
	require.Equal(t, status, ae.Status)
	return ae
}

func TestCreateOrderTwoParticipantsWithPercentCoupon(t *testing.T) {
	e := newOrderEnv(t, 100)
	ctx := context.Background()
	coupon := fx.Coupon(t, e.pool, fx.CouponOpts{Code: "RUN20", EventID: &e.event.ID, DiscountType: "PERCENT", DiscountValue: 20, Quota: 5})
	in := e.input("order-key-0001",
		fx.Profile("Chan Sophea", "N0 1234-567", "KH", "1990-05-01"),
		fx.Profile("Lim Dara", "P7654321", "US", "1992-08-20"))
	in.CouponCode = "run20"
	in.Participants[1].SaveAsProfile = true

	d, err := e.svc.CreateOrder(ctx, e.user, in, testMeta)

	require.NoError(t, err)
	require.Regexp(t, `^WR[0-9A-HJKMNP-TV-Z]{8}$`, d.OrderNo)
	require.Equal(t, registration.StatusPendingPayment, d.Status)
	require.Equal(t, "RESERVED", d.ReservationState)
	require.Equal(t, e.user.ID, d.BuyerUserID)
	require.Equal(t, int64(5000), d.ListAmountCents)
	require.Equal(t, int64(1001), d.DiscountCents)
	require.Equal(t, int64(1), d.IdentOffsetCents)
	require.Equal(t, int64(3999), d.AmountCents)
	require.Equal(t, "USD", d.Currency)
	require.Equal(t, e.account, d.PaymentAccountID)
	require.NotNil(t, d.DeadlineAt)
	require.True(t, d.DeadlineAt.Equal(e.clock.Now().Add(30*time.Minute)))
	require.Nil(t, d.PaidAt)
	require.Equal(t, "pphm-2026", d.EventSlug)
	require.Equal(t, "Phnom Penh Half Marathon 2026", d.EventName[i18n.EN])
	require.Equal(t, "Asia/Phnom_Penh", d.EventTimezone)
	require.Equal(t, e.account, d.PaymentAccount.ID)
	require.Equal(t, "ABA", d.PaymentAccount.Provider)
	require.Equal(t, "*** *** 123", d.PaymentAccount.AccountNoMasked)
	require.Nil(t, d.LastRejection)

	require.Len(t, d.Participants, 2)
	require.Regexp(t, `^RG[0-9A-HJKMNP-TV-Z]{8}$`, d.Participants[0].RegNo)
	require.Equal(t, "Chan Sophea", d.Participants[0].FullName)
	require.Equal(t, "21K 组", d.Participants[0].CategoryName[i18n.ZH])
	require.Equal(t, e.rule, d.Participants[0].PriceRuleID)
	require.Equal(t, int64(2500), d.Participants[0].ListPriceCents)
	require.Equal(t, int64(1999), d.Participants[0].PaidCents, "余数相同按参赛人顺序，第一个人多减 1 分")
	require.Equal(t, int64(2000), d.Participants[1].PaidCents)
	require.Equal(t, registration.RegistrationPending, d.Participants[0].RegistrationStatus)
	require.Nil(t, d.Participants[0].TicketCode)

	require.Equal(t, fx.Counts{Reserved: 2}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))
	require.Equal(t, fx.Counts{Reserved: 2}, e.counts(t, "price_rules", e.rule))
	require.Equal(t, fx.Counts{Reserved: 1}, e.counts(t, "coupons", coupon))

	require.Equal(t, 2, fx.Count(t, e.pool,
		`SELECT count(*) FROM registrations WHERE status = 'PENDING' AND user_id = $1 AND event_id = $2`, e.user.ID, e.event.ID))
	require.Equal(t, 1, fx.Count(t, e.pool,
		`SELECT count(*) FROM registrations WHERE id_no_hash = $1 AND id_no_enc IS NOT NULL AND id_no_enc <> convert_to('N01234567', 'UTF8')`,
		fx.PII(t).Hash("N01234567")))
	require.Equal(t, 2, fx.Count(t, e.pool, `SELECT count(*) FROM order_participants WHERE order_id = $1`, d.ID))
	require.Equal(t, 1, fx.Count(t, e.pool,
		`SELECT count(*) FROM coupon_redemptions WHERE order_id = $1 AND coupon_id = $2 AND state = 'RESERVED' AND discount_cents = 1000`, d.ID, coupon))
	require.Equal(t, 1, fx.Count(t, e.pool,
		`SELECT count(*) FROM registration_consents rc JOIN disclaimer_signatures ds ON ds.id = rc.signature_id
		 WHERE rc.reg_order_id = $1 AND ds.user_id = $2`, d.ID, e.user.ID))
	require.Equal(t, 1, fx.Count(t, e.pool, `SELECT count(*) FROM runner_profiles WHERE user_id = $1 AND full_name = 'Lim Dara'`, e.user.ID))
	require.Equal(t, 1, fx.Count(t, e.pool,
		`SELECT count(*) FROM audit_logs WHERE action = 'reg_order.create' AND entity_type = 'reg_order' AND entity_id = $1
		 AND actor_type = 'USER' AND actor_id = $2 AND is_financial AND event_id = $3`, d.ID, e.user.ID, e.event.ID))
	require.Equal(t, 1, fx.Count(t, e.pool,
		`SELECT count(*) FROM idempotency_keys WHERE scope = 'reg_order.create' AND subject = $1 AND key = 'order-key-0001' AND response_code = 201`,
		fmt.Sprintf("user:%d", e.user.ID)))
}

func TestCreateOrderWithWaiverIsPaidAndConfirmed(t *testing.T) {
	e := newOrderEnv(t, 100)
	coupon := fx.Coupon(t, e.pool, fx.CouponOpts{Code: "FREE1", DiscountType: "WAIVER", Quota: 2})
	in := e.input("order-key-free", fx.Profile("Keo Nita", "K100200", "KH", "1995-01-01"))
	in.CouponCode = "FREE1"

	d, err := e.svc.CreateOrder(context.Background(), e.user, in, testMeta)

	require.NoError(t, err)
	require.Equal(t, registration.StatusPaid, d.Status)
	require.Equal(t, "CONSUMED", d.ReservationState)
	require.Equal(t, int64(0), d.AmountCents)
	require.Equal(t, int64(0), d.IdentOffsetCents)
	require.Equal(t, int64(2500), d.DiscountCents)
	require.Nil(t, d.DeadlineAt)
	require.NotNil(t, d.PaidAt)
	require.True(t, d.PaidAt.Equal(e.clock.Now()))
	require.Equal(t, registration.RegistrationConfirmed, d.Participants[0].RegistrationStatus)
	require.NotNil(t, d.Participants[0].TicketCode)
	require.Len(t, *d.Participants[0].TicketCode, 32)
	require.Equal(t, int64(0), d.Participants[0].PaidCents)

	require.Equal(t, fx.Counts{Used: 1}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))
	require.Equal(t, fx.Counts{Used: 1}, e.counts(t, "price_rules", e.rule))
	require.Equal(t, fx.Counts{Used: 1}, e.counts(t, "coupons", coupon))
	require.Equal(t, 1, fx.Count(t, e.pool, `SELECT count(*) FROM coupon_redemptions WHERE order_id = $1 AND state = 'CONSUMED'`, d.ID))
	require.Equal(t, 1, fx.Count(t, e.pool, `SELECT count(*) FROM registrations WHERE status = 'CONFIRMED' AND confirmed_at IS NOT NULL`))
	require.Equal(t, 1, fx.Count(t, e.pool, `SELECT count(*) FROM audit_logs WHERE action = 'reg_order.create' AND entity_id = $1`, d.ID))
	require.Equal(t, 1, fx.Count(t, e.pool, `SELECT count(*) FROM audit_logs WHERE action = 'reg_order.paid_zero' AND entity_id = $1 AND is_financial`, d.ID))
}

func TestCreateOrderIdentOffsetsAreDistinctUnderConcurrency(t *testing.T) {
	e := newOrderEnv(t, 100)
	const workers = 10
	var wg sync.WaitGroup
	start := make(chan struct{})
	results := make([]registration.OrderDetail, workers)
	errs := make([]error, workers)
	for i := range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			in := e.input(fmt.Sprintf("ident-key-%04d", i), fx.Profile(fmt.Sprintf("Runner %d", i), fmt.Sprintf("C%07d", i), "US", "1990-01-01"))
			results[i], errs[i] = e.svc.CreateOrder(context.Background(), e.user, in, testMeta)
		}()
	}
	close(start)
	wg.Wait()

	offsets := map[int64]bool{}
	for i := range workers {
		require.NoError(t, errs[i])
		off := results[i].IdentOffsetCents
		require.GreaterOrEqual(t, off, int64(1))
		require.LessOrEqual(t, off, int64(workers))
		require.False(t, offsets[off], "识别分 %d 重复", off)
		offsets[off] = true
		require.Equal(t, 2500-off, results[i].AmountCents)
	}
	require.Equal(t, fx.Counts{Reserved: workers}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))
}

func TestCreateOrderLastSeatUnderConcurrency(t *testing.T) {
	e := newOrderEnv(t, 1)
	const workers = 20
	var wg sync.WaitGroup
	start := make(chan struct{})
	errs := make([]error, workers)
	for i := range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			in := e.input(fmt.Sprintf("seat-key-%04d", i), fx.Profile(fmt.Sprintf("Runner %d", i), fmt.Sprintf("S%07d", i), "KH", "1990-01-01"))
			_, errs[i] = e.svc.CreateOrder(context.Background(), e.user, in, testMeta)
		}()
	}
	close(start)
	wg.Wait()

	success := 0
	for _, err := range errs {
		if err == nil {
			success++
			continue
		}
		requireAppErr(t, err, apperr.CodeCategorySoldOut, http.StatusConflict)
	}
	require.Equal(t, 1, success)
	require.Equal(t, fx.Counts{Reserved: 1}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))
	require.Equal(t, 1, fx.Count(t, e.pool, `SELECT count(*) FROM reg_orders`))
	require.Equal(t, 1, fx.Count(t, e.pool, `SELECT count(*) FROM registrations`))
}

func TestCreateOrderIdempotencyKey(t *testing.T) {
	e := newOrderEnv(t, 100)
	ctx := context.Background()
	in := e.input("replay-key-0001", fx.Profile("Sam Rith", "R123456", "KH", "1990-01-01"))

	first, err := e.svc.CreateOrder(ctx, e.user, in, testMeta)
	require.NoError(t, err)
	second, err := e.svc.CreateOrder(ctx, e.user, in, testMeta)
	require.NoError(t, err)

	require.Equal(t, first.OrderNo, second.OrderNo)
	require.Equal(t, first.AmountCents, second.AmountCents)
	require.Equal(t, first.Participants[0].RegNo, second.Participants[0].RegNo)
	require.Equal(t, 1, fx.Count(t, e.pool, `SELECT count(*) FROM reg_orders`))
	require.Equal(t, fx.Counts{Reserved: 1}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))

	changed := in
	changed.CouponCode = "NOPE"
	_, err = e.svc.CreateOrder(ctx, e.user, changed, testMeta)
	requireAppErr(t, err, apperr.CodeIdempotencyKeyReused, http.StatusUnprocessableEntity)

	other := fx.Runner(t, e.pool, 900002, "Other")
	otherIn := e.input("replay-key-0001", fx.Profile("Other Runner", "O123456", "KH", "1990-01-01"))
	otherOrder, err := e.svc.CreateOrder(ctx, other, otherIn, testMeta)
	require.NoError(t, err, "幂等键按跑者隔离")
	require.NotEqual(t, first.OrderNo, otherOrder.OrderNo)

	e.clock.Advance(25 * time.Hour)
	expired := e.input("replay-key-0001", fx.Profile("Sam Rith Junior", "R999999", "KH", "1991-01-01"))
	third, err := e.svc.CreateOrder(ctx, e.user, expired, testMeta)
	require.NoError(t, err, "过期的幂等键不再生效")
	require.NotEqual(t, first.OrderNo, third.OrderNo)
	require.Equal(t, 3, fx.Count(t, e.pool, `SELECT count(*) FROM reg_orders`))
}

func TestCreateOrderRejectsClosedRegistration(t *testing.T) {
	e := newOrderEnv(t, 10)
	ctx := context.Background()
	now := e.clock.Now()
	attempt := func(key string) error {
		_, err := e.svc.CreateOrder(ctx, e.user, e.input(key, fx.Profile("Chan Sophea", "N01234567", "KH", "1990-05-01")), testMeta)
		return err
	}

	fx.Exec(t, e.pool, `UPDATE events SET registration_open = false WHERE id = $1`, e.event.ID)
	requireAppErr(t, attempt("closed-key-0001"), apperr.CodeRegistrationClosed, http.StatusConflict)

	fx.Exec(t, e.pool, `UPDATE events SET registration_open = true, registration_closes_at = $2 WHERE id = $1`, e.event.ID, now.Add(-time.Hour))
	requireAppErr(t, attempt("closed-key-0002"), apperr.CodeRegistrationClosed, http.StatusConflict)

	fx.Exec(t, e.pool, `UPDATE events SET registration_closes_at = NULL, registration_opens_at = $2 WHERE id = $1`, e.event.ID, now.Add(time.Hour))
	requireAppErr(t, attempt("closed-key-0003"), apperr.CodeRegistrationClosed, http.StatusConflict)

	in := e.input("closed-key-0004", fx.Profile("Chan Sophea", "N01234567", "KH", "1990-05-01"))
	in.EventSlug = "does-not-exist"
	_, err := e.svc.CreateOrder(ctx, e.user, in, testMeta)
	requireAppErr(t, err, apperr.CodeEventNotFound, http.StatusNotFound)

	require.Equal(t, fx.Counts{}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))
	require.Equal(t, 0, fx.Count(t, e.pool, `SELECT count(*) FROM reg_orders`))
}

func TestCreateOrderRejectsDuplicateIDNumbers(t *testing.T) {
	e := newOrderEnv(t, 10)
	ctx := context.Background()

	_, err := e.svc.CreateOrder(ctx, e.user, e.input("dup-key-0001",
		fx.Profile("Chan A", "AB 12-34", "KH", "1990-01-01"),
		fx.Profile("Chan B", "ab1234", "US", "1991-01-01")), testMeta)
	ae := requireAppErr(t, err, apperr.CodeValidation, http.StatusUnprocessableEntity)
	require.Equal(t, "field.duplicate_id_no", ae.Fields["participants[1].idNo"].Key)
	require.NotContains(t, ae.Fields, "participants[0].idNo")

	_, err = e.svc.CreateOrder(ctx, e.user, e.input("dup-key-0002", fx.Profile("Chan A", "AB1234", "KH", "1990-01-01")), testMeta)
	require.NoError(t, err)

	_, err = e.svc.CreateOrder(ctx, e.user, e.input("dup-key-0003",
		fx.Profile("Chan C", "X999999", "KH", "1990-01-01"),
		fx.Profile("Chan A2", "ab-1234", "KH", "1990-01-01")), testMeta)
	ae = requireAppErr(t, err, apperr.CodeAlreadyRegistered, http.StatusConflict)
	require.Equal(t, "field.already_registered", ae.Fields["participants[1].idNo"].Key)
	require.NotContains(t, ae.Fields, "participants[0].idNo")
	require.Equal(t, 1, fx.Count(t, e.pool, `SELECT count(*) FROM reg_orders`))
}

func TestCreateOrderFailureLeavesNoTrace(t *testing.T) {
	e := newOrderEnv(t, 10)
	coupon := fx.Coupon(t, e.pool, fx.CouponOpts{Code: "RUN20", DiscountType: "PERCENT", DiscountValue: 20, Quota: 5})
	in := e.input("rollback-key-0001",
		fx.Profile("Chan Sophea", "N01234567", "KH", "1990-05-01"),
		fx.Profile("Lim Dara", "P7654321", "US", "1992-08-20"))
	in.CouponCode = "RUN20"
	in.Participants[0].SaveAsProfile = true
	in.Consent.CheckedItems = []string{"rules", "health"}

	_, err := e.svc.CreateOrder(context.Background(), e.user, in, testMeta)

	requireAppErr(t, err, apperr.CodeConsentInvalid, http.StatusUnprocessableEntity)
	require.Equal(t, fx.Counts{}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))
	require.Equal(t, fx.Counts{}, e.counts(t, "price_rules", e.rule))
	require.Equal(t, fx.Counts{}, e.counts(t, "coupons", coupon))
	for _, table := range []string{"reg_orders", "order_participants", "registrations", "coupon_redemptions",
		"runner_profiles", "idempotency_keys", "registration_consents", "disclaimer_signatures"} {
		require.Equal(t, 0, fx.Count(t, e.pool, "SELECT count(*) FROM "+table), table)
	}
	require.Equal(t, 0, fx.Count(t, e.pool, `SELECT count(*) FROM audit_logs WHERE action LIKE 'reg_order.%'`))
}

func TestCreateOrderAgeAndPaymentAccountChecks(t *testing.T) {
	e := newOrderEnv(t, 10)
	ctx := context.Background()

	_, err := e.svc.CreateOrder(ctx, e.user, e.input("age-key-0001", fx.Profile("Young Runner", "Y1234567", "KH", "2012-01-01")), testMeta)
	ae := requireAppErr(t, err, apperr.CodeValidation, http.StatusUnprocessableEntity)
	require.Equal(t, "field.too_young", ae.Fields["participants[0].birthDate"].Key)

	fx.Exec(t, e.pool, `UPDATE payment_accounts SET active = false`)
	_, err = e.svc.CreateOrder(ctx, e.user, e.input("acct-key-0001", fx.Profile("Chan Sophea", "N01234567", "KH", "1990-05-01")), testMeta)
	requireAppErr(t, err, apperr.CodePaymentAccountUnavailable, http.StatusServiceUnavailable)
	require.Equal(t, 0, fx.Count(t, e.pool, `SELECT count(*) FROM reg_orders`))
}

func TestCreateOrderPrefersEventAccountOverGlobal(t *testing.T) {
	e := newOrderEnv(t, 10)
	fx.Exec(t, e.pool, `UPDATE payment_accounts SET event_id = NULL WHERE id = $1`, e.account)
	eventAccount := fx.PaymentAccount(t, e.pool, &e.event.ID)

	d, err := e.svc.CreateOrder(context.Background(), e.user,
		e.input("acct-key-0002", fx.Profile("Chan Sophea", "N01234567", "KH", "1990-05-01")), testMeta)

	require.NoError(t, err)
	require.Equal(t, eventAccount, d.PaymentAccountID)
}

func TestCreateOrderWithSavedProfile(t *testing.T) {
	e := newOrderEnv(t, 10)
	ctx := context.Background()
	saved, err := e.runners.CreateProfile(ctx, e.user, fx.Profile("Saved Runner", "S7777777", "KH", "1985-03-03"), true)
	require.NoError(t, err)
	in := registration.CreateOrderInput{
		EventSlug:      e.event.Slug,
		Consent:        e.consent,
		IdempotencyKey: "saved-key-0001",
		Participants:   []registration.OrderParticipantInput{{CategoryID: e.event.CategoryIDs[0], ProfileID: &saved.ID}},
	}

	d, err := e.svc.CreateOrder(ctx, e.user, in, testMeta)

	require.NoError(t, err)
	require.Equal(t, "Saved Runner", d.Participants[0].FullName)
	require.Equal(t, 1, fx.Count(t, e.pool, `SELECT count(*) FROM registrations WHERE id_no_hash = $1`, fx.PII(t).Hash("S7777777")))

	other := fx.Runner(t, e.pool, 900003, "Stranger")
	in.IdempotencyKey = "saved-key-0002"
	_, err = e.svc.CreateOrder(ctx, other, in, testMeta)
	ae := requireAppErr(t, err, apperr.CodeValidation, http.StatusUnprocessableEntity)
	require.Contains(t, ae.Fields, "participants[0].profileId")
}

func TestPreviewQuote(t *testing.T) {
	e := newOrderEnv(t, 10)
	ctx := context.Background()
	in := registration.QuotePreviewInput{Participants: []pricing.ParticipantInput{
		{CategoryID: e.event.CategoryIDs[0], Nationality: "KH", BirthDate: fx.Day("1990-01-01")},
	}}

	q, err := e.svc.PreviewQuote(ctx, e.user, e.event.Slug, in)

	require.NoError(t, err)
	require.Equal(t, int64(2500), q.AmountCents)
	require.Equal(t, int64(0), q.IdentOffsetCents)
	require.Equal(t, fx.Counts{}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))

	_, err = e.svc.PreviewQuote(ctx, e.user, "does-not-exist", in)
	requireAppErr(t, err, apperr.CodeEventNotFound, http.StatusNotFound)

	_, err = e.svc.PreviewQuote(ctx, e.user, e.event.Slug, registration.QuotePreviewInput{})
	ae := requireAppErr(t, err, apperr.CodeValidation, http.StatusUnprocessableEntity)
	require.Equal(t, "field.invalid", ae.Fields["participants"].Key)

	fx.Exec(t, e.pool, `UPDATE events SET status = 'DRAFT' WHERE id = $1`, e.event.ID)
	_, err = e.svc.PreviewQuote(ctx, e.user, e.event.Slug, in)
	requireAppErr(t, err, apperr.CodeEventNotFound, http.StatusNotFound)
}
```

- [ ] **Step 7: 运行测试，确认失败**

Run: `cd api && env $DBENV go test ./internal/registration/...`
Expected: 编译失败：`undefined: normalizeCreateInput`、`undefined: registration.NewService`、`undefined: registration.StatusPendingPayment` 等。

- [ ] **Step 8: 实现 registration 包**

创建 `api/internal/registration/model.go`：

```go
// Package registration 负责报名下单、订单查询、取消与超时释放。
package registration

import (
	"time"

	"werun/api/internal/platform/i18n"
	"werun/api/internal/pricing"
	"werun/api/internal/runner"
)

// 订单状态、报名状态与限制。
const (
	StatusPendingPayment = "PENDING_PAYMENT"
	StatusProofSubmitted = "PROOF_SUBMITTED"
	StatusProofRejected  = "PROOF_REJECTED"
	StatusPaid           = "PAID"
	StatusExpired        = "EXPIRED"
	StatusCancelled      = "CANCELLED"

	RegistrationPending   = "PENDING"
	RegistrationConfirmed = "CONFIRMED"
	RegistrationCancelled = "CANCELLED"

	MinParticipants = 1
	MaxParticipants = 10

	idempotencyScope = "reg_order.create"
	idempotencyTTL   = 24 * time.Hour
)

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
	OrderNo                  string
	Status                   string
	ReservationState         string
	ListAmountCents          int64
	DiscountCents            int64
	IdentOffsetCents         int64
	AmountCents              int64
	Currency                 string
	PaymentAccountID         int64
	DeadlineAt               *time.Time
	PaidAt                   *time.Time
	CreatedAt                time.Time
}

type OrderParticipant struct {
	RegistrationID     int64
	RegNo              string
	CategoryID         int64
	CategoryName       i18n.Text
	FullName           string
	PriceRuleID        int64
	ListPriceCents     int64
	PaidCents          int64
	RegistrationStatus string  // PENDING | CONFIRMED | CANCELLED
	TicketCode         *string // 仅 CONFIRMED 时非空
}

type PaymentAccountView struct {
	ID              int64
	Name            string
	Provider        string
	AccountName     string
	AccountNoMasked string
	QRFileID        int64
}

type LastRejection struct {
	Code       string
	Reason     *string
	ReviewedAt time.Time
}

type OrderDetail struct {
	Order
	EventSlug      string
	EventName      i18n.Text
	EventTimezone  string
	Participants   []OrderParticipant
	PaymentAccount PaymentAccountView
	LastRejection  *LastRejection
}

type OrderSummary struct {
	Order
	EventSlug        string
	EventName        i18n.Text
	ParticipantCount int
}
```

创建 `api/internal/registration/service.go`：

```go
package registration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"werun/api/internal/audit"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/pricing"
	"werun/api/internal/runner"
)

// Service 是报名订单模块的业务入口。
type Service struct {
	pool    *pgxpool.Pool
	runners *runner.Service
	prices  *pricing.Service
	now     func() time.Time
}

// NewService 创建报名订单服务。
func NewService(pool *pgxpool.Pool, runners *runner.Service, prices *pricing.Service, now func() time.Time) *Service {
	return &Service{pool: pool, runners: runners, prices: prices, now: now}
}

// fieldErrors 收集字段错误，一次返回。
type fieldErrors struct {
	err    *apperr.Error
	failed bool
}

func newFieldErrors() *fieldErrors {
	return &fieldErrors{err: apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)}
}

func (f *fieldErrors) add(field, key string, params map[string]any) {
	f.err = f.err.WithField(field, key, params)
	f.failed = true
}

// merge 把 VALIDATION_FAILED 的字段并入；nil 返回 nil；其它错误原样返回给调用方。
func (f *fieldErrors) merge(err error) error {
	if err == nil {
		return nil
	}
	ae, ok := apperr.As(err)
	if !ok || ae.Code != apperr.CodeValidation {
		return err
	}
	for field, fe := range ae.Fields {
		f.add(field, fe.Key, fe.Params)
	}
	f.failed = true
	return nil
}

func (f *fieldErrors) result() error {
	if f.failed {
		return f.err
	}
	return nil
}

// withSavepoint 在保存点里执行 fn：唯一约束冲突等错误只回滚到保存点，外层事务仍可继续（供 idgen.Retry 重试）。
func withSavepoint(ctx context.Context, tx pgx.Tx, fn func(sp pgx.Tx) error) error {
	sp, err := tx.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin savepoint: %w", err)
	}
	if err := fn(sp); err != nil {
		if rbErr := sp.Rollback(ctx); rbErr != nil && !errors.Is(rbErr, pgx.ErrTxClosed) {
			return errors.Join(err, fmt.Errorf("rollback savepoint: %w", rbErr))
		}
		return err
	}
	if err := sp.Commit(ctx); err != nil {
		return fmt.Errorf("release savepoint: %w", err)
	}
	return nil
}

func optString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func decodeText(raw []byte, what string) (i18n.Text, error) {
	var t i18n.Text
	if err := json.Unmarshal(raw, &t); err != nil {
		return nil, fmt.Errorf("decode %s: %w", what, err)
	}
	return t, nil
}

func runnerAudit(u runner.User, action string, orderID, eventID int64, summary string, after any, meta httpx.Meta) audit.Entry {
	actorID := u.ID
	evID := eventID
	return audit.Entry{
		ActorType:   "USER",
		ActorID:     &actorID,
		Action:      action,
		EntityType:  "reg_order",
		EntityID:    orderID,
		EventID:     &evID,
		IsFinancial: true,
		Summary:     summary,
		After:       after,
		Meta:        meta,
	}
}
```

创建 `api/internal/registration/create.go`：

```go
package registration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/audit"
	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/idgen"
	"werun/api/internal/platform/piicrypt"
	"werun/api/internal/platform/settings"
	"werun/api/internal/pricing"
	"werun/api/internal/registration/store"
	"werun/api/internal/runner"
)

var (
	idempotencyKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)
	nationalityPattern    = regexp.MustCompile(`^[A-Z]{2}$`)
)

// normalizeCreateInput 做不依赖数据库的校验，并返回规范化后的副本（不修改入参）：
// 优惠码转大写、同意书勾选项排序、证件号去空白与连字符并转大写、国籍转大写、选常用参赛人时 SaveAsProfile 归零。
func normalizeCreateInput(in CreateOrderInput) (CreateOrderInput, error) {
	fe := newFieldErrors()
	out := CreateOrderInput{
		EventSlug:      strings.TrimSpace(in.EventSlug),
		CouponCode:     strings.ToUpper(strings.TrimSpace(in.CouponCode)),
		IdempotencyKey: in.IdempotencyKey,
		Consent: runner.ConsentAcceptance{
			Version:      strings.TrimSpace(in.Consent.Version),
			Lang:         in.Consent.Lang,
			CheckedItems: slices.Sorted(slices.Values(in.Consent.CheckedItems)),
		},
	}
	if !idempotencyKeyPattern.MatchString(in.IdempotencyKey) {
		fe.add("idempotencyKey", "field.invalid", nil)
	}
	if out.EventSlug == "" {
		fe.add("eventSlug", "field.required", nil)
	}
	if n := len(in.Participants); n < MinParticipants || n > MaxParticipants {
		fe.add("participants", "field.invalid", nil)
	}
	out.Participants = make([]OrderParticipantInput, 0, len(in.Participants))
	for i, p := range in.Participants {
		prefix := fmt.Sprintf("participants[%d].", i)
		np := OrderParticipantInput{CategoryID: p.CategoryID}
		if p.CategoryID <= 0 {
			fe.add(prefix+"categoryId", "field.required", nil)
		}
		switch {
		case p.ProfileID != nil && p.Profile != nil:
			fe.add(prefix+"profileId", "field.invalid", nil)
		case p.ProfileID != nil:
			id := *p.ProfileID
			np.ProfileID = &id
		case p.Profile != nil:
			prof := *p.Profile
			prof.IDNo = piicrypt.NormalizeIDNo(prof.IDNo)
			prof.Nationality = strings.ToUpper(strings.TrimSpace(prof.Nationality))
			np.Profile = &prof
			np.SaveAsProfile = p.SaveAsProfile
			if err := fe.merge(runner.ValidateProfile(prof, prefix)); err != nil {
				return CreateOrderInput{}, err
			}
		default:
			fe.add(prefix+"profileId", "field.required", nil)
		}
		out.Participants = append(out.Participants, np)
	}
	if err := fe.result(); err != nil {
		return CreateOrderInput{}, err
	}
	return out, nil
}

// requestHash 是规范化输入（不含幂等键）的 JSON 的 SHA-256。结构体字段顺序固定，json.Marshal 输出稳定。
func requestHash(in CreateOrderInput) ([]byte, error) {
	in.IdempotencyKey = ""
	raw, err := json.Marshal(in)
	if err != nil {
		return nil, fmt.Errorf("encode order request: %w", err)
	}
	sum := sha256.Sum256(raw)
	return sum[:], nil
}

func registrationOpen(status, eventType string, open bool, opensAt, closesAt *time.Time, now time.Time) bool {
	return status == "PUBLISHED" && eventType == "RACE" && open &&
		(opensAt == nil || !opensAt.After(now)) &&
		(closesAt == nil || closesAt.After(now))
}

// CreateOrder 按 spec 6.1 在一个事务里下单。同一跑者同一幂等键：请求体相同返回首次响应，不同返回 IDEMPOTENCY_KEY_REUSED。
func (s *Service) CreateOrder(ctx context.Context, u runner.User, in CreateOrderInput, meta httpx.Meta) (OrderDetail, error) {
	norm, err := normalizeCreateInput(in)
	if err != nil {
		return OrderDetail{}, err
	}
	hash, err := requestHash(norm)
	if err != nil {
		return OrderDetail{}, err
	}
	now := s.now().UTC()
	subject := fmt.Sprintf("user:%d", u.ID)

	var out OrderDetail
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		replay, found, err := claimIdempotencyKey(ctx, q, subject, norm.IdempotencyKey, hash, now)
		if err != nil {
			return err
		}
		if found {
			out = replay
			return nil
		}
		detail, err := s.createOrderTx(ctx, tx, q, u, norm, meta, now)
		if err != nil {
			return err
		}
		body, err := json.Marshal(toAPIOrderDetail(detail))
		if err != nil {
			return fmt.Errorf("encode idempotent response: %w", err)
		}
		if err := q.SaveIdempotencyResponse(ctx, store.SaveIdempotencyResponseParams{
			ResponseCode: http.StatusCreated,
			ResponseBody: body,
			Scope:        idempotencyScope,
			Subject:      subject,
			Key:          norm.IdempotencyKey,
		}); err != nil {
			return fmt.Errorf("save idempotent response: %w", err)
		}
		out = detail
		return nil
	})
	if err != nil {
		return OrderDetail{}, err
	}
	return out, nil
}

// claimIdempotencyKey 占用幂等键。返回 found=true 时 replay 是首次请求的响应。
func claimIdempotencyKey(ctx context.Context, q *store.Queries, subject, key string, hash []byte, now time.Time) (OrderDetail, bool, error) {
	_, err := q.ClaimIdempotencyKey(ctx, store.ClaimIdempotencyKeyParams{
		Key:         key,
		Scope:       idempotencyScope,
		Subject:     subject,
		RequestHash: hash,
		Now:         now,
		ExpiresAt:   now.Add(idempotencyTTL),
	})
	if err == nil {
		return OrderDetail{}, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return OrderDetail{}, false, fmt.Errorf("claim idempotency key: %w", err)
	}
	row, err := q.GetIdempotencyKey(ctx, store.GetIdempotencyKeyParams{Scope: idempotencyScope, Subject: subject, Key: key})
	if err != nil {
		return OrderDetail{}, false, fmt.Errorf("load idempotency key: %w", err)
	}
	if !bytes.Equal(row.RequestHash, hash) {
		return OrderDetail{}, false, apperr.New(http.StatusUnprocessableEntity, apperr.CodeIdempotencyKeyReused)
	}
	if row.ResponseCode == nil {
		return OrderDetail{}, false, fmt.Errorf("idempotency key %q has no stored response", key)
	}
	var body apigen.OrderDetail
	if err := json.Unmarshal(row.ResponseBody, &body); err != nil {
		return OrderDetail{}, false, fmt.Errorf("decode idempotent response: %w", err)
	}
	return orderDetailFromAPI(body), true, nil
}

type resolvedParticipant struct {
	input   OrderParticipantInput
	profile runner.ProfileData // IDNo 已规范化
	idHash  []byte
}

func (s *Service) createOrderTx(ctx context.Context, tx pgx.Tx, q *store.Queries, u runner.User, in CreateOrderInput, meta httpx.Meta, now time.Time) (OrderDetail, error) {
	// 1. 锁赛事行并校验报名开放
	ev, err := q.LockEventForOrder(ctx, in.EventSlug)
	if errors.Is(err, pgx.ErrNoRows) {
		return OrderDetail{}, apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
	}
	if err != nil {
		return OrderDetail{}, fmt.Errorf("lock event %q: %w", in.EventSlug, err)
	}
	if !registrationOpen(ev.Status, ev.EventType, ev.RegistrationOpen, ev.RegistrationOpensAt, ev.RegistrationClosesAt, now) {
		return OrderDetail{}, apperr.New(http.StatusConflict, apperr.CodeRegistrationClosed)
	}

	// 2. 参赛人资料与单内证件号去重
	parts, err := s.resolveParticipants(ctx, tx, u, in)
	if err != nil {
		return OrderDetail{}, err
	}
	// 3. 同一赛事已报名
	if err := checkAlreadyRegistered(ctx, q, ev.ID, parts); err != nil {
		return OrderDetail{}, err
	}

	// 4. 收款账户
	accountID, err := q.SelectRegistrationPaymentAccount(ctx, ev.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return OrderDetail{}, apperr.New(http.StatusServiceUnavailable, apperr.CodePaymentAccountUnavailable)
	}
	if err != nil {
		return OrderDetail{}, fmt.Errorf("select payment account: %w", err)
	}

	// 5–6. 算价（含识别分）与预留
	quoteIn := pricing.QuoteInput{EventID: ev.ID, RaceDate: ev.RaceDate, CouponCode: in.CouponCode, Now: now, PaymentAccountID: &accountID}
	for _, p := range parts {
		quoteIn.Participants = append(quoteIn.Participants, pricing.ParticipantInput{
			CategoryID: p.input.CategoryID, Nationality: p.profile.Nationality, BirthDate: p.profile.BirthDate})
	}
	quote, err := s.prices.Quote(ctx, tx, quoteIn)
	if err != nil {
		return OrderDetail{}, err
	}
	if err := s.prices.Reserve(ctx, tx, quote); err != nil {
		return OrderDetail{}, err
	}

	// 7. 订单
	pay, err := settings.LoadPayment(ctx, tx)
	if err != nil {
		return OrderDetail{}, fmt.Errorf("load payment settings: %w", err)
	}
	deadline := now.Add(pay.UploadWindow)
	buyer := parts[0].profile
	userID := u.ID
	var orderID int64
	err = idgen.Retry("reg_orders_order_no_key", func() error {
		return withSavepoint(ctx, tx, func(sp pgx.Tx) error {
			id, err := store.New(sp).InsertRegOrder(ctx, store.InsertRegOrderParams{
				OrderNo:          idgen.Code(idgen.PrefixOrder),
				EventID:          ev.ID,
				BuyerUserID:      &userID,
				BuyerName:        buyer.FullName,
				BuyerPhoneE164:   buyer.Phone,
				BuyerEmail:       optString(buyer.Email),
				ListAmountCents:  quote.ListAmountCents,
				DiscountCents:    quote.DiscountCents,
				IdentOffsetCents: int16(quote.IdentOffsetCents),
				AmountCents:      quote.AmountCents,
				CouponID:         quote.CouponID,
				PaymentAccountID: &accountID,
				DeadlineAt:       &deadline,
			})
			orderID = id
			return err
		})
	})
	if err != nil {
		return OrderDetail{}, fmt.Errorf("insert order: %w", err)
	}

	// 8. 参赛人快照、报名、常用参赛人
	for i, p := range parts {
		pq := quote.Participants[i]
		opID, err := q.InsertOrderParticipant(ctx, store.InsertOrderParticipantParams{
			OrderID:        orderID,
			CategoryID:     pq.CategoryID,
			PriceRuleID:    pq.PriceRuleID,
			Audience:       pq.Audience,
			ListPriceCents: pq.ListPriceCents,
			PaidCents:      pq.PaidCents,
			SnapshotName:   p.profile.FullName,
		})
		if err != nil {
			return OrderDetail{}, fmt.Errorf("insert order participant: %w", err)
		}
		enc, err := s.runners.PII().Encrypt(p.profile.IDNo)
		if err != nil {
			return OrderDetail{}, fmt.Errorf("encrypt id number: %w", err)
		}
		if err := insertRegistration(ctx, tx, store.InsertRegistrationParams{
			OrderParticipantID: opID,
			EventID:            ev.ID,
			CategoryID:         pq.CategoryID,
			UserID:             &userID,
			FullName:           p.profile.FullName,
			Gender:             p.profile.Gender,
			BirthDate:          p.profile.BirthDate,
			Nationality:        p.profile.Nationality,
			IDType:             optString(p.profile.IDType),
			IDNoEnc:            enc,
			IDNoHash:           p.idHash,
			PhoneE164:          optString(p.profile.Phone),
			Email:              optString(p.profile.Email),
			EmergencyName:      optString(p.profile.EmergencyName),
			EmergencyPhone:     optString(p.profile.EmergencyPhone),
			TshirtSize:         optString(p.profile.TShirtSize),
		}); err != nil {
			return OrderDetail{}, err
		}
		if p.input.SaveAsProfile && p.input.Profile != nil {
			if _, err := s.runners.CreateProfileTx(ctx, tx, u, p.profile); err != nil {
				return OrderDetail{}, err
			}
		}
	}

	// 9. 优惠码核销
	if err := s.prices.RecordRedemption(ctx, tx, orderID, quote); err != nil {
		return OrderDetail{}, err
	}
	// 10. 同意书
	if err := s.runners.SignConsent(ctx, tx, u, in.Consent, meta, runner.ConsentLink{RegOrderID: &orderID}); err != nil {
		return OrderDetail{}, err
	}
	// 11. 审计
	after := map[string]any{
		"couponCode":       in.CouponCode,
		"participants":     len(parts),
		"listAmountCents":  quote.ListAmountCents,
		"discountCents":    quote.DiscountCents,
		"identOffsetCents": quote.IdentOffsetCents,
		"amountCents":      quote.AmountCents,
		"paymentAccountId": accountID,
	}
	if err := audit.Record(ctx, tx, runnerAudit(u, "reg_order.create", orderID, ev.ID,
		fmt.Sprintf("跑者下单（%d 人，应付 %d 分）", len(parts), quote.AmountCents), after, meta)); err != nil {
		return OrderDetail{}, err
	}
	// 12. 应付为 0 直接确认
	if quote.AmountCents == 0 {
		if err := s.ConfirmPaid(ctx, tx, orderID, now); err != nil {
			return OrderDetail{}, err
		}
		if err := audit.Record(ctx, tx, runnerAudit(u, "reg_order.paid_zero", orderID, ev.ID,
			"应付为 0，订单直接确认", map[string]any{"status": StatusPaid}, meta)); err != nil {
			return OrderDetail{}, err
		}
	}
	return s.loadDetail(ctx, q, orderID)
}

func (s *Service) resolveParticipants(ctx context.Context, tx pgx.Tx, u runner.User, in CreateOrderInput) ([]resolvedParticipant, error) {
	fe := newFieldErrors()
	out := make([]resolvedParticipant, 0, len(in.Participants))
	seen := map[string]bool{}
	for i, p := range in.Participants {
		prefix := fmt.Sprintf("participants[%d].", i)
		var prof runner.ProfileData
		if p.ProfileID != nil {
			loaded, err := s.runners.LoadProfileForOrder(ctx, tx, u, *p.ProfileID, prefix)
			if err != nil {
				if mergeErr := fe.merge(err); mergeErr != nil {
					return nil, mergeErr
				}
				continue
			}
			loaded.IDNo = piicrypt.NormalizeIDNo(loaded.IDNo)
			loaded.Nationality = strings.ToUpper(strings.TrimSpace(loaded.Nationality))
			if err := fe.merge(runner.ValidateProfile(loaded, prefix)); err != nil {
				return nil, err
			}
			prof = loaded
		} else {
			prof = *p.Profile
		}
		hash := s.runners.PII().Hash(prof.IDNo)
		if seen[string(hash)] {
			fe.add(prefix+"idNo", "field.duplicate_id_no", nil)
		}
		seen[string(hash)] = true
		out = append(out, resolvedParticipant{input: p, profile: prof, idHash: hash})
	}
	if err := fe.result(); err != nil {
		return nil, err
	}
	return out, nil
}

// checkAlreadyRegistered 先按哈希字节序对每个证件号加 advisory 锁，再查同赛事 PENDING/CONFIRMED 报名。
func checkAlreadyRegistered(ctx context.Context, q *store.Queries, eventID int64, parts []resolvedParticipant) error {
	hashes := make([][]byte, 0, len(parts))
	for _, p := range parts {
		hashes = append(hashes, p.idHash)
	}
	slices.SortFunc(hashes, bytes.Compare)
	for _, h := range hashes {
		if err := q.LockIDNoHash(ctx, store.LockIDNoHashParams{EventID: eventID, IDNoHash: h}); err != nil {
			return fmt.Errorf("lock id number hash: %w", err)
		}
	}
	taken, err := q.ListRegisteredIDNoHashes(ctx, store.ListRegisteredIDNoHashesParams{EventID: eventID, Hashes: hashes})
	if err != nil {
		return fmt.Errorf("list registered id numbers: %w", err)
	}
	if len(taken) == 0 {
		return nil
	}
	registered := make(map[string]bool, len(taken))
	for _, h := range taken {
		registered[string(h)] = true
	}
	aerr := apperr.New(http.StatusConflict, apperr.CodeAlreadyRegistered)
	for i, p := range parts {
		if registered[string(p.idHash)] {
			aerr = aerr.WithField(fmt.Sprintf("participants[%d].idNo", i), "field.already_registered", nil)
		}
	}
	return aerr
}

func insertRegistration(ctx context.Context, tx pgx.Tx, params store.InsertRegistrationParams) error {
	err := idgen.Retry("registrations_reg_no_key", func() error {
		return idgen.Retry("registrations_ticket_code_key", func() error {
			return withSavepoint(ctx, tx, func(sp pgx.Tx) error {
				params.RegNo = idgen.Code(idgen.PrefixRegistration)
				params.TicketCode = idgen.TicketCode()
				_, err := store.New(sp).InsertRegistration(ctx, params)
				return err
			})
		})
	})
	if err != nil {
		return fmt.Errorf("insert registration: %w", err)
	}
	return nil
}

// ConfirmPaid 把订单改为 PAID 并消耗预留：订单条件更新（PROOF_SUBMITTED，或应付为 0 的 PENDING_PAYMENT）→ pricing.Consume → 报名 CONFIRMED。
// 条件更新影响 0 行返回 ORDER_STATE_CONFLICT。只在调用方事务内使用。
func (s *Service) ConfirmPaid(ctx context.Context, tx pgx.Tx, orderID int64, paidAt time.Time) error {
	q := store.New(tx)
	n, err := q.MarkOrderPaid(ctx, store.MarkOrderPaidParams{PaidAt: paidAt, ID: orderID})
	if err != nil {
		return fmt.Errorf("mark order %d paid: %w", orderID, err)
	}
	if n == 0 {
		return apperr.New(http.StatusConflict, apperr.CodeOrderStateConflict)
	}
	if err := s.prices.Consume(ctx, tx, orderID); err != nil {
		return err
	}
	if _, err := q.ConfirmOrderRegistrations(ctx, store.ConfirmOrderRegistrationsParams{
		ConfirmedAt: s.now().UTC(),
		OrderID:     orderID,
	}); err != nil {
		return fmt.Errorf("confirm registrations of order %d: %w", orderID, err)
	}
	return nil
}

// PreviewQuote 返回算价预览：赛事须为已发布的 RACE，不占名额、不选识别分。
func (s *Service) PreviewQuote(ctx context.Context, _ runner.User, slug string, in QuotePreviewInput) (pricing.Quote, error) {
	fe := newFieldErrors()
	if n := len(in.Participants); n < MinParticipants || n > MaxParticipants {
		fe.add("participants", "field.invalid", nil)
	}
	for i, p := range in.Participants {
		prefix := fmt.Sprintf("participants[%d].", i)
		if p.CategoryID <= 0 {
			fe.add(prefix+"categoryId", "field.required", nil)
		}
		if !nationalityPattern.MatchString(strings.ToUpper(strings.TrimSpace(p.Nationality))) {
			fe.add(prefix+"nationality", "field.invalid", nil)
		}
		if p.BirthDate.IsZero() {
			fe.add(prefix+"birthDate", "field.required", nil)
		}
	}
	if err := fe.result(); err != nil {
		return pricing.Quote{}, err
	}

	now := s.now().UTC()
	var out pricing.Quote
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		ev, err := store.New(tx).GetEventForQuote(ctx, slug)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && (ev.Status != "PUBLISHED" || ev.EventType != "RACE")) {
			return apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
		}
		if err != nil {
			return fmt.Errorf("load event %q: %w", slug, err)
		}
		q, err := s.prices.Quote(ctx, tx, pricing.QuoteInput{
			EventID:      ev.ID,
			RaceDate:     ev.RaceDate,
			CouponCode:   in.CouponCode,
			Participants: in.Participants,
			Now:          now,
		})
		out = q
		return err
	})
	if err != nil {
		return pricing.Quote{}, err
	}
	return out, nil
}
```

创建 `api/internal/registration/orders.go`：

```go
package registration

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/registration/store"
)

// loadDetail 读取订单详情（订单、赛事、参赛人、收款账户、最近一次驳回）。
func (s *Service) loadDetail(ctx context.Context, q *store.Queries, orderID int64) (OrderDetail, error) {
	row, err := q.GetOrderDetailByID(ctx, orderID)
	if err != nil {
		return OrderDetail{}, fmt.Errorf("load order %d: %w", orderID, err)
	}
	eventName, err := decodeText(row.EventName, "event name")
	if err != nil {
		return OrderDetail{}, err
	}
	d := OrderDetail{
		Order: Order{
			ID:               row.ID,
			EventID:          row.EventID,
			OrderNo:          row.OrderNo,
			Status:           row.Status,
			ReservationState: row.ReservationState,
			ListAmountCents:  row.ListAmountCents,
			DiscountCents:    row.DiscountCents,
			IdentOffsetCents: int64(row.IdentOffsetCents),
			AmountCents:      row.AmountCents,
			Currency:         row.Currency,
			DeadlineAt:       row.DeadlineAt,
			PaidAt:           row.PaidAt,
			CreatedAt:        row.CreatedAt,
		},
		EventSlug:     row.EventSlug,
		EventName:     eventName,
		EventTimezone: row.EventTimezone,
	}
	if row.BuyerUserID != nil {
		d.BuyerUserID = *row.BuyerUserID
	}

	parts, err := q.ListOrderParticipantDetails(ctx, orderID)
	if err != nil {
		return OrderDetail{}, fmt.Errorf("list participants of order %d: %w", orderID, err)
	}
	d.Participants = make([]OrderParticipant, 0, len(parts))
	for _, p := range parts {
		catName, err := decodeText(p.CategoryName, "category name")
		if err != nil {
			return OrderDetail{}, err
		}
		op := OrderParticipant{
			RegistrationID:     p.RegistrationID,
			RegNo:              p.RegNo,
			CategoryID:         p.CategoryID,
			CategoryName:       catName,
			FullName:           p.FullName,
			PriceRuleID:        p.PriceRuleID,
			ListPriceCents:     p.ListPriceCents,
			PaidCents:          p.PaidCents,
			RegistrationStatus: p.RegistrationStatus,
		}
		if p.RegistrationStatus == RegistrationConfirmed {
			code := p.TicketCode
			op.TicketCode = &code
		}
		d.Participants = append(d.Participants, op)
	}

	if row.PaymentAccountID != nil {
		d.PaymentAccountID = *row.PaymentAccountID
		acct, err := q.GetOrderPaymentAccount(ctx, *row.PaymentAccountID)
		if err != nil {
			return OrderDetail{}, fmt.Errorf("load payment account of order %d: %w", orderID, err)
		}
		d.PaymentAccount = PaymentAccountView{
			ID:              acct.ID,
			Name:            acct.Name,
			Provider:        acct.Provider,
			AccountName:     acct.AccountName,
			AccountNoMasked: acct.AccountNoMasked,
			QRFileID:        acct.QrFileID,
		}
	}

	rej, err := q.GetLastRejectedProof(ctx, orderID)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
	case err != nil:
		return OrderDetail{}, fmt.Errorf("load last rejection of order %d: %w", orderID, err)
	case rej.RejectCode != nil && rej.ReviewedAt != nil:
		d.LastRejection = &LastRejection{Code: *rej.RejectCode, Reason: rej.RejectReason, ReviewedAt: *rej.ReviewedAt}
	}
	return d, nil
}
```

创建 `api/internal/registration/handlers.go`：

```go
package registration

import (
	"context"
	"net/http"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/pricing"
	"werun/api/internal/runner"
)

// Handlers 实现 apigen.StrictServerInterface 中的跑者订单操作。
type Handlers struct {
	svc *Service
}

// NewHandlers 创建订单 handler。
func NewHandlers(svc *Service) *Handlers {
	return &Handlers{svc: svc}
}

func currentRunner(ctx context.Context) (runner.User, error) {
	u, ok := runner.UserFrom(ctx)
	if !ok {
		return runner.User{}, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	return u, nil
}

func (h *Handlers) AppQuote(ctx context.Context, req apigen.AppQuoteRequestObject) (apigen.AppQuoteResponseObject, error) {
	u, err := currentRunner(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	in := QuotePreviewInput{}
	if req.Body.CouponCode != nil {
		in.CouponCode = *req.Body.CouponCode
	}
	for _, p := range req.Body.Participants {
		in.Participants = append(in.Participants, pricing.ParticipantInput{
			CategoryID: p.CategoryId, Nationality: p.Nationality, BirthDate: p.BirthDate.Time})
	}
	q, err := h.svc.PreviewQuote(ctx, u, req.Slug, in)
	if err != nil {
		return nil, err
	}
	return apigen.AppQuote200JSONResponse(toAPIQuote(q)), nil
}

func (h *Handlers) AppCreateOrder(ctx context.Context, req apigen.AppCreateOrderRequestObject) (apigen.AppCreateOrderResponseObject, error) {
	u, err := currentRunner(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	d, err := h.svc.CreateOrder(ctx, u, createInputFromAPI(*req.Body, req.Params.IdempotencyKey), httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AppCreateOrder201JSONResponse(toAPIOrderDetail(d)), nil
}

func createInputFromAPI(b apigen.CreateOrderRequest, key string) CreateOrderInput {
	in := CreateOrderInput{
		EventSlug:      b.EventSlug,
		IdempotencyKey: key,
		Consent: runner.ConsentAcceptance{
			Version:      b.Consent.Version,
			Lang:         string(b.Consent.Lang),
			CheckedItems: b.Consent.CheckedItems,
		},
	}
	if b.CouponCode != nil {
		in.CouponCode = *b.CouponCode
	}
	for _, p := range b.Participants {
		op := OrderParticipantInput{CategoryID: p.CategoryId, ProfileID: p.ProfileId}
		if p.SaveAsProfile != nil {
			op.SaveAsProfile = *p.SaveAsProfile
		}
		if p.Profile != nil {
			prof := runner.ProfileData{
				FullName:       p.Profile.FullName,
				Gender:         string(p.Profile.Gender),
				BirthDate:      p.Profile.BirthDate.Time,
				Nationality:    p.Profile.Nationality,
				IDType:         string(p.Profile.IdType),
				IDNo:           p.Profile.IdNo,
				Phone:          p.Profile.Phone,
				EmergencyName:  p.Profile.EmergencyName,
				EmergencyPhone: p.Profile.EmergencyPhone,
				TShirtSize:     string(p.Profile.TshirtSize),
			}
			if p.Profile.Email != nil {
				prof.Email = *p.Profile.Email
			}
			op.Profile = &prof
		}
		in.Participants = append(in.Participants, op)
	}
	return in
}

func toAPIQuote(q pricing.Quote) apigen.Quote {
	parts := make([]apigen.QuoteParticipant, 0, len(q.Participants))
	for _, p := range q.Participants {
		parts = append(parts, apigen.QuoteParticipant{
			CategoryId:     p.CategoryID,
			PriceRuleId:    p.PriceRuleID,
			Audience:       apigen.QuoteParticipantAudience(p.Audience),
			ListPriceCents: p.ListPriceCents,
			PaidCents:      p.PaidCents,
		})
	}
	return apigen.Quote{
		Participants:        parts,
		ListAmountCents:     q.ListAmountCents,
		CouponApplied:       q.CouponID != nil,
		CouponDiscountCents: q.CouponDiscountCents,
		IdentOffsetCents:    q.IdentOffsetCents,
		DiscountCents:       q.DiscountCents,
		AmountCents:         q.AmountCents,
		Currency:            q.Currency,
	}
}

func toAPIOrderDetail(d OrderDetail) apigen.OrderDetail {
	parts := make([]apigen.OrderParticipant, 0, len(d.Participants))
	for _, p := range d.Participants {
		parts = append(parts, apigen.OrderParticipant{
			RegNo:              p.RegNo,
			CategoryId:         p.CategoryID,
			CategoryName:       localizedToAPI(p.CategoryName),
			FullName:           p.FullName,
			PriceRuleId:        p.PriceRuleID,
			ListPriceCents:     p.ListPriceCents,
			PaidCents:          p.PaidCents,
			RegistrationStatus: apigen.OrderParticipantRegistrationStatus(p.RegistrationStatus),
			TicketCode:         p.TicketCode,
		})
	}
	out := apigen.OrderDetail{
		OrderNo:          d.OrderNo,
		Status:           apigen.OrderStatus(d.Status),
		EventSlug:        d.EventSlug,
		EventName:        localizedToAPI(d.EventName),
		EventTimezone:    d.EventTimezone,
		ListAmountCents:  d.ListAmountCents,
		DiscountCents:    d.DiscountCents,
		IdentOffsetCents: d.IdentOffsetCents,
		AmountCents:      d.AmountCents,
		Currency:         d.Currency,
		DeadlineAt:       d.DeadlineAt,
		PaidAt:           d.PaidAt,
		CreatedAt:        d.CreatedAt,
		Participants:     parts,
		PaymentAccount: apigen.OrderPaymentAccount{
			Id:              d.PaymentAccount.ID,
			Name:            d.PaymentAccount.Name,
			Provider:        d.PaymentAccount.Provider,
			AccountName:     d.PaymentAccount.AccountName,
			AccountNoMasked: d.PaymentAccount.AccountNoMasked,
			QrFileId:        d.PaymentAccount.QRFileID,
		},
	}
	if d.LastRejection != nil {
		out.LastRejection = &apigen.OrderRejection{
			Code:       d.LastRejection.Code,
			Reason:     d.LastRejection.Reason,
			ReviewedAt: d.LastRejection.ReviewedAt,
		}
	}
	return out
}

// orderDetailFromAPI 是 toAPIOrderDetail 的逆变换，只还原接口里暴露的字段（用于幂等重放）。
func orderDetailFromAPI(a apigen.OrderDetail) OrderDetail {
	d := OrderDetail{
		Order: Order{
			OrderNo:          a.OrderNo,
			Status:           string(a.Status),
			ListAmountCents:  a.ListAmountCents,
			DiscountCents:    a.DiscountCents,
			IdentOffsetCents: a.IdentOffsetCents,
			AmountCents:      a.AmountCents,
			Currency:         a.Currency,
			PaymentAccountID: a.PaymentAccount.Id,
			DeadlineAt:       a.DeadlineAt,
			PaidAt:           a.PaidAt,
			CreatedAt:        a.CreatedAt,
		},
		EventSlug:     a.EventSlug,
		EventName:     localizedFromAPI(a.EventName),
		EventTimezone: a.EventTimezone,
		PaymentAccount: PaymentAccountView{
			ID:              a.PaymentAccount.Id,
			Name:            a.PaymentAccount.Name,
			Provider:        a.PaymentAccount.Provider,
			AccountName:     a.PaymentAccount.AccountName,
			AccountNoMasked: a.PaymentAccount.AccountNoMasked,
			QRFileID:        a.PaymentAccount.QrFileId,
		},
	}
	for _, p := range a.Participants {
		d.Participants = append(d.Participants, OrderParticipant{
			RegNo:              p.RegNo,
			CategoryID:         p.CategoryId,
			CategoryName:       localizedFromAPI(p.CategoryName),
			FullName:           p.FullName,
			PriceRuleID:        p.PriceRuleId,
			ListPriceCents:     p.ListPriceCents,
			PaidCents:          p.PaidCents,
			RegistrationStatus: string(p.RegistrationStatus),
			TicketCode:         p.TicketCode,
		})
	}
	if a.LastRejection != nil {
		d.LastRejection = &LastRejection{Code: a.LastRejection.Code, Reason: a.LastRejection.Reason, ReviewedAt: a.LastRejection.ReviewedAt}
	}
	return d
}

func localizedToAPI(t i18n.Text) apigen.LocalizedText {
	pick := func(l i18n.Lang) *string {
		v, ok := t[l]
		if !ok {
			return nil
		}
		return &v
	}
	return apigen.LocalizedText{Zh: pick(i18n.ZH), En: pick(i18n.EN), Km: pick(i18n.KM)}
}

func localizedFromAPI(l apigen.LocalizedText) i18n.Text {
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

把 handler 接入 `Server`：

- `api/internal/httpapi/server.go`：在类型别名块里加一行 `RegistrationHandlers = registration.Handlers`；在 `Server` 结构体末尾加一行 `*RegistrationHandlers`；在 `NewServer` 返回的字面量末尾加一行 `RegistrationHandlers: registration.NewHandlers(d.Registration),`；import 加 `"werun/api/internal/registration"`。
- `api/internal/httpapi/router.go`：`RouterDeps` 结构体中 `Pricing` 字段下面加一行 `Registration *registration.Service`；import 加 `"werun/api/internal/registration"`。
- `api/cmd/werun/app.go`：`App` 结构体加字段 `Registration *registration.Service`；在 `Bootstrap` 中 `app.Pricing` 与 `app.Runner` 都已赋值之后、`app.Payment` 赋值之前加入：

```go
	app.Registration = registration.NewService(app.Pool, app.Runner, app.Pricing, time.Now)
```

  `app.Payment = payment.NewService(...)` 这一行保持不变（Task 15 才给它加 `orders` 参数）；import 加 `"werun/api/internal/registration"`。
- `api/cmd/werun/router.go`：`httpapi.RouterDeps{...}` 字面量中加一行 `Registration: app.Registration,`。

- [ ] **Step 9: 运行 registration 测试，确认通过**

Run: `cd api && go build ./... && env $DBENV go test ./internal/registration/... -v`
Expected: 编译通过；`TestNormalizeCreateInputCleansValues`、`TestNormalizeCreateInputReportsFieldErrors`（10 个子测试）、`TestRequestHashIgnoresKeyItemOrderAndFormatting`、`TestRegistrationOpen`、`TestOrderDetailAPIRoundTrip`，以及 `TestCreateOrder*`（11 个）、`TestPreviewQuote` 全部 PASS。

Run: `cd api && env $DBENV go test ./internal/registration/ -run 'TestCreateOrderIdentOffsetsAreDistinctUnderConcurrency|TestCreateOrderLastSeatUnderConcurrency' -count=5`
Expected: `ok`。

- [ ] **Step 10: 公开赛事接口补字段（调整 #8）——先改测试**

先核对 Task 3 是否已给 `event` 模型加过字段：

```bash
cd api && grep -n "RegistrationOpen\|RegistrationOpensAt\|RegistrationClosesAt\|MinAge\|UsedCount\|ReservedCount" internal/event/model.go internal/event/service.go
```

下面 Step 11 只补缺少的字段，名字固定为：`Event.RegistrationOpen bool`、`Event.RegistrationOpensAt *time.Time`、`Event.RegistrationClosesAt *time.Time`、`Category.MinAge int16`、`Category.UsedCount int32`、`Category.ReservedCount int32`。

在 `api/internal/event/service_test.go` 末尾追加：

```go
func TestServicePublicEventExposesRegistrationFields(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := event.NewService(pool)
	actor := newActor(t, pool, iam.RoleOps, "ops.public.fields")
	ctx := context.Background()
	created, err := svc.Create(ctx, actor, validInput())
	require.NoError(t, err)
	_, err = svc.Publish(ctx, actor, created.ID)
	require.NoError(t, err)
	opens := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	_, err = pool.Exec(ctx, `UPDATE events SET registration_open = true, registration_opens_at = $2 WHERE id = $1`, created.ID, opens)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE event_categories SET min_age = 16, used_count = 500, reserved_count = 300 WHERE event_id = $1`, created.ID)
	require.NoError(t, err)

	got, err := svc.GetPublic(ctx, "pphm-2026")

	require.NoError(t, err)
	require.True(t, got.RegistrationOpen)
	require.NotNil(t, got.RegistrationOpensAt)
	require.True(t, got.RegistrationOpensAt.Equal(opens))
	require.Nil(t, got.RegistrationClosesAt)
	require.Equal(t, int16(16), got.Categories[0].MinAge)
	require.Equal(t, int32(500), got.Categories[0].UsedCount)
	require.Equal(t, int32(300), got.Categories[0].ReservedCount)
}
```

`api/internal/httpapi/events_http_test.go` 的 `TestOpsCreatesAndPublishesEventThenPublicSeesIt` 中，把：

```go
	rec = env.do(t, http.MethodGet, "/api/events/pphm-2026?lang=en", nil, nil, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, "Phnom Penh Half Marathon 2026", eventsDecode[apigen.PublicEvent](t, rec).Name)
```

替换为：

```go
	rec = env.do(t, http.MethodGet, "/api/events/pphm-2026?lang=en", nil, nil, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	detail := eventsDecode[apigen.PublicEvent](t, rec)
	require.Equal(t, "Phnom Penh Half Marathon 2026", detail.Name)
	require.Equal(t, published.Id, detail.Id)
	require.Equal(t, apigen.PublicEventEventType("RACE"), detail.EventType)
	require.False(t, detail.RegistrationOpen)
	require.Nil(t, detail.RegistrationOpensAt)
	require.Nil(t, detail.RegistrationClosesAt)
	require.Equal(t, published.Categories[0].Id, detail.Categories[0].Id)
	require.Equal(t, int32(0), detail.Categories[0].MinAge)
	require.False(t, detail.Categories[0].SoldOut)
```

Run: `cd api && env $DBENV go test ./internal/event/ ./internal/httpapi/ -run 'TestServicePublicEventExposesRegistrationFields|TestOpsCreatesAndPublishesEventThenPublicSeesIt'`
Expected: 编译失败 `got.RegistrationOpen undefined`（若 Task 3 已加 `Event` 字段，则失败点为 `got.Categories[0].MinAge undefined`）；补齐模型后 HTTP 测试会因 `detail.Id` 为 0 失败。

- [ ] **Step 11: 公开赛事接口补字段——实现**

`api/internal/event/model.go`：`Event` 结构体在 `PublishedAt *time.Time` 之后加入（已有的跳过）：

```go
	RegistrationOpen     bool
	RegistrationOpensAt  *time.Time
	RegistrationClosesAt *time.Time
```

`Category` 结构体在 `CutoffAt *time.Time` 之后加入（已有的跳过）：

```go
	MinAge        int16
	UsedCount     int32
	ReservedCount int32
```

`api/internal/event/service.go`：`eventFromRow` 返回的字面量中 `PublishedAt: r.PublishedAt,` 之后加入（已有的跳过）：

```go
		RegistrationOpen:     r.RegistrationOpen,
		RegistrationOpensAt:  r.RegistrationOpensAt,
		RegistrationClosesAt: r.RegistrationClosesAt,
```

`categoryFromRow` 返回的字面量中 `CutoffAt: r.CutoffAt,` 之后加入（已有的跳过）：

```go
		MinAge:        r.MinAge,
		UsedCount:     r.UsedCount,
		ReservedCount: r.ReservedCount,
```

`api/internal/event/handlers.go`：把 `toPublicEvent` 整个函数替换为：

```go
func toPublicEvent(e Event, lang i18n.Lang) apigen.PublicEvent {
	cats := make([]apigen.PublicCategory, 0, len(e.Categories))
	for _, c := range e.Categories {
		cats = append(cats, apigen.PublicCategory{
			Id:        c.ID,
			Code:      c.Code,
			Name:      c.Name.In(lang),
			DistanceM: c.DistanceM,
			Capacity:  c.Capacity,
			StartAt:   derefTime(c.StartAt),
			CutoffAt:  derefTime(c.CutoffAt),
			MinAge:    int32(c.MinAge),
			SoldOut:   int64(c.UsedCount)+int64(c.ReservedCount) >= int64(c.Capacity),
		})
	}
	return apigen.PublicEvent{
		Id:                   e.ID,
		Slug:                 e.Slug,
		EventType:            apigen.PublicEventEventType(e.EventType),
		Name:                 e.Name.In(lang),
		City:                 e.City,
		RaceDate:             openapi_types.Date{Time: e.RaceDate},
		RegistrationOpen:     e.RegistrationOpen,
		RegistrationOpensAt:  e.RegistrationOpensAt,
		RegistrationClosesAt: e.RegistrationClosesAt,
		Categories:           cats,
	}
}
```

Run: `cd api && env $DBENV go test ./internal/event/ ./internal/httpapi/ -run 'TestServicePublicEventExposesRegistrationFields|TestOpsCreatesAndPublishesEventThenPublicSeesIt' -v`
Expected: 两个测试 PASS。

- [ ] **Step 12: 写下单 HTTP 测试并运行**

创建 `api/internal/httpapi/registration_http_test.go`：

```go
package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"werun/api/internal/event"
	"werun/api/internal/httpapi"
	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/logx"
	"werun/api/internal/pricing"
	"werun/api/internal/registration"
	"werun/api/internal/runner"
	fx "werun/api/internal/testfixture"
)

type orderHTTPEnv struct {
	router  http.Handler
	pool    *pgxpool.Pool
	runners *runner.Service
	event   fx.Event
	token   string
}

func newOrderHTTPEnv(t *testing.T) orderHTTPEnv {
	t.Helper()
	gin.SetMode(gin.TestMode)
	pool := dbtest.NewPool(t)
	catalog, err := i18n.LoadCatalog()
	require.NoError(t, err)
	runners := fx.RunnerService(t, pool, time.Now)
	prices := pricing.NewService(pool, time.Now)
	router := httpapi.NewRouter(httpapi.RouterDeps{
		Log:          logx.New("error", io.Discard),
		Catalog:      catalog,
		Pool:         pool,
		IAM:          iam.NewService(pool, []byte(strings.Repeat("k", 32)), iam.NewLoginLimiter(time.Now), time.Now),
		Events:       event.NewService(pool),
		Runner:       runners,
		Pricing:      prices,
		Registration: registration.NewService(pool, runners, prices, time.Now),
		Env:          "dev",
	})
	ev := fx.RaceEvent(t, pool, fx.EventOpts{Slug: "http-order-run", RegistrationOpen: true,
		Categories: []fx.CategoryOpts{{Code: "21K", Capacity: 50, MinAge: 16}}})
	fx.PriceRule(t, pool, ev.ID, fx.PriceRuleOpts{PriceCents: 2500, CategoryIDs: ev.CategoryIDs})
	fx.PaymentAccount(t, pool, &ev.ID)
	fx.Coupon(t, pool, fx.CouponOpts{Code: "RUN20", EventID: &ev.ID, DiscountType: "PERCENT", DiscountValue: 20, Quota: 5})
	fx.RegistrationConsent(t, runners)
	env := orderHTTPEnv{router: router, pool: pool, runners: runners, event: ev}
	env.token = env.login(t, 910001)
	return env
}

func (e orderHTTPEnv) login(t *testing.T, telegramID int64) string {
	t.Helper()
	initData := runner.SignInitData(fx.BotToken, runner.TelegramUser{
		ID: telegramID, FirstName: "Dara", Username: fmt.Sprintf("dara%d", telegramID), LanguageCode: "en",
	}, time.Now())
	sess, err := e.runners.LoginTelegram(context.Background(), initData, httpx.Meta{IP: "127.0.0.1", UserAgent: "orders-http-test"})
	require.NoError(t, err)
	return sess.Token
}

func (e orderHTTPEnv) do(t *testing.T, method, path string, body any, token string, header http.Header) *httptest.ResponseRecorder {
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
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
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

func (e orderHTTPEnv) orderBody(idNo string) map[string]any {
	return map[string]any{
		"eventSlug":  e.event.Slug,
		"couponCode": "run20",
		"consent": map[string]any{
			"version":      fx.ConsentVersion,
			"lang":         "zh",
			"checkedItems": []string{"terms", "rules", "health"},
		},
		"participants": []map[string]any{{
			"categoryId": e.event.CategoryIDs[0],
			"profile": map[string]any{
				"fullName": "Chan Sophea", "gender": "F", "birthDate": "1990-05-01", "nationality": "KH",
				"idType": "PASSPORT", "idNo": idNo, "phone": "+85512345678",
				"emergencyName": "Sok Dara", "emergencyPhone": "+85598765432", "tshirtSize": "M",
			},
		}},
	}
}

func idemHeader(key string) http.Header {
	return http.Header{"Idempotency-Key": []string{key}}
}

func TestAppQuoteAndCreateOrderHTTP(t *testing.T) {
	env := newOrderHTTPEnv(t)
	body := env.orderBody("N01234567")

	rec := env.do(t, http.MethodPost, "/api/app/orders", body, "", idemHeader("http-order-key-01"))
	require.Equal(t, http.StatusUnauthorized, rec.Code, rec.Body.String())
	require.Equal(t, apperr.CodeUnauthenticated, eventsDecode[httpx.ErrorBody](t, rec).Error.Code)

	rec = env.do(t, http.MethodPost, "/api/app/orders", body, env.token, nil)
	require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
	require.Equal(t, apperr.CodeBadRequest, eventsDecode[httpx.ErrorBody](t, rec).Error.Code)

	rec = env.do(t, http.MethodPost, "/api/app/orders", body, env.token, idemHeader("short"))
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	errBody := eventsDecode[httpx.ErrorBody](t, rec)
	require.Equal(t, apperr.CodeValidation, errBody.Error.Code)
	require.Contains(t, errBody.Error.Fields, "idempotencyKey")

	rec = env.do(t, http.MethodPost, "/api/app/events/"+env.event.Slug+"/quote", map[string]any{
		"couponCode":   "run20",
		"participants": []map[string]any{{"categoryId": env.event.CategoryIDs[0], "nationality": "KH", "birthDate": "1990-05-01"}},
	}, env.token, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	quote := eventsDecode[apigen.Quote](t, rec)
	require.True(t, quote.CouponApplied)
	require.Equal(t, int64(500), quote.CouponDiscountCents)
	require.Equal(t, int64(0), quote.IdentOffsetCents)
	require.Equal(t, int64(2000), quote.AmountCents)

	first := env.do(t, http.MethodPost, "/api/app/orders", body, env.token, idemHeader("http-order-key-01"))
	require.Equal(t, http.StatusCreated, first.Code, first.Body.String())
	order := eventsDecode[apigen.OrderDetail](t, first)
	require.Equal(t, apigen.OrderStatus("PENDING_PAYMENT"), order.Status)
	require.Equal(t, int64(1999), order.AmountCents)
	require.Equal(t, int64(1), order.IdentOffsetCents)
	require.NotNil(t, order.DeadlineAt)
	require.Equal(t, "21K run", *order.Participants[0].CategoryName.En)
	require.Nil(t, order.Participants[0].TicketCode)

	second := env.do(t, http.MethodPost, "/api/app/orders", body, env.token, http.Header{
		"Idempotency-Key": []string{"http-order-key-01"},
		"Accept-Language": []string{"km"},
	})
	require.Equal(t, http.StatusCreated, second.Code, second.Body.String())
	require.JSONEq(t, first.Body.String(), second.Body.String(), "同键同请求体返回首次响应，与语言无关")

	changed := env.orderBody("N01234567")
	delete(changed, "couponCode")
	rec = env.do(t, http.MethodPost, "/api/app/orders", changed, env.token, idemHeader("http-order-key-01"))
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	require.Equal(t, apperr.CodeIdempotencyKeyReused, eventsDecode[httpx.ErrorBody](t, rec).Error.Code)

	rec = env.do(t, http.MethodPost, "/api/app/orders", env.orderBody("N01234567"), env.token, http.Header{
		"Idempotency-Key": []string{"http-order-key-02"},
		"Accept-Language": []string{"en"},
	})
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	dup := eventsDecode[httpx.ErrorBody](t, rec)
	require.Equal(t, apperr.CodeAlreadyRegistered, dup.Error.Code)
	require.Equal(t, "This ID number is already registered for this event.", dup.Error.Fields["participants[0].idNo"])
}
```

> `RouterDeps` 的 `Runner`、`Pricing` 字段由 Task 7、4 加入；`AuthMiddleware` 的跑者分支读取 `d.Runner`。若 Task 6 的 `RouterDeps` 还要求 `Payment`/`Store`，本测试不访问这些接口，保持零值即可。

Run: `cd api && env $DBENV go test ./internal/httpapi/ -run TestAppQuoteAndCreateOrderHTTP -v`
Expected: PASS。

- [ ] **Step 13: 同步用户端测试夹具**

`make gen` 已重新生成 `packages/api-client/src/schema.d.ts`，`PublicEvent` 多了必填字段，`web/user/src/test/fixtures.ts` 需要补齐。把 `halfMarathon` 常量整体替换为：

```ts
export const halfMarathon: Schemas["PublicEvent"] = {
  id: 1,
  slug: "phnom-penh-half-2026",
  eventType: "RACE",
  name: "Phnom Penh Half Marathon 2026",
  city: "Phnom Penh",
  raceDate: "2026-11-15",
  registrationOpen: true,
  registrationOpensAt: null,
  registrationClosesAt: null,
  categories: [
    {
      id: 11,
      code: "21K",
      name: "Half marathon",
      distanceM: 21097,
      capacity: 800,
      startAt: "2026-11-14T23:00:00Z",
      cutoffAt: "2026-11-15T02:30:00Z",
      minAge: 16,
      soldOut: false,
    },
    {
      id: 12,
      code: "10K",
      name: "Fun run",
      distanceM: 10000,
      capacity: 1200,
      startAt: "2026-11-14T23:30:00Z",
      cutoffAt: "2026-11-15T02:00:00Z",
      minAge: 0,
      soldOut: false,
    },
  ],
};
```

Run: `pnpm typecheck && pnpm --filter @werun/user test`
Expected: 类型检查通过；用户端测试全部通过。

- [ ] **Step 14: 全量检查并提交**

Run: `make gen && git diff --stat`
Expected: 重新生成不产生本任务之外的改动（`git diff --stat` 只列出本任务的文件）。

Run: `cd api && env $DBENV go test ./... && go tool golangci-lint run ./...`
Expected: 所有包 `ok`；`0 issues.`。

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm i18n:check`
Expected: 全部通过。

```bash
git add api/db/queries/registration.sql api/sqlc.yaml api/internal/registration api/internal/testfixture \
  api/openapi/openapi.yaml api/internal/httpapi api/internal/event api/cmd/werun \
  api/internal/platform/apperr api/internal/platform/i18n \
  packages/api-client/src/schema.d.ts web/user/src/test/fixtures.ts
git commit -m "$(cat <<'EOF'
feat(api): create registration orders with idempotency, reservations and zero-amount confirmation

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
)"
```

---

### Task 13: 我的订单与取消

**Files:**
- Modify: `api/db/queries/registration.sql`（末尾追加）
- Generate: `api/internal/registration/store/`
- Modify: `api/internal/registration/orders.go`（整文件替换）
- Modify: `api/internal/registration/handlers.go`（追加 3 个 handler 与 `toAPIOrderSummary`）
- Modify: `api/internal/testfixture/fixture.go`（追加 `RejectedProof`）
- Test: `api/internal/registration/orders_test.go`
- Modify: `api/internal/httpapi/registration_http_test.go`（追加 `TestAppOrdersHTTP`）
- Modify: `api/openapi/openapi.yaml`；Generate: `apigen`、`packages/api-client/src/schema.d.ts`
- Modify: `api/internal/platform/apperr/apperr.go`、`apperr_test.go`、`api/internal/platform/i18n/messages.{zh,en,km}.json`

**Interfaces:**
- Consumes: Task 12 的 `loadDetail`、`runnerAudit`、`orderEnv`/`requireAppErr`/`testMeta`（同包测试）、`pricing.Release`、`newOrderHTTPEnv`。
- Produces（照抄契约）:

```go
func (s *Service) ListMyOrders(ctx context.Context, u runner.User) ([]OrderSummary, error)
func (s *Service) GetMyOrder(ctx context.Context, u runner.User, orderNo string) (OrderDetail, error) // 不属于该用户返回 ORDER_NOT_FOUND(404)
func (s *Service) CancelOrder(ctx context.Context, u runner.User, orderNo string, meta httpx.Meta) (OrderDetail, error)
type ReleaseKind string
const (ReleaseExpired ReleaseKind = "ORDER_EXPIRED"; ReleaseCancelled ReleaseKind = "ORDER_CANCELLED")
func (s *Service) ReleaseOrder(ctx context.Context, tx pgx.Tx, orderID int64, kind ReleaseKind) (bool, error)
```

  - `Handlers.AppListOrders`、`AppGetOrder`、`AppCancelOrder`；OpenAPI `appListOrders`、`appGetOrder`、`appCancelOrder`，schema `OrderSummary`、`OrderList`。
  - `CodeOrderNotFound`(404)；审计 `reg_order.cancel`。
  - `testfixture.RejectedProof(t, pool, orderID, accountID int64, code string, reason *string, reviewedAt time.Time) int64`。

**数据库事实**：`reg_orders` 的 `CHECK (status NOT IN ('EXPIRED','CANCELLED') OR reservation_state = 'RELEASED')`、`reservation_release_kind IN ('ORDER_EXPIRED','ORDER_CANCELLED')`、`expired_at`、`cancelled_at`；`registrations` 的 `cancel_reason IN ('ORDER_EXPIRED','ORDER_CANCELLED','REFUND_SETTLED')` 且与 `status = 'CANCELLED'` 同时出现；`payment_proofs` 在 `status = 'REJECTED'` 时必须有 `reviewed_by`、`reviewed_at`、`reject_code`。

- [ ] **Step 1: 错误码失败测试与实现**

`apperr_test.go`：`assert.Len(t, apperr.AllCodes, 32)` 改为 `assert.Len(t, apperr.AllCodes, 33)`。

Run: `cd api && go test ./internal/platform/apperr/`
Expected: FAIL `should have 33 item(s), but has 32`。

`apperr.go` 错误码 `const` 块末尾追加 `CodeOrderNotFound = "ORDER_NOT_FOUND"`，`AllCodes` 末尾追加 `CodeOrderNotFound,`。三份文案加入：

- `messages.zh.json`：`"ORDER_NOT_FOUND": "找不到这张订单。"`
- `messages.en.json`：`"ORDER_NOT_FOUND": "Order not found."`
- `messages.km.json`：`"ORDER_NOT_FOUND": "រកមិនឃើញការបញ្ជាទិញនេះទេ។"`

Run: `cd api && go test ./internal/platform/apperr/ ./internal/platform/i18n/`
Expected: `ok` ×2。

- [ ] **Step 2: 追加查询、OpenAPI 并生成**

在 `api/db/queries/registration.sql` 末尾追加：

```sql
-- name: ListOrdersForBuyer :many
SELECT o.id, o.order_no, o.event_id, o.buyer_user_id, o.status, o.reservation_state,
       o.list_amount_cents, o.discount_cents, o.ident_offset_cents, o.amount_cents, o.currency,
       o.payment_account_id, o.deadline_at, o.paid_at, o.created_at,
       e.slug AS event_slug, e.name AS event_name,
       (SELECT count(*) FROM order_participants op WHERE op.order_id = o.id) AS participant_count
FROM reg_orders o
JOIN events e ON e.id = o.event_id
WHERE o.buyer_user_id = @buyer_user_id::bigint
ORDER BY o.created_at DESC, o.id DESC
LIMIT 100;

-- name: GetOrderIDForBuyer :one
SELECT id
FROM reg_orders
WHERE order_no = @order_no AND buyer_user_id = @buyer_user_id::bigint;

-- name: LockOrderForBuyer :one
SELECT id, event_id, status
FROM reg_orders
WHERE order_no = @order_no AND buyer_user_id = @buyer_user_id::bigint
FOR UPDATE;

-- name: ReleaseOrderExpired :execrows
UPDATE reg_orders
SET status = 'EXPIRED',
    reservation_state = 'RELEASED',
    reservation_release_kind = 'ORDER_EXPIRED',
    expired_at = @at::timestamptz,
    deadline_at = NULL,
    version = version + 1
WHERE id = @id
  AND reservation_state = 'RESERVED'
  AND status IN ('PENDING_PAYMENT', 'PROOF_REJECTED');

-- name: ReleaseOrderCancelled :execrows
UPDATE reg_orders
SET status = 'CANCELLED',
    reservation_state = 'RELEASED',
    reservation_release_kind = 'ORDER_CANCELLED',
    cancelled_at = @at::timestamptz,
    deadline_at = NULL,
    version = version + 1
WHERE id = @id
  AND reservation_state = 'RESERVED'
  AND status = 'PENDING_PAYMENT';

-- name: CancelOrderRegistrations :execrows
UPDATE registrations r
SET status = 'CANCELLED', cancel_reason = @cancel_reason::text, version = r.version + 1
FROM order_participants op
WHERE op.id = r.order_participant_id
  AND op.order_id = @order_id::bigint
  AND r.status = 'PENDING';
```

`api/openapi/openapi.yaml`：在 Task 12 加的 `/app/orders:` 路径下、`post:` 之前插入：

```yaml
    get:
      operationId: appListOrders
      summary: 我的订单（最近 100 张，新的在前）
      x-auth: app
      responses:
        '200':
          description: 订单列表
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/OrderList'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
```

在 `paths:` 段末尾追加：

```yaml
  /app/orders/{orderNo}:
    get:
      operationId: appGetOrder
      summary: 订单详情（不属于当前跑者时 404）
      x-auth: app
      parameters:
        - name: orderNo
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: 订单详情
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/OrderDetail'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
  /app/orders/{orderNo}/cancel:
    post:
      operationId: appCancelOrder
      summary: 付款前取消订单并释放名额
      x-auth: app
      parameters:
        - name: orderNo
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: 已取消
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/OrderDetail'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
```

在 `components.schemas` 末尾追加：

```yaml
    OrderSummary:
      type: object
      required: [orderNo, status, eventSlug, eventName, amountCents, currency, participantCount, deadlineAt, createdAt]
      properties:
        orderNo:
          type: string
        status:
          $ref: '#/components/schemas/OrderStatus'
        eventSlug:
          type: string
        eventName:
          $ref: '#/components/schemas/LocalizedText'
        amountCents:
          type: integer
          format: int64
        currency:
          type: string
        participantCount:
          type: integer
          format: int32
        deadlineAt:
          type: string
          format: date-time
          nullable: true
        createdAt:
          type: string
          format: date-time
    OrderList:
      type: object
      required: [items]
      properties:
        items:
          type: array
          items:
            $ref: '#/components/schemas/OrderSummary'
```

Run: `make gen && cd api && go build ./...`
Expected: 生成成功；`permissions.gen.go` 含 `AppListOrders`、`AppGetOrder`、`AppCancelOrder` 三个 `AuthApp`；编译失败 `*Server does not implement StrictServerInterface (missing method AppCancelOrder)`；`ListOrdersForBuyerRow.ParticipantCount` 为 `int64`，`LockOrderForBuyerRow` 含 `ID`、`EventID`、`Status`。

- [ ] **Step 3: 写失败测试**

在 `api/internal/testfixture/fixture.go` 末尾追加：

```go
// RejectedProof 为订单写一份已驳回的凭证（附带审核员工与 PRIVATE 截图文件行）。
func RejectedProof(t testing.TB, pool *pgxpool.Pool, orderID, accountID int64, code string, reason *string, reviewedAt time.Time) int64 {
	t.Helper()
	staffID := scanID(t, pool, `INSERT INTO staff (username, full_name, role, password_hash)
		VALUES ($1, 'Finance Fixture', 'FINANCE', 'fixture-not-a-hash') RETURNING id`, "finance."+randHex(4))
	sha := make([]byte, 32)
	_, _ = rand.Read(sha)
	fileID := scanID(t, pool, `INSERT INTO files
		(storage_key, visibility, purpose, mime_type, size_bytes, sha256, width, height, uploaded_by_type)
		VALUES ($1, 'PRIVATE', 'PAYMENT_PROOF', 'image/jpeg', 2048, $2, 720, 1280, 'USER')
		RETURNING id`, "2026/09/"+randHex(16)+".jpg", sha)
	return scanID(t, pool, `INSERT INTO payment_proofs
		(proof_no, reg_order_id, payment_account_id, file_id, declared_amount_cents, declared_currency,
		 bank_txn_ref, status, reviewed_by, reviewed_at, reject_code, reject_reason)
		VALUES ($1, $2, $3, $4, 100, 'USD', $5, 'REJECTED', $6, $7, $8, $9)
		RETURNING id`, "PFFX"+randHex(4), orderID, accountID, fileID, "TXN"+randHex(6), staffID, reviewedAt, code, reason)
}
```

创建 `api/internal/registration/orders_test.go`：

```go
package registration_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/registration"
	fx "werun/api/internal/testfixture"
)

func TestCancelOrderReleasesReservation(t *testing.T) {
	e := newOrderEnv(t, 10)
	ctx := context.Background()
	coupon := fx.Coupon(t, e.pool, fx.CouponOpts{Code: "RUN20", DiscountType: "PERCENT", DiscountValue: 20, Quota: 5})
	in := e.input("cancel-key-0001",
		fx.Profile("Chan Sophea", "N01234567", "KH", "1990-05-01"),
		fx.Profile("Lim Dara", "P7654321", "US", "1992-08-20"))
	in.CouponCode = "RUN20"
	d, err := e.svc.CreateOrder(ctx, e.user, in, testMeta)
	require.NoError(t, err)

	cancelled, err := e.svc.CancelOrder(ctx, e.user, d.OrderNo, testMeta)

	require.NoError(t, err)
	require.Equal(t, registration.StatusCancelled, cancelled.Status)
	require.Equal(t, "RELEASED", cancelled.ReservationState)
	require.Nil(t, cancelled.DeadlineAt)
	for _, p := range cancelled.Participants {
		require.Equal(t, registration.RegistrationCancelled, p.RegistrationStatus)
		require.Nil(t, p.TicketCode)
	}
	require.Equal(t, fx.Counts{}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))
	require.Equal(t, fx.Counts{}, e.counts(t, "price_rules", e.rule))
	require.Equal(t, fx.Counts{}, e.counts(t, "coupons", coupon))
	require.Equal(t, 1, fx.Count(t, e.pool, `SELECT count(*) FROM coupon_redemptions WHERE order_id = $1 AND state = 'RELEASED'`, d.ID))
	require.Equal(t, 2, fx.Count(t, e.pool,
		`SELECT count(*) FROM registrations WHERE status = 'CANCELLED' AND cancel_reason = 'ORDER_CANCELLED'`))
	require.Equal(t, 1, fx.Count(t, e.pool,
		`SELECT count(*) FROM reg_orders WHERE id = $1 AND cancelled_at IS NOT NULL AND reservation_release_kind = 'ORDER_CANCELLED'`, d.ID))
	require.Equal(t, 1, fx.Count(t, e.pool,
		`SELECT count(*) FROM audit_logs WHERE action = 'reg_order.cancel' AND entity_id = $1 AND actor_type = 'USER' AND actor_id = $2 AND is_financial`,
		d.ID, e.user.ID))

	_, err = e.svc.CancelOrder(ctx, e.user, d.OrderNo, testMeta)
	requireAppErr(t, err, apperr.CodeOrderStateConflict, http.StatusConflict)
	require.Equal(t, fx.Counts{}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))

	_, err = e.svc.CreateOrder(ctx, e.user, e.input("cancel-key-0002", fx.Profile("Chan Sophea", "N01234567", "KH", "1990-05-01")), testMeta)
	require.NoError(t, err, "取消后的报名不再算已报名")
}

func TestCancelOrderRules(t *testing.T) {
	e := newOrderEnv(t, 10)
	ctx := context.Background()
	d, err := e.svc.CreateOrder(ctx, e.user, e.input("rules-key-0001", fx.Profile("Chan Sophea", "N01234567", "KH", "1990-05-01")), testMeta)
	require.NoError(t, err)

	other := fx.Runner(t, e.pool, 900010, "Other")
	_, err = e.svc.CancelOrder(ctx, other, d.OrderNo, testMeta)
	requireAppErr(t, err, apperr.CodeOrderNotFound, http.StatusNotFound)
	_, err = e.svc.CancelOrder(ctx, e.user, "WR00000000", testMeta)
	requireAppErr(t, err, apperr.CodeOrderNotFound, http.StatusNotFound)

	fx.Exec(t, e.pool, `UPDATE reg_orders SET status = 'PROOF_SUBMITTED', deadline_at = NULL WHERE id = $1`, d.ID)
	_, err = e.svc.CancelOrder(ctx, e.user, d.OrderNo, testMeta)
	requireAppErr(t, err, apperr.CodeOrderStateConflict, http.StatusConflict)
	require.Equal(t, fx.Counts{Reserved: 1}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))

	fx.Coupon(t, e.pool, fx.CouponOpts{Code: "FREE1", DiscountType: "WAIVER", Quota: 1})
	freeIn := e.input("rules-key-0002", fx.Profile("Keo Nita", "K100200", "KH", "1995-01-01"))
	freeIn.CouponCode = "FREE1"
	paid, err := e.svc.CreateOrder(ctx, e.user, freeIn, testMeta)
	require.NoError(t, err)
	_, err = e.svc.CancelOrder(ctx, e.user, paid.OrderNo, testMeta)
	requireAppErr(t, err, apperr.CodeOrderStateConflict, http.StatusConflict)
	require.Equal(t, fx.Counts{Used: 1, Reserved: 1}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))
}

func TestReleaseOrderExpiredReleasesOnlyOnce(t *testing.T) {
	e := newOrderEnv(t, 10)
	ctx := context.Background()
	d, err := e.svc.CreateOrder(ctx, e.user, e.input("expire-key-0001", fx.Profile("Chan Sophea", "N01234567", "KH", "1990-05-01")), testMeta)
	require.NoError(t, err)
	release := func(kind registration.ReleaseKind) (bool, error) {
		var released bool
		err := db.InTx(ctx, e.pool, func(tx pgx.Tx) error {
			r, err := e.svc.ReleaseOrder(ctx, tx, d.ID, kind)
			released = r
			return err
		})
		return released, err
	}

	released, err := release(registration.ReleaseExpired)
	require.NoError(t, err)
	require.True(t, released)
	require.Equal(t, 1, fx.Count(t, e.pool,
		`SELECT count(*) FROM reg_orders WHERE id = $1 AND status = 'EXPIRED' AND reservation_state = 'RELEASED'
		 AND reservation_release_kind = 'ORDER_EXPIRED' AND expired_at IS NOT NULL AND deadline_at IS NULL`, d.ID))
	require.Equal(t, 1, fx.Count(t, e.pool, `SELECT count(*) FROM registrations WHERE status = 'CANCELLED' AND cancel_reason = 'ORDER_EXPIRED'`))
	require.Equal(t, fx.Counts{}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))

	released, err = release(registration.ReleaseExpired)
	require.NoError(t, err)
	require.False(t, released, "条件更新保证只释放一次")
	released, err = release(registration.ReleaseCancelled)
	require.NoError(t, err)
	require.False(t, released)
	require.Equal(t, fx.Counts{}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))
	require.Equal(t, fx.Counts{}, e.counts(t, "price_rules", e.rule))
}

func TestGetMyOrder(t *testing.T) {
	e := newOrderEnv(t, 10)
	ctx := context.Background()
	d, err := e.svc.CreateOrder(ctx, e.user, e.input("get-key-0001", fx.Profile("Chan Sophea", "N01234567", "KH", "1990-05-01")), testMeta)
	require.NoError(t, err)

	got, err := e.svc.GetMyOrder(ctx, e.user, d.OrderNo)
	require.NoError(t, err)
	require.Equal(t, d.OrderNo, got.OrderNo)
	require.Equal(t, d.AmountCents, got.AmountCents)
	require.Equal(t, e.account, got.PaymentAccount.ID)
	require.Len(t, got.Participants, 1)
	require.Nil(t, got.Participants[0].TicketCode)
	require.Nil(t, got.LastRejection)

	other := fx.Runner(t, e.pool, 900011, "Other")
	_, err = e.svc.GetMyOrder(ctx, other, d.OrderNo)
	requireAppErr(t, err, apperr.CodeOrderNotFound, http.StatusNotFound)

	now := e.clock.Now()
	fx.Exec(t, e.pool, `UPDATE reg_orders SET status = 'PROOF_REJECTED', deadline_at = $2 WHERE id = $1`, d.ID, now.Add(24*time.Hour))
	fx.RejectedProof(t, e.pool, d.ID, e.account, "AMOUNT_MISMATCH", nil, now.Add(-2*time.Hour))
	fx.RejectedProof(t, e.pool, d.ID, e.account, "UNREADABLE", fx.Ptr("截图看不清"), now.Add(-time.Hour))

	got, err = e.svc.GetMyOrder(ctx, e.user, d.OrderNo)
	require.NoError(t, err)
	require.Equal(t, registration.StatusProofRejected, got.Status)
	require.NotNil(t, got.LastRejection)
	require.Equal(t, "UNREADABLE", got.LastRejection.Code)
	require.Equal(t, "截图看不清", *got.LastRejection.Reason)
	require.True(t, got.LastRejection.ReviewedAt.Equal(now.Add(-time.Hour)))

	fx.Coupon(t, e.pool, fx.CouponOpts{Code: "FREE1", DiscountType: "WAIVER", Quota: 1})
	freeIn := e.input("get-key-0002", fx.Profile("Keo Nita", "K100200", "KH", "1995-01-01"))
	freeIn.CouponCode = "FREE1"
	paid, err := e.svc.CreateOrder(ctx, e.user, freeIn, testMeta)
	require.NoError(t, err)
	got, err = e.svc.GetMyOrder(ctx, e.user, paid.OrderNo)
	require.NoError(t, err)
	require.NotNil(t, got.Participants[0].TicketCode, "已确认的报名返回参赛凭证码")
}

func TestListMyOrders(t *testing.T) {
	e := newOrderEnv(t, 10)
	ctx := context.Background()
	first, err := e.svc.CreateOrder(ctx, e.user, e.input("list-key-0001", fx.Profile("Chan Sophea", "N01234567", "KH", "1990-05-01")), testMeta)
	require.NoError(t, err)
	second, err := e.svc.CreateOrder(ctx, e.user, e.input("list-key-0002",
		fx.Profile("Lim Dara", "P7654321", "US", "1992-08-20"),
		fx.Profile("Keo Nita", "K100200", "KH", "1995-01-01")), testMeta)
	require.NoError(t, err)
	other := fx.Runner(t, e.pool, 900012, "Other")
	_, err = e.svc.CreateOrder(ctx, other, e.input("list-key-0003", fx.Profile("Other Runner", "O123456", "KH", "1990-01-01")), testMeta)
	require.NoError(t, err)

	list, err := e.svc.ListMyOrders(ctx, e.user)

	require.NoError(t, err)
	require.Len(t, list, 2)
	require.Equal(t, second.OrderNo, list[0].OrderNo)
	require.Equal(t, 2, list[0].ParticipantCount)
	require.Equal(t, second.AmountCents, list[0].AmountCents)
	require.Equal(t, first.OrderNo, list[1].OrderNo)
	require.Equal(t, 1, list[1].ParticipantCount)
	require.Equal(t, "pphm-2026", list[1].EventSlug)
	require.Equal(t, "Phnom Penh Half Marathon 2026", list[1].EventName[i18n.EN])
	require.NotNil(t, list[1].DeadlineAt)
}
```

在 `api/internal/httpapi/registration_http_test.go` 末尾追加：

```go
func TestAppOrdersHTTP(t *testing.T) {
	env := newOrderHTTPEnv(t)
	enHeader := http.Header{"Accept-Language": []string{"en"}}

	rec := env.do(t, http.MethodPost, "/api/app/orders", env.orderBody("N01234567"), env.token, idemHeader("http-orders-key-01"))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	orderNo := eventsDecode[apigen.OrderDetail](t, rec).OrderNo

	rec = env.do(t, http.MethodGet, "/api/app/orders", nil, "", nil)
	require.Equal(t, http.StatusUnauthorized, rec.Code, rec.Body.String())

	rec = env.do(t, http.MethodGet, "/api/app/orders", nil, env.token, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	list := eventsDecode[apigen.OrderList](t, rec)
	require.Len(t, list.Items, 1)
	require.Equal(t, orderNo, list.Items[0].OrderNo)
	require.Equal(t, int32(1), list.Items[0].ParticipantCount)
	require.Equal(t, apigen.OrderStatus("PENDING_PAYMENT"), list.Items[0].Status)

	rec = env.do(t, http.MethodGet, "/api/app/orders/"+orderNo, nil, env.token, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, orderNo, eventsDecode[apigen.OrderDetail](t, rec).OrderNo)

	otherToken := env.login(t, 910002)
	rec = env.do(t, http.MethodGet, "/api/app/orders/"+orderNo, nil, otherToken, enHeader)
	require.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())
	notFound := eventsDecode[httpx.ErrorBody](t, rec)
	require.Equal(t, apperr.CodeOrderNotFound, notFound.Error.Code)
	require.Equal(t, "Order not found.", notFound.Error.Message)
	rec = env.do(t, http.MethodPost, "/api/app/orders/"+orderNo+"/cancel", nil, otherToken, nil)
	require.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())

	rec = env.do(t, http.MethodPost, "/api/app/orders/"+orderNo+"/cancel", nil, env.token, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, apigen.OrderStatus("CANCELLED"), eventsDecode[apigen.OrderDetail](t, rec).Status)

	rec = env.do(t, http.MethodPost, "/api/app/orders/"+orderNo+"/cancel", nil, env.token, nil)
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	require.Equal(t, apperr.CodeOrderStateConflict, eventsDecode[httpx.ErrorBody](t, rec).Error.Code)
	require.Equal(t, fx.Counts{}, fx.CountersOf(t, env.pool, "event_categories", env.event.CategoryIDs[0]))
}
```

Run: `cd api && env $DBENV go test ./internal/registration/ ./internal/httpapi/ -run 'TestCancelOrder|TestReleaseOrder|TestGetMyOrder|TestListMyOrders|TestAppOrdersHTTP'`
Expected: 编译失败：`e.svc.CancelOrder undefined`、`undefined: registration.ReleaseExpired`、`apigen.Server does not implement ...`（或 `*Server does not implement StrictServerInterface`）。

- [ ] **Step 4: 实现订单查询、取消与释放**

把 `api/internal/registration/orders.go` 整文件替换为（`loadDetail` 与 Task 12 相同，前面新增类型与四个方法）：

```go
package registration

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/audit"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/registration/store"
	"werun/api/internal/runner"
)

// ReleaseKind 是释放预留的原因，同时写入 reg_orders.reservation_release_kind 与 registrations.cancel_reason。
type ReleaseKind string

const (
	ReleaseExpired   ReleaseKind = "ORDER_EXPIRED"
	ReleaseCancelled ReleaseKind = "ORDER_CANCELLED"
)

func orderNotFound() error {
	return apperr.New(http.StatusNotFound, apperr.CodeOrderNotFound)
}

// ListMyOrders 返回当前跑者最近 100 张订单，新的在前。
func (s *Service) ListMyOrders(ctx context.Context, u runner.User) ([]OrderSummary, error) {
	rows, err := store.New(s.pool).ListOrdersForBuyer(ctx, u.ID)
	if err != nil {
		return nil, fmt.Errorf("list orders of user %d: %w", u.ID, err)
	}
	out := make([]OrderSummary, 0, len(rows))
	for _, r := range rows {
		name, err := decodeText(r.EventName, "event name")
		if err != nil {
			return nil, err
		}
		sum := OrderSummary{
			Order: Order{
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
			},
			EventSlug:        r.EventSlug,
			EventName:        name,
			ParticipantCount: int(r.ParticipantCount),
		}
		if r.BuyerUserID != nil {
			sum.BuyerUserID = *r.BuyerUserID
		}
		if r.PaymentAccountID != nil {
			sum.PaymentAccountID = *r.PaymentAccountID
		}
		out = append(out, sum)
	}
	return out, nil
}

// GetMyOrder 返回当前跑者的订单详情；订单不存在或不属于该跑者返回 ORDER_NOT_FOUND。
func (s *Service) GetMyOrder(ctx context.Context, u runner.User, orderNo string) (OrderDetail, error) {
	q := store.New(s.pool)
	id, err := q.GetOrderIDForBuyer(ctx, store.GetOrderIDForBuyerParams{OrderNo: orderNo, BuyerUserID: u.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return OrderDetail{}, orderNotFound()
	}
	if err != nil {
		return OrderDetail{}, fmt.Errorf("find order %q: %w", orderNo, err)
	}
	return s.loadDetail(ctx, q, id)
}

// CancelOrder 取消付款前（PENDING_PAYMENT）的订单并释放名额，写审计 reg_order.cancel，不推送。
func (s *Service) CancelOrder(ctx context.Context, u runner.User, orderNo string, meta httpx.Meta) (OrderDetail, error) {
	var out OrderDetail
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		row, err := q.LockOrderForBuyer(ctx, store.LockOrderForBuyerParams{OrderNo: orderNo, BuyerUserID: u.ID})
		if errors.Is(err, pgx.ErrNoRows) {
			return orderNotFound()
		}
		if err != nil {
			return fmt.Errorf("lock order %q: %w", orderNo, err)
		}
		if row.Status != StatusPendingPayment {
			return apperr.New(http.StatusConflict, apperr.CodeOrderStateConflict)
		}
		released, err := s.ReleaseOrder(ctx, tx, row.ID, ReleaseCancelled)
		if err != nil {
			return err
		}
		if !released {
			return apperr.New(http.StatusConflict, apperr.CodeOrderStateConflict)
		}
		if err := audit.Record(ctx, tx, runnerAudit(u, "reg_order.cancel", row.ID, row.EventID,
			fmt.Sprintf("跑者取消订单 %s", orderNo),
			map[string]any{"orderNo": orderNo, "status": StatusCancelled}, meta)); err != nil {
			return err
		}
		detail, err := s.loadDetail(ctx, q, row.ID)
		out = detail
		return err
	})
	if err != nil {
		return OrderDetail{}, err
	}
	return out, nil
}

// ReleaseOrder 用条件更新结束订单预留（超时：PENDING_PAYMENT/PROOF_REJECTED → EXPIRED；取消：PENDING_PAYMENT → CANCELLED）。
// 只有影响 1 行时才释放计数、把 PENDING 报名改为 CANCELLED 并返回 true；重复调用返回 false 且不改任何数据。
func (s *Service) ReleaseOrder(ctx context.Context, tx pgx.Tx, orderID int64, kind ReleaseKind) (bool, error) {
	q := store.New(tx)
	at := s.now().UTC()
	var (
		n   int64
		err error
	)
	switch kind {
	case ReleaseExpired:
		n, err = q.ReleaseOrderExpired(ctx, store.ReleaseOrderExpiredParams{At: at, ID: orderID})
	case ReleaseCancelled:
		n, err = q.ReleaseOrderCancelled(ctx, store.ReleaseOrderCancelledParams{At: at, ID: orderID})
	default:
		return false, fmt.Errorf("release order %d: unknown kind %q", orderID, kind)
	}
	if err != nil {
		return false, fmt.Errorf("release order %d: %w", orderID, err)
	}
	if n == 0 {
		return false, nil
	}
	if err := s.prices.Release(ctx, tx, orderID); err != nil {
		return false, err
	}
	if _, err := q.CancelOrderRegistrations(ctx, store.CancelOrderRegistrationsParams{
		CancelReason: string(kind),
		OrderID:      orderID,
	}); err != nil {
		return false, fmt.Errorf("cancel registrations of order %d: %w", orderID, err)
	}
	return true, nil
}
```

然后把 Task 12 的 `loadDetail` 函数原样接在文件末尾（函数体不变）。

在 `api/internal/registration/handlers.go` 末尾追加：

```go
func (h *Handlers) AppListOrders(ctx context.Context, _ apigen.AppListOrdersRequestObject) (apigen.AppListOrdersResponseObject, error) {
	u, err := currentRunner(ctx)
	if err != nil {
		return nil, err
	}
	orders, err := h.svc.ListMyOrders(ctx, u)
	if err != nil {
		return nil, err
	}
	items := make([]apigen.OrderSummary, 0, len(orders))
	for _, o := range orders {
		items = append(items, toAPIOrderSummary(o))
	}
	return apigen.AppListOrders200JSONResponse{Items: items}, nil
}

func (h *Handlers) AppGetOrder(ctx context.Context, req apigen.AppGetOrderRequestObject) (apigen.AppGetOrderResponseObject, error) {
	u, err := currentRunner(ctx)
	if err != nil {
		return nil, err
	}
	d, err := h.svc.GetMyOrder(ctx, u, req.OrderNo)
	if err != nil {
		return nil, err
	}
	return apigen.AppGetOrder200JSONResponse(toAPIOrderDetail(d)), nil
}

func (h *Handlers) AppCancelOrder(ctx context.Context, req apigen.AppCancelOrderRequestObject) (apigen.AppCancelOrderResponseObject, error) {
	u, err := currentRunner(ctx)
	if err != nil {
		return nil, err
	}
	d, err := h.svc.CancelOrder(ctx, u, req.OrderNo, httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AppCancelOrder200JSONResponse(toAPIOrderDetail(d)), nil
}

func toAPIOrderSummary(o OrderSummary) apigen.OrderSummary {
	return apigen.OrderSummary{
		OrderNo:          o.OrderNo,
		Status:           apigen.OrderStatus(o.Status),
		EventSlug:        o.EventSlug,
		EventName:        localizedToAPI(o.EventName),
		AmountCents:      o.AmountCents,
		Currency:         o.Currency,
		ParticipantCount: int32(o.ParticipantCount),
		DeadlineAt:       o.DeadlineAt,
		CreatedAt:        o.CreatedAt,
	}
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `cd api && go build ./... && env $DBENV go test ./internal/registration/ ./internal/httpapi/ -run 'TestCancelOrder|TestReleaseOrder|TestGetMyOrder|TestListMyOrders|TestAppOrdersHTTP' -v`
Expected: `TestCancelOrderReleasesReservation`、`TestCancelOrderRules`、`TestReleaseOrderExpiredReleasesOnlyOnce`、`TestGetMyOrder`、`TestListMyOrders`、`TestAppOrdersHTTP` 全部 PASS。

- [ ] **Step 6: 全量检查并提交**

Run: `cd api && env $DBENV go test ./... && go tool golangci-lint run ./...`
Expected: 所有包 `ok`；`0 issues.`。

Run: `pnpm typecheck && pnpm test && pnpm i18n:check`
Expected: 通过（`schema.d.ts` 新增类型不影响现有代码）。

```bash
git add api/db/queries/registration.sql api/internal/registration api/internal/testfixture/fixture.go \
  api/internal/httpapi api/openapi/openapi.yaml api/internal/platform/apperr api/internal/platform/i18n \
  packages/api-client/src/schema.d.ts
git commit -m "$(cat <<'EOF'
feat(api): list, view and cancel runner orders with shared reservation release

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
)"
```

---

### Task 14: 报名向导

**Files:**
- Modify: `web/user/src/format.ts`、`web/user/src/format.test.ts`
- Create: `web/user/src/register/model.ts`
- Create: `web/user/src/register/validate.ts`、Test: `web/user/src/register/validate.test.ts`
- Create: `web/user/src/register/submissionKey.ts`、Test: `web/user/src/register/submissionKey.test.ts`
- Create: `web/user/src/register/api.ts`
- Create: `web/user/src/register/StepParticipants.tsx`、`StepDetails.tsx`、`StepConfirm.tsx`、`Wizard.module.css`
- Create: `web/user/src/orders/api.ts`、`web/user/src/orders/Orders.module.css`
- Create: `web/user/src/pages/RegisterPage.tsx`、Test: `web/user/src/pages/RegisterPage.test.tsx`
- Create: `web/user/src/pages/OrdersPage.tsx`、Test: `web/user/src/pages/OrdersPage.test.tsx`
- Create: `web/user/src/pages/OrderDetailPage.tsx`、Test: `web/user/src/pages/OrderDetailPage.test.tsx`
- Modify: `web/user/src/pages/EventDetailPage.tsx`、`web/user/src/pages/EventDetailPage.test.tsx`、`web/user/src/pages/Page.module.css`
- Modify: `web/user/src/routes.tsx`、`web/user/src/components/Layout.tsx`、`web/user/src/test/setup.ts`
- Create: `web/user/src/test/runner.ts`、`web/user/src/test/orderFixtures.ts`
- Modify: `packages/i18n/locales/{zh,en,km}/user.json`

**Interfaces:**
- Consumes:
  - `@werun/api-client`：`formatUsd(cents)`、`ApiError`、`unwrap`、`type Schemas`、`type paths`、`type ApiClient`；Task 12、13 生成的 `appQuote`、`appCreateOrder`（`params.header["Idempotency-Key"]`）、`appListOrders`、`appGetOrder`、`appCancelOrder`，schema `PublicEvent`（含 `id`/`eventType`/`registrationOpen`/`categories[].id/minAge/soldOut`）、`Quote`、`QuoteRequest`、`CreateOrderRequest`、`OrderDetail`、`OrderSummary`、`LocalizedText`
  - Task 8–10：`GET /app/profiles`、`GET /app/consents`、`RequireRunner`（形状见契约补充 10）
  - 现有：`usePublicEvent`、`useApi`、`QueryState`、`NotFoundPage`、`renderApp`、`jsonResponse`、`halfMarathon`
- Produces:
  - 路由 `/events/:slug/register`（`RegisterPage`）、`/orders`（`OrdersPage`）、`/orders/:orderNo`（`OrderDetailPage`），均在 `RequireRunner` 内。
  - testid（契约）：`register-button`、`wizard-next`、`wizard-back`、`form-error`、`participant-add`、`participant-<i>-category`、`participant-<i>-profile`、`participant-<i>-{fullName,gender,birthDate,nationality,idType,idNo,phone,email,emergencyName,emergencyPhone,tshirtSize,saveProfile}`、`coupon-input`、`coupon-apply`、`quote-list-amount`、`quote-discount`、`quote-amount`、`consent-item-<key>`、`order-submit`、`order-status`（`data-status`）、`order-pay`、`order-cancel`、`order-item-<orderNo>`。
  - 本任务新增的辅助 testid：`register-closed`、`register-sold-out`、`participant-<i>-remove`、`participant-<i>-summary`、`participant-<i>-<field>-error`、`coupon-result`（`data-kind="ok|error"`）、`quote-error`、`order-cancel-confirm`、`order-cancel-keep`、`order-deadline`、`order-list-amount`、`order-coupon-discount`、`order-ident-offset`、`order-amount`、`orders-empty`。
  - `format.ts`：`pickText(text: Schemas["LocalizedText"], lang: Lang): string`、`formatDateTime(iso: string, lang: Lang): string`。
  - 文案 `user.register.*`、`user.orders.*`（三语）。

**客户端资料校验规则**（与 `runner.ValidateProfile` 保持一致，服务端仍是最终依据；服务端返回的 `participants[i].<field>` 错误直接显示在对应字段下）：姓名、紧急联系人姓名必填且不超过 100 字；性别 `M|F|X`；出生日期为合法 `YYYY-MM-DD`、不晚于今天、比赛当天周岁不小于组别 `minAge`（2 月 29 日规则同后端）；国籍转大写后为两位字母；证件类型 `NATIONAL_ID|PASSPORT|OTHER`；证件号去空白与连字符后非空且不超过 32 位；手机与紧急联系人电话为 E.164（`^\+[1-9]\d{6,14}$`）；邮箱可空，填写时须形如 `a@b.c`；T 恤尺码 `XS|S|M|L|XL|XXL`。

- [ ] **Step 1: 核对前置形状**

```bash
grep -n '"/app/profiles"' -A30 packages/api-client/src/schema.d.ts | head -40      # items 数组元素含 id、fullName、birthDate、nationality、idNoMasked
grep -n '"/app/consents"' -A30 packages/api-client/src/schema.d.ts | head -40      # query 参数 purpose、lang；响应含 version、lang、fullText、items[{key,title,description}]
grep -n "RequireRunner" web/user/src/routes.tsx                                    # 布局路由 { element: <RequireRunner />, children: [...] }
grep -n "getAuthToken" web/user/src/test/renderApp.tsx web/user/src/main.tsx      # 两处都有
grep -n "sessionStorage.clear" web/user/src/test/setup.ts                          # 可能没有，Step 5 补
grep -n "export function formatUsd" packages/api-client/src/money.ts
```

Expected：前五条与契约补充 10 一致，`formatUsd` 存在。若 `RunnerProfile` 或同意书字段名不同，本任务中 `model.ts` 的 `RunnerProfile`/`RegistrationConsent` 使用处与 `orderFixtures.ts` 按实际字段名书写，其它代码不变。

- [ ] **Step 2: 写工具函数的失败测试**

在 `web/user/src/format.test.ts` 末尾追加（并把文件顶部的 import 改为同时导入 `formatDateTime`、`pickText`）：

```ts
describe("pickText", () => {
  it("按当前语言取文案，缺失时依次回退英文、中文、高棉文", () => {
    expect(pickText({ zh: "半程", en: "Half", km: "ពាក់កណ្ដាល" }, "km")).toBe("ពាក់កណ្ដាល");
    expect(pickText({ zh: "半程", en: "Half" }, "km")).toBe("Half");
    expect(pickText({ zh: "半程" }, "en")).toBe("半程");
    expect(pickText({ km: "ពាក់កណ្ដាល" }, "zh")).toBe("ពាក់កណ្ដាល");
    expect(pickText({}, "zh")).toBe("");
  });
});

describe("formatDateTime", () => {
  it("输出包含年份与 24 小时制分钟", () => {
    const text = formatDateTime("2026-09-14T03:30:00Z", "en");
    expect(text).toContain("2026");
    expect(text).toMatch(/\d{2}:30/);
  });
});
```

创建 `web/user/src/register/validate.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { ageOn, emptyForm, normalizeIdNo, type ProfileForm } from "./model";
import { validateProfileForm } from "./validate";

const options = { minAge: 16, raceDate: "2026-11-15", today: "2026-09-14" };

function validForm(): ProfileForm {
  return {
    fullName: "Chan Sophea",
    gender: "F",
    birthDate: "1990-05-01",
    nationality: "kh",
    idType: "PASSPORT",
    idNo: "N0 1234-567",
    phone: "+85512345678",
    email: "",
    emergencyName: "Sok Dara",
    emergencyPhone: "+85598765432",
    tshirtSize: "M",
  };
}

describe("validateProfileForm", () => {
  it("完整资料没有错误", () => {
    expect(validateProfileForm(validForm(), options)).toEqual({});
  });

  it("空表单每个必填项都报 required，邮箱不报", () => {
    const issues = validateProfileForm(emptyForm(), options);
    for (const field of ["fullName", "gender", "birthDate", "nationality", "idType", "idNo", "phone", "emergencyName", "emergencyPhone", "tshirtSize"] as const) {
      expect(issues[field]).toEqual({ key: "register.errors.required" });
    }
    expect(issues.email).toBeUndefined();
  });

  it.each([
    ["fullName", { fullName: "a".repeat(101) }, { key: "register.errors.tooLong", params: { max: 100 } }],
    ["nationality", { nationality: "KHM" }, { key: "register.errors.invalid" }],
    ["idNo", { idNo: " - - " }, { key: "register.errors.invalid" }],
    ["idNo", { idNo: "A".repeat(33) }, { key: "register.errors.tooLong", params: { max: 32 } }],
    ["phone", { phone: "012345678" }, { key: "register.errors.invalid" }],
    ["emergencyPhone", { emergencyPhone: "+0123" }, { key: "register.errors.invalid" }],
    ["email", { email: "not-an-email" }, { key: "register.errors.invalid" }],
    ["birthDate", { birthDate: "2026-02-30" }, { key: "register.errors.invalid" }],
    ["birthDate", { birthDate: "2026-09-15" }, { key: "register.errors.futureDate" }],
    ["birthDate", { birthDate: "2010-11-16" }, { key: "register.errors.tooYoung", params: { minAge: 16 } }],
  ] as const)("%s 校验：%j", (field, patch, expected) => {
    const issues = validateProfileForm({ ...validForm(), ...patch }, options);
    expect(issues[field]).toEqual(expected);
  });

  it("比赛当天刚满最低年龄可以报名", () => {
    expect(validateProfileForm({ ...validForm(), birthDate: "2010-11-15" }, options)).toEqual({});
  });
});

describe("ageOn", () => {
  it("2 月 29 日出生者在非闰年 3 月 1 日满岁", () => {
    expect(ageOn("2008-02-29", "2026-02-28")).toBe(17);
    expect(ageOn("2008-02-29", "2026-03-01")).toBe(18);
    expect(ageOn("2008-02-29", "2028-02-29")).toBe(20);
  });
});

describe("normalizeIdNo", () => {
  it("去掉空白与连字符并转大写", () => {
    expect(normalizeIdNo(" ab 12-34\t")).toBe("AB1234");
  });
});
```

创建 `web/user/src/register/submissionKey.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { SubmissionKey } from "./submissionKey";

describe("SubmissionKey", () => {
  it("同一请求体重试时沿用同一个键，请求体变化才换新键", () => {
    let n = 0;
    const keys = new SubmissionKey(() => `generated-key-${++n}`);

    const first = keys.keyFor('{"a":1}');
    expect(keys.keyFor('{"a":1}')).toBe(first);
    const second = keys.keyFor('{"a":2}');
    expect(second).not.toBe(first);
    expect(keys.keyFor('{"a":2}')).toBe(second);
  });

  it("默认用 crypto.randomUUID，格式满足 Idempotency-Key 要求", () => {
    expect(new SubmissionKey().keyFor("{}")).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});
```

Run: `pnpm --filter @werun/user test src/format.test.ts src/register`
Expected: FAIL：`Failed to resolve import "./model"`、`"./submissionKey"`，`pickText is not exported`。

- [ ] **Step 3: 实现工具函数**

在 `web/user/src/format.ts` 顶部 import 区加入 `import type { Schemas } from "@werun/api-client";`，文件末尾追加：

```ts
/** 三语文本按当前语言显示，缺失时依次回退英文、中文、高棉文 */
export function pickText(text: Schemas["LocalizedText"], lang: Lang): string {
  return text[lang] ?? text.en ?? text.zh ?? text.km ?? "";
}

/** 截止时间、下单时间等按浏览器时区显示（spec：前端按浏览器时区） */
export function formatDateTime(isoDateTime: string, lang: Lang): string {
  return new Intl.DateTimeFormat(INTL_LOCALES[lang], {
    dateStyle: "medium",
    timeStyle: "short",
    hourCycle: "h23",
  }).format(new Date(isoDateTime));
}
```

创建 `web/user/src/register/model.ts`：

```ts
import type { Schemas, paths } from "@werun/api-client";

export const GENDERS = ["M", "F", "X"] as const;
export const ID_TYPES = ["NATIONAL_ID", "PASSPORT", "OTHER"] as const;
export const TSHIRT_SIZES = ["XS", "S", "M", "L", "XL", "XXL"] as const;
export const MAX_PARTICIPANTS = 10;

export type Gender = (typeof GENDERS)[number];
export type IdType = (typeof ID_TYPES)[number];
export type TshirtSize = (typeof TSHIRT_SIZES)[number];

type ProfilesResponse = paths["/app/profiles"]["get"]["responses"][200]["content"]["application/json"];
export type RunnerProfile = ProfilesResponse["items"][number];
export type RegistrationConsent = paths["/app/consents"]["get"]["responses"][200]["content"]["application/json"];
export type PublicEvent = Schemas["PublicEvent"];

export interface ProfileForm {
  fullName: string;
  gender: Gender | "";
  birthDate: string;
  nationality: string;
  idType: IdType | "";
  idNo: string;
  phone: string;
  email: string;
  emergencyName: string;
  emergencyPhone: string;
  tshirtSize: TshirtSize | "";
}

export type ProfileField = keyof ProfileForm;

export interface ParticipantDraft {
  key: string;
  categoryId: number | null;
  profileId: number | null;
  form: ProfileForm;
  saveAsProfile: boolean;
}

export function emptyForm(): ProfileForm {
  return {
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
  };
}

export function newParticipant(): ParticipantDraft {
  return { key: crypto.randomUUID(), categoryId: null, profileId: null, form: emptyForm(), saveAsProfile: false };
}

export function normalizeIdNo(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

function dateParts(iso: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) {
    return [Number.NaN, Number.NaN, Number.NaN];
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** 比赛当天周岁；2 月 29 日出生者在非闰年按 3 月 1 日满岁（与后端 pricing.AgeOn 一致） */
export function ageOn(birthDate: string, raceDate: string): number {
  const [by, birthMonth, birthDay] = dateParts(birthDate);
  const [ry, rm, rd] = dateParts(raceDate);
  let bm = birthMonth;
  let bd = birthDay;
  if (bm === 2 && bd === 29 && !isLeapYear(ry)) {
    bm = 3;
    bd = 1;
  }
  let age = ry - by;
  if (rm < bm || (rm === bm && rd < bd)) {
    age -= 1;
  }
  return age;
}

export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function toOrderParticipant(draft: ParticipantDraft): Schemas["OrderParticipantInput"] {
  const categoryId = draft.categoryId ?? 0;
  if (draft.profileId !== null) {
    return { categoryId, profileId: draft.profileId };
  }
  const f = draft.form;
  const email = f.email.trim();
  return {
    categoryId,
    saveAsProfile: draft.saveAsProfile,
    profile: {
      fullName: f.fullName.trim(),
      gender: f.gender as Gender,
      birthDate: f.birthDate,
      nationality: f.nationality.trim().toUpperCase(),
      idType: f.idType as IdType,
      idNo: f.idNo.trim(),
      phone: f.phone.trim(),
      ...(email ? { email } : {}),
      emergencyName: f.emergencyName.trim(),
      emergencyPhone: f.emergencyPhone.trim(),
      tshirtSize: f.tshirtSize as TshirtSize,
    },
  };
}

export function toQuoteParticipant(draft: ParticipantDraft, profiles: readonly RunnerProfile[]): Schemas["QuoteParticipantInput"] {
  const saved = draft.profileId === null ? undefined : profiles.find((p) => p.id === draft.profileId);
  return {
    categoryId: draft.categoryId ?? 0,
    nationality: saved ? saved.nationality : draft.form.nationality.trim().toUpperCase(),
    birthDate: saved ? saved.birthDate : draft.form.birthDate,
  };
}

export function participantName(draft: ParticipantDraft, profiles: readonly RunnerProfile[]): string {
  if (draft.profileId !== null) {
    return profiles.find((p) => p.id === draft.profileId)?.fullName ?? "";
  }
  return draft.form.fullName.trim();
}
```

创建 `web/user/src/register/validate.ts`：

```ts
import { GENDERS, ID_TYPES, TSHIRT_SIZES, ageOn, normalizeIdNo, type ProfileField, type ProfileForm } from "./model";

export interface FieldIssue {
  key: string;
  params?: Record<string, unknown>;
}

export type ProfileIssues = Partial<Record<ProfileField, FieldIssue>>;

export interface ValidateOptions {
  minAge: number;
  raceDate: string; // YYYY-MM-DD
  today: string; // YYYY-MM-DD
}

export const NAME_MAX = 100;
export const ID_NO_MAX = 32;

const E164 = /^\+[1-9]\d{6,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NATIONALITY = /^[A-Z]{2}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isRealDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** 与 runner.ValidateProfile 规则一致的客户端校验；返回 i18n key 与参数 */
export function validateProfileForm(form: ProfileForm, options: ValidateOptions): ProfileIssues {
  const issues: ProfileIssues = {};
  const required = (field: ProfileField, value: string): boolean => {
    if (value.trim() === "") {
      issues[field] = { key: "register.errors.required" };
      return false;
    }
    return true;
  };
  const invalid = (field: ProfileField) => {
    issues[field] = { key: "register.errors.invalid" };
  };

  if (required("fullName", form.fullName) && form.fullName.trim().length > NAME_MAX) {
    issues.fullName = { key: "register.errors.tooLong", params: { max: NAME_MAX } };
  }
  if (!(GENDERS as readonly string[]).includes(form.gender)) {
    issues.gender = { key: "register.errors.required" };
  }
  if (required("birthDate", form.birthDate)) {
    if (!isRealDate(form.birthDate)) {
      invalid("birthDate");
    } else if (form.birthDate > options.today) {
      issues.birthDate = { key: "register.errors.futureDate" };
    } else if (ageOn(form.birthDate, options.raceDate) < options.minAge) {
      issues.birthDate = { key: "register.errors.tooYoung", params: { minAge: options.minAge } };
    }
  }
  if (required("nationality", form.nationality) && !NATIONALITY.test(form.nationality.trim().toUpperCase())) {
    invalid("nationality");
  }
  if (!(ID_TYPES as readonly string[]).includes(form.idType)) {
    issues.idType = { key: "register.errors.required" };
  }
  if (required("idNo", form.idNo)) {
    const normalized = normalizeIdNo(form.idNo);
    if (normalized === "") {
      invalid("idNo");
    } else if (normalized.length > ID_NO_MAX) {
      issues.idNo = { key: "register.errors.tooLong", params: { max: ID_NO_MAX } };
    }
  }
  if (required("phone", form.phone) && !E164.test(form.phone.trim())) {
    invalid("phone");
  }
  if (form.email.trim() !== "" && !EMAIL.test(form.email.trim())) {
    invalid("email");
  }
  if (required("emergencyName", form.emergencyName) && form.emergencyName.trim().length > NAME_MAX) {
    issues.emergencyName = { key: "register.errors.tooLong", params: { max: NAME_MAX } };
  }
  if (required("emergencyPhone", form.emergencyPhone) && !E164.test(form.emergencyPhone.trim())) {
    invalid("emergencyPhone");
  }
  if (!(TSHIRT_SIZES as readonly string[]).includes(form.tshirtSize)) {
    issues.tshirtSize = { key: "register.errors.required" };
  }
  return issues;
}
```

创建 `web/user/src/register/submissionKey.ts`：

```ts
/**
 * 一次提交尝试对应一个 Idempotency-Key：同一份请求体（网络失败后重试）沿用同一个键，
 * 请求体变化（改了优惠码、参赛人等）才生成新键。服务端只在成功时保存键，所以失败后复用是安全的。
 */
export class SubmissionKey {
  private payload: string | null = null;
  private key = "";
  private readonly generate: () => string;

  constructor(generate: () => string = () => crypto.randomUUID()) {
    this.generate = generate;
  }

  keyFor(payload: string): string {
    if (payload !== this.payload) {
      this.payload = payload;
      this.key = this.generate();
    }
    return this.key;
  }
}
```

Run: `pnpm --filter @werun/user test src/format.test.ts src/register`
Expected: `format.test.ts`、`validate.test.ts`、`submissionKey.test.ts` 全部通过。

- [ ] **Step 4: 加三语文案**

在 `packages/i18n/locales/zh/user.json` 的顶层对象中加入 `register` 与 `orders` 两个键（与 `home`、`events`、`event` 等已有键并列）：

```json
  "register": {
    "cta": "报名",
    "allSoldOut": "所有组别名额已满。",
    "title": "报名：{{event}}",
    "closed": "该赛事当前未开放报名。",
    "soldOut": "已满",
    "soldOutOption": "{{name}}（已满）",
    "steps": { "participants": "参赛人与组别", "details": "参赛资料", "confirm": "确认订单" },
    "next": "下一步",
    "back": "上一步",
    "participant": "参赛人 {{n}}",
    "addParticipant": "添加参赛人",
    "removeParticipant": "移除",
    "category": "组别",
    "chooseCategory": "请选择组别",
    "profile": "参赛人资料",
    "newProfile": "填写新的参赛人",
    "savedProfile": "常用参赛人：{{name}}（证件 {{idNo}}）",
    "choose": "请选择",
    "fields": {
      "fullName": "姓名（与证件一致）",
      "gender": "性别",
      "birthDate": "出生日期",
      "nationality": "国籍（两位国家代码，如 KH）",
      "idType": "证件类型",
      "idNo": "证件号",
      "phone": "手机号（含国家码，如 +85512345678）",
      "email": "邮箱（可不填）",
      "emergencyName": "紧急联系人",
      "emergencyPhone": "紧急联系人电话",
      "tshirtSize": "T 恤尺码",
      "saveProfile": "保存为常用参赛人"
    },
    "gender": { "M": "男", "F": "女", "X": "其他" },
    "idType": { "NATIONAL_ID": "身份证", "PASSPORT": "护照", "OTHER": "其他证件" },
    "errors": {
      "fixBelow": "请先修正标出的内容。",
      "required": "必填。",
      "invalid": "格式不正确。",
      "tooLong": "不能超过 {{max}} 个字符。",
      "tooYoung": "比赛当天须年满 {{minAge}} 岁。",
      "futureDate": "出生日期不能晚于今天。",
      "soldOut": "该组别名额已满。",
      "duplicateProfile": "同一位参赛人不能重复添加。",
      "network": "网络不稳定，请检查网络后重试。"
    },
    "quote": {
      "title": "费用明细",
      "listAmount": "原价合计",
      "discount": "优惠",
      "amount": "应付",
      "loading": "正在计算费用…",
      "identNote": "下单时会从应付金额中减去不超过 $0.50 的识别尾数，方便核对你的转账。"
    },
    "coupon": { "label": "优惠码", "apply": "应用", "applied": "已使用优惠码，减免 {{amount}}" },
    "consent": { "title": "报名同意书", "version": "版本 {{version}}", "loading": "正在加载同意书…" },
    "submit": "提交订单",
    "submitting": "正在提交…"
  },
  "orders": {
    "nav": "我的订单",
    "title": "我的订单",
    "empty": "还没有订单。",
    "detailTitle": "订单 {{orderNo}}",
    "participants": "参赛人数：{{n}}",
    "deadline": "请在 {{time}} 前完成付款",
    "status": {
      "PENDING_PAYMENT": "待付款",
      "PROOF_SUBMITTED": "审核中",
      "PROOF_REJECTED": "凭证被驳回",
      "PAID": "已确认",
      "PARTIALLY_REFUNDED": "部分退款",
      "REFUNDED": "已退款",
      "EXPIRED": "已过期",
      "CANCELLED": "已取消"
    },
    "table": { "name": "参赛人", "category": "组别", "listPrice": "原价", "paid": "实付", "registration": "报名状态" },
    "regStatus": { "PENDING": "待确认", "CONFIRMED": "已确认", "CANCELLED": "已取消" },
    "amount": {
      "list": "原价合计",
      "coupon": "优惠码减免",
      "ident": "识别尾数",
      "total": "应付",
      "identHint": "为方便核对转账而减去的尾数。"
    },
    "pay": "去付款",
    "cancel": "取消订单",
    "cancelAsk": "取消后名额会被释放，确定取消吗？",
    "cancelConfirm": "确定取消",
    "cancelKeep": "暂不取消"
  }
```

`packages/i18n/locales/en/user.json` 加入：

```json
  "register": {
    "cta": "Register",
    "allSoldOut": "All categories are sold out.",
    "title": "Register: {{event}}",
    "closed": "Registration for this event is not open.",
    "soldOut": "Sold out",
    "soldOutOption": "{{name}} (sold out)",
    "steps": { "participants": "Runners & categories", "details": "Runner details", "confirm": "Review & submit" },
    "next": "Next",
    "back": "Back",
    "participant": "Runner {{n}}",
    "addParticipant": "Add a runner",
    "removeParticipant": "Remove",
    "category": "Category",
    "chooseCategory": "Choose a category",
    "profile": "Runner details",
    "newProfile": "Enter new runner details",
    "savedProfile": "Saved runner: {{name}} (ID {{idNo}})",
    "choose": "Choose",
    "fields": {
      "fullName": "Full name (as on ID)",
      "gender": "Gender",
      "birthDate": "Date of birth",
      "nationality": "Nationality (2-letter code, e.g. KH)",
      "idType": "ID type",
      "idNo": "ID number",
      "phone": "Mobile (with country code, e.g. +85512345678)",
      "email": "Email (optional)",
      "emergencyName": "Emergency contact",
      "emergencyPhone": "Emergency contact phone",
      "tshirtSize": "T-shirt size",
      "saveProfile": "Save as a saved runner"
    },
    "gender": { "M": "Male", "F": "Female", "X": "Other" },
    "idType": { "NATIONAL_ID": "National ID", "PASSPORT": "Passport", "OTHER": "Other ID" },
    "errors": {
      "fixBelow": "Please fix the highlighted fields.",
      "required": "Required.",
      "invalid": "Invalid format.",
      "tooLong": "Must be at most {{max}} characters.",
      "tooYoung": "Must be at least {{minAge}} on race day.",
      "futureDate": "Date of birth can't be in the future.",
      "soldOut": "This category is sold out.",
      "duplicateProfile": "This runner has already been added.",
      "network": "Network problem. Please check your connection and try again."
    },
    "quote": {
      "title": "Price",
      "listAmount": "Subtotal",
      "discount": "Discount",
      "amount": "Total to pay",
      "loading": "Calculating price…",
      "identNote": "When you place the order, up to $0.50 is taken off the total so we can match your transfer."
    },
    "coupon": { "label": "Coupon code", "apply": "Apply", "applied": "Coupon applied: {{amount}} off" },
    "consent": { "title": "Registration waiver", "version": "Version {{version}}", "loading": "Loading waiver…" },
    "submit": "Place order",
    "submitting": "Placing order…"
  },
  "orders": {
    "nav": "My orders",
    "title": "My orders",
    "empty": "You have no orders yet.",
    "detailTitle": "Order {{orderNo}}",
    "participants": "Runners: {{n}}",
    "deadline": "Please pay before {{time}}",
    "status": {
      "PENDING_PAYMENT": "Awaiting payment",
      "PROOF_SUBMITTED": "Under review",
      "PROOF_REJECTED": "Proof rejected",
      "PAID": "Confirmed",
      "PARTIALLY_REFUNDED": "Partially refunded",
      "REFUNDED": "Refunded",
      "EXPIRED": "Expired",
      "CANCELLED": "Cancelled"
    },
    "table": { "name": "Runner", "category": "Category", "listPrice": "Price", "paid": "You pay", "registration": "Registration" },
    "regStatus": { "PENDING": "Pending", "CONFIRMED": "Confirmed", "CANCELLED": "Cancelled" },
    "amount": {
      "list": "Subtotal",
      "coupon": "Coupon discount",
      "ident": "Matching cents",
      "total": "Total to pay",
      "identHint": "Taken off so we can match your transfer."
    },
    "pay": "Pay now",
    "cancel": "Cancel order",
    "cancelAsk": "Cancel this order? Your spots will be released.",
    "cancelConfirm": "Yes, cancel",
    "cancelKeep": "Keep order"
  }
```

`packages/i18n/locales/km/user.json` 加入：

```json
  "register": {
    "cta": "ចុះឈ្មោះ",
    "allSoldOut": "ប្រភេទទាំងអស់ពេញហើយ។",
    "title": "ចុះឈ្មោះ៖ {{event}}",
    "closed": "ព្រឹត្តិការណ៍នេះមិនទាន់បើកការចុះឈ្មោះទេ។",
    "soldOut": "ពេញ",
    "soldOutOption": "{{name}} (ពេញ)",
    "steps": { "participants": "អ្នករត់ និងប្រភេទ", "details": "ព័ត៌មានអ្នករត់", "confirm": "ពិនិត្យ និងដាក់ស្នើ" },
    "next": "បន្ទាប់",
    "back": "ថយក្រោយ",
    "participant": "អ្នករត់ទី {{n}}",
    "addParticipant": "បន្ថែមអ្នករត់",
    "removeParticipant": "ដកចេញ",
    "category": "ប្រភេទ",
    "chooseCategory": "ជ្រើសរើសប្រភេទ",
    "profile": "ព័ត៌មានអ្នករត់",
    "newProfile": "បញ្ចូលព័ត៌មានអ្នករត់ថ្មី",
    "savedProfile": "អ្នករត់ដែលបានរក្សាទុក៖ {{name}} (អត្តសញ្ញាណ {{idNo}})",
    "choose": "ជ្រើសរើស",
    "fields": {
      "fullName": "ឈ្មោះពេញ (ដូចក្នុងអត្តសញ្ញាណប័ណ្ណ)",
      "gender": "ភេទ",
      "birthDate": "ថ្ងៃខែឆ្នាំកំណើត",
      "nationality": "សញ្ជាតិ (កូដ ២ អក្សរ ឧ. KH)",
      "idType": "ប្រភេទឯកសារអត្តសញ្ញាណ",
      "idNo": "លេខអត្តសញ្ញាណ",
      "phone": "លេខទូរស័ព្ទ (មានលេខកូដប្រទេស ឧ. +85512345678)",
      "email": "អ៊ីមែល (មិនចាំបាច់)",
      "emergencyName": "អ្នកទំនាក់ទំនងពេលអាសន្ន",
      "emergencyPhone": "លេខទូរស័ព្ទពេលអាសន្ន",
      "tshirtSize": "ទំហំអាវយឺត",
      "saveProfile": "រក្សាទុកជាអ្នករត់ដែលប្រើញឹកញាប់"
    },
    "gender": { "M": "ប្រុស", "F": "ស្រី", "X": "ផ្សេងទៀត" },
    "idType": { "NATIONAL_ID": "អត្តសញ្ញាណប័ណ្ណសញ្ជាតិ", "PASSPORT": "លិខិតឆ្លងដែន", "OTHER": "ឯកសារផ្សេងទៀត" },
    "errors": {
      "fixBelow": "សូមកែតម្រូវវាលដែលបានសម្គាល់។",
      "required": "ត្រូវតែបំពេញ។",
      "invalid": "ទម្រង់មិនត្រឹមត្រូវ។",
      "tooLong": "មិនអាចលើសពី {{max}} តួអក្សរ។",
      "tooYoung": "ត្រូវមានអាយុយ៉ាងតិច {{minAge}} ឆ្នាំនៅថ្ងៃប្រកួត។",
      "futureDate": "ថ្ងៃខែឆ្នាំកំណើតមិនអាចនៅពេលអនាគតបានទេ។",
      "soldOut": "ប្រភេទនេះពេញហើយ។",
      "duplicateProfile": "អ្នករត់នេះត្រូវបានបន្ថែមរួចហើយ។",
      "network": "មានបញ្ហាបណ្តាញ។ សូមពិនិត្យការតភ្ជាប់ ហើយព្យាយាមម្តងទៀត។"
    },
    "quote": {
      "title": "តម្លៃ",
      "listAmount": "សរុបរង",
      "discount": "ការបញ្ចុះតម្លៃ",
      "amount": "ចំនួនត្រូវបង់",
      "loading": "កំពុងគណនាតម្លៃ…",
      "identNote": "ពេលដាក់ការបញ្ជាទិញ ប្រព័ន្ធនឹងកាត់មិនលើស $0.50 ពីចំនួនសរុប ដើម្បីងាយស្រួលផ្ទៀងផ្ទាត់ការផ្ទេរប្រាក់របស់អ្នក។"
    },
    "coupon": { "label": "លេខកូដបញ្ចុះតម្លៃ", "apply": "ប្រើ", "applied": "បានប្រើលេខកូដ៖ បញ្ចុះ {{amount}}" },
    "consent": { "title": "លិខិតយល់ព្រមចុះឈ្មោះ", "version": "កំណែ {{version}}", "loading": "កំពុងផ្ទុកលិខិតយល់ព្រម…" },
    "submit": "ដាក់ការបញ្ជាទិញ",
    "submitting": "កំពុងដាក់ការបញ្ជាទិញ…"
  },
  "orders": {
    "nav": "ការបញ្ជាទិញរបស់ខ្ញុំ",
    "title": "ការបញ្ជាទិញរបស់ខ្ញុំ",
    "empty": "អ្នកមិនទាន់មានការបញ្ជាទិញទេ។",
    "detailTitle": "ការបញ្ជាទិញ {{orderNo}}",
    "participants": "ចំនួនអ្នករត់៖ {{n}}",
    "deadline": "សូមបង់ប្រាក់មុន {{time}}",
    "status": {
      "PENDING_PAYMENT": "រង់ចាំការបង់ប្រាក់",
      "PROOF_SUBMITTED": "កំពុងពិនិត្យ",
      "PROOF_REJECTED": "ភស្តុតាងត្រូវបានបដិសេធ",
      "PAID": "បានបញ្ជាក់",
      "PARTIALLY_REFUNDED": "បានសងប្រាក់វិញមួយផ្នែក",
      "REFUNDED": "បានសងប្រាក់វិញ",
      "EXPIRED": "ផុតកំណត់",
      "CANCELLED": "បានបោះបង់"
    },
    "table": { "name": "អ្នករត់", "category": "ប្រភេទ", "listPrice": "តម្លៃ", "paid": "ត្រូវបង់", "registration": "ការចុះឈ្មោះ" },
    "regStatus": { "PENDING": "រង់ចាំ", "CONFIRMED": "បានបញ្ជាក់", "CANCELLED": "បានបោះបង់" },
    "amount": {
      "list": "សរុបរង",
      "coupon": "បញ្ចុះតម្លៃតាមលេខកូដ",
      "ident": "សេនសម្រាប់ផ្ទៀងផ្ទាត់",
      "total": "ចំនួនត្រូវបង់",
      "identHint": "កាត់ចេញដើម្បីងាយស្រួលផ្ទៀងផ្ទាត់ការផ្ទេរប្រាក់។"
    },
    "pay": "បង់ប្រាក់ឥឡូវ",
    "cancel": "បោះបង់ការបញ្ជាទិញ",
    "cancelAsk": "បោះបង់ការបញ្ជាទិញនេះមែនទេ? កន្លែងរបស់អ្នកនឹងត្រូវដោះលែង។",
    "cancelConfirm": "យល់ព្រមបោះបង់",
    "cancelKeep": "រក្សាការបញ្ជាទិញ"
  }
```

Run: `pnpm i18n:check`
Expected: `i18n 检查通过：3 个命名空间，三种语言 key 一致`。

- [ ] **Step 5: 写页面的失败测试**

`web/user/src/test/setup.ts`：在 `afterEach` 回调中 `window.localStorage.clear();` 之后加一行（已有则跳过）：

```ts
  window.sessionStorage.clear();
```

创建 `web/user/src/test/runner.ts`：

```ts
import { jsonResponse } from "./fixtures";
import type { FetchHandler } from "./renderApp";

export const testRunner = {
  id: 7,
  telegramUserId: 700001,
  telegramUsername: "dara",
  displayName: "Dara",
  locale: "en",
};

/** 让 RequireRunner 视为已登录：未过期令牌 + 开发登录参数 */
export function signInRunner(): void {
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  window.sessionStorage.setItem("werun.appToken", "test-runner-token");
  window.sessionStorage.setItem("werun.appTokenExpiresAt", expiresAt);
  window.sessionStorage.setItem("werun.devInitData", "user=%7B%22id%22%3A700001%7D&auth_date=1&hash=test");
}

type Route = (request: Request) => Response | Promise<Response>;

/** 按「方法 路径」分发请求；登录相关接口统一返回测试跑者，未登记的路径返回 404 */
export function routeHandler(routes: Record<string, Route>): FetchHandler {
  return async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/app/me") {
      return jsonResponse(200, testRunner);
    }
    if (pathname === "/api/app/auth/telegram") {
      return jsonResponse(200, {
        token: "test-runner-token",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        user: testRunner,
      });
    }
    const route = routes[`${request.method} ${pathname}`];
    if (!route) {
      return jsonResponse(404, { error: { code: "NOT_FOUND", message: "Not found" } });
    }
    return route(request);
  };
}
```

创建 `web/user/src/test/orderFixtures.ts`：

```ts
import type { Schemas } from "@werun/api-client";
import type { RegistrationConsent, RunnerProfile } from "../register/model";

export const savedProfile: RunnerProfile = {
  id: 501,
  fullName: "Chan Sophea",
  gender: "F",
  birthDate: "1990-05-01",
  nationality: "KH",
  idType: "PASSPORT",
  idNoMasked: "*****4567",
  phone: "+85512345678",
  email: "",
  emergencyName: "Sok Dara",
  emergencyPhone: "+85598765432",
  tshirtSize: "M",
  isSelf: true,
};

export const consentEn: RegistrationConsent = {
  version: "REG-E2E-v1",
  lang: "en",
  effectiveDate: "2026-01-01",
  fullText: "By registering you agree to the race rules.",
  items: [
    { key: "rules", title: "Race rules", description: "I will follow the race rules." },
    { key: "health", title: "Health", description: "I am fit to take part." },
    { key: "terms", title: "Terms", description: "I accept the registration terms." },
  ],
};

export function quoteFor(runners: number, couponCents = 0): Schemas["Quote"] {
  const list = 2500 * runners;
  const amount = list - couponCents;
  return {
    participants: Array.from({ length: runners }, () => ({
      categoryId: 11,
      priceRuleId: 7,
      audience: "ALL" as const,
      listPriceCents: 2500,
      paidCents: Math.floor(amount / runners),
    })),
    listAmountCents: list,
    couponApplied: couponCents > 0,
    couponDiscountCents: couponCents,
    identOffsetCents: 0,
    discountCents: couponCents,
    amountCents: amount,
    currency: "USD",
  };
}

const eventName = {
  zh: "金边半程马拉松 2026",
  en: "Phnom Penh Half Marathon 2026",
  km: "ម៉ារ៉ាតុងពាក់កណ្ដាលភ្នំពេញ ២០២៦",
};

export function orderDetail(overrides: Partial<Schemas["OrderDetail"]> = {}): Schemas["OrderDetail"] {
  return {
    orderNo: "WR7K2M9QXA",
    status: "PENDING_PAYMENT",
    eventSlug: "phnom-penh-half-2026",
    eventName,
    eventTimezone: "Asia/Phnom_Penh",
    listAmountCents: 5000,
    discountCents: 1001,
    identOffsetCents: 1,
    amountCents: 3999,
    currency: "USD",
    deadlineAt: "2026-09-14T03:30:00Z",
    paidAt: null,
    createdAt: "2026-09-14T03:00:00Z",
    participants: [
      {
        regNo: "RG4N8P2QTZ",
        categoryId: 11,
        categoryName: { zh: "半程 21K", en: "Half marathon", km: "ពាក់កណ្ដាលម៉ារ៉ាតុង" },
        fullName: "Chan Sophea",
        priceRuleId: 7,
        listPriceCents: 2500,
        paidCents: 1999,
        registrationStatus: "PENDING",
      },
      {
        regNo: "RG5P9Q3RVW",
        categoryId: 11,
        categoryName: { zh: "半程 21K", en: "Half marathon", km: "ពាក់កណ្ដាលម៉ារ៉ាតុង" },
        fullName: "Lim Dara",
        priceRuleId: 7,
        listPriceCents: 2500,
        paidCents: 2000,
        registrationStatus: "PENDING",
      },
    ],
    paymentAccount: {
      id: 3,
      name: "ABA USD",
      provider: "ABA",
      accountName: "WERUN CO LTD",
      accountNoMasked: "*** *** 123",
      qrFileId: 9,
    },
    ...overrides,
  };
}

export function orderSummary(overrides: Partial<Schemas["OrderSummary"]> = {}): Schemas["OrderSummary"] {
  return {
    orderNo: "WR7K2M9QXA",
    status: "PENDING_PAYMENT",
    eventSlug: "phnom-penh-half-2026",
    eventName,
    amountCents: 3999,
    currency: "USD",
    participantCount: 2,
    deadlineAt: "2026-09-14T03:30:00Z",
    createdAt: "2026-09-14T03:00:00Z",
    ...overrides,
  };
}
```

创建 `web/user/src/pages/RegisterPage.test.tsx`：

```tsx
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { halfMarathon, jsonResponse } from "../test/fixtures";
import { consentEn, orderDetail, quoteFor, savedProfile } from "../test/orderFixtures";
import { renderApp } from "../test/renderApp";
import { routeHandler, signInRunner } from "../test/runner";

const PATH = "/events/phnom-penh-half-2026/register";

type Routes = Parameters<typeof routeHandler>[0];

function baseRoutes(overrides: Routes = {}): Routes {
  return {
    "GET /api/events/phnom-penh-half-2026": () => jsonResponse(200, halfMarathon),
    "GET /api/app/profiles": () => jsonResponse(200, { items: [savedProfile] }),
    "GET /api/app/consents": () => jsonResponse(200, consentEn),
    "POST /api/app/events/phnom-penh-half-2026/quote": () => jsonResponse(200, quoteFor(1)),
    ...overrides,
  };
}

async function reachConfirmWithSavedProfile(user: UserEvent) {
  await user.selectOptions(await screen.findByTestId("participant-0-category"), "11");
  await user.selectOptions(screen.getByTestId("participant-0-profile"), "501");
  await user.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("participant-0-summary");
  await user.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("quote-amount");
}

async function checkAllConsents(user: UserEvent) {
  for (const key of ["rules", "health", "terms"]) {
    await user.click(await screen.findByTestId(`consent-item-${key}`));
  }
}

describe("RegisterPage", () => {
  beforeEach(() => {
    signInRunner();
    window.localStorage.setItem("werun.lang", "en");
  });

  it("未开放报名时显示提示", async () => {
    renderApp(PATH, routeHandler(baseRoutes({
      "GET /api/events/phnom-penh-half-2026": () => jsonResponse(200, { ...halfMarathon, registrationOpen: false }),
    })));
    expect(await screen.findByTestId("register-closed")).toHaveTextContent("Registration for this event is not open.");
    expect(screen.queryByTestId("wizard-next")).not.toBeInTheDocument();
  });

  it("第 1 步未选组别时提示并停在第 1 步", async () => {
    const user = userEvent.setup();
    renderApp(PATH, routeHandler(baseRoutes()));

    await screen.findByTestId("participant-0-category");
    await user.click(screen.getByTestId("wizard-next"));

    expect(screen.getByTestId("form-error")).toHaveTextContent("Please fix the highlighted fields.");
    expect(screen.getByTestId("participant-0-category-error")).toHaveTextContent("Required.");
    expect(screen.queryByTestId("participant-0-fullName")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("participant-add"));
    expect(screen.getByTestId("participant-1-category")).toBeInTheDocument();
    await user.click(screen.getByTestId("participant-1-remove"));
    expect(screen.queryByTestId("participant-1-category")).not.toBeInTheDocument();
  });

  it("第 2 步校验必填、格式与年龄，通过后按资料算价", async () => {
    const user = userEvent.setup();
    const quoteBodies: unknown[] = [];
    renderApp(PATH, routeHandler(baseRoutes({
      "POST /api/app/events/phnom-penh-half-2026/quote": async (request) => {
        quoteBodies.push(await request.json());
        return jsonResponse(200, quoteFor(1));
      },
    })));

    await user.selectOptions(await screen.findByTestId("participant-0-category"), "11");
    await user.click(screen.getByTestId("wizard-next"));
    fireEvent.change(await screen.findByTestId("participant-0-birthDate"), { target: { value: "2015-01-01" } });
    await user.type(screen.getByTestId("participant-0-phone"), "012345");
    await user.click(screen.getByTestId("wizard-next"));

    expect(screen.getByTestId("form-error")).toHaveTextContent("Please fix the highlighted fields.");
    expect(screen.getByTestId("participant-0-birthDate-error")).toHaveTextContent("Must be at least 16 on race day.");
    expect(screen.getByTestId("participant-0-phone-error")).toHaveTextContent("Invalid format.");
    expect(screen.getByTestId("participant-0-fullName-error")).toHaveTextContent("Required.");
    expect(screen.queryByTestId("participant-0-email-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("quote-amount")).not.toBeInTheDocument();

    await user.type(screen.getByTestId("participant-0-fullName"), "Chan Sophea");
    await user.selectOptions(screen.getByTestId("participant-0-gender"), "F");
    fireEvent.change(screen.getByTestId("participant-0-birthDate"), { target: { value: "1990-05-01" } });
    await user.type(screen.getByTestId("participant-0-nationality"), "kh");
    await user.selectOptions(screen.getByTestId("participant-0-idType"), "PASSPORT");
    await user.type(screen.getByTestId("participant-0-idNo"), "N01234567");
    await user.clear(screen.getByTestId("participant-0-phone"));
    await user.type(screen.getByTestId("participant-0-phone"), "+85512345678");
    await user.type(screen.getByTestId("participant-0-emergencyName"), "Sok Dara");
    await user.type(screen.getByTestId("participant-0-emergencyPhone"), "+85598765432");
    await user.selectOptions(screen.getByTestId("participant-0-tshirtSize"), "M");
    await user.click(screen.getByTestId("participant-0-saveProfile"));
    await user.click(screen.getByTestId("wizard-next"));

    expect(await screen.findByTestId("quote-amount")).toHaveTextContent("$25.00");
    expect(quoteBodies[0]).toEqual({ participants: [{ categoryId: 11, nationality: "KH", birthDate: "1990-05-01" }] });
  });

  it("应用优惠码后显示减免结果，无效码显示错误且不改金额", async () => {
    const user = userEvent.setup();
    renderApp(PATH, routeHandler(baseRoutes({
      "POST /api/app/events/phnom-penh-half-2026/quote": async (request) => {
        const body = (await request.json()) as { couponCode?: string };
        if (!body.couponCode) {
          return jsonResponse(200, quoteFor(1));
        }
        if (body.couponCode === "RUN20") {
          return jsonResponse(200, quoteFor(1, 500));
        }
        return jsonResponse(422, {
          error: { code: "COUPON_INVALID", message: "This coupon code can't be used.", fields: { couponCode: "This coupon code can't be used." } },
        });
      },
    })));
    await reachConfirmWithSavedProfile(user);
    expect(screen.getByTestId("quote-amount")).toHaveTextContent("$25.00");

    await user.type(screen.getByTestId("coupon-input"), "nope");
    await user.click(screen.getByTestId("coupon-apply"));
    const invalid = await screen.findByTestId("coupon-result");
    expect(invalid).toHaveAttribute("data-kind", "error");
    expect(invalid).toHaveTextContent("This coupon code can't be used.");
    expect(screen.getByTestId("quote-amount")).toHaveTextContent("$25.00");

    await user.clear(screen.getByTestId("coupon-input"));
    await user.type(screen.getByTestId("coupon-input"), "run20");
    await user.click(screen.getByTestId("coupon-apply"));
    await waitFor(() => expect(screen.getByTestId("coupon-result")).toHaveAttribute("data-kind", "ok"));
    expect(screen.getByTestId("coupon-result")).toHaveTextContent("Coupon applied: $5.00 off");
    expect(screen.getByTestId("quote-list-amount")).toHaveTextContent("$25.00");
    expect(screen.getByTestId("quote-discount")).toHaveTextContent("-$5.00");
    expect(screen.getByTestId("quote-amount")).toHaveTextContent("$20.00");
  });

  it("同意书逐项勾选完才能提交", async () => {
    const user = userEvent.setup();
    renderApp(PATH, routeHandler(baseRoutes()));
    await reachConfirmWithSavedProfile(user);

    const submit = screen.getByTestId("order-submit");
    expect(submit).toBeDisabled();
    await user.click(await screen.findByTestId("consent-item-rules"));
    await user.click(screen.getByTestId("consent-item-health"));
    expect(submit).toBeDisabled();
    await user.click(screen.getByTestId("consent-item-terms"));
    expect(submit).toBeEnabled();
  });

  it("组别售罄时回到第 1 步并提示", async () => {
    const user = userEvent.setup();
    renderApp(PATH, routeHandler(baseRoutes({
      "POST /api/app/orders": () =>
        jsonResponse(409, { error: { code: "CATEGORY_SOLD_OUT", message: "This category is sold out." } }),
    })));
    await reachConfirmWithSavedProfile(user);
    await checkAllConsents(user);

    await user.click(screen.getByTestId("order-submit"));

    expect(await screen.findByTestId("participant-0-category")).toBeInTheDocument();
    expect(screen.getByTestId("form-error")).toHaveTextContent("This category is sold out.");
    expect(screen.queryByTestId("order-submit")).not.toBeInTheDocument();
  });

  it("网络失败后重试沿用同一个 Idempotency-Key，成功后进入付款页", async () => {
    const user = userEvent.setup();
    const keys: string[] = [];
    const bodies: unknown[] = [];
    const { router } = renderApp(PATH, routeHandler(baseRoutes({
      "POST /api/app/orders": async (request) => {
        keys.push(request.headers.get("Idempotency-Key") ?? "");
        bodies.push(await request.json());
        if (keys.length === 1) {
          throw new TypeError("Failed to fetch");
        }
        return jsonResponse(201, orderDetail());
      },
    })));
    await reachConfirmWithSavedProfile(user);
    await checkAllConsents(user);

    await user.click(screen.getByTestId("order-submit"));
    expect(await screen.findByTestId("form-error")).toHaveTextContent("Network problem. Please check your connection and try again.");
    await user.click(screen.getByTestId("order-submit"));

    await waitFor(() => expect(router.state.location.pathname).toBe("/orders/WR7K2M9QXA/pay"));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(bodies[0]).toEqual({
      eventSlug: "phnom-penh-half-2026",
      consent: { version: "REG-E2E-v1", lang: "en", checkedItems: ["rules", "health", "terms"] },
      participants: [{ categoryId: 11, profileId: 501 }],
    });
  });

  it("应付为 0 的订单直接进入订单详情", async () => {
    const user = userEvent.setup();
    const { router } = renderApp(PATH, routeHandler(baseRoutes({
      "POST /api/app/orders": () => jsonResponse(201, orderDetail({ status: "PAID", amountCents: 0, deadlineAt: null })),
    })));
    await reachConfirmWithSavedProfile(user);
    await checkAllConsents(user);

    await user.click(screen.getByTestId("order-submit"));

    await waitFor(() => expect(router.state.location.pathname).toBe("/orders/WR7K2M9QXA"));
  });
});
```

创建 `web/user/src/pages/OrdersPage.test.tsx`：

```tsx
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { jsonResponse } from "../test/fixtures";
import { orderSummary } from "../test/orderFixtures";
import { renderApp } from "../test/renderApp";
import { routeHandler, signInRunner } from "../test/runner";

describe("OrdersPage", () => {
  beforeEach(() => {
    signInRunner();
    window.localStorage.setItem("werun.lang", "en");
  });

  it("列出订单并进入详情", async () => {
    const { router } = renderApp("/orders", routeHandler({
      "GET /api/app/orders": () =>
        jsonResponse(200, {
          items: [
            orderSummary(),
            orderSummary({ orderNo: "WR3H5J7K9M", status: "PAID", amountCents: 0, participantCount: 1, deadlineAt: null }),
          ],
        }),
    }));

    const first = await screen.findByTestId("order-item-WR7K2M9QXA");
    expect(first).toHaveTextContent("Awaiting payment");
    expect(first).toHaveTextContent("$39.99");
    expect(first).toHaveTextContent("Runners: 2");
    expect(first).toHaveTextContent("Phnom Penh Half Marathon 2026");
    expect(screen.getByTestId("order-item-WR3H5J7K9M")).toHaveTextContent("Confirmed");

    await userEvent.click(first);
    await waitFor(() => expect(router.state.location.pathname).toBe("/orders/WR7K2M9QXA"));
  });

  it("没有订单时显示空状态", async () => {
    window.localStorage.setItem("werun.lang", "zh");
    renderApp("/orders", routeHandler({ "GET /api/app/orders": () => jsonResponse(200, { items: [] }) }));
    expect(await screen.findByTestId("orders-empty")).toHaveTextContent("还没有订单。");
  });
});
```

创建 `web/user/src/pages/OrderDetailPage.test.tsx`：

```tsx
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { jsonResponse } from "../test/fixtures";
import { orderDetail } from "../test/orderFixtures";
import { renderApp } from "../test/renderApp";
import { routeHandler, signInRunner } from "../test/runner";

const PATH = "/orders/WR7K2M9QXA";

describe("OrderDetailPage", () => {
  beforeEach(() => {
    signInRunner();
    window.localStorage.setItem("werun.lang", "en");
  });

  it("待付款订单显示状态、金额构成、去付款与取消", async () => {
    renderApp(PATH, routeHandler({ "GET /api/app/orders/WR7K2M9QXA": () => jsonResponse(200, orderDetail()) }));

    const status = await screen.findByTestId("order-status");
    expect(status).toHaveAttribute("data-status", "PENDING_PAYMENT");
    expect(status).toHaveTextContent("Awaiting payment");
    expect(screen.getByTestId("order-deadline")).toHaveTextContent("Please pay before");
    expect(screen.getByTestId("order-list-amount")).toHaveTextContent("$50.00");
    expect(screen.getByTestId("order-coupon-discount")).toHaveTextContent("-$10.00");
    expect(screen.getByTestId("order-ident-offset")).toHaveTextContent("-$0.01");
    expect(screen.getByTestId("order-amount")).toHaveTextContent("$39.99");
    expect(screen.getByRole("row", { name: /Chan Sophea/ })).toHaveTextContent("$19.99");
    expect(screen.getByRole("row", { name: /Lim Dara/ })).toHaveTextContent("Half marathon");
    expect(screen.getByTestId("order-pay")).toHaveAttribute("href", "/orders/WR7K2M9QXA/pay");
    expect(screen.getByTestId("order-cancel")).toBeInTheDocument();
  });

  it("取消需要二次确认，成功后显示已取消", async () => {
    const user = userEvent.setup();
    const cancelled = orderDetail({
      status: "CANCELLED",
      deadlineAt: null,
      participants: orderDetail().participants.map((p) => ({ ...p, registrationStatus: "CANCELLED" as const })),
    });
    renderApp(PATH, routeHandler({
      "GET /api/app/orders/WR7K2M9QXA": () => jsonResponse(200, orderDetail()),
      "POST /api/app/orders/WR7K2M9QXA/cancel": () => jsonResponse(200, cancelled),
    }));

    await user.click(await screen.findByTestId("order-cancel"));
    await user.click(screen.getByTestId("order-cancel-keep"));
    expect(screen.getByTestId("order-status")).toHaveAttribute("data-status", "PENDING_PAYMENT");

    await user.click(screen.getByTestId("order-cancel"));
    await user.click(screen.getByTestId("order-cancel-confirm"));

    expect(await screen.findByText("Cancelled", { selector: "[data-testid='order-status']" })).toBeInTheDocument();
    expect(screen.getByTestId("order-status")).toHaveAttribute("data-status", "CANCELLED");
    expect(screen.queryByTestId("order-pay")).not.toBeInTheDocument();
    expect(screen.queryByTestId("order-cancel")).not.toBeInTheDocument();
  });

  it("取消失败时显示服务端文案", async () => {
    const user = userEvent.setup();
    renderApp(PATH, routeHandler({
      "GET /api/app/orders/WR7K2M9QXA": () => jsonResponse(200, orderDetail()),
      "POST /api/app/orders/WR7K2M9QXA/cancel": () =>
        jsonResponse(409, { error: { code: "ORDER_STATE_CONFLICT", message: "This action isn't allowed for the order's current status." } }),
    }));

    await user.click(await screen.findByTestId("order-cancel"));
    await user.click(screen.getByTestId("order-cancel-confirm"));

    expect(await screen.findByTestId("form-error")).toHaveTextContent("This action isn't allowed for the order's current status.");
  });

  it("凭证被驳回时只显示去付款，已确认订单两个按钮都不显示", async () => {
    const { unmount } = renderApp(PATH, routeHandler({
      "GET /api/app/orders/WR7K2M9QXA": () => jsonResponse(200, orderDetail({ status: "PROOF_REJECTED" })),
    }));
    expect(await screen.findByTestId("order-pay")).toBeInTheDocument();
    expect(screen.queryByTestId("order-cancel")).not.toBeInTheDocument();
    unmount();

    renderApp(PATH, routeHandler({
      "GET /api/app/orders/WR7K2M9QXA": () =>
        jsonResponse(200, orderDetail({ status: "PAID", deadlineAt: null, paidAt: "2026-09-14T04:00:00Z" })),
    }));
    expect(await screen.findByTestId("order-status")).toHaveAttribute("data-status", "PAID");
    expect(screen.queryByTestId("order-pay")).not.toBeInTheDocument();
    expect(screen.queryByTestId("order-cancel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("order-deadline")).not.toBeInTheDocument();
  });

  it("订单不存在时显示 404 页面", async () => {
    renderApp("/orders/WR00000000", routeHandler({}));
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
  });
});
```

在 `web/user/src/pages/EventDetailPage.test.tsx` 的 `describe` 末尾追加：

```tsx
  it("RACE 开放报名且有余额时显示报名按钮", async () => {
    window.localStorage.setItem("werun.lang", "en");
    renderApp("/events/phnom-penh-half-2026", async () => jsonResponse(200, halfMarathon));

    const button = await screen.findByTestId("register-button");
    expect(button).toHaveAttribute("href", "/events/phnom-penh-half-2026/register");
    expect(button).toHaveTextContent("Register");
  });

  it("未开放报名时不显示报名按钮", async () => {
    window.localStorage.setItem("werun.lang", "en");
    renderApp("/events/phnom-penh-half-2026", async () => jsonResponse(200, { ...halfMarathon, registrationOpen: false }));

    expect(await screen.findByRole("heading", { name: "Phnom Penh Half Marathon 2026" })).toBeInTheDocument();
    expect(screen.queryByTestId("register-button")).not.toBeInTheDocument();
  });

  it("所有组别售罄时显示已满", async () => {
    window.localStorage.setItem("werun.lang", "en");
    const soldOut = { ...halfMarathon, categories: halfMarathon.categories.map((c) => ({ ...c, soldOut: true })) };
    renderApp("/events/phnom-penh-half-2026", async () => jsonResponse(200, soldOut));

    expect(await screen.findByTestId("register-sold-out")).toHaveTextContent("All categories are sold out.");
    expect(screen.queryByTestId("register-button")).not.toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Half marathon/ })).toHaveTextContent("Sold out");
  });
```

- [ ] **Step 6: 运行测试，确认失败**

Run: `pnpm --filter @werun/user test src/pages`
Expected: FAIL：`RegisterPage.test.tsx` 等报 `Unable to find an element by: [data-testid="participant-0-category"]`（路由尚未注册，渲染 404 页面）；`EventDetailPage.test.tsx` 新增用例找不到 `register-button`；`orderFixtures.ts` 导入 `../register/model` 成功（Step 3 已创建）。

- [ ] **Step 7: 实现向导、订单页与入口**

创建 `web/user/src/register/api.ts`：

```ts
import { useQuery } from "@tanstack/react-query";
import { unwrap, type ApiClient, type Schemas } from "@werun/api-client";
import type { Lang } from "@werun/i18n";
import { useApi } from "../api";

export function useRunnerProfiles() {
  const api = useApi();
  return useQuery({
    queryKey: ["register", "profiles"],
    queryFn: async () => unwrap(await api.GET("/app/profiles")).items,
  });
}

export function useRegistrationConsent(lang: Lang) {
  const api = useApi();
  return useQuery({
    queryKey: ["register", "consent", lang],
    queryFn: async () => unwrap(await api.GET("/app/consents", { params: { query: { purpose: "REGISTRATION", lang } } })),
  });
}

export function quoteQueryKey(slug: string, body: Schemas["QuoteRequest"]) {
  return ["register", "quote", slug, JSON.stringify(body)] as const;
}

export async function fetchQuote(api: ApiClient, slug: string, body: Schemas["QuoteRequest"]): Promise<Schemas["Quote"]> {
  return unwrap(await api.POST("/app/events/{slug}/quote", { params: { path: { slug } }, body }));
}

export async function createOrder(api: ApiClient, idempotencyKey: string, body: Schemas["CreateOrderRequest"]): Promise<Schemas["OrderDetail"]> {
  return unwrap(await api.POST("/app/orders", { params: { header: { "Idempotency-Key": idempotencyKey } }, body }));
}
```

创建 `web/user/src/orders/api.ts`：

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "@werun/api-client";
import { useApi } from "../api";

export function useMyOrders() {
  const api = useApi();
  return useQuery({
    queryKey: ["orders"],
    queryFn: async () => unwrap(await api.GET("/app/orders")).items,
  });
}

export function useMyOrder(orderNo: string) {
  const api = useApi();
  return useQuery({
    queryKey: ["orders", orderNo],
    queryFn: async () => unwrap(await api.GET("/app/orders/{orderNo}", { params: { path: { orderNo } } })),
  });
}

export function useCancelOrder(orderNo: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => unwrap(await api.POST("/app/orders/{orderNo}/cancel", { params: { path: { orderNo } } })),
    onSuccess: (order) => {
      queryClient.setQueryData(["orders", orderNo], order);
      void queryClient.invalidateQueries({ queryKey: ["orders"], exact: true });
    },
  });
}
```

创建 `web/user/src/register/Wizard.module.css`：

```css
.stepper {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 16px;
  padding: 0;
  list-style: none;
  font-size: 13px;
}

.step,
.stepActive {
  padding: 4px 12px;
  border-radius: 100px;
  border: 1px solid var(--line);
  color: var(--ink-mute);
  background: var(--card);
}

.stepActive {
  border-color: var(--brand);
  color: var(--brand);
  font-weight: 600;
}

.stack {
  display: grid;
  gap: 12px;
}

.card {
  display: grid;
  gap: 12px;
  margin: 0;
  padding: 16px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--r);
  min-width: 0;
}

.legend,
.cardTitle {
  font-size: 16px;
  font-weight: 700;
}

.field {
  display: grid;
  gap: 6px;
}

.label {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-mid);
}

.input {
  min-height: 44px;
  width: 100%;
  padding: 0 12px;
  border: 1px solid var(--line-hard);
  border-radius: 10px;
  background: var(--card);
  color: var(--ink);
  font: inherit;
}

.input[aria-invalid="true"] {
  border-color: var(--stop);
}

.fieldError {
  font-size: 13px;
  color: var(--stop);
}

.formError {
  margin-bottom: 12px;
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--stop-tint);
  color: var(--stop);
}

.hint {
  font-size: 13px;
  color: var(--ink-mute);
}

.checkbox {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-height: 44px;
}

.checkbox input {
  width: 20px;
  height: 20px;
  margin-top: 2px;
  flex: none;
}

.checkbox span {
  display: grid;
  gap: 2px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 16px;
}

.primary,
.secondary {
  min-height: 44px;
  padding: 0 20px;
  border-radius: 100px;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.primary {
  border: 1px solid var(--brand);
  background: var(--brand-fill);
  color: #fff;
}

.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.secondary {
  border: 1px solid var(--line-hard);
  background: var(--card);
  color: var(--ink);
}

.couponRow {
  display: flex;
  gap: 8px;
}

.couponOk {
  font-size: 13px;
  color: var(--leaf);
}

.amounts {
  display: grid;
  gap: 6px;
  margin: 0;
}

.amountRow,
.total {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.amountRow dd,
.total dd {
  margin: 0;
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

.total {
  padding-top: 8px;
  border-top: 1px solid var(--line);
  font-size: 18px;
  font-weight: 700;
}

.consentText {
  max-height: 220px;
  overflow-y: auto;
  padding: 12px;
  border-radius: 10px;
  background: var(--sunk);
  white-space: pre-wrap;
  font-size: 14px;
}
```

创建 `web/user/src/register/StepParticipants.tsx`：

```tsx
import { useTranslation } from "react-i18next";
import { MAX_PARTICIPANTS, type ParticipantDraft, type PublicEvent, type RunnerProfile } from "./model";
import styles from "./Wizard.module.css";

interface StepParticipantsProps {
  event: PublicEvent;
  participants: ParticipantDraft[];
  profiles: RunnerProfile[];
  errors: Record<string, string>;
  onChange: (index: number, patch: Partial<ParticipantDraft>) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
}

export function StepParticipants({ event, participants, profiles, errors, onChange, onAdd, onRemove }: StepParticipantsProps) {
  const { t } = useTranslation("user");

  return (
    <div className={styles.stack}>
      {participants.map((draft, i) => {
        const categoryError = errors[`participants[${i}].categoryId`];
        const profileError = errors[`participants[${i}].profileId`];
        return (
          <fieldset key={draft.key} className={styles.card}>
            <legend className={styles.legend}>{t("register.participant", { n: i + 1 })}</legend>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`participant-${i}-category`}>
                {t("register.category")}
              </label>
              <select
                id={`participant-${i}-category`}
                data-testid={`participant-${i}-category`}
                className={styles.input}
                value={draft.categoryId ?? ""}
                aria-invalid={categoryError ? true : undefined}
                onChange={(e) => onChange(i, { categoryId: e.target.value === "" ? null : Number(e.target.value) })}
              >
                <option value="">{t("register.chooseCategory")}</option>
                {event.categories.map((category) => (
                  <option key={category.id} value={category.id} disabled={category.soldOut}>
                    {category.soldOut ? t("register.soldOutOption", { name: category.name }) : category.name}
                  </option>
                ))}
              </select>
              {categoryError ? (
                <span className={styles.fieldError} data-testid={`participant-${i}-category-error`}>
                  {categoryError}
                </span>
              ) : null}
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`participant-${i}-profile`}>
                {t("register.profile")}
              </label>
              <select
                id={`participant-${i}-profile`}
                data-testid={`participant-${i}-profile`}
                className={styles.input}
                value={draft.profileId ?? ""}
                aria-invalid={profileError ? true : undefined}
                onChange={(e) => onChange(i, { profileId: e.target.value === "" ? null : Number(e.target.value) })}
              >
                <option value="">{t("register.newProfile")}</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {t("register.savedProfile", { name: profile.fullName, idNo: profile.idNoMasked })}
                  </option>
                ))}
              </select>
              {profileError ? (
                <span className={styles.fieldError} data-testid={`participant-${i}-profile-error`}>
                  {profileError}
                </span>
              ) : null}
            </div>
            {participants.length > 1 ? (
              <div className={styles.actions}>
                <button type="button" className={styles.secondary} data-testid={`participant-${i}-remove`} onClick={() => onRemove(i)}>
                  {t("register.removeParticipant")}
                </button>
              </div>
            ) : null}
          </fieldset>
        );
      })}
      {participants.length < MAX_PARTICIPANTS ? (
        <button type="button" className={styles.secondary} data-testid="participant-add" onClick={onAdd}>
          {t("register.addParticipant")}
        </button>
      ) : null}
    </div>
  );
}
```

创建 `web/user/src/register/StepDetails.tsx`：

```tsx
import type { ChangeEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { GENDERS, ID_TYPES, TSHIRT_SIZES, type ParticipantDraft, type ProfileField, type ProfileForm, type PublicEvent, type RunnerProfile } from "./model";
import styles from "./Wizard.module.css";

interface StepDetailsProps {
  event: PublicEvent;
  participants: ParticipantDraft[];
  profiles: RunnerProfile[];
  errors: Record<string, string>;
  today: string;
  onChange: (index: number, patch: Partial<ParticipantDraft>) => void;
}

export function StepDetails({ event, participants, profiles, errors, today, onChange }: StepDetailsProps) {
  const { t } = useTranslation("user");

  return (
    <div className={styles.stack}>
      {participants.map((draft, i) => {
        const category = event.categories.find((c) => c.id === draft.categoryId);
        const heading = (
          <h2 className={styles.cardTitle}>
            {t("register.participant", { n: i + 1 })}
            {category ? <span className={styles.hint}> · {category.name}</span> : null}
          </h2>
        );

        if (draft.profileId !== null) {
          const saved = profiles.find((p) => p.id === draft.profileId);
          const profileError = errors[`participants[${i}].profileId`];
          return (
            <section key={draft.key} className={styles.card} data-testid={`participant-${i}-summary`}>
              {heading}
              {saved ? <p>{t("register.savedProfile", { name: saved.fullName, idNo: saved.idNoMasked })}</p> : null}
              {profileError ? (
                <span className={styles.fieldError} data-testid={`participant-${i}-profile-error`}>
                  {profileError}
                </span>
              ) : null}
            </section>
          );
        }

        const testId = (field: ProfileField | "saveProfile") => `participant-${i}-${field}`;
        const bind = (field: ProfileField) => ({
          id: testId(field),
          "data-testid": testId(field),
          className: styles.input,
          value: draft.form[field],
          "aria-invalid": errors[`participants[${i}].${field}`] ? true : undefined,
          onChange: (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
            onChange(i, { form: { ...draft.form, [field]: e.target.value } as ProfileForm }),
        });
        const row = (field: ProfileField, control: ReactNode) => {
          const error = errors[`participants[${i}].${field}`];
          return (
            <div className={styles.field} key={field}>
              <label className={styles.label} htmlFor={testId(field)}>
                {t(`register.fields.${field}`)}
              </label>
              {control}
              {error ? (
                <span className={styles.fieldError} data-testid={`${testId(field)}-error`}>
                  {error}
                </span>
              ) : null}
            </div>
          );
        };

        return (
          <section key={draft.key} className={styles.card}>
            {heading}
            {row("fullName", <input type="text" autoComplete="name" maxLength={100} {...bind("fullName")} />)}
            {row(
              "gender",
              <select {...bind("gender")}>
                <option value="">{t("register.choose")}</option>
                {GENDERS.map((g) => (
                  <option key={g} value={g}>
                    {t(`register.gender.${g}`)}
                  </option>
                ))}
              </select>,
            )}
            {row("birthDate", <input type="date" max={today} {...bind("birthDate")} />)}
            {row("nationality", <input type="text" maxLength={2} autoCapitalize="characters" placeholder="KH" {...bind("nationality")} />)}
            {row(
              "idType",
              <select {...bind("idType")}>
                <option value="">{t("register.choose")}</option>
                {ID_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`register.idType.${type}`)}
                  </option>
                ))}
              </select>,
            )}
            {row("idNo", <input type="text" autoComplete="off" maxLength={64} {...bind("idNo")} />)}
            {row("phone", <input type="tel" inputMode="tel" autoComplete="tel" placeholder="+85512345678" {...bind("phone")} />)}
            {row("email", <input type="email" autoComplete="email" {...bind("email")} />)}
            {row("emergencyName", <input type="text" maxLength={100} {...bind("emergencyName")} />)}
            {row("emergencyPhone", <input type="tel" inputMode="tel" placeholder="+85512345678" {...bind("emergencyPhone")} />)}
            {row(
              "tshirtSize",
              <select {...bind("tshirtSize")}>
                <option value="">{t("register.choose")}</option>
                {TSHIRT_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>,
            )}
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                id={testId("saveProfile")}
                data-testid={testId("saveProfile")}
                checked={draft.saveAsProfile}
                onChange={(e) => onChange(i, { saveAsProfile: e.target.checked })}
              />
              <span>{t("register.fields.saveProfile")}</span>
            </label>
          </section>
        );
      })}
    </div>
  );
}
```

创建 `web/user/src/register/StepConfirm.tsx`：

```tsx
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, formatUsd, type Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "../api";
import { createOrder, fetchQuote, quoteQueryKey, useRegistrationConsent } from "./api";
import { participantName, toOrderParticipant, toQuoteParticipant, type ParticipantDraft, type PublicEvent, type RunnerProfile } from "./model";
import type { SubmissionKey } from "./submissionKey";
import styles from "./Wizard.module.css";

interface StepConfirmProps {
  event: PublicEvent;
  participants: ParticipantDraft[];
  profiles: RunnerProfile[];
  submissionKey: SubmissionKey;
  /** 返回 true 表示向导已处理（例如回到前面的步骤） */
  onServerError: (error: ApiError) => boolean;
  onBack: () => void;
  onDone: (order: Schemas["OrderDetail"]) => void;
}

type CouponResult = { kind: "ok" | "error"; text: string };

function describeError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const details = Object.values(error.fields);
    return details.length > 0 ? `${error.message} ${details.join(" ")}` : error.message;
  }
  return fallback;
}

export function StepConfirm({ event, participants, profiles, submissionKey, onServerError, onBack, onDone }: StepConfirmProps) {
  const { t } = useTranslation("user");
  const lang = useLang();
  const api = useApi();
  const queryClient = useQueryClient();
  const [couponInput, setCouponInput] = useState("");
  const [appliedCoupon, setAppliedCoupon] = useState("");
  const [couponResult, setCouponResult] = useState<CouponResult | null>(null);
  const [applying, setApplying] = useState(false);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const quoteParticipants = participants.map((p) => toQuoteParticipant(p, profiles));
  const quoteBody = (code: string): Schemas["QuoteRequest"] =>
    code ? { participants: quoteParticipants, couponCode: code } : { participants: quoteParticipants };
  const currentBody = quoteBody(appliedCoupon);
  const quote = useQuery({
    queryKey: quoteQueryKey(event.slug, currentBody),
    queryFn: () => fetchQuote(api, event.slug, currentBody),
  });
  const consent = useRegistrationConsent(lang);
  const consentItems = consent.data?.items ?? [];
  const allChecked = consentItems.length > 0 && consentItems.every((item) => checked[item.key]);

  async function applyCoupon() {
    const code = couponInput.trim().toUpperCase();
    if (code === "") {
      setAppliedCoupon("");
      setCouponResult(null);
      return;
    }
    setApplying(true);
    try {
      const body = quoteBody(code);
      const data = await fetchQuote(api, event.slug, body);
      queryClient.setQueryData(quoteQueryKey(event.slug, body), data);
      setAppliedCoupon(code);
      setCouponResult({ kind: "ok", text: t("register.coupon.applied", { amount: formatUsd(data.couponDiscountCents) }) });
    } catch (err) {
      const text = err instanceof ApiError ? (err.fields.couponCode ?? err.message) : t("register.errors.network");
      setCouponResult({ kind: "error", text });
    } finally {
      setApplying(false);
    }
  }

  async function submit() {
    if (!consent.data || !allChecked) {
      return;
    }
    const payload: Schemas["CreateOrderRequest"] = {
      eventSlug: event.slug,
      ...(appliedCoupon ? { couponCode: appliedCoupon } : {}),
      consent: { version: consent.data.version, lang, checkedItems: consent.data.items.map((item) => item.key) },
      participants: participants.map(toOrderParticipant),
    };
    const key = submissionKey.keyFor(JSON.stringify(payload));
    setSubmitting(true);
    setError(null);
    try {
      const order = await createOrder(api, key, payload);
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      onDone(order);
    } catch (err) {
      if (!(err instanceof ApiError)) {
        setError(t("register.errors.network"));
        return;
      }
      if (err.code === "COUPON_INVALID" || err.code === "COUPON_EXHAUSTED") {
        setAppliedCoupon("");
        setCouponResult({ kind: "error", text: err.fields.couponCode ?? err.message });
        return;
      }
      if (!onServerError(err)) {
        setError(describeError(err, t("register.errors.network")));
      }
    } finally {
      setSubmitting(false);
    }
  }

  const discount = quote.data?.discountCents ?? 0;

  return (
    <div className={styles.stack}>
      <section className={styles.card}>
        <h2 className={styles.cardTitle}>{t("register.quote.title")}</h2>
        {quote.isPending ? (
          <p className={styles.hint}>{t("register.quote.loading")}</p>
        ) : quote.isError ? (
          <p className={styles.fieldError} role="alert" data-testid="quote-error">
            {describeError(quote.error, t("common:state.error"))}
          </p>
        ) : (
          <dl className={styles.amounts}>
            {quote.data.participants.map((p, i) => {
              const draft = participants[i];
              return (
                <div key={draft?.key ?? i} className={styles.amountRow}>
                  <dt>{draft ? participantName(draft, profiles) : ""}</dt>
                  <dd>{formatUsd(p.listPriceCents)}</dd>
                </div>
              );
            })}
            <div className={styles.amountRow}>
              <dt>{t("register.quote.listAmount")}</dt>
              <dd data-testid="quote-list-amount">{formatUsd(quote.data.listAmountCents)}</dd>
            </div>
            <div className={styles.amountRow}>
              <dt>{t("register.quote.discount")}</dt>
              <dd data-testid="quote-discount">{formatUsd(discount > 0 ? -discount : 0)}</dd>
            </div>
            <div className={styles.total}>
              <dt>{t("register.quote.amount")}</dt>
              <dd data-testid="quote-amount">{formatUsd(quote.data.amountCents)}</dd>
            </div>
          </dl>
        )}
        <p className={styles.hint}>{t("register.quote.identNote")}</p>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="coupon-input">
            {t("register.coupon.label")}
          </label>
          <div className={styles.couponRow}>
            <input
              id="coupon-input"
              data-testid="coupon-input"
              className={styles.input}
              type="text"
              autoCapitalize="characters"
              maxLength={64}
              value={couponInput}
              onChange={(e) => setCouponInput(e.target.value)}
            />
            <button type="button" className={styles.secondary} data-testid="coupon-apply" disabled={applying} onClick={() => void applyCoupon()}>
              {t("register.coupon.apply")}
            </button>
          </div>
          {couponResult ? (
            <span
              data-testid="coupon-result"
              data-kind={couponResult.kind}
              className={couponResult.kind === "ok" ? styles.couponOk : styles.fieldError}
              role={couponResult.kind === "error" ? "alert" : "status"}
            >
              {couponResult.text}
            </span>
          ) : null}
        </div>
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>{t("register.consent.title")}</h2>
        {consent.isPending ? (
          <p className={styles.hint}>{t("register.consent.loading")}</p>
        ) : consent.isError ? (
          <p className={styles.fieldError} role="alert">
            {describeError(consent.error, t("common:state.error"))}
          </p>
        ) : (
          <>
            <p className={styles.hint}>{t("register.consent.version", { version: consent.data.version })}</p>
            <div className={styles.consentText} tabIndex={0}>
              {consent.data.fullText}
            </div>
            {consent.data.items.map((item) => (
              <label key={item.key} className={styles.checkbox}>
                <input
                  type="checkbox"
                  data-testid={`consent-item-${item.key}`}
                  checked={checked[item.key] ?? false}
                  onChange={(e) => setChecked((prev) => ({ ...prev, [item.key]: e.target.checked }))}
                />
                <span>
                  <strong>{item.title}</strong>
                  <span className={styles.hint}>{item.description}</span>
                </span>
              </label>
            ))}
          </>
        )}
      </section>

      {error ? (
        <p className={styles.formError} role="alert" data-testid="form-error">
          {error}
        </p>
      ) : null}

      <div className={styles.actions}>
        <button type="button" className={styles.secondary} data-testid="wizard-back" onClick={onBack}>
          {t("register.back")}
        </button>
        <button
          type="button"
          className={styles.primary}
          data-testid="order-submit"
          disabled={!allChecked || !quote.isSuccess || submitting}
          onClick={() => void submit()}
        >
          {submitting ? t("register.submitting") : t("register.submit")}
        </button>
      </div>
    </div>
  );
}
```

创建 `web/user/src/pages/RegisterPage.tsx`：

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, type Schemas } from "@werun/api-client";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { QueryState } from "../components/QueryState";
import { usePublicEvent } from "../queries";
import { useRunnerProfiles } from "../register/api";
import { ageOn, newParticipant, todayIso, type ParticipantDraft, type PublicEvent, type RunnerProfile } from "../register/model";
import { StepConfirm } from "../register/StepConfirm";
import { StepDetails } from "../register/StepDetails";
import { StepParticipants } from "../register/StepParticipants";
import { SubmissionKey } from "../register/submissionKey";
import { validateProfileForm } from "../register/validate";
import wizard from "../register/Wizard.module.css";
import { NotFoundPage } from "./NotFoundPage";
import styles from "./Page.module.css";

const STEP_KEYS = ["participants", "details", "confirm"] as const;
type Step = 0 | 1 | 2;
const PARTICIPANT_FIELD = /^participants\[(\d+)\]\.(\w+)$/;

export function RegisterPage() {
  const { slug = "" } = useParams();
  const { t } = useTranslation("user");
  const event = usePublicEvent(slug);
  const profiles = useRunnerProfiles();

  if (event.error instanceof ApiError && event.error.status === 404) {
    return <NotFoundPage />;
  }

  return (
    <QueryState query={event}>
      {(data) =>
        data.eventType !== "RACE" || !data.registrationOpen ? (
          <section>
            <h1 className={styles.title}>{data.name}</h1>
            <p className={styles.muted} data-testid="register-closed">
              {t("register.closed")}
            </p>
          </section>
        ) : (
          <QueryState query={profiles}>{(items) => <RegisterWizard event={data} profiles={items} />}</QueryState>
        )
      }
    </QueryState>
  );
}

function RegisterWizard({ event, profiles }: { event: PublicEvent; profiles: RunnerProfile[] }) {
  const { t } = useTranslation("user");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [submissionKey] = useState(() => new SubmissionKey());
  const [step, setStep] = useState<Step>(0);
  const [participants, setParticipants] = useState<ParticipantDraft[]>(() => [newParticipant()]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const today = todayIso();

  const categoryOf = (draft: ParticipantDraft) => event.categories.find((c) => c.id === draft.categoryId);

  function update(index: number, patch: Partial<ParticipantDraft>) {
    setParticipants((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }

  function finishStep(errors: Record<string, string>, next: Step) {
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setFormError(t("register.errors.fixBelow"));
      return;
    }
    setFormError(null);
    setStep(next);
  }

  function nextFromParticipants() {
    const errors: Record<string, string> = {};
    const chosenProfiles = new Set<number>();
    participants.forEach((draft, i) => {
      const category = categoryOf(draft);
      if (!category) {
        errors[`participants[${i}].categoryId`] = t("register.errors.required");
      } else if (category.soldOut) {
        errors[`participants[${i}].categoryId`] = t("register.errors.soldOut");
      }
      if (draft.profileId === null) {
        return;
      }
      if (chosenProfiles.has(draft.profileId)) {
        errors[`participants[${i}].profileId`] = t("register.errors.duplicateProfile");
      }
      chosenProfiles.add(draft.profileId);
      const saved = profiles.find((p) => p.id === draft.profileId);
      if (saved && category && ageOn(saved.birthDate, event.raceDate) < category.minAge) {
        errors[`participants[${i}].profileId`] = t("register.errors.tooYoung", { minAge: category.minAge });
      }
    });
    finishStep(errors, 1);
  }

  function nextFromDetails() {
    const errors: Record<string, string> = {};
    participants.forEach((draft, i) => {
      if (draft.profileId !== null) {
        return;
      }
      const issues = validateProfileForm(draft.form, {
        minAge: categoryOf(draft)?.minAge ?? 0,
        raceDate: event.raceDate,
        today,
      });
      for (const [field, issue] of Object.entries(issues)) {
        if (issue) {
          errors[`participants[${i}].${field}`] = t(issue.key, issue.params ?? {});
        }
      }
    });
    finishStep(errors, 2);
  }

  function handleServerError(error: ApiError): boolean {
    if (error.code === "CATEGORY_SOLD_OUT" || error.code === "PRICE_TIER_SOLD_OUT") {
      void queryClient.invalidateQueries({ queryKey: ["event", event.slug] });
      setFieldErrors({});
      setFormError(error.message);
      setStep(0);
      return true;
    }
    const mapped: Record<string, string> = {};
    let target: Step = 1;
    for (const [field, message] of Object.entries(error.fields)) {
      const match = PARTICIPANT_FIELD.exec(field);
      if (!match) {
        continue;
      }
      const index = Number(match[1]);
      const name = match[2] ?? "";
      const usesSavedProfile = (participants[index]?.profileId ?? null) !== null;
      if (name === "categoryId") {
        mapped[`participants[${index}].categoryId`] = message;
        target = 0;
      } else if (name === "profileId" || usesSavedProfile) {
        mapped[`participants[${index}].profileId`] = message;
        target = 0;
      } else {
        mapped[field] = message;
      }
    }
    if (Object.keys(mapped).length === 0) {
      return false;
    }
    setFieldErrors(mapped);
    setFormError(error.message);
    setStep(target);
    return true;
  }

  function handleDone(order: Schemas["OrderDetail"]) {
    navigate(order.status === "PENDING_PAYMENT" ? `/orders/${order.orderNo}/pay` : `/orders/${order.orderNo}`);
  }

  return (
    <section>
      <h1 className={styles.title}>{t("register.title", { event: event.name })}</h1>
      <ol className={wizard.stepper}>
        {STEP_KEYS.map((key, i) => (
          <li key={key} className={i === step ? wizard.stepActive : wizard.step} aria-current={i === step ? "step" : undefined}>
            {t(`register.steps.${key}`)}
          </li>
        ))}
      </ol>
      {formError && step !== 2 ? (
        <p className={wizard.formError} role="alert" data-testid="form-error">
          {formError}
        </p>
      ) : null}

      {step === 0 ? (
        <StepParticipants
          event={event}
          participants={participants}
          profiles={profiles}
          errors={fieldErrors}
          onChange={update}
          onAdd={() => setParticipants((prev) => [...prev, newParticipant()])}
          onRemove={(index) => setParticipants((prev) => prev.filter((_, i) => i !== index))}
        />
      ) : null}
      {step === 1 ? (
        <StepDetails event={event} participants={participants} profiles={profiles} errors={fieldErrors} today={today} onChange={update} />
      ) : null}
      {step === 2 ? (
        <StepConfirm
          event={event}
          participants={participants}
          profiles={profiles}
          submissionKey={submissionKey}
          onServerError={handleServerError}
          onBack={() => setStep(1)}
          onDone={handleDone}
        />
      ) : null}

      {step < 2 ? (
        <div className={wizard.actions}>
          {step > 0 ? (
            <button type="button" className={wizard.secondary} data-testid="wizard-back" onClick={() => setStep(0)}>
              {t("register.back")}
            </button>
          ) : null}
          <button
            type="button"
            className={wizard.primary}
            data-testid="wizard-next"
            onClick={step === 0 ? nextFromParticipants : nextFromDetails}
          >
            {t("register.next")}
          </button>
        </div>
      ) : null}
    </section>
  );
}
```

创建 `web/user/src/orders/Orders.module.css`：

```css
.list {
  display: grid;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.item {
  display: grid;
  gap: 6px;
  padding: 14px 16px;
  color: var(--ink);
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--r);
}

.itemHead,
.itemMeta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.orderNo,
.money {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

.eventName {
  font-weight: 600;
}

.badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 10px;
  border-radius: 100px;
  font-size: 13px;
  font-weight: 600;
  background: var(--sunk);
  color: var(--ink-mid);
}

.badge[data-status="PENDING_PAYMENT"],
.badge[data-status="PROOF_REJECTED"] {
  background: var(--warn-tint);
  color: var(--warn);
}

.badge[data-status="PAID"] {
  background: var(--leaf-tint);
  color: var(--leaf);
}

.statusLine {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  margin-bottom: 16px;
}

.amounts {
  display: grid;
  gap: 6px;
  margin: 16px 0 0;
  padding: 16px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--r);
}

.amountRow,
.total {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.amountRow dd,
.total dd {
  margin: 0;
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

.total {
  padding-top: 8px;
  border-top: 1px solid var(--line);
  font-size: 18px;
  font-weight: 700;
}

.hint {
  font-size: 13px;
  color: var(--ink-mute);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 16px;
}

.primary,
.secondary {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0 20px;
  border-radius: 100px;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.primary {
  border: 1px solid var(--brand);
  background: var(--brand-fill);
  color: #fff;
}

.secondary {
  border: 1px solid var(--line-hard);
  background: var(--card);
  color: var(--ink);
}

.confirm {
  display: grid;
  gap: 8px;
  width: 100%;
}

.error {
  margin-top: 12px;
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--stop-tint);
  color: var(--stop);
}
```

创建 `web/user/src/pages/OrdersPage.tsx`：

```tsx
import { formatUsd } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { QueryState } from "../components/QueryState";
import { formatDateTime, pickText } from "../format";
import { useMyOrders } from "../orders/api";
import orders from "../orders/Orders.module.css";
import styles from "./Page.module.css";

export function OrdersPage() {
  const { t } = useTranslation("user");
  const lang = useLang();
  const query = useMyOrders();

  return (
    <section>
      <h1 className={styles.title}>{t("orders.title")}</h1>
      <QueryState query={query}>
        {(items) =>
          items.length === 0 ? (
            <p className={styles.muted} data-testid="orders-empty">
              {t("orders.empty")}
            </p>
          ) : (
            <ul className={orders.list}>
              {items.map((order) => (
                <li key={order.orderNo}>
                  <Link to={`/orders/${order.orderNo}`} className={orders.item} data-testid={`order-item-${order.orderNo}`}>
                    <span className={orders.itemHead}>
                      <span className={orders.orderNo}>{order.orderNo}</span>
                      <span className={orders.badge} data-status={order.status}>
                        {t(`orders.status.${order.status}`)}
                      </span>
                    </span>
                    <span className={orders.eventName}>{pickText(order.eventName, lang)}</span>
                    <span className={orders.itemMeta}>
                      <span>{t("orders.participants", { n: order.participantCount })}</span>
                      <span className={orders.money}>{formatUsd(order.amountCents)}</span>
                    </span>
                    <span className={orders.hint}>{formatDateTime(order.createdAt, lang)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )
        }
      </QueryState>
    </section>
  );
}
```

创建 `web/user/src/pages/OrderDetailPage.tsx`：

```tsx
import { ApiError, formatUsd, type Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import { QueryState } from "../components/QueryState";
import { formatDateTime, pickText } from "../format";
import { useCancelOrder, useMyOrder } from "../orders/api";
import orders from "../orders/Orders.module.css";
import { NotFoundPage } from "./NotFoundPage";
import styles from "./Page.module.css";

export function OrderDetailPage() {
  const { orderNo = "" } = useParams();
  const order = useMyOrder(orderNo);

  if (order.error instanceof ApiError && order.error.status === 404) {
    return <NotFoundPage />;
  }
  return <QueryState query={order}>{(data) => <OrderDetailView order={data} />}</QueryState>;
}

// Task 18 在此补全审核中、驳回原因与重传、已确认参赛凭证、过期等状态
function OrderDetailView({ order }: { order: Schemas["OrderDetail"] }) {
  const { t } = useTranslation("user");
  const lang = useLang();
  const cancel = useCancelOrder(order.orderNo);
  const [confirming, setConfirming] = useState(false);

  const couponDiscount = order.discountCents - order.identOffsetCents;
  const canPay = order.status === "PENDING_PAYMENT" || order.status === "PROOF_REJECTED";
  const canCancel = order.status === "PENDING_PAYMENT";

  return (
    <article>
      <p className={styles.muted}>{pickText(order.eventName, lang)}</p>
      <h1 className={styles.title}>{t("orders.detailTitle", { orderNo: order.orderNo })}</h1>
      <p className={orders.statusLine}>
        <span className={orders.badge} data-testid="order-status" data-status={order.status}>
          {t(`orders.status.${order.status}`)}
        </span>
        {canPay && order.deadlineAt ? (
          <span data-testid="order-deadline">{t("orders.deadline", { time: formatDateTime(order.deadlineAt, lang) })}</span>
        ) : null}
      </p>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t("orders.table.name")}</th>
              <th scope="col">{t("orders.table.category")}</th>
              <th scope="col">{t("orders.table.listPrice")}</th>
              <th scope="col">{t("orders.table.paid")}</th>
              <th scope="col">{t("orders.table.registration")}</th>
            </tr>
          </thead>
          <tbody>
            {order.participants.map((p) => (
              <tr key={p.regNo}>
                <th scope="row">{p.fullName}</th>
                <td>{pickText(p.categoryName, lang)}</td>
                <td className={styles.num}>{formatUsd(p.listPriceCents)}</td>
                <td className={styles.num}>{formatUsd(p.paidCents)}</td>
                <td>{t(`orders.regStatus.${p.registrationStatus}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className={orders.amounts}>
        <div className={orders.amountRow}>
          <dt>{t("orders.amount.list")}</dt>
          <dd data-testid="order-list-amount">{formatUsd(order.listAmountCents)}</dd>
        </div>
        {couponDiscount > 0 ? (
          <div className={orders.amountRow}>
            <dt>{t("orders.amount.coupon")}</dt>
            <dd data-testid="order-coupon-discount">{formatUsd(-couponDiscount)}</dd>
          </div>
        ) : null}
        {order.identOffsetCents > 0 ? (
          <div className={orders.amountRow}>
            <dt>
              {t("orders.amount.ident")}
              <span className={orders.hint}> · {t("orders.amount.identHint")}</span>
            </dt>
            <dd data-testid="order-ident-offset">{formatUsd(-order.identOffsetCents)}</dd>
          </div>
        ) : null}
        <div className={orders.total}>
          <dt>{t("orders.amount.total")}</dt>
          <dd data-testid="order-amount">{formatUsd(order.amountCents)}</dd>
        </div>
      </dl>

      {cancel.error ? (
        <p className={orders.error} role="alert" data-testid="form-error">
          {cancel.error instanceof ApiError ? cancel.error.message : t("common:state.error")}
        </p>
      ) : null}

      <div className={orders.actions}>
        {canPay ? (
          <Link to={`/orders/${order.orderNo}/pay`} className={orders.primary} data-testid="order-pay">
            {t("orders.pay")}
          </Link>
        ) : null}
        {canCancel && !confirming ? (
          <button type="button" className={orders.secondary} data-testid="order-cancel" onClick={() => setConfirming(true)}>
            {t("orders.cancel")}
          </button>
        ) : null}
        {canCancel && confirming ? (
          <div className={orders.confirm} role="group">
            <p>{t("orders.cancelAsk")}</p>
            <div className={orders.actions}>
              <button
                type="button"
                className={orders.primary}
                data-testid="order-cancel-confirm"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                {t("orders.cancelConfirm")}
              </button>
              <button type="button" className={orders.secondary} data-testid="order-cancel-keep" onClick={() => setConfirming(false)}>
                {t("orders.cancelKeep")}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}
```

`web/user/src/pages/Page.module.css` 末尾追加：

```css
.cta {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  margin-bottom: 20px;
  padding: 0 24px;
  border-radius: 100px;
  background: var(--brand-fill);
  color: #fff;
  font-weight: 700;
}

.cta:hover {
  color: #fff;
}

.badge {
  display: inline-flex;
  margin-left: 8px;
  padding: 0 8px;
  border-radius: 100px;
  font-size: 12px;
  font-weight: 600;
  background: var(--stop-tint);
  color: var(--stop);
}
```

`web/user/src/pages/EventDetailPage.tsx` 整文件替换为：

```tsx
import { ApiError } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import { QueryState } from "../components/QueryState";
import { formatKm, formatNumber, formatRaceDate, formatTime } from "../format";
import { usePublicEvent } from "../queries";
import { NotFoundPage } from "./NotFoundPage";
import styles from "./Page.module.css";

export function EventDetailPage() {
  const { slug = "" } = useParams();
  const { t } = useTranslation("user");
  const lang = useLang();
  const event = usePublicEvent(slug);

  if (event.error instanceof ApiError && event.error.status === 404) {
    return <NotFoundPage />;
  }

  return (
    <QueryState query={event}>
      {(data) => (
        <article>
          <h1 className={styles.title}>{data.name}</h1>
          <p className={styles.meta}>
            <span>
              {t("event.date")}：{formatRaceDate(data.raceDate, lang)}
            </span>
            <span>
              {t("event.city")}：{data.city}
            </span>
          </p>
          {data.eventType === "RACE" && data.registrationOpen ? (
            data.categories.some((category) => !category.soldOut) ? (
              <Link to={`/events/${data.slug}/register`} className={styles.cta} data-testid="register-button">
                {t("register.cta")}
              </Link>
            ) : (
              <p className={styles.muted} data-testid="register-sold-out">
                {t("register.allSoldOut")}
              </p>
            )
          ) : null}
          <h2 className={styles.title}>{t("event.categories")}</h2>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{t("event.categories")}</th>
                  <th scope="col">{t("event.distance")}</th>
                  <th scope="col">{t("event.capacity")}</th>
                  <th scope="col">{t("event.start")}</th>
                  <th scope="col">{t("event.cutoff")}</th>
                </tr>
              </thead>
              <tbody>
                {data.categories.map((category) => (
                  <tr key={category.code}>
                    <th scope="row">
                      {category.name}
                      {category.soldOut ? <span className={styles.badge}>{t("register.soldOut")}</span> : null}
                    </th>
                    <td className={styles.num}>{t("event.km", { km: formatKm(category.distanceM, lang) })}</td>
                    <td className={styles.num}>{formatNumber(category.capacity, lang)}</td>
                    <td className={styles.num}>{formatTime(category.startAt, lang)}</td>
                    <td className={styles.num}>{formatTime(category.cutoffAt, lang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      )}
    </QueryState>
  );
}
```

`web/user/src/routes.tsx`：import 区加入

```tsx
import { OrderDetailPage } from "./pages/OrderDetailPage";
import { OrdersPage } from "./pages/OrdersPage";
import { RegisterPage } from "./pages/RegisterPage";
```

在 `RequireRunner` 布局路由的 `children` 中、`{ path: "profiles", element: <ProfilesPage /> },` 之后加入：

```tsx
          { path: "events/:slug/register", element: <RegisterPage /> },
          { path: "orders", element: <OrdersPage /> },
          { path: "orders/:orderNo", element: <OrderDetailPage /> },
```

`web/user/src/components/Layout.tsx`：在

```tsx
            <NavLink to="/events" className={navClass}>
              {t("common:nav.events")}
            </NavLink>
```

之后加入：

```tsx
            <NavLink to="/orders" className={navClass}>
              {t("orders.nav")}
            </NavLink>
```

- [ ] **Step 8: 运行前端测试，确认通过**

Run: `pnpm --filter @werun/user test src/pages src/register src/format.test.ts`
Expected: `RegisterPage.test.tsx`（8 个用例）、`OrdersPage.test.tsx`（2 个）、`OrderDetailPage.test.tsx`（5 个）、`EventDetailPage.test.tsx`（5 个）、`validate.test.ts`、`submissionKey.test.ts`、`format.test.ts` 全部通过。

Run: `for i in 1 2 3; do pnpm --filter @werun/user test src/pages/RegisterPage.test.tsx || exit 1; done`
Expected: 连续 3 次通过（幂等键重试与售罄回退用例不依赖时序）。

- [ ] **Step 9: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm i18n:check`
Expected: 全部通过。

Run: `pnpm --filter @werun/user build`
Expected: `tsc` 与 `vite build` 成功，输出 `web/user/dist`。

```bash
git add web/user/src packages/i18n/locales
git commit -m "$(cat <<'EOF'
feat(user): add registration wizard, my orders and order detail pages

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
)"
```
