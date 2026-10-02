-- +goose Up
-- GitHub App integration. One registered app per deployment; installations
-- hang off workspaces; repositories link to projects.

create table github_app (
    id                boolean primary key default true check (id),
    app_id            bigint not null,
    slug              text not null,
    name              text not null,
    client_id         text not null,
    client_secret_enc bytea not null, -- AES-256-GCM, key = sha256(AUTH_SECRET)
    private_key_enc   bytea not null,
    webhook_secret_enc bytea not null,
    created_at        timestamptz not null default now()
);

create table github_installations (
    id              uuid primary key default gen_random_uuid(),
    workspace_id    uuid not null references workspaces(id) on delete cascade,
    installation_id bigint not null unique,
    account_login   text not null,
    account_type    text not null default 'User',
    created_at      timestamptz not null default now()
);

create table repositories (
    id              uuid primary key default gen_random_uuid(),
    project_id      uuid not null references projects(id) on delete cascade,
    installation_id bigint not null references github_installations(installation_id) on delete cascade,
    owner           text not null,
    name            text not null,
    default_branch  text not null default 'main',
    linked_by       uuid references users(id) on delete set null,
    created_at      timestamptz not null default now(),
    unique (installation_id, owner, name)
);
create index repositories_project_idx on repositories (project_id);

-- webhook delivery idempotency
create table github_events (
    delivery_id  text primary key,
    event        text not null,
    processed_at timestamptz not null default now()
);

-- issues gain a GitHub mirror side
alter table issues add column github_node_id text;
alter table issues add column github_repo_id uuid references repositories(id) on delete set null;
alter table issues add column github_number integer;
alter table issues add column origin text not null default 'relay'
    check (origin in ('relay', 'github'));
create unique index issues_github_uniq
    on issues (github_repo_id, github_number) where github_number is not null;

-- +goose Down
alter table issues drop column origin;
alter table issues drop column github_number;
alter table issues drop column github_repo_id;
alter table issues drop column github_node_id;
drop table if exists github_events;
drop table if exists repositories;
drop table if exists github_installations;
drop table if exists github_app;
