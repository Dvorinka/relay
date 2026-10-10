-- name: CreateIdea :one
insert into ideas (workspace_id, project_id, title, summary, scene, created_by_user, created_by_agent)
values (sqlc.arg(workspace_id), sqlc.narg(project_id), sqlc.arg(title), sqlc.arg(summary), sqlc.arg(scene),
        sqlc.narg(created_by_user), sqlc.narg(created_by_agent))
returning *;

-- name: ListProjectIdeas :many
select i.*, p.key as project_key, p.name as project_name,
       coalesce(u.name, a.name, '') as author_name
from ideas i
join projects p on p.id = i.project_id
left join users u on u.id = i.created_by_user
left join agents a on a.id = i.created_by_agent
where i.project_id = sqlc.arg(project_id)
order by i.updated_at desc;

-- name: ListWorkspaceIdeas :many
-- every idea in the workspace, platform-wide ones (null project) included —
-- the Ideas page feed. Membership is enforced by the route gate.
select i.*, p.key as project_key, p.name as project_name,
       coalesce(u.name, a.name, '') as author_name
from ideas i
left join projects p on p.id = i.project_id
left join users u on u.id = i.created_by_user
left join agents a on a.id = i.created_by_agent
where i.workspace_id = sqlc.arg(workspace_id)
order by i.updated_at desc;

-- name: GetIdea :one
select i.*, p.key as project_key, p.name as project_name,
       coalesce(u.name, a.name, '') as author_name,
       coalesce(u.id is not null, false) as author_is_user
from ideas i
left join projects p on p.id = i.project_id
left join users u on u.id = i.created_by_user
left join agents a on a.id = i.created_by_agent
where i.id = sqlc.arg(id);

-- name: UpdateIdea :one
update ideas set
  title   = coalesce(sqlc.narg(title), title),
  summary = coalesce(sqlc.narg(summary), summary),
  scene   = coalesce(sqlc.narg(scene), scene),
  status  = coalesce(sqlc.narg(status), status),
  project_id = coalesce(sqlc.narg(project_id), project_id),
  updated_at = now()
where id = sqlc.arg(id)
returning *;

-- name: DeleteIdea :exec
delete from ideas where id = sqlc.arg(id);
