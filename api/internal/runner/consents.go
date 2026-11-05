package runner

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/audit"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/runner/store"
)

// 同意书用途，对应 disclaimer_versions.purpose。
const (
	PurposeCommunity    = "COMMUNITY"
	PurposeRegistration = "REGISTRATION"

	maxConsentItems              = 20
	maxConsentItemTitleLen       = 200
	maxConsentItemDescriptionLen = 1000
)

var (
	consentVersionPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
	consentItemKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)
	consentLangs          = []string{string(i18n.ZH), string(i18n.EN), string(i18n.KM)}
)

func init() {
	// 版本发布后不可修改：同一 (version, lang) 再次发布时撞主键
	apperr.RegisterConstraint("disclaimer_versions_pkey", func() *apperr.Error {
		return apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation).
			WithField("version", "field.invalid", nil)
	})
}

// consentItemJSON 是 disclaimer_versions.items 列中每个元素的格式。
type consentItemJSON struct {
	K string `json:"k"`
	T string `json:"t"`
	D string `json:"d,omitempty"`
	O bool   `json:"o,omitempty"` // 可选条目；旧版本没有这个字段，一律必勾
}

// PublishConsent 发布一版同意书（text_sha256 = SHA-256(full_text)），写审计 consent.publish。
func (s *Service) PublishConsent(ctx context.Context, in PublishConsentInput) error {
	if err := validatePublishConsent(in); err != nil {
		return err
	}
	stored := make([]consentItemJSON, len(in.Items))
	keys := make([]string, len(in.Items))
	for i, item := range in.Items {
		stored[i] = consentItemJSON{K: item.Key, T: strings.TrimSpace(item.Title), D: strings.TrimSpace(item.Description), O: item.Optional}
		keys[i] = item.Key
	}
	itemsJSON, err := json.Marshal(stored)
	if err != nil {
		return fmt.Errorf("runner: encode consent items: %w", err)
	}
	sum := sha256.Sum256([]byte(in.FullText))
	effective := dateOnly(in.EffectiveDate)

	return db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		if err := s.q.WithTx(tx).InsertConsentVersion(ctx, store.InsertConsentVersionParams{
			Version:       in.Version,
			Lang:          in.Lang,
			EffectiveDate: effective,
			FullText:      in.FullText,
			Items:         itemsJSON,
			TextSha256:    sum[:],
			Purpose:       in.Purpose,
		}); err != nil {
			return apperr.FromPG(err)
		}
		return audit.Record(ctx, tx, audit.Entry{
			ActorType:  "SYSTEM",
			Action:     "consent.publish",
			EntityType: "disclaimer_version",
			EntityID:   0,
			Summary: fmt.Sprintf("发布同意书 %s（%s，%s，%s 生效）",
				in.Version, in.Lang, in.Purpose, effective.Format(time.DateOnly)),
			After: map[string]any{
				"purpose":       in.Purpose,
				"version":       in.Version,
				"lang":          in.Lang,
				"effectiveDate": effective.Format(time.DateOnly),
				"textSha256":    hex.EncodeToString(sum[:]),
				"itemKeys":      keys,
			},
		})
	})
}

