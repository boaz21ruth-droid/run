\set ON_ERROR_STOP 1
BEGIN;
SET client_min_messages = notice;

CREATE OR REPLACE FUNCTION pg_temp.expect_fail(label text, stmt text) RETURNS void AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
    RAISE NOTICE 'FAIL  % (statement succeeded)', label;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'PASS  % -> %', label, SQLERRM;
  END;
END $$ LANGUAGE plpgsql;

-- ---------- seed ----------
INSERT INTO files (storage_key, visibility, purpose, mime_type, size_bytes, sha256, uploaded_by_type)
VALUES ('qr/aba-usd.png','PUBLIC','PAYMENT_QR','image/png',100,'\x01','SYSTEM'),
       ('proof/1.jpg','PRIVATE','PAYMENT_PROOF','image/jpeg',100,'\x02','USER'),
       ('proof/2.jpg','PRIVATE','PAYMENT_PROOF','image/jpeg',100,'\x02','USER');
INSERT INTO staff (username, full_name, role, password_hash) VALUES
  ('finance.mao','Maolin Tep','FINANCE','x'), ('ops.chan','Chanthou Ny','OPS','x');
INSERT INTO users (phone_e164) VALUES ('+85512345678');
INSERT INTO events (slug, event_type, organizer_type, name, city, race_date, status, published_at, registration_open)
VALUES ('pphm-2026','RACE','OFFICIAL','{"zh":"金边半马"}','Phnom Penh','2026-11-15','PUBLISHED',now(),true);
INSERT INTO event_categories (event_id, code, name, distance_m, capacity, used_count)
VALUES (1,'10K','{"zh":"欢乐 10K"}',10000,2,1);
INSERT INTO price_rules (event_id, name, audience, price_cents, quota) VALUES (1,'{"zh":"标准价"}','ALL',2200,100);
INSERT INTO payment_accounts (name, provider, account_name, account_no_masked, currency, qr_file_id)
VALUES ('ABA USD','ABA','RUN CO','***123','USD',1);

-- 1 名额：条件 UPDATE 占到第 2 个；第 3 个被 CHECK 拦下
UPDATE event_categories SET reserved_count = reserved_count + 1 WHERE id = 1;
SELECT pg_temp.expect_fail('category oversell',
  'UPDATE event_categories SET reserved_count = reserved_count + 1 WHERE id = 1');

-- 订单 + 参赛人
INSERT INTO reg_orders (order_no, event_id, buyer_name, buyer_phone_e164, status, reservation_state,
                        list_amount_cents, discount_cents, ident_offset_cents, amount_cents, payment_account_id, deadline_at)
VALUES ('R2026-0001',1,'Sok Dara','+85512345678','PENDING_PAYMENT','RESERVED',2200,7,7,2193,1, now()+interval '30 min');
INSERT INTO order_participants (order_id, category_id, price_rule_id, audience, list_price_cents, paid_cents, snapshot_name)
VALUES (1,1,1,'ALL',2200,2193,'Sok Dara');
INSERT INTO registrations (reg_no, order_participant_id, event_id, category_id, status, ticket_code, full_name, gender, birth_date, nationality)
VALUES ('REG-1',1,1,1,'PENDING','tkt-abc','Sok Dara','M','1996-04-18','KH');

SELECT pg_temp.expect_fail('amount must equal list - discount',
  $q$UPDATE reg_orders SET amount_cents = 2000 WHERE id = 1$q$);
SELECT pg_temp.expect_fail('participant snapshot immutable',
  $q$UPDATE order_participants SET paid_cents = 100 WHERE id = 1$q$);
SELECT pg_temp.expect_fail('expired order must have released reservation',
  $q$UPDATE reg_orders SET status = 'EXPIRED' WHERE id = 1$q$);

-- 2 凭证：同一交易号不能挂两单；同一订单只能有一份待审
INSERT INTO payment_proofs (proof_no, reg_order_id, payment_account_id, file_id, declared_amount_cents, declared_currency, bank_txn_ref)
VALUES ('P-1',1,1,2,2193,'USD','ABA88213');
INSERT INTO reg_orders (order_no, event_id, buyer_name, buyer_phone_e164, status, reservation_state,
                        list_amount_cents, amount_cents, payment_account_id)
VALUES ('R2026-0002',1,'Nary Pich','+85596222118','PENDING_PAYMENT','RELEASED',2200,2200,1);
SELECT pg_temp.expect_fail('same bank txn ref on two orders',
  $q$INSERT INTO payment_proofs (proof_no, reg_order_id, payment_account_id, file_id, declared_amount_cents, declared_currency, bank_txn_ref)
     VALUES ('P-2',2,1,3,2200,'USD','ABA88213')$q$);
SELECT pg_temp.expect_fail('second pending proof on same order',
  $q$INSERT INTO payment_proofs (proof_no, reg_order_id, payment_account_id, file_id, declared_amount_cents, declared_currency, bank_txn_ref)
     VALUES ('P-3',1,1,3,2193,'USD','ABA99999')$q$);
