-- +goose Up
-- Allow image/file-only messages: the API requires body OR at least one
-- attachment, so the column-level minimum is dropped to 0.

alter table messages drop constraint messages_body_check;
alter table messages add constraint messages_body_check check (length(body) <= 20000);

-- +goose Down
alter table messages drop constraint messages_body_check;
alter table messages add constraint messages_body_check check (length(body) between 1 and 20000);
