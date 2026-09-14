-- +goose Up
-- =====================================================================
-- 0001 · 基础：通用约定、文件、账号、后台员工、会话、审计、幂等
-- 约定：
--   · 主键 bigint identity；对外暴露的编号用 *_no（如 order_no）
--   · 金额一律 *_cents bigint（最小货币单位）+ currency char(3)
--   · 时间一律 timestamptz；业务时区 Asia/Phnom_Penh
--   · 枚举用 text + CHECK（改枚举只需改约束，不用 ALTER TYPE）
--   · 多语言文案用 jsonb：{"zh":"…","en":"…","km":"…"}
-- =====================================================================

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
-- +goose StatementEnd

-- 只追加表：禁止 UPDATE / DELETE
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;
-- +goose StatementEnd

-- ---------------------------------------------------------------------
-- 文件元数据（实体文件在 EC2 本地数据盘；storage_key 为相对路径）
-- ---------------------------------------------------------------------
CREATE TABLE files (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  storage_key     text        NOT NULL UNIQUE,
  visibility      text        NOT NULL CHECK (visibility IN ('PUBLIC','PRIVATE')),
  purpose         text        NOT NULL CHECK (purpose IN (
                    'PAYMENT_PROOF','REFUND_PROOF','RACE_PHOTO','EVENT_COVER','PRODUCT_IMAGE',
                    'COMMUNITY_IMAGE','IMPORT_CSV','CLAIM_EVIDENCE','PAYMENT_QR','OTHER')),
  mime_type       text        NOT NULL,
  size_bytes      bigint      NOT NULL CHECK (size_bytes > 0),
  sha256          bytea       NOT NULL,
  phash           bigint,                       -- 感知哈希（图片），用于相似截图检测
  width           int,
  height          int,
  uploaded_by_type text       NOT NULL CHECK (uploaded_by_type IN ('USER','STAFF','SYSTEM')),
  uploaded_by_id  bigint,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX files_sha256_idx ON files (sha256);
CREATE INDEX files_phash_idx  ON files (phash) WHERE phash IS NOT NULL;

-- ---------------------------------------------------------------------
-- 用户（跑者）账号：手机号验证码 / Telegram 登录；游客下单后可认领
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phone_e164         text UNIQUE,
  email              text,
  telegram_user_id   bigint UNIQUE,
  telegram_username  text,
  display_name       text,
  locale             text NOT NULL DEFAULT 'km' CHECK (locale IN ('zh','en','km')),
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (phone_e164 IS NOT NULL OR telegram_user_id IS NOT NULL)
);
CREATE TRIGGER users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 常用参赛人（报名第 1 步「谁要参加？」直接选）
CREATE TABLE runner_profiles (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          bigint NOT NULL REFERENCES users(id),
  full_name        text   NOT NULL,
  gender           text   NOT NULL CHECK (gender IN ('M','F','X')),
  birth_date       date   NOT NULL,
  nationality      char(2) NOT NULL,
  id_type          text   CHECK (id_type IN ('NATIONAL_ID','PASSPORT','OTHER')),
  id_no_enc        bytea,                          -- 应用层 AES-GCM 加密
  id_no_hash       bytea,                          -- HMAC，用于核验匹配
  phone_e164       text,
  email            text,
  emergency_name   text,
  emergency_phone  text,
  tshirt_size      text,
  is_self          boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runner_profiles_user_idx ON runner_profiles (user_id);
CREATE TRIGGER runner_profiles_updated BEFORE UPDATE ON runner_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE auth_otps (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phone_e164   text   NOT NULL,
  code_hash    bytea  NOT NULL,
  purpose      text   NOT NULL CHECK (purpose IN ('LOGIN','CLAIM_ACCOUNT')),
  attempts     smallint NOT NULL DEFAULT 0,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  ip           inet,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_otps_phone_idx ON auth_otps (phone_e164, created_at DESC);

-- ---------------------------------------------------------------------
-- 后台员工：7 个固定角色；权限矩阵写在代码里
-- ---------------------------------------------------------------------
CREATE TABLE staff (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username        text NOT NULL UNIQUE,
  full_name       text NOT NULL,
  role            text NOT NULL CHECK (role IN
                    ('ADMIN','OPS','FINANCE','SUPPORT','RACE_SUPERVISOR','RACE_STAFF','PHOTOGRAPHER')),
  password_hash   text NOT NULL,                  -- argon2id
  totp_secret_enc bytea,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER staff_updated BEFORE UPDATE ON staff FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sessions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_type  text   NOT NULL CHECK (subject_type IN ('USER','STAFF')),
  subject_id    bigint NOT NULL,
  token_hash    bytea  NOT NULL UNIQUE,            -- refresh token 的哈希
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  ip            inet,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_subject_idx ON sessions (subject_type, subject_id);

-- ---------------------------------------------------------------------
-- 审计流水：两端写同一条；只追加
-- ---------------------------------------------------------------------
CREATE TABLE audit_logs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_type    text   NOT NULL CHECK (actor_type IN ('USER','STAFF','SYSTEM')),
  actor_id      bigint,
  actor_role    text,
  action        text   NOT NULL,                   -- 如 reg_order.expire / payment_proof.approve
  entity_type   text   NOT NULL,
  entity_id     bigint NOT NULL,
  event_id      bigint,
  is_financial  boolean NOT NULL DEFAULT false,
  summary       text   NOT NULL,
  before_data   jsonb,
  after_data    jsonb,
  request_id    text,
  ip            inet,
  user_agent    text
);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_logs_event_idx  ON audit_logs (event_id, occurred_at DESC);
CREATE INDEX audit_logs_fin_idx    ON audit_logs (occurred_at DESC) WHERE is_financial;
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- 接口幂等（弱网重试不产生第二张订单）
CREATE TABLE idempotency_keys (
  key            text   NOT NULL,
  scope          text   NOT NULL,                  -- 如 reg_order.create
  subject        text   NOT NULL,                  -- user:123 / guest:<device>
  request_hash   bytea  NOT NULL,
  response_code  int,
  response_body  jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  PRIMARY KEY (scope, subject, key)
);

CREATE TABLE system_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  bigint REFERENCES staff(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO system_settings (key, value) VALUES
  ('payment.upload_window_minutes',   '30'),
  ('payment.reupload_window_hours',   '24'),
  ('payment.review_sla_hours',        '24'),
  ('merch.payment_window_minutes',    '30'),
  ('payment.ident_offset_max_cents',  '50'),
  ('community.review_required_default', 'true');   -- 不挂在赛事下的跑友活动用这个默认值
