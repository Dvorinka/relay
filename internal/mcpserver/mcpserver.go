// Package mcpserver exposes the Relay MCP endpoint: streamable HTTP at
// /mcp, authenticated by rly_ bearer tokens, every tool gated by the
// token's per-project scope grant.
package mcpserver

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"go.uber.org/zap"

	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/events"
	"github.com/Dvorinka/relay/internal/github"
	"github.com/Dvorinka/relay/internal/localfiles"
	"github.com/Dvorinka/relay/internal/push"
	"github.com/Dvorinka/relay/internal/storage"
)

const requestsPerMinute = 120

type ctxKey int

const agentKey ctxKey = iota

// Agent is the authenticated caller carried through the request context.
type Agent struct {
	ID         pgtype.UUID
	TokenID    pgtype.UUID
	Name       string
	AvatarKey  pgtype.Text
	ReviewMode string
}

// Service wires tools to the database and object storage.
type Service struct {
	q     *db.Queries
	store *storage.Store
	gh    *github.Service
	log   *zap.Logger
	// Bus publishes domain events for SSE subscribers. Optional.
	Bus *events.Hub
	// Push fans out web-push notifications. Optional.
	Push *push.Service

	mu      sync.Mutex
	windows map[[16]byte]time.Time // token id -> current minute window start
	counts  map[[16]byte]int
}

// New builds the gin handler for POST /mcp. It performs bearer auth,
// rate limiting, and last_used_at bookkeeping, then hands the request
// to the mcp-go streamable HTTP transport.
func New(q *db.Queries, store *storage.Store, log *zap.Logger, gh *github.Service, hub *events.Hub, pushSvc *push.Service) gin.HandlerFunc {
	s := &Service{
		q: q, store: store, gh: gh, log: log, Bus: hub, Push: pushSvc,
		windows: make(map[[16]byte]time.Time),
		counts:  make(map[[16]byte]int),
	}

	mcpSrv := server.NewMCPServer("relay", "0.1.0",
		server.WithToolCapabilities(true))
	s.registerTools(mcpSrv)

	httpSrv := server.NewStreamableHTTPServer(mcpSrv)

	return func(c *gin.Context) {
		agent, err := s.authenticate(c)
		if err != nil {
			jsonRPCError(c.Writer, "unauthorized: "+err.Error(), -32001)
			return
		}
		if !s.allow(agent.TokenID) {
			jsonRPCError(c.Writer, "rate limit exceeded", -32001)
			return
		}
		// last_used_at reflects real MCP traffic only
		if err := s.q.TouchMcpToken(c.Request.Context(), agent.TokenID); err != nil {
			s.log.Warn("touch mcp token", zap.Error(err))
		}
		c.Request = c.Request.WithContext(
			context.WithValue(c.Request.Context(), agentKey, agent))
		httpSrv.ServeHTTP(c.Writer, c.Request)
	}
}

func jsonRPCError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(gin.H{
		"jsonrpc": "2.0",
		"error":   gin.H{"code": code, "message": msg},
		"id":      nil,
	})
}

func (s *Service) authenticate(c *gin.Context) (*Agent, error) {
	h := c.GetHeader("Authorization")
	if !strings.HasPrefix(h, "Bearer rly_") {
		return nil, errors.New("missing bearer token")
	}
	sum := sha256.Sum256([]byte(strings.TrimPrefix(h, "Bearer ")))
	row, err := s.q.GetTokenAgent(c.Request.Context(), sum[:])
	if err != nil {
		return nil, errors.New("invalid or revoked token")
	}
	return &Agent{ID: row.ID, TokenID: row.TokenID, Name: row.Name, AvatarKey: row.AvatarKey,
		ReviewMode: row.ReviewMode}, nil
}

// allow implements a fixed 1-minute window per token. Cheap and correct;
// swap for a sliding window if bursts need smoothing.
func (s *Service) allow(tokenID pgtype.UUID) bool {
	key := tokenID.Bytes
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	start, ok := s.windows[key]
	if !ok || now.Sub(start) >= time.Minute {
		s.windows[key] = now
		s.counts[key] = 0
	}
	s.counts[key]++
	return s.counts[key] <= requestsPerMinute
}

func agent(ctx context.Context) *Agent {
	a, _ := ctx.Value(agentKey).(*Agent)
	return a
}

func uuidArg(req mcp.CallToolRequest, name string) (pgtype.UUID, error) {
	v, err := req.RequireString(name)
	if err != nil {
		return pgtype.UUID{}, err
	}
	var id pgtype.UUID
	if err := id.Scan(v); err != nil || !id.Valid {
		return pgtype.UUID{}, errors.New("invalid " + name)
	}
	return id, nil
}

// scope resolves the agent's grant for a project and verifies it covers
// the required scope. An absent grant or missing scope is a hard deny.
func (s *Service) scope(ctx context.Context, projectID pgtype.UUID, required string) error {
	scopes, err := s.q.AgentScopeForProject(ctx, db.AgentScopeForProjectParams{
		ProjectID: projectID,
		AgentID:   agent(ctx).ID,
	})
	if err != nil {
		return errors.New("no grant for this project")
	}
	if !hasScope(scopes, required) {
		return errors.New("missing scope: " + required)
	}
	return nil
}

func hasScope(granted []string, required string) bool {
	for _, s := range granted {
		if s == required {
			return true
		}
	}
	return false
}

func errResult(err error) (*mcp.CallToolResult, error) {
	if errors.Is(err, pgx.ErrNoRows) {
		return mcp.NewToolResultError("not found or not granted"), nil
	}
	return mcp.NewToolResultError(err.Error()), nil
}

func jsonResult(v any) (*mcp.CallToolResult, error) {
	r, err := mcp.NewToolResultJSON(v)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	return r, nil
}

