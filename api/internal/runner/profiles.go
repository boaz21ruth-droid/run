package runner

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/mail"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/piicrypt"
	"werun/api/internal/runner/store"
)

const (
	maxProfileNameLen = 100
	maxEmailLen       = 254
)

var (
	nationalityPattern = regexp.MustCompile(`^[A-Z]{2}$`)
	idNoPattern        = regexp.MustCompile(`^[A-Z0-9]{4,32}$`)
	phonePattern       = regexp.MustCompile(`^\+[1-9][0-9]{7,14}$`)
	emailPattern       = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

	profileGenders     = []string{"M", "F", "X"}
	profileIDTypes     = []string{"NATIONAL_ID", "PASSPORT", "OTHER"}
	profileTShirtSizes = []string{"XS", "S", "M", "L", "XL", "XXL"}

	minBirthDate = time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC)

	// platformZone：平台所在地柬埔寨，固定 UTC+7，不实行夏令时。用于「今天」这类按日期的判断。
	platformZone = time.FixedZone("Asia/Phnom_Penh", 7*60*60)
)

// NormalizeProfile 去掉首尾空白，统一大小写，证件号去空白与连字符，手机号去空白与连字符，出生日期取日期部分。
func NormalizeProfile(p ProfileData) ProfileData {
	p.FullName = strings.TrimSpace(p.FullName)
	p.Gender = strings.ToUpper(strings.TrimSpace(p.Gender))
	if !p.BirthDate.IsZero() {
		p.BirthDate = dateOnly(p.BirthDate)
	}
	p.Nationality = strings.ToUpper(strings.TrimSpace(p.Nationality))
	p.IDType = strings.ToUpper(strings.TrimSpace(p.IDType))
	p.IDNo = piicrypt.NormalizeIDNo(p.IDNo)
	p.Phone = normalizePhone(p.Phone)
	p.Email = strings.TrimSpace(p.Email)
	p.EmergencyName = strings.TrimSpace(p.EmergencyName)
	p.EmergencyPhone = normalizePhone(p.EmergencyPhone)
	p.TShirtSize = strings.ToUpper(strings.TrimSpace(p.TShirtSize))
	return p
}

// ValidateProfile 规范化后校验全部字段，返回 VALIDATION_FAILED；字段名前缀由 fieldPrefix 给出（如 "participants[0]."）。
func ValidateProfile(p ProfileData, fieldPrefix string) error {
	return validateProfile(NormalizeProfile(p), fieldPrefix, true, time.Now())
}

// validateProfile 校验已规范化的资料；requireIDNo 为 false 时证件号可以为空（更新时保留原号）。
func validateProfile(p ProfileData, fieldPrefix string, requireIDNo bool, now time.Time) error {
	verr := apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)
	invalid := false
	add := func(field, key string) {
		verr = verr.WithField(fieldPrefix+field, key, nil)
		invalid = true
	}
	checkName := func(field, value string) {
		switch {
		case value == "":
			add(field, "field.required")
		case utf8.RuneCountInString(value) > maxProfileNameLen:
			add(field, "field.invalid")
		}
	}
	checkEnum := func(field, value string, allowed []string) {
		switch {
		case value == "":
			add(field, "field.required")
		case !slices.Contains(allowed, value):
			add(field, "field.invalid")
		}
	}
	checkPattern := func(field, value string, pattern *regexp.Regexp) {
		switch {
		case value == "":
			add(field, "field.required")
		case !pattern.MatchString(value):
			add(field, "field.invalid")
		}
	}

	checkName("fullName", p.FullName)
	checkEnum("gender", p.Gender, profileGenders)
	today := dateOnly(now.In(platformZone))
	switch {
	case p.BirthDate.IsZero():
		add("birthDate", "field.required")
	case p.BirthDate.Before(minBirthDate) || p.BirthDate.After(today):
		add("birthDate", "field.invalid")
	}
	checkPattern("nationality", p.Nationality, nationalityPattern)
	checkEnum("idType", p.IDType, profileIDTypes)
	if p.IDNo != "" || requireIDNo {
		checkPattern("idNo", p.IDNo, idNoPattern)
	}
	checkPattern("phone", p.Phone, phonePattern)
	if p.Email != "" && !validEmail(p.Email) {
		add("email", "field.invalid")
	}
	checkName("emergencyName", p.EmergencyName)
	checkPattern("emergencyPhone", p.EmergencyPhone, phonePattern)
	checkEnum("tshirtSize", p.TShirtSize, profileTShirtSizes)

	if invalid {
		return verr
	}
	return nil
}

