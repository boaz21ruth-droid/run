-- name: EventExists :one
SELECT EXISTS (SELECT 1 FROM events WHERE id = @id);

-- name: ListCategoryIDsOfEvent :many
SELECT id FROM event_categories
WHERE event_id = @event_id
ORDER BY id;

-- name: InsertPriceRule :one
INSERT INTO price_rules (event_id, name, audience, price_cents, currency, quota, sale_starts_at, sale_ends_at, sort_order)
VALUES (@event_id, @name, @audience, @price_cents, 'USD', sqlc.narg(quota), sqlc.narg(sale_starts_at),
        sqlc.narg(sale_ends_at), @sort_order)
RETURNING *;

-- name: GetPriceRuleForUpdate :one
SELECT * FROM price_rules
WHERE id = @id
FOR UPDATE;

-- name: UpdatePriceRule :one
UPDATE price_rules
SET name = @name,
    audience = @audience,
    price_cents = @price_cents,
    quota = sqlc.narg(quota),
    sale_starts_at = sqlc.narg(sale_starts_at),
    sale_ends_at = sqlc.narg(sale_ends_at),
    sort_order = @sort_order,
    updated_at = now()
WHERE id = @id
RETURNING *;

-- name: ListPriceRulesByEvent :many
SELECT * FROM price_rules
WHERE event_id = @event_id
ORDER BY sort_order, id;

-- name: ListCategoryLinksByRuleIDs :many
SELECT category_id, price_rule_id FROM category_price_rules
WHERE price_rule_id = ANY(@rule_ids::bigint[])
ORDER BY price_rule_id, category_id;

-- name: DeleteCategoryLinksByRule :exec
DELETE FROM category_price_rules
WHERE price_rule_id = @price_rule_id;

-- name: InsertCategoryLink :exec
INSERT INTO category_price_rules (category_id, price_rule_id)
VALUES (@category_id, @price_rule_id);

-- name: InsertCoupon :one
INSERT INTO coupons (code, event_id, discount_type, discount_value, quota, min_runners,
                     valid_from, valid_until, description, status, created_by)
VALUES (@code, sqlc.narg(event_id), @discount_type, @discount_value, @quota, sqlc.narg(min_runners),
        sqlc.narg(valid_from), sqlc.narg(valid_until), sqlc.narg(description), @status, @created_by)
RETURNING *;

-- name: GetCouponForUpdate :one
SELECT * FROM coupons
WHERE id = @id
FOR UPDATE;

-- name: UpdateCoupon :one
UPDATE coupons
SET event_id = sqlc.narg(event_id),
    discount_type = @discount_type,
    discount_value = @discount_value,
    quota = @quota,
    min_runners = sqlc.narg(min_runners),
    valid_from = sqlc.narg(valid_from),
    valid_until = sqlc.narg(valid_until),
    description = sqlc.narg(description),
    status = @status
WHERE id = @id
RETURNING *;

-- name: ListCoupons :many
SELECT * FROM coupons
WHERE (sqlc.narg(event_id)::bigint IS NULL OR event_id = sqlc.narg(event_id)::bigint)
ORDER BY created_at DESC, id DESC;

-- name: QuoteListCategories :many
SELECT id, min_age
FROM event_categories
WHERE event_id = @event_id AND id = ANY(@category_ids::bigint[]);

-- name: QuoteListTierCandidates :many
SELECT cpr.category_id,
       pr.id AS price_rule_id,
       pr.audience,
       pr.price_cents,
       pr.quota,
       pr.used_count,
       pr.reserved_count,
       pr.sale_starts_at,
       pr.sale_ends_at,
       pr.sort_order
FROM category_price_rules cpr
JOIN price_rules pr ON pr.id = cpr.price_rule_id
WHERE pr.event_id = @event_id
  AND cpr.category_id = ANY(@category_ids::bigint[])
ORDER BY cpr.category_id, pr.id;

-- name: QuoteGetCouponByCode :one
SELECT id, event_id, discount_type, discount_value, quota, used_count, reserved_count,
       min_runners, valid_from, valid_until, status
FROM coupons
WHERE code = @code;

