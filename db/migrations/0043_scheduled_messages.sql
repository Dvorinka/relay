-- +goose Up
-- Scheduled sends: a draft parked server-side until send_at, then the
-- scheduler posts it through the normal message path (mentions, events,
-- push). sent_at marks the sweep has consumed it.
create table scheduled_messages (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid not null references users(id) on delete cascade,
    conversation_id uuid not null references conversations(id) on delete cascade,
    project_id      uuid not null references projects(id) on delete cascade,
    body            text not null,
    parent_id       uuid references messages(id) on delete set null,
    tags            jsonb not null default '[]',
    send_at         timestamptz not null,
    sent_at         timestamptz,
    created_at      timestamptz not null default now()
);
create index scheduled_messages_due_idx on scheduled_messages (send_at) where sent_at is null;
create index scheduled_messages_user_idx on scheduled_messages (user_id, send_at);

-- +goose Down
drop table scheduled_messages;