func validEmail(s string) bool {
	if len(s) > maxEmailLen || !emailPattern.MatchString(s) {
		return false
	}
	addr, err := mail.ParseAddress(s)
	return err == nil && addr.Address == s
}

func normalizePhone(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) || r == '-' {
			return -1
		}
		return r
	}, s)
}

// dateOnly 取 t 在其自身时区里的年月日，返回该日期的 UTC 零点。
func dateOnly(t time.Time) time.Time {
	y, m, d := t.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

// PII 返回证件号加解密器，供 registration 写报名快照时复用。
func (s *Service) PII() *piicrypt.Cipher {
	return s.pii
}

// ListProfiles 列出当前跑者的常用参赛人，本人排在最前。
func (s *Service) ListProfiles(ctx context.Context, u User) ([]Profile, error) {
	rows, err := s.q.ListProfiles(ctx, u.ID)
	if err != nil {
		return nil, fmt.Errorf("runner: list profiles of user %d: %w", u.ID, err)
	}
	out := make([]Profile, 0, len(rows))
	for _, row := range rows {
		p, err := s.toProfile(row)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, nil
}

// CreateProfile 校验并保存常用参赛人；isSelf 为 true 时同一事务内清掉该跑者其它资料的本人标记。
func (s *Service) CreateProfile(ctx context.Context, u User, p ProfileData, isSelf bool) (Profile, error) {
	p = NormalizeProfile(p)
	if err := validateProfile(p, "", true, s.now()); err != nil {
		return Profile{}, err
	}
	var out Profile
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		row, err := s.insertProfile(ctx, s.q.WithTx(tx), u, p, isSelf)
		if err != nil {
			return err
		}
		out, err = s.toProfile(row)
		return err
	})
	if err != nil {
		return Profile{}, err
	}
	return out, nil
}

// UpdateProfile 修改常用参赛人；p.IDNo 为空串时保留原证件号。资料不属于该跑者返回 NOT_FOUND。
func (s *Service) UpdateProfile(ctx context.Context, u User, id int64, p ProfileData, isSelf bool) (Profile, error) {
	p = NormalizeProfile(p)
	keepIDNo := p.IDNo == ""
	if err := validateProfile(p, "", !keepIDNo, s.now()); err != nil {
		return Profile{}, err
	}
	var out Profile
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		if isSelf {
			if _, err := q.LockUser(ctx, u.ID); err != nil {
				return fmt.Errorf("runner: lock user %d: %w", u.ID, err)
			}
		}
		existing, err := q.GetProfileForUpdate(ctx, store.GetProfileForUpdateParams{ID: id, UserID: u.ID})
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeNotFound)
		}
		if err != nil {
			return fmt.Errorf("runner: lock profile %d: %w", id, err)
		}

		enc, hash := existing.IDNoEnc, existing.IDNoHash
		if keepIDNo {
			if len(enc) == 0 {
				return apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation).
					WithField("idNo", "field.required", nil)
			}
		} else {
			enc, err = s.pii.Encrypt(p.IDNo)
			if err != nil {
				return fmt.Errorf("runner: encrypt id number: %w", err)
			}
			hash = s.pii.Hash(p.IDNo)
		}
		if isSelf {
			if err := q.ClearSelfProfiles(ctx, store.ClearSelfProfilesParams{UserID: u.ID, ExceptID: id}); err != nil {
				return fmt.Errorf("runner: clear self flag of user %d: %w", u.ID, err)
			}
		}
		row, err := q.UpdateProfile(ctx, store.UpdateProfileParams{
			FullName:       p.FullName,
			Gender:         p.Gender,
			BirthDate:      p.BirthDate,
			Nationality:    p.Nationality,
			IDType:         p.IDType,
			IDNoEnc:        enc,
			IDNoHash:       hash,
			PhoneE164:      p.Phone,
			Email:          optionalString(p.Email),
			EmergencyName:  p.EmergencyName,
			EmergencyPhone: p.EmergencyPhone,
			TshirtSize:     p.TShirtSize,
			IsSelf:         isSelf,
			ID:             id,
			UserID:         u.ID,
		})
		if err != nil {
			return fmt.Errorf("runner: update profile %d: %w", id, err)
		}
		out, err = s.toProfile(row)
		return err
	})
	if err != nil {
		return Profile{}, err
	}
	return out, nil
}

// DeleteProfile 删除常用参赛人；资料不属于该跑者返回 NOT_FOUND。已报名的快照在 registrations 里，不受影响。
func (s *Service) DeleteProfile(ctx context.Context, u User, id int64) error {
	n, err := s.q.DeleteProfile(ctx, store.DeleteProfileParams{ID: id, UserID: u.ID})
	if err != nil {
		return fmt.Errorf("runner: delete profile %d: %w", id, err)
	}
	if n == 0 {
		return apperr.New(http.StatusNotFound, apperr.CodeNotFound)
	}
	return nil
}