func (s *Service) registerTools(srv *server.MCPServer) {
	srv.AddTool(mcp.NewTool("list_projects",
		mcp.WithDescription("List the projects this agent has been granted access to."),
	), s.listProjects)

	srv.AddTool(mcp.NewTool("get_project",
		mcp.WithDescription("Get one granted project's details."),
		mcp.WithString("project_id", mcp.Required(), mcp.Description("Project UUID")),
	), s.getProject)

	srv.AddTool(mcp.NewTool("list_conversations",
		mcp.WithDescription("List conversations in a granted project."),
		mcp.WithString("project_id", mcp.Required()),
	), s.listConversations)

	srv.AddTool(mcp.NewTool("get_messages",
		mcp.WithDescription("List messages in a conversation (newest first)."),
		mcp.WithString("conversation_id", mcp.Required()),
		mcp.WithNumber("limit", mcp.Description("Max messages, default 50, cap 200")),
	), s.getMessages)

	srv.AddTool(mcp.NewTool("get_message",
		mcp.WithDescription("Get one message by id."),
		mcp.WithString("message_id", mcp.Required()),
	), s.getMessage)

	srv.AddTool(mcp.NewTool("get_attachment",
		mcp.WithDescription("Get an attachment's metadata and a short-lived download URL."),
		mcp.WithString("attachment_id", mcp.Required()),
	), s.getAttachment)

	srv.AddTool(mcp.NewTool("search_messages",
		mcp.WithDescription("Full-text-ish search (case-insensitive substring) over a project's messages."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithString("query", mcp.Required()),
		mcp.WithNumber("limit", mcp.Description("Max results, default 20, cap 100")),
	), s.searchMessages)

	srv.AddTool(mcp.NewTool("list_issues",
		mcp.WithDescription("List issues in a granted project."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithNumber("limit", mcp.Description("Max issues, default 50, cap 200")),
	), s.listIssues)

	srv.AddTool(mcp.NewTool("get_issue",
		mcp.WithDescription("Get one issue by id."),
		mcp.WithString("issue_id", mcp.Required()),
	), s.getIssue)

	srv.AddTool(mcp.NewTool("send_message",
		mcp.WithDescription("Post a message as this agent. Give project_id to post in the project's main thread, or conversation_id to reply in a specific conversation. Pass reply_to (a message id) to thread the reply under that message."),
		mcp.WithString("project_id"),
		mcp.WithString("conversation_id"),
		mcp.WithString("body", mcp.Required(), mcp.Description("Markdown body")),
		mcp.WithString("reply_to", mcp.Description("Message UUID this message replies to")),
	), s.sendMessage)

	srv.AddTool(mcp.NewTool("edit_message",
		mcp.WithDescription("Edit one of this agent's own messages. Allowed only while no agent has read it."),
		mcp.WithString("message_id", mcp.Required()),
		mcp.WithString("body", mcp.Required(), mcp.Description("New markdown body")),
	), s.editMessage)

	srv.AddTool(mcp.NewTool("react_to_message",
		mcp.WithDescription("Toggle an emoji reaction on a message."),
		mcp.WithString("message_id", mcp.Required()),
		mcp.WithString("emoji", mcp.Required(), mcp.Description("e.g. 👀 ✅ 🎉")),
	), s.reactToMessage)

	srv.AddTool(mcp.NewTool("set_avatar",
		mcp.WithDescription("Set this agent's profile picture. Accepts a base64-encoded png/jpeg/gif/webp image, max 2 MiB decoded."),
		mcp.WithString("image_base64", mcp.Required(), mcp.Description("Base64-encoded image bytes")),
	), s.setAvatar)

	srv.AddTool(mcp.NewTool("create_issue",
		mcp.WithDescription("Create an issue in a granted project."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithString("title", mcp.Required()),
		mcp.WithString("description"),
		mcp.WithString("priority", mcp.Description("none|low|medium|high|urgent")),
	), s.createIssue)

	srv.AddTool(mcp.NewTool("update_issue",
		mcp.WithDescription("Update an issue's title/description/status/priority."),
		mcp.WithString("issue_id", mcp.Required()),
		mcp.WithString("title"),
		mcp.WithString("description"),
		mcp.WithString("status", mcp.Description("backlog|todo|in_progress|review|done|cancelled")),
		mcp.WithString("priority", mcp.Description("none|low|medium|high|urgent")),
	), s.updateIssue)

	srv.AddTool(mcp.NewTool("github_list_issues",
		mcp.WithDescription("List open GitHub issues on the project's linked repository."),
		mcp.WithString("project_id", mcp.Required()),
	), s.ghListIssues)

	srv.AddTool(mcp.NewTool("github_get_issue",
		mcp.WithDescription("Get one GitHub issue (with body) from the project's linked repository."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithNumber("number", mcp.Required()),
	), s.ghGetIssue)

	srv.AddTool(mcp.NewTool("github_list_prs",
		mcp.WithDescription("List open pull requests on the project's linked repository."),
		mcp.WithString("project_id", mcp.Required()),
	), s.ghListPRs)

	srv.AddTool(mcp.NewTool("github_get_pr",
		mcp.WithDescription("Get one pull request from the project's linked repository."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithNumber("number", mcp.Required()),
	), s.ghGetPR)

	srv.AddTool(mcp.NewTool("list_project_files",
		mcp.WithDescription("List one directory level of the project's linked local folder. Omit path for the root."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithString("path"),
	), s.listProjectFiles)

	srv.AddTool(mcp.NewTool("read_project_file",
		mcp.WithDescription("Read a UTF-8 file (<=256KB) from the project's linked local folder."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithString("path", mcp.Required()),
	), s.readProjectFile)

	srv.AddTool(mcp.NewTool("todo_list",
		mcp.WithDescription("List the project's todo/work-tracking list (agent-managed)."),
		mcp.WithString("project_id", mcp.Required()),
	), s.todoList)

	srv.AddTool(mcp.NewTool("todo_add",
		mcp.WithDescription("Add a todo item to the project's work list. Optionally link an issue_id."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithString("content", mcp.Required()),
		mcp.WithString("issue_id"),
	), s.todoAdd)

	srv.AddTool(mcp.NewTool("todo_update",
		mcp.WithDescription("Update a todo: content, done flag, or linked issue."),
		mcp.WithString("todo_id", mcp.Required()),
		mcp.WithString("content"),
		mcp.WithBoolean("done"),
		mcp.WithString("issue_id"),
	), s.todoUpdate)

	srv.AddTool(mcp.NewTool("todo_delete",
		mcp.WithDescription("Delete a todo item."),
		mcp.WithString("todo_id", mcp.Required()),
	), s.todoDelete)

	srv.AddTool(mcp.NewTool("mark_message_read",
		mcp.WithDescription("Mark a message as read by this agent."),
		mcp.WithString("message_id", mcp.Required()),
	), s.markRead)

	// --- work reviews ---
	// Review payloads follow a fixed schema so the web UI can render a
	// consistent board: summary, per-file changes, autonomous decisions,
	// required human actions, verification steps, links.

	srv.AddTool(mcp.NewTool("submit_review",
		mcp.WithDescription("Submit a structured review of completed work for human approval. "+
			"Required fields: project_id, title, summary. Provide files as [{path,status,additions,deletions,note}] "+
			"(status: added|modified|deleted|renamed; optional patch), decisions as [{decision,rationale}], "+
			"actions as [{kind: env|config|deploy|ci|secret|migration|other, label, detail}] for anything the human "+
			"must change (new env vars, deploy steps, CI tweaks), links as [{label,url}], and a short 'verify' "+
			"markdown explaining how to confirm the change works. The response includes review_mode: when 'gate', "+
			"call await_review and wait for the verdict before continuing; when 'notify', the review is informational."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithString("issue_id", mcp.Description("Linked Relay issue UUID")),
		mcp.WithString("title", mcp.Required(), mcp.Description("One-line title, <= 200 chars")),
		mcp.WithString("summary", mcp.Required(), mcp.Description("Plain-language markdown summary of what changed and why")),
		mcp.WithArray("files", mcp.Items(map[string]any{"type": "object"}),
			mcp.Description("[{path, status, additions, deletions, note, patch?}]")),
		mcp.WithArray("decisions", mcp.Items(map[string]any{"type": "object"}),
			mcp.Description("[{decision, rationale}] - choices made autonomously")),
		mcp.WithArray("actions", mcp.Items(map[string]any{"type": "object"}),
			mcp.Description("[{kind: env|config|deploy|ci|secret|migration|other, label, detail}] - required human follow-ups")),
		mcp.WithArray("links", mcp.Items(map[string]any{"type": "object"}),
			mcp.Description("[{label, url}] - PRs, commits, CI runs")),
		mcp.WithString("verify", mcp.Description("Markdown: how to verify the change works")),
		mcp.WithString("supersedes", mcp.Description("Review UUID this revision replaces")),
	), s.submitReview)

	srv.AddTool(mcp.NewTool("get_review",
		mcp.WithDescription("Get one review with its status and any human response."),
		mcp.WithString("review_id", mcp.Required()),
	), s.getReview)

	srv.AddTool(mcp.NewTool("list_reviews",
		mcp.WithDescription("List reviews in a granted project, newest first."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithString("status", mcp.Description("Filter: pending|approved|changes_requested|superseded")),
	), s.listReviews)

	srv.AddTool(mcp.NewTool("await_review",
		mcp.WithDescription("Block until a review gets a human verdict (approved or changes_requested), "+
			"or timeout_s elapses. Use after submit_review when review_mode is 'gate'. Returns the review "+
			"with its final status and the responder's note."),
		mcp.WithString("review_id", mcp.Required()),
		mcp.WithNumber("timeout_s", mcp.Description("Max wait, default 60, cap 300")),
	), s.awaitReview)
}

func messageJSON(m db.GetMessageFullRow) gin.H {
	var editedAt any
	if m.EditedAt.Valid {
		editedAt = m.EditedAt.Time
	}
	var avatar any
	if m.AuthorAvatar.Valid {
		avatar = "/api/files/" + m.AuthorAvatar.String
	}
	var parent any
	if m.ParentID.Valid {
		preview := m.ParentBody.String
		if m.ParentDeleted.Bool {
			preview = ""
		} else if len([]rune(preview)) > 160 {
			preview = string([]rune(preview)[:160]) + "…"
		}
		parent = gin.H{
			"id":      m.ParentID.String(),
			"author":  m.ParentAuthorName,
			"preview": preview,
			"deleted": m.ParentDeleted.Bool,
		}
	}
	return gin.H{
		"id":              m.ID,
		"conversation_id": m.ConversationID,
		"body":            m.Body,
		"parent":          parent,
		"created_at":      m.CreatedAt.Time,
		"edited_at":       editedAt,
		"author": gin.H{
			"kind":   authorKind(m),
			"id":     firstValid(m.AuthorUserID, m.AuthorAgentID),
			"name":   m.AuthorName,
			"avatar": avatar,
		},
	}
}

func authorKind(m db.GetMessageFullRow) string {
	if m.AuthorAgentID.Valid {
		return "agent"
	}
	return "user"
}

func firstValid(ids ...pgtype.UUID) any {
	for _, id := range ids {
		if id.Valid {
			return id
		}
	}
	return nil
}

func (s *Service) listProjects(ctx context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	rows, err := s.q.ListGrantedProjects(ctx, agent(ctx).ID)
	if err != nil {
		return errResult(err)
	}
	out := make([]gin.H, 0, len(rows))
	for _, p := range rows {
		out = append(out, gin.H{
			"id": p.ID, "key": p.Key, "name": p.Name, "description": p.Description,
		})
	}
	return jsonResult(out)
}

func (s *Service) getProject(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	pid, err := uuidArg(req, "project_id")
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "project:read"); err != nil {
		return errResult(err)
	}
	p, err := s.q.GetProjectByID(ctx, pid)
	if err != nil {
		return errResult(err)
	}
	return jsonResult(gin.H{
		"id": p.ID, "key": p.Key, "name": p.Name,
		"description": p.Description, "workspace_id": p.WorkspaceID,
		"review_mode": agent(ctx).ReviewMode,
	})
}

func (s *Service) listConversations(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	pid, err := uuidArg(req, "project_id")
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "message:read"); err != nil {
		return errResult(err)
	}
	rows, err := s.q.ListProjectConversations(ctx, pid)
	if err != nil {
		return errResult(err)
	}
	out := make([]gin.H, 0, len(rows))
	for _, c := range rows {
		out = append(out, gin.H{
			"id": c.ID, "kind": c.Kind, "issue_id": c.IssueID, "created_at": c.CreatedAt.Time,
		})
	}
	return jsonResult(out)
}

func (s *Service) getMessages(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	cid, err := uuidArg(req, "conversation_id")
	if err != nil {
		return errResult(err)
	}
	pid, err := s.q.ResolveConversationProject(ctx, cid)
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "message:read"); err != nil {
		return errResult(err)
	}
	lim := clampInt(req.GetInt("limit", 50), 1, 200)
	rows, err := s.q.ListMessages(ctx, db.ListMessagesParams{
		ConversationID: cid, Lim: int32(lim),
	})
	if err != nil {
		return errResult(err)
	}
	// fetching is the agent's read receipt - it is what locks user edits
	ids := make([]pgtype.UUID, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.ID)
	}
	if err := s.q.MarkMessagesReadAgent(ctx, db.MarkMessagesReadAgentParams{
		AgentID: agent(ctx).ID, Ids: ids,
	}); err != nil {
		s.log.Warn("mark agent read", zap.Error(err))
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, messageJSON(db.GetMessageFullRow(r)))
	}
	return jsonResult(out)
}

func (s *Service) getMessage(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	mid, err := uuidArg(req, "message_id")
	if err != nil {
		return errResult(err)
	}
	pid, err := s.q.ResolveMessageProject(ctx, mid)
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "message:read"); err != nil {
		return errResult(err)
	}
	m, err := s.q.GetMessageFull(ctx, mid)
	if err != nil {
		return errResult(err)
	}
	_ = s.q.MarkMessageReadAgent(ctx, db.MarkMessageReadAgentParams{
		MessageID: mid, AgentID: agent(ctx).ID,
	})
	return jsonResult(messageJSON(m))
}

func (s *Service) getAttachment(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	aid, err := uuidArg(req, "attachment_id")
	if err != nil {
		return errResult(err)
	}
	pid, err := s.q.ResolveAttachmentProject(ctx, aid)
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "attachment:read"); err != nil {
		return errResult(err)
	}
	a, err := s.q.GetAttachmentByID(ctx, aid)
	if err != nil {
		return errResult(err)
	}
	if s.store == nil {
		return mcp.NewToolResultError("storage not configured"), nil
	}
	url, err := s.store.PresignGet(ctx, a.StorageKey, a.Filename, a.ContentType)
	if err != nil {
		return errResult(err)
	}
	return jsonResult(gin.H{
		"id": a.ID, "filename": a.Filename, "content_type": a.ContentType,
		"size_bytes": a.SizeBytes, "download_url": url,
	})
}

func (s *Service) searchMessages(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	pid, err := uuidArg(req, "project_id")
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "message:read"); err != nil {
		return errResult(err)
	}
	q, err := req.RequireString("query")
	if err != nil {
		return errResult(err)
	}
	lim := clampInt(req.GetInt("limit", 20), 1, 100)
	rows, err := s.q.SearchMessagesInProject(ctx, db.SearchMessagesInProjectParams{
		ProjectID: pid, Q: pgtype.Text{String: q, Valid: true}, Lim: int32(lim),
	})
	if err != nil {
		return errResult(err)
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, gin.H{
			"id": r.ID, "conversation_id": r.ConversationID, "body": r.Body,
			"created_at": r.CreatedAt.Time, "author_name": r.AuthorName,
		})
	}
	return jsonResult(out)
}

func (s *Service) listIssues(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	pid, err := uuidArg(req, "project_id")
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "issue:read"); err != nil {
		return errResult(err)
	}
	lim := clampInt(req.GetInt("limit", 50), 1, 200)
	rows, err := s.q.ListProjectIssuesForAgent(ctx, db.ListProjectIssuesForAgentParams{
		ProjectID: pid, Lim: int32(lim),
	})
	if err != nil {
		return errResult(err)
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, issueJSON(issueFromRow(r), r.AssigneeName))
	}
	return jsonResult(out)
}

