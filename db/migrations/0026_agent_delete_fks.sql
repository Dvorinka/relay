-- +goose Up
-- DELETE /agents/:id failed with FK violations for any agent that had authored
-- messages, threads, briefs, issues, todos, activity or redeemed an invite —
-- these references were created (or recreated in 0016's messages rebuild) as
-- NO ACTION. Switch them to SET NULL; the 0025 tombstone trigger snapshots the
-- agent's name (and kind) before the row disappears.
-- The two single-author CHECKs are relaxed to accept a tombstoned author:
-- both ids null is only allowed when a snapshot carries the name.

alter table messages drop constraint messages_check;
alter table messages
    add constraint messages_check check (
        ((author_user_id is null) <> (author_agent_id is null))
        or author_name_snapshot <> '');

alter table messages drop constraint messages_author_agent_fkey;
alter table messages
    add constraint messages_author_agent_fkey foreign key (author_agent_id)
    references agents(id) on delete set null;

alter table conversations drop constraint conversations_created_by_agent_fkey;
alter table conversations
    add constraint conversations_created_by_agent_fkey foreign key (created_by_agent)
    references agents(id) on delete set null;

alter table briefs drop constraint briefs_check;
alter table briefs
    add constraint briefs_check check (
        created_by_user is not null or created_by_agent is not null
        or creator_name_snapshot <> '');

alter table briefs drop constraint briefs_created_by_agent_fkey;
alter table briefs
    add constraint briefs_created_by_agent_fkey foreign key (created_by_agent)
    references agents(id) on delete set null;

alter table issues drop constraint issues_agent_fkey;
alter table issues
    add constraint issues_agent_fkey foreign key (agent_id)
    references agents(id) on delete set null;

alter table issue_activity drop constraint issue_activity_agent_fkey;
alter table issue_activity
    add constraint issue_activity_agent_fkey foreign key (actor_agent_id)
    references agents(id) on delete set null;

alter table agent_invites drop constraint agent_invites_used_by_fkey;
alter table agent_invites
    add constraint agent_invites_used_by_fkey foreign key (used_by)
    references agents(id) on delete set null;

alter table agent_todos drop constraint agent_todos_agent_id_fkey;
alter table agent_todos
    add constraint agent_todos_agent_id_fkey foreign key (agent_id)
    references agents(id) on delete set null;

-- +goose Down
alter table agent_todos drop constraint agent_todos_agent_id_fkey;
alter table agent_todos
    add constraint agent_todos_agent_id_fkey foreign key (agent_id)
    references agents(id) on delete no action;

alter table agent_invites drop constraint agent_invites_used_by_fkey;
alter table agent_invites
    add constraint agent_invites_used_by_fkey foreign key (used_by)
    references agents(id) on delete no action;

alter table issue_activity drop constraint issue_activity_agent_fkey;
alter table issue_activity
    add constraint issue_activity_agent_fkey foreign key (actor_agent_id)
    references agents(id) on delete no action;

alter table issues drop constraint issues_agent_fkey;
alter table issues
    add constraint issues_agent_fkey foreign key (agent_id)
    references agents(id) on delete no action;

alter table briefs drop constraint briefs_created_by_agent_fkey;
alter table briefs
    add constraint briefs_created_by_agent_fkey foreign key (created_by_agent)
    references agents(id) on delete no action;
alter table briefs drop constraint briefs_check;
alter table briefs
    add constraint briefs_check check (created_by_user is not null or created_by_agent is not null);

alter table conversations drop constraint conversations_created_by_agent_fkey;
alter table conversations
    add constraint conversations_created_by_agent_fkey foreign key (created_by_agent)
    references agents(id) on delete no action;

alter table messages drop constraint messages_author_agent_fkey;
alter table messages
    add constraint messages_author_agent_fkey foreign key (author_agent_id)
    references agents(id) on delete no action;
alter table messages drop constraint messages_check;
alter table messages
    add constraint messages_check check ((author_user_id is null) <> (author_agent_id is null));
