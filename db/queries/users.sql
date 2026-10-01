-- name: CreateUser :one
insert into users (email, password_hash, name)
values ($1, $2, $3)
returning id, email, name, created_at;

-- name: GetUserByEmail :one
select id, email, password_hash, name, avatar_key
from users
where lower(email) = lower($1);

-- name: GetUserByID :one
select id, email, name, avatar_key, created_at
from users
where id = $1;
