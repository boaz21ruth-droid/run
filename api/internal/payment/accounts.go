package payment

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/audit"
	"werun/api/internal/iam"
	"werun/api/internal/payment/store"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/storage"
)

const (
	accountTextMaxLen     = 80
	accountNoMaskedMaxLen = 32
)

var (
	providers = []string{ProviderABA, ProviderACLEDA, ProviderWing, ProviderBakong, ProviderOther}
	scopes    = []string{ScopeRegistration, ScopeMerch, ScopeAll}
)

// ValidateAccount 校验收款账户输入（文本应已去掉首尾空白），一次返回全部字段错误。
func ValidateAccount(in AccountInput) error {
	if verr := validateAccount(in, false); verr != nil {
		return verr
	}
	return nil
}

func validateAccount(in AccountInput, qrMissing bool) *apperr.Error {
	verr := validationError()
	failed := false
	add := func(field, key string, params map[string]any) {
		verr = verr.WithField(field, key, params)
		failed = true
	}
	text := func(field, value string, maxLen int) {
		switch {
		case strings.TrimSpace(value) == "":
			add(field, "field.required", nil)
		case utf8.RuneCountInString(value) > maxLen:
			add(field, "field.too_long", map[string]any{"max": maxLen})
		}
	}

	text("name", in.Name, accountTextMaxLen)
	text("accountName", in.AccountName, accountTextMaxLen)
	text("accountNoMasked", in.AccountNoMasked, accountNoMaskedMaxLen)
	if !slices.Contains(providers, in.Provider) {
		add("provider", "field.invalid", nil)
	}
	if !slices.Contains(scopes, in.Scope) {
		add("scope", "field.invalid", nil)
	}
	if qrMissing {
		add("qr", "field.required", nil)
	}
	if failed {
		return verr
	}
	return nil
}

func normalizeAccount(in AccountInput) AccountInput {
	in.Name = strings.TrimSpace(in.Name)
	in.Provider = strings.TrimSpace(in.Provider)
	in.AccountName = strings.TrimSpace(in.AccountName)
	in.AccountNoMasked = strings.TrimSpace(in.AccountNoMasked)
	in.Scope = strings.TrimSpace(in.Scope)
	return in
}

// ListAccounts 返回全部收款账户，启用的在前。
func (s *Service) ListAccounts(ctx context.Context) ([]Account, error) {
	rows, err := store.New(s.pool).ListPaymentAccounts(ctx)
	if err != nil {
		return nil, fmt.Errorf("list payment accounts: %w", err)
	}
	out := make([]Account, 0, len(rows))
	for _, r := range rows {
		out = append(out, accountFromRow(r))
	}
	return out, nil
}

// CreateAccount 保存二维码并新建收款账户，写审计 payment_account.create。
func (s *Service) CreateAccount(ctx context.Context, actor iam.Staff, in AccountInput, qr io.Reader) (Account, error) {
	in = normalizeAccount(in)
	if verr := validateAccount(in, qr == nil); verr != nil {
		return Account{}, verr
	}
	img, key, err := s.storeQR(ctx, qr)
	if err != nil {
		return Account{}, err
	}

	var out Account
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		if err := requireAccountEvent(ctx, q, in.EventID); err != nil {
			return err
		}
		fileID, err := storage.InsertFile(ctx, tx, qrRecord(key, img, actor))
		if err != nil {
			return err
		}
		actorID := actor.ID
		row, err := q.InsertPaymentAccount(ctx, store.InsertPaymentAccountParams{
			Name:            in.Name,
			Provider:        in.Provider,
			AccountName:     in.AccountName,
			AccountNoMasked: in.AccountNoMasked,
			QrFileID:        fileID,
			Scope:           in.Scope,
			EventID:         in.EventID,
			Active:          in.Active,
			CreatedBy:       &actorID,
		})
		if err != nil {
			return fmt.Errorf("insert payment account: %w", err)
		}
		out = accountFromRow(row)
		return audit.Record(ctx, tx, staffEntry(ctx, actor, "payment_account.create", out.ID, out.Input.EventID,
			fmt.Sprintf("新建收款账户 %s（%s %s）", out.Input.Name, out.Input.Provider, out.Input.AccountNoMasked),
			nil, accountSnapshot(out)))
	})
	if err != nil {
		s.discardFile(ctx, key)
		return Account{}, err
	}
	return out, nil
}

