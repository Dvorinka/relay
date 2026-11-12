-- +goose Up
alter table users add column github_login text not null default '';

-- +goose Down
alter table users drop column github_login;
