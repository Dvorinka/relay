-- +goose Up
-- Reminders: "remind me about this message later". project_id is stored
-- denormalized so the fire path can publish a scoped hub event and push
-- without re-joining through conversations.
create table reminders (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references users(id) on delete cascade,
    message_id  uuid not null references messages(id) on delete cascade,
    project_id  uuid not null references projects(id) on delete cascade,
    fire_at     timestamptz not null,
    fired_at    timestamptz,
    created_at  timestamptz not null default now()
);
create index reminders_due_idx on reminders (fire_at) where fired_at is null;
create index reminders_user_idx on reminders (user_id, created_at desc);

-- +goose Down
drop table reminders;
