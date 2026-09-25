-- name: ClaimIdempotencyKey :one
-- 新键直接插入；已过期的同名键被覆盖；未过期的同名键不返回行（并等待持有它的事务结束）。
INSERT INTO idempotency_keys (key, scope, subject, request_hash, created_at, expires_at)
VALUES (@key, @scope, @subject, @request_hash, @now, @expires_at)
ON CONFLICT (scope, subject, key) DO UPDATE
SET request_hash = EXCLUDED.request_hash,
    response_code = NULL,
    response_body = NULL,
    created_at = EXCLUDED.created_at,
    expires_at = EXCLUDED.expires_at
WHERE idempotency_keys.expires_at <= EXCLUDED.created_at
RETURNING key;

-- name: GetIdempotencyKey :one
SELECT request_hash, response_code, response_body
FROM idempotency_keys
WHERE scope = @scope AND subject = @subject AND key = @key;

-- name: SaveIdempotencyResponse :exec
UPDATE idempotency_keys
SET response_code = @response_code::int, response_body = @response_body::jsonb
WHERE scope = @scope AND subject = @subject AND key = @key;

-- name: LockEventForOrder :one
SELECT id, slug, event_type, status, registration_open, registration_opens_at, registration_closes_at, race_date
FROM events
WHERE slug = @slug
FOR SHARE;

-- name: GetEventForQuote :one
SELECT id, event_type, status, race_date
FROM events
WHERE slug = @slug;

-- name: LockIDNoHash :exec
-- 键为 hashtextextended('<eventId>:<hex(hash)>', 7302)。
SELECT pg_advisory_xact_lock(hashtextextended(format('%s:%s', @event_id::bigint, encode(@id_no_hash::bytea, 'hex')), 7302));

-- name: ListRegisteredIDNoHashes :many
SELECT id_no_hash
FROM registrations
WHERE event_id = @event_id::bigint
  AND status IN ('PENDING', 'CONFIRMED')
  AND id_no_hash = ANY(@hashes::bytea[]);

-- name: SelectRegistrationPaymentAccount :one
SELECT id
FROM payment_accounts
WHERE active
  AND currency = 'USD'
  AND scope IN ('REGISTRATION', 'ALL')
  AND (event_id = @event_id::bigint OR event_id IS NULL)
ORDER BY (event_id IS NULL), id
LIMIT 1;

-- name: InsertRegOrder :one
INSERT INTO reg_orders (
  order_no, event_id, buyer_user_id, buyer_name, buyer_phone_e164, buyer_email,
  status, reservation_state, list_amount_cents, discount_cents, ident_offset_cents, amount_cents,
  currency, coupon_id, payment_account_id, deadline_at, source
) VALUES (
  @order_no, @event_id, @buyer_user_id, @buyer_name, @buyer_phone_e164, @buyer_email,
  'PENDING_PAYMENT', 'RESERVED', @list_amount_cents, @discount_cents, @ident_offset_cents, @amount_cents,
  'USD', @coupon_id, @payment_account_id, @deadline_at, 'TELEGRAM'
)
RETURNING id;

-- name: InsertOrderParticipant :one
INSERT INTO order_participants (order_id, category_id, price_rule_id, audience, list_price_cents, paid_cents, snapshot_name)
VALUES (@order_id, @category_id, @price_rule_id, @audience, @list_price_cents, @paid_cents, @snapshot_name)
RETURNING id;

-- name: InsertRegistration :one
INSERT INTO registrations (
  reg_no, order_participant_id, event_id, category_id, status, ticket_code, user_id,
  full_name, gender, birth_date, nationality, id_type, id_no_enc, id_no_hash,
  phone_e164, email, emergency_name, emergency_phone, tshirt_size
) VALUES (
  @reg_no, @order_participant_id, @event_id, @category_id, 'PENDING', @ticket_code, @user_id,
  @full_name, @gender, @birth_date, @nationality, @id_type, @id_no_enc, @id_no_hash,
  @phone_e164, @email, @emergency_name, @emergency_phone, @tshirt_size
)
RETURNING id;