-- name: QuoteLockPaymentAccount :exec
SELECT pg_advisory_xact_lock(7301, @payment_account_id::int);

-- name: QuoteListOpenOrderAmounts :many
SELECT amount_cents
FROM reg_orders
WHERE payment_account_id = @payment_account_id::bigint
  AND status IN ('PENDING_PAYMENT', 'PROOF_SUBMITTED', 'PROOF_REJECTED');

-- name: ReserveCategorySeats :execrows
UPDATE event_categories
SET reserved_count = reserved_count + @seats::int
WHERE id = @id
  AND used_count + reserved_count + @seats::int <= capacity;

-- name: ReservePriceRuleSeats :execrows
UPDATE price_rules
SET reserved_count = reserved_count + @seats::int
WHERE id = @id
  AND (quota IS NULL OR used_count + reserved_count + @seats::int <= quota);

-- name: ReserveCouponUse :execrows
UPDATE coupons
SET reserved_count = reserved_count + 1
WHERE id = @id
  AND status = 'ACTIVE'
  AND used_count + reserved_count + 1 <= quota;

-- name: InsertCouponRedemption :exec
INSERT INTO coupon_redemptions (order_id, coupon_id, state, discount_cents)
VALUES (@order_id, @coupon_id, 'RESERVED', @discount_cents);

-- name: LockCategoriesForOrders :exec
-- 批量释放前按 id 升序锁住这些订单涉及的组别行（与 UPDATE 同为 NO KEY UPDATE，不挡外键检查）。
SELECT id FROM event_categories
WHERE id IN (SELECT DISTINCT category_id FROM order_participants WHERE order_id = ANY(@order_ids::bigint[]))
ORDER BY id
FOR NO KEY UPDATE;

-- name: LockPriceRulesForOrders :exec
SELECT id FROM price_rules
WHERE id IN (SELECT DISTINCT price_rule_id FROM order_participants WHERE order_id = ANY(@order_ids::bigint[]))
ORDER BY id
FOR NO KEY UPDATE;

-- name: LockCouponsForOrders :exec
SELECT id FROM coupons
WHERE id IN (SELECT DISTINCT coupon_id FROM coupon_redemptions WHERE order_id = ANY(@order_ids::bigint[]) AND state = 'RESERVED')
ORDER BY id
FOR NO KEY UPDATE;

-- name: ListOrderCategorySeats :many
SELECT category_id, count(*)::int AS seats
FROM order_participants
WHERE order_id = @order_id
GROUP BY category_id
ORDER BY category_id;

-- name: ListOrderPriceRuleSeats :many
SELECT price_rule_id, count(*)::int AS seats
FROM order_participants
WHERE order_id = @order_id
GROUP BY price_rule_id
ORDER BY price_rule_id;

-- name: ConsumeCategorySeats :execrows
UPDATE event_categories
SET reserved_count = reserved_count - @seats::int,
    used_count = used_count + @seats::int
WHERE id = @id AND reserved_count >= @seats::int;

-- name: ConsumePriceRuleSeats :execrows
UPDATE price_rules
SET reserved_count = reserved_count - @seats::int,
    used_count = used_count + @seats::int
WHERE id = @id AND reserved_count >= @seats::int;

-- name: ReleaseCategorySeats :execrows
UPDATE event_categories
SET reserved_count = reserved_count - @seats::int
WHERE id = @id AND reserved_count >= @seats::int;

-- name: ReleasePriceRuleSeats :execrows
UPDATE price_rules
SET reserved_count = reserved_count - @seats::int
WHERE id = @id AND reserved_count >= @seats::int;

-- name: MarkCouponRedemption :one
UPDATE coupon_redemptions
SET state = @to_state::text, updated_at = now()
WHERE order_id = @order_id AND state = 'RESERVED'
RETURNING coupon_id;

-- name: ConsumeCouponUse :execrows
UPDATE coupons
SET reserved_count = reserved_count - 1,
    used_count = used_count + 1
WHERE id = @id AND reserved_count >= 1;

-- name: ReleaseCouponUse :execrows
UPDATE coupons
SET reserved_count = reserved_count - 1
WHERE id = @id AND reserved_count >= 1;
