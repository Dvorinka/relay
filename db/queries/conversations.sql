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

-- name: GetMessageConversation :one
-- conversation a message lives in - used to forbid nested threads
select conversation_id
from messages
where id = $1;

-- name: CreateThread :one
-- one thread per message; the unique index makes this race-safe. expires_at
-- is computed by the handler: default 5 days, NULL means the thread never
-- expires.
insert into conversations (project_id, kind, parent_message_id, title, created_by_user, expires_at)
values (sqlc.arg(project_id), 'thread', sqlc.arg(parent_message_id),
        sqlc.narg(title), sqlc.arg(created_by_user), sqlc.narg(expires_at))
on conflict (parent_message_id) where kind = 'thread' do nothing
returning *;

-- name: CreateThreadAgent :one
insert into conversations (project_id, kind, parent_message_id, title, created_by_agent, expires_at)
values (sqlc.arg(project_id), 'thread', sqlc.arg(parent_message_id),
        sqlc.narg(title), sqlc.arg(created_by_agent), sqlc.narg(expires_at))
on conflict (parent_message_id) where kind = 'thread' do nothing
returning *;

-- name: SetThreadExpiry :one
-- expires_at NULL keeps the thread alive forever
update conversations
set expires_at = sqlc.narg(expires_at)
where id = sqlc.arg(id) and kind = 'thread'
returning *;

-- name: DeleteExpiredThreads :execrows
delete from conversations
where kind = 'thread' and expires_at is not null and expires_at < now();

-- name: GetThreadByParentMessage :one
select *
from conversations
where parent_message_id = $1 and kind = 'thread'
  and (expires_at is null or expires_at > now());

-- name: GetThread :one
select c.id, c.project_id, c.parent_message_id, c.title, c.created_at, c.expires_at,
       pm.conversation_id as parent_conversation_id,
       coalesce(u.name, a.name, nullif(c.creator_name_snapshot, ''), '') as creator_name,
       case when pm.deleted_at is null then coalesce(pu.name, pa.name, nullif(pm.author_name_snapshot, ''), '')
            else 'Deleted' end as parent_author_name,
       case when pm.deleted_at is null then left(pm.body, 160)
            else 'Original message was deleted' end as parent_preview,
       (select count(*)::int from messages tm
         where tm.conversation_id = c.id and tm.deleted_at is null) as reply_count
from conversations c
join messages pm on pm.id = c.parent_message_id
left join users u on u.id = c.created_by_user
left join agents a on a.id = c.created_by_agent
left join users pu on pu.id = pm.author_user_id
left join agents pa on pa.id = pm.author_agent_id
where c.id = $1
  and (c.expires_at is null or c.expires_at > now());

-- name: ListProjectThreads :many
-- thread index for a project, most recently active first
select c.id, c.parent_message_id, c.title, c.created_at, c.expires_at,
       pm.conversation_id as parent_conversation_id,
       coalesce(u.name, a.name, nullif(c.creator_name_snapshot, ''), '') as creator_name,
       case when pm.deleted_at is null then coalesce(pu.name, pa.name, nullif(pm.author_name_snapshot, ''), '')
            else 'Deleted' end as parent_author_name,
       case when pm.deleted_at is null then left(pm.body, 160)
            else 'Original message was deleted' end as parent_preview,
       (select count(*)::int from messages tm
         where tm.conversation_id = c.id and tm.deleted_at is null) as reply_count,
       (select max(tm.created_at)::timestamptz from messages tm
         where tm.conversation_id = c.id and tm.deleted_at is null) as last_reply_at
from conversations c
join messages pm on pm.id = c.parent_message_id
left join users u on u.id = c.created_by_user
left join agents a on a.id = c.created_by_agent
left join users pu on pu.id = pm.author_user_id
left join agents pa on pa.id = pm.author_agent_id
where c.project_id = $1 and c.kind = 'thread'
  and (c.expires_at is null or c.expires_at > now())
order by last_reply_at desc nulls last, c.created_at desc
limit 100;

-- name: CreateChannel :one
-- named side conversation inside a project; name is unique per project
insert into conversations (project_id, kind, title, created_by_user)
values (sqlc.arg(project_id), 'channel', sqlc.arg(title), sqlc.narg(created_by_user))
on conflict (project_id, lower(title)) where kind = 'channel' do nothing
returning *;

