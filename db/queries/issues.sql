-- name: NextIssueNumber :one
-- atomic per-project counter; safe under concurrent creates
insert into project_counters (project_id, next_issue_number)
values (sqlc.arg(project_id), 2)
on conflict (project_id) do update
    set next_issue_number = project_counters.next_issue_number + 1
returning next_issue_number - 1 as number;

-- name: CreateIssue :one
insert into issues (project_id, number, title, description, status, priority, assignee_id, created_by)
values (sqlc.arg(project_id), sqlc.arg(number), sqlc.arg(title), sqlc.arg(description),
        sqlc.arg(status), sqlc.arg(priority), sqlc.arg(assignee_id), sqlc.arg(created_by))
returning *;

-- name: GetIssueForUser :one
select i.*, u.name as assignee_name, u.avatar_key as assignee_avatar,
       gr.owner as github_repo_owner, gr.name as github_repo_name,
       gr.installation_id as github_installation_id
from issues i
join projects p on p.id = i.project_id
join workspace_members wm on wm.workspace_id = p.workspace_id and wm.user_id = sqlc.arg(user_id)
left join users u on u.id = i.assignee_id
left join repositories gr on gr.id = i.github_repo_id
where i.id = sqlc.arg(id);

-- name: GetIssueByID :one
select i.*, u.name as assignee_name, u.avatar_key as assignee_avatar,
       gr.owner as github_repo_owner, gr.name as github_repo_name
from issues i
left join users u on u.id = i.assignee_id
left join repositories gr on gr.id = i.github_repo_id
where i.id = sqlc.arg(id);

-- name: ListIssuesForUser :many
select i.*, u.name as assignee_name, u.avatar_key as assignee_avatar,
       gr.owner as github_repo_owner, gr.name as github_repo_name
from issues i
join projects p on p.id = i.project_id
join workspace_members wm on wm.workspace_id = p.workspace_id and wm.user_id = sqlc.arg(user_id)
left join users u on u.id = i.assignee_id
left join repositories gr on gr.id = i.github_repo_id
where i.project_id = sqlc.arg(project_id)
  and (sqlc.narg(status)::text is null or i.status = sqlc.narg(status))
  and (sqlc.narg(assignee)::uuid is null or i.assignee_id = sqlc.narg(assignee))
  and (sqlc.narg(label)::uuid is null or exists (
        select 1 from issue_label_links ll
        where ll.issue_id = i.id and ll.label_id = sqlc.narg(label)))
  and (sqlc.narg(q)::text is null or i.title ilike '%' || sqlc.narg(q) || '%')
order by i.number desc;

-- name: UpdateIssueFields :one
update issues set
    title = coalesce(sqlc.narg(title), title),
    description = coalesce(sqlc.narg(description), description),
    status = coalesce(sqlc.narg(status), status),
    priority = coalesce(sqlc.narg(priority), priority),
    updated_at = now()
where id = sqlc.arg(id)
returning *;

-- name: SetIssueAssignee :exec
update issues set assignee_id = sqlc.arg(assignee_id), updated_at = now()
where id = sqlc.arg(id);

-- name: TouchIssue :exec
update issues set updated_at = now() where id = sqlc.arg(id);

-- name: SetIssueGitHub :exec
-- link a relay issue to its GitHub counterpart (write-back)
update issues set
    github_repo_id = sqlc.arg(github_repo_id),
    github_number = sqlc.arg(github_number),
    github_node_id = sqlc.arg(github_node_id),
    updated_at = now()
where id = sqlc.arg(id);

-- name: UserInProjectWorkspace :one
select exists (
    select 1 from projects p
    join workspace_members wm on wm.workspace_id = p.workspace_id
    where p.id = sqlc.arg(project_id) and wm.user_id = sqlc.arg(member_id)
);

-- name: CreateLabel :one
insert into issue_labels (project_id, name, color)
values (sqlc.arg(project_id), sqlc.arg(name), sqlc.arg(color))
returning *;

-- name: ListProjectLabels :many
select * from issue_labels where project_id = sqlc.arg(project_id) order by lower(name);

-- name: CountLabelsInProject :one
select count(*) from issue_labels
where project_id = sqlc.arg(project_id) and id = any(sqlc.arg(ids)::uuid[]);

-- name: ReplaceIssueLabelLinks :exec
delete from issue_label_links where issue_id = sqlc.arg(issue_id);

-- name: LinkIssueLabel :exec
insert into issue_label_links (issue_id, label_id)
values (sqlc.arg(issue_id), sqlc.arg(label_id))
on conflict do nothing;

-- name: ListIssueLabels :many
select l.* from issue_label_links ll
join issue_labels l on l.id = ll.label_id
where ll.issue_id = sqlc.arg(issue_id)
order by lower(l.name);

-- name: ListLabelsForIssues :many
select l.*, ll.issue_id from issue_label_links ll
join issue_labels l on l.id = ll.label_id
where ll.issue_id = any(sqlc.arg(ids)::uuid[]);

-- name: RecordIssueActivity :one
insert into issue_activity (issue_id, actor_user_id, kind, payload)
values (sqlc.arg(issue_id), sqlc.arg(actor_user_id), sqlc.arg(kind), sqlc.arg(payload))
returning *;

-- name: ListIssueActivity :many
select a.*, u.name as actor_name, u.avatar_key as actor_avatar
from issue_activity a
left join users u on u.id = a.actor_user_id
where a.issue_id = sqlc.arg(issue_id)
order by a.created_at desc
limit 100;

-- name: GetIssueConversation :one
select * from conversations where issue_id = sqlc.arg(issue_id) and kind = 'issue';

-- name: CreateIssueConversation :one
insert into conversations (project_id, kind, issue_id)
values (sqlc.arg(project_id), 'issue', sqlc.arg(issue_id))
returning *;

-- name: GetMessageWithProjectForUser :one
-- message row + owning project, only when the caller is a workspace member
select m.id, m.body, c.project_id
from messages m
join conversations c on c.id = m.conversation_id
join projects p on p.id = c.project_id
join workspace_members wm on wm.workspace_id = p.workspace_id and wm.user_id = sqlc.arg(user_id)
where m.id = sqlc.arg(id);
