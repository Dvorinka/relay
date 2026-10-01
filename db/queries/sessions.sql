-- name: CreateSession :one
insert into sessions (user_id, token_hash, expires_at, ip, user_agent)
values ($1, $2, $3, $4, $5)
returning id;

-- name: GetSessionUser :one
select s.id as session_id, s.expires_at, s.last_seen_at,
       u.id, u.email, u.name, u.avatar_key, u.created_at
from sessions s
join users u on u.id = s.user_id
where s.token_hash = $1 and s.expires_at > now();

-- name: TouchSession :exec
update sessions
set last_seen_at = now(), expires_at = now() + make_interval(secs => sqlc.arg(ttl_secs)::int)
where token_hash = $1;

-- name: DeleteSession :exec
delete from sessions where token_hash = $1;

-- name: DeleteOtherSessions :exec
delete from sessions where user_id = $1 and token_hash <> $2;
