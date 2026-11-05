-- name: ListFeedActivities :many
-- 跑团发起的活动：已发布、未冻结、还没结束（开始后 2 小时内仍显示）
SELECT a.id, a.title, a.tag, a.starts_at, a.location, a.meet_point, a.distance_text, a.capacity, a.joined_count,
       a.waitlist_count, a.fee_note, a.host_name, a.city, u.display_name AS author_name
FROM community_activities a
JOIN users u ON u.id = a.author_user_id
WHERE a.status = 'PUBLISHED' AND NOT a.frozen AND a.starts_at > @since
ORDER BY a.starts_at, a.id
LIMIT 100;

-- name: ListFeedOfficialEvents :many
-- 官方免费活动：已发布、公开、日期不早于今天
SELECT e.id, e.slug, e.name, e.city, e.venue, e.race_date, e.timezone, e.cover_file_id, e.registration_open,
       coalesce((SELECT min(c.start_at) FROM event_categories c WHERE c.event_id = e.id),
                (e.race_date + time '06:00') AT TIME ZONE e.timezone)::timestamptz AS starts_at,
       (SELECT coalesce(sum(c.capacity), 0) FROM event_categories c WHERE c.event_id = e.id)::int AS capacity,
       (SELECT coalesce(sum(c.used_count), 0) FROM event_categories c WHERE c.event_id = e.id)::int AS joined
FROM events e
WHERE e.event_type = 'FREE_ACTIVITY' AND e.status = 'PUBLISHED' AND e.public_visible AND e.race_date >= @today::date
ORDER BY e.race_date, e.id
LIMIT 50;

-- name: ListJoinerNames :many
-- 每个活动最早报名的 3 位跑者显示名（只用来生成头像缩写）
SELECT activity_id, display_name
FROM (
  SELECT j.activity_id, u.display_name, row_number() OVER (PARTITION BY j.activity_id ORDER BY j.joined_at, j.user_id) AS n
  FROM community_activity_joins j
  JOIN users u ON u.id = j.user_id
  WHERE j.activity_id = ANY(@activity_ids::bigint[]) AND j.status = 'JOINED'
) ranked
WHERE n <= 3
ORDER BY activity_id, n;

-- name: ListRecentCheckins :many
SELECT c.user_id, u.display_name, c.city, c.checked_in_at
FROM community_checkins c
JOIN users u ON u.id = c.user_id
WHERE c.checked_in_at > @since
ORDER BY c.checked_in_at DESC
LIMIT 30;

-- name: UpsertCheckin :exec
INSERT INTO community_checkins (user_id, city, checked_in_at)
VALUES (@user_id, @city, @checked_in_at)
ON CONFLICT (user_id) DO UPDATE SET city = EXCLUDED.city, checked_in_at = EXCLUDED.checked_in_at;

-- name: DeleteCheckin :exec
DELETE FROM community_checkins WHERE user_id = @user_id;

-- name: GetActivity :one
SELECT sqlc.embed(a), u.display_name AS author_name
FROM community_activities a
JOIN users u ON u.id = a.author_user_id
WHERE a.id = @id;

-- name: LockActivity :one
SELECT * FROM community_activities
WHERE id = @id
FOR UPDATE;

-- name: ReviewRequiredDefault :one
SELECT coalesce((SELECT value FROM system_settings WHERE key = 'community.review_required_default'), 'true'::jsonb)::boolean;

-- name: InsertActivity :one
INSERT INTO community_activities (
  author_user_id, review_required, signature_id, title, tag, starts_at, location, meet_point, distance_text,
  capacity, fee_note, contact_telegram, contact_phone, contact_visibility, body, status, host_name, city
) VALUES (
  @author_user_id, @review_required, @signature_id, @title, @tag, @starts_at, @location, @meet_point,
  sqlc.narg(distance_text), @capacity, @fee_note, sqlc.narg(contact_telegram), sqlc.narg(contact_phone),
  @contact_visibility, @body, @status, sqlc.narg(host_name), @city
)
RETURNING id;

-- name: ListMyActivities :many
SELECT sqlc.embed(a), u.display_name AS author_name
FROM community_activities a
JOIN users u ON u.id = a.author_user_id
WHERE a.author_user_id = @user_id
ORDER BY a.created_at DESC, a.id DESC
LIMIT 50;

-- name: GetJoin :one
SELECT status, joined_at FROM community_activity_joins
WHERE activity_id = @activity_id AND user_id = @user_id;

-- name: UpsertJoin :exec
INSERT INTO community_activity_joins (activity_id, user_id, status, joined_at, left_at)
VALUES (@activity_id, @user_id, @status, @joined_at, NULL)
ON CONFLICT (activity_id, user_id) DO UPDATE SET status = EXCLUDED.status, joined_at = EXCLUDED.joined_at, left_at = NULL;

-- name: LeaveJoin :exec
UPDATE community_activity_joins
SET status = 'LEFT', left_at = @left_at
WHERE activity_id = @activity_id AND user_id = @user_id;

-- name: FirstWaitlisted :one
SELECT user_id FROM community_activity_joins
WHERE activity_id = @activity_id AND status = 'WAITLIST'
ORDER BY joined_at, user_id
LIMIT 1
FOR UPDATE;

-- name: PromoteJoin :exec
UPDATE community_activity_joins SET status = 'JOINED'
WHERE activity_id = @activity_id AND user_id = @user_id;

-- name: SetActivityCounts :exec
UPDATE community_activities
SET joined_count = @joined_count, waitlist_count = @waitlist_count
WHERE id = @id;

-- name: InsertContactView :exec
INSERT INTO contact_view_logs (activity_id, viewer_user_id, contact_type, viewer_joined, ip)
VALUES (@activity_id, @viewer_user_id, @contact_type, @viewer_joined, @ip);

-- name: CloseActivity :exec
UPDATE community_activities SET status = 'CLOSED' WHERE id = @id;

-- name: ListAdminActivities :many
SELECT sqlc.embed(a), u.display_name AS author_name, u.telegram_username AS author_telegram
FROM community_activities a
JOIN users u ON u.id = a.author_user_id
WHERE (sqlc.narg(status)::text IS NULL OR a.status = sqlc.narg(status)::text)
ORDER BY (a.status = 'REVIEWING') DESC, a.created_at DESC, a.id DESC
LIMIT 200;

-- name: ReviewActivity :exec
UPDATE community_activities
SET status = @status, reject_code = sqlc.narg(reject_code), reviewed_by = @reviewed_by, reviewed_at = @reviewed_at
WHERE id = @id;

-- name: FreezeActivity :exec
UPDATE community_activities
SET frozen = true, freeze_reason = @freeze_reason, frozen_by = @frozen_by, frozen_at = @frozen_at
WHERE id = @id;

-- name: UnfreezeActivity :exec
UPDATE community_activities
SET frozen = false, freeze_reason = NULL, frozen_by = NULL, frozen_at = NULL
WHERE id = @id;
