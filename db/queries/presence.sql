-- name: StampUserLastSeen :exec
update users set last_seen_at = now() where id = sqlc.arg(id);

-- name: ListUserProjectIDs :many
-- every project the user can see: workspace membership implies project
-- visibility, same shape GetProjectForUser encodes
select p.id
from projects p
join workspace_members wm on wm.workspace_id = p.workspace_id
where wm.user_id = sqlc.arg(user_id);

-- name: ListVisibleUserIDs :many
-- every user sharing at least one workspace with the caller — the
-- visibility envelope for presence data
select distinct wm2.user_id
from workspace_members wm
join workspace_members wm2 on wm2.workspace_id = wm.workspace_id
where wm.user_id = sqlc.arg(user_id);
