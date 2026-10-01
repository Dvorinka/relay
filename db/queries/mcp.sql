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
insert into messages (conversation_id, author_agent_id, body)
values (sqlc.arg(conversation_id), sqlc.arg(agent_id), sqlc.arg(body))
returning id;

-- name: GetMessageFull :one
select m.id, m.conversation_id, m.body, m.created_at, m.edited_at,
       m.author_user_id, m.author_agent_id,
       coalesce(u.name, a.name, '') as author_name,
       coalesce(u.avatar_key, a.avatar_key) as author_avatar
from messages m
left join users u on u.id = m.author_user_id
left join agents a on a.id = m.author_agent_id
where m.id = sqlc.arg(id);

-- name: MarkMessageReadAgent :exec
insert into message_reads (message_id, agent_id)
values (sqlc.arg(message_id), sqlc.arg(agent_id))
on conflict (message_id, agent_id) where agent_id is not null do nothing;

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
