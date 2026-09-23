package runner

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"regexp"
	"strconv"
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

const (
	otpTTL         = 5 * time.Minute
	otpResendAfter = 60 * time.Second
	otpMaxAttempts = 5
	otpLength      = 6
	displayNameMax = 64
)

var e164 = regexp.MustCompile(`^\+[1-9][0-9]{6,14}$`)

// ValidE164 判断手机号是否为 E.164 格式。
func ValidE164(phone string) bool { return e164.MatchString(phone) }

// CodeRequest 是请求验证码成功后的响应。
type CodeRequest struct {
	ExpiresIn   time.Duration
	ResendAfter time.Duration
	Channel     string
}

// RequestPhoneCode 生成验证码、写入 auth_otps（作废旧码）、事务提交后交给发送器；
// 发送失败时作废刚写入的记录并按失败类型返回错误。
func (s *Service) RequestPhoneCode(ctx context.Context, phone string, meta httpx.Meta) (CodeRequest, error) {
	if !ValidE164(phone) {
		return CodeRequest{}, apperr.New(http.StatusUnprocessableEntity, apperr.CodeOTPPhoneInvalid)
	}
	if wait, ok := s.limiter.Allow(phone, meta.IP); !ok {
		return CodeRequest{}, apperr.New(http.StatusTooManyRequests, apperr.CodeRateLimited).
			WithField("retryAfterSeconds", strconv.Itoa(int(wait/time.Second)), nil)
	}
	code, err := s.newCode()
	if err != nil {
		return CodeRequest{}, err
	}
	now := s.now()
	var id int64
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		if err := q.ConsumeActiveOTPs(ctx, store.ConsumeActiveOTPsParams{PhoneE164: phone, ConsumedAt: now}); err != nil {
			return fmt.Errorf("runner: consume old otps: %w", err)
		}
		id, err = q.InsertOTP(ctx, store.InsertOTPParams{
			PhoneE164: phone, CodeHash: s.hashCode(phone, code), ExpiresAt: now.Add(otpTTL), Ip: parseIP(meta.IP), CreatedAt: now,
		})
		if err != nil {
			return fmt.Errorf("runner: insert otp: %w", err)
		}
		return nil
	})
	if err != nil {
		return CodeRequest{}, err
	}
	requestID, sendErr := s.otp.Send(ctx, phone, code)
	if sendErr != nil {
		if err := s.q.ConsumeOTP(ctx, store.ConsumeOTPParams{ID: id, ConsumedAt: s.now()}); err != nil {
			return CodeRequest{}, fmt.Errorf("runner: void otp after send failure: %w", err)
		}
		if errors.Is(sendErr, ErrPhoneUnreachable) {
			return CodeRequest{}, apperr.New(http.StatusUnprocessableEntity, apperr.CodeOTPPhoneNotOnTelegram).Wrap(sendErr)
		}
		return CodeRequest{}, apperr.New(http.StatusBadGateway, apperr.CodeOTPSendFailed).Wrap(sendErr)
	}
	if requestID != "" {
		if err := s.q.SetOTPProviderRequestID(ctx, store.SetOTPProviderRequestIDParams{ID: id, ProviderRequestID: &requestID}); err != nil {
			return CodeRequest{}, fmt.Errorf("runner: store provider request id: %w", err)
		}
	}
	return CodeRequest{ExpiresIn: otpTTL, ResendAfter: otpResendAfter, Channel: "telegram"}, nil
}

