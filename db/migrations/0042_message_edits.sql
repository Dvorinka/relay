-- +goose Up
-- Previous bodies of edited messages — the "edited · view history" audit
-- trail. One row per edit; the current body stays on messages.body.
create table message_edits (
    id         uuid primary key default gen_random_uuid(),
    message_id uuid not null references messages(id) on delete cascade,
    body       text not null,
    edited_by  uuid not null references users(id) on delete cascade,
    edited_at  timestamptz not null default now()
);
create index message_edits_message_idx on message_edits (message_id, edited_at);

-- +goose Down
drop table message_edits;
