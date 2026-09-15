package registration

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/runner"
)

func ptr[T any](v T) *T { return &v }

func validCreateInput() CreateOrderInput {
	return CreateOrderInput{
		EventSlug:      " pphm-2026 ",
		CouponCode:     " run20 ",
		IdempotencyKey: "0f8e1c2a-7b1d-4c55-9e0e-1a2b3c4d5e6f",
		Consent:        runner.ConsentAcceptance{Version: "REG-TEST-v1", Lang: "zh", CheckedItems: []string{"terms", "rules", "health"}},
		Participants: []OrderParticipantInput{
			{
				CategoryID: 11,
				Profile: &runner.ProfileData{
					FullName: "Chan Sophea", Gender: "F", BirthDate: time.Date(1990, 5, 1, 0, 0, 0, 0, time.UTC),
					Nationality: "kh", IDType: "PASSPORT", IDNo: "n0 1234-567", Phone: "+85512345678",
					EmergencyName: "Sok Dara", EmergencyPhone: "+85598765432", TShirtSize: "M",
				},
				SaveAsProfile: true,
			},
			{CategoryID: 11, ProfileID: ptr(int64(5)), SaveAsProfile: true},
		},
	}
}

func TestNormalizeCreateInputCleansValues(t *testing.T) {
	in := validCreateInput()

	out, err := normalizeCreateInput(in)

	require.NoError(t, err)
	require.Equal(t, "pphm-2026", out.EventSlug)
	require.Equal(t, "RUN20", out.CouponCode)
	require.Equal(t, []string{"health", "rules", "terms"}, out.Consent.CheckedItems)
	require.Equal(t, "N01234567", out.Participants[0].Profile.IDNo)
	require.Equal(t, "KH", out.Participants[0].Profile.Nationality)
	require.True(t, out.Participants[0].SaveAsProfile)
	require.Equal(t, int64(5), *out.Participants[1].ProfileID)
	require.False(t, out.Participants[1].SaveAsProfile, "选常用参赛人时 saveAsProfile 无意义，归一为 false")
	require.Equal(t, "n0 1234-567", in.Participants[0].Profile.IDNo, "不修改调用方的输入")
	require.Equal(t, []string{"terms", "rules", "health"}, in.Consent.CheckedItems)
}

func TestNormalizeCreateInputReportsFieldErrors(t *testing.T) {
	eleven := make([]OrderParticipantInput, 11)
	for i := range eleven {
		eleven[i] = OrderParticipantInput{CategoryID: 11, ProfileID: ptr(int64(i + 1))}
	}
	cases := []struct {
		name   string
		mutate func(in *CreateOrderInput)
		field  string
		key    string
	}{
		{"幂等键太短", func(in *CreateOrderInput) { in.IdempotencyKey = "short" }, "idempotencyKey", "field.invalid"},
		{"幂等键含空格", func(in *CreateOrderInput) { in.IdempotencyKey = "has space in it" }, "idempotencyKey", "field.invalid"},
		{"幂等键超过 64 位", func(in *CreateOrderInput) { in.IdempotencyKey = fmt.Sprintf("%065d", 0) }, "idempotencyKey", "field.invalid"},
		{"赛事为空", func(in *CreateOrderInput) { in.EventSlug = "  " }, "eventSlug", "field.required"},
		{"没有参赛人", func(in *CreateOrderInput) { in.Participants = nil }, "participants", "field.invalid"},
		{"超过 10 人", func(in *CreateOrderInput) { in.Participants = eleven }, "participants", "field.invalid"},
		{"缺组别", func(in *CreateOrderInput) { in.Participants[0].CategoryID = 0 }, "participants[0].categoryId", "field.required"},
		{"既没选常用参赛人也没填资料", func(in *CreateOrderInput) { in.Participants[1].ProfileID = nil }, "participants[1].profileId", "field.required"},
		{"同时给了两种", func(in *CreateOrderInput) {
			in.Participants[1].Profile = in.Participants[0].Profile
		}, "participants[1].profileId", "field.invalid"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := validCreateInput()
			tc.mutate(&in)

			_, err := normalizeCreateInput(in)

			ae, ok := apperr.As(err)
			require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
			require.Equal(t, apperr.CodeValidation, ae.Code)
			require.Equal(t, http.StatusUnprocessableEntity, ae.Status)
			require.Equal(t, tc.key, ae.Fields[tc.field].Key, "fields=%v", ae.Fields)
		})
	}

	t.Run("资料校验沿用 runner.ValidateProfile 并带参赛人前缀", func(t *testing.T) {
		in := validCreateInput()
		in.Participants[0].Profile.FullName = ""

		_, err := normalizeCreateInput(in)

		ae, ok := apperr.As(err)
		require.True(t, ok)
		require.Contains(t, ae.Fields, "participants[0].fullName")
	})
}

