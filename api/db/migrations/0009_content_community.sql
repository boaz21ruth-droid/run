-- +goose Up
-- =====================================================================
-- 0009 · 官方活动内容 / 跑友活动（UGC）/ 免责声明签署 / 社区 / 通知 / 告警
-- =====================================================================

-- 官方活动内容（RUN Ops 代发；D-043）
CREATE TABLE contents (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title                jsonb  NOT NULL,
  summary              jsonb,
  body                 jsonb,
  cta_label            jsonb,
  cover_file_id        bigint REFERENCES files(id),
  source_note          text   NOT NULL,                  -- 合作方通过 Telegram 提交资料，RUN Ops 代发
  status               text   NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','UNPUBLISHED','FROZEN')),
  status_before_freeze text   CHECK (status_before_freeze IN ('PUBLISHED','UNPUBLISHED')),
  unpublish_reason     text,
  freeze_reason        text,
  recovery_condition   text,
  frozen_by            bigint REFERENCES staff(id),
  frozen_at            timestamptz,
  recover_note         text,
  recovered_by         bigint REFERENCES staff(id),
  recovered_at         timestamptz,
  published_at         timestamptz,
  edit_count           int    NOT NULL DEFAULT 0,
  created_by           bigint NOT NULL REFERENCES staff(id),
  updated_by           bigint REFERENCES staff(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'FROZEN' OR (freeze_reason IS NOT NULL AND recovery_condition IS NOT NULL
                                AND status_before_freeze IS NOT NULL)),
  CHECK (status <> 'UNPUBLISHED' OR unpublish_reason IS NOT NULL)
);
CREATE TRIGGER contents_updated BEFORE UPDATE ON contents FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- 免责声明：版本发布后不可改；签署记录永不删除
-- ---------------------------------------------------------------------
CREATE TABLE disclaimer_versions (
  version         text   NOT NULL,                       -- UGC-DISC-v1.1
  lang            text   NOT NULL CHECK (lang IN ('zh','en','km')),
  effective_date  date   NOT NULL,
  full_text       text   NOT NULL,
  items           jsonb  NOT NULL,                       -- 确认项 [{k, t, d}]
  text_sha256     bytea  NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (version, lang)
);
CREATE TRIGGER disclaimer_versions_immutable BEFORE UPDATE OR DELETE ON disclaimer_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE disclaimer_signatures (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version         text   NOT NULL,
  lang            text   NOT NULL,
  text_sha256     bytea  NOT NULL,
  user_id         bigint NOT NULL REFERENCES users(id),
  checked_items   jsonb  NOT NULL,
  signed_at       timestamptz NOT NULL DEFAULT now(),
  client_timezone text,
  ip              inet,
  user_agent      text,
  device          text,
  FOREIGN KEY (version, lang) REFERENCES disclaimer_versions (version, lang)
);
CREATE TRIGGER disclaimer_signatures_append_only BEFORE UPDATE OR DELETE ON disclaimer_signatures
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------
-- 跑友活动（用户发布；平台不碰钱）
--   是否审核：挂在赛事下的看 events.community_review_required，
--   不挂赛事的看 system_settings.community.review_required_default。
--   发布时把当时的规则冻结进 review_required，之后改开关不影响已发布的活动。
--   review_required = true  → 初始 REVIEWING，平台审核后 PUBLISHED / REJECTED
--   review_required = false → 直接 PUBLISHED；平台仍可下架、紧急冻结
-- ---------------------------------------------------------------------
CREATE TABLE community_activities (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  author_user_id         bigint NOT NULL REFERENCES users(id),
  event_id               bigint REFERENCES events(id),
  review_required        boolean NOT NULL,
  signature_id           bigint NOT NULL UNIQUE REFERENCES disclaimer_signatures(id),
  title                  text   NOT NULL CHECK (char_length(title) <= 30),
  tag                    text   NOT NULL CHECK (tag IN ('MORNING','NIGHT','LONG','TRAIL','TRAINING','FAMILY','CYCLING','OTHER')),
  starts_at              timestamptz NOT NULL,
  location               text   NOT NULL,
  meet_point             text   NOT NULL,
  distance_text          text,
  capacity               int    NOT NULL CHECK (capacity >= 1),
  joined_count           int    NOT NULL DEFAULT 0 CHECK (joined_count >= 0),
  fee_note               text   NOT NULL DEFAULT '免费',
  contact_telegram       text,
  contact_phone          text,
  contact_visibility     text   NOT NULL DEFAULT 'JOINED' CHECK (contact_visibility IN ('JOINED','PUBLIC')),
  body                   text   NOT NULL CHECK (char_length(body) <= 1000),
  status                 text   NOT NULL DEFAULT 'REVIEWING' CHECK (status IN ('REVIEWING','PUBLISHED','REJECTED','CLOSED')),
  reject_code            text   CHECK (reject_code ~ '^R0[0-9]$'),
  reviewed_by            bigint REFERENCES staff(id),
  reviewed_at            timestamptz,
  -- 冻结是平台侧叠加状态，不覆盖 status，解冻后回到原状态
  frozen                 boolean NOT NULL DEFAULT false,
  freeze_reason          text,
  frozen_by              bigint REFERENCES staff(id),
  frozen_at              timestamptz,
  report_count           int    NOT NULL DEFAULT 0,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT community_activities_capacity CHECK (joined_count <= capacity),
  CHECK (contact_telegram IS NOT NULL OR contact_phone IS NOT NULL),
  CHECK (status <> 'REJECTED' OR reject_code IS NOT NULL),
  CHECK (review_required OR status NOT IN ('REVIEWING','REJECTED')),
  CHECK (review_required OR reviewed_by IS NULL),
  CHECK (frozen = (frozen_at IS NOT NULL AND freeze_reason IS NOT NULL))
);
CREATE INDEX community_activities_feed_idx ON community_activities (starts_at) WHERE status = 'PUBLISHED';
CREATE TRIGGER community_activities_updated BEFORE UPDATE ON community_activities FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE community_activity_images (
  activity_id  bigint   NOT NULL REFERENCES community_activities(id),
  file_id      bigint   NOT NULL REFERENCES files(id),
  sort_order   smallint NOT NULL CHECK (sort_order BETWEEN 0 AND 8),
  PRIMARY KEY (activity_id, sort_order)
);

