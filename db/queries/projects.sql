-- name: CreateProject :one
insert into projects (workspace_id, key, name, description, icon, color, created_by)
values ($1, $2, $3, $4, $5, $6, $7)
returning id, workspace_id, key, name, description, icon, avatar_key, color, statuses, local_path, brief_policy, created_at;

-- name: AddProjectMember :exec
insert into project_members (project_id, user_id)
values ($1, $2);

-- name: ListProjectsForUser :many
select p.id, p.workspace_id, p.key, p.name, p.description, p.icon, p.avatar_key, p.color, p.statuses, p.local_path, p.brief_policy, p.created_at
from projects p
join workspace_members wm on wm.workspace_id = p.workspace_id
where wm.user_id = $1
order by p.name;

-- name: GetProjectByID :one
select id, workspace_id, key, name, description, icon, avatar_key, color, statuses, local_path, brief_policy, created_at
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
returning id, workspace_id, key, name, description, icon, avatar_key, color, statuses, local_path, brief_policy, created_at;

-- name: ProjectCounts :one
select
  (select count(*) from project_members pm where pm.project_id = $1) as members,
  (select count(*) from messages m
     join conversations c on c.id = m.conversation_id
     where c.project_id = $1 and m.deleted_at is null) as messages,
  (select count(*) from conversations c where c.project_id = $1) as conversations;

-- name: SetProjectStatuses :exec
update projects set statuses = $2, updated_at = now() where id = $1;

-- name: SetProjectLocalPath :exec
update projects set local_path = $2, updated_at = now() where id = $1;

-- name: ProjectMeta :one
select statuses, local_path, brief_policy from projects where id = $1;

-- name: CreateSavedFilter :one
insert into saved_filters (project_id, user_id, name, filters)
values ($1, $2, $3, $4)
returning id, project_id, user_id, name, filters, created_at;

-- name: ListSavedFilters :many
select id, project_id, user_id, name, filters, created_at
from saved_filters
where project_id = $1 and user_id = $2
order by name;

-- name: DeleteSavedFilter :exec
delete from saved_filters where id = $1 and user_id = $2;

-- name: CreateBoard :one
insert into boards (project_id, name, filters)
values ($1, $2, coalesce(sqlc.arg(filters), '{}'::jsonb))
returning id, project_id, name, filters, created_at;

-- name: ListBoards :many
select id, project_id, name, filters, created_at
from boards where project_id = $1 order by name;

-- name: DeleteBoard :exec
delete from boards where id = $1;

-- name: UpsertPushSubscription :exec
insert into push_subscriptions (user_id, endpoint, auth, keys, user_agent)
values ($1, $2, $3, $4, $5)
on conflict (endpoint) do update
set user_id = excluded.user_id, keys = excluded.keys,
    user_agent = excluded.user_agent, last_seen = now();

-- name: DeletePushSubscription :exec
delete from push_subscriptions where endpoint = $1 and user_id = $2;

-- name: ListPushSubscriptions :many
select endpoint, keys from push_subscriptions where user_id = $1;

-- name: ListProjectMemberIDs :many
select user_id from project_members where project_id = $1;

-- name: MentionedUserIDs :many
-- workspace members whose name appears as @name (case-insensitive) in the body
select u.id
from workspace_members wm
join users u on u.id = wm.user_id
join projects p on p.workspace_id = wm.workspace_id
where p.id = $1
  and position('@' || lower(u.name) in lower($2)) > 0;

-- name: SetProjectAvatarKey :one
update projects set avatar_key = sqlc.arg(avatar_key), updated_at = now()
where id = sqlc.arg(id)
returning id;
