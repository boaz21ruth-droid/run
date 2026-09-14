package jobs_test

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"werun/api/internal/jobs"
)

func TestDailyAtNext(t *testing.T) {
	phnomPenh, err := time.LoadLocation("Asia/Phnom_Penh")
	require.NoError(t, err)
	at3 := jobs.DailyAt{Hour: 3, Minute: 0, Loc: phnomPenh}

	cases := []struct {
		name    string
		sched   jobs.DailyAt
		current string
		want    string
	}{
		{"金边 02:59，排到当天 03:00", at3, "2026-09-13T19:59:00Z", "2026-09-13T20:00:00Z"},
		{"金边正好 03:00，排到第二天", at3, "2026-09-13T20:00:00Z", "2026-09-14T20:00:00Z"},
		{"金边 03:00:01，排到第二天", at3, "2026-09-13T20:00:01Z", "2026-09-14T20:00:00Z"},
		{"金边 23:30（UTC 仍是同一天），排到次日 03:00", at3, "2026-09-13T16:30:00Z", "2026-09-13T20:00:00Z"},
		{"月底跨月", at3, "2026-09-30T21:00:00Z", "2026-10-01T20:00:00Z"},
		{"年底跨年", at3, "2026-12-31T20:30:00Z", "2027-01-01T20:00:00Z"},
		{"Loc 为空时按 UTC", jobs.DailyAt{Hour: 3}, "2026-09-13T02:00:00Z", "2026-09-13T03:00:00Z"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			current, err := time.Parse(time.RFC3339, tc.current)
			require.NoError(t, err)
			want, err := time.Parse(time.RFC3339, tc.want)
			require.NoError(t, err)

			got := tc.sched.Next(current)

			require.Truef(t, got.Equal(want), "got %s, want %s", got.UTC().Format(time.RFC3339), tc.want)
			require.True(t, got.After(current), "Next 必须严格晚于 current")
		})
	}
}
