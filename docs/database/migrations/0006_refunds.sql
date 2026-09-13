-- +goose Up
-- =====================================================================
-- 0006 · 退款（线下转账后登记）/ 补退与多退纠错 / 用户协助请求
--   报名退款与周边退款是两个业务对象，分表存
--   金额上限由触发器兜底：累计实退 ≤ 参赛人实付（或 ≤ 异常到账金额）
-- =====================================================================

CREATE TABLE reg_refunds (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  refund_no             text   NOT NULL UNIQUE,
  order_id              bigint NOT NULL REFERENCES reg_orders(id),
  participant_id        bigint REFERENCES order_participants(id),
  kind                  text   NOT NULL CHECK (kind IN ('PARTICIPANT_CANCEL','EXCEPTION_RETURN')),
  refund_type           text   NOT NULL DEFAULT 'STANDARD' CHECK (refund_type IN ('STANDARD','SUPPLEMENTAL')),
  source_exception_id   bigint REFERENCES payment_exceptions(id),
  source_correction_id  bigint,                         -- FK 见下方
  requested_cents       bigint NOT NULL CHECK (requested_cents > 0),
  approved_cents        bigint CHECK (approved_cents > 0),
  settled_cents         bigint CHECK (settled_cents > 0),
  currency              char(3) NOT NULL DEFAULT 'USD',
  status                text   NOT NULL DEFAULT 'REQUESTED'
                          CHECK (status IN ('REQUESTED','APPROVED','SETTLED','REJECTED','WITHDRAWN')),
  reason                text   NOT NULL,
  initiated_by_role     text   NOT NULL CHECK (initiated_by_role IN ('FINANCE','SUPPORT')),
  requested_by          bigint NOT NULL REFERENCES staff(id),
  approved_by           bigint REFERENCES staff(id),
  approved_at           timestamptz,
  settled_by            bigint REFERENCES staff(id),
  settled_at            timestamptz,
  payout_method         text   CHECK (payout_method IN ('BANK_TRANSFER','ABA_TRANSFER','CASH')),
  payee_account_enc     bytea,
  payout_txn_ref        text,
  payout_proof_file_id  bigint REFERENCES files(id),
  rejected_by           bigint REFERENCES staff(id),
  rejected_at           timestamptz,
  reject_reason         text,
  user_confirmation     text,                            -- WITHDRAWN 必填
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'PARTICIPANT_CANCEL' OR participant_id IS NOT NULL),
  CHECK (kind <> 'EXCEPTION_RETURN' OR source_exception_id IS NOT NULL),
  CHECK (approved_cents IS NULL OR approved_cents <= requested_cents),
  CHECK (status NOT IN ('APPROVED','SETTLED') OR approved_cents IS NOT NULL),
  CHECK (status <> 'SETTLED' OR (settled_cents IS NOT NULL AND settled_at IS NOT NULL
                                 AND (payout_txn_ref IS NOT NULL OR payout_proof_file_id IS NOT NULL))),
  CHECK (status <> 'WITHDRAWN' OR user_confirmation IS NOT NULL)
);
-- 同一参赛人同一时刻只允许一笔进行中的标准退款
CREATE UNIQUE INDEX reg_refunds_one_open ON reg_refunds (participant_id)
  WHERE status IN ('REQUESTED','APPROVED') AND refund_type = 'STANDARD';
CREATE INDEX reg_refunds_queue_idx ON reg_refunds (status, created_at);
CREATE TRIGGER reg_refunds_updated BEFORE UPDATE ON reg_refunds FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION reg_refunds_cap() RETURNS trigger AS $$
DECLARE
  cap    bigint;
  others bigint;
  this   bigint := COALESCE(NEW.settled_cents, NEW.approved_cents, NEW.requested_cents);
BEGIN
  IF NEW.status IN ('REJECTED','WITHDRAWN') THEN RETURN NEW; END IF;
  IF NEW.source_exception_id IS NOT NULL THEN
    SELECT amount_cents INTO cap FROM payment_exceptions WHERE id = NEW.source_exception_id;
    SELECT COALESCE(sum(settled_cents), 0) INTO others FROM reg_refunds
     WHERE source_exception_id = NEW.source_exception_id AND status = 'SETTLED' AND id <> NEW.id;
  ELSE
    SELECT paid_cents INTO cap FROM order_participants WHERE id = NEW.participant_id;
    SELECT COALESCE(sum(settled_cents), 0) INTO others FROM reg_refunds
     WHERE participant_id = NEW.participant_id AND source_exception_id IS NULL
       AND status = 'SETTLED' AND id <> NEW.id;
  END IF;
  IF others + this > cap THEN
    RAISE EXCEPTION 'refund exceeds paid amount: cap %, already settled %, this %', cap, others, this
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER reg_refunds_amount_cap BEFORE INSERT OR UPDATE ON reg_refunds
  FOR EACH ROW EXECUTE FUNCTION reg_refunds_cap();