-- name: ListChannels :many
-- a project's persistent channels, in creation order
select *
from conversations
where project_id = $1 and kind = 'channel'
order by created_at;

-- name: RenameChannel :one
update conversations
set title = sqlc.arg(title)
where id = sqlc.arg(id) and kind = 'channel'
returning *;

-- name: SetChannelAgentsBlocked :one
-- agents_blocked channels are invisible to MCP agents; humans unaffected
update conversations
set agents_blocked = sqlc.arg(agents_blocked)
where id = sqlc.arg(id) and kind = 'channel'
returning *;

-- name: DeleteChannel :execrows
delete from conversations
where id = $1 and kind = 'channel';

-- name: GetProjectForUser :one
-- project row only when the caller is a member of its workspace
select p.id, p.workspace_id, p.key, p.name, p.description, p.icon, p.color,
       p.statuses, p.local_path, p.brief_policy, p.created_at
from projects p
join workspace_members wm on wm.workspace_id = p.workspace_id
where p.id = $1 and wm.user_id = $2;

-- name: ListMessages :many
-- newest-first page; $2 is an optional "older than message id" cursor,
-- narg(tag) filters to messages carrying that tag
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
       coalesce(fu.name, fa.name, nullif(f.author_name_snapshot, ''), '') as fwd_author_name
from messages m
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
where m.conversation_id = $1
  and m.deleted_at is null
  and (sqlc.narg(tag)::text is null or sqlc.narg(tag)::text = any(m.tags))
  and (sqlc.narg(before)::uuid is null or
       (m.created_at, m.id) < (select m2.created_at, m2.id from messages m2 where m2.id = sqlc.narg(before)::uuid))
order by m.created_at desc, m.id desc
limit sqlc.arg(lim)::int;

-- name: ListPinnedMessages :many
-- pinned messages in one conversation, most recently pinned first
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
       coalesce(fu.name, fa.name, nullif(f.author_name_snapshot, ''), '') as fwd_author_name
from messages m
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
where m.conversation_id = $1
  and m.deleted_at is null
  and m.pinned_at is not null
order by m.pinned_at desc;

-- name: PinMessage :one
-- any project member may pin; conversation id comes back for the SSE frame
update messages set pinned_at = now()
where id = sqlc.arg(id) and deleted_at is null
returning id, conversation_id;

-- name: UnpinMessage :one
update messages set pinned_at = null
where id = sqlc.arg(id) and deleted_at is null
returning id, conversation_id;

-- name: CreateMessage :one
insert into messages (conversation_id, author_user_id, body, parent_id, mentions, forwarded_from, tags, silent)
values ($1, $2, $3, sqlc.narg(parent_id), coalesce(sqlc.narg(mentions), '[]'::jsonb), sqlc.narg(forwarded_from), coalesce(sqlc.narg(tags), '{}'::text[]), coalesce(sqlc.narg(silent), false))
returning id;

-- name: CopyMessageAttachments :exec
-- a forward reuses the same attachment objects behind the new message
insert into message_attachments (message_id, attachment_id, position)
select sqlc.arg(message_id)::uuid, attachment_id, position
from message_attachments
where message_id = sqlc.arg(source_id)::uuid;

-- name: MessageParentInConversation :one
-- reply target must live in the same conversation and be undeleted
select m.id
from messages m
where m.id = sqlc.arg(id)
  and m.conversation_id = sqlc.arg(conversation_id)
  and m.deleted_at is null;

-- name: GetMessageByID :one
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
       coalesce(fu.name, fa.name, nullif(f.author_name_snapshot, ''), '') as fwd_author_name
from messages m
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
where m.id = $1;

-- name: GetMessageForUser :one
-- message id only when the user may see its workspace
select m.id
from messages m
join conversations c on c.id = m.conversation_id
join projects p on p.id = c.project_id
join workspace_members wm on wm.workspace_id = p.workspace_id
where m.id = $1 and wm.user_id = $2 and m.deleted_at is null;

