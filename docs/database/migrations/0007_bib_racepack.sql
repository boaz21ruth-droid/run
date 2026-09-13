-- +goose Up
-- =====================================================================
-- 0007 · 导入任务 / 号码布 / 现场领物
--   号码布：赛内唯一、历史号永不复用 → (event_id, bib_number) 对全部状态唯一
--   领物名单由 registrations 派生；本模块只存「领没领 / 核验过没有」
-- =====================================================================

CREATE TABLE import_jobs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_type      text   NOT NULL CHECK (job_type IN ('BIB_ASSIGN_CSV','RESULT_CSV','BANK_STATEMENT','ROSTER_EXPORT')),
  event_id      bigint REFERENCES events(id),
  file_id       bigint REFERENCES files(id),
  status        text   NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','SUCCEEDED','FAILED')),
  total_rows    int,
  ok_rows       int,
  error_rows    int,
  errors        jsonb,                                  -- [{row, field, message}]
  created_by    bigint REFERENCES staff(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

CREATE TABLE bib_ranges (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id       bigint NOT NULL REFERENCES events(id),
  category_id    bigint NOT NULL UNIQUE REFERENCES event_categories(id),
  range_from     int    NOT NULL,
  range_to       int    NOT NULL,
  reserved_from  int,
  reserved_to    int,
  assign_mode    text   NOT NULL CHECK (assign_mode IN ('AUTO','BATCH','MANUAL')),
  display_digits smallint NOT NULL DEFAULT 4,           -- 展示补零位数
  CHECK (range_from > 0 AND range_to >= range_from),
  CHECK ((reserved_from IS NULL) = (reserved_to IS NULL)),
  CHECK (reserved_from IS NULL OR (reserved_from >= range_from AND reserved_to <= range_to
                                   AND reserved_to >= reserved_from))
);
-- 同一赛事内号段不重叠
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE bib_ranges ADD CONSTRAINT bib_ranges_no_overlap
  EXCLUDE USING gist (event_id WITH =, int4range(range_from, range_to, '[]') WITH &&);

CREATE TABLE bib_assignments (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id            bigint NOT NULL REFERENCES events(id),
  bib_number          int    NOT NULL CHECK (bib_number > 0),
  registration_id     bigint REFERENCES registrations(id),
  status              text   NOT NULL CHECK (status IN ('RESERVED','ASSIGNED','SUPERSEDED','VOIDED')),
  assign_method       text   CHECK (assign_method IN ('MANUAL','AUTO','CSV','SWAP')),
  holder_name         text,                             -- 分配时持有人拼写
  import_job_id       bigint REFERENCES import_jobs(id),
  superseded_by_id    bigint REFERENCES bib_assignments(id),
  note                text,
  created_by          bigint REFERENCES staff(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  status_changed_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, bib_number),                         -- 永不复用
  CHECK (status NOT IN ('ASSIGNED','SUPERSEDED') OR registration_id IS NOT NULL),
  CHECK (status <> 'RESERVED' OR registration_id IS NULL),
  CHECK (status <> 'SUPERSEDED' OR superseded_by_id IS NOT NULL)
);
-- 一个报名只有一个当前号码布
CREATE UNIQUE INDEX bib_assignments_one_current ON bib_assignments (registration_id) WHERE status = 'ASSIGNED';

-- 领物当前事实（按报名挂靠）
CREATE TABLE race_pack_facts (
  registration_id   bigint PRIMARY KEY REFERENCES registrations(id),
  picked            boolean NOT NULL DEFAULT false,
  picked_at         timestamptz,
  picked_by         bigint REFERENCES staff(id),
  device_id         text,
  offline_synced    boolean NOT NULL DEFAULT false,
  id_verified       boolean NOT NULL DEFAULT false,      -- 本地价参赛人必须先核验证件
  verified_at       timestamptz,
  verified_by       bigint REFERENCES staff(id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (picked = (picked_at IS NOT NULL AND picked_by IS NOT NULL)),
  CHECK (id_verified = (verified_at IS NOT NULL))
);
CREATE TRIGGER race_pack_facts_updated BEFORE UPDATE ON race_pack_facts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 扫码 / 离线同步流水（只追加）。client_event_id 保证离线重传幂等
CREATE TABLE race_pack_scan_logs (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_event_id   uuid   NOT NULL UNIQUE,
  registration_id   bigint NOT NULL REFERENCES registrations(id),
  event_id          bigint NOT NULL REFERENCES events(id),
  action            text   NOT NULL CHECK (action IN ('ISSUE','UNDO','VERIFY_ID','RESET_ID')),
  outcome           text   NOT NULL CHECK (outcome IN ('APPLIED','ALREADY','CONFLICT','REJECTED')),
  reason            text,
  staff_id          bigint NOT NULL REFERENCES staff(id),
  device_id         text   NOT NULL,
  offline           boolean NOT NULL DEFAULT false,
  occurred_at       timestamptz NOT NULL,                 -- 设备本地发生时间
  synced_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX race_pack_scan_logs_reg_idx ON race_pack_scan_logs (registration_id, occurred_at);
CREATE TRIGGER race_pack_scan_logs_append_only BEFORE UPDATE OR DELETE ON race_pack_scan_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- 多设备离线重复发包的裁决
CREATE TABLE race_pack_conflicts (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  registration_id   bigint NOT NULL REFERENCES registrations(id),
  status            text   NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DECIDED')),
  kept_scan_log_id  bigint REFERENCES race_pack_scan_logs(id),
  decided_by        bigint REFERENCES staff(id),
  decided_at        timestamptz,
  decision_reason   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'OPEN' OR (kept_scan_log_id IS NOT NULL AND decided_by IS NOT NULL AND decision_reason IS NOT NULL))
);
CREATE UNIQUE INDEX race_pack_conflicts_one_open ON race_pack_conflicts (registration_id) WHERE status = 'OPEN';
