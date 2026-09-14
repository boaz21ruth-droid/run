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