-- name: UpdateMessageBody :one
-- author-only edit; conversation id is resolved off the row afterwards
update messages set body = sqlc.arg(body), edited_at = now()
where id = sqlc.arg(id)
  and author_user_id = sqlc.arg(author_user_id)
  and deleted_at is null
returning id;

-- name: SoftDeleteMessage :one
-- author-only soft delete; conversation id comes back for the SSE frame
update messages set deleted_at = now()
where id = sqlc.arg(id)
  and author_user_id = sqlc.arg(author_user_id)
  and deleted_at is null
returning id, conversation_id;

-- name: SoftDeleteMessageAgent :one
-- agent-author counterpart; the MCP delete_message tool uses this
update messages set deleted_at = now()
where id = sqlc.arg(id)
  and author_agent_id = sqlc.arg(author_agent_id)
  and deleted_at is null
returning id, conversation_id;

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

-- name: AgentReadersForMessages :many
-- named read receipts: which agents (other than the author) have read each
-- message — name, avatar and timestamp feed the "seen by" row
select r.message_id, a.id as agent_id, a.name, a.avatar_key, r.read_at
from message_reads r
join messages m on m.id = r.message_id
join agents a on a.id = r.agent_id
where r.agent_id is not null
  and (m.author_agent_id is null or r.agent_id <> m.author_agent_id)
  and r.message_id = any(sqlc.arg(ids)::uuid[])
order by r.read_at asc;

-- name: MarkMessageRead :exec
-- own posts excluded — the author is never one of their own readers
insert into message_reads (message_id, user_id)
select m.id, sqlc.arg(user_id)
from messages m
where m.id = sqlc.arg(message_id)
  and (m.author_user_id is null or m.author_user_id <> sqlc.arg(user_id))
on conflict (message_id, user_id) where user_id is not null do nothing;

-- name: MarkConversationRead :exec
-- mark every message in the conversation read for the user (bulk, on view);
-- own posts excluded — the author's receipt is meaningless
insert into message_reads (message_id, user_id)
select m.id, sqlc.arg(user_id)
from messages m
where m.conversation_id = sqlc.arg(conversation_id)
  and m.deleted_at is null
  and (m.author_user_id is null or m.author_user_id <> sqlc.arg(user_id))
on conflict (message_id, user_id) where user_id is not null do nothing;

-- name: FirstUnreadMessageID :one
-- oldest message the user hasn't read — the "New" divider boundary.
-- Own messages don't count; result is null when the channel is caught up.
select m.id
from messages m
where m.conversation_id = $1
  and m.deleted_at is null
  and (m.author_user_id is null or m.author_user_id <> $2)
  and not exists (
    select 1 from message_reads r
    where r.message_id = m.id and r.user_id = $2)
order by m.created_at asc, m.id asc
limit 1;

-- name: ClearConversation :execrows
-- /clear — soft-delete every message in the conversation at once
update messages set deleted_at = now()
where conversation_id = $1 and deleted_at is null;

