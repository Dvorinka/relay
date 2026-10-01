-- name: CreateWorkspace :one
insert into workspaces (name, slug)
values ($1, $2)
returning id, name, slug, created_at;

-- name: AddWorkspaceMember :exec
insert into workspace_members (workspace_id, user_id, role)
values ($1, $2, $3);

-- name: ListWorkspacesForUser :many
select w.id, w.name, w.slug, wm.role
from workspaces w
join workspace_members wm on wm.workspace_id = w.id
where wm.user_id = $1
order by w.name;

-- name: GetWorkspaceRole :one
select role
from workspace_members
where workspace_id = $1 and user_id = $2;
