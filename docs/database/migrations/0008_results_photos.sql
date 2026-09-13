-- +goose Up
-- =====================================================================
-- 0008 · 成绩 / 历史成绩认领 / 赛道照片（一期：赛事 → 号码布 → 照片）
--   成绩批次生命周期 DRAFT → VALIDATED → PUBLISHED → UNPUBLISHED；
--   重新发布 = 新建批次；同一组别同时只有一个 PUBLISHED
-- =====================================================================

CREATE TABLE result_batches (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id          bigint NOT NULL REFERENCES events(id),
  category_id       bigint NOT NULL REFERENCES event_categories(id),
  status            text   NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','VALIDATED','PUBLISHED','UNPUBLISHED')),
  import_job_id     bigint REFERENCES import_jobs(id),
  source_file_name  text   NOT NULL,
  row_count         int    NOT NULL DEFAULT 0,
  bad_row_count     int    NOT NULL DEFAULT 0,
  bad_rows_ignored  boolean NOT NULL DEFAULT false,
  created_by        bigint NOT NULL REFERENCES staff(id),
  validated_by      bigint REFERENCES staff(id),
  validated_at      timestamptz,
  published_by      bigint REFERENCES staff(id),
  published_at      timestamptz,
  unpublished_by    bigint REFERENCES staff(id),
  unpublished_at    timestamptz,
  unpublish_reason  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('PUBLISHED','UNPUBLISHED') OR published_at IS NOT NULL),
  CHECK (status <> 'UNPUBLISHED' OR unpublish_reason IS NOT NULL),
  CHECK (status NOT IN ('PUBLISHED') OR bad_row_count = 0 OR bad_rows_ignored)
);
CREATE UNIQUE INDEX result_batches_one_published ON result_batches (category_id) WHERE status = 'PUBLISHED';

CREATE TABLE results (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id          bigint NOT NULL REFERENCES result_batches(id),
  event_id          bigint NOT NULL REFERENCES events(id),
  category_id       bigint NOT NULL REFERENCES event_categories(id),
  bib_number        int    NOT NULL,
  registration_id   bigint REFERENCES registrations(id),
  runner_user_id    bigint REFERENCES users(id),        -- 个人永久成绩档案；认领后回填
  name_snapshot     text   NOT NULL,
  gender            text   CHECK (gender IN ('M','F','X')),
  age_group         text,                               -- M35-39
  status            text   NOT NULL CHECK (status IN ('FINISHED','DNS','DNF','DSQ','PENDING')),
  gun_time_ms       int    CHECK (gun_time_ms > 0),
  net_time_ms       int    CHECK (net_time_ms > 0),
  start_time        time,
  overall_rank      int,
  gender_rank       int,
  age_group_rank    int,
  splits            jsonb  NOT NULL DEFAULT '[]',       -- [{label:"5 km", distance_m:5000, elapsed_ms:1758000}]
  note              text,
  UNIQUE (batch_id, bib_number),
  CHECK (status <> 'FINISHED' OR net_time_ms IS NOT NULL)
);
CREATE INDEX results_runner_idx ON results (runner_user_id) WHERE runner_user_id IS NOT NULL;
CREATE INDEX results_rank_idx   ON results (batch_id, overall_rank);

CREATE TABLE result_claim_cases (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_no           text   NOT NULL UNIQUE,
  result_id         bigint NOT NULL REFERENCES results(id),
  user_id           bigint NOT NULL REFERENCES users(id),
  evidence          text   NOT NULL,
  evidence_file_id  bigint REFERENCES files(id),
  status            text   NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','BOUND','REJECTED')),
  received_by       bigint NOT NULL REFERENCES staff(id),   -- SUPPORT 受理
  decided_by        bigint REFERENCES staff(id),            -- OPS 最终绑定
  decided_at        timestamptz,
  decision_note     text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 赛道照片
-- ---------------------------------------------------------------------
CREATE TABLE photo_batches (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id         bigint NOT NULL REFERENCES events(id),
  name             text   NOT NULL,                     -- 终点门架 · 09:00–10:30
  photographer_id  bigint NOT NULL REFERENCES staff(id),
  photo_count      int    NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE photos (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id            bigint NOT NULL REFERENCES photo_batches(id),
  event_id            bigint NOT NULL REFERENCES events(id),
  original_file_id    bigint NOT NULL UNIQUE REFERENCES files(id),  -- PRIVATE 原图
  preview_key         text,                              -- 带赞助商水印的预览图（PUBLIC）
  thumb_key           text,
  taken_at            timestamptz,
  label               text,
  status              text   NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('PROCESSING','ACTIVE','TAKEN_DOWN')),
  taken_down_reason   text,
  taken_down_by       bigint REFERENCES staff(id),
  taken_down_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'TAKEN_DOWN' OR taken_down_reason IS NOT NULL)
);
CREATE INDEX photos_batch_idx ON photos (batch_id);

-- 一张照片可标多个号码布；只存号码，不存姓名（摄影师不可见 PII）
CREATE TABLE photo_bib_tags (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  photo_id        bigint NOT NULL REFERENCES photos(id),
  event_id        bigint NOT NULL REFERENCES events(id),
  bib_number      int    NOT NULL,
  tagged_by       bigint NOT NULL REFERENCES staff(id),
  tagged_at       timestamptz NOT NULL DEFAULT now(),
  removed         boolean NOT NULL DEFAULT false,
  removed_by      bigint REFERENCES staff(id),
  removed_at      timestamptz,
  removed_reason  text,
  CHECK (removed = (removed_at IS NOT NULL))
);
CREATE UNIQUE INDEX photo_bib_tags_active_uniq ON photo_bib_tags (photo_id, bib_number) WHERE NOT removed;
CREATE INDEX photo_bib_tags_search_idx ON photo_bib_tags (event_id, bib_number) WHERE NOT removed;

CREATE TABLE photo_removal_requests (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  photo_id        bigint NOT NULL REFERENCES photos(id),
  user_id         bigint REFERENCES users(id),
  contact         text   NOT NULL,
  reason          text   NOT NULL,
  status          text   NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','APPROVED','REJECTED')),
  reviewed_by     bigint REFERENCES staff(id),
  reviewed_at     timestamptz,
  review_note     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 「不是我」标记 / 免费领取 / 下载记录
CREATE TABLE photo_user_actions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  photo_id     bigint NOT NULL REFERENCES photos(id),
  user_id      bigint NOT NULL REFERENCES users(id),
  action       text   NOT NULL CHECK (action IN ('NOT_ME','SPONSOR_FREE_CLAIM','DOWNLOAD')),
  sponsor_id   bigint REFERENCES sponsors(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (action <> 'SPONSOR_FREE_CLAIM' OR sponsor_id IS NOT NULL)
);
CREATE UNIQUE INDEX photo_user_actions_once ON photo_user_actions (photo_id, user_id, action)
  WHERE action IN ('NOT_ME','SPONSOR_FREE_CLAIM');