func validatePublishConsent(in PublishConsentInput) error {
	verr := apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)
	invalid := false
	add := func(field, key string) {
		verr = verr.WithField(field, key, nil)
		invalid = true
	}

	switch {
	case in.Purpose == "":
		add("purpose", "field.required")
	case in.Purpose != PurposeCommunity && in.Purpose != PurposeRegistration:
		add("purpose", "field.invalid")
	}
	switch {
	case in.Version == "":
		add("version", "field.required")
	case !consentVersionPattern.MatchString(in.Version):
		add("version", "field.invalid")
	}
	switch {
	case in.Lang == "":
		add("lang", "field.required")
	case !slices.Contains(consentLangs, in.Lang):
		add("lang", "field.invalid")
	}
	if in.EffectiveDate.IsZero() {
		add("effectiveDate", "field.required")
	}
	if strings.TrimSpace(in.FullText) == "" {
		add("fullText", "field.required")
	}
	switch {
	case len(in.Items) == 0:
		add("items", "field.required")
	case len(in.Items) > maxConsentItems:
		add("items", "field.invalid")
	}
	// 全部可选等于没有同意书：至少要有一条必勾
	if len(in.Items) > 0 && !slices.ContainsFunc(in.Items, func(item ConsentItem) bool { return !item.Optional }) {
		add("items", "field.invalid")
	}
	seen := make(map[string]bool, len(in.Items))
	for i, item := range in.Items {
		prefix := fmt.Sprintf("items[%d].", i)
		switch {
		case item.Key == "":
			add(prefix+"key", "field.required")
		case !consentItemKeyPattern.MatchString(item.Key) || seen[item.Key]:
			add(prefix+"key", "field.invalid")
		}
		seen[item.Key] = true
		title := strings.TrimSpace(item.Title)
		switch {
		case title == "":
			add(prefix+"title", "field.required")
		case utf8.RuneCountInString(title) > maxConsentItemTitleLen:
			add(prefix+"title", "field.invalid")
		}
		if utf8.RuneCountInString(strings.TrimSpace(item.Description)) > maxConsentItemDescriptionLen {
			add(prefix+"description", "field.invalid")
		}
	}

	if invalid {
		return verr
	}
	return nil
}

// CurrentConsent 取 effective_date <= 今天（柬埔寨时间）中最新的一版；请求语言没有时依次回退到英文、中文；都没有返回 NOT_FOUND。
func (s *Service) CurrentConsent(ctx context.Context, purpose string, lang i18n.Lang) (ConsentVersion, error) {
	if purpose != PurposeCommunity && purpose != PurposeRegistration {
		return ConsentVersion{}, apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation).
			WithField("purpose", "field.invalid", nil)
	}
	today := dateOnly(s.now().In(platformZone))
	for _, l := range consentLangOrder(lang) {
		row, err := s.q.GetCurrentConsent(ctx, store.GetCurrentConsentParams{
			Purpose: purpose,
			Lang:    string(l),
			Today:   today,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return ConsentVersion{}, fmt.Errorf("runner: load current %s consent in %s: %w", purpose, l, err)
		}
		items, err := decodeConsentItems(row.Items)
		if err != nil {
			return ConsentVersion{}, fmt.Errorf("runner: consent %s/%s: %w", row.Version, row.Lang, err)
		}
		return ConsentVersion{
			Version:       row.Version,
			Lang:          row.Lang,
			EffectiveDate: row.EffectiveDate,
			FullText:      row.FullText,
			Items:         items,
		}, nil
	}
	return ConsentVersion{}, apperr.New(http.StatusNotFound, apperr.CodeNotFound)
}

// SignConsent 在调用方事务里写 disclaimer_signatures 与 registration_consents。
func (s *Service) SignConsent(ctx context.Context, tx pgx.Tx, u User, acc ConsentAcceptance, meta httpx.Meta, link ConsentLink) error {
	if (link.RegOrderID == nil) == (link.FreeSignupID == nil) {
		return errors.New("runner: ConsentLink must set exactly one of RegOrderID and FreeSignupID")
	}
	signatureID, err := s.sign(ctx, tx, u, acc, meta, PurposeRegistration)
	if err != nil {
		return err
	}
	if err := s.q.WithTx(tx).InsertRegistrationConsent(ctx, store.InsertRegistrationConsentParams{
		SignatureID:  signatureID,
		RegOrderID:   link.RegOrderID,
		FreeSignupID: link.FreeSignupID,
	}); err != nil {
		return fmt.Errorf("runner: link consent signature %d: %w", signatureID, err)
	}
	return nil
}

// SignCommunityConsent 在调用方事务里签署跑友活动免责声明（purpose COMMUNITY），返回签署记录 id，
// 由调用方写进 community_activities.signature_id。
func (s *Service) SignCommunityConsent(ctx context.Context, tx pgx.Tx, u User, acc ConsentAcceptance, meta httpx.Meta) (int64, error) {
	return s.sign(ctx, tx, u, acc, meta, PurposeCommunity)
}

