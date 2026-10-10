-- name: GetLinkPreview :one
select * from link_previews
where url = sqlc.arg(url) and fetched_at > now() - interval '7 days';

-- name: UpsertLinkPreview :exec
insert into link_previews (url, title, description, image_url, site_name, failed_at)
values (sqlc.arg(url), sqlc.arg(title), sqlc.arg(description), sqlc.arg(image_url), sqlc.arg(site_name), sqlc.narg(failed_at))
on conflict (url) do update set
    title = excluded.title,
    description = excluded.description,
    image_url = excluded.image_url,
    site_name = excluded.site_name,
    failed_at = excluded.failed_at,
    fetched_at = now();
