-- 领物核销站（v8 第 8 屏）。领物名单由 registrations 派生；race_pack_facts 只存领没领、核验过没有。

-- name: ActiveAssignment :one
-- 现场角色（摄影师 / 现场主管 / 现场工作人员）只能操作被指派、启用且在有效期内的赛事（D-019）。
SELECT EXISTS (
  SELECT 1 FROM staff_event_assignments
  WHERE staff_id = @staff_id AND event_id = @event_id AND enabled
    AND valid_from <= @now::timestamptz AND valid_until > @now::timestamptz
)::boolean AS ok;

-- name: ListAssignedRaceEvents :many
SELECT e.id, e.name, e.city, e.race_date, e.timezone, a.valid_until
FROM staff_event_assignments a
JOIN events e ON e.id = a.event_id
WHERE a.staff_id = @staff_id AND a.enabled
  AND a.valid_from <= @now::timestamptz AND a.valid_until > @now::timestamptz
  AND e.status = 'PUBLISHED' AND e.event_type = 'RACE'
ORDER BY e.race_date, e.id;

-- name: ListAllRaceEvents :many
SELECT e.id, e.name, e.city, e.race_date, e.timezone
FROM events e
WHERE e.status = 'PUBLISHED' AND e.event_type = 'RACE'
ORDER BY e.race_date DESC, e.id DESC;

-- name: GetRaceEvent :one
SELECT id, name, city, race_date, timezone, event_type, status FROM events WHERE id = @id;

-- name: RacepackStats :one
-- 已确认的报名数与其中已领数
SELECT count(*)::int AS confirmed,
       count(*) FILTER (WHERE f.picked)::int AS picked
FROM registrations r
LEFT JOIN race_pack_facts f ON f.registration_id = r.id
WHERE r.event_id = @event_id AND r.status = 'CONFIRMED';

-- name: SearchRacepack :many
-- 按参考码（订单号 / 报名号 / 凭证码）、号码布、姓名、手机号尾号搜索；不过滤状态，
-- 这样未付款、已取消的人也能搜到并被明确拦下。
SELECT r.id, r.reg_no, o.order_no, r.status, r.full_name, r.tshirt_size, r.phone_e164,
       op.audience, c.name AS category_name, c.code AS category_code, o.status AS order_status,
       b.bib_number, br.display_digits,
       coalesce(f.picked, false)::boolean AS picked, f.picked_at, f.proxy_name,
       coalesce(f.id_verified, false)::boolean AS id_verified,
       s.full_name AS picked_by_name
FROM registrations r
JOIN order_participants op ON op.id = r.order_participant_id
JOIN reg_orders o ON o.id = op.order_id
JOIN event_categories c ON c.id = r.category_id
LEFT JOIN bib_assignments b ON b.registration_id = r.id AND b.status = 'ASSIGNED'
LEFT JOIN bib_ranges br ON br.category_id = r.category_id
LEFT JOIN race_pack_facts f ON f.registration_id = r.id
LEFT JOIN staff s ON s.id = f.picked_by
WHERE r.event_id = @event_id
  AND (
    upper(o.order_no) = upper(@q::text)
    OR upper(r.reg_no) = upper(@q::text)
    OR r.ticket_code = @q::text
    OR (@bib::int > 0 AND b.bib_number = @bib::int)
    OR r.full_name ILIKE '%' || @q::text || '%'
    OR (length(@digits::text) >= 4 AND r.phone_e164 LIKE '%' || @digits::text)
  )
ORDER BY (r.status = 'CONFIRMED') DESC, r.full_name, r.id
LIMIT 20;

-- name: RecentRacepackIssues :many
SELECT l.registration_id, l.occurred_at, l.proxy_name, r.full_name, b.bib_number, br.display_digits,
       s.full_name AS staff_name
FROM race_pack_scan_logs l
JOIN registrations r ON r.id = l.registration_id
JOIN staff s ON s.id = l.staff_id
LEFT JOIN bib_assignments b ON b.registration_id = r.id AND b.status = 'ASSIGNED'
LEFT JOIN bib_ranges br ON br.category_id = r.category_id
WHERE l.event_id = @event_id AND l.action = 'ISSUE' AND l.outcome = 'APPLIED'
ORDER BY l.synced_at DESC, l.id DESC
LIMIT 8;

