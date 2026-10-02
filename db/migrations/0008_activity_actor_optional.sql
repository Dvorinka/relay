-- +goose Up
-- GitHub/webhook events have no user or agent actor. Allow system entries.
alter table issue_activity drop constraint if exists issue_activity_check;
alter table issue_activity
    add constraint issue_activity_actor_check
    check (num_nonnulls(actor_user_id, actor_agent_id) <= 1);

-- +goose Down
delete from issue_activity where actor_user_id is null and actor_agent_id is null;
alter table issue_activity drop constraint if exists issue_activity_actor_check;
alter table issue_activity
    add constraint issue_activity_check
    check (num_nonnulls(actor_user_id, actor_agent_id) = 1);
