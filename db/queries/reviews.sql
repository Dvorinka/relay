-- name: CreateReview :one
insert into agent_reviews (project_id, issue_id, agent_id, title, summary,
                           files, decisions, actions, links, verify, supersedes)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
returning *;

-- name: GetReview :one
select r.*, a.name as agent_name, a.slug as agent_slug, a.avatar_key as agent_avatar,
       p.key as project_key, i.number as issue_number,
       u.name as responder_name, u.avatar_key as responder_avatar
from agent_reviews r
join agents a on a.id = r.agent_id
join projects p on p.id = r.project_id
left join issues i on i.id = r.issue_id
left join users u on u.id = r.responded_by
where r.id = $1;

-- name: ListProjectReviews :many
select r.*, a.name as agent_name, a.slug as agent_slug, a.avatar_key as agent_avatar,
       p.key as project_key, i.number as issue_number,
       u.name as responder_name, u.avatar_key as responder_avatar
from agent_reviews r
join agents a on a.id = r.agent_id
join projects p on p.id = r.project_id
left join issues i on i.id = r.issue_id
left join users u on u.id = r.responded_by
where r.project_id = sqlc.arg(project_id)
  and r.status = coalesce(sqlc.narg(status)::text, r.status)
order by r.created_at desc
limit sqlc.arg(lim);

-- name: ListIssueReviews :many
select r.*, a.name as agent_name, a.slug as agent_slug, a.avatar_key as agent_avatar,
       p.key as project_key, i.number as issue_number,
       u.name as responder_name, u.avatar_key as responder_avatar
from agent_reviews r
join agents a on a.id = r.agent_id
join projects p on p.id = r.project_id
left join issues i on i.id = r.issue_id
left join users u on u.id = r.responded_by
where r.issue_id = $1
order by r.created_at desc;

-- name: ReviewProjectMembership :one
-- does user X belong to the workspace owning review Y's project?
select wm.role
from agent_reviews r
join projects p on p.id = r.project_id
join workspace_members wm on wm.workspace_id = p.workspace_id and wm.user_id = $2
where r.id = $1;

-- name: ReviewAgentProject :one
-- the review's project + the agent's review_mode, for MCP auth + gating
select r.project_id, a.review_mode
from agent_reviews r
join agents a on a.id = r.agent_id
where r.id = $1;

-- name: RespondToReview :one
-- human verdict. Only pending reviews can be answered.
update agent_reviews
set status = $2, responded_by = $3, response = $4,
    responded_at = now(), updated_at = now()
where id = $1 and status = 'pending'
returning *;

-- name: SupersedeReview :exec
-- a resubmission retires the previous pending review
update agent_reviews
set status = 'superseded', updated_at = now()
where id = $1 and status = 'pending';

-- name: GetAgentReviewMode :one
select review_mode from agents where id = $1;

-- name: PendingReviewCount :one
select count(*)::int from agent_reviews
where project_id = $1 and status = 'pending';

-- name: PendingReviewCounts :many
-- per-project count of reviews awaiting a human verdict
select p.id as project_id, count(r.id)::int as pending
from projects p
join workspace_members wm on wm.workspace_id = p.workspace_id
  and wm.user_id = $1
join agent_reviews r on r.project_id = p.id and r.status = 'pending'
group by p.id;

-- name: ListMyPendingReviews :many
-- reviews awaiting a human verdict across every workspace the user belongs to
select r.id, r.project_id, r.title, r.created_at,
       a.id as agent_id, a.name as agent_name, a.slug as agent_slug, a.avatar_key as agent_avatar,
       p.key as project_key, p.name as project_name
from agent_reviews r
join agents a on a.id = r.agent_id
join projects p on p.id = r.project_id
join workspace_members wm on wm.workspace_id = p.workspace_id and wm.user_id = $1
where r.status = 'pending'
order by r.created_at desc
limit 50;
