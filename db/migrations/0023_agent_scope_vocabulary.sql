-- +goose Up
-- Widen the grant scope vocabulary: file:read + brief:read/brief:write are
-- enforced by the MCP server but were missing from the CHECK, so grants and
-- invites carrying them were rejected with "unknown scope".
alter table agent_project_permissions
    drop constraint agent_project_permissions_scopes_check;
alter table agent_project_permissions
    add constraint agent_project_permissions_scopes_check
    check (scopes <@ array[
        'project:read','message:read','message:write',
        'attachment:read','issue:read','issue:write',
        'review:read','review:write',
        'file:read','brief:read','brief:write']::text[]);

alter table agent_invites
    drop constraint agent_invites_scopes_check;
alter table agent_invites
    add constraint agent_invites_scopes_check
    check (scopes <@ array[
        'project:read','message:read','message:write',
        'attachment:read','issue:read','issue:write',
        'review:read','review:write',
        'file:read','brief:read','brief:write']::text[]);

-- +goose Down
alter table agent_invites
    drop constraint agent_invites_scopes_check;
alter table agent_invites
    add constraint agent_invites_scopes_check
    check (scopes <@ array[
        'project:read','message:read','message:write',
        'attachment:read','issue:read','issue:write',
        'review:read','review:write']::text[]);
alter table agent_project_permissions
    drop constraint agent_project_permissions_scopes_check;
alter table agent_project_permissions
    add constraint agent_project_permissions_scopes_check
    check (scopes <@ array[
        'project:read','message:read','message:write',
        'attachment:read','issue:read','issue:write',
        'review:read','review:write']::text[]);
