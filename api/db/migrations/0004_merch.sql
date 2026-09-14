-- +goose Up
-- =====================================================================
-- 0004 · 周边商品（docs/14）
--   · 价格挂 SKU；available = on_hand - reserved 为派生值，不落列
--   · 库存只有三个动作：下单 reserved+ / 付款 reserved- 且 on_hand- / 释放 reserved-
--   · 退钱 ≠ 退货：只有 RETURN_RECEIVED 调整能把 on_hand 加回去，且一笔退款只一次
-- =====================================================================

CREATE TABLE merch_products (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id         bigint REFERENCES events(id),
  name             jsonb  NOT NULL,
  description      jsonb,
  cover_file_id    bigint REFERENCES files(id),
  status           text   NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ON_SALE','OFF_SALE')),
  off_sale_reason  text,
  created_by       bigint REFERENCES staff(id),
  updated_by       bigint REFERENCES staff(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER merch_products_updated BEFORE UPDATE ON merch_products FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE merch_skus (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id   bigint NOT NULL REFERENCES merch_products(id),
  variant      text   NOT NULL,
  size         text   NOT NULL,
  price_cents  bigint NOT NULL CHECK (price_cents >= 0),
  currency     char(3) NOT NULL DEFAULT 'USD',
  on_hand      int    NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved     int    NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  saleable     boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, variant, size),
  CONSTRAINT merch_skus_no_oversell CHECK (on_hand - reserved >= 0)
);
CREATE TRIGGER merch_skus_updated BEFORE UPDATE ON merch_skus FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE merch_orders (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_no                 text   NOT NULL UNIQUE,
  event_id                 bigint REFERENCES events(id),
  buyer_user_id            bigint REFERENCES users(id),
  buyer_name               text   NOT NULL,
  buyer_phone_e164         text   NOT NULL,
  status                   text   NOT NULL CHECK (status IN (
                             'PENDING_PAYMENT','PROOF_SUBMITTED','PROOF_REJECTED',
                             'PAID','EXPIRED','CANCELLED')),
  refund_state             text   NOT NULL DEFAULT 'NONE' CHECK (refund_state IN ('NONE','REFUNDED')),
  fulfillment              text   NOT NULL DEFAULT 'NONE' CHECK (fulfillment IN ('NONE','PENDING_HANDOFF','FULFILLED')),
  list_amount_cents        bigint NOT NULL CHECK (list_amount_cents > 0),     -- Σ 明细金额
  ident_offset_cents       smallint NOT NULL DEFAULT 0 CHECK (ident_offset_cents BETWEEN 0 AND 50),
  amount_cents             bigint NOT NULL CHECK (amount_cents > 0),          -- 应付 = 明细合计 − 识别分
  currency                 char(3) NOT NULL DEFAULT 'USD',
  payment_account_id       bigint,
  deadline_at              timestamptz,
  paid_at                  timestamptz,
  expired_at               timestamptz,
  cancelled_at             timestamptz,
  cancel_source            text   CHECK (cancel_source IN ('USER','SUPPORT','OPS')),
  cancel_reason            text,
  reservation_released     boolean NOT NULL DEFAULT false,
  reservation_release_kind text   CHECK (reservation_release_kind IN ('PAID','EXPIRED','CANCELLED')),
  stock_deducted           boolean NOT NULL DEFAULT false,
  handoff_at               timestamptz,
  handoff_location         text,
  handoff_by               bigint REFERENCES staff(id),
  handoff_recipient        text,
  source                   text   NOT NULL DEFAULT 'USER' CHECK (source IN ('USER','SUPPORT','OPS')),
  version                  int    NOT NULL DEFAULT 1,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (amount_cents = list_amount_cents - ident_offset_cents),
  CHECK (reservation_released = (reservation_release_kind IS NOT NULL)),
  CHECK (stock_deducted = (status = 'PAID')),          -- 只有正常付款才扣库存；迟到到账永不扣
  CHECK (fulfillment = 'NONE' OR status = 'PAID'),
  CHECK (fulfillment <> 'FULFILLED' OR handoff_at IS NOT NULL)
);
CREATE INDEX merch_orders_deadline_idx ON merch_orders (deadline_at)
  WHERE status IN ('PENDING_PAYMENT','PROOF_REJECTED');
CREATE INDEX merch_orders_buyer_idx ON merch_orders (buyer_user_id) WHERE buyer_user_id IS NOT NULL;
CREATE TRIGGER merch_orders_updated BEFORE UPDATE ON merch_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 下单即冻结快照
CREATE TABLE merch_order_items (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id            bigint NOT NULL REFERENCES merch_orders(id),
  sku_id              bigint NOT NULL REFERENCES merch_skus(id),
  product_id          bigint NOT NULL REFERENCES merch_products(id),
  product_name        text   NOT NULL,
  variant             text   NOT NULL,
  size                text   NOT NULL,
  unit_price_cents    bigint NOT NULL CHECK (unit_price_cents >= 0),
  qty                 int    NOT NULL CHECK (qty > 0),
  amount_cents        bigint NOT NULL,
  UNIQUE (order_id, sku_id),
  CHECK (amount_cents = unit_price_cents * qty)
);
CREATE TRIGGER merch_order_items_immutable BEFORE UPDATE OR DELETE ON merch_order_items
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE inventory_adjustments (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku_id            bigint NOT NULL REFERENCES merch_skus(id),
  delta             int    NOT NULL CHECK (delta <> 0),
  reason            text   NOT NULL CHECK (reason IN
                      ('INITIAL_STOCK','RESTOCK','STOCKTAKE','DAMAGE','RETURN_RECEIVED')),
  before_on_hand    int    NOT NULL,
  after_on_hand     int    NOT NULL CHECK (after_on_hand >= 0),
  source_order_id   bigint REFERENCES merch_orders(id),
  source_refund_id  bigint,                          -- FK 在 0006 补
  note              text,
  created_by        bigint REFERENCES staff(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (after_on_hand = before_on_hand + delta),
  CHECK (reason <> 'RETURN_RECEIVED' OR (delta > 0 AND source_refund_id IS NOT NULL))
);
-- 同一笔退款同一 SKU 只入库一次（M-14）
CREATE UNIQUE INDEX inventory_return_once ON inventory_adjustments (source_refund_id, sku_id)
  WHERE reason = 'RETURN_RECEIVED';
CREATE TRIGGER inventory_adjustments_append_only BEFORE UPDATE OR DELETE ON inventory_adjustments
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
