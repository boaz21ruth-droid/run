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
