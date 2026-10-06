-- +goose Up
-- Ideas: freeform brainstorm/mindmap documents (Excalidraw-compatible scene
-- JSON) that can later be converted into issues or spun out into projects.
-- Project-scoped so existing membership/permission machinery applies; the
-- Ideas page aggregates across a workspace's projects.
create table ideas (
    id               uuid primary key default gen_random_uuid(),
    project_id       uuid not null references projects(id) on delete cascade,
    title            text not null check (length(trim(title)) between 1 and 200),
    summary          text not null default '',
    scene            jsonb not null default '{}'::jsonb,
    status           text not null default 'open' check (status in ('open', 'converted', 'archived')),
    created_by_user  uuid references users(id) on delete set null,
    created_by_agent uuid references agents(id) on delete set null,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    check (created_by_user is not null or created_by_agent is not null)
);
create index ideas_project_idx on ideas (project_id, updated_at desc);

-- +goose Down
drop table ideas;
