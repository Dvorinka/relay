-- +goose Up
-- Workspace SMTP settings (in-app alternative to SMTP_* env) and per-channel
-- email alert lists. password_enc is AES-256-GCM under sha256(AUTH_SECRET),
-- same protection as the GitHub App secrets.
create table smtp_settings (
    id boolean primary key default true check (id),
    host text not null,
    port int not null,
    username text not null default '',
    password_enc bytea,
    from_addr text not null,
    from_name text not null default '',
    enabled boolean not null default true,
    updated_at timestamptz not null default now()
);

alter table conversations
    add column email_alerts text[] not null default '{}';

-- +goose Down
alter table conversations drop column email_alerts;
drop table smtp_settings;
