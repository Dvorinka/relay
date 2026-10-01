-- name: CreatePasswordResetToken :exec
insert into password_reset_tokens (user_id, token_hash, expires_at)
values ($1, $2, now() + interval '1 hour');

-- name: GetPasswordResetUser :one
select t.id as token_id, u.id, u.email, u.name
from password_reset_tokens t
join users u on u.id = t.user_id
where t.token_hash = $1 and t.used_at is null and t.expires_at > now();

-- name: UsePasswordResetToken :exec
update password_reset_tokens set used_at = now() where id = $1;

-- name: UpdateUserPassword :exec
update users set password_hash = $2, updated_at = now() where id = $1;

-- name: DeleteAllSessions :exec
delete from sessions where user_id = $1;

-- name: RateLimitHit :one
insert into rate_limits (key, window_start, count)
values ($1, now(), 1)
on conflict (key) do update
set count = case
    when rate_limits.window_start + make_interval(secs => sqlc.arg(window_secs)::int) < now()
        then 1
    else rate_limits.count + 1
  end,
  window_start = case
    when rate_limits.window_start + make_interval(secs => sqlc.arg(window_secs)::int) < now()
        then now()
    else rate_limits.window_start
  end
returning count;
