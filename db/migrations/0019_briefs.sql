-- +goose Up
-- Visual briefs: agent-generated diagrams (Excalidraw-compatible scene JSON)
-- attached to a project or issue, with their own conversation for comments
-- and iteration. Policy on projects gates whether briefs are expected.
create table briefs (
    id            uuid primary key default gen_random_uuid(),
    project_id    uuid not null references projects(id) on delete cascade,
    issue_id      uuid references issues(id) on delete set null,
    conversation_id uuid references conversations(id) on delete set null,
    title         text not null check (length(trim(title)) between 1 and 200),
    summary       text not null default '',
    scene         jsonb not null default '{}'::jsonb,
    status        text not null default 'open' check (status in ('open', 'resolved', 'archived')),
    created_by_user uuid references users(id) on delete set null,
    created_by_agent uuid references agents(id) on delete set null,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    check (created_by_user is not null or created_by_agent is not null)
);
create index briefs_project_idx on briefs (project_id, created_at desc);
create index briefs_issue_idx on briefs (issue_id) where issue_id is not null;

-- brief threads reuse the messages machinery
alter table conversations drop constraint conversations_kind_check;
alter table conversations add constraint conversations_kind_check
    check (kind in ('project', 'issue', 'brief'));
alter table conversations add column brief_id uuid references briefs(id) on delete set null;

-- never | on_request | pre_merge — settable per project in settings
alter table projects add column brief_policy text not null default 'on_request'
    check (brief_policy in ('never', 'on_request', 'pre_merge'));

-- widen the agent grant vocabulary for brief tools
alter table agent_project_permissions
    drop constraint agent_project_permissions_scopes_check;
alter table agent_project_permissions
    add constraint agent_project_permissions_scopes_check
    check (scopes <@ array[
        'project:read','message:read','message:write',
        'attachment:read','issue:read','issue:write',
        'review:read','review:write','file:read',
        'brief:read','brief:write']::text[]);

-- grants that already let an agent write issues reasonably include briefs
update agent_project_permissions
set scopes = array_cat(scopes, '{brief:read,brief:write}'::text[])
where 'issue:write' = any(scopes)
  and not ('brief:write' = any(scopes));

-- +goose Down
alter table agent_project_permissions
    drop constraint agent_project_permissions_scopes_check;
alter table agent_project_permissions
    add constraint agent_project_permissions_scopes_check
    check (scopes <@ array[
        'project:read','message:read','message:write',
        'attachment:read','issue:read','issue:write',
        'review:read','review:write','file:read']::text[]);
alter table projects drop column brief_policy;
alter table conversations drop column brief_id;
alter table conversations drop constraint conversations_kind_check;
alter table conversations add constraint conversations_kind_check
    check (kind in ('project', 'issue'));
drop table briefs;