func issueFromRow(r db.ListProjectIssuesForAgentRow) db.Issue {
	return db.Issue{
		ID: r.ID, ProjectID: r.ProjectID, Number: r.Number, Title: r.Title,
		Description: r.Description, Status: r.Status, Priority: r.Priority,
		AssigneeID: r.AssigneeID, AgentID: r.AgentID, CreatedBy: r.CreatedBy,
		CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
	}
}

func (s *Service) getIssue(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	iid, err := uuidArg(req, "issue_id")
	if err != nil {
		return errResult(err)
	}
	pid, err := s.q.ResolveIssueProject(ctx, iid)
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "issue:read"); err != nil {
		return errResult(err)
	}
	r, err := s.q.GetIssueForAgent(ctx, iid)
	if err != nil {
		return errResult(err)
	}
	return jsonResult(issueJSON(db.Issue{
		ID: r.ID, ProjectID: r.ProjectID, Number: r.Number, Title: r.Title,
		Description: r.Description, Status: r.Status, Priority: r.Priority,
		AssigneeID: r.AssigneeID, AgentID: r.AgentID, CreatedBy: r.CreatedBy,
		CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
	}, r.AssigneeName))
}

func issueJSON(i db.Issue, assigneeName pgtype.Text) gin.H {
	return gin.H{
		"id": i.ID, "project_id": i.ProjectID, "number": i.Number,
		"title": i.Title, "description": i.Description,
		"status": i.Status, "priority": i.Priority,
		"assignee_id": i.AssigneeID, "assignee_name": assigneeName.String,
		"agent_id": i.AgentID, "created_at": i.CreatedAt.Time,
	}
}

