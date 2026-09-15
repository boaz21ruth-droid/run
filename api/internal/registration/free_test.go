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

// requireFreeErr 断言错误码与状态码，返回错误的副本（值类型，便于读取 Fields，且不触发 errcheck）。
func requireFreeErr(t *testing.T, err error, code string, status int) apperr.Error {
	t.Helper()
	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	require.Equal(t, code, ae.Code)
	require.Equal(t, status, ae.Status)
	return *ae
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

// 服务端按跑者资料的同一套规则规范化后再入库：小写性别转大写（否则触发 DB CHECK 返回 500），手机号去空白与连字符。
func TestCreateFreeSignupStoresNormalizedContactFields(t *testing.T) {
	env := newFreeEnv(t)
	ctx := context.Background()
	u := env.login(t, 7010)
	_, categoryID := env.createEvent(t, freeOpen("riverside-normalize", 10))
	in := freeInput(categoryID, "Dara Sok", "+855 12-345-678")
	in.EmergencyPhone = " +855 98-765-432 "
	gender := "m"
	in.Gender = &gender

	fs, err := env.svc.CreateFreeSignup(ctx, u, "riverside-normalize", in, freeMeta)

	require.NoError(t, err)
	var phone, emergencyPhone, storedGender string
	require.NoError(t, env.pool.QueryRow(ctx,
		`SELECT phone_e164, emergency_phone, gender FROM free_signups WHERE id = $1`, fs.ID).
		Scan(&phone, &emergencyPhone, &storedGender))
	require.Equal(t, "+85512345678", phone)
	require.Equal(t, "+85598765432", emergencyPhone)
	require.Equal(t, "M", storedGender)
}

// 手机号写法不同（空格、连字符）不能绕过「同组别同手机号同姓名只能一条有效报名」。
func TestCreateFreeSignupDuplicateIgnoresPhoneFormatting(t *testing.T) {
	env := newFreeEnv(t)
	ctx := context.Background()
	u := env.login(t, 7011)
	_, categoryID := env.createEvent(t, freeOpen("riverside-dup-phone", 10))

	_, err := env.svc.CreateFreeSignup(ctx, u, "riverside-dup-phone", freeInput(categoryID, "Dara Sok", "+85512345678"), freeMeta)
	require.NoError(t, err)
	_, err = env.svc.CreateFreeSignup(ctx, u, "riverside-dup-phone", freeInput(categoryID, "Dara Sok", "+855 12-345-678"), freeMeta)

	requireFreeErr(t, err, apperr.CodeAlreadyRegistered, http.StatusConflict)
	require.Equal(t, 1, freeCount(t, env.pool, `SELECT count(*) FROM free_signups WHERE category_id = $1`, categoryID))
	require.Equal(t, 1, freeCount(t, env.pool, `SELECT used_count FROM event_categories WHERE id = $1`, categoryID))
}

func TestCreateFreeSignupTrimsSlug(t *testing.T) {
	env := newFreeEnv(t)
	u := env.login(t, 7012)
	_, categoryID := env.createEvent(t, freeOpen("riverside-slug", 10))

	fs, err := env.svc.CreateFreeSignup(context.Background(), u, " riverside-slug ", freeInput(categoryID, "Dara Sok", "+85512345678"), freeMeta)

	require.NoError(t, err)
	require.Equal(t, "riverside-slug", fs.EventSlug)
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
