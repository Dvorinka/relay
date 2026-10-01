-- name: CreateProject :one
insert into projects (workspace_id, key, name, description, icon, color, created_by)
values ($1, $2, $3, $4, $5, $6, $7)
returning id, workspace_id, key, name, description, icon, color, created_at;

-- name: AddProjectMember :exec
insert into project_members (project_id, user_id)
values ($1, $2);

-- name: ListProjectsForUser :many
select p.id, p.workspace_id, p.key, p.name, p.description, p.icon, p.color, p.created_at
from projects p
join workspace_members wm on wm.workspace_id = p.workspace_id
where wm.user_id = $1
order by p.name;

-- name: GetProjectByID :one
select id, workspace_id, key, name, description, icon, color, created_at
from projects
where id = $1;

-- name: ProjectWorkspaceRole :one
-- caller's workspace role for the project, empty when not a member
select cast(coalesce((
    select wm.role from workspace_members wm
    where wm.workspace_id = p.workspace_id and wm.user_id = $2
), '') as text) as role
from projects p
where p.id = $1;

-- name: UpdateProject :one
update projects
set name = coalesce(sqlc.narg(name), name),
    description = coalesce(sqlc.narg(description), description),
    icon = coalesce(sqlc.narg(icon), icon),
    color = coalesce(sqlc.narg(color), color),
    updated_at = now()
where id = sqlc.arg(id)
returning id, workspace_id, key, name, description, icon, color, created_at;

-- name: ProjectCounts :one
select
  (select count(*) from project_members pm where pm.project_id = $1) as members,
  (select count(*) from messages m
     join conversations c on c.id = m.conversation_id
     where c.project_id = $1 and m.deleted_at is null) as messages,
  (select count(*) from conversations c where c.project_id = $1) as conversations;
