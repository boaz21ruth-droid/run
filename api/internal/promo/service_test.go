package promo_test

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/promo"
	"werun/api/internal/registration"
	"werun/api/internal/registration/regtest"
	"werun/api/internal/runner"
	fx "werun/api/internal/testfixture"
)

func codeOf(t *testing.T, err error) string {
	t.Helper()
	var ae *apperr.Error
	require.True(t, errors.As(err, &ae), "want apperr, got %v", err)
	return ae.Code
}

func order(t *testing.T, env *regtest.Env, u runner.User, idNo, coupon, referral string, runners int) (registration.OrderDetail, error) {
	t.Helper()
	parts := make([]registration.OrderParticipantInput, 0, runners)
	for i := range runners {
		p := fx.Profile("Promo Runner "+idNo, "PROMO"+idNo+string(rune('A'+i)), "US", "1990-01-01")
		parts = append(parts, registration.OrderParticipantInput{CategoryID: env.CategoryID, Profile: &p})
	}
	return env.Orders.CreateOrder(context.Background(), u, registration.CreateOrderInput{
		EventSlug:      regtest.EventSlug,
		CouponCode:     coupon,
		Referral:       referral,
		Consent:        env.Consent,
		Participants:   parts,
		IdempotencyKey: "promo-" + idNo,
	}, httpx.Meta{})
}

func TestReferralLinkFixedPriceAndAttribution(t *testing.T) {
	env := regtest.New(t)
	ctx := context.Background()
	svc := promo.NewService(env.Pool, env.Clock.Now)
	ops := env.NewStaff(t, iam.RoleOps, "promo-ops")

	// 档位 $25，推荐价 $18 固定
	link, err := svc.CreateReferralLink(ctx, ops, env.EventID, promo.ReferralLinkInput{
		Slug: " BKK ", Label: "BKK Runners", Kind: "CLUB",
		Offer: &promo.OfferInput{Code: "neak-bkk", Offer: promo.Offer{DiscountType: "PRICE", DiscountValue: 1800}, Quota: 50},
	})
	require.NoError(t, err)
	require.Equal(t, "bkk", link.Slug)
	require.NotNil(t, link.Coupon)
	require.Equal(t, "NEAK-BKK", link.Coupon.Code)

	_, err = svc.CreateReferralLink(ctx, ops, env.EventID, promo.ReferralLinkInput{Slug: "bkk", Label: "dup", Kind: "CLUB"})
	require.Equal(t, apperr.CodeReferralSlugTaken, codeOf(t, err))
	_, err = svc.CreateReferralLink(ctx, ops, env.EventID, promo.ReferralLinkInput{
		Slug: "bkk2", Label: "dup code", Kind: "CLUB",
		Offer: &promo.OfferInput{Code: "NEAK-BKK", Offer: promo.Offer{DiscountType: "PRICE", DiscountValue: 1800}, Quota: 5},
	})
	require.Equal(t, apperr.CodeCouponCodeTaken, codeOf(t, err))
	tg, err := svc.CreateReferralLink(ctx, ops, env.EventID, promo.ReferralLinkInput{Slug: "tg", Label: "Telegram 频道", Kind: "CHANNEL"})
	require.NoError(t, err)
	require.Nil(t, tg.Coupon)

	v, err := svc.VisitReferral(ctx, "bkk")
	require.NoError(t, err)
	require.Equal(t, regtest.EventSlug, v.EventSlug)
	require.Equal(t, "NEAK-BKK", *v.CouponCode)
	require.Equal(t, int64(1800), v.Offer.DiscountValue)
	_, err = svc.VisitReferral(ctx, "tg")
	require.NoError(t, err)
	_, err = svc.VisitReferral(ctx, "nope")
	require.Equal(t, apperr.CodeNotFound, codeOf(t, err))

	// 两人用推荐码：每人 $18（含识别分前）；来源 tg 但用了 bkk 的码，记到 bkk
	a := env.NewRunner(t, 91001, "en")
	d, err := order(t, env, a, "P1", "neak-bkk", "tg", 2)
	require.NoError(t, err)
	require.Equal(t, int64(2*regtest.PriceCents), d.ListAmountCents)
	require.Equal(t, int64(2*1800), d.AmountCents+d.IdentOffsetCents)

	// 只从 tg 进来、没用码
	b := env.NewRunner(t, 91002, "en")
	_, err = order(t, env, b, "P2", "", "TG", 1)
	require.NoError(t, err)
	// 直接来的
	c := env.NewRunner(t, 91003, "en")
	_, err = order(t, env, c, "P3", "", "", 1)
	require.NoError(t, err)
	// 无效来源不挡报名
	dd := env.NewRunner(t, 91004, "en")
	_, err = order(t, env, dd, "P4", "", "ghost", 1)
	require.NoError(t, err)

	st, err := svc.ListReferralLinks(ctx, env.EventID)
	require.NoError(t, err)
	require.Len(t, st.Links, 2)
	require.Equal(t, "bkk", st.Links[0].Slug)
	require.Equal(t, int64(1), st.Links[0].ClickCount)
	require.Equal(t, int32(1), st.Links[0].Orders)
	require.Equal(t, int32(1), st.Links[1].Orders)
	require.Equal(t, int32(0), st.Links[1].PaidOrders)
	require.Equal(t, int32(2), st.DirectOrders)
	require.Equal(t, int32(1), st.Links[0].Coupon.ReservedCount)

	// 停用：不再计点击、码也不能用
	_, err = svc.UpdateReferralLink(ctx, ops, link.ID, "BKK Runners", "DISABLED")
	require.NoError(t, err)
	_, err = svc.VisitReferral(ctx, "bkk")
	require.Equal(t, apperr.CodeNotFound, codeOf(t, err))
	e := env.NewRunner(t, 91005, "en")
	_, err = order(t, env, e, "P5", "NEAK-BKK", "", 1)
	require.Equal(t, apperr.CodeCouponInvalid, codeOf(t, err))
	require.Equal(t, 1, env.CountRows(t, `SELECT count(*) FROM audit_logs WHERE action = 'referral_link.update'`))
}

