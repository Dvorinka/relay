-- +goose Up
-- File attachments. Objects live in S3-compatible storage under
-- <project_id>/<attachment_id>; rows track status pending -> ready.

create table attachments (
    id           uuid primary key default gen_random_uuid(),
    project_id   uuid not null references projects(id) on delete cascade,
    uploader_id  uuid not null references users(id) on delete cascade,
    storage_key  text not null unique,
    filename     text not null check (length(filename) between 1 and 255),
    content_type text not null,
    size_bytes   bigint not null check (size_bytes >= 0),
    status       text not null default 'pending' check (status in ('pending', 'ready')),
    created_at   timestamptz not null default now()
);
create index attachments_project_idx on attachments (project_id);

create table message_attachments (
    message_id    uuid not null references messages(id) on delete cascade,
    attachment_id uuid not null references attachments(id) on delete cascade,
    position      integer not null default 0,
    primary key (message_id, attachment_id)
);
create index message_attachments_attachment_idx on message_attachments (attachment_id);

-- +goose Down
drop table if exists message_attachments;
drop table if exists attachments;
