package event_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"werun/api/internal/event"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/i18n"
)

func ptrTime(s string) *time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return &t
}

func validInput() event.CreateInput {
	return event.CreateInput{
		Slug:          "pphm-2026",
		EventType:     event.TypeRace,
		OrganizerType: event.OrganizerOfficial,
		Name: i18n.Text{
			i18n.ZH: "金边半程马拉松 2026",
			i18n.EN: "Phnom Penh Half Marathon 2026",
			i18n.KM: "ម៉ារ៉ាតុងពាក់កណ្ដាលភ្នំពេញ ២០២៦",
		},
		City:     "Phnom Penh",
		RaceDate: time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC),
		Categories: []event.CategoryInput{{
			Code: "21K",
			Name: i18n.Text{
				i18n.ZH: "半程 21K",
				i18n.EN: "Half Marathon 21K",
				i18n.KM: "ពាក់កណ្ដាលម៉ារ៉ាតុង 21K",
			},
			DistanceM: 21097,
			Capacity:  800,
			StartAt:   ptrTime("2026-11-15T06:00:00+07:00"),
			CutoffAt:  ptrTime("2026-11-15T09:30:00+07:00"),
		}},
	}
}

// fieldKeys 取出 *apperr.Error 的"字段 → 文案 key"。
func fieldKeys(t *testing.T, err error) map[string]string {
	t.Helper()
	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	out := make(map[string]string, len(ae.Fields))
	for field, fe := range ae.Fields {
		out[field] = fe.Key
	}
	return out
}

func TestValidateCreateAcceptsValidInput(t *testing.T) {
	require.NoError(t, event.ValidateCreate(validInput()))
}

func TestValidateCreateAllowsCategoryWithoutTimes(t *testing.T) {
	in := validInput()
	in.Categories[0].StartAt = nil
	in.Categories[0].CutoffAt = nil
	require.NoError(t, event.ValidateCreate(in))
}

func TestValidateCreateRejectsInvalidInput(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(in *event.CreateInput)
		field  string
		key    string
	}{
		{"slug 为空", func(in *event.CreateInput) { in.Slug = "" }, "slug", "field.required"},
		{"slug 超过 60 个字符", func(in *event.CreateInput) { in.Slug = strings.Repeat("a", 61) }, "slug", "field.too_long"},
		{"slug 含大写字母", func(in *event.CreateInput) { in.Slug = "PPHM-2026" }, "slug", "field.slug_format"},
		{"slug 以连字符结尾", func(in *event.CreateInput) { in.Slug = "pphm-" }, "slug", "field.slug_format"},
		{"eventType 不在枚举内", func(in *event.CreateInput) { in.EventType = "MARATHON" }, "eventType", "field.invalid"},
		{"organizerType 不在枚举内", func(in *event.CreateInput) { in.OrganizerType = "SPONSOR" }, "organizerType", "field.invalid"},
		{"缺高棉文名称", func(in *event.CreateInput) { delete(in.Name, i18n.KM) }, "name.km", "field.required"},
		{"中文名称只有空格", func(in *event.CreateInput) { in.Name[i18n.ZH] = "   " }, "name.zh", "field.required"},
		{"city 为空", func(in *event.CreateInput) { in.City = "" }, "city", "field.required"},
		{"raceDate 为零值", func(in *event.CreateInput) { in.RaceDate = time.Time{} }, "raceDate", "field.required"},
		{"组别代码含小写", func(in *event.CreateInput) { in.Categories[0].Code = "21k" }, "categories[0].code", "field.category_code_format"},
		{"组别缺英文名称", func(in *event.CreateInput) { delete(in.Categories[0].Name, i18n.EN) }, "categories[0].name.en", "field.required"},
		{"距离为 0", func(in *event.CreateInput) { in.Categories[0].DistanceM = 0 }, "categories[0].distanceM", "field.must_be_positive"},
		{"名额为 0", func(in *event.CreateInput) { in.Categories[0].Capacity = 0 }, "categories[0].capacity", "field.must_be_positive"},
		{"关门时间早于发枪时间", func(in *event.CreateInput) {
			in.Categories[0].CutoffAt = ptrTime("2026-11-15T05:00:00+07:00")
		}, "categories[0].cutoffAt", "field.cutoff_before_start"},
		{"同一请求内组别代码重复", func(in *event.CreateInput) {
			in.Categories = append(in.Categories, in.Categories[0])
		}, "categories[1].code", apperr.CodeEventCategoryCodeTaken},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := validInput()
			tc.mutate(&in)

			err := event.ValidateCreate(in)

			require.Error(t, err)
			ae, ok := apperr.As(err)
			require.True(t, ok)
			require.Equal(t, apperr.CodeValidation, ae.Code)
			require.Equal(t, http.StatusUnprocessableEntity, ae.Status)
			require.Equal(t, tc.key, fieldKeys(t, err)[tc.field], "fields=%v", fieldKeys(t, err))
		})
	}
}

func publishable() event.Event {
	return event.Event{
		ID:     1,
		Slug:   "pphm-2026",
		Status: event.StatusDraft,
		Categories: []event.Category{{
			Code:     "21K",
			Capacity: 800,
			StartAt:  ptrTime("2026-11-15T06:00:00+07:00"),
			CutoffAt: ptrTime("2026-11-15T09:30:00+07:00"),
		}},
	}
}

func TestValidateForPublish(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(e *event.Event)
		code    string
		status  int
		missing string
	}{
		{"完整的草稿可以发布", func(e *event.Event) {}, "", 0, ""},
		{"已经发布", func(e *event.Event) { e.Status = event.StatusPublished }, apperr.CodeEventAlreadyPublished, http.StatusConflict, ""},
		{"没有组别", func(e *event.Event) { e.Categories = nil }, apperr.CodeEventNoCategory, http.StatusUnprocessableEntity, ""},
		{"缺发枪与关门时间", func(e *event.Event) {
			e.Categories[0].StartAt = nil
			e.Categories[0].CutoffAt = nil
		}, apperr.CodeEventCategoryIncomplete, http.StatusUnprocessableEntity, "21K: start_at, cutoff_at"},
		{"名额为 0", func(e *event.Event) { e.Categories[0].Capacity = 0 }, apperr.CodeEventCategoryIncomplete, http.StatusUnprocessableEntity, "21K: capacity"},
		{"关门时间早于发枪时间", func(e *event.Event) {
			e.Categories[0].CutoffAt = ptrTime("2026-11-15T05:00:00+07:00")
		}, apperr.CodeEventCategoryIncomplete, http.StatusUnprocessableEntity, "21K: cutoff_before_start"},
		{"多个组别不完整", func(e *event.Event) {
			e.Categories[0].StartAt = nil
			e.Categories = append(e.Categories, event.Category{Code: "10K", Capacity: 1200})
		}, apperr.CodeEventCategoryIncomplete, http.StatusUnprocessableEntity, "21K: start_at; 10K: start_at, cutoff_at"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := publishable()
			tc.mutate(&e)

			err := event.ValidateForPublish(e)

			if tc.code == "" {
				require.NoError(t, err)
				return
			}
			ae, ok := apperr.As(err)
			require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
			require.Equal(t, tc.code, ae.Code)
			require.Equal(t, tc.status, ae.Status)
			if tc.missing != "" {
				require.Equal(t, "field.category_incomplete", ae.Fields["categories"].Key)
				require.Equal(t, tc.missing, ae.Fields["categories"].Params["missing"])
			}
		})
	}
}
