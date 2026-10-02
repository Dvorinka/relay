-- +goose Up
-- Threaded replies and emoji reactions. parent_id is a soft thread link -
-- deleting the parent clears children's reference (set null) rather than
-- cascading, so replies survive a removed parent.

alter table messages
    add column parent_id uuid references messages(id) on delete set null;
create index messages_parent_idx on messages (parent_id) where parent_id is not null;

create table message_reactions (
    message_id uuid not null references messages(id) on delete cascade,
    user_id    uuid references users(id) on delete cascade,
    agent_id   uuid references agents(id) on delete cascade,
    emoji      text not null check (length(emoji) between 1 and 32),
    created_at timestamptz not null default now(),
    check ((user_id is null) <> (agent_id is null))
);
create unique index message_reactions_user_idx
    on message_reactions (message_id, user_id, emoji) where user_id is not null;
create unique index message_reactions_agent_idx
    on message_reactions (message_id, agent_id, emoji) where agent_id is not null;

-- +goose Down
drop table message_reactions;
drop index messages_parent_idx;
alter table messages drop column parent_id;
