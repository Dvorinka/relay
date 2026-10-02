-- name: GetProjectConversation :one
select *
from conversations
where project_id = $1 and kind = 'project';

-- name: CreateProjectConversation :one
insert into conversations (project_id, kind)
values ($1, 'project')
on conflict do nothing
returning *;

-- name: GetConversationForUser :one
-- resolves the conversation only when the user belongs to its workspace
select c.*
from conversations c
join projects p on p.id = c.project_id
join workspace_members wm on wm.workspace_id = p.workspace_id
where c.id = $1 and wm.user_id = $2;

-- name: GetConversationByID :one
select *
from conversations
where id = $1;

-- name: GetProjectForUser :one
-- project row only when the caller is a member of its workspace
select p.id, p.workspace_id, p.key, p.name, p.description, p.icon, p.color,
       p.statuses, p.local_path, p.brief_policy, p.created_at
from projects p
join workspace_members wm on wm.workspace_id = p.workspace_id
where p.id = $1 and wm.user_id = $2;

-- name: ListMessages :many
-- newest-first page; $2 is an optional "older than message id" cursor
select m.id, m.conversation_id, m.body, m.mentions, m.created_at, m.edited_at, m.parent_id,
       m.author_user_id, m.author_agent_id,
       coalesce(u.name, a.name, '') as author_name,
       coalesce(u.avatar_key, a.avatar_key) as author_avatar,
       coalesce(pu.name, pa.name, '') as parent_author_name,
       pm.body as parent_body,
       (pm.id is not null and pm.deleted_at is not null) as parent_deleted
from messages m
left join users u on u.id = m.author_user_id
left join agents a on a.id = m.author_agent_id
left join messages pm on pm.id = m.parent_id
left join users pu on pu.id = pm.author_user_id
left join agents pa on pa.id = pm.author_agent_id
where m.conversation_id = $1
  and m.deleted_at is null
  and (sqlc.narg(before)::uuid is null or
       (m.created_at, m.id) < (select m2.created_at, m2.id from messages m2 where m2.id = sqlc.narg(before)::uuid))
order by m.created_at desc, m.id desc
limit sqlc.arg(lim)::int;

-- name: CreateMessage :one
insert into messages (conversation_id, author_user_id, body, parent_id, mentions)
values ($1, $2, $3, sqlc.narg(parent_id), coalesce(sqlc.narg(mentions), '[]'::jsonb))
returning id;

-- name: MessageParentInConversation :one
-- reply target must live in the same conversation and be undeleted
select m.id
from messages m
where m.id = sqlc.arg(id)
  and m.conversation_id = sqlc.arg(conversation_id)
  and m.deleted_at is null;

-- name: GetMessageByID :one
select m.id, m.conversation_id, m.body, m.mentions, m.created_at, m.edited_at, m.parent_id,
       m.author_user_id, m.author_agent_id,
       coalesce(u.name, a.name, '') as author_name,
       coalesce(u.avatar_key, a.avatar_key) as author_avatar,
       coalesce(pu.name, pa.name, '') as parent_author_name,
       pm.body as parent_body,
       (pm.id is not null and pm.deleted_at is not null) as parent_deleted
from messages m
left join users u on u.id = m.author_user_id
left join agents a on a.id = m.author_agent_id
left join messages pm on pm.id = m.parent_id
left join users pu on pu.id = pm.author_user_id
left join agents pa on pa.id = pm.author_agent_id
where m.id = $1;

-- name: GetMessageForUser :one
-- message id only when the user may see its workspace
select m.id
from messages m
join conversations c on c.id = m.conversation_id
join projects p on p.id = c.project_id
join workspace_members wm on wm.workspace_id = p.workspace_id
where m.id = $1 and wm.user_id = $2;

-- name: UpdateMessageBody :one
-- author-only edit; conversation id is resolved off the row afterwards
update messages set body = sqlc.arg(body), edited_at = now()
where id = sqlc.arg(id)
  and author_user_id = sqlc.arg(author_user_id)
  and deleted_at is null
returning id;

