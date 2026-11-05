-- +goose Up
-- 赛事志愿者（v8 设计稿 09）：主办方建岗位与席位，跑者选能参加的日期与 1–3 个岗位申请，
-- 运营分配到岗位（占一个席位）、转候补或拒绝。
ALTER TABLE events ADD COLUMN volunteer_open boolean NOT NULL DEFAULT false;
ALTER TABLE events ADD COLUMN volunteer_dates date[] NOT NULL DEFAULT '{}';   -- 需要志愿者的日期（简报 / 领物 / 比赛日）
ALTER TABLE events ADD COLUMN volunteer_note jsonb;                           -- 三语：要求与福利，如「需柬英双语 · 提供 T 恤与餐食」

CREATE TABLE volunteer_roles (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id        bigint   NOT NULL REFERENCES events(id),
  name            jsonb    NOT NULL,
  schedule        jsonb,                                   -- 三语：时间与说明，如「16:00 起 · 核对参考码与证件」
  capacity        int      NOT NULL CHECK (capacity >= 0),
  assigned_count  int      NOT NULL DEFAULT 0 CHECK (assigned_count >= 0),
  sort_order      smallint NOT NULL DEFAULT 0,
  active          boolean  NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT volunteer_roles_no_overfill CHECK (assigned_count <= capacity)
);
CREATE INDEX volunteer_roles_event_idx ON volunteer_roles (event_id, sort_order, id);
CREATE TRIGGER volunteer_roles_updated BEFORE UPDATE ON volunteer_roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 申请：role_ids 是跑者选的 1–3 个岗位（同等考虑）；ASSIGNED 时 assigned_role_id 占该岗位一个席位。
CREATE TABLE volunteer_applications (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id           bigint  NOT NULL REFERENCES events(id),
  user_id            bigint  NOT NULL REFERENCES users(id),
  full_name          text    NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 80),
  phone_e164         text    NOT NULL,
  full_availability  boolean NOT NULL,
  dates              date[]  NOT NULL DEFAULT '{}',
  role_ids           bigint[] NOT NULL CHECK (cardinality(role_ids) BETWEEN 1 AND 3),
  tshirt_size        text,
  note               text    CHECK (note IS NULL OR char_length(note) <= 500),
  media_consent      boolean NOT NULL DEFAULT false,
  status             text    NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING','ASSIGNED','WAITLIST','REJECTED','WITHDRAWN')),
  assigned_role_id   bigint  REFERENCES volunteer_roles(id),
  review_note        text    CHECK (review_note IS NULL OR char_length(review_note) <= 200),
  reviewed_by        bigint  REFERENCES staff(id),
  reviewed_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'ASSIGNED') = (assigned_role_id IS NOT NULL)),
  CHECK (full_availability OR cardinality(dates) >= 1)
);
-- 同一赛事一人只有一份进行中的申请；被拒或撤回后可以重新申请
CREATE UNIQUE INDEX volunteer_applications_active_key ON volunteer_applications (event_id, user_id)
  WHERE status NOT IN ('REJECTED','WITHDRAWN');
CREATE INDEX volunteer_applications_event_idx ON volunteer_applications (event_id, status, created_at);
CREATE TRIGGER volunteer_applications_updated BEFORE UPDATE ON volunteer_applications FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- +goose Down
DROP TABLE volunteer_applications;
DROP TABLE volunteer_roles;
ALTER TABLE events DROP COLUMN volunteer_note;
ALTER TABLE events DROP COLUMN volunteer_dates;
ALTER TABLE events DROP COLUMN volunteer_open;
