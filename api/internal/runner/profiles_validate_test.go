package runner_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/runner"
)

// fieldKeys 取出 *apperr.Error 的“字段 → 文案 key”。
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

// validProfile 是一份合法但未规范化的原始输入。
func validProfile() runner.ProfileData {
	return runner.ProfileData{
		FullName:       "  Sok Dara ",
		Gender:         "m",
		BirthDate:      time.Date(1990, 5, 1, 0, 0, 0, 0, time.UTC),
		Nationality:    "kh",
		IDType:         "NATIONAL_ID",
		IDNo:           "n0 1234-5678",
		Phone:          "+855 12 345 678",
		Email:          " dara@example.com ",
		EmergencyName:  "Sok Chenda",
		EmergencyPhone: "+85598765432",
		TShirtSize:     "m",
	}
}

func TestValidateProfileAcceptsValidInput(t *testing.T) {
	require.NoError(t, runner.ValidateProfile(validProfile(), "participants[1]."))
}

func TestValidateProfileFieldRules(t *testing.T) {
	const prefix = "participants[1]."
	future := time.Now().UTC().AddDate(0, 0, 2)
	cases := []struct {
		name   string
		mutate func(p *runner.ProfileData)
		want   map[string]string
	}{
		{"blank full name", func(p *runner.ProfileData) { p.FullName = "   " }, map[string]string{prefix + "fullName": "field.required"}},
		{"full name too long", func(p *runner.ProfileData) { p.FullName = strings.Repeat("a", 101) }, map[string]string{prefix + "fullName": "field.invalid"}},
		{"khmer full name of 100 runes", func(p *runner.ProfileData) { p.FullName = strings.Repeat("ក", 100) }, nil},
		{"missing gender", func(p *runner.ProfileData) { p.Gender = "" }, map[string]string{prefix + "gender": "field.required"}},
		{"unknown gender", func(p *runner.ProfileData) { p.Gender = "Z" }, map[string]string{prefix + "gender": "field.invalid"}},
		{"lowercase gender", func(p *runner.ProfileData) { p.Gender = "f" }, nil},
		{"missing birth date", func(p *runner.ProfileData) { p.BirthDate = time.Time{} }, map[string]string{prefix + "birthDate": "field.required"}},
		{"birth date before 1900", func(p *runner.ProfileData) { p.BirthDate = time.Date(1899, 12, 31, 0, 0, 0, 0, time.UTC) }, map[string]string{prefix + "birthDate": "field.invalid"}},
		{"birth date on 1900-01-01", func(p *runner.ProfileData) { p.BirthDate = time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC) }, nil},
		{"birth date in the future", func(p *runner.ProfileData) { p.BirthDate = future }, map[string]string{prefix + "birthDate": "field.invalid"}},
		{"missing nationality", func(p *runner.ProfileData) { p.Nationality = "" }, map[string]string{prefix + "nationality": "field.required"}},
		{"three letter nationality", func(p *runner.ProfileData) { p.Nationality = "KHM" }, map[string]string{prefix + "nationality": "field.invalid"}},
		{"nationality with digit", func(p *runner.ProfileData) { p.Nationality = "K1" }, map[string]string{prefix + "nationality": "field.invalid"}},
		{"missing id type", func(p *runner.ProfileData) { p.IDType = "" }, map[string]string{prefix + "idType": "field.required"}},
		{"unknown id type", func(p *runner.ProfileData) { p.IDType = "DRIVER_LICENSE" }, map[string]string{prefix + "idType": "field.invalid"}},
		{"lowercase id type", func(p *runner.ProfileData) { p.IDType = "passport" }, nil},
		{"missing id number", func(p *runner.ProfileData) { p.IDNo = " - " }, map[string]string{prefix + "idNo": "field.required"}},
		{"id number too short", func(p *runner.ProfileData) { p.IDNo = "12-3" }, map[string]string{prefix + "idNo": "field.invalid"}},
		{"id number too long", func(p *runner.ProfileData) { p.IDNo = strings.Repeat("A", 33) }, map[string]string{prefix + "idNo": "field.invalid"}},
		{"id number with symbol", func(p *runner.ProfileData) { p.IDNo = "AB#1234" }, map[string]string{prefix + "idNo": "field.invalid"}},
		{"id number with spaces and hyphens", func(p *runner.ProfileData) { p.IDNo = "ab 12-34" }, nil},
		{"missing phone", func(p *runner.ProfileData) { p.Phone = "" }, map[string]string{prefix + "phone": "field.required"}},
		{"phone without plus", func(p *runner.ProfileData) { p.Phone = "012345678" }, map[string]string{prefix + "phone": "field.invalid"}},
		{"phone starting with zero", func(p *runner.ProfileData) { p.Phone = "+0123456789" }, map[string]string{prefix + "phone": "field.invalid"}},
		{"phone too short", func(p *runner.ProfileData) { p.Phone = "+8551234" }, map[string]string{prefix + "phone": "field.invalid"}},
		{"phone too long", func(p *runner.ProfileData) { p.Phone = "+1234567890123456" }, map[string]string{prefix + "phone": "field.invalid"}},
		{"empty email", func(p *runner.ProfileData) { p.Email = "  " }, nil},
		{"email without domain dot", func(p *runner.ProfileData) { p.Email = "dara@example" }, map[string]string{prefix + "email": "field.invalid"}},
		{"email with display name", func(p *runner.ProfileData) { p.Email = "Dara <dara@example.com>" }, map[string]string{prefix + "email": "field.invalid"}},
		{"email too long", func(p *runner.ProfileData) { p.Email = strings.Repeat("a", 250) + "@example.com" }, map[string]string{prefix + "email": "field.invalid"}},
		{"missing emergency name", func(p *runner.ProfileData) { p.EmergencyName = "" }, map[string]string{prefix + "emergencyName": "field.required"}},
		{"emergency name too long", func(p *runner.ProfileData) { p.EmergencyName = strings.Repeat("b", 101) }, map[string]string{prefix + "emergencyName": "field.invalid"}},
		{"invalid emergency phone", func(p *runner.ProfileData) { p.EmergencyPhone = "12345" }, map[string]string{prefix + "emergencyPhone": "field.invalid"}},
		{"unknown tshirt size", func(p *runner.ProfileData) { p.TShirtSize = "XXXL" }, map[string]string{prefix + "tshirtSize": "field.invalid"}},
		{"lowercase tshirt size", func(p *runner.ProfileData) { p.TShirtSize = "xl" }, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := validProfile()
			tc.mutate(&p)

			err := runner.ValidateProfile(p, prefix)

			if tc.want == nil {
				require.NoError(t, err)
				return
			}
			requireAppError(t, err, http.StatusUnprocessableEntity, apperr.CodeValidation)
			assert.Equal(t, tc.want, fieldKeys(t, err))
		})
	}
}