-- name: MessageReadByAgent :one
-- true once an agent other than the author has read the message; edits lock
-- from that point (an agent's own read receipt must not lock its own message)
select exists (
    select 1 from message_reads r
    join messages m on m.id = r.message_id
    where r.message_id = sqlc.arg(message_id)
      and r.agent_id is not null
      and (m.author_agent_id is null or r.agent_id <> m.author_agent_id));

-- name: AgentReadMessageIDs :many
-- subset of the given ids that at least one other agent has read
select r.message_id from message_reads r
join messages m on m.id = r.message_id
where r.agent_id is not null
  and (m.author_agent_id is null or r.agent_id <> m.author_agent_id)
  and r.message_id = any(sqlc.arg(ids)::uuid[])
group by r.message_id;

-- name: MarkMessageRead :exec
insert into message_reads (message_id, user_id)
values ($1, $2)
on conflict (message_id, user_id) where user_id is not null do nothing;

-- name: AddReactionUser :exec
insert into message_reactions (message_id, user_id, emoji)
values ($1, $2, $3)
on conflict (message_id, user_id, emoji) where user_id is not null do nothing;

-- name: RemoveReactionUser :execrows
delete from message_reactions
where message_id = $1 and user_id = $2 and emoji = $3;

-- name: ListReactionsForMessages :many
select mr.message_id, mr.emoji, mr.user_id, mr.agent_id,
       coalesce(u.name, a.name, '') as reactor_name
from message_reactions mr
left join users u on u.id = mr.user_id
left join agents a on a.id = mr.agent_id
where mr.message_id = any(sqlc.arg(ids)::uuid[])
order by mr.created_at;

-- name: RecentProjectMessages :many
select m.id, m.conversation_id, m.body, m.mentions, m.created_at, m.edited_at, m.parent_id,
       m.author_user_id, m.author_agent_id,
       coalesce(u.name, a.name, '') as author_name,
       coalesce(u.avatar_key, a.avatar_key) as author_avatar,
       coalesce(pu.name, pa.name, '') as parent_author_name,
       pm.body as parent_body,
       (pm.id is not null and pm.deleted_at is not null) as parent_deleted
from messages m
join conversations c on c.id = m.conversation_id
left join users u on u.id = m.author_user_id
left join agents a on a.id = m.author_agent_id
left join messages pm on pm.id = m.parent_id
left join users pu on pu.id = pm.author_user_id
left join agents pa on pa.id = pm.author_agent_id
where c.project_id = $1 and m.deleted_at is null
order by m.created_at desc, m.id desc
limit 10;

-- name: UnreadCounts :many
-- per-project count of messages the user hasn't read, excluding their own
select p.id as project_id, count(m.id)::int as unread
from projects p
join workspace_members wm on wm.workspace_id = p.workspace_id
  and wm.user_id = $1
join conversations c on c.project_id = p.id
join messages m on m.conversation_id = c.id and m.deleted_at is null
where (m.author_user_id is null or m.author_user_id <> $1)
  and not exists (
    select 1 from message_reads r
    where r.message_id = m.id and r.user_id = $1)
group by p.id;

-- name: MentionsForUser :many
-- messages mentioning the user (@<name>), newest first
select m.id, m.conversation_id, m.body, m.created_at, m.edited_at,
       m.author_user_id, m.author_agent_id,
       coalesce(u.name, a.name, '') as author_name,
       coalesce(u.avatar_key, a.avatar_key) as author_avatar,
       c.project_id,
       (r.message_id is not null) as is_read
from messages m
join conversations c on c.id = m.conversation_id
join projects p on p.id = c.project_id
join workspace_members wm on wm.workspace_id = p.workspace_id
  and wm.user_id = $1
join users me on me.id = $1
left join users u on u.id = m.author_user_id
left join agents a on a.id = m.author_agent_id
left join message_reads r on r.message_id = m.id and r.user_id = $1
where m.deleted_at is null
  and (m.author_user_id is null or m.author_user_id <> $1)
  and position(lower('@' || me.name) in lower(m.body)) > 0
order by m.created_at desc, m.id desc
limit 50;

-- name: ParentAuthorID :one
-- user who wrote a message's parent; null when the parent is an agent's
select m2.author_user_id
from messages m
join messages m2 on m2.id = m.parent_id
where m.id = $1;
