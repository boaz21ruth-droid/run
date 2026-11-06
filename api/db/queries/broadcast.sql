-- name: GetBroadcastEvent :one
SELECT id, slug, name, event_type FROM events WHERE id = @id;

-- name: LockBroadcastEvent :exec
SELECT id FROM events WHERE id = @id FOR UPDATE;

-- name: AudiencePaid :many
-- 已确认的报名（赛事）与有效的免费活动报名
SELECT DISTINCT user_id::bigint FROM (
  SELECT r.user_id FROM registrations r
  WHERE r.event_id = @event_id AND r.status = 'CONFIRMED' AND r.user_id IS NOT NULL
  UNION
  SELECT fs.user_id FROM free_signups fs
  WHERE fs.event_id = @event_id AND fs.status = 'REGISTERED' AND fs.user_id IS NOT NULL
) u;

-- name: AudiencePending :many
SELECT DISTINCT o.buyer_user_id::bigint FROM reg_orders o
WHERE o.event_id = @event_id AND o.status IN ('PENDING_PAYMENT','PROOF_SUBMITTED','PROOF_REJECTED')
  AND o.buyer_user_id IS NOT NULL;

-- name: AudienceElite :many
SELECT DISTINCT r.user_id::bigint FROM qualification_proofs q
JOIN registrations r ON r.id = q.registration_id
WHERE q.event_id = @event_id AND q.status <> 'REJECTED' AND r.status = 'CONFIRMED' AND r.user_id IS NOT NULL;

-- name: AudienceVolunteers :many
SELECT DISTINCT user_id FROM volunteer_applications
WHERE event_id = @event_id AND status = 'ASSIGNED';

-- name: CountRecentDuplicate :one
SELECT count(*) FROM event_broadcasts
WHERE event_id = @event_id AND audience = @audience AND body = @body AND created_at > @since;

-- name: InsertBroadcast :one
INSERT INTO event_broadcasts (event_id, audience, body, recipient_count, created_by)
VALUES (@event_id, @audience, @body, @recipient_count, @created_by)
RETURNING id, created_at;

-- name: InsertBroadcastRecipients :exec
INSERT INTO event_broadcast_recipients (broadcast_id, user_id)
SELECT @broadcast_id, unnest(@user_ids::bigint[]);

-- name: ListBroadcasts :many
SELECT b.id, b.audience, b.body, b.recipient_count, b.created_at, s.full_name AS sender_name,
       (SELECT count(*) FROM notification_logs l
        WHERE l.entity_type = 'event_broadcast' AND l.entity_id = b.id AND l.status = 'SENT')::int AS sent_count,
       (SELECT count(*) FROM notification_logs l
        WHERE l.entity_type = 'event_broadcast' AND l.entity_id = b.id AND l.status = 'FAILED')::int AS failed_count
FROM event_broadcasts b
JOIN staff s ON s.id = b.created_by
WHERE b.event_id = @event_id
ORDER BY b.created_at DESC, b.id DESC
LIMIT 50;

-- name: ListMyNotices :many
SELECT b.id, b.body, b.created_at, e.slug AS event_slug, e.name AS event_name
FROM event_broadcast_recipients br
JOIN event_broadcasts b ON b.id = br.broadcast_id
JOIN events e ON e.id = b.event_id
WHERE br.user_id = @user_id
ORDER BY b.created_at DESC, b.id DESC
LIMIT 20;
