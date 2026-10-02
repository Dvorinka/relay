-- name: GetProjectConversation :one
select id, project_id, kind, issue_id, created_at
from conversations
where project_id = $1 and kind = 'project';

-- name: CreateProjectConversation :one
insert into conversations (project_id, kind)
values ($1, 'project')
on conflict do nothing
returning id, project_id, kind, issue_id, created_at;

-- name: GetConversationForUser :one
-- resolves the conversation only when the user belongs to its workspace
select c.id, c.project_id, c.kind, c.issue_id, c.created_at
from conversations c
join projects p on p.id = c.project_id
join workspace_members wm on wm.workspace_id = p.workspace_id
where c.id = $1 and wm.user_id = $2;

-- name: GetConversationByID :one
select id, project_id, kind, issue_id, created_at
from conversations
where id = $1;

-- name: GetProjectForUser :one
-- project row only when the caller is a member of its workspace
select p.id, p.workspace_id, p.key, p.name, p.description, p.icon, p.color, p.created_at
from projects p
join workspace_members wm on wm.workspace_id = p.workspace_id
where p.id = $1 and wm.user_id = $2;

-- name: ListMessages :many
-- newest-first page; $2 is an optional "older than message id" cursor
select m.id, m.conversation_id, m.body, m.created_at, m.edited_at,
       m.author_user_id, m.author_agent_id,
       coalesce(u.name, a.name, '') as author_name,
       coalesce(u.avatar_key, a.avatar_key) as author_avatar
from messages m
left join users u on u.id = m.author_user_id
left join agents a on a.id = m.author_agent_id
where m.conversation_id = $1
  and m.deleted_at is null
  and (sqlc.narg(before)::uuid is null or
       (m.created_at, m.id) < (select m2.created_at, m2.id from messages m2 where m2.id = sqlc.narg(before)::uuid))
order by m.created_at desc, m.id desc
limit sqlc.arg(lim)::int;

-- name: CreateMessage :one
insert into messages (conversation_id, author_user_id, body)
values ($1, $2, $3)
returning id;

-- name: GetMessageByID :one
select m.id, m.conversation_id, m.body, m.created_at, m.edited_at,
       m.author_user_id, m.author_agent_id,
       coalesce(u.name, a.name, '') as author_name,
       coalesce(u.avatar_key, a.avatar_key) as author_avatar
from messages m
left join users u on u.id = m.author_user_id
left join agents a on a.id = m.author_agent_id
where m.id = $1;

-- name: GetMessageForUser :one
-- message id only when the user may see its workspace
select m.id
from messages m
join conversations c on c.id = m.conversation_id
join projects p on p.id = c.project_id
join workspace_members wm on wm.workspace_id = p.workspace_id
where m.id = $1 and wm.user_id = $2;

-- name: MarkMessageRead :exec
insert into message_reads (message_id, user_id)
values ($1, $2)
on conflict (message_id, user_id) where user_id is not null do nothing;

-- name: RecentProjectMessages :many
select m.id, m.conversation_id, m.body, m.created_at, m.edited_at,
       m.author_user_id, m.author_agent_id,
       coalesce(u.name, a.name, '') as author_name,
       coalesce(u.avatar_key, a.avatar_key) as author_avatar
from messages m
join conversations c on c.id = m.conversation_id
left join users u on u.id = m.author_user_id
left join agents a on a.id = m.author_agent_id
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
