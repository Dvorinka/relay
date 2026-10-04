-- name: ListTodos :many
select t.*, coalesce(a.name, nullif(t.agent_name_snapshot, '')) as agent_name, i.number as issue_number, p.key as issue_key
from agent_todos t
left join agents a on a.id = t.agent_id
left join issues i on i.id = t.issue_id
left join projects p on p.id = i.project_id
where t.project_id = sqlc.arg(project_id)
order by t.done, t.position, t.created_at;

-- name: CreateTodo :one
insert into agent_todos (project_id, agent_id, issue_id, content, status, done, position)
values (sqlc.arg(project_id), sqlc.narg(agent_id), sqlc.narg(issue_id),
        sqlc.arg(content),
        coalesce(sqlc.narg(status)::text, 'todo'),
        coalesce(sqlc.narg(status)::text, 'todo') = 'done',
        coalesce((select max(position) + 1 from agent_todos where project_id = sqlc.arg(project_id)), 0))
returning *;

-- name: GetTodo :one
select * from agent_todos where id = sqlc.arg(id);

-- name: GetTodoJoined :one
select t.*, coalesce(a.name, nullif(t.agent_name_snapshot, '')) as agent_name, i.number as issue_number, p.key as issue_key
from agent_todos t
left join agents a on a.id = t.agent_id
left join issues i on i.id = t.issue_id
left join projects p on p.id = i.project_id
where t.id = sqlc.arg(id);

-- name: UpdateTodo :one
update agent_todos set
    content = coalesce(sqlc.narg(content)::text, content),
    status = case
        when sqlc.narg(status)::text is not null then sqlc.narg(status)::text
        when sqlc.narg(done)::boolean is not null then case when sqlc.narg(done)::boolean then 'done' else 'todo' end
        else status end,
    done = case
        when sqlc.narg(status)::text is not null then sqlc.narg(status)::text = 'done'
        when sqlc.narg(done)::boolean is not null then sqlc.narg(done)::boolean
        else done end,
    issue_id = coalesce(sqlc.narg(issue_id)::uuid, issue_id),
    position = coalesce(sqlc.narg(position)::integer, position),
    updated_at = now()
where id = sqlc.arg(id)
returning *;

-- name: DeleteTodo :exec
delete from agent_todos where id = sqlc.arg(id);

-- name: TodoProject :one
select project_id from agent_todos where id = sqlc.arg(id);

-- name: GetIssueByKey :one
select i.id, i.number, i.project_id, p.key as project_key
from issues i join projects p on p.id = i.project_id
where p.id = sqlc.arg(project_id) and i.number = sqlc.arg(number);

-- name: ListTodosByAgent :many
select * from agent_todos
where project_id = sqlc.arg(project_id) and agent_id = sqlc.arg(agent_id)
order by position, created_at;