-- 补退 / 多退纠错（AR-F-002）
CREATE TABLE refund_corrections (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  correction_no           text   NOT NULL UNIQUE,
  order_id                bigint NOT NULL REFERENCES reg_orders(id),
  participant_id          bigint NOT NULL REFERENCES order_participants(id),
  source_refund_id        bigint NOT NULL REFERENCES reg_refunds(id),
  type                    text   NOT NULL CHECK (type IN ('UNDERPAID','OVERPAID')),
  should_refund_cents     bigint NOT NULL CHECK (should_refund_cents >= 0),
  settled_cents           bigint NOT NULL CHECK (settled_cents >= 0),
  variance_cents          bigint GENERATED ALWAYS AS (abs(should_refund_cents - settled_cents)) STORED,
  status                  text   NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  resolution              text   CHECK (resolution IN ('SUPPLEMENTAL_REFUND','RECOVERED','WRITTEN_OFF')),
  supplemental_refund_id  bigint REFERENCES reg_refunds(id),
  recovered_cents         bigint CHECK (recovered_cents >= 0),
  evidence_file_id        bigint REFERENCES files(id),
  created_by              bigint NOT NULL REFERENCES staff(id),
  resolved_by             bigint REFERENCES staff(id),
  resolved_at             timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (should_refund_cents <> settled_cents),
  CHECK ((type = 'UNDERPAID') = (settled_cents < should_refund_cents)),
  CHECK (status = 'OPEN' OR resolution IS NOT NULL),
  CHECK (resolution IS DISTINCT FROM 'SUPPLEMENTAL_REFUND' OR supplemental_refund_id IS NOT NULL),
  CHECK (resolution IS DISTINCT FROM 'RECOVERED' OR recovered_cents IS NOT NULL)
);
CREATE UNIQUE INDEX refund_corrections_one_open ON refund_corrections (source_refund_id) WHERE status = 'OPEN';
ALTER TABLE reg_refunds ADD CONSTRAINT reg_refunds_correction_fk
  FOREIGN KEY (source_correction_id) REFERENCES refund_corrections(id);

-- 周边退款：一期只有整单退款；应退与实退分列，SETTLED 必须逐分一致
CREATE TABLE merch_refunds (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  refund_no             text   NOT NULL UNIQUE,
  order_id              bigint NOT NULL REFERENCES merch_orders(id),
  scope                 text   NOT NULL DEFAULT 'WHOLE_ORDER' CHECK (scope = 'WHOLE_ORDER'),
  origin                text   NOT NULL CHECK (origin IN ('PAID_ORDER','LATE_ARRIVAL')),
  source_exception_id   bigint REFERENCES payment_exceptions(id),
  required_cents        bigint NOT NULL CHECK (required_cents > 0),  -- 冻结：订单金额或迟到到账金额
  settled_cents         bigint,
  currency              char(3) NOT NULL DEFAULT 'USD',
  status                text   NOT NULL DEFAULT 'REQUESTED'
                          CHECK (status IN ('REQUESTED','APPROVED','SETTLED','REJECTED','WITHDRAWN')),
  reason                text   NOT NULL,
  initiated_by_role     text   NOT NULL CHECK (initiated_by_role IN ('FINANCE','SUPPORT')),
  requested_by          bigint NOT NULL REFERENCES staff(id),
  approved_by           bigint REFERENCES staff(id),
  approved_at           timestamptz,
  settled_by            bigint REFERENCES staff(id),
  settled_at            timestamptz,
  payout_txn_ref        text,
  payout_proof_file_id  bigint REFERENCES files(id),
  rejected_by           bigint REFERENCES staff(id),
  rejected_at           timestamptz,
  reject_reason         text,
  user_confirmation     text,
  return_received_at    timestamptz,
  return_received_by    bigint REFERENCES staff(id),
  return_note           text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((origin = 'LATE_ARRIVAL') = (source_exception_id IS NOT NULL)),
  CHECK (NOT (origin = 'LATE_ARRIVAL' AND status IN ('REJECTED','WITHDRAWN'))),   -- D-094 R1
  CHECK (status <> 'SETTLED' OR (settled_cents = required_cents AND settled_at IS NOT NULL
                                 AND (payout_txn_ref IS NOT NULL OR payout_proof_file_id IS NOT NULL))),
  CHECK (return_received_at IS NULL OR (status = 'SETTLED' AND origin = 'PAID_ORDER'))
);
CREATE UNIQUE INDEX merch_refunds_one_active  ON merch_refunds (order_id) WHERE status IN ('REQUESTED','APPROVED');
CREATE UNIQUE INDEX merch_refunds_one_settled ON merch_refunds (order_id) WHERE status = 'SETTLED';
CREATE TRIGGER merch_refunds_updated BEFORE UPDATE ON merch_refunds FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE payment_exceptions
  ADD CONSTRAINT payment_exceptions_reg_refund_fk   FOREIGN KEY (settled_reg_refund_id)   REFERENCES reg_refunds(id),
  ADD CONSTRAINT payment_exceptions_merch_refund_fk FOREIGN KEY (settled_merch_refund_id) REFERENCES merch_refunds(id);
ALTER TABLE inventory_adjustments
  ADD CONSTRAINT inventory_adjustments_refund_fk FOREIGN KEY (source_refund_id) REFERENCES merch_refunds(id);

-- 用户端「帮我退款」「我付过了帮我查」——是诉求，不是 Refund
CREATE TABLE support_requests (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_no       text   NOT NULL UNIQUE,
  type             text   NOT NULL CHECK (type IN ('REFUND_HELP','PAYMENT_CHECK','INFO_CHANGE','OTHER')),
  user_id          bigint REFERENCES users(id),
  reg_order_id     bigint REFERENCES reg_orders(id),
  participant_id   bigint REFERENCES order_participants(id),
  merch_order_id   bigint REFERENCES merch_orders(id),
  reason           text   NOT NULL,
  contact          text   NOT NULL,
  status           text   NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','HANDLED','CLOSED')),
  handled_by       bigint REFERENCES staff(id),
  handled_at       timestamptz,
  reg_refund_id    bigint REFERENCES reg_refunds(id),
  merch_refund_id  bigint REFERENCES merch_refunds(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX support_requests_one_open ON support_requests (participant_id, type)
  WHERE status = 'OPEN' AND participant_id IS NOT NULL;
