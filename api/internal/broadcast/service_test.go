package broadcast_test

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/broadcast"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/registration"
	"werun/api/internal/registration/regtest"
	fx "werun/api/internal/testfixture"
)

func codeOf(t *testing.T, err error) string {
	t.Helper()
	var ae *apperr.Error
	require.True(t, errors.As(err, &ae), "want apperr, got %v", err)
	return ae.Code
}

func countOf(b broadcast.Board, audience string) int32 {
	for _, a := range b.Audiences {
		if a.Audience == audience {
			return a.Count
		}
	}
	return -1
}

func TestBroadcastToPaidRunners(t *testing.T) {
	e := regtest.New(t)
	ctx := context.Background()
	svc := broadcast.NewService(e.Pool, e.Notifier, e.Clock.Now)
	ops := e.NewStaff(t, iam.RoleOps, "broadcast-ops")
	fx.Coupon(t, e.Pool, fx.CouponOpts{Code: "FREEALL", EventID: &e.EventID, DiscountType: "WAIVER", Quota: 5})

	paid := e.NewRunner(t, 50001, "en")
	order := e.CreateOrder(t, paid, "BCAST0001", "FREEALL")
	require.Equal(t, registration.StatusPaid, order.Status)
	pending := e.NewRunner(t, 50002, "km")
	e.CreateOrder(t, pending, "BCAST0002", "")
	volunteer := e.NewRunner(t, 50003, "zh")
	e.Exec(t, `INSERT INTO volunteer_roles (event_id, name, capacity, assigned_count) VALUES ($1, '{"zh":"检录台"}', 5, 1)`, e.EventID)
	e.Exec(t, `INSERT INTO volunteer_applications (event_id, user_id, full_name, phone_e164, full_availability, role_ids, status, assigned_role_id)
		SELECT $1, $2, 'Vol', '+85512345678', true, ARRAY[id], 'ASSIGNED', id FROM volunteer_roles WHERE event_id = $1`, e.EventID, volunteer.ID)

	board, err := svc.Board(ctx, e.EventID)
	require.NoError(t, err)
	assert.Equal(t, int32(1), countOf(board, broadcast.AudiencePaid))
	assert.Equal(t, int32(1), countOf(board, broadcast.AudiencePending))
	assert.Equal(t, int32(0), countOf(board, broadcast.AudienceElite))
	assert.Equal(t, int32(1), countOf(board, broadcast.AudienceVolunteers))

	_, err = svc.Send(ctx, ops, e.EventID, "EVERYONE", " ")
	require.Equal(t, apperr.CodeValidation, codeOf(t, err))
	_, err = svc.Send(ctx, ops, e.EventID, broadcast.AudienceElite, "Elite briefing at 17:00")
	require.Equal(t, apperr.CodeBroadcastNoRecipients, codeOf(t, err))

	body := "  Race-pack pickup: 13–14 Nov, Aeon 1, 17:00–20:00. Bring your reference code.  "
	board, err = svc.Send(ctx, ops, e.EventID, broadcast.AudiencePaid, body)
	require.NoError(t, err)
	require.Len(t, board.Items, 1)
	assert.Equal(t, int32(1), board.Items[0].RecipientCount)
	assert.Equal(t, "Race-pack pickup: 13–14 Nov, Aeon 1, 17:00–20:00. Bring your reference code.", board.Items[0].Body)
	assert.Equal(t, 1, e.CountRows(t, `SELECT count(*) FROM notification_logs WHERE entity_type = 'event_broadcast' AND template = 'event_broadcast'`))
	text := e.QueryString(t, `SELECT args->>'text' FROM river_job WHERE kind = 'notify_send' ORDER BY id DESC LIMIT 1`)
	assert.Contains(t, text, "[Phnom Penh Half Marathon 2026] Message from the organizer")
	assert.Contains(t, text, "Bring your reference code.")
	assert.Equal(t, 1, e.CountRows(t, `SELECT count(*) FROM audit_logs WHERE action = 'broadcast.send'`))

	_, err = svc.Send(ctx, ops, e.EventID, broadcast.AudiencePaid, body)
	require.Equal(t, apperr.CodeBroadcastDuplicate, codeOf(t, err), "10 分钟内同一人群同一正文")

	notices, err := svc.Notices(ctx, paid)
	require.NoError(t, err)
	require.Len(t, notices, 1)
	assert.Equal(t, regtest.EventSlug, notices[0].EventSlug)
	assert.Equal(t, regtest.EventNameEN, notices[0].EventName[i18n.EN])
	notices, err = svc.Notices(ctx, pending)
	require.NoError(t, err)
	assert.Empty(t, notices, "不在这批人里看不到")
}
