-- +goose Up
-- Support-intake channels: an inbound-hook-backed channel flagged so the
-- UI shows the intake setup guide and a support badge.
alter table conversations add column intake boolean not null default false;

-- +goose Down
alter table conversations drop column intake;
