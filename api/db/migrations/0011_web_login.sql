-- +goose Up
ALTER TABLE auth_otps ADD COLUMN provider_request_id text;

-- +goose Down
ALTER TABLE auth_otps DROP COLUMN provider_request_id;
