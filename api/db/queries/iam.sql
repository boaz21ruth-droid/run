-- name: GetStaffByUsername :one
SELECT id, username, full_name, role, password_hash, status
FROM staff
WHERE username = @username;

-- name: InsertStaff :one
INSERT INTO staff (username, full_name, role, password_hash)
VALUES (@username, @full_name, @role, @password_hash)
RETURNING id, username, full_name, role;

-- name: SetStaffLastLogin :exec
UPDATE staff SET last_login_at = @last_login_at WHERE id = @id;

-- name: InsertStaffSession :exec
INSERT INTO sessions (subject_type, subject_id, token_hash, expires_at, ip, user_agent, created_at)
VALUES ('STAFF', @staff_id, @token_hash, @expires_at, @ip, @user_agent, @created_at);

-- name: GetStaffSession :one
SELECT s.id AS session_id,
       s.expires_at,
       s.created_at,
       s.revoked_at,
       st.id AS staff_id,
       st.username,
       st.full_name,
       st.role,
       st.status
FROM sessions s
JOIN staff st ON st.id = s.subject_id
WHERE s.subject_type = 'STAFF'
  AND s.token_hash = @token_hash;

-- name: UpdateSessionExpiry :exec
UPDATE sessions SET expires_at = @expires_at
WHERE id = @id AND revoked_at IS NULL;

-- name: RevokeSession :exec
UPDATE sessions SET revoked_at = @revoked_at
WHERE token_hash = @token_hash AND revoked_at IS NULL;

-- name: DeleteExpiredSessions :execrows
DELETE FROM sessions
WHERE expires_at < @cutoff
   OR revoked_at < @cutoff;
