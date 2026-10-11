-- name: GetSMTPSettings :one
select * from smtp_settings where id = true;

-- name: UpsertSMTPSettings :one
-- narg(password_enc) null keeps the stored password — the settings form
-- only sends a password when the user rotates it.
insert into smtp_settings (id, host, port, username, password_enc, from_addr, from_name, enabled)
values (true, sqlc.arg(host), sqlc.arg(port), sqlc.arg(username),
        sqlc.narg(password_enc), sqlc.arg(from_addr), sqlc.arg(from_name), sqlc.arg(enabled))
on conflict (id) do update set
    host = excluded.host,
    port = excluded.port,
    username = excluded.username,
    password_enc = coalesce(excluded.password_enc, smtp_settings.password_enc),
    from_addr = excluded.from_addr,
    from_name = excluded.from_name,
    enabled = excluded.enabled,
    updated_at = now()
returning *;

-- name: ClearSMTPPassword :exec
update smtp_settings set password_enc = null, updated_at = now() where id = true;
