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
