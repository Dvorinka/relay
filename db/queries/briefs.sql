-- name: CreateBriefConversation :one
insert into conversations (project_id, kind, brief_id)
values (sqlc.arg(project_id), 'brief', sqlc.arg(brief_id))
returning *;

-- name: CreateBrief :one
insert into briefs (project_id, issue_id, title, summary, scene,
                    created_by_user, created_by_agent)
values (sqlc.arg(project_id), sqlc.narg(issue_id), sqlc.arg(title),
        sqlc.arg(summary), sqlc.arg(scene),
        sqlc.narg(created_by_user), sqlc.narg(created_by_agent))
returning *;

-- name: BriefSetConversation :exec
update briefs set conversation_id = sqlc.arg(conversation_id) where id = sqlc.arg(id);

-- name: ListBriefs :many
select b.*,
       coalesce(u.name, a.name, nullif(b.creator_name_snapshot, ''), '') as author_name,
       coalesce(p.key, ''::text) as issue_project_key,
       i.number as issue_number
from briefs b
left join users u on u.id = b.created_by_user
left join agents a on a.id = b.created_by_agent
left join issues i on i.id = b.issue_id
left join projects p on p.id = i.project_id
where b.project_id = sqlc.arg(project_id)
  and (sqlc.narg(issue_id)::uuid is null or b.issue_id = sqlc.narg(issue_id))
order by b.created_at desc;

-- name: GetBrief :one
select b.*,
       coalesce(u.name, a.name, nullif(b.creator_name_snapshot, ''), '') as author_name,
       coalesce(u.id is not null, false) as author_is_user,
       coalesce(p.key, ''::text) as issue_project_key,
       i.number as issue_number
from briefs b
left join users u on u.id = b.created_by_user
left join agents a on a.id = b.created_by_agent
left join issues i on i.id = b.issue_id
left join projects p on p.id = i.project_id
where b.id = sqlc.arg(id);

-- name: UpdateBrief :one
update briefs set
  title   = coalesce(sqlc.narg(title), title),
  summary = coalesce(sqlc.narg(summary), summary),
  scene   = coalesce(sqlc.narg(scene), scene),
  status  = coalesce(sqlc.narg(status), status),
  updated_at = now()
where id = sqlc.arg(id)
returning *;

-- name: SetBriefPolicy :one
update projects set brief_policy = sqlc.arg(policy)
where id = sqlc.arg(project_id)
returning brief_policy;
