package runner

import (
	"strings"
	"time"

	"werun/api/internal/platform/apperr"
)

// ContactFields 是免费活动报名需要校验的资料子集。Gender、BirthDate 为 nil 表示未填写。
type ContactFields struct {
	FullName       string
	Phone          string
	EmergencyName  string
	EmergencyPhone string
	Gender         *string
	BirthDate      *time.Time
}

var contactFieldKeys = []string{"fullName", "phone", "emergencyName", "emergencyPhone", "gender", "birthDate"}

// NormalizeContactFields 按 NormalizeProfile 的同一套规则规范化联系人字段：姓名去首尾空白，
// 手机号去空白与连字符，性别去空白并转大写（空串视为未填写，置为 nil）。出生日期原样保留。
func NormalizeContactFields(in ContactFields) ContactFields {
	in.FullName = strings.TrimSpace(in.FullName)
	in.Phone = normalizePhone(in.Phone)
	in.EmergencyName = strings.TrimSpace(in.EmergencyName)
	in.EmergencyPhone = normalizePhone(in.EmergencyPhone)
	if in.Gender != nil {
		g := normalizeGender(*in.Gender)
		if g == "" {
			in.Gender = nil
		} else {
			in.Gender = &g
		}
	}
	return in
}

// ValidateContactFields 用 ValidateProfile 的同一套规则校验联系人字段：其余资料字段填占位值，
// 只保留 fullName、phone、emergencyName、emergencyPhone 以及已填写的 gender、birthDate 的错误。
// 占位字段即使不合法也不会出现在结果里。
func ValidateContactFields(in ContactFields, fieldPrefix string) error {
	p := ProfileData{
		FullName:       in.FullName,
		Gender:         "M",
		BirthDate:      time.Date(1990, 1, 1, 0, 0, 0, 0, time.UTC),
		Nationality:    "KH",
		IDType:         "PASSPORT",
		IDNo:           "N01234567",
		Phone:          in.Phone,
		Email:          "",
		EmergencyName:  in.EmergencyName,
		EmergencyPhone: in.EmergencyPhone,
		TShirtSize:     "M",
	}
	if in.Gender != nil {
		p.Gender = *in.Gender
	}
	if in.BirthDate != nil {
		p.BirthDate = *in.BirthDate
	}

	err := ValidateProfile(p, fieldPrefix)
	if err == nil {
		return nil
	}
	ae, ok := apperr.As(err)
	if !ok || ae.Code != apperr.CodeValidation {
		return err
	}
	out := apperr.New(ae.Status, apperr.CodeValidation)
	kept := 0
	for _, key := range contactFieldKeys {
		if fe, found := ae.Fields[fieldPrefix+key]; found {
			out = out.WithField(fieldPrefix+key, fe.Key, fe.Params)
			kept++
		}
	}
	if kept == 0 {
		return nil
	}
	return out
}
