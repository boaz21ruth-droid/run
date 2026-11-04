package httpapi_test

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"werun/api/internal/event"
	"werun/api/internal/httpapi"
	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/logx"
	"werun/api/internal/promo"
	"werun/api/internal/testfixture"
)

func TestPromoHTTPPermissionsAndPublicVisit(t *testing.T) {
	gin.SetMode(gin.TestMode)
	pool := dbtest.NewPool(t)
	catalog, err := i18n.LoadCatalog()
	require.NoError(t, err)
	iamSvc := iam.NewService(pool, []byte(strings.Repeat("k", 32)), iam.NewLoginLimiter(time.Now), time.Now)
	env := eventsEnv{router: httpapi.NewRouter(httpapi.RouterDeps{
		Log:     logx.New("error", io.Discard),
		Catalog: catalog,
		Pool:    pool,
		IAM:     iamSvc,
		Events:  event.NewService(pool),
		Promo:   promo.NewService(pool, time.Now),
		Env:     "dev",
	}), iam: iamSvc, catalog: catalog, pool: pool}

	ev := testfixture.RaceEvent(t, pool, testfixture.EventOpts{
		Slug: "promo-http", Categories: []testfixture.CategoryOpts{{Code: "10K", Capacity: 10}},
	})
	links := fmt.Sprintf("/api/admin/events/%d/referral-links", ev.ID)
	body := map[string]any{
		"slug": "bkk", "label": "BKK Runners", "kind": "CLUB",
		"offer": map[string]any{"code": "NEAK-BKK", "discountType": "PRICE", "discountValue": 1800, "quota": 50},
	}

	staff := env.sessionCookie(t, iam.RoleRaceStaff, "promo.staff")
	rec := env.do(t, http.MethodGet, links, nil, staff, nil)
	require.Equal(t, http.StatusForbidden, rec.Code, "现场人员看不到推广数据")

	support := env.sessionCookie(t, iam.RoleSupport, "promo.support")
	rec = env.do(t, http.MethodGet, links, nil, support, nil)
	require.Equal(t, http.StatusOK, rec.Code, "客服可以看")
	rec = env.do(t, http.MethodPost, links, body, support, adminClientHeader)
	require.Equal(t, http.StatusForbidden, rec.Code, "客服不能建推荐链接")

	ops := env.sessionCookie(t, iam.RoleOps, "promo.ops")
	rec = env.do(t, http.MethodPost, links, body, ops, adminClientHeader)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	link := eventsDecode[apigen.ReferralLink](t, rec)
	require.Equal(t, "NEAK-BKK", link.Coupon.Code)

	rec = env.do(t, http.MethodPost, "/api/referrals/bkk/visit", nil, nil, nil)
	require.Equal(t, http.StatusOK, rec.Code, "推荐链接公开可访问")
	visit := eventsDecode[apigen.ReferralVisit](t, rec)
	require.Equal(t, "promo-http", visit.EventSlug)
	require.Equal(t, "NEAK-BKK", *visit.CouponCode)
	require.Equal(t, apigen.DiscountTypePRICE, visit.Offer.DiscountType)

	rec = env.do(t, http.MethodGet, "/api/app/events/promo-http/comp-request", nil, nil, nil)
	require.Equal(t, http.StatusUnauthorized, rec.Code, "申请免费入场要先登录")

	rec = env.do(t, http.MethodPut, fmt.Sprintf("/api/admin/events/%d/comp-quota", ev.ID), map[string]any{"quota": 30}, support, adminClientHeader)
	require.Equal(t, http.StatusForbidden, rec.Code)
	rec = env.do(t, http.MethodPut, fmt.Sprintf("/api/admin/events/%d/comp-quota", ev.ID), map[string]any{"quota": 30}, ops, adminClientHeader)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, int32(30), *eventsDecode[apigen.CompRequestList](t, rec).Quota)

	rec = env.do(t, http.MethodGet, "/api/events/promo-http", nil, nil, nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.True(t, eventsDecode[apigen.PublicEvent](t, rec).CompOpen)
}
