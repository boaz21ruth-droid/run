-- +goose Up
-- =====================================================================
-- 0003 · 报名订单 / 参赛人财务快照 / 报名资料 / 资料变更与转让
--
-- 订单状态机（人工审核版）：
--   PENDING_PAYMENT ─上传凭证→ PROOF_SUBMITTED ─通过→ PAID
--        │                         └─驳回→ PROOF_REJECTED ─重传→ PROOF_SUBMITTED
--        ├─上传期超时 / 重传期超时→ EXPIRED（释放名额，恰好一次）
--        └─付款前取消→ CANCELLED（终态，不走迟到到账恢复）
--   PAID → PARTIALLY_REFUNDED → REFUNDED（由参赛人退款聚合）
--   金额为 0（WAIVER 免单码）：建单即 PAID，不走凭证
--   免费活动不建订单：没有支付动作，报名直接写 free_signups
-- =====================================================================

CREATE TABLE reg_orders (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_no              text   NOT NULL UNIQUE,     -- 展示给用户、写进转账备注
  event_id              bigint NOT NULL REFERENCES events(id),
  buyer_user_id         bigint REFERENCES users(id), -- 游客下单为 NULL，认领后回填
  buyer_name            text   NOT NULL,
  buyer_phone_e164      text   NOT NULL,
  buyer_email           text,
  status                text   NOT NULL CHECK (status IN (
                          'PENDING_PAYMENT','PROOF_SUBMITTED','PROOF_REJECTED',
                          'PAID','PARTIALLY_REFUNDED','REFUNDED','EXPIRED','CANCELLED')),
  -- 名额 / 配额预留事实（D-098）：RESERVED → CONSUMED 或 RELEASED，各只发生一次
  reservation_state     text   NOT NULL CHECK (reservation_state IN ('RESERVED','CONSUMED','RELEASED')),
  reservation_release_kind text CHECK (reservation_release_kind IN ('ORDER_EXPIRED','ORDER_CANCELLED')),
  list_amount_cents     bigint NOT NULL CHECK (list_amount_cents >= 0),
  discount_cents        bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  ident_offset_cents    smallint NOT NULL DEFAULT 0 CHECK (ident_offset_cents BETWEEN 0 AND 50), -- 识别分（计入优惠，≤ 50 美分）
  amount_cents          bigint NOT NULL CHECK (amount_cents >= 0),  -- 应付 = Σ 参赛人 paid_cents
  currency              char(3) NOT NULL DEFAULT 'USD',
  coupon_id             bigint REFERENCES coupons(id),
  payment_account_id    bigint,                      -- 下单时展示的收款码（FK 在 0005 补）
  deadline_at           timestamptz,                 -- 当前阶段截止：上传期 / 重传期；审核中为 NULL
  paid_at               timestamptz,
  expired_at            timestamptz,
  cancelled_at          timestamptz,
  cancel_reason         text,
  source                text   NOT NULL DEFAULT 'USER' CHECK (source IN ('USER','SUPPORT','OPS','TELEGRAM')),
  archived              boolean NOT NULL DEFAULT false,
  version               int    NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (amount_cents = list_amount_cents - discount_cents),
  CHECK (status <> 'PAID' OR paid_at IS NOT NULL),
  CHECK (reservation_state <> 'RESERVED' OR status IN ('PENDING_PAYMENT','PROOF_SUBMITTED','PROOF_REJECTED')),
  CHECK (status NOT IN ('EXPIRED','CANCELLED') OR reservation_state = 'RELEASED')
);
CREATE INDEX reg_orders_event_status_idx ON reg_orders (event_id, status);
CREATE INDEX reg_orders_buyer_idx        ON reg_orders (buyer_user_id) WHERE buyer_user_id IS NOT NULL;
CREATE INDEX reg_orders_phone_idx        ON reg_orders (buyer_phone_e164);
-- 超时扫描：River 定时任务按此索引取到期订单（FOR UPDATE SKIP LOCKED）
CREATE INDEX reg_orders_deadline_idx     ON reg_orders (deadline_at)
  WHERE status IN ('PENDING_PAYMENT','PROOF_REJECTED');
-- 财务按金额找单
CREATE INDEX reg_orders_open_amount_idx  ON reg_orders (amount_cents)
  WHERE status IN ('PENDING_PAYMENT','PROOF_SUBMITTED','PROOF_REJECTED');
