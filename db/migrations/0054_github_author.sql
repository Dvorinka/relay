-- +goose Up
-- Mirrored GitHub issues/PRs remember who filed them — the mirror upsert
-- refreshes these on every write, so the reconcile sweep backfills them.
alter table issues add column github_author text;
alter table issues add column github_avatar_url text;

-- +goose Down
alter table issues drop column github_avatar_url;
alter table issues drop column github_author;
