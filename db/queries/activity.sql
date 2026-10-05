-- name: ListMyOpenIssues :many
-- open issues and GitHub-linked PRs across every project the user can see,
-- most recently touched first. The /api/me/activity handler splits issue vs
-- pr on github_kind.
select i.id, i.project_id, cast(p.key || '-' || i.number as text) as key,
       i.title, i.status, i.priority, i.github_kind, i.updated_at,
       p.key as project_key, p.name as project_name
from issues i
join projects p on p.id = i.project_id
join workspace_members wm on wm.workspace_id = p.workspace_id
where wm.user_id = $1
  and i.status not in ('done','cancelled')
order by i.updated_at desc
limit 40;

-- name: ListMyRecentMessages :many
-- latest messages across all visible projects for the dashboard feed
select m.id, m.conversation_id, m.body, m.created_at,
       case when m.deleted_at is null
            then coalesce(u.name, a.name, nullif(m.author_name_snapshot, ''), '')
            else 'Deleted' end as author_name,
       case when m.author_agent_id is not null then 'agent' else 'user' end as author_kind,
       c.project_id, p.key as project_key, p.name as project_name,
       c.kind as conversation_kind
from messages m
join conversations c on c.id = m.conversation_id
join projects p on p.id = c.project_id
join workspace_members wm on wm.workspace_id = p.workspace_id
left join users u on u.id = m.author_user_id
left join agents a on a.id = m.author_agent_id
where wm.user_id = $1
  and m.deleted_at is null
order by m.created_at desc
limit 12;

-- name: ListGrantedOpenIssues :many
-- same feed as ListMyOpenIssues but scoped to the calling agent's project
-- grants: explicit rows win, grant_all + project:read covers the workspace
select i.id, i.project_id, cast(p.key || '-' || i.number as text) as key,
       i.title, i.status, i.priority, i.github_kind, i.updated_at,
       p.key as project_key, p.name as project_name
from issues i
join projects p on p.id = i.project_id
join agents a on a.id = sqlc.arg(agent_id)
left join agent_project_permissions g
       on g.agent_id = a.id and g.project_id = p.id
where i.status not in ('done','cancelled')
  and ('project:read' = any(g.scopes)
       or (a.grant_all and 'project:read' = any(a.grant_scopes)))
order by i.updated_at desc
limit 40;

-- name: ListGrantedRecentMessages :many
-- latest messages across an agent's granted projects — the agent-side
-- activity feed behind the MCP `activity` tool
select m.id, m.conversation_id, m.body, m.created_at,
       case when m.deleted_at is null
            then coalesce(u.name, a2.name, nullif(m.author_name_snapshot, ''), '')
            else 'Deleted' end as author_name,
       case when m.author_agent_id is not null then 'agent' else 'user' end as author_kind,
       c.project_id, p.key as project_key, p.name as project_name,
       c.kind as conversation_kind
from messages m
join conversations c on c.id = m.conversation_id
join projects p on p.id = c.project_id
join agents a on a.id = sqlc.arg(agent_id)
left join agent_project_permissions g
       on g.agent_id = a.id and g.project_id = p.id
left join users u on u.id = m.author_user_id
left join agents a2 on a2.id = m.author_agent_id
where m.deleted_at is null
  and ('project:read' = any(g.scopes)
       or (a.grant_all and 'project:read' = any(a.grant_scopes)))
order by m.created_at desc
limit 15;