func (s *Service) sendMessage(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var cid pgtype.UUID
	var pid pgtype.UUID
	if v := req.GetString("project_id", ""); v != "" {
		if err := pid.Scan(v); err != nil || !pid.Valid {
			return mcp.NewToolResultError("invalid project_id"), nil
		}
		if err := s.scope(ctx, pid, "message:write"); err != nil {
			return errResult(err)
		}
		conv, err := s.q.GetProjectConversation(ctx, pid)
		if errors.Is(err, pgx.ErrNoRows) {
			conv, err = s.q.CreateProjectConversation(ctx, pid)
		}
		if err != nil {
			return errResult(err)
		}
		cid = conv.ID
	} else {
		var err error
		cid, err = uuidArg(req, "conversation_id")
		if err != nil {
			return mcp.NewToolResultError("conversation_id or project_id required"), nil
		}
		pid, err = s.q.ResolveConversationProject(ctx, cid)
		if err != nil {
			return errResult(err)
		}
		if err := s.scope(ctx, pid, "message:write"); err != nil {
			return errResult(err)
		}
	}
	body, err := req.RequireString("body")
	if err != nil {
		return errResult(err)
	}
	if strings.TrimSpace(body) == "" || len(body) > 40000 {
		return mcp.NewToolResultError("body must be 1..40000 chars"), nil
	}
	var parent pgtype.UUID
	if v := req.GetString("reply_to", ""); v != "" {
		if err := parent.Scan(v); err != nil || !parent.Valid {
			return mcp.NewToolResultError("invalid reply_to"), nil
		}
		if _, err := s.q.MessageInConversation(ctx, db.MessageInConversationParams{
			ID: parent, ConversationID: cid,
		}); err != nil {
			return mcp.NewToolResultError("reply_to is not a message in this conversation"), nil
		}
	}
	id, err := s.q.CreateAgentMessage(ctx, db.CreateAgentMessageParams{
		ConversationID: cid, AgentID: agent(ctx).ID, Body: body, ParentID: parent,
	})
	if err != nil {
		return errResult(err)
	}
	m, err := s.q.GetMessageFull(ctx, id)
	if err != nil {
		return errResult(err)
	}
	s.publish(ctx, cid, "message.created", map[string]any{"conversation_id": cid.String(), "message": messageJSON(m)})
	if s.Push != nil {
		s.Push.NotifyMessage(pid, pgtype.UUID{}, body, m.ID,
			"/app/p/"+pid.String(), agent(ctx).Name)
	}
	return jsonResult(messageJSON(m))
}

