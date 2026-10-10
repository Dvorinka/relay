-- +goose Up
-- Presence: online state lives in the realtime service's in-memory set;
-- last_seen_at persists the moment a user's last SSE connection closed so
-- profiles can show "last seen …" for offline users.
alter table users add column last_seen_at timestamptz;

-- +goose Down
alter table users drop column last_seen_at;
