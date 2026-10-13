-- +goose Up
-- Ops/command-center intake: inbound-hook payloads can carry structured
-- data (service, state, latency_ms, level, env, fields…) that lands on
-- the message as jsonb `meta`. Null = a normal message; the web UI
-- renders meta-carrying posts as distinct cards and ops channels build
-- their status strip from them.
alter table messages add column meta jsonb;
create index messages_ops_meta_idx on messages (conversation_id, created_at)
    where meta is not null;

-- intake_mode gains 'ops': a receive-only channel whose surface is a
-- control-center view (service pills, uptime strip, alert feed).
alter table conversations drop constraint conversations_intake_mode_check;
alter table conversations add constraint conversations_intake_mode_check
    check (intake_mode in ('', 'receive', 'chat', 'ops'));

-- +goose Down
alter table conversations drop constraint conversations_intake_mode_check;
update conversations set intake_mode = 'receive' where intake_mode = 'ops';
alter table conversations add constraint conversations_intake_mode_check
    check (intake_mode in ('', 'receive', 'chat'));
drop index messages_ops_meta_idx;
alter table messages drop column meta;