func TestValidateProfileReportsEveryMissingField(t *testing.T) {
	err := runner.ValidateProfile(runner.ProfileData{}, "")

	assert.Equal(t, map[string]string{
		"fullName":       "field.required",
		"gender":         "field.required",
		"birthDate":      "field.required",
		"nationality":    "field.required",
		"idType":         "field.required",
		"idNo":           "field.required",
		"phone":          "field.required",
		"emergencyName":  "field.required",
		"emergencyPhone": "field.required",
		"tshirtSize":     "field.required",
	}, fieldKeys(t, err))
}

func TestNormalizeProfile(t *testing.T) {
	ict := time.FixedZone("ICT", 7*60*60)

	got := runner.NormalizeProfile(runner.ProfileData{
		FullName:       "  Sok Dara ",
		Gender:         " f ",
		BirthDate:      time.Date(1990, 5, 1, 23, 30, 0, 0, ict),
		Nationality:    " kh",
		IDType:         "passport",
		IDNo:           "n0 1234-5678",
		Phone:          "+855 12-345-678",
		Email:          " dara@example.com ",
		EmergencyName:  " Sok Chenda ",
		EmergencyPhone: "+855 98 765 432",
		TShirtSize:     " xl ",
	})

	assert.Equal(t, runner.ProfileData{
		FullName:       "Sok Dara",
		Gender:         "F",
		BirthDate:      time.Date(1990, 5, 1, 0, 0, 0, 0, time.UTC),
		Nationality:    "KH",
		IDType:         "PASSPORT",
		IDNo:           "N012345678",
		Phone:          "+85512345678",
		Email:          "dara@example.com",
		EmergencyName:  "Sok Chenda",
		EmergencyPhone: "+85598765432",
		TShirtSize:     "XL",
	}, got)
}
