-- +goose Up
-- Structured mentions: extracted from message bodies at post time so agents
-- and notifications know exactly which entities were referenced.
-- Shape: [{kind: user|agent|issue|gh|file, ref, label, id?, url?}]
alter table messages add column mentions jsonb not null default '[]'::jsonb;

-- +goose Down
alter table messages drop column mentions;