func TestRequestHashIgnoresKeyItemOrderAndFormatting(t *testing.T) {
	a := validCreateInput()
	b := validCreateInput()
	b.IdempotencyKey = "another-key-123"
	b.CouponCode = "RUN20"
	b.Consent.CheckedItems = []string{"health", "terms", "rules"}
	b.Participants[0].Profile.IDNo = "N01234567"
	c := validCreateInput()
	c.Participants[0].CategoryID = 12

	hash := func(in CreateOrderInput) []byte {
		t.Helper()
		norm, err := normalizeCreateInput(in)
		require.NoError(t, err)
		h, err := requestHash(norm)
		require.NoError(t, err)
		require.Len(t, h, 32)
		return h
	}

	require.Equal(t, hash(a), hash(b))
	require.NotEqual(t, hash(a), hash(c))
}

func TestRegistrationOpen(t *testing.T) {
	now := time.Date(2026, 9, 14, 3, 0, 0, 0, time.UTC)
	before := now.Add(-time.Minute)
	after := now.Add(time.Minute)
	cases := []struct {
		name      string
		status    string
		eventType string
		open      bool
		opensAt   *time.Time
		closesAt  *time.Time
		want      bool
	}{
		{"已发布、开放、不限时间", "PUBLISHED", "RACE", true, nil, nil, true},
		{"开关关闭", "PUBLISHED", "RACE", false, nil, nil, false},
		{"草稿", "DRAFT", "RACE", true, nil, nil, false},
		{"免费活动不走订单", "PUBLISHED", "FREE_ACTIVITY", true, nil, nil, false},
		{"尚未开始", "PUBLISHED", "RACE", true, &after, nil, false},
		{"开始时间等于现在", "PUBLISHED", "RACE", true, &now, nil, true},
		{"已截止", "PUBLISHED", "RACE", true, nil, &before, false},
		{"截止时间等于现在", "PUBLISHED", "RACE", true, nil, &now, false},
		{"时间窗内", "PUBLISHED", "RACE", true, &before, &after, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, registrationOpen(tc.status, tc.eventType, tc.open, tc.opensAt, tc.closesAt, now))
		})
	}
}

func TestOrderDetailAPIRoundTrip(t *testing.T) {
	zh, en, km := "金边半程马拉松 2026", "Phnom Penh Half Marathon 2026", "ម៉ារ៉ាតុងពាក់កណ្ដាលភ្នំពេញ ២០២៦"
	catZh, catEn, catKm := "21K 组", "21K run", "ការរត់ 21K"
	deadline := time.Date(2026, 9, 14, 3, 30, 0, 0, time.UTC)
	reviewed := time.Date(2026, 9, 14, 4, 0, 0, 0, time.UTC)
	reason := "截图看不清"
	ticket := "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
	original := apigen.OrderDetail{
		OrderNo:          "WR0A1B2C3D",
		Status:           apigen.OrderStatus("PROOF_REJECTED"),
		EventSlug:        "pphm-2026",
		EventName:        apigen.LocalizedText{Zh: &zh, En: &en, Km: &km},
		EventTimezone:    "Asia/Phnom_Penh",
		ListAmountCents:  5000,
		DiscountCents:    1001,
		IdentOffsetCents: 1,
		AmountCents:      3999,
		Currency:         "USD",
		DeadlineAt:       &deadline,
		CreatedAt:        deadline.Add(-30 * time.Minute),
		Participants: []apigen.OrderParticipant{
			{RegNo: "RG0A1B2C3D", CategoryId: 11, CategoryName: apigen.LocalizedText{Zh: &catZh, En: &catEn, Km: &catKm},
				FullName: "Chan Sophea", PriceRuleId: 7, ListPriceCents: 2500, PaidCents: 1999,
				RegistrationStatus: apigen.OrderParticipantRegistrationStatus("CONFIRMED"), TicketCode: &ticket},
		},
		PaymentAccount: apigen.OrderPaymentAccount{Id: 3, Name: "ABA USD 主收款户", Provider: "ABA", AccountName: "WERUN CO LTD", AccountNoMasked: "*** *** 123", QrFileId: 9},
		LastRejection:  &apigen.OrderRejection{Code: "UNREADABLE", Reason: &reason, ReviewedAt: reviewed},
	}

	require.Equal(t, original, toAPIOrderDetail(orderDetailFromAPI(original)))
}
