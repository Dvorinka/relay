-- +goose Up
-- Inbound-hook customization: 'kind' is the hook's default report type
-- (payload "kind" overrides it; lands as a kind:<x> tag + colored chip),
-- 'header_template' shapes the rendered head line — {from} {subject}
-- {kind} {key} placeholders, empty = the default "**from** — *subject*".
alter table inbound_hooks
  add column kind text not null default '',
  add column header_template text not null default '';

-- +goose Down
alter table inbound_hooks drop column kind, drop column header_template;
