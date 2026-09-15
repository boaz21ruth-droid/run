-- name: GetNotifyRecipient :one
SELECT telegram_user_id, locale
FROM users
WHERE id = @id;

-- name: InsertNotificationLog :one
INSERT INTO notification_logs (channel, recipient, template, locale, entity_type, entity_id, dedupe_key)
VALUES ('TELEGRAM', @recipient, @template, @locale, 'reg_order', @entity_id, @dedupe_key)
ON CONFLICT (dedupe_key) DO NOTHING
RETURNING id;

-- name: GetNotificationLog :one
SELECT id, status, attempts
FROM notification_logs
WHERE id = @id;

-- name: MarkNotificationSent :exec
UPDATE notification_logs
SET status = 'SENT', sent_at = @sent_at, attempts = attempts + 1, last_error = NULL
WHERE id = @id;

-- name: MarkNotificationAttemptFailed :exec
UPDATE notification_logs
SET status = @status, attempts = attempts + 1, last_error = @last_error
WHERE id = @id;
