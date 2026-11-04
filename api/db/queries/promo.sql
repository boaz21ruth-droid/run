-- 推荐渠道与免费入场（v8 设计稿 02、10）

-- name: PromoEventExists :one
SELECT EXISTS (SELECT 1 FROM events WHERE id = @id);

-- name: VisitReferral :one
-- 打开推荐链接计一次点击；链接停用或赛事未公开时不计、返回空
UPDATE referral_links rl
SET click_count = rl.click_count + 1
FROM events e
WHERE rl.slug = @slug AND rl.status = 'ACTIVE'
  AND e.id = rl.event_id AND e.status = 'PUBLISHED' AND e.public_visible
RETURNING e.slug AS event_slug, rl.label, rl.kind, rl.coupon_id;

-- name: GetReferralCoupon :one
SELECT id, code, discount_type, discount_value, quota, used_count, reserved_count, status,
       valid_from, valid_until
FROM coupons WHERE id = @id;

-- name: ListReferralLinks :many
SELECT rl.*,
       c.code AS coupon_code, c.discount_type AS coupon_discount_type, c.discount_value AS coupon_discount_value,
       c.quota AS coupon_quota, c.used_count AS coupon_used_count, c.reserved_count AS coupon_reserved_count,
       c.status AS coupon_status,
       (SELECT count(*) FROM reg_orders o WHERE o.referral_link_id = rl.id)::int AS orders,
       (SELECT count(*) FROM reg_orders o WHERE o.referral_link_id = rl.id
          AND o.status IN ('PAID','PARTIALLY_REFUNDED'))::int AS paid_orders
FROM referral_links rl
LEFT JOIN coupons c ON c.id = rl.coupon_id
WHERE rl.event_id = @event_id
ORDER BY rl.created_at, rl.id;

-- name: GetReferralLink :one
SELECT rl.*,
       c.code AS coupon_code, c.discount_type AS coupon_discount_type, c.discount_value AS coupon_discount_value,
       c.quota AS coupon_quota, c.used_count AS coupon_used_count, c.reserved_count AS coupon_reserved_count,
       c.status AS coupon_status,
       (SELECT count(*) FROM reg_orders o WHERE o.referral_link_id = rl.id)::int AS orders,
       (SELECT count(*) FROM reg_orders o WHERE o.referral_link_id = rl.id
          AND o.status IN ('PAID','PARTIALLY_REFUNDED'))::int AS paid_orders
FROM referral_links rl
LEFT JOIN coupons c ON c.id = rl.coupon_id
WHERE rl.id = @id;

-- name: DirectOrderStats :one
SELECT count(*)::int AS orders,
       count(*) FILTER (WHERE status IN ('PAID','PARTIALLY_REFUNDED'))::int AS paid_orders
FROM reg_orders
WHERE event_id = @event_id AND referral_link_id IS NULL;

-- name: InsertPromoCoupon :one
INSERT INTO coupons (code, event_id, discount_type, discount_value, quota, max_runners, owner_user_id, status, created_by)
VALUES (@code, @event_id, @discount_type, @discount_value, @quota, sqlc.narg(max_runners), sqlc.narg(owner_user_id), 'ACTIVE', @created_by)
RETURNING id;

-- name: InsertReferralLink :one
INSERT INTO referral_links (event_id, slug, label, kind, coupon_id, created_by)
VALUES (@event_id, @slug, @label, @kind, sqlc.narg(coupon_id), @created_by)
RETURNING id;

-- name: LockReferralLink :one
SELECT id, event_id, label, status, coupon_id FROM referral_links WHERE id = @id FOR UPDATE;

-- name: UpdateReferralLink :exec
UPDATE referral_links SET label = @label, status = @status WHERE id = @id;

-- name: SetCouponStatus :exec
UPDATE coupons SET status = @status WHERE id = @id;

-- name: GetCompEvent :one
SELECT id, event_type, status, public_visible, comp_quota FROM events WHERE slug = @slug;

-- name: GetCompQuota :one
SELECT comp_quota FROM events WHERE id = @id;

-- name: LockCompEvent :one
SELECT comp_quota FROM events WHERE id = @id FOR UPDATE;

-- name: SetCompQuota :exec
UPDATE events SET comp_quota = sqlc.narg(comp_quota), version = version + 1, updated_at = now() WHERE id = @id;

-- name: CompCounts :one
SELECT count(*) FILTER (WHERE status = 'APPROVED')::int AS approved,
       count(*) FILTER (WHERE status = 'PENDING')::int AS pending
FROM comp_requests WHERE event_id = @event_id;

-- name: GetMyCompRequest :one
-- 本人最近一条申请（被拒后可能还有更早的记录）
SELECT cr.*, c.code AS coupon_code
FROM comp_requests cr
LEFT JOIN coupons c ON c.id = cr.coupon_id
WHERE cr.event_id = @event_id AND cr.user_id = @user_id
ORDER BY cr.created_at DESC, cr.id DESC
LIMIT 1;

-- name: InsertCompRequest :one
INSERT INTO comp_requests (event_id, user_id, applicant_name, kind, profile_url, audience, note)
VALUES (@event_id, @user_id, @applicant_name, @kind, sqlc.narg(profile_url), sqlc.narg(audience), sqlc.narg(note))
RETURNING id;

-- name: ListCompRequests :many
SELECT cr.*, c.code AS coupon_code, (COALESCE(c.used_count, 0) > 0)::bool AS coupon_used,
       u.telegram_username
FROM comp_requests cr
JOIN users u ON u.id = cr.user_id
LEFT JOIN coupons c ON c.id = cr.coupon_id
WHERE cr.event_id = @event_id
ORDER BY (cr.status = 'PENDING') DESC, cr.created_at DESC, cr.id DESC;

-- name: GetCompRequest :one
SELECT cr.*, c.code AS coupon_code, (COALESCE(c.used_count, 0) > 0)::bool AS coupon_used,
       u.telegram_username
FROM comp_requests cr
JOIN users u ON u.id = cr.user_id
LEFT JOIN coupons c ON c.id = cr.coupon_id
WHERE cr.id = @id;

-- name: LockCompRequest :one
SELECT id, event_id, user_id, applicant_name, status FROM comp_requests WHERE id = @id FOR UPDATE;

-- name: ApproveCompRequest :exec
UPDATE comp_requests
SET status = 'APPROVED', coupon_id = @coupon_id, reviewed_by = @reviewed_by, reviewed_at = @reviewed_at
WHERE id = @id;

-- name: RejectCompRequest :exec
UPDATE comp_requests
SET status = 'REJECTED', review_note = sqlc.narg(review_note), reviewed_by = @reviewed_by, reviewed_at = @reviewed_at
WHERE id = @id;
