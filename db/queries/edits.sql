-- name: CreateMessageEdit :exec
-- snapshot of the pre-edit body; taken in handleEditMessage before the
-- update lands so the history view can show every prior version.
insert into message_edits (message_id, body, edited_by)
values (sqlc.arg(message_id), sqlc.arg(body), sqlc.arg(edited_by));

-- name: ListMessageEdits :many
-- oldest first — the UI renders a timeline
select e.*, u.name as editor_name
from message_edits e
left join users u on u.id = e.edited_by
where e.message_id = sqlc.arg(message_id)
order by e.edited_at asc;
