-- +goose Up
-- Inbound hooks: token-secured endpoints that post into a channel.
-- External services (CI, deploy bots, monitoring) POST to
-- /api/hooks/<token>; Relay drops the payload into the target conversation
-- as a message authored by the hook's creator.

create table inbound_hooks (
    id              uuid primary key default gen_random_uuid(),
    project_id      uuid not null references projects(id) on delete cascade,
    conversation_id uuid not null references conversations(id) on delete cascade,
    name            text not null,
    -- sha256 of the bearer token; plaintext is only returned at create/rotate
    token_hash      text not null unique,
    enabled         boolean not null default true,
    created_by      uuid not null references users(id) on delete cascade,
    created_at      timestamptz not null default now(),
    last_used_at    timestamptz
);

create index inbound_hooks_project_idx on inbound_hooks (project_id);

-- +goose Down
drop table inbound_hooks;
