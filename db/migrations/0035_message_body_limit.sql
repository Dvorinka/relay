-- +goose Up
-- Raise the message body ceiling to match the API's MaxMessageBodyChars
-- (1M chars): pasted logs, MIME dumps and diffs blew past 20k.

alter table messages drop constraint messages_body_check;
alter table messages add constraint messages_body_check check (length(body) <= 1000000);

-- +goose Down
alter table messages drop constraint messages_body_check;
alter table messages add constraint messages_body_check check (length(body) <= 20000);
