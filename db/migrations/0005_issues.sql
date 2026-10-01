-- +goose Up
-- Issues (Linear-style): keyed via project_counters, status/priority enums,
-- labels, activity log. Comments reuse conversations(kind='issue') + messages.

create table issues (
    id           uuid primary key default gen_random_uuid(),
    project_id   uuid not null references projects(id) on delete cascade,
    number       integer not null,
    title        text not null check (length(trim(title)) between 1 and 200),
    description  text not null default '',
    status       text not null default 'backlog'
                 check (status in ('backlog','todo','in_progress','review','done','cancelled')),
    priority     text not null default 'none'
                 check (priority in ('none','urgent','high','medium','low')),
    assignee_id  uuid references users(id) on delete set null,
    agent_id     uuid, -- FK to agents lands in phase 5
    created_by   uuid references users(id),
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    unique (project_id, number)
);
create index issues_project_status_idx on issues (project_id, status);
create index issues_assignee_idx on issues (assignee_id) where assignee_id is not null;

create table issue_labels (
    id         uuid primary key default gen_random_uuid(),
    project_id uuid not null references projects(id) on delete cascade,
    name       text not null check (length(trim(name)) between 1 and 40),
    color      text not null check (color ~ '^#[0-9a-fA-F]{6}$'),
    created_at timestamptz not null default now()
);
create unique index issue_labels_project_name_idx on issue_labels (project_id, lower(name));

create table issue_label_links (
    issue_id uuid not null references issues(id) on delete cascade,
    label_id uuid not null references issue_labels(id) on delete cascade,
    primary key (issue_id, label_id)
);

-- one event log feeding the issue timeline and (later) the project activity
-- feed; actor pair follows the message authorship pattern
create table issue_activity (
    id             uuid primary key default gen_random_uuid(),
    issue_id       uuid not null references issues(id) on delete cascade,
    actor_user_id  uuid references users(id),
    actor_agent_id uuid, -- FK lands in phase 5
    kind           text not null,
    payload        jsonb not null default '{}',
    created_at     timestamptz not null default now(),
    check (num_nonnulls(actor_user_id, actor_agent_id) = 1)
);
create index issue_activity_issue_idx on issue_activity (issue_id, created_at);

-- conversations.issue_id was declared without a FK in 0003; resolve it now,
-- and enforce one issue-thread per issue
alter table conversations
    add constraint conversations_issue_id_fkey
    foreign key (issue_id) references issues(id) on delete cascade;
create unique index conversations_issue_uq on conversations (issue_id)
    where issue_id is not null;

-- +goose Down
alter table conversations drop constraint if exists conversations_issue_id_fkey;
drop table if exists issue_activity;
drop table if exists issue_label_links;
drop table if exists issue_labels;
drop table if exists issues;