func (s *Service) createIssue(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	pid, err := uuidArg(req, "project_id")
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "issue:write"); err != nil {
		return errResult(err)
	}
	title, err := req.RequireString("title")
	if err != nil {
		return errResult(err)
	}
	if strings.TrimSpace(title) == "" || len(title) > 200 {
		return mcp.NewToolResultError("title must be 1..200 chars"), nil
	}
	prio := req.GetString("priority", "none")
	switch prio {
	case "none", "low", "medium", "high", "urgent":
	default:
		return mcp.NewToolResultError("invalid priority"), nil
	}
	n, err := s.q.NextIssueNumber(ctx, pid)
	if err != nil {
		return errResult(err)
	}
	i, err := s.q.CreateIssueForAgent(ctx, db.CreateIssueForAgentParams{
		ProjectID: pid, Number: n, Title: title,
		Description: req.GetString("description", ""),
		Priority:    prio, AgentID: agent(ctx).ID,
	})
	if err != nil {
		return errResult(err)
	}
	s.recordActivity(ctx, i.ID, "created", gin.H{"title": title})
	s.publishPID(pid, "issue.created", map[string]any{"issue": issueJSON(i, pgtype.Text{})})
	return jsonResult(issueJSON(i, pgtype.Text{}))
}

func (s *Service) updateIssue(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	iid, err := uuidArg(req, "issue_id")
	if err != nil {
		return errResult(err)
	}
	pid, err := s.q.ResolveIssueProject(ctx, iid)
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "issue:write"); err != nil {
		return errResult(err)
	}
	opt := func(name string) pgtype.Text {
		v := req.GetString(name, "")
		return pgtype.Text{String: v, Valid: v != ""}
	}
	if st := opt("status"); st.Valid {
		switch st.String {
		case "backlog", "todo", "in_progress", "review", "done", "cancelled":
		default:
			return mcp.NewToolResultError("invalid status"), nil
		}
	}
	i, err := s.q.UpdateIssueFields(ctx, db.UpdateIssueFieldsParams{
		ID: iid, Title: opt("title"), Description: opt("description"),
		Status: opt("status"), Priority: opt("priority"),
	})
	if err != nil {
		return errResult(err)
	}
	s.recordActivity(ctx, iid, "updated", nil)
	s.publishPID(pid, "issue.updated", map[string]any{"issue": issueJSON(i, pgtype.Text{})})
	return jsonResult(issueJSON(i, pgtype.Text{}))
}

// editMessage mirrors the REST rule: the author may edit only while no
// agent has read the message. Once any agent (this one included) has a
// read receipt on it, the message is locked.
func (s *Service) editMessage(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	mid, err := uuidArg(req, "message_id")
	if err != nil {
		return errResult(err)
	}
	pid, err := s.q.ResolveMessageProject(ctx, mid)
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "message:write"); err != nil {
		return errResult(err)
	}
	locked, err := s.q.MessageReadByAgent(ctx, mid)
	if err != nil {
		return errResult(err)
	}
	if locked {
		return mcp.NewToolResultError("message_locked: an agent has read this message"), nil
	}
	body, err := req.RequireString("body")
	if err != nil {
		return errResult(err)
	}
	if strings.TrimSpace(body) == "" || len(body) > 40000 {
		return mcp.NewToolResultError("body must be 1..40000 chars"), nil
	}
	if _, err := s.q.UpdateMessageBodyAgent(ctx, db.UpdateMessageBodyAgentParams{
		ID: mid, AuthorAgentID: agent(ctx).ID, Body: body,
	}); err != nil {
		return errResult(errors.New("only the author can edit a message"))
	}
	m, err := s.q.GetMessageFull(ctx, mid)
	if err != nil {
		return errResult(err)
	}
	s.publish(ctx, m.ConversationID, "message.updated",
		map[string]any{"conversation_id": m.ConversationID.String(), "message": messageJSON(m)})
	return jsonResult(messageJSON(m))
}

// reactToMessage toggles this agent's emoji on a message and publishes the
// new aggregate over SSE.
func (s *Service) reactToMessage(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	mid, err := uuidArg(req, "message_id")
	if err != nil {
		return errResult(err)
	}
	pid, err := s.q.ResolveMessageProject(ctx, mid)
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "message:write"); err != nil {
		return errResult(err)
	}
	emoji, err := req.RequireString("emoji")
	if err != nil {
		return errResult(err)
	}
	emoji = strings.TrimSpace(emoji)
	if emoji == "" || len(emoji) > 32 {
		return mcp.NewToolResultError("emoji required (<= 32 chars)"), nil
	}
	removed, err := s.q.RemoveReactionAgent(ctx, db.RemoveReactionAgentParams{
		MessageID: mid, AgentID: agent(ctx).ID, Emoji: emoji,
	})
	if err != nil {
		return errResult(err)
	}
	if removed == 0 {
		if err := s.q.AddReactionAgent(ctx, db.AddReactionAgentParams{
			MessageID: mid, AgentID: agent(ctx).ID, Emoji: emoji,
		}); err != nil {
			return errResult(err)
		}
	}
	m, err := s.q.GetMessageFull(ctx, mid)
	if err != nil {
		return errResult(err)
	}
	s.publish(ctx, m.ConversationID, "reaction.updated",
		map[string]any{"conversation_id": m.ConversationID.String(), "message_id": mid.String()})
	return jsonResult(gin.H{"ok": true})
}

// avatarImageTypes mirrors internal/avatars: logos stay small and square.
var avatarImageTypes = map[string]bool{
	"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true,
}

// setAvatar lets the agent upload its own profile picture - the same file
// the workspace admin can set via PUT /api/agents/:id/avatar.
func (s *Service) setAvatar(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if s.store == nil {
		return mcp.NewToolResultError("storage not configured"), nil
	}
	raw, err := req.RequireString("image_base64")
	if err != nil {
		return errResult(err)
	}
	data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(raw))
	if err != nil {
		return mcp.NewToolResultError("image_base64 is not valid base64"), nil
	}
	if len(data) == 0 || len(data) > 2<<20 {
		return mcp.NewToolResultError("image must be 1 byte to 2 MiB"), nil
	}
	ct, _, _ := strings.Cut(http.DetectContentType(data), ";")
	if !avatarImageTypes[strings.TrimSpace(ct)] {
		return mcp.NewToolResultError("unsupported image type; png, jpeg, gif or webp"), nil
	}
	key := "avatars/a/" + agent(ctx).ID.String()
	if err := s.store.Put(ctx, key, bytes.NewReader(data), int64(len(data)), ct); err != nil {
		return errResult(err)
	}
	if _, err := s.q.UpdateAgentAvatar(ctx, db.UpdateAgentAvatarParams{
		ID: agent(ctx).ID, AvatarKey: pgtype.Text{String: key, Valid: true},
	}); err != nil {
		return errResult(err)
	}
	return jsonResult(gin.H{"ok": true, "avatar_url": "/api/files/" + key})
}

