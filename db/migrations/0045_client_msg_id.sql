-- +goose Up
-- Client-supplied idempotency key on messages. The composer stamps one per
-- send; the server dedupes on it, so the offline outbox can safely replay a
-- send that may have reached the server before the connection dropped.
alter table messages add column client_msg_id text;
create unique index messages_client_msg_id_key
    on messages (conversation_id, client_msg_id)
    where client_msg_id is not null;

-- +goose Down
drop index messages_client_msg_id_key;
alter table messages drop column client_msg_id;
