-- +goose Up
-- Free-form message tags (frontend/backend/visual/mcp/…); [] when untagged.

alter table messages
    add column tags text[] not null default '{}';

-- +goose Down
alter table messages
    drop column tags;
