package iam

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/netip"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"werun/api/internal/audit"
	"werun/api/internal/iam/store"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/httpx"
)

// 会话参数取自 spec §5.4。
const (
	CookieName      = "werun_admin_session"
	CookiePath      = "/api/admin"
	IdleTimeout     = 8 * time.Hour
	AbsoluteTimeout = 7 * 24 * time.Hour
	TouchInterval   = time.Minute

	tokenBytes     = 32
	minPasswordLen = 10
	maxFullNameLen = 100
	statusActive   = "ACTIVE"
)

var usernamePattern = regexp.MustCompile(`^[a-z0-9._-]{3,64}$`)

func init() {
	apperr.RegisterConstraint("staff_username_key", func() *apperr.Error {
		return apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation).
			WithField("username", "field.invalid", nil)
	})
}

// Staff 是已认证的后台员工。
type Staff struct {
	ID       int64
	Username string
	FullName string
	Role     Role
}

// Service 负责员工账号、登录与会话。
type Service struct {
	pool    *pgxpool.Pool
	q       *store.Queries
	secret  []byte
	limiter *LoginLimiter
	clock   Clock
}

func NewService(pool *pgxpool.Pool, sessionSecret []byte, limiter *LoginLimiter, clock Clock) *Service {
	return &Service{
		pool:    pool,
		q:       store.New(pool),
		secret:  sessionSecret,
		limiter: limiter,
		clock:   clock,
	}
}

// CreateStaff 校验输入并创建员工；用户名重复时返回字段 username 的校验错误。
func (s *Service) CreateStaff(ctx context.Context, username, fullName string, role Role, password string) (Staff, error) {
	username = strings.TrimSpace(username)
	fullName = strings.TrimSpace(fullName)

	verr := apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)
	invalid := false
	if !usernamePattern.MatchString(username) {
		verr, invalid = verr.WithField("username", "field.invalid", nil), true
	}
	switch {
	case fullName == "":
		verr, invalid = verr.WithField("fullName", "field.required", nil), true
	case utf8.RuneCountInString(fullName) > maxFullNameLen:
		verr, invalid = verr.WithField("fullName", "field.too_long", map[string]any{"max": maxFullNameLen}), true
	}
	if _, ok := ParseRole(string(role)); !ok {
		verr, invalid = verr.WithField("role", "field.invalid", nil), true
	}
	if utf8.RuneCountInString(password) < minPasswordLen {
		verr, invalid = verr.WithField("password", "field.invalid", nil), true
	}
	if invalid {
		return Staff{}, verr
	}

	hash, err := HashPassword(password)
	if err != nil {
		return Staff{}, err
	}
	row, err := s.q.InsertStaff(ctx, store.InsertStaffParams{
		Username:     username,
		FullName:     fullName,
		Role:         string(role),
		PasswordHash: hash,
	})
	if err != nil {
		return Staff{}, apperr.FromPG(err)
	}
	return Staff{ID: row.ID, Username: row.Username, FullName: row.FullName, Role: Role(row.Role)}, nil
}

