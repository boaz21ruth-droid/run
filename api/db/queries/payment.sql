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

-- name: InsertPaymentProof :one
INSERT INTO payment_proofs (
  proof_no, reg_order_id, payment_account_id, file_id, submitted_by_user_id,
  declared_amount_cents, declared_currency, bank_txn_ref, declared_paid_at, payer_name, dup_file_hit
) VALUES (
  @proof_no, sqlc.arg(reg_order_id)::bigint, @payment_account_id, @file_id, sqlc.arg(submitted_by_user_id)::bigint,
  @declared_amount_cents, 'USD', @bank_txn_ref, @declared_paid_at, @payer_name, @dup_file_hit
)
RETURNING *;

-- name: GetPaymentProofForReview :one
SELECT sqlc.embed(p), o.order_no
FROM payment_proofs p
JOIN reg_orders o ON o.id = p.reg_order_id
WHERE p.id = @id;

-- name: LockPaymentProof :one
SELECT * FROM payment_proofs
WHERE id = @id
FOR UPDATE;

-- name: MarkPaymentProofApproved :execrows
UPDATE payment_proofs
SET status = 'APPROVED',
    reviewed_by = sqlc.arg(reviewed_by)::bigint,
    reviewed_at = sqlc.arg(reviewed_at)::timestamptz
WHERE id = @id AND status = 'SUBMITTED';

-- name: MarkPaymentProofRejected :execrows
UPDATE payment_proofs
SET status = 'REJECTED',
    reviewed_by = sqlc.arg(reviewed_by)::bigint,
    reviewed_at = sqlc.arg(reviewed_at)::timestamptz,
    reject_code = sqlc.arg(reject_code)::text,
    reject_reason = sqlc.narg(reject_reason)::text
WHERE id = @id AND status = 'SUBMITTED';

-- name: InsertPaymentReceipt :one
INSERT INTO payment_receipts (
  payment_account_id, txn_ref, amount_cents, currency, received_at,
  proof_id, reg_order_id, match_status, recorded_by_type, recorded_by
) VALUES (
  @payment_account_id, @txn_ref, @amount_cents, 'USD', @received_at,
  sqlc.arg(proof_id)::bigint, sqlc.arg(reg_order_id)::bigint, @match_status, 'STAFF', sqlc.arg(recorded_by)::bigint
)
RETURNING id;

-- name: InsertPaymentException :one
INSERT INTO payment_exceptions (exception_no, domain, type, reg_order_id, receipt_id, amount_cents, status, note)
VALUES (@exception_no, 'REGISTRATION', 'OVERPAID', sqlc.arg(reg_order_id)::bigint, @receipt_id, @amount_cents, 'OPEN', sqlc.narg(note)::text)
RETURNING id;

-- name: ListProofQueue :many
SELECT sqlc.embed(p), o.order_no, o.amount_cents AS order_amount_cents, e.name AS event_name
FROM payment_proofs p
JOIN reg_orders o ON o.id = p.reg_order_id
JOIN events e ON e.id = o.event_id
WHERE p.status = @status
ORDER BY p.created_at, p.id
LIMIT 500;

-- name: IsProofFile :one
-- 只认被凭证引用、用途为 PAYMENT_PROOF 且私有的文件。
SELECT EXISTS (
  SELECT 1 FROM files f
  JOIN payment_proofs p ON p.file_id = f.id
  WHERE f.id = @file_id AND f.purpose = 'PAYMENT_PROOF' AND f.visibility = 'PRIVATE'
);

-- name: GetOrderForProofNotice :one
SELECT o.order_no, o.buyer_user_id, o.deadline_at, e.name AS event_name, e.timezone AS event_timezone
FROM reg_orders o
JOIN events e ON e.id = o.event_id
WHERE o.id = @order_id;
