-- +goose Up
-- Agent file uploads: attachments can name an agent uploader instead of a
-- user, and the grant scope vocabulary grows 'attachment:write'. Existing
-- grants that already allow attachment:read get the write side too.

alter table attachments
    add column uploader_agent_id uuid references agents(id) on delete cascade;
alter table attachments alter column uploader_id drop not null;
alter table attachments
    add constraint attachments_one_uploader
    check (num_nonnulls(uploader_id, uploader_agent_id) = 1);

alter table agent_project_permissions
    drop constraint agent_project_permissions_scopes_check;
alter table agent_project_permissions
    add constraint agent_project_permissions_scopes_check
    check (scopes <@ array[
        'project:read','message:read','message:write',
        'attachment:read','attachment:write','issue:read','issue:write',
        'review:read','review:write',
        'file:read','brief:read','brief:write']::text[]);

alter table agent_invites
    drop constraint agent_invites_scopes_check;
alter table agent_invites
    add constraint agent_invites_scopes_check
    check (scopes <@ array[
        'project:read','message:read','message:write',
        'attachment:read','attachment:write','issue:read','issue:write',
        'review:read','review:write',
        'file:read','brief:read','brief:write']::text[]);

alter table agents
    drop constraint agents_grant_scopes_check;
alter table agents
    add constraint agents_grant_scopes_check
    check (grant_scopes <@ array[
        'project:read','message:read','message:write',
        'attachment:read','attachment:write','issue:read','issue:write',
        'review:read','review:write',
        'file:read','brief:read','brief:write']::text[]);

update agent_project_permissions
set scopes = array_append(scopes, 'attachment:write')
where 'attachment:read' = any(scopes)
  and not 'attachment:write' = any(scopes);

update agents
set grant_scopes = array_append(grant_scopes, 'attachment:write')
where 'attachment:read' = any(grant_scopes)
  and not 'attachment:write' = any(grant_scopes);

-- +goose Down
update agent_project_permissions
set scopes = array_remove(scopes, 'attachment:write')
where 'attachment:write' = any(scopes);
update agents
set grant_scopes = array_remove(grant_scopes, 'attachment:write')
where 'attachment:write' = any(grant_scopes);

alter table agents
    drop constraint agents_grant_scopes_check;
alter table agents
    add constraint agents_grant_scopes_check
    check (grant_scopes <@ array[
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

alter table agent_project_permissions
    drop constraint agent_project_permissions_scopes_check;
alter table agent_project_permissions
    add constraint agent_project_permissions_scopes_check
    check (scopes <@ array[
        'project:read','message:read','message:write',
        'attachment:read','issue:read','issue:write',
        'review:read','review:write',
        'file:read','brief:read','brief:write']::text[]);

alter table attachments drop constraint attachments_one_uploader;
alter table attachments alter column uploader_id set not null;
alter table attachments drop column uploader_agent_id;
