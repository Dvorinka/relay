-- +goose Up
-- Digest mode: when a user opts in, individual web pushes park in
-- push_digests instead; the sweep bundles them into one periodic summary.
alter table users add column digest_enabled boolean not null default false;

create table push_digests (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null references users(id) on delete cascade,
    title      text not null,
    body       text not null default '',
    url        text not null default '',
    created_at timestamptz not null default now(),
    flushed_at timestamptz
);
create index push_digests_pending_idx on push_digests (user_id) where flushed_at is null;

-- +goose Down
drop table push_digests;
alter table users drop column digest_enabled;
