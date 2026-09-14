package httpapi_test

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
)

func priceRuleBody(categoryIDs ...int64) map[string]any {
	return map[string]any{
		"name":         map[string]string{"zh": "早鸟价", "en": "Early bird", "km": "តម្លៃទិញមុន"},
		"audience":     "ALL",
		"priceCents":   2500,
		"quota":        100,
		"saleStartsAt": "2026-09-20T00:00:00+07:00",
		"saleEndsAt":   nil,
		"sortOrder":    1,
		"categoryIds":  categoryIDs,
	}
}

func TestPriceRulesHTTP(t *testing.T) {
	env := newEventsEnv(t)
	ops := env.sessionCookie(t, iam.RoleOps, "ops.pricehttp")
	finance := env.sessionCookie(t, iam.RoleFinance, "finance.pricehttp")
	support := env.sessionCookie(t, iam.RoleSupport, "support.pricehttp")
	ev := env.createPublishedEvent(t, ops)
	listPath := fmt.Sprintf("/api/admin/events/%d/price-rules", ev.Id)
	categoryID := ev.Categories[0].Id

	rec := env.do(t, http.MethodPost, listPath, priceRuleBody(categoryID), finance, adminClientHeader)
	require.Equal(t, http.StatusForbidden, rec.Code, "FINANCE 对 price_config 只读")

	rec = env.do(t, http.MethodPost, listPath, priceRuleBody(categoryID), ops, adminClientHeader)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	created := eventsDecode[apigen.PriceRule](t, rec)
	require.Equal(t, int64(2500), created.PriceCents)
	require.Equal(t, "USD", created.Currency)
	require.Equal(t, []int64{categoryID}, created.CategoryIds)
	require.Equal(t, int32(100), *created.Quota)
	require.Nil(t, created.SaleEndsAt)

	rec = env.do(t, http.MethodGet, listPath, nil, finance, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	list := eventsDecode[apigen.PriceRuleList](t, rec)
	require.Len(t, list.Items, 1)
	require.Equal(t, "Early bird", *list.Items[0].Name.En)

	rec = env.do(t, http.MethodGet, listPath, nil, support, nil)
	require.Equal(t, http.StatusForbidden, rec.Code, "SUPPORT 没有 price_config")

	invalid := priceRuleBody()
	invalid["priceCents"] = -1
	rec = env.do(t, http.MethodPost, listPath, invalid, ops, adminClientHeader)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	fields := eventsDecode[httpx.ErrorBody](t, rec).Error.Fields
	require.Contains(t, fields, "priceCents")
	require.Contains(t, fields, "categoryIds")

	tooBigSort := priceRuleBody(categoryID)
	tooBigSort["sortOrder"] = 40000
	rec = env.do(t, http.MethodPost, listPath, tooBigSort, ops, adminClientHeader)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	require.Contains(t, eventsDecode[httpx.ErrorBody](t, rec).Error.Fields, "sortOrder")

	updatePath := fmt.Sprintf("/api/admin/price-rules/%d", created.Id)
	changed := priceRuleBody(categoryID)
	changed["priceCents"] = 2200
	rec = env.do(t, http.MethodPut, updatePath, changed, ops, adminClientHeader)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, int64(2200), eventsDecode[apigen.PriceRule](t, rec).PriceCents)

	_, err := env.pool.Exec(t.Context(), `UPDATE price_rules SET reserved_count = 1 WHERE id = $1`, created.Id)
	require.NoError(t, err)
	changed["priceCents"] = 2000
	rec = env.do(t, http.MethodPut, updatePath, changed, ops, adminClientHeader)
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	require.Equal(t, apperr.CodePriceRuleLocked, eventsDecode[httpx.ErrorBody](t, rec).Error.Code)

	rec = env.do(t, http.MethodPut, "/api/admin/price-rules/999999", priceRuleBody(categoryID), ops, adminClientHeader)
	require.Equal(t, http.StatusNotFound, rec.Code)
}
