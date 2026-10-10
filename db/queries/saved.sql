-- name: SaveMessage :exec
insert into saved_messages (user_id, message_id)
values (sqlc.arg(user_id), sqlc.arg(message_id))
on conflict do nothing;

-- name: UnsaveMessage :exec
delete from saved_messages
where user_id = sqlc.arg(user_id) and message_id = sqlc.arg(message_id);

-- name: IsMessageSaved :one
select exists(
    select 1 from saved_messages
    where user_id = sqlc.arg(user_id) and message_id = sqlc.arg(message_id)
) as saved;

-- name: ListSavedMessageIDs :many
select message_id from saved_messages where user_id = sqlc.arg(user_id);

-- name: ListSavedMessages :many
-- newest-saved-first; joins mirror GetMessageByID so the client can render
-- a normal message plus enough context to deep-link back to it
select m.id, m.conversation_id, m.body, m.mentions, m.tags, m.silent, m.created_at, m.edited_at, m.deleted_at, m.parent_id,
       m.author_user_id, m.author_agent_id, m.author_kind_snapshot,
       coalesce(u.name, a.name, nullif(m.author_name_snapshot, ''), '') as author_name,
       coalesce(u.avatar_key, a.avatar_key) as author_avatar,
       coalesce(pu.name, pa.name, nullif(pm.author_name_snapshot, ''), '') as parent_author_name,
       pm.body as parent_body,
       (pm.id is not null and pm.deleted_at is not null) as parent_deleted,
       t.id as thread_id, t.title as thread_title,
       (select count(*)::int from messages tm
         where tm.conversation_id = t.id and tm.deleted_at is null) as thread_reply_count,
       m.pinned_at, m.forwarded_from,
       f.conversation_id as fwd_conversation_id,
       fcp.project_id as fwd_project_id,
       coalesce(fu.name, fa.name, nullif(f.author_name_snapshot, ''), '') as fwd_author_name,
       c.project_id, p.name as project_name, s.created_at as saved_at
from saved_messages s
join messages m on m.id = s.message_id
join conversations c on c.id = m.conversation_id
join projects p on p.id = c.project_id
left join users u on u.id = m.author_user_id
left join agents a on a.id = m.author_agent_id
left join messages pm on pm.id = m.parent_id
left join users pu on pu.id = pm.author_user_id
left join agents pa on pa.id = pm.author_agent_id
left join conversations t on t.parent_message_id = m.id and t.kind = 'thread'
  and (t.expires_at is null or t.expires_at > now())
left join messages f on f.id = m.forwarded_from
left join conversations fcp on fcp.id = f.conversation_id
left join users fu on fu.id = f.author_user_id
left join agents fa on fa.id = f.author_agent_id
where s.user_id = sqlc.arg(user_id) and m.deleted_at is null
order by s.created_at desc
limit 200;
