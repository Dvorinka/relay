-- name: CreateAttachment :one
insert into attachments (id, project_id, uploader_id, storage_key, filename, content_type, size_bytes)
values (sqlc.arg(id), sqlc.arg(project_id), sqlc.arg(uploader_id), sqlc.arg(storage_key),
        sqlc.arg(filename), sqlc.arg(content_type), sqlc.arg(size_bytes))
returning *;

-- name: MarkAttachmentReady :one
update attachments set status = 'ready' where id = sqlc.arg(id)
returning *;

-- name: DeleteAttachment :exec
delete from attachments where id = sqlc.arg(id);

-- name: GetAttachmentInProjectForUser :one
-- one row only when the attachment exists, sits in the given project, and
-- the caller belongs to the project's workspace
select a.* from attachments a
join projects p on p.id = a.project_id
join workspace_members wm on wm.workspace_id = p.workspace_id and wm.user_id = sqlc.arg(user_id)
where a.id = sqlc.arg(id) and a.project_id = sqlc.arg(project_id);

-- name: CountUsableAttachmentsInProject :one
-- how many of the given ids are ready attachments inside this project
select count(*) from attachments
where project_id = sqlc.arg(project_id) and status = 'ready'
  and id = any(sqlc.arg(ids)::uuid[]);

-- name: LinkMessageAttachment :exec
insert into message_attachments (message_id, attachment_id, position)
values (sqlc.arg(message_id), sqlc.arg(attachment_id), sqlc.arg(position));

-- name: CountMessageAttachments :one
select count(*) from message_attachments where message_id = sqlc.arg(message_id);

-- name: ListAttachmentsForMessages :many
select a.*, ma.message_id
from message_attachments ma
join attachments a on a.id = ma.attachment_id
where ma.message_id = any(sqlc.arg(ids)::uuid[])
order by ma.position;
