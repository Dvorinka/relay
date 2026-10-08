-- name: GetGitHubApp :one
select * from github_app where id = true;

-- name: UpsertGitHubApp :exec
insert into github_app (id, app_id, slug, name, client_id, client_secret_enc, private_key_enc, webhook_secret_enc)
values (true, sqlc.arg(app_id), sqlc.arg(slug), sqlc.arg(name), sqlc.arg(client_id),
        sqlc.arg(client_secret_enc), sqlc.arg(private_key_enc), sqlc.arg(webhook_secret_enc))
on conflict (id) do update set
    app_id = excluded.app_id, slug = excluded.slug, name = excluded.name,
    client_id = excluded.client_id, client_secret_enc = excluded.client_secret_enc,
    private_key_enc = excluded.private_key_enc,
    webhook_secret_enc = excluded.webhook_secret_enc;

-- name: DeleteGitHubApp :exec
delete from github_app;

-- name: UpsertInstallation :one
insert into github_installations (workspace_id, installation_id, account_login, account_type)
values (sqlc.arg(workspace_id), sqlc.arg(installation_id), sqlc.arg(account_login), sqlc.arg(account_type))
on conflict (installation_id) do update set account_login = excluded.account_login
returning *;

-- name: DeleteInstallation :exec
delete from github_installations where installation_id = sqlc.arg(installation_id);

-- name: ListInstallationsForWorkspace :many
select * from github_installations where workspace_id = sqlc.arg(workspace_id);

-- name: GetInstallationByInstallID :one
select * from github_installations where installation_id = sqlc.arg(installation_id);

-- name: UpsertRepoLink :one
insert into repositories (project_id, installation_id, owner, name, default_branch, linked_by)
values (sqlc.arg(project_id), sqlc.arg(installation_id), sqlc.arg(owner), sqlc.arg(name),
        sqlc.arg(default_branch), sqlc.arg(linked_by))
on conflict (installation_id, owner, name) do update set project_id = excluded.project_id
returning *;

-- name: DeleteRepoLink :exec
delete from repositories where id = sqlc.arg(id);

-- name: ListProjectRepos :many
select * from repositories where project_id = sqlc.arg(project_id) order by owner, name;

-- name: GetRepoByID :one
select * from repositories where id = sqlc.arg(id);

-- name: GetRepoByFullName :one
select * from repositories where installation_id = sqlc.arg(installation_id)
  and owner = sqlc.arg(owner) and name = sqlc.arg(name);

-- name: GetRepoForIssue :one
select r.* from repositories r
where r.installation_id = sqlc.arg(installation_id)
  and r.owner = sqlc.arg(owner) and r.name = sqlc.arg(name);

-- name: RecordGitHubEvent :exec
insert into github_events (delivery_id, event)
values (sqlc.arg(delivery_id), sqlc.arg(event))
on conflict (delivery_id) do nothing;

-- name: HasGitHubEvent :one
select exists(select 1 from github_events where delivery_id = sqlc.arg(delivery_id));

-- name: FindIssueByGitHub :one
select * from issues
where github_repo_id = sqlc.arg(repo_id) and github_number = sqlc.arg(number);

-- name: CreateGitHubIssue :one
insert into issues (project_id, number, title, description, status, priority,
                    github_node_id, github_repo_id, github_number, origin,
                    github_kind, github_state, github_url)
values (sqlc.arg(project_id), sqlc.arg(number), sqlc.arg(title), sqlc.arg(description),
        sqlc.arg(status), 'none', sqlc.arg(node_id), sqlc.arg(repo_id), sqlc.arg(gh_number), 'github',
        sqlc.arg(kind), sqlc.arg(gh_state), sqlc.arg(gh_url))
returning *;

-- name: UpdateGitHubIssue :one
update issues set
    title = coalesce(sqlc.narg(title)::text, title),
    description = coalesce(sqlc.narg(description)::text, description),
    status = coalesce(sqlc.narg(status)::text, status),
    github_state = coalesce(sqlc.narg(gh_state)::text, github_state),
    github_url = coalesce(sqlc.narg(gh_url)::text, github_url),
    updated_at = now()
where id = sqlc.arg(id)
returning *;

-- name: ListProjectReposForWorkspace :many
select r.* from repositories r
join projects p on p.id = r.project_id
where p.workspace_id = sqlc.arg(workspace_id)
order by r.owner, r.name;

-- name: ListWorkspaceRepoProjects :many
-- every linked repo in the workspace, carrying its project's name/key so
-- aggregate views (all open PRs) don't need a second hop
select r.*, p.name as project_name, p.key as project_key
from repositories r
join projects p on p.id = r.project_id
where p.workspace_id = sqlc.arg(workspace_id)
order by r.owner, r.name;
