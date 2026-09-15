-- name: UpsertTelegramUser :one
-- 首次登录创建跑者；再次登录只更新用户名、显示名与最近登录时间，不覆盖 locale。
INSERT INTO users (telegram_user_id, telegram_username, display_name, locale, last_login_at)
VALUES (@telegram_user_id::bigint, @telegram_username, @display_name, @locale, @last_login_at::timestamptz)
ON CONFLICT (telegram_user_id) DO UPDATE
SET telegram_username = EXCLUDED.telegram_username,
    display_name      = EXCLUDED.display_name,
    last_login_at     = EXCLUDED.last_login_at
RETURNING id, telegram_user_id, telegram_username, display_name, locale, status;

-- name: InsertUserSession :exec
INSERT INTO sessions (subject_type, subject_id, token_hash, expires_at, ip, user_agent, created_at)
VALUES ('USER', @user_id, @token_hash, @expires_at, @ip, @user_agent, @created_at);

-- name: GetUserSession :one
SELECT s.expires_at,
       s.revoked_at,
       u.id AS user_id,
       u.telegram_user_id,
       u.telegram_username,
       u.display_name,
       u.locale,
       u.status
FROM sessions s
JOIN users u ON u.id = s.subject_id
WHERE s.subject_type = 'USER'
  AND s.token_hash = @token_hash;

-- name: RevokeUserSession :exec
UPDATE sessions SET revoked_at = @revoked_at::timestamptz
WHERE subject_type = 'USER' AND token_hash = @token_hash AND revoked_at IS NULL;