SELECT pg_temp.expect_fail('reject without reason code',
  $q$UPDATE payment_proofs SET status='REJECTED', reviewed_by=1, reviewed_at=now() WHERE id=1$q$);

-- 通过：凭证 APPROVED → 入账 → 订单 PAID，名额 RESERVED→CONSUMED
UPDATE payment_proofs SET status='APPROVED', reviewed_by=1, reviewed_at=now() WHERE id=1;
INSERT INTO payment_receipts (payment_account_id, txn_ref, amount_cents, currency, received_at, proof_id, reg_order_id, match_status, recorded_by_type, recorded_by)
VALUES (1,'ABA88213',2193,'USD',now(),1,1,'APPLIED','STAFF',1);
SELECT pg_temp.expect_fail('same bank txn recorded twice',
  $q$INSERT INTO payment_receipts (payment_account_id, txn_ref, amount_cents, currency, received_at, match_status, recorded_by_type)
     VALUES (1,'ABA88213',2193,'USD',now(),'UNMATCHED','SYSTEM')$q$);
UPDATE event_categories SET reserved_count = reserved_count - 1, used_count = used_count + 1 WHERE id = 1;
UPDATE reg_orders SET status='PAID', reservation_state='CONSUMED', paid_at=now(), deadline_at=NULL WHERE id=1;
UPDATE registrations SET status='CONFIRMED', confirmed_at=now() WHERE id=1;

-- 3 退款上限：实付 2193，申请 3000 被拦；2193 可以
SELECT pg_temp.expect_fail('refund above paid amount',
  $q$INSERT INTO reg_refunds (refund_no, order_id, participant_id, kind, requested_cents, reason, initiated_by_role, requested_by)
     VALUES ('RF-X',1,1,'PARTICIPANT_CANCEL',3000,'injury','FINANCE',1)$q$);
INSERT INTO reg_refunds (refund_no, order_id, participant_id, kind, requested_cents, reason, initiated_by_role, requested_by)
VALUES ('RF-1',1,1,'PARTICIPANT_CANCEL',2193,'injury','FINANCE',1);
SELECT pg_temp.expect_fail('second open refund for same participant',
  $q$INSERT INTO reg_refunds (refund_no, order_id, participant_id, kind, requested_cents, reason, initiated_by_role, requested_by)
     VALUES ('RF-2',1,1,'PARTICIPANT_CANCEL',100,'dup','SUPPORT',1)$q$);
SELECT pg_temp.expect_fail('settle without payout proof',
  $q$UPDATE reg_refunds SET status='SETTLED', approved_cents=2193, settled_cents=2193, settled_at=now() WHERE refund_no='RF-1'$q$);
UPDATE reg_refunds SET status='SETTLED', approved_cents=2193, approved_by=1, approved_at=now(),
       settled_cents=2193, settled_by=1, settled_at=now(), payout_txn_ref='OUT-1' WHERE refund_no='RF-1';
SELECT pg_temp.expect_fail('supplemental refund beyond paid total',
  $q$INSERT INTO reg_refunds (refund_no, order_id, participant_id, kind, refund_type, requested_cents, reason, initiated_by_role, requested_by)
     VALUES ('RF-3',1,1,'PARTICIPANT_CANCEL','SUPPLEMENTAL',1,'extra','FINANCE',1)$q$);

-- 4 号码布：历史号永不复用；一人一个当前号
INSERT INTO bib_ranges (event_id, category_id, range_from, range_to, reserved_from, reserved_to, assign_mode)
VALUES (1,1,2000,2999,2090,2099,'AUTO');
SELECT pg_temp.expect_fail('overlapping bib range in same event',
  $q$INSERT INTO event_categories (event_id, code, name, distance_m, capacity) VALUES (1,'5K','{}',5000,10);
     INSERT INTO bib_ranges (event_id, category_id, range_from, range_to, assign_mode) VALUES (1,2,2500,3500,'AUTO')$q$);
INSERT INTO bib_assignments (event_id, bib_number, registration_id, status, assign_method, created_by)
VALUES (1,2010,1,'ASSIGNED','MANUAL',2);
SELECT pg_temp.expect_fail('second current bib for same registration',
  $q$INSERT INTO bib_assignments (event_id, bib_number, registration_id, status, created_by) VALUES (1,2031,1,'ASSIGNED',2)$q$);
INSERT INTO bib_assignments (event_id, bib_number, registration_id, status, assign_method, created_by)
VALUES (1,2031,NULL,'RESERVED',NULL,2);
UPDATE bib_assignments SET status='VOIDED' WHERE bib_number=2031;
SELECT pg_temp.expect_fail('reuse voided bib number',
  $q$INSERT INTO bib_assignments (event_id, bib_number, registration_id, status, created_by) VALUES (1,2031,1,'ASSIGNED',2)$q$);

