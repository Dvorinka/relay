-- name: ProjectWorkspaceID :one
select workspace_id from projects where id = sqlc.arg(project_id);

-- name: ListMentionableIssues :many
-- project issues incl. GitHub mirrors; key is computed, repo name joins for
-- owner/repo#N refs
select i.id, cast(p.key || '-' || i.number as text) as key, i.title, i.status,
       i.github_kind, i.github_url, i.github_number,
       coalesce(cast(r.owner || '/' || r.name as text), '') as repo
from issues i
join projects p on p.id = i.project_id
left join repositories r on r.id = i.github_repo_id
where i.project_id = sqlc.arg(project_id)
order by i.updated_at desc
limit 500;

-- name: IssueByKeyInProject :one
select i.id, cast(p.key || '-' || i.number as text) as key, i.title,
       i.github_kind, i.github_url,
       coalesce(cast(r.owner || '/' || r.name as text), '') as repo
from issues i
join projects p on p.id = i.project_id
left join repositories r on r.id = i.github_repo_id
where i.project_id = sqlc.arg(project_id)
  and p.key || '-' || i.number = upper(sqlc.arg(key));

-- name: AgentBySlug :one
select id, name, slug
from agents
where workspace_id = sqlc.arg(workspace_id) and slug = sqlc.arg(slug);

-- name: UserByNameInWorkspace :one
select u.id, u.name
from workspace_members wm
join users u on u.id = wm.user_id
where wm.workspace_id = sqlc.arg(workspace_id)
  and (lower(u.name) = lower(sqlc.arg(name))
       or lower(replace(u.name, ' ', '-')) = lower(sqlc.arg(name))
       or lower(u.email) = lower(sqlc.arg(name))
       or lower(split_part(u.email, '@', 1)) = lower(sqlc.arg(name)));

-- name: ListAgentsMentionable :many
select id, name, slug, description
from agents
where workspace_id = sqlc.arg(workspace_id)
order by name;

-- name: UpdateMessageMentions :exec
update messages set mentions = sqlc.arg(mentions) where id = sqlc.arg(id);
