-- MCP tool queries. Authorization is scope-based: resolvers map an entity
-- to its project, then AgentScopeForProject decides.

-- name: ResolveConversationProject :one
select project_id from conversations where id = sqlc.arg(id);

-- name: ResolveMessageProject :one
select c.project_id from messages m
join conversations c on c.id = m.conversation_id
where m.id = sqlc.arg(id);

-- name: ResolveIssueProject :one
select project_id from issues where id = sqlc.arg(id);

-- name: ResolveAttachmentProject :one
select project_id from attachments where id = sqlc.arg(id);

-- name: ListProjectConversations :many
select * from conversations where project_id = sqlc.arg(project_id)
order by created_at;

-- name: SearchMessagesInProject :many
select m.id, m.conversation_id, m.body, m.created_at, m.edited_at,
       m.author_user_id, m.author_agent_id,
       coalesce(u.name, a.name, '') as author_name,
       coalesce(u.avatar_key, a.avatar_key) as author_avatar
from messages m
join conversations c on c.id = m.conversation_id
left join users u on u.id = m.author_user_id
left join agents a on a.id = m.author_agent_id
where c.project_id = sqlc.arg(project_id)
  and m.deleted_at is null
  and m.body ilike '%' || sqlc.arg(q) || '%'
order by m.created_at desc
limit sqlc.arg(lim);

-- name: ListProjectIssuesForAgent :many
select i.*, u.name as assignee_name, u.avatar_key as assignee_avatar
from issues i
left join users u on u.id = i.assignee_id
where i.project_id = sqlc.arg(project_id)
order by i.number desc
limit sqlc.arg(lim);

-- name: GetIssueForAgent :one
select i.*, u.name as assignee_name, u.avatar_key as assignee_avatar
from issues i
left join users u on u.id = i.assignee_id
where i.id = sqlc.arg(id);

-- name: CreateAgentMessage :one
insert into messages (conversation_id, author_agent_id, body, parent_id, mentions)
values (sqlc.arg(conversation_id), sqlc.arg(agent_id), sqlc.arg(body), sqlc.narg(parent_id), coalesce(sqlc.narg(mentions), '[]'::jsonb))
returning id;

-- name: GetMessageFull :one
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
where m.id = sqlc.arg(id);

-- name: AddReactionAgent :exec
insert into message_reactions (message_id, agent_id, emoji)
values (sqlc.arg(message_id), sqlc.arg(agent_id), sqlc.arg(emoji))
on conflict (message_id, agent_id, emoji) where agent_id is not null do nothing;

-- name: RemoveReactionAgent :execrows
delete from message_reactions
where message_id = sqlc.arg(message_id) and agent_id = sqlc.arg(agent_id) and emoji = sqlc.arg(emoji);

-- name: UpdateMessageBodyAgent :one
-- agents may edit their own messages while no agent has read them
update messages set body = sqlc.arg(body), edited_at = now()
where id = sqlc.arg(id)
  and author_agent_id = sqlc.arg(author_agent_id)
  and deleted_at is null
returning id;

-- name: MarkMessageReadAgent :exec
insert into message_reads (message_id, agent_id)
values (sqlc.arg(message_id), sqlc.arg(agent_id))
on conflict (message_id, agent_id) where agent_id is not null do nothing;

-- name: MarkMessagesReadAgent :exec
-- batch read receipt: fetching messages marks them read by this agent
insert into message_reads (message_id, agent_id)
select m.id, sqlc.arg(agent_id) from messages m
where m.id = any(sqlc.arg(ids)::uuid[]) and m.deleted_at is null
on conflict (message_id, agent_id) where agent_id is not null do nothing;

-- name: MessageInConversation :one
select id from messages
where id = sqlc.arg(id) and conversation_id = sqlc.arg(conversation_id)
  and deleted_at is null;

-- name: GetAttachmentByID :one
select * from attachments where id = sqlc.arg(id);

-- name: CreateIssueForAgent :one
insert into issues (project_id, number, title, description, status, priority, assignee_id, created_by, agent_id)
values (sqlc.arg(project_id), sqlc.arg(number), sqlc.arg(title), sqlc.arg(description),
        'todo', sqlc.arg(priority), null, null, sqlc.arg(agent_id))
returning *;

-- name: RecordIssueActivityAgent :exec
insert into issue_activity (issue_id, actor_agent_id, kind, payload)
values (sqlc.arg(issue_id), sqlc.arg(agent_id), sqlc.arg(kind), sqlc.arg(payload));
