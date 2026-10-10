-- name: CreateReminder :one
insert into reminders (user_id, message_id, project_id, fire_at)
values (sqlc.arg(user_id), sqlc.arg(message_id), sqlc.arg(project_id), sqlc.arg(fire_at))
returning *;

-- name: DeleteReminder :exec
delete from reminders
where id = sqlc.arg(id) and user_id = sqlc.arg(user_id);

-- name: ListReminders :many
-- pending plus recently-fired (24h) so the Reminders view can show what
-- just went off; message join carries the snippet to display
select r.*, m.body as message_body, m.conversation_id,
       coalesce(u.name, a.name, nullif(m.author_name_snapshot, ''), '') as author_name
from reminders r
join messages m on m.id = r.message_id
left join users u on u.id = m.author_user_id
left join agents a on a.id = m.author_agent_id
where r.user_id = sqlc.arg(user_id)
  and (r.fired_at is null or r.fired_at > now() - interval '24 hours')
  and m.deleted_at is null
order by r.fired_at is null desc, r.fire_at
limit 100;

-- name: ListDueReminders :many
select r.*, m.body as message_body, m.conversation_id,
       coalesce(u.name, a.name, nullif(m.author_name_snapshot, ''), '') as author_name
from reminders r
join messages m on m.id = r.message_id
left join users u on u.id = m.author_user_id
left join agents a on a.id = m.author_agent_id
where r.fired_at is null and r.fire_at <= now()
order by r.fire_at
limit 100;

-- name: MarkReminderFired :exec
update reminders set fired_at = now() where id = sqlc.arg(id);