-- name: MarkOrderPaid :execrows
-- 订单条件更新：只有预留仍为 RESERVED 的订单能转为 PAID/CONSUMED，保证 pricing.Consume 每单只调用一次。
UPDATE reg_orders
SET status = 'PAID',
    paid_at = @paid_at::timestamptz,
    deadline_at = NULL,
    reservation_state = 'CONSUMED',
    version = version + 1
WHERE id = @id
  AND reservation_state = 'RESERVED'
  AND (status = 'PROOF_SUBMITTED' OR (status = 'PENDING_PAYMENT' AND amount_cents = 0));

-- name: ConfirmOrderRegistrations :execrows
UPDATE registrations r
SET status = 'CONFIRMED', confirmed_at = @confirmed_at::timestamptz, version = r.version + 1
FROM order_participants op
WHERE op.id = r.order_participant_id
  AND op.order_id = @order_id::bigint
  AND r.status = 'PENDING';

-- name: GetOrderDetailByID :one
SELECT o.id, o.order_no, o.event_id, o.buyer_user_id, o.status, o.reservation_state,
       o.list_amount_cents, o.discount_cents, o.ident_offset_cents, o.amount_cents, o.currency,
       o.payment_account_id, o.deadline_at, o.paid_at, o.created_at,
       e.slug AS event_slug, e.name AS event_name, e.timezone AS event_timezone
FROM reg_orders o
JOIN events e ON e.id = o.event_id
WHERE o.id = @id;

-- name: ListOrderParticipantDetails :many
SELECT r.id AS registration_id, r.reg_no, op.category_id, ec.name AS category_name, r.full_name,
       op.price_rule_id, op.list_price_cents, op.paid_cents, r.status AS registration_status, r.ticket_code
FROM order_participants op
JOIN registrations r ON r.order_participant_id = op.id
JOIN event_categories ec ON ec.id = op.category_id
WHERE op.order_id = @order_id
ORDER BY op.id;

-- name: GetOrderPaymentAccount :one
SELECT id, name, provider, account_name, account_no_masked, qr_file_id
FROM payment_accounts
WHERE id = @id;

-- name: GetLastRejectedProof :one
SELECT reject_code, reject_reason, reviewed_at
FROM payment_proofs
WHERE reg_order_id = @reg_order_id::bigint AND status = 'REJECTED'
ORDER BY reviewed_at DESC, id DESC
LIMIT 1;

-- name: ListOrdersForBuyer :many
SELECT o.id, o.order_no, o.event_id, o.buyer_user_id, o.status, o.reservation_state,
       o.list_amount_cents, o.discount_cents, o.ident_offset_cents, o.amount_cents, o.currency,
       o.payment_account_id, o.deadline_at, o.paid_at, o.created_at,
       e.slug AS event_slug, e.name AS event_name,
       (SELECT count(*) FROM order_participants op WHERE op.order_id = o.id) AS participant_count
FROM reg_orders o
JOIN events e ON e.id = o.event_id
WHERE o.buyer_user_id = @buyer_user_id::bigint
ORDER BY o.created_at DESC, o.id DESC
LIMIT 100;

-- name: GetOrderIDForBuyer :one
SELECT id
FROM reg_orders
WHERE order_no = @order_no AND buyer_user_id = @buyer_user_id::bigint;

-- name: LockOrderForBuyer :one
SELECT id, event_id, status
FROM reg_orders
WHERE order_no = @order_no AND buyer_user_id = @buyer_user_id::bigint
FOR UPDATE;

-- name: ReleaseOrderExpired :execrows
UPDATE reg_orders
SET status = 'EXPIRED',
    reservation_state = 'RELEASED',
    reservation_release_kind = 'ORDER_EXPIRED',
    expired_at = @at::timestamptz,
    deadline_at = NULL,
    version = version + 1
WHERE id = @id
  AND reservation_state = 'RESERVED'
  AND status IN ('PENDING_PAYMENT', 'PROOF_REJECTED');

