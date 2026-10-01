-- +goose Up
-- Core identity tables: users, sessions, workspaces, workspace_members.
create table users (
    id            uuid primary key default gen_random_uuid(),
    email         text not null,
    password_hash text not null,
    name          text not null default '',
    avatar_key    text,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
create unique index users_email_key on users (lower(email));

create table sessions (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid not null references users(id) on delete cascade,
    token_hash   text not null unique,
    created_at   timestamptz not null default now(),
    expires_at   timestamptz not null,
    last_seen_at timestamptz not null default now(),
    ip           text not null default '',
    user_agent   text not null default ''
);
create index sessions_user_id_idx on sessions (user_id);
create index sessions_expires_at_idx on sessions (expires_at);

create table workspaces (
    id         uuid primary key default gen_random_uuid(),
    name       text not null,
    slug       text not null unique,
    created_at timestamptz not null default now()
);

create table workspace_members (
    workspace_id uuid not null references workspaces(id) on delete cascade,
    user_id      uuid not null references users(id) on delete cascade,
    role         text not null default 'member' check (role in ('owner','admin','member')),
    created_at   timestamptz not null default now(),
    primary key (workspace_id, user_id)
);

-- +goose Down
drop table workspace_members;
drop table workspaces;
drop table sessions;
drop table users;
