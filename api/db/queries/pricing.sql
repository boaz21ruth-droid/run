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
