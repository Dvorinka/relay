-- +goose Up
-- Outbound event subscriptions: Relay -> subscriber URL. Agents or external
-- services register an HTTPS endpoint and receive signed POSTs for the
-- project events they subscribe to.

create table webhook_subscriptions (
    id          uuid primary key default gen_random_uuid(),
    project_id  uuid not null references projects(id) on delete cascade,
    url         text not null,
    secret      text not null,              -- HMAC-SHA256 signing key
    events      text[] not null,            -- exact types or 'prefix.*'
    active      boolean not null default true,
    created_by  uuid references users(id) on delete set null,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create index webhook_subscriptions_project_idx on webhook_subscriptions (project_id) where active;

create table webhook_deliveries (
    id              uuid primary key default gen_random_uuid(),
    subscription_id uuid not null references webhook_subscriptions(id) on delete cascade,
    delivery_id     uuid not null default gen_random_uuid(),
    event_type      text not null,
    payload         jsonb not null,
    status_code     integer,
    attempts        integer not null default 0,
    duration_ms     integer not null default 0,
    success         boolean not null default false,
    created_at      timestamptz not null default now()
);
create index webhook_deliveries_sub_idx on webhook_deliveries (subscription_id, created_at desc);

-- +goose Down
drop table if exists webhook_deliveries;
drop table if exists webhook_subscriptions;
