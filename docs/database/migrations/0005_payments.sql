-- +goose Up
-- =====================================================================
-- 0005 · 收款（固定二维码 + 截图凭证 + 财务人工审核）
--   凭证 payment_proofs  = 用户「自称付过了」，是待核查的诉求
--   到账 payment_receipts = 财务核对过银行记录后确认「钱确实到了」
--   两者分开存：只有 FINANCE / SYSTEM 能写 receipts（D-112 / D-125）
-- =====================================================================

CREATE TABLE payment_accounts (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name                text   NOT NULL,                 -- ABA USD 主收款户
  provider            text   NOT NULL CHECK (provider IN ('ABA','ACLEDA','WING','BAKONG','OTHER')),
  account_name        text   NOT NULL,
  account_no_masked   text   NOT NULL,
  currency            char(3) NOT NULL CHECK (currency IN ('USD','KHR')),
  qr_file_id          bigint NOT NULL REFERENCES files(id),
  scope               text   NOT NULL DEFAULT 'ALL' CHECK (scope IN ('REGISTRATION','MERCH','ALL')),
  event_id            bigint REFERENCES events(id),     -- NULL = 全局
  active              boolean NOT NULL DEFAULT true,
  created_by          bigint REFERENCES staff(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE reg_orders   ADD CONSTRAINT reg_orders_payment_account_fk
  FOREIGN KEY (payment_account_id) REFERENCES payment_accounts(id);
ALTER TABLE merch_orders ADD CONSTRAINT merch_orders_payment_account_fk
  FOREIGN KEY (payment_account_id) REFERENCES payment_accounts(id);

CREATE TABLE payment_proofs (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proof_no               text   NOT NULL UNIQUE,
  reg_order_id           bigint REFERENCES reg_orders(id),
  merch_order_id         bigint REFERENCES merch_orders(id),
  payment_account_id     bigint NOT NULL REFERENCES payment_accounts(id),
  file_id                bigint NOT NULL REFERENCES files(id),   -- PRIVATE 截图
  submitted_by_user_id   bigint REFERENCES users(id),
  declared_amount_cents  bigint NOT NULL CHECK (declared_amount_cents > 0),
  declared_currency      char(3) NOT NULL,
  bank_txn_ref           text   NOT NULL,              -- 回执交易号，去空格转大写后存
  declared_paid_at       timestamptz,
  payer_name             text,
  payer_account_masked   text,
  remark                 text,
  is_late                boolean NOT NULL DEFAULT false, -- 提交时订单已过期
  dup_file_hit           boolean NOT NULL DEFAULT false, -- 截图 sha256/phash 命中其他凭证
  status                 text   NOT NULL DEFAULT 'SUBMITTED'
                           CHECK (status IN ('SUBMITTED','APPROVED','REJECTED','WITHDRAWN')),
  reviewed_by            bigint REFERENCES staff(id),
  reviewed_at            timestamptz,
  reject_code            text   CHECK (reject_code IN
                           ('NOT_RECEIVED','AMOUNT_MISMATCH','DUPLICATE_TXN','UNREADABLE','WRONG_ACCOUNT','FRAUD','OTHER')),
  reject_reason          text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(reg_order_id, merch_order_id) = 1),
  CHECK (status = 'SUBMITTED' OR status = 'WITHDRAWN' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
  CHECK (status <> 'REJECTED' OR reject_code IS NOT NULL)
);
-- 一张订单同一时刻只有一份待审凭证
CREATE UNIQUE INDEX payment_proofs_one_pending_reg   ON payment_proofs (reg_order_id)   WHERE status = 'SUBMITTED';
CREATE UNIQUE INDEX payment_proofs_one_pending_merch ON payment_proofs (merch_order_id) WHERE status = 'SUBMITTED';
-- 同一收款户同一交易号不能挂在两份有效凭证上（拦截一笔钱报两单）
CREATE UNIQUE INDEX payment_proofs_txn_ref_uniq ON payment_proofs (payment_account_id, bank_txn_ref)
  WHERE status IN ('SUBMITTED','APPROVED');
CREATE INDEX payment_proofs_queue_idx ON payment_proofs (created_at) WHERE status = 'SUBMITTED';

-- 确认到账的钱（资金事实）
CREATE TABLE payment_receipts (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_account_id  bigint NOT NULL REFERENCES payment_accounts(id),
  txn_ref             text   NOT NULL,
  amount_cents        bigint NOT NULL CHECK (amount_cents > 0),
  currency            char(3) NOT NULL,
  received_at         timestamptz NOT NULL,
  proof_id            bigint UNIQUE REFERENCES payment_proofs(id),
  reg_order_id        bigint REFERENCES reg_orders(id),
  merch_order_id      bigint REFERENCES merch_orders(id),
  match_status        text   NOT NULL CHECK (match_status IN ('APPLIED','EXCEPTION','UNMATCHED')),
  recorded_by_type    text   NOT NULL CHECK (recorded_by_type IN ('STAFF','SYSTEM')),
  recorded_by         bigint REFERENCES staff(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_account_id, txn_ref),               -- 一笔银行流水只入账一次
  CHECK (num_nonnulls(reg_order_id, merch_order_id) <= 1),
  CHECK (match_status = 'UNMATCHED' OR num_nonnulls(reg_order_id, merch_order_id) = 1),
  CHECK (recorded_by_type = 'SYSTEM' OR recorded_by IS NOT NULL)
);
CREATE TRIGGER payment_receipts_append_only BEFORE DELETE ON payment_receipts
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- 支付异常：多付 / 少付 / 重复付 / 迟到到账 / 无法匹配
CREATE TABLE payment_exceptions (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exception_no           text   NOT NULL UNIQUE,
  domain                 text   NOT NULL CHECK (domain IN ('REGISTRATION','MERCH')),
  type                   text   NOT NULL CHECK (type IN ('OVERPAID','UNDERPAID','DUPLICATE','LATE_ARRIVAL','UNMATCHED')),
  reg_order_id           bigint REFERENCES reg_orders(id),
  merch_order_id         bigint REFERENCES merch_orders(id),
  receipt_id             bigint NOT NULL REFERENCES payment_receipts(id),
  amount_cents           bigint NOT NULL CHECK (amount_cents > 0),
  status                 text   NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  resolution             text   CHECK (resolution IN ('RESTORED','REFUNDED','TOPPED_UP','ACCEPTED','OTHER')),
  resolution_note        text,
  settled_reg_refund_id  bigint,                       -- FK 在 0006 补
  settled_merch_refund_id bigint,
  resolved_by            bigint REFERENCES staff(id),
  resolved_at            timestamptz,
  note                   text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (domain <> 'REGISTRATION' OR merch_order_id IS NULL),
  CHECK (domain <> 'MERCH' OR reg_order_id IS NULL),
  CHECK (type = 'UNMATCHED' OR num_nonnulls(reg_order_id, merch_order_id) = 1),
  CHECK (status = 'OPEN' OR (resolution IS NOT NULL AND resolved_at IS NOT NULL)),
  -- 周边迟到到账只能以退款结算关闭（D-094 R2）
  CHECK (NOT (domain = 'MERCH' AND type = 'LATE_ARRIVAL' AND status = 'CLOSED') OR settled_merch_refund_id IS NOT NULL)
);
CREATE UNIQUE INDEX payment_exceptions_receipt_type ON payment_exceptions (receipt_id, type);
CREATE INDEX payment_exceptions_open_idx ON payment_exceptions (domain, created_at) WHERE status = 'OPEN';

-- ---------------------------------------------------------------------
-- 对账：导入银行 / ABA 商户流水，按日核对
-- ---------------------------------------------------------------------
CREATE TABLE bank_statement_imports (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_account_id  bigint NOT NULL REFERENCES payment_accounts(id),
  period_start        date   NOT NULL,
  period_end          date   NOT NULL,
  file_id             bigint NOT NULL REFERENCES files(id),
  line_count          int    NOT NULL DEFAULT 0,
  imported_by         bigint NOT NULL REFERENCES staff(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);

CREATE TABLE bank_statement_lines (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  import_id       bigint NOT NULL REFERENCES bank_statement_imports(id),
  payment_account_id bigint NOT NULL REFERENCES payment_accounts(id),
  txn_ref         text   NOT NULL,
  amount_cents    bigint NOT NULL,
  currency        char(3) NOT NULL,
  txn_at          timestamptz NOT NULL,
  counterparty    text,
  memo            text,
  receipt_id      bigint REFERENCES payment_receipts(id),
  UNIQUE (payment_account_id, txn_ref)
);

CREATE TABLE reconciliations (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_account_id  bigint NOT NULL REFERENCES payment_accounts(id),
  biz_date            date   NOT NULL,
  bank_total_cents    bigint NOT NULL,
  system_total_cents  bigint NOT NULL,
  matched_count       int    NOT NULL DEFAULT 0,
  status              text   NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  closed_by           bigint REFERENCES staff(id),
  closed_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_account_id, biz_date),
  CHECK (status = 'OPEN' OR closed_by IS NOT NULL)
);

CREATE TABLE reconciliation_discrepancies (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reconciliation_id  bigint NOT NULL REFERENCES reconciliations(id),
  type               text   NOT NULL CHECK (type IN ('BANK_ONLY','SYSTEM_ONLY','AMOUNT_DIFF')),
  statement_line_id  bigint REFERENCES bank_statement_lines(id),
  receipt_id         bigint REFERENCES payment_receipts(id),
  amount_cents       bigint NOT NULL,
  status             text   NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  resolution         text,
  evidence_file_id   bigint REFERENCES files(id),
  resolved_by        bigint REFERENCES staff(id),
  resolved_at        timestamptz,
  note               text
);