func TestCompRequestApproveIssuesPersonalFreeCode(t *testing.T) {
	env := regtest.New(t)
	ctx := context.Background()
	svc := promo.NewService(env.Pool, env.Clock.Now)
	ops := env.NewStaff(t, iam.RoleOps, "comp-ops")
	kol := env.NewRunner(t, 92001, "en")
	other := env.NewRunner(t, 92002, "en")
	in := promo.CompRequestInput{ApplicantName: "Sreyleak K.", Kind: "KOL", ProfileURL: "https://instagram.com/sreyleak", Audience: "Instagram 48k"}

	// 默认不开放
	st, err := svc.MyCompRequest(ctx, kol, regtest.EventSlug)
	require.NoError(t, err)
	require.False(t, st.Open)
	_, err = svc.CreateCompRequest(ctx, kol, regtest.EventSlug, in, httpx.Meta{})
	require.Equal(t, apperr.CodeCompClosed, codeOf(t, err))

	one := int32(1)
	_, err = svc.UpdateCompQuota(ctx, ops, env.EventID, &one)
	require.NoError(t, err)

	bad := in
	bad.ProfileURL = "javascript:alert(1)"
	_, err = svc.CreateCompRequest(ctx, kol, regtest.EventSlug, bad, httpx.Meta{})
	require.Equal(t, apperr.CodeValidation, codeOf(t, err))

	req, err := svc.CreateCompRequest(ctx, kol, regtest.EventSlug, in, httpx.Meta{})
	require.NoError(t, err)
	require.Equal(t, promo.CompPending, req.Status)
	_, err = svc.CreateCompRequest(ctx, kol, regtest.EventSlug, in, httpx.Meta{})
	require.Equal(t, apperr.CodeCompRequestExists, codeOf(t, err))
	otherReq, err := svc.CreateCompRequest(ctx, other, regtest.EventSlug,
		promo.CompRequestInput{ApplicantName: "Dara M.", Kind: "CLUB"}, httpx.Meta{})
	require.NoError(t, err)

	approved, err := svc.ApproveCompRequest(ctx, ops, req.ID)
	require.NoError(t, err)
	require.Equal(t, promo.CompApproved, approved.Status)
	require.Regexp(t, `^COMP-[0-9A-Z]{8}$`, *approved.CouponCode)
	_, err = svc.ApproveCompRequest(ctx, ops, req.ID)
	require.Equal(t, apperr.CodeCompRequestReviewed, codeOf(t, err))
	_, err = svc.ApproveCompRequest(ctx, ops, otherReq.ID)
	require.Equal(t, apperr.CodeCompQuotaFull, codeOf(t, err), "名额 1 已用完")
	zero := int32(0)
	_, err = svc.UpdateCompQuota(ctx, ops, env.EventID, &zero)
	require.Equal(t, apperr.CodeValidation, codeOf(t, err), "名额不能低于已批准人数")

	rejected, err := svc.RejectCompRequest(ctx, ops, otherReq.ID, "请走推荐码")
	require.NoError(t, err)
	require.Equal(t, "请走推荐码", *rejected.ReviewNote)

	code := *approved.CouponCode
	// 别人拿到码也用不了；本人一单两人也不行
	_, err = order(t, env, other, "C1", code, "", 1)
	require.Equal(t, apperr.CodeCouponInvalid, codeOf(t, err))
	_, err = order(t, env, kol, "C2", code, "", 2)
	require.Equal(t, apperr.CodeCouponInvalid, codeOf(t, err))
	d, err := order(t, env, kol, "C3", code, "", 1)
	require.NoError(t, err)
	require.Equal(t, int64(0), d.AmountCents)
	require.Equal(t, registration.StatusPaid, d.Status, "应付为 0 直接确认")

	list, err := svc.ListCompRequests(ctx, env.EventID)
	require.NoError(t, err)
	require.Equal(t, int32(1), list.Approved)
	require.Equal(t, int32(0), list.Pending)
	require.Len(t, list.Items, 2)
	var mine promo.CompRequest
	for _, it := range list.Items {
		if it.ID == req.ID {
			mine = it
		}
	}
	require.True(t, mine.CouponUsed)
	require.Equal(t, "runner92001", *mine.TelegramUsername)

	// 被拒后可以重新申请
	_, err = svc.CreateCompRequest(ctx, other, regtest.EventSlug,
		promo.CompRequestInput{ApplicantName: "Dara M.", Kind: "CLUB"}, httpx.Meta{})
	require.NoError(t, err)
	mineStatus, err := svc.MyCompRequest(ctx, kol, regtest.EventSlug)
	require.NoError(t, err)
	require.True(t, mineStatus.Open)
	require.Equal(t, code, *mineStatus.Request.CouponCode)
	require.Equal(t, 1, env.CountRows(t, `SELECT count(*) FROM audit_logs WHERE action = 'comp_request.approve'`))
}
