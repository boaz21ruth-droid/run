package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"werun/api/internal/event"
	"werun/api/internal/httpapi"
	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/jobs"
	"werun/api/internal/notify"
	"werun/api/internal/payment"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/logx"
	"werun/api/internal/platform/piicrypt"
	"werun/api/internal/platform/storage"
	"werun/api/internal/pricing"
	"werun/api/internal/registration"
	"werun/api/internal/runner"
)

const (
	fshBotToken = "123456:free-signup-http"
	fshSlug     = "riverside-walk-http"
	fshVersion  = "REG-HTTP-v1"
)

type fshEnv struct {
	router     http.Handler
	catalog    *i18n.Catalog
	runners    *runner.Service
	categoryID int64
}

func newFreeSignupHTTPEnv(t *testing.T) fshEnv {
	t.Helper()
	gin.SetMode(gin.TestMode)
	ctx := context.Background()
	pool := dbtest.NewPool(t)
	now := time.Now

	catalog, err := i18n.LoadCatalog()
	require.NoError(t, err)
	pii, err := piicrypt.New(bytes.Repeat([]byte{9}, 32))
	require.NoError(t, err)
	inserter, err := jobs.NewInserter(pool)
	require.NoError(t, err)
	files, err := storage.NewDisk(t.TempDir())
	require.NoError(t, err)

	iamSvc := iam.NewService(pool, []byte(strings.Repeat("k", 32)), iam.NewLoginLimiter(time.Now), time.Now)
	events := event.NewService(pool)
	runners := runner.NewService(pool, []byte(strings.Repeat("k", 32)), fshBotToken, pii, now)
	prices := pricing.NewService(pool, now)
	notifier := notify.NewService(inserter, catalog, "http://werun.localhost")
	orders := registration.NewService(pool, runners, prices, notifier, now)
	payments := payment.NewService(pool, files, orders, notifier, now)

	router := httpapi.NewRouter(httpapi.RouterDeps{
		Log:          logx.New("error", io.Discard),
		Catalog:      catalog,
		Pool:         pool,
		IAM:          iamSvc,
		Events:       events,
		Runner:       runners,
		Pricing:      prices,
		Registration: orders,
		Payment:      payments,
		Notify:       notifier,
		Env:          "dev",
	})

	ops, err := iamSvc.CreateStaff(ctx, "ops.free.http", "Ops Free HTTP", iam.RoleOps, "Correct-Horse-Battery-9")
	require.NoError(t, err)
	start := time.Date(2026, 11, 14, 23, 0, 0, 0, time.UTC)
	cutoff := start.Add(2 * time.Hour)
	ev, err := events.Create(ctx, ops, event.CreateInput{
		Slug:          fshSlug,
		EventType:     event.TypeFreeActivity,
		OrganizerType: event.OrganizerOfficial,
		Name:          i18n.Text{i18n.ZH: "河畔健步走", i18n.EN: "Riverside Walk", i18n.KM: "ដើរលេងមាត់ទន្លេ"},
		City:          "Phnom Penh",
		RaceDate:      time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC),
		Categories: []event.CategoryInput{{
			Code:      "3K",
			Name:      i18n.Text{i18n.ZH: "健步走 3K", i18n.EN: "Walk 3K", i18n.KM: "ដើរ 3K"},
			DistanceM: 3000,
			Capacity:  50,
			StartAt:   &start,
			CutoffAt:  &cutoff,
		}},
	})
	require.NoError(t, err)
	_, err = events.Publish(ctx, ops, ev.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE events SET registration_open = true WHERE id = $1`, ev.ID)
	require.NoError(t, err)

	require.NoError(t, runners.PublishConsent(ctx, runner.PublishConsentInput{
		Purpose:       "REGISTRATION",
		Version:       fshVersion,
		Lang:          "en",
		EffectiveDate: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		FullText:      "Consent text.",
		Items: []runner.ConsentItem{
			{Key: "rules", Title: "Rules", Description: "Follow the rules"},
			{Key: "health", Title: "Health", Description: "Fit to take part"},
			{Key: "terms", Title: "Terms", Description: "Accept the terms"},
		},
	}))

	return fshEnv{router: router, catalog: catalog, runners: runners, categoryID: ev.Categories[0].ID}
}

func (e fshEnv) token(t *testing.T, telegramID int64) string {
	t.Helper()
	initData := runner.SignInitData(fshBotToken, runner.TelegramUser{ID: telegramID, FirstName: "Dara", LanguageCode: "en"}, time.Now())
	sess, err := e.runners.LoginTelegram(context.Background(), initData, httpx.Meta{IP: "127.0.0.1", UserAgent: "free-signup-http"})
	require.NoError(t, err)
	return sess.Token
}

func (e fshEnv) post(t *testing.T, body any, token, lang string) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	require.NoError(t, err)
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost,
		"/api/app/events/"+fshSlug+"/free-signups", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if lang != "" {
		req.Header.Set("Accept-Language", lang)
	}
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	return rec
}

func fshBody(categoryID int64, fullName string) map[string]any {
	return map[string]any{
		"categoryId":     categoryID,
		"fullName":       fullName,
		"phone":          "+85512345678",
		"emergencyName":  "Sok Chan",
		"emergencyPhone": "+85598765432",
		"consents": map[string]any{
			"version":      fshVersion,
			"lang":         "en",
			"checkedItems": []string{"rules", "health", "terms"},
		},
	}
}

func TestAppCreateFreeSignupCreatesThenRejectsDuplicate(t *testing.T) {
	env := newFreeSignupHTTPEnv(t)
	token := env.token(t, 8101)

	rec := env.post(t, fshBody(env.categoryID, "Dara Sok"), token, "en")
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	created := eventsDecode[apigen.FreeSignup](t, rec)
	require.Regexp(t, regexp.MustCompile(`^FS[0-9A-Z]{8}$`), created.SignupNo)
	require.Equal(t, fshSlug, created.EventSlug)
	require.Equal(t, env.categoryID, created.CategoryId)
	require.Equal(t, "Dara Sok", created.FullName)
	require.Equal(t, "REGISTERED", created.Status)

	rec = env.post(t, fshBody(env.categoryID, "dara sok"), token, "zh")
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	body := eventsDecode[httpx.ErrorBody](t, rec)
	require.Equal(t, apperr.CodeAlreadyRegistered, body.Error.Code)
	require.Equal(t, env.catalog.T(i18n.ZH, apperr.CodeAlreadyRegistered, nil), body.Error.Message)
	require.Contains(t, body.Error.Fields, "fullName")
}

func TestAppCreateFreeSignupRequiresRunnerToken(t *testing.T) {
	env := newFreeSignupHTTPEnv(t)

	rec := env.post(t, fshBody(env.categoryID, "Dara Sok"), "", "en")

	require.Equal(t, http.StatusUnauthorized, rec.Code, rec.Body.String())
	require.Equal(t, apperr.CodeUnauthenticated, eventsDecode[httpx.ErrorBody](t, rec).Error.Code)
}

func TestAppCreateFreeSignupReturnsFieldErrors(t *testing.T) {
	env := newFreeSignupHTTPEnv(t)
	token := env.token(t, 8102)

	rec := env.post(t, fshBody(env.categoryID, ""), token, "en")

	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	body := eventsDecode[httpx.ErrorBody](t, rec)
	require.Equal(t, apperr.CodeValidation, body.Error.Code)
	require.Contains(t, body.Error.Fields, "fullName")
}
