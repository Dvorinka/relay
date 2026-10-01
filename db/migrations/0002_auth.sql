-- +goose Up
-- Password reset tokens and fixed-window rate limiting (Postgres counters,
-- no cache dependency in v1).

create table password_reset_tokens (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null references users(id) on delete cascade,
    token_hash text not null unique,
    expires_at timestamptz not null,
    used_at    timestamptz,
    created_at timestamptz not null default now()
);
create index password_reset_tokens_user_id_idx on password_reset_tokens (user_id);

create table rate_limits (
    key          text primary key,
    window_start timestamptz not null,
    count        integer not null default 0
);

-- +goose Down
drop table rate_limits;
drop table password_reset_tokens;
