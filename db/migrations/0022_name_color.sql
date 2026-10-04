-- +goose Up
-- Per-user chat name color (Discord-style); null = palette default.

alter table users
    add column name_color text;

-- +goose Down
alter table users
    drop column name_color;