// Login 校验账号密码并创建会话，返回明文令牌（只出现在 Cookie 里）。
func (s *Service) Login(ctx context.Context, username, password string, meta httpx.Meta) (string, Staff, error) {
	username = strings.ToLower(strings.TrimSpace(username))

	if !s.limiter.AllowIP(meta.IP) {
		return "", Staff{}, apperr.New(http.StatusTooManyRequests, apperr.CodeRateLimited)
	}
	// BeginAttempt 原子地检查锁定状态并预占一个名额，避免并发请求都在各自的
	// Locked 检查与各自的 Failure 之间抢跑，绕过"连续失败 5 次锁定"。下面每一
	// 条退出路径都必须恰好释放一次这个名额：已知结果（失败/成功）调用
	// Failure/Success 释放；尚未得出结果就出错的路径由 defer 里的 Release 兜底。
	if !s.limiter.BeginAttempt(username) {
		return "", Staff{}, apperr.New(http.StatusLocked, apperr.CodeAccountLocked)
	}
	released := false
	defer func() {
		if !released {
			s.limiter.Release(username)
		}
	}()

	row, err := s.q.GetStaffByUsername(ctx, username)
	if errors.Is(err, pgx.ErrNoRows) {
		// 做一次同等开销的哈希，避免通过响应时间判断用户名是否存在。
		_, verifyErr := verifyPasswordLimited(ctx, dummyHash(), password)
		if errors.Is(verifyErr, errArgon2Busy) {
			return "", Staff{}, apperr.New(http.StatusTooManyRequests, apperr.CodeRateLimited)
		}
		released = true
		s.limiter.Failure(username)
		slog.WarnContext(ctx, "staff login with unknown username",
			"username", username, "ip", meta.IP, "request_id", meta.RequestID)
		return "", Staff{}, invalidCredentials()
	}
	if err != nil {
		return "", Staff{}, fmt.Errorf("iam: load staff %q: %w", username, err)
	}

	staff := Staff{ID: row.ID, Username: row.Username, FullName: row.FullName, Role: Role(row.Role)}
	ok, err := verifyPasswordLimited(ctx, row.PasswordHash, password)
	if errors.Is(err, errArgon2Busy) {
		return "", Staff{}, apperr.New(http.StatusTooManyRequests, apperr.CodeRateLimited)
	}
	if err != nil {
		return "", Staff{}, fmt.Errorf("iam: verify password of staff %d: %w", row.ID, err)
	}
	if !ok || row.Status != statusActive {
		released = true
		s.limiter.Failure(username)
		reason := "密码错误"
		if ok {
			reason = "账号已停用"
		}
		err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
			return audit.Record(ctx, tx, audit.Entry{
				ActorType:  "SYSTEM",
				Action:     "staff.login_failed",
				EntityType: "staff",
				EntityID:   staff.ID,
				Summary:    fmt.Sprintf("员工 %s 登录失败：%s", staff.Username, reason),
				Meta:       meta,
			})
		})
		if err != nil {
			return "", Staff{}, err
		}
		return "", Staff{}, invalidCredentials()
	}
	released = true
	s.limiter.Success(username)

	raw := make([]byte, tokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", Staff{}, fmt.Errorf("iam: generate session token: %w", err)
	}
	now := s.clock()
	role := string(staff.Role)
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		if err := q.InsertStaffSession(ctx, store.InsertStaffSessionParams{
			StaffID:   staff.ID,
			TokenHash: s.hashToken(raw),
			ExpiresAt: now.Add(IdleTimeout),
			Ip:        parseIP(meta.IP),
			UserAgent: optionalString(meta.UserAgent),
			CreatedAt: now,
		}); err != nil {
			return err
		}
		if err := q.SetStaffLastLogin(ctx, store.SetStaffLastLoginParams{LastLoginAt: &now, ID: staff.ID}); err != nil {
			return err
		}
		return audit.Record(ctx, tx, audit.Entry{
			ActorType:  "STAFF",
			ActorID:    &staff.ID,
			ActorRole:  &role,
			Action:     "staff.login",
			EntityType: "staff",
			EntityID:   staff.ID,
			Summary:    fmt.Sprintf("员工 %s 登录", staff.Username),
			Meta:       meta,
		})
	})
	if err != nil {
		return "", Staff{}, fmt.Errorf("iam: create session for staff %d: %w", staff.ID, err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), staff, nil
}

// Authenticate 校验令牌；有效时按需滑动续期。
func (s *Service) Authenticate(ctx context.Context, token string) (Staff, error) {
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) != tokenBytes {
		return Staff{}, unauthenticated()
	}
	row, err := s.q.GetStaffSession(ctx, s.hashToken(raw))
	if errors.Is(err, pgx.ErrNoRows) {
		return Staff{}, unauthenticated()
	}
	if err != nil {
		return Staff{}, fmt.Errorf("iam: load session: %w", err)
	}

	now := s.clock()
	absolute := row.CreatedAt.Add(AbsoluteTimeout)
	if row.RevokedAt != nil || !now.Before(row.ExpiresAt) || !now.Before(absolute) || row.Status != statusActive {
		return Staff{}, unauthenticated()
	}

	target := now.Add(IdleTimeout)
	if absolute.Before(target) {
		target = absolute
	}
	if target.Sub(row.ExpiresAt) >= TouchInterval {
		if err := s.q.UpdateSessionExpiry(ctx, store.UpdateSessionExpiryParams{ExpiresAt: target, ID: row.SessionID}); err != nil {
			return Staff{}, fmt.Errorf("iam: extend session %d: %w", row.SessionID, err)
		}
	}

	role, ok := ParseRole(row.Role)
	if !ok {
		return Staff{}, fmt.Errorf("iam: staff %d has unknown role %q", row.StaffID, row.Role)
	}
	return Staff{ID: row.StaffID, Username: row.Username, FullName: row.FullName, Role: role}, nil
}

// Logout 吊销令牌对应的会话；令牌格式不对时什么也不做。
func (s *Service) Logout(ctx context.Context, token string) error {
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) != tokenBytes {
		return nil
	}
	now := s.clock()
	if err := s.q.RevokeSession(ctx, store.RevokeSessionParams{RevokedAt: &now, TokenHash: s.hashToken(raw)}); err != nil {
		return fmt.Errorf("iam: revoke session: %w", err)
	}
	return nil
}

// DeleteExpiredSessions 删除过期或吊销时间早于 now-olderThan 的会话。
func (s *Service) DeleteExpiredSessions(ctx context.Context, olderThan time.Duration) (int64, error) {
	n, err := s.q.DeleteExpiredSessions(ctx, s.clock().Add(-olderThan))
	if err != nil {
		return 0, fmt.Errorf("iam: delete expired sessions: %w", err)
	}
	return n, nil
}

func (s *Service) hashToken(raw []byte) []byte {
	mac := hmac.New(sha256.New, s.secret)
	_, _ = mac.Write(raw)
	return mac.Sum(nil)
}

func invalidCredentials() *apperr.Error {
	return apperr.New(http.StatusUnauthorized, apperr.CodeInvalidCredentials)
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

var (
	dummyHashOnce  sync.Once
	dummyHashValue string
)

func dummyHash() string {
	dummyHashOnce.Do(func() {
		dummyHashValue, _ = HashPassword("werun-dummy-password")
	})
	return dummyHashValue
}
