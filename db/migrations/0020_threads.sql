-- +goose Up
-- Threads: a child conversation rooted at one message (Discord-style).
-- kind='thread', parent_message_id points at the seed message, title is
-- optional. Reply counts derive from messages - no denormalized state.
alter table conversations drop constraint conversations_kind_check;
alter table conversations add constraint conversations_kind_check
    check (kind in ('project', 'issue', 'brief', 'thread'));

alter table conversations
    add column parent_message_id uuid references messages(id) on delete cascade,
    add column title text,
    add column created_by_user uuid references users(id) on delete set null,
    add column created_by_agent uuid references agents(id) on delete set null;

-- at most one thread per message
create unique index conversations_thread_parent_uq
    on conversations (parent_message_id) where kind = 'thread';

-- +goose Down
drop index conversations_thread_parent_uq;
alter table conversations drop column created_by_agent;
alter table conversations drop column created_by_user;
alter table conversations drop column title;
alter table conversations drop column parent_message_id;
alter table conversations drop constraint conversations_kind_check;
alter table conversations add constraint conversations_kind_check
    check (kind in ('project', 'issue', 'brief'));
