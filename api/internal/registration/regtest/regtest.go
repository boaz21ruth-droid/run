// Package regtest 为 registration、payment 等包的数据库测试搭建可下单的赛事环境：
// 已发布并开放报名的 RACE 赛事、一个组别、一个价格档、一个优惠码、一个收款账户、一版 REGISTRATION 同意书。
// 种子数据复用 internal/testfixture；只允许在 _test.go 中导入。
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
	"werun/api/internal/pricing"
	"werun/api/internal/registration"
	"werun/api/internal/runner"
	fx "werun/api/internal/testfixture"
)

const (
	BotToken       = fx.BotToken
	EventSlug      = "regtest-city-run"
	EventNameEN    = "Phnom Penh Half Marathon 2026" // testfixture.RaceEvent 的英文赛事名
	EventTimezone  = "Asia/Phnom_Penh"               // events.timezone 的默认值
	ConsentVersion = fx.ConsentVersion
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
	Consent          runner.ConsentAcceptance
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
	// 跑者登录校验 initData 的 auth_date，用真实时间，拨动 Clock 不影响登录。
	runners := fx.RunnerService(t, pool, time.Now)
	prices := pricing.NewService(pool, clock.Now)

	env := &Env{
		Pool:     pool,
		Clock:    clock,
		Runners:  runners,
		Pricing:  prices,
		Notifier: notifytest.New(t, pool),
		Orders:   registration.NewService(pool, runners, prices, clock.Now),
	}
	env.seed(t)
	return env
}

func (e *Env) seed(t testing.TB) {
	t.Helper()
	ev := fx.RaceEvent(t, e.Pool, fx.EventOpts{
		Slug:             EventSlug,
		RaceDate:         time.Date(e.Clock.Now().Year()+1, 1, 15, 0, 0, 0, 0, time.UTC),
		RegistrationOpen: true,
		Categories:       []fx.CategoryOpts{{Code: "10K", Capacity: 500}},
	})
	e.EventID = ev.ID
	e.CategoryID = ev.CategoryIDs[0]
	e.PriceRuleID = fx.PriceRule(t, e.Pool, ev.ID, fx.PriceRuleOpts{PriceCents: PriceCents, CategoryIDs: ev.CategoryIDs})
	e.CouponID = fx.Coupon(t, e.Pool, fx.CouponOpts{
		Code: CouponCode, EventID: &ev.ID, DiscountType: "AMOUNT", DiscountValue: 500, Quota: 100,
	})
	e.PaymentAccountID = fx.PaymentAccount(t, e.Pool, &ev.ID)
	e.Consent = fx.RegistrationConsent(t, e.Runners)
}

// NewRunner 用签名正确的 initData 登录一个跑者（lang 为 Telegram language_code，决定 users.locale）。
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
	profile := fx.Profile("Regtest Runner "+idNo, idNo, "US", "1990-01-01")
	detail, err := e.Orders.CreateOrder(context.Background(), u, registration.CreateOrderInput{
		EventSlug:      EventSlug,
		CouponCode:     couponCode,
		Consent:        e.Consent,
		Participants:   []registration.OrderParticipantInput{{CategoryID: e.CategoryID, Profile: &profile}},
		IdempotencyKey: "regtest-" + idNo,
	}, httpx.Meta{})
	require.NoError(t, err)
	return detail
}

// Counters 读取种子组别、价格档、优惠码的计数。
func (e *Env) Counters(t testing.TB) Counters {
	t.Helper()
	category := fx.CountersOf(t, e.Pool, "event_categories", e.CategoryID)
	rule := fx.CountersOf(t, e.Pool, "price_rules", e.PriceRuleID)
	coupon := fx.CountersOf(t, e.Pool, "coupons", e.CouponID)
	return Counters{
		CategoryUsed: int(category.Used), CategoryReserved: int(category.Reserved),
		RuleUsed: int(rule.Used), RuleReserved: int(rule.Reserved),
		CouponUsed: int(coupon.Used), CouponReserved: int(coupon.Reserved),
	}
}

// CountRows 执行返回单个计数的查询。
func (e *Env) CountRows(t testing.TB, sql string, args ...any) int {
	t.Helper()
	return fx.Count(t, e.Pool, sql, args...)
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
	fx.Exec(t, e.Pool, sql, args...)
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