-- name: ReleaseOrderCancelled :execrows
UPDATE reg_orders
SET status = 'CANCELLED',
    reservation_state = 'RELEASED',
    reservation_release_kind = 'ORDER_CANCELLED',
    cancelled_at = @at::timestamptz,
    deadline_at = NULL,
    version = version + 1
WHERE id = @id
  AND reservation_state = 'RESERVED'
  AND status = 'PENDING_PAYMENT';

-- name: CancelOrderRegistrations :execrows
UPDATE registrations r
SET status = 'CANCELLED', cancel_reason = @cancel_reason::text, version = r.version + 1
FROM order_participants op
WHERE op.id = r.order_participant_id
  AND op.order_id = @order_id::bigint
  AND r.status = 'PENDING';

-- name: LockRegOrderByNo :one
SELECT * FROM reg_orders
WHERE order_no = @order_no
FOR UPDATE;

-- name: SetOrderProofSubmitted :execrows
UPDATE reg_orders
SET status = 'PROOF_SUBMITTED',
    deadline_at = NULL,
    version = version + 1
WHERE id = @id
  AND reservation_state = 'RESERVED'
  AND status IN ('PENDING_PAYMENT', 'PROOF_REJECTED');

-- name: AdminListRegOrders :many
SELECT sqlc.embed(o),
       e.slug AS event_slug,
       e.name AS event_name,
       (SELECT count(*) FROM order_participants op WHERE op.order_id = o.id)::int AS participant_count