func (s *Service) markRead(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	mid, err := uuidArg(req, "message_id")
	if err != nil {
		return errResult(err)
	}
	pid, err := s.q.ResolveMessageProject(ctx, mid)
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "message:read"); err != nil {
		return errResult(err)
	}
	err = s.q.MarkMessageReadAgent(ctx, db.MarkMessageReadAgentParams{
		MessageID: mid, AgentID: agent(ctx).ID,
	})
	if err != nil {
		return errResult(err)
	}
	return jsonResult(gin.H{"ok": true})
}

func (s *Service) recordActivity(ctx context.Context, issueID pgtype.UUID, kind string, payload gin.H) {
	var raw []byte
	if payload != nil {
		raw, _ = json.Marshal(payload)
	}
	if err := s.q.RecordIssueActivityAgent(ctx, db.RecordIssueActivityAgentParams{
		IssueID: issueID, AgentID: agent(ctx).ID, Kind: kind, Payload: raw,
	}); err != nil {
		s.log.Warn("record issue activity", zap.Error(err))
	}
}

// ghRepo resolves the project's first linked repository under issue:read.
func (s *Service) ghRepo(ctx context.Context, req mcp.CallToolRequest) (db.Repository, error) {
	pid, err := uuidArg(req, "project_id")
	if err != nil {
		return db.Repository{}, err
	}
	if err := s.scope(ctx, pid, "issue:read"); err != nil {
		return db.Repository{}, err
	}
	repos, err := s.q.ListProjectRepos(ctx, pid)
	if err != nil || len(repos) == 0 {
		return db.Repository{}, errors.New("no GitHub repository linked to this project")
	}
	return repos[0], nil
}

func (s *Service) ghClient(ctx context.Context) (*github.Client, error) {
	if s.gh == nil {
		return nil, errors.New("github integration unavailable")
	}
	return s.gh.Client(ctx)
}

func ghIssueJSON(i github.GHIssue, repo string) gin.H {
	return gin.H{
		"number": i.Number, "title": i.Title, "state": i.State,
		"url": i.HTMLURL, "author": i.User.Login, "repo": repo,
		"updated_at": i.UpdatedAt,
	}
}

func (s *Service) ghListIssues(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	r, err := s.ghRepo(ctx, req)
	if err != nil {
		return errResult(err)
	}
	cli, err := s.ghClient(ctx)
	if err != nil {
		return errResult(err)
	}
	issues, err := cli.ListIssues(ctx, r.InstallationID, r.Owner, r.Name)
	if err != nil {
		return errResult(err)
	}
	full := r.Owner + "/" + r.Name
	out := make([]gin.H, 0, len(issues))
	for _, i := range issues {
		out = append(out, ghIssueJSON(i, full))
	}
	return jsonResult(out)
}

func (s *Service) ghGetIssue(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	r, err := s.ghRepo(ctx, req)
	if err != nil {
		return errResult(err)
	}
	num := req.GetInt("number", 0)
	if num < 1 {
		return mcp.NewToolResultError("number required"), nil
	}
	cli, err := s.ghClient(ctx)
	if err != nil {
		return errResult(err)
	}
	i, err := cli.GetIssue(ctx, r.InstallationID, r.Owner, r.Name, num)
	if err != nil {
		return errResult(err)
	}
	out := ghIssueJSON(*i, r.Owner+"/"+r.Name)
	out["body"] = i.Body
	return jsonResult(out)
}

func ghPRJSON(p github.PR, repo string) gin.H {
	return gin.H{
		"number": p.Number, "title": p.Title, "state": p.State,
		"draft": p.Draft, "url": p.HTMLURL, "author": p.User.Login,
		"head": p.Head.Ref, "base": p.Base.Ref, "repo": repo,
	}
}

func (s *Service) ghListPRs(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	r, err := s.ghRepo(ctx, req)
	if err != nil {
		return errResult(err)
	}
	cli, err := s.ghClient(ctx)
	if err != nil {
		return errResult(err)
	}
	prs, err := cli.ListPRs(ctx, r.InstallationID, r.Owner, r.Name)
	if err != nil {
		return errResult(err)
	}
	full := r.Owner + "/" + r.Name
	out := make([]gin.H, 0, len(prs))
	for _, p := range prs {
		out = append(out, ghPRJSON(p, full))
	}
	return jsonResult(out)
}

func (s *Service) ghGetPR(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	r, err := s.ghRepo(ctx, req)
	if err != nil {
		return errResult(err)
	}
	num := req.GetInt("number", 0)
	if num < 1 {
		return mcp.NewToolResultError("number required"), nil
	}
	cli, err := s.ghClient(ctx)
	if err != nil {
		return errResult(err)
	}
	p, err := cli.GetPR(ctx, r.InstallationID, r.Owner, r.Name, num)
	if err != nil {
		return errResult(err)
	}
	return jsonResult(ghPRJSON(*p, r.Owner+"/"+r.Name))
}

// --- agent todos ---

func todoOut(t db.ListTodosRow) gin.H {
	out := gin.H{
		"id": t.ID.String(), "content": t.Content, "done": t.Done,
		"created_at": t.CreatedAt.Time, "updated_at": t.UpdatedAt.Time,
	}
	if t.AgentID.Valid {
		out["agent"] = gin.H{"id": t.AgentID.String(), "name": t.AgentName.String}
	}
	if t.IssueID.Valid && t.IssueKey.Valid {
		out["issue"] = gin.H{"id": t.IssueID.String(),
			"key": t.IssueKey.String + "-" + strconv.Itoa(int(t.IssueNumber.Int32))}
	}
	return out
}

func (s *Service) todoList(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	pid, err := uuidArg(req, "project_id")
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "issue:read"); err != nil {
		return errResult(err)
	}
	rows, err := s.q.ListTodos(ctx, pid)
	if err != nil {
		return errResult(err)
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, todoOut(r))
	}
	return jsonResult(out)
}

func (s *Service) todoAdd(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	pid, err := uuidArg(req, "project_id")
	if err != nil {
		return errResult(err)
	}
	content, err := req.RequireString("content")
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "issue:write"); err != nil {
		return errResult(err)
	}
	var issueID pgtype.UUID
	if v, ok := req.GetArguments()["issue_id"].(string); ok && v != "" {
		if err := issueID.Scan(v); err != nil {
			return errResult(errors.New("invalid issue_id"))
		}
	}
	row, err := s.q.CreateTodo(ctx, db.CreateTodoParams{
		ProjectID: pid, AgentID: agent(ctx).ID, IssueID: issueID, Content: content,
	})
	if err != nil {
		return errResult(err)
	}
	return jsonResult(gin.H{"id": row.ID.String(), "done": row.Done, "content": row.Content})
}

