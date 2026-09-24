-- name: InsertEvent :one
INSERT INTO events (slug, event_type, organizer_type, name, city, race_date, created_by)
VALUES (@slug, @event_type, @organizer_type, @name, @city, @race_date, @created_by)
RETURNING *;

-- name: InsertCategory :one
INSERT INTO event_categories (event_id, code, name, distance_m, capacity, start_at, cutoff_at, sort_order)
VALUES (@event_id, @code, @name, @distance_m, @capacity, @start_at, @cutoff_at, @sort_order)
RETURNING *;

-- name: ListEvents :many
SELECT * FROM events
ORDER BY race_date DESC, id DESC;

-- name: ListPublicEvents :many
SELECT * FROM events
WHERE status = 'PUBLISHED' AND public_visible
ORDER BY race_date, id;

-- name: GetPublicEventBySlug :one
SELECT * FROM events
WHERE slug = @slug AND status = 'PUBLISHED' AND public_visible;

-- name: GetEventForUpdate :one
SELECT * FROM events
WHERE id = @id
FOR UPDATE;

-- name: ListCategoriesByEventIDs :many
SELECT * FROM event_categories
WHERE event_id = ANY(@event_ids::bigint[])
ORDER BY event_id, sort_order, id;

-- name: PublishEvent :one
UPDATE events
SET status = 'PUBLISHED',
    public_visible = true,
    published_at = @published_at,
    published_by = @published_by,
    version = version + 1
WHERE id = @id
RETURNING *;

-- name: GetEventByID :one
SELECT * FROM events
WHERE id = @id;

-- name: UpdateEventRegistration :one
UPDATE events
SET registration_open = @registration_open,
    registration_opens_at = sqlc.narg(registration_opens_at),
    registration_closes_at = sqlc.narg(registration_closes_at),
    version = version + 1,
    updated_at = now()
WHERE id = @id
RETURNING *;

-- name: ListCategoryCodesWithoutPriceRule :many
SELECT c.code FROM event_categories c
WHERE c.event_id = @event_id
  AND NOT EXISTS (SELECT 1 FROM category_price_rules cpr WHERE cpr.category_id = c.id)
ORDER BY c.sort_order, c.id;

-- name: CountRegistrationPaymentAccounts :one
SELECT count(*) FROM payment_accounts
WHERE active
  AND currency = 'USD'
  AND scope IN ('REGISTRATION', 'ALL')
  AND (event_id = @event_id::bigint OR event_id IS NULL);

-- name: MinAvailablePriceCentsByEvents :many
-- 批量取多个赛事当前在售价格档中的最低价（分）：销售窗口覆盖当前时间（sale_starts_at
-- 为空或不晚于当前时间，sale_ends_at 为空或晚于当前时间），且配额未用尽（quota 为空或
-- used_count + reserved_count 未达到 quota）。判定口径与 internal/pricing 的 SelectTier 一致。
-- 没有任何在售价格档的赛事不会出现在结果里。
SELECT event_id, min(price_cents)::bigint AS min_price_cents
FROM price_rules
WHERE event_id = ANY(@event_ids::bigint[])
  AND (sale_starts_at IS NULL OR sale_starts_at <= @now::timestamptz)
  AND (sale_ends_at IS NULL OR sale_ends_at > @now::timestamptz)
  AND (quota IS NULL OR used_count + reserved_count < quota)
GROUP BY event_id;
