-- name: EventExists :one
SELECT EXISTS (SELECT 1 FROM events WHERE id = @id);

-- name: InsertPaymentAccount :one
INSERT INTO payment_accounts (name, provider, account_name, account_no_masked, currency, qr_file_id,
                              scope, event_id, active, created_by)
VALUES (@name, @provider, @account_name, @account_no_masked, 'USD', @qr_file_id,
        @scope, sqlc.narg(event_id), @active, @created_by)
RETURNING *;

-- name: GetPaymentAccountForUpdate :one
SELECT * FROM payment_accounts
WHERE id = @id
FOR UPDATE;

-- name: UpdatePaymentAccount :one
UPDATE payment_accounts
SET name = @name,
    provider = @provider,
    account_name = @account_name,
    account_no_masked = @account_no_masked,
    currency = 'USD',
    qr_file_id = @qr_file_id,
    scope = @scope,
    event_id = sqlc.narg(event_id),
    active = @active
WHERE id = @id
RETURNING *;

-- name: ListPaymentAccounts :many
SELECT * FROM payment_accounts
ORDER BY active DESC, id;
