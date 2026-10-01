-- name: CreateWorkspace :one
insert into workspaces (name, slug)
values ($1, $2)
returning id, name, slug, created_at;

-- name: AddWorkspaceMember :exec
insert into workspace_members (workspace_id, user_id, role)
values ($1, $2, $3);

-- name: ListWorkspacesForUser :many
select w.id, w.name, w.slug, w.created_at, wm.role
from workspaces w
join workspace_members wm on wm.workspace_id = w.id
where wm.user_id = $1
order by w.name;

-- name: GetWorkspaceRole :one
select role
from workspace_members
where workspace_id = $1 and user_id = $2;

-- name: GetWorkspaceByID :one
select id, name, slug, created_at
from workspaces
where id = $1;

-- name: ListWorkspaceMembers :many
select u.id, u.email, u.name, u.avatar_key, u.created_at, wm.role
from workspace_members wm
join users u on u.id = wm.user_id
where wm.workspace_id = $1
order by wm.created_at;

-- name: WorkspaceSlugExists :one
select exists(select 1 from workspaces where slug = $1) as exists;
