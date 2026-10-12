-- +goose Up
-- Multi-use agent invites: one rli_ token can onboard several agents.
-- max_uses 1 preserves the original one-shot behavior.
alter table agent_invites
  add column max_uses int not null default 1,
  add column use_count int not null default 0;

-- +goose Down
alter table agent_invites
  drop column max_uses,
  drop column use_count;