// UpdateAccount 修改收款账户；qr 非 nil 时新建二维码文件行（旧文件保留），写审计 payment_account.update。
func (s *Service) UpdateAccount(ctx context.Context, actor iam.Staff, id int64, in AccountInput, qr io.Reader) (Account, error) {
	in = normalizeAccount(in)
	if verr := validateAccount(in, false); verr != nil {
		return Account{}, verr
	}
	var img storage.Image
	var key string
	if qr != nil {
		var err error
		if img, key, err = s.storeQR(ctx, qr); err != nil {
			return Account{}, err
		}
	}

	var out Account
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		row, err := q.GetPaymentAccountForUpdate(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeNotFound)
		}
		if err != nil {
			return fmt.Errorf("lock payment account %d: %w", id, err)
		}
		before := accountFromRow(row)
		if err := requireAccountEvent(ctx, q, in.EventID); err != nil {
			return err
		}
		qrFileID := row.QrFileID
		if key != "" {
			if qrFileID, err = storage.InsertFile(ctx, tx, qrRecord(key, img, actor)); err != nil {
				return err
			}
		}
		updated, err := q.UpdatePaymentAccount(ctx, store.UpdatePaymentAccountParams{
			Name:            in.Name,
			Provider:        in.Provider,
			AccountName:     in.AccountName,
			AccountNoMasked: in.AccountNoMasked,
			QrFileID:        qrFileID,
			Scope:           in.Scope,
			EventID:         in.EventID,
			Active:          in.Active,
			ID:              id,
		})
		if err != nil {
			return fmt.Errorf("update payment account %d: %w", id, err)
		}
		out = accountFromRow(updated)
		return audit.Record(ctx, tx, staffEntry(ctx, actor, "payment_account.update", out.ID, out.Input.EventID,
			fmt.Sprintf("修改收款账户 %s", out.Input.Name), accountSnapshot(before), accountSnapshot(out)))
	})
	if err != nil {
		if key != "" {
			s.discardFile(ctx, key)
		}
		return Account{}, err
	}
	return out, nil
}

// storeQR 校验二维码图片并写入存储，返回图片与存储键。
func (s *Service) storeQR(ctx context.Context, qr io.Reader) (storage.Image, string, error) {
	img, err := storage.ReadImage(qr, storage.MaxQRBytes)
	if err != nil {
		return storage.Image{}, "", err
	}
	key := storage.NewKey(s.now(), img.Ext)
	if err := s.files.Put(ctx, key, bytes.NewReader(img.Data)); err != nil {
		return storage.Image{}, "", fmt.Errorf("store payment qr: %w", err)
	}
	return img, key, nil
}

func qrRecord(key string, img storage.Image, actor iam.Staff) storage.FileRecord {
	return storage.FileRecord{
		StorageKey:     key,
		Visibility:     storage.VisibilityPublic,
		Purpose:        storage.PurposePaymentQR,
		Image:          img,
		UploadedByType: "STAFF",
		UploadedByID:   actor.ID,
	}
}

func requireAccountEvent(ctx context.Context, q *store.Queries, eventID *int64) error {
	if eventID == nil {
		return nil
	}
	exists, err := q.EventExists(ctx, *eventID)
	if err != nil {
		return fmt.Errorf("check event %d: %w", *eventID, err)
	}
	if !exists {
		return validationError().WithField("eventId", "field.invalid", nil)
	}
	return nil
}

func accountFromRow(r store.PaymentAccount) Account {
	return Account{
		ID: r.ID,
		Input: AccountInput{
			Name:            r.Name,
			Provider:        r.Provider,
			AccountName:     r.AccountName,
			AccountNoMasked: r.AccountNoMasked,
			Scope:           r.Scope,
			EventID:         r.EventID,
			Active:          r.Active,
		},
		Currency:  r.Currency,
		QRFileID:  r.QrFileID,
		CreatedAt: r.CreatedAt,
	}
}

func accountSnapshot(a Account) map[string]any {
	return map[string]any{
		"name":            a.Input.Name,
		"provider":        a.Input.Provider,
		"accountName":     a.Input.AccountName,
		"accountNoMasked": a.Input.AccountNoMasked,
		"scope":           a.Input.Scope,
		"eventId":         a.Input.EventID,
		"active":          a.Input.Active,
		"currency":        a.Currency,
		"qrFileId":        a.QRFileID,
	}
}
