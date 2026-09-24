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

// TestPublicEventFromPriceRemainingAndCover 覆盖公开赛事的三个新字段：
// fromPriceCents 取当前在售价格档中的最低价（跳过未开售、已结束、配额用尽的档），
// remaining 反映容量减已确认与占用名额，coverUrl 在设置封面时指向公开文件地址。
func TestPublicEventFromPriceRemainingAndCover(t *testing.T) {
	env := newEventsEnv(t)
	ops := env.sessionCookie(t, iam.RoleOps, "ops.frompricehttp")
	ev := env.createPublishedEvent(t, ops)
	categoryID := ev.Categories[0].Id
	priceRulesPath := fmt.Sprintf("/api/admin/events/%d/price-rules", ev.Id)

	// 未开售：价格更低，但不应被选中。
	notYetOnSale := priceRuleBody(categoryID)
	notYetOnSale["priceCents"] = 1000
	notYetOnSale["saleStartsAt"] = "2099-01-01T00:00:00Z"
	notYetOnSale["saleEndsAt"] = nil
	rec := env.do(t, http.MethodPost, priceRulesPath, notYetOnSale, ops, adminClientHeader)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	// 已结束：价格更低，但不应被选中。
	ended := priceRuleBody(categoryID)
	ended["priceCents"] = 1200
	ended["saleStartsAt"] = "2020-01-01T00:00:00Z"
	ended["saleEndsAt"] = "2020-06-01T00:00:00Z"
	rec = env.do(t, http.MethodPost, priceRulesPath, ended, ops, adminClientHeader)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	// 配额已用尽：价格更低，但不应被选中。
	exhausted := priceRuleBody(categoryID)
	exhausted["priceCents"] = 1500
	exhausted["saleStartsAt"] = "2020-01-01T00:00:00Z"
	exhausted["saleEndsAt"] = nil
	exhausted["quota"] = 1
	rec = env.do(t, http.MethodPost, priceRulesPath, exhausted, ops, adminClientHeader)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	exhaustedRule := eventsDecode[apigen.PriceRule](t, rec)
	_, err := env.pool.Exec(t.Context(), `UPDATE price_rules SET used_count = 1 WHERE id = $1`, exhaustedRule.Id)
	require.NoError(t, err)

	// 在售：应作为最低可用价被选中。
	onSale := priceRuleBody(categoryID)
	onSale["priceCents"] = 2500
	onSale["saleStartsAt"] = "2020-01-01T00:00:00Z"
	onSale["saleEndsAt"] = nil
	onSale["quota"] = nil
	rec = env.do(t, http.MethodPost, priceRulesPath, onSale, ops, adminClientHeader)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	// 在售但更贵：不应被选中。
	pricierOnSale := priceRuleBody(categoryID)
	pricierOnSale["priceCents"] = 3000
	pricierOnSale["saleStartsAt"] = "2020-01-01T00:00:00Z"
	pricierOnSale["saleEndsAt"] = nil
	pricierOnSale["quota"] = nil
	rec = env.do(t, http.MethodPost, priceRulesPath, pricierOnSale, ops, adminClientHeader)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	// 占用部分名额，核对 remaining。
	_, err = env.pool.Exec(t.Context(),
		`UPDATE event_categories SET used_count = 2, reserved_count = 3 WHERE id = $1`, categoryID)
	require.NoError(t, err)

	// 设置封面图。
	var fileID int64
	require.NoError(t, env.pool.QueryRow(t.Context(),
		`INSERT INTO files (storage_key, visibility, purpose, mime_type, size_bytes, sha256, uploaded_by_type)
		 VALUES ('2026/09/cover.png', 'PUBLIC', 'EVENT_COVER', 'image/png', 10, '\x02', 'SYSTEM') RETURNING id`).Scan(&fileID))
	_, err = env.pool.Exec(t.Context(), `UPDATE events SET cover_file_id = $1 WHERE id = $2`, fileID, ev.Id)
	require.NoError(t, err)

	rec = env.do(t, http.MethodGet, fmt.Sprintf("/api/events/%s", ev.Slug), nil, nil, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	detail := eventsDecode[apigen.PublicEvent](t, rec)
	require.NotNil(t, detail.FromPriceCents)
	require.Equal(t, int64(2500), *detail.FromPriceCents, "应取在售价格档中最低者，跳过未开售/已结束/配额用尽")
	require.Equal(t, int32(800-2-3), detail.Categories[0].Remaining)
	require.NotNil(t, detail.CoverUrl)
	require.Equal(t, fmt.Sprintf("/api/files/%d", fileID), *detail.CoverUrl)

	rec = env.do(t, http.MethodGet, "/api/events", nil, nil, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	list := eventsDecode[apigen.PublicEventList](t, rec)
	require.Len(t, list.Items, 1)
	require.NotNil(t, list.Items[0].FromPriceCents)
	require.Equal(t, int64(2500), *list.Items[0].FromPriceCents)
	require.NotNil(t, list.Items[0].CoverUrl)
	require.Equal(t, fmt.Sprintf("/api/files/%d", fileID), *list.Items[0].CoverUrl)
}
