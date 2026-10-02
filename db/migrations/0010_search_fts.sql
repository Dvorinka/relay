-- +goose Up
-- Full-text search indexes. plainto_tsquery at read time; generated
-- tsvectors aren't stored — the GIN index on the expression keeps writes cheap.
create index if not exists messages_fts_idx
  on messages using gin (to_tsvector('english', body))
  where deleted_at is null;

create index if not exists issues_fts_idx
  on issues using gin (to_tsvector('english', title || ' ' || description));

create index if not exists projects_fts_idx
  on projects using gin (to_tsvector('english', name || ' ' || description));

create index if not exists agent_todos_fts_idx
  on agent_todos using gin (to_tsvector('english', content));

-- +goose Down
drop index if exists messages_fts_idx;
drop index if exists issues_fts_idx;
drop index if exists projects_fts_idx;
drop index if exists agent_todos_fts_idx;
