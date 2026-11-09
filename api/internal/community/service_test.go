package community_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/community"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/registration/regtest"
	"werun/api/internal/runner"
)

func codeOf(t *testing.T, err error) string {
	t.Helper()
	var ae *apperr.Error
	require.True(t, errors.As(err, &ae), "want apperr, got %v", err)
	return ae.Code
}

func fieldsOf(t *testing.T, err error) map[string]string {
	t.Helper()
	var ae *apperr.Error
	require.True(t, errors.As(err, &ae), "want apperr, got %v", err)
	out := map[string]string{}
	for k, v := range ae.Fields {
		out[k] = v.Key
	}
	return out
}

type env struct {
	*regtest.Env
	svc     *community.Service
	ops     iam.Staff
	consent runner.ConsentAcceptance
}

func setup(t *testing.T) env {
	t.Helper()
	e := regtest.New(t)
	require.NoError(t, e.Runners.PublishConsent(context.Background(), runner.PublishConsentInput{
		Purpose: runner.PurposeCommunity, Version: "UGC-TEST-v1", Lang: "zh", EffectiveDate: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		FullText: "跑友活动免责声明", Items: []runner.ConsentItem{{Key: "safety", Title: "我自行承担参与风险"}},
	}))
	return env{
		Env: e, svc: community.NewService(e.Pool, e.Runners, e.Clock.Now), ops: e.NewStaff(t, iam.RoleOps, "community-ops"),
		consent: runner.ConsentAcceptance{Version: "UGC-TEST-v1", Lang: "zh", CheckedItems: []string{"safety"}},
	}
}

func (e env) input(capacity int32) community.CreateInput {
	return community.CreateInput{
		Title: "周三夜跑 · 滨河大道 8K", Tag: "night", StartsAt: e.Clock.Now().Add(48 * time.Hour), Location: "滨河大道",
		MeetPoint: "独立纪念碑北侧", DistanceText: "8K · 配速 6:00–6:30", Capacity: capacity, HostName: "BKK Runners",
		ContactTelegram: "@bkk_runners", ContactVisibility: "JOINED", Body: "一起夜跑，结束后喝椰子水。", Consent: e.consent,
	}
}

func TestCommunityCreateReviewJoinWaitlist(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	host := e.NewRunner(t, 40001, "zh")

	bad := e.input(0)
	bad.Title = ""
	bad.StartsAt = e.Clock.Now().Add(30 * time.Minute)
	bad.ContactTelegram = ""
	_, err := e.svc.Create(ctx, host, bad, httpx.Meta{})
	assert.Equal(t, map[string]string{
		"title": "field.required", "startsAt": "field.community_starts_soon", "capacity": "field.invalid",
		"contactTelegram": "field.community_contact_required",
	}, fieldsOf(t, err))
	noConsent := e.input(2)
	noConsent.Consent.CheckedItems = nil
	_, err = e.svc.Create(ctx, host, noConsent, httpx.Meta{})
	require.Equal(t, apperr.CodeConsentInvalid, codeOf(t, err))

	// 默认需要审核：先进审核，跑团页看不到
	a, err := e.svc.Create(ctx, host, e.input(2), httpx.Meta{})
	require.NoError(t, err)
	assert.Equal(t, community.StatusReviewing, a.Status)
	assert.Equal(t, "NIGHT", a.Tag)
	assert.Equal(t, "bkk_runners", *a.ContactTelegram, "去掉 @")
	feed, err := e.svc.Feed(ctx, "", "")
	require.NoError(t, err)
	assert.Empty(t, feed.Items)
	_, err = e.svc.GetPublic(ctx, a.ID)
	require.Equal(t, apperr.CodeNotFound, codeOf(t, err))
	mine, err := e.svc.Mine(ctx, host)
	require.NoError(t, err)
	require.Len(t, mine, 1)

	_, err = e.svc.Reject(ctx, e.ops, a.ID, "R99")
	assert.Equal(t, map[string]string{"code": "field.invalid"}, fieldsOf(t, err))
	_, err = e.svc.Approve(ctx, e.ops, a.ID)
	require.NoError(t, err)
	_, err = e.svc.Approve(ctx, e.ops, a.ID)
	require.Equal(t, apperr.CodeCommunityStateConflict, codeOf(t, err))

	// 容量 2：第三个人进候补；联系方式只给已参加的人
	dara, sophea, vuthy := e.NewRunner(t, 40002, "zh"), e.NewRunner(t, 40003, "en"), e.NewRunner(t, 40004, "km")
	v, err := e.svc.ViewFor(ctx, dara, a.ID, httpx.Meta{})
	require.NoError(t, err)
	assert.Nil(t, v.Contact, "没参加看不到联系方式")
	v, err = e.svc.Join(ctx, dara, a.ID, httpx.Meta{IP: "203.0.113.9"})
	require.NoError(t, err)
	assert.Equal(t, community.JoinJoined, v.MyStatus)
	require.NotNil(t, v.Contact)
	assert.Equal(t, "bkk_runners", *v.Contact.Telegram)
	assert.Equal(t, 1, e.CountRows(t, `SELECT count(*) FROM contact_view_logs WHERE viewer_joined`))
	_, err = e.svc.Join(ctx, dara, a.ID, httpx.Meta{})
	require.Equal(t, apperr.CodeCommunityStateConflict, codeOf(t, err))
	_, err = e.svc.Join(ctx, host, a.ID, httpx.Meta{})
	require.Equal(t, apperr.CodeCommunityStateConflict, codeOf(t, err), "发起人不用报名自己的活动")
	_, err = e.svc.Join(ctx, sophea, a.ID, httpx.Meta{})
	require.NoError(t, err)
	v, err = e.svc.Join(ctx, vuthy, a.ID, httpx.Meta{})
	require.NoError(t, err)
	assert.Equal(t, community.JoinWaitlist, v.MyStatus)
	assert.Equal(t, int32(2), v.Activity.JoinedCount)
	assert.Equal(t, int32(1), v.Activity.WaitlistCount)

	// 有人退出，候补的人自动补上
	v, err = e.svc.Leave(ctx, dara, a.ID, httpx.Meta{})
	require.NoError(t, err)
	assert.Equal(t, community.JoinNone, v.MyStatus)
	assert.Equal(t, int32(2), v.Activity.JoinedCount)
	assert.Equal(t, int32(0), v.Activity.WaitlistCount)
	v, err = e.svc.ViewFor(ctx, vuthy, a.ID, httpx.Meta{})
	require.NoError(t, err)
	assert.Equal(t, community.JoinJoined, v.MyStatus)

	feed, err = e.svc.Feed(ctx, community.KindClub, "")
	require.NoError(t, err)
	require.Len(t, feed.Items, 1)
	assert.Equal(t, "BKK Runners", feed.Items[0].HostName)
	assert.Len(t, feed.Items[0].JoinerInitials, 2)
	assert.Equal(t, []string{"Phnom Penh"}, feed.Cities)

	// 冻结：跑者看不到、不能报名；解冻恢复
	_, err = e.svc.Freeze(ctx, e.ops, a.ID, "  举报核实中 ")
	require.NoError(t, err)
	_, err = e.svc.Join(ctx, dara, a.ID, httpx.Meta{})
	require.Equal(t, apperr.CodeCommunityClosed, codeOf(t, err))
	_, err = e.svc.ViewFor(ctx, dara, a.ID, httpx.Meta{})
	require.Equal(t, apperr.CodeNotFound, codeOf(t, err))
	v, err = e.svc.ViewFor(ctx, host, a.ID, httpx.Meta{})
	require.NoError(t, err, "发起人仍能看到自己的活动")
	assert.True(t, v.Activity.Frozen)
	_, err = e.svc.Unfreeze(ctx, e.ops, a.ID)
	require.NoError(t, err)

	// 发起人取消；开始后不能再报名
	_, err = e.svc.Close(ctx, dara, a.ID, httpx.Meta{})
	require.Equal(t, apperr.CodeNotFound, codeOf(t, err), "不是发起人")
	b, err := e.svc.Create(ctx, host, e.input(5), httpx.Meta{})
	require.NoError(t, err)
	_, err = e.svc.Close(ctx, host, b.ID, httpx.Meta{})
	require.NoError(t, err)
	e.Clock.Advance(49 * time.Hour)
	_, err = e.svc.Join(ctx, dara, a.ID, httpx.Meta{})
	require.Equal(t, apperr.CodeCommunityClosed, codeOf(t, err))
}

