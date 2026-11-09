-- +goose Up
-- 主办方群发通知（v8 设计稿 10「发通知」）：按人群（已付款 / 待付款 / 精英组 / 志愿者）发一条消息，
-- 通过 Telegram 推送，同时显示在跑者的「我的赛事」。收件人在发送时算定并记下，之后人群变化不影响已发的。
CREATE TABLE event_broadcasts (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id         bigint NOT NULL REFERENCES events(id),
  audience         text   NOT NULL CHECK (audience IN ('PAID','PENDING','ELITE','VOLUNTEERS')),
  body             text   NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  recipient_count  int    NOT NULL CHECK (recipient_count >= 0),
  created_by       bigint NOT NULL REFERENCES staff(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_broadcasts_event_idx ON event_broadcasts (event_id, created_at DESC);

CREATE TABLE event_broadcast_recipients (
  broadcast_id  bigint NOT NULL REFERENCES event_broadcasts(id),
  user_id       bigint NOT NULL REFERENCES users(id),
  PRIMARY KEY (broadcast_id, user_id)
);
CREATE INDEX event_broadcast_recipients_user_idx ON event_broadcast_recipients (user_id, broadcast_id DESC);

-- +goose Down
DROP TABLE event_broadcast_recipients;
DROP TABLE event_broadcasts;
