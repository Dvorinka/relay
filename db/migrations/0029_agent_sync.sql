-- +goose Up
-- Live agent↔app sync: todo status (todo|in_progress|done) so a harness task
-- list mirrors faithfully, and silent messages so agents can post progress
-- updates into threads without fanning out notifications.
alter table agent_todos
    add column status text not null default 'todo'
        check (status in ('todo', 'in_progress', 'done'));

update agent_todos set status = 'done' where done;

alter table messages
    add column silent boolean not null default false;

-- +goose Down
alter table agent_todos drop column if exists status;
alter table messages drop column if exists silent;
