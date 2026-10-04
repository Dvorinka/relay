-- +goose Up
-- Message pinning, forwards, and image icons for projects/workspaces.

alter table messages
    add column pinned_at timestamptz,
    add column forwarded_from uuid references messages(id) on delete set null;

-- pins list reads newest-pinned first within one conversation
create index messages_pinned_idx
    on messages (conversation_id, pinned_at)
    where pinned_at is not null;

-- image icons reusing the avatars/ object prefix; served via /api/files/
alter table projects add column avatar_key text;
alter table workspaces add column avatar_key text;

-- +goose Down
alter table workspaces drop column avatar_key;
alter table projects drop column avatar_key;
drop index if exists messages_pinned_idx;
alter table messages
    drop column forwarded_from,
    drop column pinned_at;
