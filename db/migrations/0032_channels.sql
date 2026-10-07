-- +goose Up
-- Channels: persistent named conversations inside a project, Discord-style.
-- kind='channel', the name lives in `title`. agents_blocked hides a channel
-- from MCP agents (per-channel agent access). expires_at is set on threads —
-- default five days, adjustable — and expired threads are swept on read.

alter table conversations drop constraint conversations_kind_check;
alter table conversations add constraint conversations_kind_check
    check (kind in ('project', 'issue', 'brief', 'thread', 'channel'));

alter table conversations
    add column expires_at timestamptz,
    add column agents_blocked boolean not null default false;

-- channel names unique per project, case-insensitive
create unique index conversations_channel_name_uq
    on conversations (project_id, lower(title)) where kind = 'channel';
create index conversations_expiry_idx
    on conversations (expires_at) where expires_at is not null;

-- +goose Down
drop index conversations_expiry_idx;
drop index conversations_channel_name_uq;
alter table conversations drop column agents_blocked;
alter table conversations drop column expires_at;
alter table conversations drop constraint conversations_kind_check;
alter table conversations add constraint conversations_kind_check
    check (kind in ('project', 'issue', 'brief', 'thread'));
