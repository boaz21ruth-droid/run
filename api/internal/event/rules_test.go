package event_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/event"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/i18n"
)

func ptrInt32(v int32) *int32 { return &v }

func TestValidateRefundPolicy(t *testing.T) {
	ok := event.RefundPolicy{
		Tiers:        []event.RefundTier{{Days: 14, Percent: 80}, {Days: 7, Percent: 50}},
		TransferDays: ptrInt32(3),
	}
	require.NoError(t, event.ValidateRefundPolicy(ok))
	require.NoError(t, event.ValidateRefundPolicy(event.RefundPolicy{}), "一律不退、不接受转让")

	cases := map[string]struct {
		policy event.RefundPolicy
		fields map[string]string
	}{
		"days not descending": {
			event.RefundPolicy{Tiers: []event.RefundTier{{Days: 7, Percent: 50}, {Days: 14, Percent: 40}}},
			map[string]string{"tiers[1].days": "field.refund_tier_order"},
		},
		"refund rises near race day": {
			event.RefundPolicy{Tiers: []event.RefundTier{{Days: 14, Percent: 50}, {Days: 7, Percent: 80}}},
			map[string]string{"tiers[1].percent": "field.refund_tier_order"},
		},
		"out of range": {
			event.RefundPolicy{Tiers: []event.RefundTier{{Days: 400, Percent: 101}}, TransferDays: ptrInt32(-1)},
			map[string]string{"tiers[0].days": "field.invalid", "tiers[0].percent": "field.invalid", "transferDays": "field.invalid"},
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			assert.Equal(t, tc.fields, fieldKeys(t, event.ValidateRefundPolicy(tc.policy)))
		})
	}
}

// eliteEvent 建一场赛事：21K-E 精英组、21K 公开组、10K。
func eliteEvent(t *testing.T, svc *event.Service, actor iam.Staff) event.Event {
	t.Helper()
	in := validInput()
	name := func(s string) i18n.Text { return i18n.Text{i18n.ZH: s, i18n.EN: s, i18n.KM: s} }
	in.Categories = []event.CategoryInput{
		{Code: "21KE", Name: name("21K elite"), DistanceM: 21097, Capacity: 50},
		{Code: "21K", Name: name("21K open"), DistanceM: 21097, Capacity: 500},
		{Code: "10K", Name: name("10K"), DistanceM: 10000, Capacity: 500},
	}
	ev, err := svc.Create(context.Background(), actor, in)
	require.NoError(t, err)
	return ev
}

func TestUpdateRefundPolicyAndQualification(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := event.NewService(pool)
	actor := newActor(t, pool, iam.RoleOps, "ops.rules")
	ctx := context.Background()
	ev := eliteEvent(t, svc, actor)
	elite, open, tenK := ev.Categories[0], ev.Categories[1], ev.Categories[2]

	policy := &event.RefundPolicy{Tiers: []event.RefundTier{{Days: 14, Percent: 80}, {Days: 7, Percent: 50}}, TransferDays: ptrInt32(3)}
	got, err := svc.UpdateRefundPolicy(ctx, actor, ev.ID, policy)
	require.NoError(t, err)
	assert.Equal(t, policy, got.RefundPolicy)

	rule := i18n.Text{i18n.ZH: " 需近两年 21K 1:45 以内的官方成绩 ", i18n.EN: "Official 21K under 1:45", i18n.KM: "21K ក្រោម 1:45"}
	got, err = svc.UpdateQualification(ctx, actor, elite.ID, &event.Qualification{Rule: rule, MaxMs: ptrInt32(105 * 60 * 1000), FallbackCategoryID: open.ID})
	require.NoError(t, err)
	require.NotNil(t, got.Categories[0].Qualification)
	assert.Equal(t, "需近两年 21K 1:45 以内的官方成绩", got.Categories[0].Qualification.Rule[i18n.ZH], "说明去掉首尾空白")
	assert.Equal(t, open.ID, got.Categories[0].Qualification.FallbackCategoryID)
	assert.Nil(t, got.Categories[1].Qualification)
	assert.Equal(t, 2, countRows(t, pool,
		`SELECT count(*) FROM audit_logs WHERE action IN ('event.refund_policy_update', 'event.category_qualification_update') AND event_id = $1`, ev.ID))

	// 去处不能是自己、别的赛事的组别，也不能本身要求资格；被当作去处的组别不能再设为精英组
	other := validInput()
	other.Slug = "other-run"
	otherEv, err := svc.Create(ctx, actor, other)
	require.NoError(t, err)
	for name, tc := range map[string]struct {
		category, fallback int64
		key                string
	}{
		"self":          {elite.ID, elite.ID, "field.invalid"},
		"other event":   {tenK.ID, otherEv.Categories[0].ID, "field.invalid"},
		"elite as dest": {tenK.ID, elite.ID, "field.fallback_chain"},
		"dest as elite": {open.ID, tenK.ID, "field.fallback_chain"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := svc.UpdateQualification(ctx, actor, tc.category, &event.Qualification{Rule: rule, FallbackCategoryID: tc.fallback})
			assert.Equal(t, map[string]string{"fallbackCategoryId": tc.key}, fieldKeys(t, err))
		})
	}
	_, err = svc.UpdateQualification(ctx, actor, elite.ID, &event.Qualification{Rule: i18n.Text{i18n.ZH: "x"}, FallbackCategoryID: open.ID})
	assert.Equal(t, map[string]string{"rule.en": "field.required", "rule.km": "field.required"}, fieldKeys(t, err))
	_, err = svc.UpdateQualification(ctx, actor, 999999, nil)
	ae, ok := apperr.As(err)
	require.True(t, ok)
	assert.Equal(t, http.StatusNotFound, ae.Status)

	// 取消资格要求与退改政策
	got, err = svc.UpdateQualification(ctx, actor, elite.ID, nil)
	require.NoError(t, err)
	assert.Nil(t, got.Categories[0].Qualification)
	got, err = svc.UpdateRefundPolicy(ctx, actor, ev.ID, nil)
	require.NoError(t, err)
	assert.Nil(t, got.RefundPolicy)
}