// sign 校验版本用途与勾选项，写一条 disclaimer_signatures。
func (s *Service) sign(ctx context.Context, tx pgx.Tx, u User, acc ConsentAcceptance, meta httpx.Meta, purpose string) (int64, error) {
	q := s.q.WithTx(tx)
	row, err := q.GetConsentVersion(ctx, store.GetConsentVersionParams{Version: acc.Version, Lang: acc.Lang})
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, consentInvalid("version %q in %q not found", acc.Version, acc.Lang)
	}
	if err != nil {
		return 0, fmt.Errorf("runner: load consent %s/%s: %w", acc.Version, acc.Lang, err)
	}
	if row.Purpose != purpose {
		return 0, consentInvalid("version %s/%s has purpose %s, want %s", row.Version, row.Lang, row.Purpose, purpose)
	}
	items, err := decodeConsentItems(row.Items)
	if err != nil {
		return 0, fmt.Errorf("runner: consent %s/%s: %w", row.Version, row.Lang, err)
	}
	checked, ok := orderedCheckedItems(items, acc.CheckedItems)
	if !ok {
		return 0, consentInvalid("checked items %v do not match version %s/%s", acc.CheckedItems, row.Version, row.Lang)
	}
	checkedJSON, err := json.Marshal(checked)
	if err != nil {
		return 0, fmt.Errorf("runner: encode checked items: %w", err)
	}
	signatureID, err := q.InsertConsentSignature(ctx, store.InsertConsentSignatureParams{
		Version:      row.Version,
		Lang:         row.Lang,
		TextSha256:   row.TextSha256,
		UserID:       u.ID,
		CheckedItems: checkedJSON,
		SignedAt:     s.now(),
		Ip:           parseIP(meta.IP),
		UserAgent:    optionalString(meta.UserAgent),
	})
	if err != nil {
		return 0, fmt.Errorf("runner: insert consent signature for user %d: %w", u.ID, err)
	}
	return signatureID, nil
}

func consentLangOrder(l i18n.Lang) []i18n.Lang {
	order := []i18n.Lang{l}
	for _, fallback := range []i18n.Lang{i18n.EN, i18n.ZH} {
		if !slices.Contains(order, fallback) {
			order = append(order, fallback)
		}
	}
	return order
}

func decodeConsentItems(raw []byte) ([]ConsentItem, error) {
	var stored []consentItemJSON
	if err := json.Unmarshal(raw, &stored); err != nil {
		return nil, fmt.Errorf("decode consent items: %w", err)
	}
	items := make([]ConsentItem, len(stored))
	for i, item := range stored {
		items[i] = ConsentItem{Key: item.K, Title: item.T, Description: item.D, Optional: item.O}
	}
	return items, nil
}

// orderedCheckedItems 要求 checked 含版本的全部必勾 key、可含可选 key，不得重复或出现版本外的 key（顺序无关），
// 返回按版本顺序排列的 key。签署记录里没有的可选 key 就是跑者没同意的那几条。
func orderedCheckedItems(items []ConsentItem, checked []string) ([]string, bool) {
	set := make(map[string]bool, len(checked))
	for _, key := range checked {
		if set[key] {
			return nil, false
		}
		set[key] = true
	}
	ordered := make([]string, 0, len(checked))
	for _, item := range items {
		switch {
		case set[item.Key]:
			ordered = append(ordered, item.Key)
		case !item.Optional:
			return nil, false
		}
	}
	if len(ordered) != len(checked) {
		return nil, false
	}
	return ordered, true
}

// consentInvalid 返回 422 CONSENT_INVALID；具体原因只进日志。
func consentInvalid(format string, args ...any) *apperr.Error {
	return apperr.New(http.StatusUnprocessableEntity, apperr.CodeConsentInvalid).
		Wrap(fmt.Errorf("runner: consent invalid: "+format, args...))
}
