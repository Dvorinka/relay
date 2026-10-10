-- +goose Up
-- Ideas become workspace-level documents: a workspace_id is the owning scope
-- and project_id turns optional — an idea can float platform-wide or attach
-- to one project for context.
alter table ideas add column workspace_id uuid references workspaces(id) on delete cascade;
update ideas i set workspace_id = p.workspace_id from projects p where p.id = i.project_id;
alter table ideas alter column workspace_id set not null;
alter table ideas alter column project_id drop not null;
create index ideas_workspace_idx on ideas (workspace_id, updated_at desc);

-- +goose Down
delete from ideas where project_id is null;
alter table ideas alter column project_id set not null;
drop index ideas_workspace_idx;
alter table ideas drop column workspace_id;
