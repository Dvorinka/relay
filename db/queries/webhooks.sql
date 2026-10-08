-- name: CreateWebhookSubscription :one
insert into webhook_subscriptions (project_id, url, secret, events, active, created_by)
values (sqlc.arg(project_id), sqlc.arg(url), sqlc.arg(secret), sqlc.arg(events)::text[], sqlc.arg(active), sqlc.arg(created_by))
returning *;

-- name: ListProjectWebhooks :many
select * from webhook_subscriptions where project_id = sqlc.arg(project_id) order by created_at desc;

-- name: GetWebhookForUser :one
-- subscription + owning project, only when the caller is a workspace member
select s.*, p.workspace_id
from webhook_subscriptions s
join projects p on p.id = s.project_id
join workspace_members wm on wm.workspace_id = p.workspace_id and wm.user_id = sqlc.arg(user_id)
where s.id = sqlc.arg(id);

-- name: GetWebhookByID :one
select s.*, p.workspace_id
from webhook_subscriptions s
join projects p on p.id = s.project_id
where s.id = sqlc.arg(id);

-- name: UpdateWebhook :one
update webhook_subscriptions set
    url = coalesce(sqlc.narg(url), url),
    events = coalesce(sqlc.narg(events)::text[], events),
    active = coalesce(sqlc.narg(active), active),
    updated_at = now()
where id = sqlc.arg(id)
returning *;

-- name: DeleteWebhook :exec
delete from webhook_subscriptions where id = sqlc.arg(id);

-- name: ActiveWebhooksForProject :many
select * from webhook_subscriptions where project_id = sqlc.arg(project_id) and active;

-- name: RecordWebhookDelivery :one
insert into webhook_deliveries (subscription_id, event_type, payload, status_code, attempts, duration_ms, success)
values (sqlc.arg(subscription_id), sqlc.arg(event_type), sqlc.arg(payload)::jsonb, sqlc.narg(status_code), sqlc.arg(attempts), sqlc.arg(duration_ms), sqlc.arg(success))
returning *;

-- name: ListWebhookDeliveries :many
select * from webhook_deliveries where subscription_id = sqlc.arg(subscription_id)
order by created_at desc limit 50;

-- name: TrimWebhookDeliveries :exec
-- keep the newest 200 rows per subscription
delete from webhook_deliveries d
where d.subscription_id = sqlc.arg(subscription_id)
  and d.id not in (
    select id from webhook_deliveries
    where subscription_id = sqlc.arg(subscription_id)
    order by created_at desc limit 200
  );

-- name: CreateInboundHook :one
insert into inbound_hooks (project_id, conversation_id, name, token_hash, created_by)
values (sqlc.arg(project_id), sqlc.arg(conversation_id), sqlc.arg(name), sqlc.arg(token_hash), sqlc.arg(created_by))
returning *;

-- name: ListInboundHooks :many
select * from inbound_hooks where project_id = sqlc.arg(project_id) order by created_at desc;

-- name: GetInboundHookByTokenHash :one
select * from inbound_hooks where token_hash = sqlc.arg(token_hash) and enabled;

-- name: GetInboundHookForUser :one
-- hook + owning project, only when the caller is a workspace member
select h.*, p.workspace_id
from inbound_hooks h
join projects p on p.id = h.project_id
join workspace_members wm on wm.workspace_id = p.workspace_id and wm.user_id = sqlc.arg(user_id)
where h.id = sqlc.arg(id);

-- name: RotateInboundHook :one
update inbound_hooks set token_hash = sqlc.arg(token_hash)
where id = sqlc.arg(id)
returning *;

-- name: UpdateInboundHook :one
update inbound_hooks set
    name = coalesce(sqlc.narg(name), name),
    enabled = coalesce(sqlc.narg(enabled), enabled)
where id = sqlc.arg(id)
returning *;

-- name: DeleteInboundHook :exec
delete from inbound_hooks where id = sqlc.arg(id);

-- name: TouchInboundHook :exec
update inbound_hooks set last_used_at = now() where id = sqlc.arg(id);