// todoProject resolves todo_id -> project row for the scope check.
func (s *Service) todoProject(ctx context.Context, req mcp.CallToolRequest) (pgtype.UUID, db.AgentTodo, error) {
	tid, err := uuidArg(req, "todo_id")
	if err != nil {
		return pgtype.UUID{}, db.AgentTodo{}, err
	}
	t, err := s.q.GetTodo(ctx, tid)
	if err != nil {
		return pgtype.UUID{}, db.AgentTodo{}, errors.New("todo not found")
	}
	return t.ProjectID, t, nil
}

func (s *Service) todoUpdate(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	pid, t, err := s.todoProject(ctx, req)
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "issue:write"); err != nil {
		return errResult(err)
	}
	params := db.UpdateTodoParams{ID: t.ID}
	args := req.GetArguments()
	if v, ok := args["content"].(string); ok {
		params.Content = pgtype.Text{String: v, Valid: true}
	}
	if v, ok := args["done"].(bool); ok {
		params.Done = pgtype.Bool{Bool: v, Valid: true}
	}
	if v, ok := args["issue_id"].(string); ok {
		var iid pgtype.UUID
		if v != "" {
			if err := iid.Scan(v); err != nil {
				return errResult(errors.New("invalid issue_id"))
			}
		}
		params.IssueID = iid
	}
	row, err := s.q.UpdateTodo(ctx, params)
	if err != nil {
		return errResult(err)
	}
	return jsonResult(gin.H{"id": row.ID.String(), "done": row.Done, "content": row.Content})
}

func (s *Service) todoDelete(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	pid, t, err := s.todoProject(ctx, req)
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "issue:write"); err != nil {
		return errResult(err)
	}
	if err := s.q.DeleteTodo(ctx, t.ID); err != nil {
		return errResult(err)
	}
	return jsonResult(gin.H{"deleted": t.ID.String()})
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// publish resolves a conversation's project before emitting — a wrong
// project_id on the event would bypass the SSE membership gate, so never
// trust the caller.
func (s *Service) publish(ctx context.Context, conversationID pgtype.UUID, typ string, data map[string]any) {
	if s.Bus == nil {
		return
	}
	pid, err := s.q.ResolveConversationProject(ctx, conversationID)
	if err != nil {
		return
	}
	s.publishPID(pid, typ, data)
}

func (s *Service) publishPID(pid pgtype.UUID, typ string, data map[string]any) {
	if s.Bus == nil || !pid.Valid {
		return
	}
	id, _ := uuid.FromBytes(pid.Bytes[:])
	s.Bus.Publish(events.Event{Type: typ, ProjectID: id, Data: data})
}

// --- work review tools ---

// maxReviewJSON caps each structured field so a runaway agent cannot
// bloat a row (and every SSE fan-out of it).
const maxReviewJSON = 256 * 1024

// jsonbArg re-marshals a raw tool argument into a jsonb-ready []byte and
// validates it decodes as an array of objects. Missing keys become '[]'.
func jsonbArg(req mcp.CallToolRequest, name string) ([]byte, error) {
	v, ok := req.GetArguments()[name]
	if !ok || v == nil {
		return []byte("[]"), nil
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, errors.New(name + ": not JSON-marshalable")
	}
	if len(raw) > maxReviewJSON {
		return nil, errors.New(name + ": exceeds 256KB")
	}
	var arr []map[string]any
	if err := json.Unmarshal(raw, &arr); err != nil {
		return nil, errors.New(name + " must be an array of objects")
	}
	return raw, nil
}

func mcpReviewJSON(r db.GetReviewRow) gin.H {
	raw := func(b []byte) json.RawMessage {
		if len(b) == 0 {
			return json.RawMessage("[]")
		}
		return json.RawMessage(b)
	}
	var respondedAt, supersedes, issueID any
	if r.RespondedAt.Valid {
		respondedAt = r.RespondedAt.Time
	}
	if r.Supersedes.Valid {
		supersedes = r.Supersedes.String()
	}
	if r.IssueID.Valid {
		issueID = r.IssueID.String()
	}
	var responder any
	if r.RespondedBy.Valid {
		responder = r.ResponderName.String
	}
	return gin.H{
		"id": r.ID.String(), "project_id": r.ProjectID.String(),
		"status": r.Status, "title": r.Title, "summary": r.Summary,
		"files": raw(r.Files), "decisions": raw(r.Decisions),
		"actions": raw(r.Actions), "links": raw(r.Links), "verify": r.Verify,
		"issue_id": issueID, "supersedes": supersedes,
		"response": r.Response, "responder": responder, "responded_at": respondedAt,
		"created_at": r.CreatedAt.Time,
	}
}

func (s *Service) submitReview(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	pid, err := uuidArg(req, "project_id")
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "review:write"); err != nil {
		return errResult(err)
	}
	title, err := req.RequireString("title")
	if err != nil {
		return errResult(err)
	}
	title = strings.TrimSpace(title)
	if len(title) == 0 || len(title) > 200 {
		return errResult(errors.New("title must be 1-200 chars"))
	}
	summary, err := req.RequireString("summary")
	if err != nil {
		return errResult(err)
	}
	if len(summary) > 20000 {
		return errResult(errors.New("summary exceeds 20KB"))
	}
	var issueID, supersedes pgtype.UUID
	if v := req.GetString("issue_id", ""); v != "" {
		if err := issueID.Scan(v); err != nil || !issueID.Valid {
			return errResult(errors.New("invalid issue_id"))
		}
	}
	if v := req.GetString("supersedes", ""); v != "" {
		if err := supersedes.Scan(v); err != nil || !supersedes.Valid {
			return errResult(errors.New("invalid supersedes"))
		}
	}
	files, err := jsonbArg(req, "files")
	if err != nil {
		return errResult(err)
	}
	decisions, err := jsonbArg(req, "decisions")
	if err != nil {
		return errResult(err)
	}
	actions, err := jsonbArg(req, "actions")
	if err != nil {
		return errResult(err)
	}
	links, err := jsonbArg(req, "links")
	if err != nil {
		return errResult(err)
	}
	verify := req.GetString("verify", "")
	if len(verify) > 10000 {
		return errResult(errors.New("verify exceeds 10KB"))
	}
	if supersedes.Valid {
		prev, err := s.q.ReviewAgentProject(ctx, supersedes)
		if err != nil {
			return errResult(errors.New("supersedes: review not found"))
		}
		if prev.ProjectID != pid {
			return errResult(errors.New("supersedes: review belongs to another project"))
		}
		if err := s.q.SupersedeReview(ctx, supersedes); err != nil {
			return errResult(err)
		}
	}
	row, err := s.q.CreateReview(ctx, db.CreateReviewParams{
		ProjectID: pid, IssueID: issueID, AgentID: agent(ctx).ID,
		Title: title, Summary: summary,
		Files: files, Decisions: decisions, Actions: actions, Links: links,
		Verify: verify, Supersedes: supersedes,
	})
	if err != nil {
		return errResult(err)
	}
	s.publishPID(pid, "review.created", map[string]any{
		"review_id": row.ID.String(), "title": row.Title, "agent": agent(ctx).Name,
	})
	if s.Push != nil {
		s.Push.NotifyProject(pid, push.Payload{
			Title: "Review requested by " + agent(ctx).Name,
			Body:  row.Title, URL: "/app/p/" + pid.String(),
			Tag: "review-" + row.ID.String(),
		})
	}
	return jsonResult(gin.H{
		"id": row.ID.String(), "status": row.Status,
		"created_at":  row.CreatedAt.Time,
		"review_mode": agent(ctx).ReviewMode,
		"must_wait":   agent(ctx).ReviewMode == "gate",
	})
}

