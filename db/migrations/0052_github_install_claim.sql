-- +goose Up
-- Unbound GitHub App installs: the installation.created webhook carries no
-- Relay workspace context, so on a multi-tenant instance the server cannot
-- always know which workspace an install belongs to. NULL marks "unclaimed"
-- — a workspace admin claims it explicitly instead of the install silently
-- landing in whichever workspace was created first.
alter table github_installations alter column workspace_id drop not null;

-- +goose Down
delete from github_installations where workspace_id is null;
alter table github_installations alter column workspace_id set not null;
