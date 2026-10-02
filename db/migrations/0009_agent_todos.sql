-- +goose Up
create table agent_todos (
    id          uuid primary key default gen_random_uuid(),
    project_id  uuid not null references projects(id) on delete cascade,
    agent_id    uuid references agents(id) on delete set null,
    issue_id    uuid references issues(id) on delete set null,
    content     text not null,
    done        boolean not null default false,
    position    integer not null default 0,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create index agent_todos_project_idx on agent_todos (project_id, position, created_at);

-- +goose Down
drop table if exists agent_todos;
