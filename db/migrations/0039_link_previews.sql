-- +goose Up
-- Link preview cache: OG metadata for URLs that appear in messages, fetched
-- lazily by the unfurl endpoint and keyed by URL. failed_at records a fetch
-- that produced no usable metadata so error pages aren't retried eagerly.
create table link_previews (
    url          text primary key,
    title        text not null default '',
    description  text not null default '',
    image_url    text not null default '',
    site_name    text not null default '',
    fetched_at   timestamptz not null default now(),
    failed_at    timestamptz
);
create index link_previews_fetched_idx on link_previews (fetched_at);

-- +goose Down
drop table link_previews;
