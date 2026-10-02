-- +goose Up
-- Phase 17 follow-up: custom issue statuses per project, linked local
-- folders, saved filters, named boards, and Web Push subscriptions.

-- Status validation moves to the app layer so projects can define their own.
alter table issues drop constraint if exists issues_status_check;

-- file:read grants agents access to the project's linked local folder
alter table agent_project_permissions
    drop constraint agent_project_permissions_scopes_check;
alter table agent_project_permissions
    add constraint agent_project_permissions_scopes_check
    check (scopes <@ array[
        'project:read','message:read','message:write',
        'attachment:read','issue:read','issue:write',
        'review:read','review:write','file:read']::text[]);

-- NULL statuses means "use the built-in six". Otherwise JSONB array of
-- {id, label, color, closed} e.g. [{"id":"todo","label":"To do"}].
alter table projects add column if not exists statuses jsonb;

-- Optional path to a local checkout on the server host — the "connect a
-- folder" alternative to GitHub linking. Read-only exposure via /files.
alter table projects add column if not exists local_path text;

create table if not exists saved_filters (
    id         uuid primary key default gen_random_uuid(),
    project_id uuid not null references projects(id) on delete cascade,
    user_id    uuid not null references users(id) on delete cascade,
    name       text not null,
    filters    jsonb not null, -- {status,assignee,label,q}
    created_at timestamptz not null default now()
);

-- Named board views: same filters shape plus a board flag; kept separate so
-- boards can later gain column order / WIP limits without touching filters.
create table if not exists boards (
    id         uuid primary key default gen_random_uuid(),
    project_id uuid not null references projects(id) on delete cascade,
    name       text not null,
    filters    jsonb not null default '{}',
    created_at timestamptz not null default now()
);

create table if not exists push_subscriptions (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null references users(id) on delete cascade,
    endpoint   text not null unique,
    auth       text not null, -- browser p256dh/auth secrets
    keys       jsonb not null, -- {p256dh, auth}
    user_agent text,
    created_at timestamptz not null default now(),
    last_seen  timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on push_subscriptions (user_id);

-- +goose Down
alter table agent_project_permissions
    drop constraint agent_project_permissions_scopes_check;
alter table agent_project_permissions
    add constraint agent_project_permissions_scopes_check
    check (scopes <@ array[
        'project:read','message:read','message:write',
        'attachment:read','issue:read','issue:write',
        'review:read','review:write']::text[]);
drop table if exists push_subscriptions;
drop table if exists boards;
drop table if exists saved_filters;
alter table projects drop column if exists local_path;
alter table projects drop column if exists statuses;
alter table issues
    add constraint issues_status_check
    check (status in ('backlog','todo','in_progress','review','done','cancelled'));