-- 5 审计只追加
INSERT INTO audit_logs (actor_type, action, entity_type, entity_id, summary) VALUES ('SYSTEM','test','reg_order',1,'x');
SELECT pg_temp.expect_fail('audit log update', $q$UPDATE audit_logs SET summary='y'$q$);

-- 6 周边：库存不可超卖；LATE_ARRIVAL 退款不可拒绝
INSERT INTO merch_products (name, status) VALUES ('{"zh":"T 恤"}','ON_SALE');
INSERT INTO merch_skus (product_id, variant, size, price_cents, on_hand) VALUES (1,'黑','M',1200,1);
SELECT pg_temp.expect_fail('merch oversell', $q$UPDATE merch_skus SET reserved = 2 WHERE id = 1$q$);

-- 7 识别分 ≤ 50 美分（报名 / 周边）
SELECT pg_temp.expect_fail('ident offset above 50 cents',
  $q$UPDATE reg_orders SET ident_offset_cents = 51, discount_cents = 51, amount_cents = 2149 WHERE order_no = 'R2026-0002'$q$);
SELECT pg_temp.expect_fail('merch amount must equal items minus ident offset',
  $q$INSERT INTO merch_orders (order_no, buyer_name, buyer_phone_e164, status, list_amount_cents, ident_offset_cents, amount_cents)
     VALUES ('M-1','Ratana Kim','+85577900431','PENDING_PAYMENT',2400,7,2400)$q$);

-- 8 免费活动不建订单；付费赛事不能走免费报名
INSERT INTO events (slug, event_type, organizer_type, name, city, race_date)
VALUES ('sat-run-128','FREE_ACTIVITY','OFFICIAL','{"zh":"RUN 周六晨跑 · 第 128 期"}','Phnom Penh','2026-11-21');
INSERT INTO event_categories (event_id, code, name, distance_m, capacity)
SELECT id, '5K', '{"zh":"5K 自由跑"}', 5000, 64 FROM events WHERE slug = 'sat-run-128';
SELECT pg_temp.expect_fail('paid order on free activity',
  $q$INSERT INTO reg_orders (order_no, event_id, buyer_name, buyer_phone_e164, status, reservation_state, list_amount_cents, amount_cents, paid_at)
     SELECT 'R-FREE', id, 'Sok Dara', '+85512345678', 'PAID', 'CONSUMED', 0, 0, now() FROM events WHERE slug = 'sat-run-128'$q$);
SELECT pg_temp.expect_fail('free signup on paid race',
  $q$INSERT INTO free_signups (signup_no, event_id, category_id, full_name, phone_e164)
     VALUES ('FS-X', 1, 1, 'Sok Dara', '+85512345678')$q$);
INSERT INTO free_signups (signup_no, event_id, category_id, full_name, phone_e164)
SELECT 'FS-1', e.id, c.id, 'Sok Dara', '+85512345678'
  FROM events e JOIN event_categories c ON c.event_id = e.id WHERE e.slug = 'sat-run-128';
SELECT pg_temp.expect_fail('duplicate free signup same person',
  $q$INSERT INTO free_signups (signup_no, event_id, category_id, full_name, phone_e164)
     SELECT 'FS-2', e.id, c.id, 'sok dara', '+85512345678'
       FROM events e JOIN event_categories c ON c.event_id = e.id WHERE e.slug = 'sat-run-128'$q$);

-- 9 跑友活动：不需要审核的活动不能停在审核中
INSERT INTO disclaimer_versions (version, lang, effective_date, full_text, items, text_sha256)
VALUES ('UGC-DISC-v1.1','zh','2026-08-06','（全文）','[]','\x03');
INSERT INTO disclaimer_signatures (version, lang, text_sha256, user_id, checked_items)
VALUES ('UGC-DISC-v1.1','zh','\x03',1,'{"organizer":true,"liability":true,"content":true}');
SELECT pg_temp.expect_fail('review-free activity stuck in REVIEWING',
  $q$INSERT INTO community_activities (author_user_id, signature_id, event_id, review_required, title, tag, starts_at,
                                       location, meet_point, capacity, contact_telegram, body, status)
     VALUES (1, 1, 1, false, '周三夜跑 · 滨河大道 8 公里', 'NIGHT', now() + interval '2 day',
             '金边 · 滨河大道', '王宫广场旗杆下', 20, '@vuthy_run', '配速 6:00–6:30', 'REVIEWING')$q$);
INSERT INTO community_activities (author_user_id, signature_id, event_id, review_required, title, tag, starts_at,
                                  location, meet_point, capacity, contact_telegram, body, status)
VALUES (1, 1, 1, false, '周三夜跑 · 滨河大道 8 公里', 'NIGHT', now() + interval '2 day',
        '金边 · 滨河大道', '王宫广场旗杆下', 20, '@vuthy_run', '配速 6:00–6:30', 'PUBLISHED');

ROLLBACK;
