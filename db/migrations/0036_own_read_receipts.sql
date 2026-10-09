-- +goose Up
-- Purge self-read receipts: an author is never one of their own readers,
-- and showing "seen by <author>" on their own post is noise. Insert paths
-- now exclude them; this removes the ones already written.
delete from message_reads r
using messages m
where r.message_id = m.id
  and (
    (r.agent_id is not null and r.agent_id = m.author_agent_id)
    or (r.user_id is not null and r.user_id = m.author_user_id)
  );

-- +goose Down
-- Deleted self-receipts cannot be restored (read_at is gone).
select 1;
