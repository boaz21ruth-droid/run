-- +goose Up
-- =====================================================================
-- 0002 · 赛事 / 组别 / 价格档 / 优惠码 / 现场指派
-- 名额与配额用「计数列 + CHECK」守住：条件 UPDATE 原子扣减，CHECK 兜底防超卖
-- =====================================================================

CREATE TABLE events (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug                  text   NOT NULL UNIQUE,
  event_type            text   NOT NULL CHECK (event_type IN ('RACE','FREE_ACTIVITY')),
  organizer_type        text   NOT NULL CHECK (organizer_type IN ('OFFICIAL','PARTNER')),
  name                  jsonb  NOT NULL,
  summary               jsonb,
  description           jsonb,
  city                  text   NOT NULL,
  venue                 text,
  race_date             date   NOT NULL,
  timezone              text   NOT NULL DEFAULT 'Asia/Phnom_Penh',
  cover_file_id         bigint REFERENCES files(id),
  -- D-032/D-033：status 只有两值且不可退回 DRAFT；报名开关、公开展示是独立字段
  status                text   NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED')),
  registration_open     boolean NOT NULL DEFAULT false,
  public_visible        boolean NOT NULL DEFAULT false,
  registration_opens_at timestamptz,
  registration_closes_at timestamptz,
  race_pack_configured  boolean NOT NULL DEFAULT false,
  community_review_required boolean NOT NULL DEFAULT true,  -- 该赛事下跑友活动是否需要平台审核
  -- 免费活动专用：集合点 / 适合人群 / 补给 / 提前取消小时数
  activity_info         jsonb,
  published_at          timestamptz,
  published_by          bigint REFERENCES staff(id),
  created_by            bigint REFERENCES staff(id),
  version               int    NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'DRAFT' OR published_at IS NOT NULL)
);
CREATE INDEX events_public_idx ON events (race_date) WHERE status = 'PUBLISHED' AND public_visible;
CREATE TRIGGER events_updated BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE event_categories (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id        bigint NOT NULL REFERENCES events(id),
  code            text   NOT NULL,                  -- 21K / 10K / 5K
  name            jsonb  NOT NULL,
  distance_m      int    NOT NULL CHECK (distance_m > 0),
  capacity        int    NOT NULL CHECK (capacity >= 0),
  used_count      int    NOT NULL DEFAULT 0 CHECK (used_count >= 0),      -- 已确认
  reserved_count  int    NOT NULL DEFAULT 0 CHECK (reserved_count >= 0),  -- 待付款/待审核占用
  start_at        timestamptz,
  cutoff_at       timestamptz,
  min_age         smallint NOT NULL DEFAULT 0,      -- 按比赛当天年龄
  sort_order      smallint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, code),
  CONSTRAINT event_categories_no_oversell CHECK (used_count + reserved_count <= capacity)
);
CREATE TRIGGER event_categories_updated BEFORE UPDATE ON event_categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE price_rules (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id        bigint NOT NULL REFERENCES events(id),
  name            jsonb  NOT NULL,                  -- 早鸟价 / 标准价 / 本地居民价
  audience        text   NOT NULL CHECK (audience IN ('ALL','LOCAL')),
  price_cents     bigint NOT NULL CHECK (price_cents >= 0),
  currency        char(3) NOT NULL DEFAULT 'USD',
  quota           int    CHECK (quota IS NULL OR quota >= 0),   -- NULL = 不限
  used_count      int    NOT NULL DEFAULT 0 CHECK (used_count >= 0),      -- CONSUMED，退款不恢复
  reserved_count  int    NOT NULL DEFAULT 0 CHECK (reserved_count >= 0),
  sale_starts_at  timestamptz,
  sale_ends_at    timestamptz,
  sort_order      smallint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT price_rules_no_oversell CHECK (quota IS NULL OR used_count + reserved_count <= quota)
);
CREATE INDEX price_rules_event_idx ON price_rules (event_id);
CREATE TRIGGER price_rules_updated BEFORE UPDATE ON price_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 组别适用哪些价格档（多对多）
CREATE TABLE category_price_rules (
  category_id    bigint NOT NULL REFERENCES event_categories(id),
  price_rule_id  bigint NOT NULL REFERENCES price_rules(id),
  PRIMARY KEY (category_id, price_rule_id)
);

CREATE TABLE sponsors (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text NOT NULL,
  logo_file_id  bigint REFERENCES files(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE event_sponsors (
  event_id           bigint NOT NULL REFERENCES events(id),
  sponsor_id         bigint NOT NULL REFERENCES sponsors(id),
  role_label         jsonb,                        -- 官方补给伙伴 …
  photo_watermark    boolean NOT NULL DEFAULT false,
  free_photo_claim   boolean NOT NULL DEFAULT false,
  sort_order         smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, sponsor_id)
);

CREATE TABLE coupons (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code            text   NOT NULL UNIQUE,          -- 存大写
  event_id        bigint REFERENCES events(id),    -- NULL = 全场通用
  discount_type   text   NOT NULL CHECK (discount_type IN ('PERCENT','AMOUNT','WAIVER')),
  discount_value  bigint NOT NULL CHECK (discount_value >= 0),  -- PERCENT: 1-100；AMOUNT: cents
  quota           int    NOT NULL CHECK (quota >= 0),
  used_count      int    NOT NULL DEFAULT 0,
  reserved_count  int    NOT NULL DEFAULT 0,
  min_runners     smallint,
  valid_from      timestamptz,
  valid_until     timestamptz,
  description     jsonb,
  status          text   NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  created_by      bigint REFERENCES staff(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coupons_no_overuse CHECK (used_count + reserved_count <= quota),
  CHECK (discount_type <> 'PERCENT' OR discount_value BETWEEN 1 AND 100)
);

-- D-019：摄影师 / 现场主管 / 现场工作人员只看被指派、且在有效期内的赛事
CREATE TABLE staff_event_assignments (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  staff_id     bigint NOT NULL REFERENCES staff(id),
  event_id     bigint NOT NULL REFERENCES events(id),
  valid_from   timestamptz NOT NULL,
  valid_until  timestamptz NOT NULL,
  enabled      boolean NOT NULL DEFAULT true,
  created_by   bigint REFERENCES staff(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (staff_id, event_id),
  CHECK (valid_until > valid_from)
);