FROM reg_orders o
JOIN events e ON e.id = o.event_id
WHERE (sqlc.narg(event_id)::bigint IS NULL OR o.event_id = sqlc.narg(event_id)::bigint)
  AND (sqlc.arg(status)::text = '' OR o.status = sqlc.arg(status)::text)
  AND (sqlc.arg(q)::text = ''
       OR o.order_no = upper(sqlc.arg(q)::text)
       OR o.buyer_phone_e164 LIKE ('%' || sqlc.arg(q_like)::text || '%') ESCAPE '\'
       OR o.buyer_name ILIKE ('%' || sqlc.arg(q_like)::text || '%') ESCAPE '\')
ORDER BY o.created_at DESC, o.id DESC
LIMIT sqlc.arg(row_limit)::int OFFSET sqlc.arg(row_offset)::int;

-- name: AdminCountRegOrders :one
SELECT count(*)
FROM reg_orders o
WHERE (sqlc.narg(event_id)::bigint IS NULL OR o.event_id = sqlc.narg(event_id)::bigint)
  AND (sqlc.arg(status)::text = '' OR o.status = sqlc.arg(status)::text)
  AND (sqlc.arg(q)::text = ''
       OR o.order_no = upper(sqlc.arg(q)::text)
       OR o.buyer_phone_e164 LIKE ('%' || sqlc.arg(q_like)::text || '%') ESCAPE '\'
       OR o.buyer_name ILIKE ('%' || sqlc.arg(q_like)::text || '%') ESCAPE '\');

-- name: AdminGetRegOrderBuyer :one
SELECT buyer_name, buyer_phone_e164
FROM reg_orders
WHERE id = @id;

-- name: AdminListOrderProofs :many
SELECT id, proof_no, status, bank_txn_ref, declared_amount_cents, reject_code, created_at, reviewed_at
FROM payment_proofs
WHERE reg_order_id = sqlc.arg(order_id)::bigint
ORDER BY created_at DESC, id DESC;

-- name: AdminListOrderReceipts :many
SELECT id, txn_ref, amount_cents, received_at, match_status
FROM payment_receipts
WHERE reg_order_id = sqlc.arg(order_id)::bigint
ORDER BY received_at, id;

-- name: AdminGetOrderCoupon :one
SELECT c.code, cr.discount_cents, cr.state
FROM coupon_redemptions cr
JOIN coupons c ON c.id = cr.coupon_id
WHERE cr.order_id = @order_id;

-- name: LockRegOrderByID :one
SELECT * FROM reg_orders
WHERE id = @id
FOR UPDATE;

-- name: SetOrderProofRejected :execrows
-- 条件更新：只有预留仍为 RESERVED、处于审核中的订单能被驳回并进入重传期。
UPDATE reg_orders
SET status = 'PROOF_REJECTED',
    deadline_at = sqlc.arg(deadline_at)::timestamptz,
    version = version + 1
WHERE id = @id
  AND reservation_state = 'RESERVED'
  AND status = 'PROOF_SUBMITTED';

-- name: ListDueOrderIDsForExpiry :many
-- 只锁订单行（SKIP LOCKED 跳过上传凭证 / 审核事务正持有的订单），按截止时间先后取一批。
SELECT id
FROM reg_orders
WHERE status IN ('PENDING_PAYMENT', 'PROOF_REJECTED')
  AND deadline_at <= @as_of::timestamptz
ORDER BY deadline_at, id
LIMIT @batch_limit::int
FOR UPDATE SKIP LOCKED;

-- name: GetOrderForExpiryNotice :one
SELECT order_no, buyer_user_id, event_id, status, deadline_at
FROM reg_orders
WHERE id = @id;

-- name: ListOrdersDueForReminder :many
SELECT o.id, o.order_no, o.buyer_user_id, o.deadline_at, e.timezone AS event_timezone
FROM reg_orders o
JOIN events e ON e.id = o.event_id
JOIN users u ON u.id = o.buyer_user_id
WHERE o.status IN ('PENDING_PAYMENT', 'PROOF_REJECTED')
  AND o.deadline_at > @as_of::timestamptz
  AND o.deadline_at <= @until::timestamptz
  AND u.telegram_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM notification_logs n
    WHERE n.dedupe_key = 'reminder:' || o.id || ':' || floor(extract(epoch FROM o.deadline_at))::bigint
  )
ORDER BY o.deadline_at, o.id;

-- name: PurgeExpiredIdempotencyKeys :execrows
-- 每次至多删除 batch_limit 条已过期的幂等键。外层再判一次 expires_at：
-- READ COMMITTED 下若同名键刚被 ClaimIdempotencyKey 续期，重新检查最新行版本后不会误删。
DELETE FROM idempotency_keys k
USING (
  SELECT scope, subject, key
  FROM idempotency_keys
  WHERE expires_at < @now::timestamptz
  LIMIT @batch_limit::int
) d
WHERE k.scope = d.scope AND k.subject = d.subject AND k.key = d.key
  AND k.expires_at < @now::timestamptz;

-- name: FreeSignupLockEvent :one
SELECT id, event_type, status, registration_open, registration_opens_at, registration_closes_at, race_date
FROM events
WHERE slug = @slug
FOR SHARE;

-- name: FreeSignupGetCategory :one
SELECT id, min_age
FROM event_categories
WHERE id = @id AND event_id = @event_id;

-- name: FreeSignupTakeSeat :execrows
UPDATE event_categories
SET used_count = used_count + 1
WHERE id = @id AND used_count + reserved_count + 1 <= capacity;

-- name: InsertFreeSignup :one
INSERT INTO free_signups (
  signup_no, event_id, category_id, user_id, full_name, phone_e164,
  gender, birth_date, emergency_name, emergency_phone, source
) VALUES (
  @signup_no, @event_id, @category_id, @user_id::bigint, @full_name, @phone_e164,
  NULLIF(@gender::text, ''), NULLIF(@birth_date::text, '')::date,
  @emergency_name::text, @emergency_phone::text, 'TELEGRAM'
)
RETURNING id, signup_no, status, created_at;

-- name: ListFreeSignupsForUser :many
SELECT fs.signup_no, fs.full_name, fs.status, fs.created_at,
       e.slug AS event_slug, e.name AS event_name, e.race_date, ec.name AS category_name
FROM free_signups fs
JOIN events e ON e.id = fs.event_id
JOIN event_categories ec ON ec.id = fs.category_id
WHERE fs.user_id = @user_id::bigint
ORDER BY fs.created_at DESC, fs.id DESC
LIMIT 100;