-- name: LockRegistrationForRacepack :one
SELECT r.id, r.event_id, r.status, op.audience
FROM registrations r
JOIN order_participants op ON op.id = r.order_participant_id
WHERE r.id = @id
FOR UPDATE OF r;

-- name: GetScanLogByClientID :one
SELECT id, registration_id, action, outcome FROM race_pack_scan_logs WHERE client_event_id = @client_event_id;

-- name: GetRacepackFactForUpdate :one
SELECT registration_id, picked, id_verified FROM race_pack_facts WHERE registration_id = @registration_id FOR UPDATE;

-- name: UpsertRacepackIssued :exec
INSERT INTO race_pack_facts (registration_id, picked, picked_at, picked_by, device_id, proxy_name,
                             id_verified, verified_at, verified_by)
VALUES (@registration_id, true, @now::timestamptz, @staff_id, @device_id, sqlc.narg('proxy_name'),
        @id_verified::boolean, CASE WHEN @id_verified::boolean THEN @now::timestamptz END,
        CASE WHEN @id_verified::boolean THEN @staff_id::bigint END)
ON CONFLICT (registration_id) DO UPDATE SET
  picked = true, picked_at = excluded.picked_at, picked_by = excluded.picked_by,
  device_id = excluded.device_id, proxy_name = excluded.proxy_name,
  id_verified = race_pack_facts.id_verified OR excluded.id_verified,
  verified_at = coalesce(race_pack_facts.verified_at, excluded.verified_at),
  verified_by = coalesce(race_pack_facts.verified_by, excluded.verified_by);

-- name: MarkRacepackUndone :exec
UPDATE race_pack_facts
SET picked = false, picked_at = NULL, picked_by = NULL, proxy_name = NULL, device_id = @device_id
WHERE registration_id = @registration_id;

-- name: InsertScanLog :exec
INSERT INTO race_pack_scan_logs (client_event_id, registration_id, event_id, action, outcome, reason,
                                 staff_id, device_id, occurred_at, proxy_name)
VALUES (@client_event_id, @registration_id, @event_id, @action, @outcome, sqlc.narg('reason'),
        @staff_id, @device_id, @occurred_at::timestamptz, sqlc.narg('proxy_name'));

-- name: GetRacepackEntry :one
SELECT r.id, r.reg_no, o.order_no, r.status, r.full_name, r.tshirt_size, r.phone_e164,
       op.audience, c.name AS category_name, c.code AS category_code, o.status AS order_status,
       b.bib_number, br.display_digits,
       coalesce(f.picked, false)::boolean AS picked, f.picked_at, f.proxy_name,
       coalesce(f.id_verified, false)::boolean AS id_verified,
       s.full_name AS picked_by_name
FROM registrations r
JOIN order_participants op ON op.id = r.order_participant_id
JOIN reg_orders o ON o.id = op.order_id
JOIN event_categories c ON c.id = r.category_id
LEFT JOIN bib_assignments b ON b.registration_id = r.id AND b.status = 'ASSIGNED'
LEFT JOIN bib_ranges br ON br.category_id = r.category_id
LEFT JOIN race_pack_facts f ON f.registration_id = r.id
LEFT JOIN staff s ON s.id = f.picked_by
WHERE r.id = @id;

-- name: ListStaff :many
SELECT id, username, full_name, role, status FROM staff ORDER BY role, username;

-- name: ListEventAssignments :many
SELECT a.staff_id, s.username, s.full_name, s.role, a.valid_from, a.valid_until, a.enabled
FROM staff_event_assignments a
JOIN staff s ON s.id = a.staff_id
WHERE a.event_id = @event_id
ORDER BY s.role, s.username;

-- name: GetStaffRole :one
SELECT role, status FROM staff WHERE id = @id;

-- name: UpsertEventAssignment :exec
INSERT INTO staff_event_assignments (staff_id, event_id, valid_from, valid_until, enabled, created_by)
VALUES (@staff_id, @event_id, @valid_from, @valid_until, @enabled, @created_by)
ON CONFLICT (staff_id, event_id) DO UPDATE SET
  valid_from = excluded.valid_from, valid_until = excluded.valid_until, enabled = excluded.enabled;
