-- +goose Up
ALTER TABLE disclaimer_versions
  ADD COLUMN purpose text NOT NULL DEFAULT 'COMMUNITY' CHECK (purpose IN ('COMMUNITY','REGISTRATION'));

CREATE TABLE registration_consents (
  signature_id   bigint PRIMARY KEY REFERENCES disclaimer_signatures(id),
  reg_order_id   bigint REFERENCES reg_orders(id),
  free_signup_id bigint REFERENCES free_signups(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(reg_order_id, free_signup_id) = 1)
);
CREATE INDEX registration_consents_order_idx ON registration_consents (reg_order_id) WHERE reg_order_id IS NOT NULL;
CREATE INDEX registration_consents_free_idx  ON registration_consents (free_signup_id) WHERE free_signup_id IS NOT NULL;
CREATE TRIGGER registration_consents_append_only BEFORE UPDATE OR DELETE ON registration_consents
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- +goose Down
DROP TABLE registration_consents;
ALTER TABLE disclaimer_versions DROP COLUMN purpose;
