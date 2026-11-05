-- +goose Up
-- 报名规则与精英组资格（v8 设计稿 03、04）。
--
-- 退改政策由主办方按赛事设置，报名确认页与赛事页照着展示；退款仍由财务按退款流程办理。
-- 格式：{"tiers":[{"days":14,"percent":80},{"days":7,"percent":50}],"transferDays":3}
--   tiers：开赛前至少 days 天申请退 percent%，按 days 从大到小；不在任何一档内的不退
--   transferDays：开赛前至少几天可以转让给他人；null 表示不接受转让
ALTER TABLE events ADD COLUMN refund_policy jsonb;

-- 精英组：报名时自报最好成绩并附证明链接，主办方核验；不通过转到 fallback 组（通常是同距离公开组）。
ALTER TABLE event_categories ADD COLUMN qualify_required boolean NOT NULL DEFAULT false;
ALTER TABLE event_categories ADD COLUMN qualify_rule jsonb;          -- 资格说明（三语），如「近两年 21K 1:45 以内」
ALTER TABLE event_categories ADD COLUMN qualify_max_ms int CHECK (qualify_max_ms IS NULL OR qualify_max_ms > 0);
ALTER TABLE event_categories ADD COLUMN fallback_category_id bigint REFERENCES event_categories(id);
ALTER TABLE event_categories ADD CONSTRAINT event_categories_qualify_complete
  CHECK (NOT qualify_required OR (qualify_rule IS NOT NULL AND fallback_category_id IS NOT NULL));
ALTER TABLE event_categories ADD CONSTRAINT event_categories_fallback_not_self
  CHECK (fallback_category_id IS NULL OR fallback_category_id <> id);

-- 资格证明：一个参赛名额一份。核验只在报名确认（已付款）后进行：名额此时已计入 used_count，
-- 不通过时把 registrations.category_id 换到 fallback 组并搬一个 used_count；order_participants 的财务快照不动。
CREATE TABLE qualification_proofs (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  registration_id       bigint NOT NULL UNIQUE REFERENCES registrations(id),
  event_id              bigint NOT NULL REFERENCES events(id),
  category_id           bigint NOT NULL REFERENCES event_categories(id),   -- 报名的精英组
  best_time_ms          int    NOT NULL CHECK (best_time_ms > 0),
  source                text   NOT NULL CHECK (char_length(source) BETWEEN 1 AND 100),
  proof_url             text   NOT NULL CHECK (proof_url ~ '^https?://' AND char_length(proof_url) <= 300),
  status                text   NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  review_note           text   CHECK (review_note IS NULL OR char_length(review_note) <= 200),
  moved_to_category_id  bigint REFERENCES event_categories(id),
  reviewed_by           bigint REFERENCES staff(id),
  reviewed_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'PENDING') = (reviewed_at IS NULL)),
  CHECK ((status = 'REJECTED') = (moved_to_category_id IS NOT NULL))
);
CREATE INDEX qualification_proofs_event_idx ON qualification_proofs (event_id, status, created_at);
CREATE TRIGGER qualification_proofs_updated BEFORE UPDATE ON qualification_proofs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- +goose Down
DROP TABLE qualification_proofs;
ALTER TABLE event_categories DROP CONSTRAINT event_categories_fallback_not_self;
ALTER TABLE event_categories DROP CONSTRAINT event_categories_qualify_complete;
ALTER TABLE event_categories DROP COLUMN fallback_category_id;
ALTER TABLE event_categories DROP COLUMN qualify_max_ms;
ALTER TABLE event_categories DROP COLUMN qualify_rule;
ALTER TABLE event_categories DROP COLUMN qualify_required;
ALTER TABLE events DROP COLUMN refund_policy;