// VerifyPhoneCode 校验验证码，按手机号创建或找到跑者，签发会话并写审计 runner.login。
//
// 验证码错误次数达上限（5 次）时的规则（spec §4.2）：错误码用光的那一次直接返回
// OTP_ATTEMPTS_EXCEEDED 并作废验证码；单次错误只计数、返回 OTP_INVALID 和剩余次数，
// 不在“最后一次错误”当场作废——下一次校验（无论验证码是否正确）都会看到
// attempts>=5，从而消费掉验证码并返回 OTP_ATTEMPTS_EXCEEDED。
func (s *Service) VerifyPhoneCode(ctx context.Context, phone, code, locale string, meta httpx.Meta) (Session, error) {
	if !ValidE164(phone) {
		return Session{}, apperr.New(http.StatusUnprocessableEntity, apperr.CodeOTPPhoneInvalid)
	}
	if _, ok := i18n.Parse(locale); !ok {
		locale = string(i18n.Default)
	}
	raw := make([]byte, tokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return Session{}, fmt.Errorf("runner: generate session token: %w", err)
	}
	now := s.now()
	expiresAt := now.Add(SessionTTL)
	var user User
	// bizErr 装可预期的业务错误（验证码错误/过期/超限/账号禁用）。这些情形下
	// attempts 计数、consumed_at、last_login_at 等写入都必须落盘，所以事务本身
	// 正常提交（fn 返回 nil），业务错误在提交后再返回给调用方；只有意外的技术性
	// 错误才让事务回滚。
	var bizErr *apperr.Error
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		otp, err := q.GetActiveOTPForUpdate(ctx, phone)
		if errors.Is(err, pgx.ErrNoRows) {
			bizErr = apperr.New(http.StatusUnprocessableEntity, apperr.CodeOTPExpired)
			return nil
		}
		if err != nil {
			return fmt.Errorf("runner: load otp: %w", err)
		}
		if !now.Before(otp.ExpiresAt) {
			bizErr = apperr.New(http.StatusUnprocessableEntity, apperr.CodeOTPExpired)
			return nil
		}
		if otp.Attempts >= otpMaxAttempts {
			if err := q.ConsumeOTP(ctx, store.ConsumeOTPParams{ID: otp.ID, ConsumedAt: now}); err != nil {
				return fmt.Errorf("runner: void exhausted otp: %w", err)
			}
			bizErr = apperr.New(http.StatusUnprocessableEntity, apperr.CodeOTPAttemptsExceeded)
			return nil
		}
		if subtle.ConstantTimeCompare(otp.CodeHash, s.hashCode(phone, code)) != 1 {
			attempts, err := q.IncrementOTPAttempts(ctx, otp.ID)
			if err != nil {
				return fmt.Errorf("runner: bump otp attempts: %w", err)
			}
			left := max(otpMaxAttempts-int(attempts), 0)
			bizErr = apperr.New(http.StatusUnprocessableEntity, apperr.CodeOTPInvalid).
				WithField("attemptsLeft", strconv.Itoa(left), nil)
			return nil
		}
		if err := q.ConsumeOTP(ctx, store.ConsumeOTPParams{ID: otp.ID, ConsumedAt: now}); err != nil {
			return fmt.Errorf("runner: consume otp: %w", err)
		}
		row, err := q.UpsertPhoneUser(ctx, store.UpsertPhoneUserParams{PhoneE164: &phone, Locale: locale, LastLoginAt: now})
		if err != nil {
			return fmt.Errorf("runner: upsert phone user: %w", err)
		}
		if row.Status != statusActive {
			bizErr = apperr.New(http.StatusForbidden, apperr.CodeForbidden).
				Wrap(fmt.Errorf("runner: user %d is %s", row.ID, row.Status))
			return nil
		}
		user = userFromColumns(row.ID, row.PhoneE164, row.TelegramUserID, row.TelegramUsername, row.DisplayName, row.Locale)
		if err := q.InsertUserSession(ctx, store.InsertUserSessionParams{
			UserID: user.ID, TokenHash: s.hashToken(raw), ExpiresAt: expiresAt, Ip: parseIP(meta.IP), UserAgent: optionalString(meta.UserAgent), CreatedAt: now,
		}); err != nil {
			return fmt.Errorf("runner: insert session for user %d: %w", user.ID, err)
		}
		actorID := user.ID
		return audit.Record(ctx, tx, audit.Entry{
			ActorType: "USER", ActorID: &actorID, Action: "runner.login", EntityType: "user", EntityID: user.ID,
			Summary: fmt.Sprintf("跑者 %s（手机号 %s）登录", user.DisplayName, maskPhone(phone)), Meta: meta,
		})
	})
	if err != nil {
		return Session{}, err
	}
	if bizErr != nil {
		return Session{}, bizErr
	}
	return Session{Token: base64.RawURLEncoding.EncodeToString(raw), ExpiresAt: expiresAt, User: user}, nil
}

// UpdateMe 修改显示名与语言；nil 表示不改。
func (s *Service) UpdateMe(ctx context.Context, userID int64, displayName, locale *string, meta httpx.Meta) (User, error) {
	if displayName != nil && (utf8.RuneCountInString(*displayName) == 0 || utf8.RuneCountInString(*displayName) > displayNameMax) {
		return User{}, apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation).WithField("displayName", "field.too_long", nil)
	}
	if locale != nil {
		if _, ok := i18n.Parse(*locale); !ok {
			return User{}, apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation).WithField("locale", "field.invalid", nil)
		}
	}
	var user User
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		cur, err := q.GetUserByID(ctx, userID)
		if err != nil {
			return fmt.Errorf("runner: load user %d: %w", userID, err)
		}
		name, lang := cur.DisplayName, cur.Locale
		if displayName != nil {
			name = displayName
		}
		if locale != nil {
			lang = *locale
		}
		row, err := q.UpdateUserProfile(ctx, store.UpdateUserProfileParams{ID: userID, DisplayName: name, Locale: lang})
		if err != nil {
			return fmt.Errorf("runner: update user %d: %w", userID, err)
		}
		user = userFromColumns(row.ID, row.PhoneE164, row.TelegramUserID, row.TelegramUsername, row.DisplayName, row.Locale)
		actorID := userID
		return audit.Record(ctx, tx, audit.Entry{
			ActorType: "USER", ActorID: &actorID, Action: "runner.profile_update", EntityType: "user", EntityID: userID,
			Summary: "跑者修改显示名或语言", Meta: meta,
		})
	})
	return user, err
}

func (s *Service) newCode() (string, error) {
	if _, fixed := s.otp.(FixedOTPSender); fixed {
		return FixedOTPCode, nil
	}
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return "", fmt.Errorf("runner: generate otp: %w", err)
	}
	return fmt.Sprintf("%0*d", otpLength, n.Int64()), nil
}

// hashCode = HMAC-SHA256(sessionSecret, phone + ":" + code)
func (s *Service) hashCode(phone, code string) []byte {
	mac := hmac.New(sha256.New, s.secret)
	_, _ = mac.Write([]byte(phone + ":" + code))
	return mac.Sum(nil)
}