CREATE TRIGGER reg_orders_updated BEFORE UPDATE ON reg_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- 参赛人行：不可变财务快照（docs/12 §8.2）。只有 op_status 可变
-- ---------------------------------------------------------------------
CREATE TABLE order_participants (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id          bigint NOT NULL REFERENCES reg_orders(id),
  category_id       bigint NOT NULL REFERENCES event_categories(id),
  price_rule_id     bigint NOT NULL REFERENCES price_rules(id),  -- 当初命中的那一档，恢复时不可换档
  audience          text   NOT NULL CHECK (audience IN ('ALL','LOCAL')),
  list_price_cents  bigint NOT NULL CHECK (list_price_cents >= 0),
  paid_cents        bigint NOT NULL CHECK (paid_cents >= 0),       -- 按分摊后的实付份额
  snapshot_name     text   NOT NULL,
  op_status         text   NOT NULL DEFAULT 'ACTIVE' CHECK (op_status IN ('ACTIVE','REFUND_PENDING','REFUNDED')),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_participants_order_idx ON order_participants (order_id);

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION order_participants_guard() RETURNS trigger AS $$
BEGIN
  IF (NEW.order_id, NEW.category_id, NEW.price_rule_id, NEW.audience,
      NEW.list_price_cents, NEW.paid_cents, NEW.snapshot_name)
     IS DISTINCT FROM
     (OLD.order_id, OLD.category_id, OLD.price_rule_id, OLD.audience,
      OLD.list_price_cents, OLD.paid_cents, OLD.snapshot_name) THEN
    RAISE EXCEPTION 'order_participants financial snapshot is immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
-- +goose StatementEnd
CREATE TRIGGER order_participants_immutable BEFORE UPDATE ON order_participants
  FOR EACH ROW EXECUTE FUNCTION order_participants_guard();
CREATE TRIGGER order_participants_no_delete BEFORE DELETE ON order_participants
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------
-- 报名资料：当前参赛资格与可编辑资料（与财务快照 1:1）
-- holder_id = 身份；full_name = 当前拼写。改拼写不换 holder_id，转让才换
-- ---------------------------------------------------------------------
CREATE TABLE registrations (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reg_no                text   NOT NULL UNIQUE,
  order_participant_id  bigint NOT NULL UNIQUE REFERENCES order_participants(id),
  event_id              bigint NOT NULL REFERENCES events(id),
  category_id           bigint NOT NULL REFERENCES event_categories(id),
  status                text   NOT NULL CHECK (status IN ('PENDING','CONFIRMED','CANCELLED')),
  cancel_reason         text   CHECK (cancel_reason IN ('ORDER_EXPIRED','ORDER_CANCELLED','REFUND_SETTLED')),
  ticket_code           text   NOT NULL UNIQUE,      -- 参赛凭证二维码内容（随机，不可猜）
  holder_id             uuid   NOT NULL DEFAULT gen_random_uuid(),
  user_id               bigint REFERENCES users(id),
  full_name             text   NOT NULL,
  gender                text   NOT NULL CHECK (gender IN ('M','F','X')),
  birth_date            date   NOT NULL,
  nationality           char(2) NOT NULL,
  id_type               text   CHECK (id_type IN ('NATIONAL_ID','PASSPORT','OTHER')),
  id_no_enc             bytea,
  id_no_hash            bytea,
  phone_e164            text,
  email                 text,
  emergency_name        text,
  emergency_phone       text,
  tshirt_size           text,
  confirmed_at          timestamptz,
  version               int    NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL))
);
CREATE INDEX registrations_event_status_idx ON registrations (event_id, category_id, status);
CREATE INDEX registrations_user_idx         ON registrations (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX registrations_phone_idx        ON registrations (phone_e164);
CREATE TRIGGER registrations_updated BEFORE UPDATE ON registrations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 资料修改 / 参赛人转让留痕（只追加）
CREATE TABLE registration_changes (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  registration_id  bigint NOT NULL REFERENCES registrations(id),
  change_type      text   NOT NULL CHECK (change_type IN ('EDIT_SPELLING','EDIT_INFO','TRANSFER')),
  before_data      jsonb  NOT NULL,
  after_data       jsonb  NOT NULL,
  from_holder_id   uuid,
  to_holder_id     uuid,
  reason           text,
  actor_type       text   NOT NULL CHECK (actor_type IN ('USER','STAFF')),
  actor_id         bigint,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (change_type <> 'TRANSFER' OR (from_holder_id IS NOT NULL AND to_holder_id IS NOT NULL
                                       AND from_holder_id <> to_holder_id))
);
CREATE INDEX registration_changes_reg_idx ON registration_changes (registration_id, created_at);
CREATE TRIGGER registration_changes_append_only BEFORE UPDATE OR DELETE ON registration_changes
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- 优惠码核销：一单一条，状态随订单预留走
CREATE TABLE coupon_redemptions (
  order_id    bigint PRIMARY KEY REFERENCES reg_orders(id),
  coupon_id   bigint NOT NULL REFERENCES coupons(id),
  state       text   NOT NULL CHECK (state IN ('RESERVED','CONSUMED','RELEASED')),
  discount_cents bigint NOT NULL CHECK (discount_cents >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 免费活动报名：不建订单、不走支付；名额同样占 event_categories.used_count
-- ---------------------------------------------------------------------
CREATE TABLE free_signups (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  signup_no        text   NOT NULL UNIQUE,
  event_id         bigint NOT NULL REFERENCES events(id),
  category_id      bigint NOT NULL REFERENCES event_categories(id),
  user_id          bigint REFERENCES users(id),
  full_name        text   NOT NULL,
  phone_e164       text   NOT NULL,
  gender           text   CHECK (gender IN ('M','F','X')),
  birth_date       date,
  emergency_name   text,
  emergency_phone  text,
  status           text   NOT NULL DEFAULT 'REGISTERED' CHECK (status IN ('REGISTERED','CANCELLED','ATTENDED','NO_SHOW')),
  cancel_source    text   CHECK (cancel_source IN ('USER','OPS','EVENT_CANCELLED')),
  cancelled_at     timestamptz,
  checked_in_at    timestamptz,
  checked_in_by    bigint REFERENCES staff(id),
  source           text   NOT NULL DEFAULT 'USER' CHECK (source IN ('USER','TELEGRAM','OPS','WAITLIST')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL AND cancel_source IS NOT NULL)),
  CHECK (status <> 'ATTENDED' OR checked_in_at IS NOT NULL)
);
-- 同一分组里，同一手机号 + 同一姓名只保留一条有效报名（亲子可用一个手机号报多人）
CREATE UNIQUE INDEX free_signups_one_active ON free_signups (category_id, phone_e164, lower(full_name))
  WHERE status <> 'CANCELLED';
CREATE INDEX free_signups_user_idx ON free_signups (user_id) WHERE user_id IS NOT NULL;
CREATE TRIGGER free_signups_updated BEFORE UPDATE ON free_signups FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 免费活动满员候补
CREATE TABLE waitlist_entries (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id            bigint NOT NULL REFERENCES events(id),
  category_id         bigint NOT NULL REFERENCES event_categories(id),
  user_id             bigint REFERENCES users(id),
  full_name           text   NOT NULL,
  phone_e164          text   NOT NULL,
  status              text   NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING','PROMOTED','CANCELLED')),
  promoted_signup_id  bigint REFERENCES free_signups(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'PROMOTED' OR promoted_signup_id IS NOT NULL)
);
CREATE UNIQUE INDEX waitlist_one_active ON waitlist_entries (category_id, phone_e164) WHERE status = 'WAITING';

-- 付费赛事只能建订单，免费活动只能走 free_signups
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION assert_event_type() RETURNS trigger AS $$
DECLARE t text;
BEGIN
  SELECT event_type INTO t FROM events WHERE id = NEW.event_id;
  IF t IS DISTINCT FROM TG_ARGV[0] THEN
    RAISE EXCEPTION '% requires event_type %, got %', TG_TABLE_NAME, TG_ARGV[0], t
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
-- +goose StatementEnd
CREATE TRIGGER reg_orders_event_type BEFORE INSERT OR UPDATE OF event_id ON reg_orders
  FOR EACH ROW EXECUTE FUNCTION assert_event_type('RACE');
CREATE TRIGGER free_signups_event_type BEFORE INSERT OR UPDATE OF event_id ON free_signups
  FOR EACH ROW EXECUTE FUNCTION assert_event_type('FREE_ACTIVITY');
CREATE TRIGGER waitlist_event_type BEFORE INSERT OR UPDATE OF event_id ON waitlist_entries
  FOR EACH ROW EXECUTE FUNCTION assert_event_type('FREE_ACTIVITY');