CREATE TABLE community_activity_joins (
  activity_id  bigint NOT NULL REFERENCES community_activities(id),
  user_id      bigint NOT NULL REFERENCES users(id),
  status       text   NOT NULL DEFAULT 'JOINED' CHECK (status IN ('JOINED','LEFT')),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  left_at      timestamptz,
  PRIMARY KEY (activity_id, user_id)
);

CREATE TABLE community_reports (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  activity_id     bigint NOT NULL REFERENCES community_activities(id),
  reporter_id     bigint NOT NULL REFERENCES users(id),
  reason_code     text   NOT NULL,
  detail          text,
  status          text   NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','HANDLED','DISMISSED')),
  handled_by      bigint REFERENCES staff(id),
  handled_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (activity_id, reporter_id)
);

-- 联系方式查看留痕
CREATE TABLE contact_view_logs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  activity_id     bigint NOT NULL REFERENCES community_activities(id),
  viewer_user_id  bigint NOT NULL REFERENCES users(id),
  contact_type    text   NOT NULL CHECK (contact_type IN ('TELEGRAM','PHONE')),
  viewer_joined   boolean NOT NULL,
  ip              inet,
  viewed_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contact_view_logs_activity_idx ON contact_view_logs (activity_id, viewed_at);

-- ---------------------------------------------------------------------
-- 赛事留言板 / 跑后故事（可放二期）
-- ---------------------------------------------------------------------
CREATE TABLE event_comments (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id     bigint NOT NULL REFERENCES events(id),
  user_id      bigint REFERENCES users(id),
  staff_id     bigint REFERENCES staff(id),              -- 官方回复
  body         text   NOT NULL CHECK (char_length(body) <= 500),
  like_count   int    NOT NULL DEFAULT 0,
  status       text   NOT NULL DEFAULT 'VISIBLE' CHECK (status IN ('VISIBLE','HIDDEN')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(user_id, staff_id) = 1)
);
CREATE INDEX event_comments_event_idx ON event_comments (event_id, created_at DESC) WHERE status = 'VISIBLE';

CREATE TABLE stories (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        bigint NOT NULL REFERENCES users(id),
  event_id       bigint REFERENCES events(id),
  result_id      bigint REFERENCES results(id),
  title          text   NOT NULL,
  body           text   NOT NULL,
  tags           text[] NOT NULL DEFAULT '{}',
  cover_file_id  bigint REFERENCES files(id),
  like_count     int    NOT NULL DEFAULT 0,
  comment_count  int    NOT NULL DEFAULT 0,
  status         text   NOT NULL DEFAULT 'VISIBLE' CHECK (status IN ('VISIBLE','HIDDEN')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stories_tags_idx ON stories USING gin (tags);

CREATE TABLE story_likes (
  story_id    bigint NOT NULL REFERENCES stories(id),
  user_id     bigint NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (story_id, user_id)
);

CREATE TABLE story_comments (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  story_id    bigint NOT NULL REFERENCES stories(id),
  user_id     bigint NOT NULL REFERENCES users(id),
  body        text   NOT NULL CHECK (char_length(body) <= 500),
  status      text   NOT NULL DEFAULT 'VISIBLE' CHECK (status IN ('VISIBLE','HIDDEN')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 通知记录（发送本身由 River 任务执行）/ 后台告警
-- ---------------------------------------------------------------------
CREATE TABLE notification_logs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel       text   NOT NULL CHECK (channel IN ('TELEGRAM','SMS','EMAIL')),
  recipient     text   NOT NULL,
  template      text   NOT NULL,                         -- proof_approved / proof_rejected / ticket_issued
  locale        text   NOT NULL CHECK (locale IN ('zh','en','km')),
  entity_type   text,
  entity_id     bigint,
  dedupe_key    text   NOT NULL UNIQUE,
  status        text   NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED')),
  attempts      smallint NOT NULL DEFAULT 0,
  last_error    text,
  sent_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ops_alerts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_type    text   NOT NULL,                         -- REVIEW_SLA_BREACH / COUNTER_DRIFT / OFFLINE_CONFLICT
  severity      text   NOT NULL CHECK (severity IN ('INFO','WARN','CRITICAL')),
  event_id      bigint REFERENCES events(id),
  entity_type   text,
  entity_id     bigint,
  message       text   NOT NULL,
  status        text   NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKED','RESOLVED')),
  acked_by      bigint REFERENCES staff(id),
  acked_at      timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ops_alerts_open_idx ON ops_alerts (created_at DESC) WHERE status = 'OPEN';
