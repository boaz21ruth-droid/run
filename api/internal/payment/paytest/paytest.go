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
	"werun/api/internal/notify/notifytest"
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
	runners := runner.NewService(pool, sessionSecret, BotToken, pii, clock.Now, runner.FixedOTPSender{}, runner.NewOTPLimiter(clock.Now))
	prices := pricing.NewService(pool, clock.Now)
	notifier := notifytest.New(t, pool)
	orders := registration.NewService(pool, runners, prices, notifier, clock.Now)
	return &Env{
		Pool:     pool,
		Store:    files,
		Clock:    clock,
		IAM:      iam.NewService(pool, sessionSecret, iam.NewLoginLimiter(time.Now), time.Now),
		Runners:  runners,
		Prices:   prices,
		Orders:   orders,
		Payments: payment.NewService(pool, files, orders, notifier, clock.Now),
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
