-- +goose Up
-- 领物核销站（v8）：代领要记下代领人，现场才能对上「谁拿走了这份物资」。
-- race_pack_facts 存当前事实；扫码流水只追加，同样记下当时的代领人。
ALTER TABLE race_pack_facts ADD COLUMN proxy_name text;
ALTER TABLE race_pack_facts ADD CONSTRAINT race_pack_facts_proxy_only_when_picked
  CHECK (proxy_name IS NULL OR picked);
ALTER TABLE race_pack_scan_logs ADD COLUMN proxy_name text;

-- 核销站按赛事看「最近发放」
CREATE INDEX race_pack_scan_logs_event_idx ON race_pack_scan_logs (event_id, synced_at DESC);

-- +goose Down
DROP INDEX race_pack_scan_logs_event_idx;
ALTER TABLE race_pack_scan_logs DROP COLUMN proxy_name;
ALTER TABLE race_pack_facts DROP CONSTRAINT race_pack_facts_proxy_only_when_picked;
ALTER TABLE race_pack_facts DROP COLUMN proxy_name;
