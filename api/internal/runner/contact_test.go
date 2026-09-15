package runner_test

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/runner"
)

var contactFieldNames = map[string]bool{
	"fullName": true, "phone": true, "emergencyName": true,
	"emergencyPhone": true, "gender": true, "birthDate": true,
}

func completeProfile() runner.ProfileData {
	return runner.ProfileData{
		FullName:       "Dara Sok",
		Gender:         "M",
		BirthDate:      time.Date(1990, 5, 1, 0, 0, 0, 0, time.UTC),
		Nationality:    "KH",
		IDType:         "NATIONAL_ID",
		IDNo:           "010203040",
		Phone:          "+85512345678",
		Email:          "dara@example.com",
		EmergencyName:  "Sok Chan",
		EmergencyPhone: "+85598765432",
		TShirtSize:     "M",
	}
}

func validContact() runner.ContactFields {
	return runner.ContactFields{
		FullName:       "Dara Sok",
		Phone:          "+85512345678",
		EmergencyName:  "Sok Chan",
		EmergencyPhone: "+85598765432",
	}
}

func fieldsOf(t *testing.T, err error) map[string]apperr.FieldError {
	t.Helper()
	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	require.Equal(t, apperr.CodeValidation, ae.Code)
	return ae.Fields
}

// ValidateContactFields 依赖 ValidateProfile 使用这些字段键；这里直接验证。
func TestValidateProfileUsesContactFieldNames(t *testing.T) {
	require.NoError(t, runner.ValidateProfile(completeProfile(), "p."))

	cases := map[string]func(p *runner.ProfileData){
		"p.fullName":       func(p *runner.ProfileData) { p.FullName = "" },
		"p.phone":          func(p *runner.ProfileData) { p.Phone = "" },
		"p.emergencyName":  func(p *runner.ProfileData) { p.EmergencyName = "" },
		"p.emergencyPhone": func(p *runner.ProfileData) { p.EmergencyPhone = "" },
		"p.gender":         func(p *runner.ProfileData) { p.Gender = "Q" },
		"p.birthDate":      func(p *runner.ProfileData) { p.BirthDate = time.Time{} },
	}
	for field, mutate := range cases {
		p := completeProfile()
		mutate(&p)
		require.Contains(t, fieldsOf(t, runner.ValidateProfile(p, "p.")), field)
	}
}

func TestValidateContactFieldsAcceptsValidInputWithoutOptionalFields(t *testing.T) {
	require.NoError(t, runner.ValidateContactFields(validContact(), ""))

	gender := "F"
	birth := time.Date(2012, 2, 29, 0, 0, 0, 0, time.UTC)
	in := validContact()
	in.Gender = &gender
	in.BirthDate = &birth
	require.NoError(t, runner.ValidateContactFields(in, ""))
}

func TestValidateContactFieldsReportsOnlyContactFields(t *testing.T) {
	cases := map[string]func(c *runner.ContactFields){
		"fullName":       func(c *runner.ContactFields) { c.FullName = "" },
		"phone":          func(c *runner.ContactFields) { c.Phone = "" },
		"emergencyName":  func(c *runner.ContactFields) { c.EmergencyName = "" },
		"emergencyPhone": func(c *runner.ContactFields) { c.EmergencyPhone = "" },
		"gender": func(c *runner.ContactFields) {
			g := "Q"
			c.Gender = &g
		},
	}
	for field, mutate := range cases {
		in := validContact()
		mutate(&in)
		fields := fieldsOf(t, runner.ValidateContactFields(in, "x."))
		require.Contains(t, fields, "x."+field)
		for key := range fields {
			require.True(t, contactFieldNames[key[len("x."):]], "unexpected field %s", key)
		}
	}
}

func TestValidateContactFieldsMatchesProfileRulesForPhone(t *testing.T) {
	for _, phone := range []string{"12345", "+855", "abc", "+85512345678"} {
		p := completeProfile()
		p.Phone = phone
		profileErr := runner.ValidateProfile(p, "")

		in := validContact()
		in.Phone = phone
		contactErr := runner.ValidateContactFields(in, "")

		if profileErr == nil {
			require.NoError(t, contactErr, phone)
			continue
		}
		_, profileHasPhone := fieldsOf(t, profileErr)["phone"]
		if !profileHasPhone {
			require.NoError(t, contactErr, phone)
			continue
		}
		require.Contains(t, fieldsOf(t, contactErr), "phone", phone)
	}
}
