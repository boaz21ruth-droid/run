-- +goose Up
-- 到账记录是对账的事实依据：入账后金额、币种、收款账户、银行交易号、到账时间以及来源（凭证、录入人）
-- 都不允许再改（0005 只禁止了 DELETE）。目前代码不更新 payment_receipts 的任何列；
-- match_status 与订单关联（reg_order_id / merch_order_id）保留可改，留给对账处理把 UNMATCHED 到账匹配到订单。
-- +goose StatementBegin
CREATE FUNCTION forbid_receipt_core_update() RETURNS trigger AS $$
BEGIN
  IF NEW.id                 IS DISTINCT FROM OLD.id
  OR NEW.payment_account_id IS DISTINCT FROM OLD.payment_account_id
  OR NEW.txn_ref            IS DISTINCT FROM OLD.txn_ref
  OR NEW.amount_cents       IS DISTINCT FROM OLD.amount_cents
  OR NEW.currency           IS DISTINCT FROM OLD.currency
  OR NEW.received_at        IS DISTINCT FROM OLD.received_at
  OR NEW.proof_id           IS DISTINCT FROM OLD.proof_id
  OR NEW.recorded_by_type   IS DISTINCT FROM OLD.recorded_by_type
  OR NEW.recorded_by        IS DISTINCT FROM OLD.recorded_by
  OR NEW.created_at         IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'payment_receipts % : money and identity columns are immutable', OLD.id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
-- +goose StatementEnd

CREATE TRIGGER payment_receipts_core_immutable BEFORE UPDATE ON payment_receipts
  FOR EACH ROW EXECUTE FUNCTION forbid_receipt_core_update();

-- +goose Down
DROP TRIGGER payment_receipts_core_immutable ON payment_receipts;
DROP FUNCTION forbid_receipt_core_update();
