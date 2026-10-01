-- +goose Up
-- Projects, conversations, messages. Message authorship is a nullable
-- user/agent pair - exactly one side is set (agents land in phase 5).

create table projects (
    id           uuid primary key default gen_random_uuid(),
    workspace_id uuid not null references workspaces(id) on delete cascade,
    key          text not null check (key ~ '^[A-Z0-9]{2,6}$'),
    name         text not null check (length(trim(name)) between 1 and 80),
    description  text not null default '',
    icon         text,
    color        text check (color is null or color ~ '^#[0-9a-fA-F]{6}$'),
    created_by   uuid references users(id),
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    unique (workspace_id, key)
);

create table project_members (
    project_id uuid not null references projects(id) on delete cascade,
    user_id    uuid not null references users(id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (project_id, user_id)
);

-- issue numbering lands with issues (phase 4); the table exists now so the
-- counter pattern is settled.
create table project_counters (
    project_id        uuid primary key references projects(id) on delete cascade,
    next_issue_number integer not null default 1
);

create table conversations (
    id         uuid primary key default gen_random_uuid(),
    project_id uuid not null references projects(id) on delete cascade,
    kind       text not null default 'project' check (kind in ('project', 'issue')),
    issue_id   uuid, -- FK to issues lands in phase 4
    created_at timestamptz not null default now()
);
create index conversations_project_idx on conversations (project_id);
-- one project channel per project
create unique index conversations_project_channel
    on conversations (project_id) where kind = 'project';

create table messages (
    id              uuid primary key default gen_random_uuid(),
    conversation_id uuid not null references conversations(id) on delete cascade,
    author_user_id  uuid references users(id) on delete set null,
    author_agent_id uuid, -- FK to agents lands in phase 5
    body            text not null check (length(body) between 1 and 20000),
    created_at      timestamptz not null default now(),
    edited_at       timestamptz,
    deleted_at      timestamptz,
    check ((author_user_id is null) <> (author_agent_id is null))
);
create index messages_conversation_idx on messages (conversation_id, created_at, id);

create table message_reads (
    message_id uuid not null references messages(id) on delete cascade,
    user_id    uuid references users(id) on delete cascade,
    agent_id   uuid, -- FK to agents lands in phase 5
    read_at    timestamptz not null default now(),
    check ((user_id is null) <> (agent_id is null))
);
create unique index message_reads_user_idx
    on message_reads (message_id, user_id) where user_id is not null;

-- +goose Down
drop table message_reads;
drop table messages;
drop table conversations;
drop table project_counters;
drop table project_members;
drop table projects;