// reviewForAgent loads a review after verifying the caller holds
// review:read on its project.
func (s *Service) reviewForAgent(ctx context.Context, req mcp.CallToolRequest) (db.GetReviewRow, error) {
	rid, err := uuidArg(req, "review_id")
	if err != nil {
		return db.GetReviewRow{}, err
	}
	rp, err := s.q.ReviewAgentProject(ctx, rid)
	if err != nil {
		return db.GetReviewRow{}, errors.New("review not found")
	}
	if err := s.scope(ctx, rp.ProjectID, "review:read"); err != nil {
		return db.GetReviewRow{}, err
	}
	return s.q.GetReview(ctx, rid)
}

func (s *Service) getReview(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	r, err := s.reviewForAgent(ctx, req)
	if err != nil {
		return errResult(err)
	}
	return jsonResult(mcpReviewJSON(r))
}

func (s *Service) listReviews(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	pid, err := uuidArg(req, "project_id")
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "review:read"); err != nil {
		return errResult(err)
	}
	var status pgtype.Text
	if v := req.GetString("status", ""); v != "" {
		status = pgtype.Text{String: v, Valid: true}
	}
	rows, err := s.q.ListProjectReviews(ctx, db.ListProjectReviewsParams{
		ProjectID: pid, Status: status, Lim: 100,
	})
	if err != nil {
		return errResult(err)
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, mcpReviewJSON(listRowAsGet(r)))
	}
	return jsonResult(out)
}

// awaitReview blocks on the event hub until the review leaves 'pending'.
// Gated agents call this after submit_review to get the human verdict.
func (s *Service) awaitReview(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	r, err := s.reviewForAgent(ctx, req)
	if err != nil {
		return errResult(err)
	}
	if r.Status != "pending" {
		return jsonResult(mcpReviewJSON(r))
	}
	if s.Bus == nil {
		return errResult(errors.New("event hub unavailable; poll get_review instead"))
	}
	timeout := clampInt(req.GetInt("timeout_s", 60), 1, 300)
	rid := r.ID.String()
	sub, ch := s.Bus.Subscribe()
	defer s.Bus.Unsubscribe(sub)
	timer := time.NewTimer(time.Duration(timeout) * time.Second)
	defer timer.Stop()
	for {
		select {
		case e, ok := <-ch:
			if !ok {
				return errResult(errors.New("event hub closed"))
			}
			if e.Type == "review.responded" && e.Data["review_id"] == rid {
				fresh, err := s.q.GetReview(ctx, r.ID)
				if err != nil {
					return errResult(err)
				}
				return jsonResult(mcpReviewJSON(fresh))
			}
		case <-ctx.Done():
			return errResult(errors.New("request cancelled"))
		case <-timer.C:
			fresh, err := s.q.GetReview(ctx, r.ID)
			if err != nil {
				return errResult(err)
			}
			return jsonResult(mcpReviewJSON(fresh))
		}
	}
}

// listRowAsGet bridges the two joined row types - identical fields.
func listRowAsGet(r db.ListProjectReviewsRow) db.GetReviewRow {
	return db.GetReviewRow(r)
}

// --- local folder tools (file:read) ---

// localRoot loads the project's linked folder; empty when unlinked.
func (s *Service) localRoot(ctx context.Context, pid pgtype.UUID) (string, error) {
	meta, err := s.q.ProjectMeta(ctx, pid)
	if err != nil {
		return "", err
	}
	if !meta.LocalPath.Valid {
		return "", nil
	}
	return meta.LocalPath.String, nil
}

func (s *Service) listProjectFiles(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	pid, err := uuidArg(req, "project_id")
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "file:read"); err != nil {
		return errResult(err)
	}
	root, err := s.localRoot(ctx, pid)
	if err != nil {
		return errResult(err)
	}
	if root == "" {
		return mcp.NewToolResultError("no folder linked to this project"), nil
	}
	dir, ok := localfiles.ResolveInRoot(root, req.GetString("path", ""))
	if !ok {
		return mcp.NewToolResultError("path not found"), nil
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return errResult(err)
	}
	out := make([]gin.H, 0, len(ents))
	for _, e := range ents {
		if e.IsDir() && localfiles.SkipDirs[e.Name()] {
			continue
		}
		if !e.IsDir() && localfiles.Sensitive(e.Name()) {
			continue
		}
		out = append(out, gin.H{"name": e.Name(), "dir": e.IsDir()})
		if len(out) >= localfiles.MaxTreeEntries {
			break
		}
	}
	return jsonResult(gin.H{"entries": out})
}

func (s *Service) readProjectFile(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	pid, err := uuidArg(req, "project_id")
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "file:read"); err != nil {
		return errResult(err)
	}
	root, err := s.localRoot(ctx, pid)
	if err != nil {
		return errResult(err)
	}
	if root == "" {
		return mcp.NewToolResultError("no folder linked to this project"), nil
	}
	path := req.GetString("path", "")
	full, ok := localfiles.ResolveInRoot(root, path)
	if !ok || localfiles.Sensitive(filepath.Base(full)) {
		return mcp.NewToolResultError("path not found"), nil
	}
	st, err := os.Stat(full)
	if err != nil || st.IsDir() || st.Size() > localfiles.MaxReadBytes {
		return mcp.NewToolResultError("not a readable text file (or over 256KB)"), nil
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return errResult(err)
	}
	if !utf8.Valid(data) {
		return mcp.NewToolResultError("binary file"), nil
	}
	return jsonResult(gin.H{"path": path, "content": string(data), "size": st.Size()})
}
