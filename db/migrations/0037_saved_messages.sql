-- +goose Up
-- Saved messages: a personal "save for later" list distinct from pins
-- (shared) and reminders (time-based). Per-user, so no membership check
-- beyond message visibility at save time.
create table saved_messages (
    user_id    uuid not null references users(id) on delete cascade,
    message_id uuid not null references messages(id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (user_id, message_id)
);

-- +goose Down
drop table saved_messages;