// CreateProfileTx 在调用方事务里保存常用参赛人（下单时勾选「保存为常用参赛人」），不设本人标记。
func (s *Service) CreateProfileTx(ctx context.Context, tx pgx.Tx, u User, p ProfileData) (int64, error) {
	p = NormalizeProfile(p)
	if err := validateProfile(p, "", true, s.now()); err != nil {
		return 0, err
	}
	row, err := s.insertProfile(ctx, s.q.WithTx(tx), u, p, false)
	if err != nil {
		return 0, err
	}
	return row.ID, nil
}

// LoadProfileForOrder 返回解密后的完整资料（含证件号）；资料不属于该跑者返回 VALIDATION_FAILED（字段 fieldPrefix+"profileId"）。
func (s *Service) LoadProfileForOrder(ctx context.Context, tx pgx.Tx, u User, id int64, fieldPrefix string) (ProfileData, error) {
	row, err := s.q.WithTx(tx).GetProfile(ctx, store.GetProfileParams{ID: id, UserID: u.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return ProfileData{}, apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation).
			WithField(fieldPrefix+"profileId", "field.invalid", nil)
	}
	if err != nil {
		return ProfileData{}, fmt.Errorf("runner: load profile %d: %w", id, err)
	}
	return s.profileData(row)
}

// insertProfile 写入已校验的资料；isSelf 时先锁跑者行再清掉其它本人标记，避免并发产生两个本人。
func (s *Service) insertProfile(ctx context.Context, q *store.Queries, u User, p ProfileData, isSelf bool) (store.RunnerProfile, error) {
	enc, err := s.pii.Encrypt(p.IDNo)
	if err != nil {
		return store.RunnerProfile{}, fmt.Errorf("runner: encrypt id number: %w", err)
	}
	if isSelf {
		if _, err := q.LockUser(ctx, u.ID); err != nil {
			return store.RunnerProfile{}, fmt.Errorf("runner: lock user %d: %w", u.ID, err)
		}
		if err := q.ClearSelfProfiles(ctx, store.ClearSelfProfilesParams{UserID: u.ID, ExceptID: 0}); err != nil {
			return store.RunnerProfile{}, fmt.Errorf("runner: clear self flag of user %d: %w", u.ID, err)
		}
	}
	row, err := q.InsertProfile(ctx, store.InsertProfileParams{
		UserID:         u.ID,
		FullName:       p.FullName,
		Gender:         p.Gender,
		BirthDate:      p.BirthDate,
		Nationality:    p.Nationality,
		IDType:         p.IDType,
		IDNoEnc:        enc,
		IDNoHash:       s.pii.Hash(p.IDNo),
		PhoneE164:      p.Phone,
		Email:          optionalString(p.Email),
		EmergencyName:  p.EmergencyName,
		EmergencyPhone: p.EmergencyPhone,
		TshirtSize:     p.TShirtSize,
		IsSelf:         isSelf,
	})
	if err != nil {
		return store.RunnerProfile{}, fmt.Errorf("runner: insert profile for user %d: %w", u.ID, err)
	}
	return row, nil
}

func (s *Service) toProfile(row store.RunnerProfile) (Profile, error) {
	data, err := s.profileData(row)
	if err != nil {
		return Profile{}, err
	}
	masked := piicrypt.MaskIDNo(data.IDNo)
	data.IDNo = ""
	return Profile{ID: row.ID, Data: data, IDNoMasked: masked, IsSelf: row.IsSelf}, nil
}

func (s *Service) profileData(row store.RunnerProfile) (ProfileData, error) {
	idNo := ""
	if len(row.IDNoEnc) > 0 {
		plain, err := s.pii.Decrypt(row.IDNoEnc)
		if err != nil {
			return ProfileData{}, fmt.Errorf("runner: decrypt id number of profile %d: %w", row.ID, err)
		}
		idNo = plain
	}
	return ProfileData{
		FullName:       row.FullName,
		Gender:         row.Gender,
		BirthDate:      row.BirthDate,
		Nationality:    row.Nationality,
		IDType:         derefString(row.IDType),
		IDNo:           idNo,
		Phone:          derefString(row.PhoneE164),
		Email:          derefString(row.Email),
		EmergencyName:  derefString(row.EmergencyName),
		EmergencyPhone: derefString(row.EmergencyPhone),
		TShirtSize:     derefString(row.TshirtSize),
	}, nil
}