func TestCommunityFeedOfficialAndCheckins(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	race := e.Clock.Now().AddDate(0, 0, 3).Format(time.DateOnly)
	e.Exec(t, `INSERT INTO events (slug, event_type, organizer_type, name, city, race_date, status, public_visible, published_at)
		VALUES ('sat-run', 'FREE_ACTIVITY', 'OFFICIAL', '{"zh":"周六晨跑 · 钻石岛","en":"Saturday run","km":"រត់ថ្ងៃសៅរ៍"}', 'Phnom Penh', $1, 'PUBLISHED', true, now())`, race)
	e.Exec(t, `INSERT INTO event_categories (event_id, code, name, distance_m, capacity, used_count)
		SELECT id, '5K', '{"zh":"5K"}', 5000, 100, 64 FROM events WHERE slug = 'sat-run'`)

	feed, err := e.svc.Feed(ctx, "", "")
	require.NoError(t, err)
	require.Len(t, feed.Items, 1)
	assert.Equal(t, community.KindOfficial, feed.Items[0].Kind)
	assert.Equal(t, "sat-run", *feed.Items[0].EventSlug)
	assert.Equal(t, int32(64), feed.Items[0].JoinedCount)
	assert.Equal(t, int32(100), feed.Items[0].Capacity)
	feed, err = e.svc.Feed(ctx, community.KindClub, "")
	require.NoError(t, err)
	assert.Empty(t, feed.Items)
	feed, err = e.svc.Feed(ctx, "", "Siem Reap")
	require.NoError(t, err)
	assert.Empty(t, feed.Items, "按城市筛选")

	dara := e.NewRunner(t, 40011, "zh")
	st, err := e.svc.CheckinState(ctx, dara)
	require.NoError(t, err)
	assert.False(t, st.CheckedIn)
	st, err = e.svc.Checkin(ctx, dara, "")
	require.NoError(t, err)
	assert.True(t, st.CheckedIn)
	require.Len(t, st.Checkins, 1)
	assert.Equal(t, "Runner", st.Checkins[0].Name)
	assert.Equal(t, "R4", st.Checkins[0].Initials)
	e.Clock.Advance(9 * time.Hour)
	st, err = e.svc.CheckinState(ctx, dara)
	require.NoError(t, err)
	assert.False(t, st.CheckedIn, "8 小时后过期")
	assert.Empty(t, st.Checkins)
	_, err = e.svc.Checkin(ctx, dara, "Phnom Penh")
	require.NoError(t, err)
	st, err = e.svc.Checkout(ctx, dara)
	require.NoError(t, err)
	assert.False(t, st.CheckedIn)
}
