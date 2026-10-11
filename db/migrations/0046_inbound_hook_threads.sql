-- +goose Up
-- Support-intake threading: posts carrying the same `key` land as replies
-- under the first message posted with that key (one ticket, one thread).
create table inbound_hook_threads (
    hook_id           uuid not null references inbound_hooks (id) on delete cascade,
    key               text not null,
    parent_message_id uuid not null references messages (id) on delete cascade,
    created_at        timestamptz not null default now(),
    primary key (hook_id, key)
);

-- +goose Down
drop table inbound_hook_threads;
