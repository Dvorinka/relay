-- +goose Up
-- Deleting an agent nulls author_agent_id / created_by_agent FKs, which erases
-- the author's name (and the "agent" kind) from every past message, thread and
-- brief. Snapshot name+kind onto those rows before the agent row disappears.
alter table messages
    add column if not exists author_name_snapshot text not null default '',
    add column if not exists author_kind_snapshot text not null default '';

alter table conversations
    add column if not exists creator_name_snapshot text not null default '';

alter table briefs
    add column if not exists creator_name_snapshot text not null default '';

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

create trigger agents_preserve_author
before delete on agents
for each row execute function preserve_agent_author();

-- +goose Down
drop trigger if exists agents_preserve_author on agents;
-- +goose StatementBegin
drop function if exists preserve_agent_author();
-- +goose StatementEnd
alter table messages
    drop column if exists author_name_snapshot,
    drop column if exists author_kind_snapshot;
alter table conversations
    drop column if exists creator_name_snapshot;
alter table briefs
    drop column if exists creator_name_snapshot;
