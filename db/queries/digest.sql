-- name: UserDigestEnabled :one
select digest_enabled from users where id = sqlc.arg(id);

-- name: SetUserDigest :one
update users set digest_enabled = sqlc.arg(digest_enabled), updated_at = now()
where id = sqlc.arg(id)
returning id;

-- name: CreatePushDigest :exec
insert into push_digests (user_id, title, body, url)
values (sqlc.arg(user_id), sqlc.arg(title), sqlc.arg(body), sqlc.arg(url));

-- name: ListPendingDigests :many
-- sweep input: every unflushed digest, grouped client-side by user
select * from push_digests
where flushed_at is null
order by created_at asc;

-- name: MarkDigestsFlushed :exec
update push_digests set flushed_at = now()
where user_id = sqlc.arg(user_id) and flushed_at is null;
