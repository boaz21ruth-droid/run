package registration

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/audit"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/idgen"
	"werun/api/internal/pricing"
	"werun/api/internal/registration/store"
	"werun/api/internal/runner"
)

const (
	freeSignupNoConstraint     = "free_signups_signup_no_key"
	freeSignupActiveConstraint = "free_signups_one_active"
)

func init() {
	apperr.RegisterConstraint(freeSignupActiveConstraint, func() *apperr.Error {
		return apperr.New(http.StatusConflict, apperr.CodeAlreadyRegistered).
			WithField("fullName", "field.already_registered", nil)
	})
}

// FreeSignupInput 是免费活动报名的输入。Gender、BirthDate 为 nil 表示未填写。
type FreeSignupInput struct {
	CategoryID                                     int64
	FullName, Phone, EmergencyName, EmergencyPhone string
	Gender                                         *string
	BirthDate                                      *time.Time
	Consent                                        runner.ConsentAcceptance
}

// FreeSignup 是创建成功的免费报名。
type FreeSignup struct {
	ID         int64
	SignupNo   string
	EventSlug  string
	CategoryID int64
	FullName   string
	Status     string
	CreatedAt  time.Time
}

// CreateFreeSignup 按 spec 6.7 为免费活动报名：同一跑者可为家人报多人，
// 同一组别内同手机号 + 同姓名（不区分大小写）只能有一条有效报名。
func (s *Service) CreateFreeSignup(ctx context.Context, u runner.User, slug string, in FreeSignupInput, meta httpx.Meta) (FreeSignup, error) {
	slug = strings.TrimSpace(slug)
	in = freeSignupNormalize(in)
	if err := freeSignupValidate(in); err != nil {
		return FreeSignup{}, err
	}

	var out FreeSignup
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)

		ev, err := q.FreeSignupLockEvent(ctx, slug)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
		}
		if err != nil {
			return fmt.Errorf("lock event %q: %w", slug, err)
		}
		if !freeSignupOpen(ev, s.now()) {
			return apperr.New(http.StatusConflict, apperr.CodeRegistrationClosed)
		}

		cat, err := q.FreeSignupGetCategory(ctx, store.FreeSignupGetCategoryParams{ID: in.CategoryID, EventID: ev.ID})
		if errors.Is(err, pgx.ErrNoRows) {
			return freeSignupFieldError("categoryId", "field.category_unavailable", nil)
		}
		if err != nil {
			return fmt.Errorf("get category %d: %w", in.CategoryID, err)
		}
		if cat.MinAge > 0 {
			if in.BirthDate == nil {
				return freeSignupFieldError("birthDate", "field.required", nil)
			}
			if pricing.AgeOn(*in.BirthDate, ev.RaceDate) < int(cat.MinAge) {
				return freeSignupFieldError("birthDate", "field.too_young", map[string]any{"minAge": int(cat.MinAge)})
			}
		}

		taken, err := q.FreeSignupTakeSeat(ctx, cat.ID)
		if err != nil {
			return fmt.Errorf("take seat in category %d: %w", cat.ID, err)
		}
		if taken == 0 {
			return apperr.New(http.StatusConflict, apperr.CodeCategorySoldOut)
		}

		params := store.InsertFreeSignupParams{
			EventID:        ev.ID,
			CategoryID:     cat.ID,
			UserID:         u.ID,
			FullName:       in.FullName,
			PhoneE164:      in.Phone,
			EmergencyName:  in.EmergencyName,
			EmergencyPhone: in.EmergencyPhone,
		}
		if in.Gender != nil {
			params.Gender = *in.Gender
		}
		if in.BirthDate != nil {
			params.BirthDate = in.BirthDate.Format(time.DateOnly)
		}
		row, err := freeSignupInsert(ctx, tx, params)
		if err != nil {
			return err
		}

		signupID := row.ID
		if err := s.runners.SignConsent(ctx, tx, u, in.Consent, meta, runner.ConsentLink{FreeSignupID: &signupID}); err != nil {
			return err
		}

		out = FreeSignup{
			ID:         row.ID,
			SignupNo:   row.SignupNo,
			EventSlug:  slug,
			CategoryID: cat.ID,
			FullName:   in.FullName,
			Status:     row.Status,
			CreatedAt:  row.CreatedAt,
		}
		userID := u.ID
		eventID := ev.ID
		return audit.Record(ctx, tx, audit.Entry{
			ActorType:   "USER",
			ActorID:     &userID,
			Action:      "free_signup.create",
			EntityType:  "free_signup",
			EntityID:    row.ID,
			EventID:     &eventID,
			IsFinancial: false,
			Summary:     fmt.Sprintf("免费活动报名 %s（%s）", row.SignupNo, slug),
			After: map[string]any{
				"signupNo":   row.SignupNo,
				"categoryId": cat.ID,
				"status":     row.Status,
			},
			Meta: meta,
		})
	})
	if err != nil {
		return FreeSignup{}, err
	}
	return out, nil
}

