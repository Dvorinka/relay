-- +goose Up
-- Bulk GitHub import: PRs join issues as first-class rows. github_kind
-- distinguishes them; github_state keeps GitHub's raw state (merged vs
-- closed matters for PRs); github_url links back without rebuilding it.

alter table issues add column github_kind text not null default 'issue'
    check (github_kind in ('issue', 'pr'));
alter table issues add column github_state text;
alter table issues add column github_url text;

-- +goose Down
alter table issues drop column github_url;
alter table issues drop column github_state;
alter table issues drop column github_kind;
