-- name: GetVolunteerEventBySlug :one
SELECT id, slug, timezone, volunteer_open, volunteer_dates, volunteer_note
FROM events
WHERE slug = @slug AND status = 'PUBLISHED' AND public_visible AND event_type = 'RACE';

-- name: GetVolunteerEvent :one
SELECT id, slug, timezone, volunteer_open, volunteer_dates, volunteer_note
FROM events
WHERE id = @id AND event_type = 'RACE';

-- name: LockVolunteerEvent :one
SELECT id, volunteer_open, volunteer_dates
FROM events
WHERE id = @id
FOR SHARE;

-- name: UpdateVolunteerSettings :execrows
UPDATE events
SET volunteer_open = @volunteer_open,
    volunteer_dates = @volunteer_dates::date[],
    volunteer_note = @volunteer_note,
    version = version + 1
WHERE id = @id AND event_type = 'RACE';

-- name: ListVolunteerRoles :many
SELECT * FROM volunteer_roles
WHERE event_id = @event_id
ORDER BY sort_order, id;

-- name: InsertVolunteerRole :one
INSERT INTO volunteer_roles (event_id, name, schedule, capacity, sort_order)
VALUES (@event_id, @name, @schedule, @capacity, @sort_order)
RETURNING id;

-- name: LockVolunteerRole :one
SELECT * FROM volunteer_roles
WHERE id = @id
FOR UPDATE;

-- name: UpdateVolunteerRole :exec
UPDATE volunteer_roles
SET name = @name, schedule = @schedule, capacity = @capacity, sort_order = @sort_order, active = @active
WHERE id = @id;

-- name: TakeVolunteerSeat :execrows
UPDATE volunteer_roles
SET assigned_count = assigned_count + 1
WHERE id = @id AND active AND assigned_count < capacity;

-- name: ReleaseVolunteerSeat :execrows
UPDATE volunteer_roles
SET assigned_count = assigned_count - 1
WHERE id = @id AND assigned_count >= 1;

-- name: GetMyVolunteerApplication :one
-- 最近一份申请（含已拒绝 / 撤回），给跑者看状态
SELECT a.*, r.name AS assigned_role_name
FROM volunteer_applications a
LEFT JOIN volunteer_roles r ON r.id = a.assigned_role_id
WHERE a.event_id = @event_id AND a.user_id = @user_id
ORDER BY a.created_at DESC, a.id DESC
LIMIT 1;

-- name: InsertVolunteerApplication :one
INSERT INTO volunteer_applications (
  event_id, user_id, full_name, phone_e164, full_availability, dates, role_ids, tshirt_size, note, media_consent
) VALUES (
  @event_id, @user_id, @full_name, @phone_e164, @full_availability, @dates::date[], @role_ids::bigint[],
  sqlc.narg(tshirt_size), sqlc.narg(note), @media_consent
)
RETURNING id;

-- name: ListVolunteerApplications :many
-- 待处理在前，其余按提交时间倒序
SELECT a.*, u.telegram_username
FROM volunteer_applications a
JOIN users u ON u.id = a.user_id
WHERE a.event_id = @event_id
ORDER BY (a.status = 'PENDING') DESC, (a.status = 'WAITLIST') DESC, a.created_at DESC, a.id DESC
LIMIT 1000;

-- name: LockVolunteerApplication :one
SELECT * FROM volunteer_applications
WHERE id = @id
FOR UPDATE;

-- name: LockMyActiveVolunteerApplication :one
SELECT * FROM volunteer_applications
WHERE event_id = @event_id AND user_id = @user_id AND status NOT IN ('REJECTED','WITHDRAWN')
FOR UPDATE;

-- name: SetVolunteerApplicationStatus :exec
UPDATE volunteer_applications
SET status = @status,
    assigned_role_id = sqlc.narg(assigned_role_id),
    review_note = sqlc.narg(review_note),
    reviewed_by = sqlc.narg(reviewed_by),
    reviewed_at = sqlc.narg(reviewed_at)
WHERE id = @id;

-- name: WithdrawVolunteerApplication :exec
UPDATE volunteer_applications
SET status = 'WITHDRAWN', assigned_role_id = NULL
WHERE id = @id;
