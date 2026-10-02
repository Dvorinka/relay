-- +goose Up
-- One-shot agent invites: the user mints an rli_ token, the agent redeems it
-- itself via POST /api/agent-invites/redeem and receives a scoped rly_ MCP
-- token. Grants cover the projects and scopes chosen at invite time; empty
-- project list means every workspace project at redeem time.

create table agent_invites (
    id           uuid primary key default gen_random_uuid(),
    workspace_id uuid not null references workspaces(id) on delete cascade,
    token_hash   bytea not null unique,      -- sha256 of the rli_ token
    project_ids  uuid[] not null default '{}',
    scopes       text[] not null check (scopes <@ array[
        'project:read','message:read','message:write',
        'attachment:read','issue:read','issue:write',
        'review:read','review:write']::text[]),
    expires_at   timestamptz not null,
    used_by      uuid references agents(id) on delete set null,
    created_by   uuid references users(id) on delete set null,
    created_at   timestamptz not null default now()
);
create index agent_invites_ws_idx on agent_invites (workspace_id);

-- +goose Down
drop table agent_invites;