-- name: ClearReadStateUsers :exec
-- /clear wipes unread markers for every workspace member — on the channel
-- itself and on threads rooted at its messages (threads survive /clear but
-- shouldn't keep badging the inbox)
insert into message_reads (message_id, user_id)
select m.id, wm.user_id
from conversations c
join messages m on m.conversation_id = c.id
join projects p on p.id = c.project_id
join workspace_members wm on wm.workspace_id = p.workspace_id
where (c.id = $1
       or c.parent_message_id in
         (select id from messages where conversation_id = $1))
  and (m.author_user_id is null or m.author_user_id <> wm.user_id)
on conflict (message_id, user_id) where user_id is not null do nothing;

-- name: ClearReadStateAgents :exec
-- same reset for agents granted this project (or every project)
insert into message_reads (message_id, agent_id)
select m.id, a.id
from conversations c
join messages m on m.conversation_id = c.id
join projects p on p.id = c.project_id
join agents a on a.workspace_id = p.workspace_id
left join agent_project_permissions g
  on g.agent_id = a.id and g.project_id = p.id
where (c.id = $1
       or c.parent_message_id in
         (select id from messages where conversation_id = $1))
  and (a.grant_all or g.agent_id is not null)
  and (m.author_agent_id is null or m.author_agent_id <> a.id)
on conflict (message_id, agent_id) where agent_id is not null do nothing;

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
select m.id, m.conversation_id, m.body, m.mentions, m.tags, m.silent, m.created_at, m.edited_at, m.deleted_at, m.parent_id,
       m.author_user_id, m.author_agent_id, m.author_kind_snapshot,
       coalesce(u.name, a.name, nullif(m.author_name_snapshot, ''), '') as author_name,
       coalesce(u.avatar_key, a.avatar_key) as author_avatar,
       coalesce(pu.name, pa.name, nullif(pm.author_name_snapshot, ''), '') as parent_author_name,
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

-- name: UnreadConversations :many
-- per-conversation unread detail: which channel/issue/brief/thread holds the
-- unread messages. first_unread_id anchors deep links; per-project badge
-- counts are this grouped up in the handler.
select c.id as conversation_id, c.project_id, c.kind,
       c.issue_id, c.brief_id, c.parent_message_id, c.title as conversation_title,
       i.number as issue_number, i.title as issue_title,
       b.title as brief_title,
       count(m.id)::int as unread,
       fu.id as first_unread_id,
       fu.body as first_unread_body,
       fu.created_at as first_unread_at,
       fu.author_name as first_unread_author
from conversations c
join projects p on p.id = c.project_id
join workspace_members wm on wm.workspace_id = p.workspace_id
  and wm.user_id = $1
join messages m on m.conversation_id = c.id and m.deleted_at is null
left join issues i on i.id = c.issue_id
left join briefs b on b.id = c.brief_id
left join lateral (
  select m2.id, m2.body, m2.created_at,
         coalesce(u2.name, a2.name, nullif(m2.author_name_snapshot, ''), '') as author_name
  from messages m2
  left join users u2 on u2.id = m2.author_user_id
  left join agents a2 on a2.id = m2.author_agent_id
  where m2.conversation_id = c.id and m2.deleted_at is null
    and (m2.author_user_id is null or m2.author_user_id <> $1)
    and not exists (
      select 1 from message_reads r
      where r.message_id = m2.id and r.user_id = $1)
  order by m2.created_at asc, m2.id asc
  limit 1
) fu on true
where (m.author_user_id is null or m.author_user_id <> $1)
  and not exists (
    select 1 from message_reads r
    where r.message_id = m.id and r.user_id = $1)
group by c.id, c.project_id, c.kind, c.issue_id, c.brief_id,
         c.parent_message_id, c.title, i.number, i.title, b.title,
         fu.id, fu.body, fu.created_at, fu.author_name;

-- name: MentionsForUser :many
-- messages mentioning the user (@<name>), newest first
select m.id, m.conversation_id, m.body, m.tags, m.silent, m.created_at, m.edited_at,
       m.author_user_id, m.author_agent_id, m.author_kind_snapshot,
       coalesce(u.name, a.name, nullif(m.author_name_snapshot, ''), '') as author_name,
       coalesce(u.avatar_key, a.avatar_key) as author_avatar,
       c.project_id, c.kind as conversation_kind, c.issue_id,
       c.parent_message_id,
       pm.conversation_id as parent_conversation_id,
       (r.message_id is not null) as is_read
from messages m
join conversations c on c.id = m.conversation_id
join projects p on p.id = c.project_id
join workspace_members wm on wm.workspace_id = p.workspace_id
  and wm.user_id = $1
join users me on me.id = $1
left join users u on u.id = m.author_user_id
left join agents a on a.id = m.author_agent_id
left join messages pm on pm.id = c.parent_message_id
left join message_reads r on r.message_id = m.id and r.user_id = $1
where m.deleted_at is null
  and (m.author_user_id is null or m.author_user_id <> $1)
  and (position(lower('@' || me.name) in lower(m.body)) > 0
       or exists (select 1
                  from jsonb_array_elements(coalesce(m.mentions, '[]'::jsonb)) elem
                  where elem->>'kind' = 'user'
                    and elem->>'id' = me.id::text))
order by m.created_at desc, m.id desc
limit 50;

-- name: ParentAuthorID :one
-- user who wrote a message's parent; null when the parent is an agent's
select m2.author_user_id
from messages m
join messages m2 on m2.id = m.parent_id
where m.id = $1;
