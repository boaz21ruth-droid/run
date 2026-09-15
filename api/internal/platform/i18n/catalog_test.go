package i18n

import (
	"testing"
	"testing/fstest"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
)

func mapFS(zh, en, km string) fstest.MapFS {
	return fstest.MapFS{
		"messages.zh.json": {Data: []byte(zh)},
		"messages.en.json": {Data: []byte(en)},
		"messages.km.json": {Data: []byte(km)},
	}
}

func TestLoadCatalogRejectsMismatchedKeys(t *testing.T) {
	fsys := mapFS(
		`{"A":"甲","B":"乙"}`,
		`{"A":"a","B":"b"}`,
		`{"A":"ក"}`,
	)

	_, err := loadCatalog(fsys)

	require.Error(t, err)
	assert.Contains(t, err.Error(), `km missing "B"`)
}

func TestTFallbackAndParams(t *testing.T) {
	cat, err := loadCatalog(mapFS(
		`{"greet":"你好 {name}","only_zh":"只有中文","empty_km":"中文"}`,
		`{"greet":"Hello {name}","only_zh":"","empty_km":"English"}`,
		`{"greet":"សួស្តី {name}","only_zh":"","empty_km":""}`,
	))
	require.NoError(t, err)

	assert.Equal(t, "Hello Dara", cat.T(EN, "greet", map[string]any{"name": "Dara"}))
	assert.Equal(t, "សួស្តី Dara", cat.T(KM, "greet", map[string]any{"name": "Dara"}))
	assert.Equal(t, "English", cat.T(KM, "empty_km", nil), "empty km falls back to en")
	assert.Equal(t, "只有中文", cat.T(KM, "only_zh", nil), "falls back to zh")
	assert.Equal(t, "no.such.key", cat.T(ZH, "no.such.key", nil), "unknown key returns key")
}

func TestEmbeddedCatalogCoversAllCodesAndFieldKeys(t *testing.T) {
	cat, err := LoadCatalog()
	require.NoError(t, err)

	keys := append([]string{}, apperr.AllCodes...)
	keys = append(keys,
		"field.required",
		"field.invalid",
		"field.too_long",
		"field.slug_format",
		"field.category_code_format",
		"field.must_be_positive",
		"field.cutoff_before_start",
		"field.category_incomplete",
		"field.too_young",
		"field.category_unavailable",
		"field.coupon_invalid",
		"field.event_not_published",
		"field.missing_price_rule",
		"field.missing_payment_account",
		"field.ends_before_starts",
		"field.quota_below_taken",
		"field.coupon_code_format",
		"field.percent_range",
	)
	for _, key := range keys {
		for _, l := range []Lang{ZH, EN, KM} {
			assert.NotEqual(t, key, cat.T(l, key, nil), "missing %s for %s", key, l)
		}
	}
	assert.Equal(t, "Must be at most 60 characters.", cat.T(EN, "field.too_long", map[string]any{"max": 60}))
	assert.Equal(t, "Must be at least 16 on race day.", cat.T(EN, "field.too_young", map[string]any{"minAge": 16}))
}
