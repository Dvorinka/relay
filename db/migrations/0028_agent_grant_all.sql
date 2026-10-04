-- +goose Up
-- Workspace-wide agent grants: an invite scoped to "all projects" now means
-- every project in the workspace, including ones created after the agent
-- registered. grant_scopes is the scope set applied where no explicit
-- agent_project_permissions row exists; a row still wins when present.
alter table agents
    add column grant_all boolean not null default false,
    add column grant_scopes text[] not null default '{}'
        check (grant_scopes <@ array[
            'project:read','message:read','message:write',
            'attachment:read','issue:read','issue:write',
            'review:read','review:write',
            'file:read','brief:read','brief:write']::text[]);

-- +goose Down
alter table agents drop column grant_scopes;
alter table agents drop column grant_all;
