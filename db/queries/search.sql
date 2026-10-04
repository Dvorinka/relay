-- name: SearchMessages :many
-- global message FTS across the user's workspaces, ranked.
-- Optional qualifiers parsed by the handler: author ilike, project key,
-- has-image/has-file attachment filters, created_at bounds.
select m.id, m.body, m.created_at, c.project_id,
       coalesce(u.name, a.name, '') as author_name,
       coalesce(ts_rank(to_tsvector('english', m.body),
               websearch_to_tsquery('english', nullif(sqlc.arg(q), ''))), 0) as rank
from messages m
join conversations c on c.id = m.conversation_id
join projects p on p.id = c.project_id
join workspace_members wm on wm.workspace_id = p.workspace_id and wm.user_id = $1
left join users u on u.id = m.author_user_id
left join agents a on a.id = m.author_agent_id
where m.deleted_at is null
  and (sqlc.arg(q) = '' or to_tsvector('english', m.body) @@ websearch_to_tsquery('english', sqlc.arg(q)))
  and (sqlc.arg(author) = '' or coalesce(u.name, a.name, '') ilike sqlc.arg(author))
  and (sqlc.arg(project_key) = '' or upper(p.key) = upper(sqlc.arg(project_key)))
  and (sqlc.narg(has_image)::bool is not true or exists (
        select 1 from message_attachments ma
        join attachments att on att.id = ma.attachment_id
        where ma.message_id = m.id and att.content_type like 'image/%'))
  and (sqlc.narg(has_file)::bool is not true or exists (
        select 1 from message_attachments ma where ma.message_id = m.id))
  and (sqlc.narg(before)::timestamptz is null or m.created_at < sqlc.narg(before)::timestamptz)
  and (sqlc.narg(after)::timestamptz is null or m.created_at >= sqlc.narg(after)::timestamptz)
order by rank desc, m.created_at desc
limit 20;

-- name: SearchIssues :many
select i.id, i.number, i.title, i.status, i.priority, i.project_id,
       p.key as project_key,
       ts_rank(
         to_tsvector('english', i.title || ' ' || i.description)
         || to_tsvector('simple', p.key || '-' || i.number || ' ' || p.key || i.number),
         websearch_to_tsquery('english', $2)) as rank
from issues i
join projects p on p.id = i.project_id
join workspace_members wm on wm.workspace_id = p.workspace_id and wm.user_id = $1
where (to_tsvector('english', i.title || ' ' || i.description)
       || to_tsvector('simple', p.key || '-' || i.number || ' ' || p.key || i.number))
      @@ websearch_to_tsquery('english', $2)
      or upper(p.key || '-' || i.number) = upper($2)
order by rank desc, i.updated_at desc
limit 20;

-- name: SearchProjects :many
select p.id, p.key, p.name, p.description, p.icon, p.color,
       ts_rank(to_tsvector('english', p.name || ' ' || p.description),
               websearch_to_tsquery('english', $2)) as rank
from projects p
join workspace_members wm on wm.workspace_id = p.workspace_id and wm.user_id = $1
where to_tsvector('english', p.name || ' ' || p.description)
      @@ websearch_to_tsquery('english', $2)
order by rank desc
limit 10;

-- name: SearchTodos :many
select t.id, t.content, t.done, t.project_id,
       ts_rank(to_tsvector('english', t.content), websearch_to_tsquery('english', $2)) as rank
from agent_todos t
join projects p on p.id = t.project_id
join workspace_members wm on wm.workspace_id = p.workspace_id and wm.user_id = $1
where to_tsvector('english', t.content) @@ websearch_to_tsquery('english', $2)
order by rank desc, t.created_at desc
limit 20;
