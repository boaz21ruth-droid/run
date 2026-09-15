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
	"werun/api/internal/notify/notifytest"
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
		Registration: registration.NewService(pool, runners, prices, notifytest.New(t, pool), time.Now),
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
	require.NotContains(t, first.Body.String(), "N01234567", "响应里不出现完整证件号")

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

func TestAppQuoteAndCreateOrderRejectParticipantCountHTTP(t *testing.T) {
	env := newOrderHTTPEnv(t)
	template := env.orderBody("N01234567")["participants"].([]map[string]any)[0]

	for _, n := range []int{0, 11} {
		t.Run(fmt.Sprintf("%d 人", n), func(t *testing.T) {
			quoteParts := make([]map[string]any, n)
			orderParts := make([]map[string]any, n)
			for i := range n {
				quoteParts[i] = map[string]any{"categoryId": env.event.CategoryIDs[0], "nationality": "KH", "birthDate": "1990-05-01"}
				orderParts[i] = template
			}

			rec := env.do(t, http.MethodPost, "/api/app/events/"+env.event.Slug+"/quote",
				map[string]any{"participants": quoteParts}, env.token, nil)
			require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
			quoteErr := eventsDecode[httpx.ErrorBody](t, rec)
			require.Equal(t, apperr.CodeValidation, quoteErr.Error.Code)
			require.Contains(t, quoteErr.Error.Fields, "participants")

			body := env.orderBody("N01234567")
			body["participants"] = orderParts
			rec = env.do(t, http.MethodPost, "/api/app/orders", body, env.token, idemHeader(fmt.Sprintf("count-key-%04d", n)))
			require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
			orderErr := eventsDecode[httpx.ErrorBody](t, rec)
			require.Equal(t, apperr.CodeValidation, orderErr.Error.Code)
			require.Contains(t, orderErr.Error.Fields, "participants")
		})
	}
	require.Equal(t, 0, fx.Count(t, env.pool, `SELECT count(*) FROM reg_orders`))
}

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
