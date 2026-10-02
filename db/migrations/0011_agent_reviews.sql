-- +goose Up
-- Structured agent work reviews ("whiteboard" reports) and the per-agent
-- review gate. Design inspired by devdotfast/whiteboard (MIT): a fixed-schema
-- review document - summary, per-file changes, decisions, required follow-up
-- actions - that a human approves or sends back.

-- per-agent gate: 'gate' means the agent must wait for a human verdict before
-- continuing; 'notify' means the review is informational, posted after the fact.
alter table agents
    add column review_mode text not null default 'notify'
        check (review_mode in ('notify','gate'));

-- widen the grant vocabulary with review scopes
alter table agent_project_permissions
    drop constraint agent_project_permissions_scopes_check;
alter table agent_project_permissions
    add constraint agent_project_permissions_scopes_check
    check (scopes <@ array[
        'project:read','message:read','message:write',
        'attachment:read','issue:read','issue:write',
        'review:read','review:write']::text[]);

create table agent_reviews (
    id           uuid primary key default gen_random_uuid(),
    project_id   uuid not null references projects(id) on delete cascade,
    issue_id     uuid references issues(id) on delete set null,
    agent_id     uuid not null references agents(id) on delete cascade,
    status       text not null default 'pending'
                 check (status in ('pending','approved','changes_requested','superseded')),
    title        text not null check (length(trim(title)) between 1 and 200),
    -- plain-language summary of what changed and why (markdown)
    summary      text not null default '',
    -- [{path, status: added|modified|deleted|renamed, additions, deletions, note}]
    files        jsonb not null default '[]',
    -- [{decision, rationale}] choices the agent made autonomously
    decisions    jsonb not null default '[]',
    -- [{kind: env|config|deploy|ci|secret|migration|other, label, detail}]
    -- things the human must do for the change to work in production
    actions      jsonb not null default '[]',
    -- [{label, url}] PRs, commits, runs
    links        jsonb not null default '[]',
    -- short markdown: how to verify the change works
    verify       text not null default '',
    -- iteration chain: a revised review points at the one it replaces
    supersedes   uuid references agent_reviews(id) on delete set null,
    responded_by uuid references users(id) on delete set null,
    response     text not null default '',
    responded_at timestamptz,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);
create index agent_reviews_project_idx on agent_reviews (project_id, created_at desc);
create index agent_reviews_issue_idx on agent_reviews (issue_id) where issue_id is not null;
create index agent_reviews_pending_idx on agent_reviews (project_id) where status = 'pending';

-- +goose Down
drop table if exists agent_reviews;
alter table agent_project_permissions
    drop constraint agent_project_permissions_scopes_check;
alter table agent_project_permissions
    add constraint agent_project_permissions_scopes_check
    check (scopes <@ array[
        'project:read','message:read','message:write',
        'attachment:read','issue:read','issue:write']::text[]);
alter table agents drop column if exists review_mode;
