-- +goose Up
-- 推荐渠道与免费入场（v8 设计稿 02、10）。
--
-- 优惠码新增 PRICE 类型：每位参赛人按固定价收费（discount_value 为每人价格，单位分），
-- 「推荐价 $18，不随档位上涨」；原价已低于固定价的参赛人不加价。
-- owner_user_id：只有这位跑者能用（免费入场审批通过后发的专属码）；max_runners：一单最多几人。
ALTER TABLE coupons DROP CONSTRAINT coupons_discount_type_check;
ALTER TABLE coupons ADD CONSTRAINT coupons_discount_type_check
  CHECK (discount_type IN ('PERCENT','AMOUNT','WAIVER','PRICE'));
ALTER TABLE coupons ADD COLUMN owner_user_id bigint REFERENCES users(id);
ALTER TABLE coupons ADD COLUMN max_runners smallint CHECK (max_runners IS NULL OR max_runners >= 1);
ALTER TABLE coupons ADD CONSTRAINT coupons_runner_range
  CHECK (min_runners IS NULL OR max_runners IS NULL OR min_runners <= max_runners);

-- 推荐链接：一条链接 = 一个渠道（跑团 / KOL / 赞助商 / 频道），可带一个优惠码。
-- 访问 /r/<slug> 计一次点击；订单记下归因到哪条链接。
CREATE TABLE referral_links (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id     bigint NOT NULL REFERENCES events(id),
  slug         text   NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,32}$'),
  label        text   NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
  kind         text   NOT NULL CHECK (kind IN ('CLUB','KOL','SPONSOR','CHANNEL','OTHER')),
  coupon_id    bigint UNIQUE REFERENCES coupons(id),
  click_count  bigint NOT NULL DEFAULT 0 CHECK (click_count >= 0),
  status       text   NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  created_by   bigint REFERENCES staff(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX referral_links_event_idx ON referral_links (event_id, created_at);
CREATE TRIGGER referral_links_updated BEFORE UPDATE ON referral_links FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE reg_orders ADD COLUMN referral_link_id bigint REFERENCES referral_links(id);
CREATE INDEX reg_orders_referral_idx ON reg_orders (referral_link_id) WHERE referral_link_id IS NOT NULL;

-- 免费入场：comp_quota 为 NULL 时不开放申请；否则最多批准这么多人。
ALTER TABLE events ADD COLUMN comp_quota int CHECK (comp_quota IS NULL OR comp_quota >= 0);

-- 免费入场申请：KOL / 跑团团长 / 赞助商 / 媒体提交，运营审批；批准即发一个专属 PRICE=0 的优惠码。
CREATE TABLE comp_requests (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id        bigint NOT NULL REFERENCES events(id),
  user_id         bigint NOT NULL REFERENCES users(id),
  applicant_name  text   NOT NULL CHECK (char_length(applicant_name) BETWEEN 1 AND 80),
  kind            text   NOT NULL CHECK (kind IN ('KOL','CLUB','SPONSOR','MEDIA')),
  profile_url     text   CHECK (profile_url IS NULL OR char_length(profile_url) <= 300),
  audience        text   CHECK (audience IS NULL OR char_length(audience) <= 80),
  note            text   CHECK (note IS NULL OR char_length(note) <= 500),
  status          text   NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  coupon_id       bigint UNIQUE REFERENCES coupons(id),
  review_note     text,
  reviewed_by     bigint REFERENCES staff(id),
  reviewed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'APPROVED') = (coupon_id IS NOT NULL)),
  CHECK ((status = 'PENDING') = (reviewed_at IS NULL))
);
-- 同一跑者同一赛事只能有一条进行中或已批准的申请；被拒后可以重新申请
CREATE UNIQUE INDEX comp_requests_active_key ON comp_requests (event_id, user_id) WHERE status <> 'REJECTED';
CREATE INDEX comp_requests_event_idx ON comp_requests (event_id, status, created_at);
CREATE TRIGGER comp_requests_updated BEFORE UPDATE ON comp_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- +goose Down
DROP TABLE comp_requests;
ALTER TABLE events DROP COLUMN comp_quota;
DROP INDEX reg_orders_referral_idx;
ALTER TABLE reg_orders DROP COLUMN referral_link_id;
DROP TABLE referral_links;
ALTER TABLE coupons DROP CONSTRAINT coupons_runner_range;
ALTER TABLE coupons DROP COLUMN max_runners;
ALTER TABLE coupons DROP COLUMN owner_user_id;
ALTER TABLE coupons DROP CONSTRAINT coupons_discount_type_check;
ALTER TABLE coupons ADD CONSTRAINT coupons_discount_type_check
  CHECK (discount_type IN ('PERCENT','AMOUNT','WAIVER'));
