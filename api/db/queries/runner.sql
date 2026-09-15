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

-- name: LockUser :one
SELECT id FROM users WHERE id = @id FOR UPDATE;

-- name: ListProfiles :many
SELECT * FROM runner_profiles
WHERE user_id = @user_id
ORDER BY is_self DESC, id;

-- name: GetProfile :one
SELECT * FROM runner_profiles
WHERE id = @id AND user_id = @user_id;

-- name: GetProfileForUpdate :one
SELECT * FROM runner_profiles
WHERE id = @id AND user_id = @user_id
FOR UPDATE;

-- name: InsertProfile :one
INSERT INTO runner_profiles (
  user_id, full_name, gender, birth_date, nationality, id_type, id_no_enc, id_no_hash,
  phone_e164, email, emergency_name, emergency_phone, tshirt_size, is_self
) VALUES (
  @user_id, @full_name, @gender, @birth_date, @nationality, @id_type::text, @id_no_enc::bytea, @id_no_hash::bytea,
  @phone_e164::text, sqlc.narg(email), @emergency_name::text, @emergency_phone::text, @tshirt_size::text, @is_self
)
RETURNING *;

-- name: UpdateProfile :one
UPDATE runner_profiles
SET full_name       = @full_name,
    gender          = @gender,
    birth_date      = @birth_date,
    nationality     = @nationality,
    id_type         = @id_type::text,
    id_no_enc       = @id_no_enc::bytea,
    id_no_hash      = @id_no_hash::bytea,
    phone_e164      = @phone_e164::text,
    email           = sqlc.narg(email),
    emergency_name  = @emergency_name::text,
    emergency_phone = @emergency_phone::text,
    tshirt_size     = @tshirt_size::text,
    is_self         = @is_self
WHERE id = @id AND user_id = @user_id
RETURNING *;

-- name: ClearSelfProfiles :exec
UPDATE runner_profiles SET is_self = false
WHERE user_id = @user_id AND is_self AND id <> @except_id;

-- name: DeleteProfile :execrows
DELETE FROM runner_profiles WHERE id = @id AND user_id = @user_id;