// freeSignupNormalize 用跑者资料的同一套规则规范化联系人字段；入库的就是规范化后的值，
// 这样 free_signups_one_active 按 E.164 手机号去重，性别满足 DB CHECK。
func freeSignupNormalize(in FreeSignupInput) FreeSignupInput {
	c := runner.NormalizeContactFields(runner.ContactFields{
		FullName:       in.FullName,
		Phone:          in.Phone,
		EmergencyName:  in.EmergencyName,
		EmergencyPhone: in.EmergencyPhone,
		Gender:         in.Gender,
		BirthDate:      in.BirthDate,
	})
	in.FullName = c.FullName
	in.Phone = c.Phone
	in.EmergencyName = c.EmergencyName
	in.EmergencyPhone = c.EmergencyPhone
	in.Gender = c.Gender
	return in
}

func freeSignupValidate(in FreeSignupInput) error {
	err := runner.ValidateContactFields(runner.ContactFields{
		FullName:       in.FullName,
		Phone:          in.Phone,
		EmergencyName:  in.EmergencyName,
		EmergencyPhone: in.EmergencyPhone,
		Gender:         in.Gender,
		BirthDate:      in.BirthDate,
	}, "")
	if in.CategoryID > 0 {
		return err
	}
	if err == nil {
		return freeSignupFieldError("categoryId", "field.required", nil)
	}
	if ae, ok := apperr.As(err); ok && ae.Code == apperr.CodeValidation {
		return ae.WithField("categoryId", "field.required", nil)
	}
	return err
}

func freeSignupFieldError(field, key string, params map[string]any) error {
	return apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation).WithField(field, key, params)
}

// freeSignupOpen 与 spec 6.1 第 1 步相同的开放条件，但要求 FREE_ACTIVITY。
func freeSignupOpen(ev store.FreeSignupLockEventRow, now time.Time) bool {
	if ev.Status != "PUBLISHED" || ev.EventType != "FREE_ACTIVITY" || !ev.RegistrationOpen {
		return false
	}
	if ev.RegistrationOpensAt != nil && now.Before(*ev.RegistrationOpensAt) {
		return false
	}
	if ev.RegistrationClosesAt != nil && !now.Before(*ev.RegistrationClosesAt) {
		return false
	}
	return true
}

// freeSignupInsert 在保存点里写报名行：编号冲突时回滚保存点并重新生成（idgen.Retry 最多 3 次），
// 外层事务不受影响；free_signups_one_active 冲突映射为 ALREADY_REGISTERED。
func freeSignupInsert(ctx context.Context, tx pgx.Tx, params store.InsertFreeSignupParams) (store.InsertFreeSignupRow, error) {
	var row store.InsertFreeSignupRow
	err := idgen.Retry(freeSignupNoConstraint, func() error {
		params.SignupNo = idgen.Code(idgen.PrefixFreeSignup)
		return withSavepoint(ctx, tx, func(sp pgx.Tx) error {
			inserted, err := store.New(sp).InsertFreeSignup(ctx, params)
			if err != nil {
				return err
			}
			row = inserted
			return nil
		})
	})
	if err != nil {
		mapped := apperr.FromPG(err)
		if _, ok := apperr.As(mapped); ok {
			return store.InsertFreeSignupRow{}, mapped
		}
		return store.InsertFreeSignupRow{}, fmt.Errorf("insert free signup: %w", err)
	}
	return row, nil
}
