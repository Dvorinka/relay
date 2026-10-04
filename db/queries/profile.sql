-- Profile surface: what a workspace-mate sees on a user's details page.
-- Every query is gated on the VIEWER's membership — a profile only exposes
-- activity inside workspaces both parties share.

-- name: SharedWorkspaces :many
select w.id, w.name, w.slug, w.avatar_key, mt.role
from workspaces w
join workspace_members mv on mv.workspace_id = w.id and mv.user_id = $1
join workspace_members mt on mt.workspace_id = w.id and mt.user_id = $2
order by w.name;

-- name: ProfileAssignedIssues :many
-- most recently touched issues assigned to the target, in shared workspaces
select i.id, i.project_id, i.number, i.title, i.status, i.priority, i.updated_at,
       p.key as project_key, p.name as project_name
from issues i
join projects p on p.id = i.project_id
join workspace_members mv on mv.workspace_id = p.workspace_id and mv.user_id = $1
where i.assignee_id = $2
order by i.updated_at desc
limit 10;

-- name: ProfileRecentMessages :many
-- target's latest public messages in shared workspaces
select m.id, m.body, m.created_at, c.project_id, p.name as project_name
from messages m
join conversations c on c.id = m.conversation_id
join projects p on p.id = c.project_id
join workspace_members mv on mv.workspace_id = p.workspace_id and mv.user_id = $1
where m.author_user_id = $2 and m.deleted_at is null
order by m.created_at desc
limit 10;

-- name: ProfileMentionsOf :many
-- recent messages @naming the target, visible to the viewer
select m.id, m.body, m.created_at, c.project_id,
       coalesce(u.name, a.name, nullif(m.author_name_snapshot, ''), '') as author_name,
       (m.author_agent_id is not null or m.author_kind_snapshot = 'agent') as author_is_agent
from messages m
join conversations c on c.id = m.conversation_id
join projects p on p.id = c.project_id
join workspace_members mv on mv.workspace_id = p.workspace_id and mv.user_id = $1
join users me on me.id = $2
left join users u on u.id = m.author_user_id
left join agents a on a.id = m.author_agent_id
where m.deleted_at is null
  and position(lower('@' || me.name) in lower(m.body)) > 0
  and (m.author_user_id is null or m.author_user_id <> $2)
order by m.created_at desc
limit 20;

-- name: ProfileMessageCount :one
select count(*)::int
from messages m
join conversations c on c.id = m.conversation_id
join projects p on p.id = c.project_id
join workspace_members mv on mv.workspace_id = p.workspace_id and mv.user_id = $1
where m.author_user_id = $2 and m.deleted_at is null;
