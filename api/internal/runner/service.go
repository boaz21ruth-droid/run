package runner

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"werun/api/internal/audit"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/piicrypt"
	"werun/api/internal/runner/store"
)

const (
	// SessionTTL 是跑者令牌的固定有效期，不续期。
	SessionTTL = 24 * time.Hour

	tokenBytes   = 32
	statusActive = "ACTIVE"
)

// Service 负责跑者登录与会话、常用参赛人、同意书、手机号验证码登录。
type Service struct {
	pool     *pgxpool.Pool
	q        *store.Queries
	secret   []byte
	botToken string
	pii      *piicrypt.Cipher
	now      func() time.Time
	otp      OTPSender
	limiter  *OTPLimiter
}

// NewService：sessionSecret 与员工会话共用 WERUN_SESSION_SECRET；now 在测试中注入；
// otp 为 FixedOTPSender 时验证码固定为 FixedOTPCode。
// botToken 为空时 VerifyInitData 拒绝一切登录（config.Load 已禁止空 token）。
func NewService(pool *pgxpool.Pool, sessionSecret []byte, botToken string, pii *piicrypt.Cipher, now func() time.Time, otp OTPSender, limiter *OTPLimiter) *Service {
	return &Service{
		pool:     pool,
		q:        store.New(pool),
		secret:   sessionSecret,
		botToken: botToken,
		pii:      pii,
		now:      now,
		otp:      otp,
		limiter:  limiter,
	}
}

// LoginTelegram 校验 initData，按 telegram_user_id 创建或更新跑者，建 24 小时会话并写审计 runner.login。
func (s *Service) LoginTelegram(ctx context.Context, initData string, meta httpx.Meta) (Session, error) {
	now := s.now()
	tg, err := VerifyInitData(initData, s.botToken, now)
	if err != nil {
		return Session{}, err
	}
	raw := make([]byte, tokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return Session{}, fmt.Errorf("runner: generate session token: %w", err)
	}
	expiresAt := now.Add(SessionTTL)

	var user User
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		row, err := q.UpsertTelegramUser(ctx, store.UpsertTelegramUserParams{
			TelegramUserID:   tg.ID,
			TelegramUsername: optionalString(tg.Username),
			DisplayName:      optionalString(displayName(tg)),
			Locale:           localeFor(tg.LanguageCode),
			LastLoginAt:      now,
		})
		if err != nil {
			return fmt.Errorf("runner: upsert telegram user %d: %w", tg.ID, err)
		}
		if row.Status != statusActive {
			return apperr.New(http.StatusForbidden, apperr.CodeForbidden).
				Wrap(fmt.Errorf("runner: user %d is %s", row.ID, row.Status))
		}
		user = userFromColumns(row.ID, row.PhoneE164, row.TelegramUserID, row.TelegramUsername, row.DisplayName, row.Locale)

		if err := q.InsertUserSession(ctx, store.InsertUserSessionParams{
			UserID:    user.ID,
			TokenHash: s.hashToken(raw),
			ExpiresAt: expiresAt,
			Ip:        parseIP(meta.IP),
			UserAgent: optionalString(meta.UserAgent),
			CreatedAt: now,
		}); err != nil {
			return fmt.Errorf("runner: insert session for user %d: %w", user.ID, err)
		}
		actorID := user.ID
		return audit.Record(ctx, tx, audit.Entry{
			ActorType:  "USER",
			ActorID:    &actorID,
			Action:     "runner.login",
			EntityType: "user",
			EntityID:   user.ID,
			Summary:    fmt.Sprintf("跑者 %s（Telegram %d）登录", user.DisplayName, user.TelegramUserID),
			Meta:       meta,
		})
	})
	if err != nil {
		return Session{}, err
	}
	return Session{
		Token:     base64.RawURLEncoding.EncodeToString(raw),
		ExpiresAt: expiresAt,
		User:      user,
	}, nil
}

// Authenticate 校验跑者令牌：会话属于 USER、未吊销、未过期，且跑者为 ACTIVE。不续期。
func (s *Service) Authenticate(ctx context.Context, token string) (User, error) {
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) != tokenBytes {
		return User{}, unauthenticated()
	}
	row, err := s.q.GetUserSession(ctx, s.hashToken(raw))
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, unauthenticated()
	}
	if err != nil {
		return User{}, fmt.Errorf("runner: load session: %w", err)
	}
	if row.RevokedAt != nil || !s.now().Before(row.ExpiresAt) || row.Status != statusActive {
		return User{}, unauthenticated()
	}
	return userFromColumns(row.UserID, row.PhoneE164, row.TelegramUserID, row.TelegramUsername, row.DisplayName, row.Locale), nil
}

// Logout 吊销令牌对应的跑者会话；令牌格式不对时什么也不做。
func (s *Service) Logout(ctx context.Context, token string) error {
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) != tokenBytes {
		return nil
	}
	if err := s.q.RevokeUserSession(ctx, store.RevokeUserSessionParams{
		RevokedAt: s.now(),
		TokenHash: s.hashToken(raw),
	}); err != nil {
		return fmt.Errorf("runner: revoke session: %w", err)
	}
	return nil
}

// hashToken 与员工会话使用同一算法：HMAC-SHA256(WERUN_SESSION_SECRET, 原始令牌字节)。
func (s *Service) hashToken(raw []byte) []byte {
	mac := hmac.New(sha256.New, s.secret)
	_, _ = mac.Write(raw)
	return mac.Sum(nil)
}

// localeFor：language_code 以 zh 开头 → zh；等于 km → km；其余 → en。
func localeFor(languageCode string) string {
	code := strings.ToLower(strings.TrimSpace(languageCode))
	switch {
	case strings.HasPrefix(code, "zh"):
		return "zh"
	case code == "km":
		return "km"
	default:
		return "en"
	}
}

func displayName(u TelegramUser) string {
	name := strings.TrimSpace(strings.TrimSpace(u.FirstName) + " " + strings.TrimSpace(u.LastName))
	if name == "" {
		return strings.TrimSpace(u.Username)
	}
	return name
}

func userFromColumns(id int64, phone *string, telegramUserID *int64, telegramUsername, name *string, locale string) User {
	u := User{
		ID:               id,
		Phone:            derefString(phone),
		TelegramUsername: derefString(telegramUsername),
		DisplayName:      derefString(name),
		Locale:           locale,
	}
	if telegramUserID != nil {
		u.TelegramUserID = *telegramUserID
	}
	return u
}

func unauthenticated() *apperr.Error {
	return apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
}

func parseIP(s string) *netip.Addr {
	addr, err := netip.ParseAddr(s)
	if err != nil {
		return nil
	}
	return &addr
}

func optionalString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func derefString(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
