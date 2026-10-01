-- +goose Up
-- Agent identities, per-project scoped grants, and hashed MCP tokens.

create table agents (
    id           uuid primary key default gen_random_uuid(),
    workspace_id uuid not null references workspaces(id) on delete cascade,
    name         text not null check (length(trim(name)) between 1 and 60),
    slug         text not null check (slug ~ '^[a-z0-9][a-z0-9-]*$'),
    description  text not null default '',
    avatar_key   text,
    created_by   uuid references users(id),
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    unique (workspace_id, slug)
);

create table agent_project_permissions (
    agent_id   uuid not null references agents(id) on delete cascade,
    project_id uuid not null references projects(id) on delete cascade,
    scopes     text[] not null check (scopes <@ array[
        'project:read','message:read','message:write',
        'attachment:read','issue:read','issue:write']::text[]),
    created_at timestamptz not null default now(),
    primary key (agent_id, project_id)
);

create table mcp_tokens (
    id           uuid primary key default gen_random_uuid(),
    agent_id     uuid not null references agents(id) on delete cascade,
    token_hash   bytea not null unique,      -- sha256 of the rly_ token
    name         text not null check (length(trim(name)) between 1 and 60),
    last_used_at timestamptz,
    expires_at   timestamptz,
    revoked_at   timestamptz,
    created_at   timestamptz not null default now()
);
create index mcp_tokens_agent_idx on mcp_tokens (agent_id);

-- agent authorship FKs declared in earlier migrations now resolve; the
-- read-marker table gains its agent side too
alter table message_reads
    add constraint message_reads_agent_fkey
    foreign key (agent_id) references agents(id) on delete cascade;
create unique index message_reads_agent_idx
    on message_reads (message_id, agent_id) where agent_id is not null;
alter table messages
    add constraint messages_author_agent_fkey
    foreign key (author_agent_id) references agents(id) on delete set null;
alter table issues
    add constraint issues_agent_fkey
    foreign key (agent_id) references agents(id) on delete set null;
alter table issue_activity
    add constraint issue_activity_agent_fkey
    foreign key (actor_agent_id) references agents(id) on delete set null;

-- +goose Down
drop index if exists message_reads_agent_idx;
alter table message_reads drop constraint if exists message_reads_agent_fkey;
alter table issue_activity drop constraint if exists issue_activity_agent_fkey;
alter table issues drop constraint if exists issues_agent_fkey;
alter table messages drop constraint if exists messages_author_agent_fkey;
drop table if exists mcp_tokens;
drop table if exists agent_project_permissions;
drop table if exists agents;
