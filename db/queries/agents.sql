-- name: CreateAgent :one
insert into agents (workspace_id, name, slug, description, created_by)
values (sqlc.arg(workspace_id), sqlc.arg(name), sqlc.arg(slug), sqlc.arg(description), sqlc.arg(created_by))
returning *;

-- name: AgentSlugExists :one
select exists (select 1 from agents where workspace_id = sqlc.arg(workspace_id) and slug = sqlc.arg(slug));

-- name: GetAgentForUser :one
-- agent row only when the caller belongs to its workspace
select a.* from agents a
join workspace_members wm on wm.workspace_id = a.workspace_id and wm.user_id = sqlc.arg(user_id)
where a.id = sqlc.arg(id);

-- name: GetAgentByID :one
select * from agents where id = sqlc.arg(id);

-- name: AgentWorkspaceRole :one
-- caller's role in the agent's workspace, '' when not a member
select cast(coalesce((
    select wm.role from agents a
    join workspace_members wm on wm.workspace_id = a.workspace_id
    where a.id = sqlc.arg(id) and wm.user_id = sqlc.arg(user_id)
), '') as text) as role;

-- name: ListAgentsForWorkspace :many
select a.*, cast((
    select max(t.last_used_at) from mcp_tokens t where t.agent_id = a.id
) as timestamptz) as last_seen_at
from agents a
where a.workspace_id = sqlc.arg(workspace_id)
order by a.name;

-- name: UpdateAgent :one
update agents set
    name = coalesce(sqlc.narg(name), name),
    description = coalesce(sqlc.narg(description), description),
    updated_at = now()
where id = sqlc.arg(id)
returning *;

-- name: DeleteAgent :exec
delete from agents where id = sqlc.arg(id);

-- name: UpsertAgentGrant :one
with g as (
    insert into agent_project_permissions (agent_id, project_id, scopes)
    values (sqlc.arg(agent_id), sqlc.arg(project_id), sqlc.arg(scopes)::text[])
    on conflict (agent_id, project_id) do update set scopes = excluded.scopes
    returning *
)
select g.*, p.key as project_key, p.name as project_name
from g join projects p on p.id = g.project_id;

-- name: DeleteAgentGrant :exec
delete from agent_project_permissions
where agent_id = sqlc.arg(agent_id) and project_id = sqlc.arg(project_id);

-- name: ListAgentGrants :many
select g.*, p.key as project_key, p.name as project_name
from agent_project_permissions g
join projects p on p.id = g.project_id
where g.agent_id = sqlc.arg(agent_id)
order by p.name;

-- name: ProjectInAgentWorkspace :one
-- project must live in the agent's own workspace for a grant to be valid
select exists (
    select 1 from projects p join agents a on a.workspace_id = p.workspace_id
    where p.id = sqlc.arg(project_id) and a.id = sqlc.arg(agent_id)
);

-- name: CreateMcpToken :one
insert into mcp_tokens (agent_id, token_hash, name, expires_at)
values (sqlc.arg(agent_id), sqlc.arg(token_hash), sqlc.arg(name), sqlc.arg(expires_at))
returning *;

-- name: ListMcpTokens :many
select id, agent_id, name, last_used_at, expires_at, revoked_at, created_at
from mcp_tokens
where agent_id = sqlc.arg(agent_id) and revoked_at is null
order by created_at desc;

-- name: RevokeMcpToken :exec
update mcp_tokens set revoked_at = now()
where id = sqlc.arg(id) and agent_id = sqlc.arg(agent_id) and revoked_at is null;

-- name: RevokeAgentTokens :exec
update mcp_tokens set revoked_at = now()
where agent_id = sqlc.arg(agent_id) and revoked_at is null;

-- name: GetTokenAgent :one
-- resolve a presented bearer token to its agent when usable
select t.id as token_id, a.* from mcp_tokens t
join agents a on a.id = t.agent_id
where t.token_hash = sqlc.arg(token_hash)
  and t.revoked_at is null
  and (t.expires_at is null or t.expires_at > now());

-- name: TouchMcpToken :exec
update mcp_tokens set last_used_at = now() where id = sqlc.arg(id);

-- name: AgentScopeForProject :one
-- scopes the agent holds on a project; empty set when ungranted
select coalesce(g.scopes, '{}'::text[]) as scopes
from agents a
left join agent_project_permissions g
       on g.agent_id = a.id and g.project_id = sqlc.arg(project_id)
where a.id = sqlc.arg(agent_id);

-- name: AgentLastSeen :one
select cast(max(last_used_at) as timestamptz) as last_seen_at from mcp_tokens where agent_id = sqlc.arg(agent_id);

-- name: ListGrantedProjects :many
select p.* from agent_project_permissions g
join projects p on p.id = g.project_id
where g.agent_id = sqlc.arg(agent_id) and 'project:read' = any(g.scopes)
order by p.name;
