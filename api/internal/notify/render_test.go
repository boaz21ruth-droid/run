package notify

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/i18n"
)

var allTemplates = []Template{
	TemplateProofApproved,
	TemplateProofRejected,
	TemplateDeadlineReminder,
	TemplateOrderExpired,
}

var allRejectCodes = []string{
	"NOT_RECEIVED", "AMOUNT_MISMATCH", "DUPLICATE_TXN", "UNREADABLE", "WRONG_ACCOUNT", "FRAUD", "OTHER",
}

var allLangs = []i18n.Lang{i18n.ZH, i18n.EN, i18n.KM}

func loadTestCatalog(t *testing.T) *i18n.Catalog {
	t.Helper()
	cat, err := i18n.LoadCatalog()
	require.NoError(t, err)
	return cat
}

func TestEveryTemplateRendersInAllLanguages(t *testing.T) {
	cat := loadTestCatalog(t)
	params := map[string]any{
		"orderNo":   "WR12345678",
		"eventName": i18n.Text{i18n.ZH: "金边城市跑", i18n.EN: "Phnom Penh City Run", i18n.KM: "ការរត់ទីក្រុងភ្នំពេញ"},
		"deadline":  "2026-09-15 10:00",
		"reason":    RejectReason{Code: "OTHER"},
	}

	for _, tpl := range allTemplates {
		key := "notify." + string(tpl)
		rendered := map[i18n.Lang]string{}
		for _, lang := range allLangs {
			text := render(cat, lang, tpl, params)
			require.NotEqual(t, key, text, "%s 缺少 %s", lang, key)
			require.Contains(t, text, "WR12345678", "%s %s 必须包含订单号", lang, key)
			require.NotContains(t, text, "{", "%s %s 有未替换的参数：%s", lang, key, text)
			require.NotContains(t, text, "}", "%s %s 有未替换的参数：%s", lang, key, text)
			rendered[lang] = text
		}
		require.NotEqual(t, rendered[i18n.ZH], rendered[i18n.EN], "%s 中英文不能相同", key)
		require.NotEqual(t, rendered[i18n.EN], rendered[i18n.KM], "%s 高棉文不能照抄英文", key)
	}
}

func TestRejectCodeAndButtonKeysExistInAllLanguages(t *testing.T) {
	cat := loadTestCatalog(t)
	keys := []string{"notify.open_order"}
	for _, code := range allRejectCodes {
		keys = append(keys, "notify.reject_code."+code)
	}
	for _, key := range keys {
		for _, lang := range allLangs {
			require.NotEqual(t, key, cat.T(lang, key, nil), "%s 缺少 %s", lang, key)
		}
	}
}

func TestRenderLocalizesTextAndRejectReason(t *testing.T) {
	cat := loadTestCatalog(t)
	note := "  Photo is blurry  "
	eventName := i18n.Text{i18n.ZH: "金边城市跑", i18n.EN: "Phnom Penh City Run", i18n.KM: "ការរត់ទីក្រុងភ្នំពេញ"}

	en := render(cat, i18n.EN, TemplateProofRejected, map[string]any{
		"orderNo":   "WR12345678",
		"eventName": eventName,
		"reason":    RejectReason{Code: "UNREADABLE", Note: &note},
		"deadline":  "2026-09-15 10:00",
	})
	require.Equal(t,
		"Payment proof not accepted\nEvent: Phnom Penh City Run\nOrder: WR12345678\nReason: Screenshot is unreadable\nPhoto is blurry\nPlease upload a new proof before 2026-09-15 10:00, otherwise the order will be cancelled automatically.",
		en)

	zh := render(cat, i18n.ZH, TemplateProofRejected, map[string]any{
		"orderNo":   "WR12345678",
		"eventName": eventName,
		"reason":    RejectReason{Code: "NOT_RECEIVED"},
		"deadline":  "2026-09-15 10:00",
	})
	require.Contains(t, zh, "赛事：金边城市跑\n")
	require.Contains(t, zh, "原因：未查到到账记录\n请在 2026-09-15 10:00 前")
}

func TestFormatTimeUsesEventTimezone(t *testing.T) {
	at := time.Date(2026, 9, 15, 3, 0, 0, 0, time.UTC)

	require.Equal(t, "2026-09-15 10:00", FormatTime(at, "Asia/Phnom_Penh"))
	require.Equal(t, "2026-09-15 03:00", FormatTime(at, "UTC"))
	require.Equal(t, "2026-09-15 10:00", FormatTime(at, ""), "空时区用 Asia/Phnom_Penh")
	require.Equal(t, "2026-09-15 10:00", FormatTime(at, "Not/AZone"), "无效时区用 Asia/Phnom_Penh")
}

func TestSendArgsKind(t *testing.T) {
	require.Equal(t, "notify_send", SendArgs{}.Kind())
	require.Equal(t, 5, SendMaxAttempts)
}
