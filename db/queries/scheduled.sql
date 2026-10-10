-- name: CreateScheduledMessage :one
insert into scheduled_messages (user_id, conversation_id, project_id, body, parent_id, tags, send_at)
values (sqlc.arg(user_id), sqlc.arg(conversation_id), sqlc.arg(project_id),
        sqlc.arg(body), sqlc.narg(parent_id),
        coalesce(sqlc.narg(tags), '[]'::jsonb), sqlc.arg(send_at))
returning *;

-- name: ListScheduledMessages :many
-- the user's pending queue, soonest first
select * from scheduled_messages
where user_id = sqlc.arg(user_id) and sent_at is null
order by send_at asc;

-- name: DeleteScheduledMessage :exec
delete from scheduled_messages
where id = sqlc.arg(id) and user_id = sqlc.arg(user_id) and sent_at is null;

-- name: ListDueScheduledMessages :many
-- sweep input: everything past due, still unsent
select * from scheduled_messages
where sent_at is null and send_at <= now()
order by send_at asc;

-- name: MarkScheduledMessageSent :exec
update scheduled_messages set sent_at = now()
where id = sqlc.arg(id) and sent_at is null;
