-- +goose Up
-- Extend the 0025 tombstone to todo attribution: agent_todos.agent_id goes
-- NULL on agent delete, so "last touched by <agent>" lost the name.
alter table agent_todos
    add column if not exists agent_name_snapshot text not null default '';

-- +goose StatementBegin
create or replace function preserve_agent_author() returns trigger as $$
begin
    update messages
       set author_name_snapshot = old.name,
           author_kind_snapshot = 'agent'
     where author_agent_id = old.id;
    update conversations
       set creator_name_snapshot = old.name
     where created_by_agent = old.id;
    update briefs
       set creator_name_snapshot = old.name
     where created_by_agent = old.id;
    update agent_todos
       set agent_name_snapshot = old.name
     where agent_id = old.id;
    return old;
end;
$$ language plpgsql;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
create or replace function preserve_agent_author() returns trigger as $$
begin
    update messages
       set author_name_snapshot = old.name,
           author_kind_snapshot = 'agent'
     where author_agent_id = old.id;
    update conversations
       set creator_name_snapshot = old.name
     where created_by_agent = old.id;
    update briefs
       set creator_name_snapshot = old.name
     where created_by_agent = old.id;
    return old;
end;
$$ language plpgsql;
-- +goose StatementEnd

alter table agent_todos drop column if exists agent_name_snapshot;
