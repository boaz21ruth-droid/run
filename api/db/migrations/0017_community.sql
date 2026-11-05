-- +goose Up
-- 跑团页（v8 设计稿 07）：官方免费活动与跑团发起的跑友活动混排，满员可候补，「今天谁在跑」签到。
-- 跑友活动表 0009 已建；这里补发起的跑团名、城市、候补，以及签到表。
ALTER TABLE community_activities ADD COLUMN host_name text CHECK (host_name IS NULL OR char_length(host_name) BETWEEN 1 AND 40);
ALTER TABLE community_activities ADD COLUMN city text NOT NULL DEFAULT 'Phnom Penh' CHECK (char_length(city) BETWEEN 1 AND 40);
ALTER TABLE community_activities ADD COLUMN waitlist_count int NOT NULL DEFAULT 0 CHECK (waitlist_count >= 0);

-- 报名满员时进候补（WAITLIST）；有人退出时按候补先后自动补上
ALTER TABLE community_activity_joins DROP CONSTRAINT community_activity_joins_status_check;
ALTER TABLE community_activity_joins ADD CONSTRAINT community_activity_joins_status_check
  CHECK (status IN ('JOINED','LEFT','WAITLIST'));
CREATE INDEX community_activity_joins_waitlist_idx ON community_activity_joins (activity_id, joined_at)
  WHERE status = 'WAITLIST';

-- 「今天谁在跑」：一人一行，签到后 8 小时内显示
CREATE TABLE community_checkins (
  user_id        bigint PRIMARY KEY REFERENCES users(id),
  city           text   NOT NULL CHECK (char_length(city) BETWEEN 1 AND 40),
  checked_in_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX community_checkins_recent_idx ON community_checkins (checked_in_at);

-- +goose Down
DROP TABLE community_checkins;
DROP INDEX community_activity_joins_waitlist_idx;
ALTER TABLE community_activity_joins DROP CONSTRAINT community_activity_joins_status_check;
ALTER TABLE community_activity_joins ADD CONSTRAINT community_activity_joins_status_check
  CHECK (status IN ('JOINED','LEFT'));
ALTER TABLE community_activities DROP COLUMN waitlist_count;
ALTER TABLE community_activities DROP COLUMN city;
ALTER TABLE community_activities DROP COLUMN host_name;
