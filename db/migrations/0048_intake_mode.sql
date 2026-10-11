-- +goose Up
-- Intake channels get a mode: 'receive' (reports land, nothing leaves)
-- or 'chat' (the hook token can also read the channel — live support
-- chat over GET /api/hooks/<token>/messages). '' means not an intake
-- channel. Existing intake flags become 'receive'.
alter table conversations add column intake_mode text not null default '';
alter table conversations add constraint conversations_intake_mode_check
  check (intake_mode in ('', 'receive', 'chat'));
update conversations set intake_mode = 'receive' where intake;
alter table conversations drop column intake;

-- +goose Down
alter table conversations add column intake boolean not null default false;
update conversations set intake = true where intake_mode <> '';
alter table conversations drop column intake_mode;
