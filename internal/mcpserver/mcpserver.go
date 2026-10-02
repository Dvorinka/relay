// Package mcpserver exposes the Relay MCP endpoint: streamable HTTP at
// /mcp, authenticated by rly_ bearer tokens, every tool gated by the
// token's per-project scope grant.
package mcpserver

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

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
	"github.com/Dvorinka/relay/internal/storage"
)

const requestsPerMinute = 120

type ctxKey int

const agentKey ctxKey = iota

// Agent is the authenticated caller carried through the request context.
type Agent struct {
	ID        pgtype.UUID
	TokenID   pgtype.UUID
	Name      string
	AvatarKey pgtype.Text
}

// Service wires tools to the database and object storage.
type Service struct {
	q     *db.Queries
	store *storage.Store
	gh    *github.Service
	log   *zap.Logger
	// Bus publishes domain events for SSE subscribers. Optional.
	Bus *events.Hub

	mu      sync.Mutex
	windows map[[16]byte]time.Time // token id -> current minute window start
	counts  map[[16]byte]int
}

// New builds the gin handler for POST /mcp. It performs bearer auth,
// rate limiting, and last_used_at bookkeeping, then hands the request
// to the mcp-go streamable HTTP transport.
func New(q *db.Queries, store *storage.Store, log *zap.Logger, gh *github.Service, hub *events.Hub) gin.HandlerFunc {
	s := &Service{
		q: q, store: store, gh: gh, log: log, Bus: hub,
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
	return &Agent{ID: row.ID, TokenID: row.TokenID, Name: row.Name, AvatarKey: row.AvatarKey}, nil
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
		mcp.WithDescription("Post a message as this agent. Give project_id to post in the project's main thread, or conversation_id to reply in a specific conversation."),
		mcp.WithString("project_id"),
		mcp.WithString("conversation_id"),
		mcp.WithString("body", mcp.Required(), mcp.Description("Markdown body")),
	), s.sendMessage)

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
	return gin.H{
		"id":              m.ID,
		"conversation_id": m.ConversationID,
		"body":            m.Body,
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
	if v := req.GetString("project_id", ""); v != "" {
		var pid pgtype.UUID
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
		pid, err := s.q.ResolveConversationProject(ctx, cid)
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
	id, err := s.q.CreateAgentMessage(ctx, db.CreateAgentMessageParams{
		ConversationID: cid, AgentID: agent(ctx).ID, Body: body,
	})
	if err != nil {
		return errResult(err)
	}
	m, err := s.q.GetMessageFull(ctx, id)
	if err != nil {
		return errResult(err)
	}
	s.publish(ctx, cid, "message.created", map[string]any{"conversation_id": cid.String(), "message": messageJSON(m)})
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
