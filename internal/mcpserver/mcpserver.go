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
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
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

	"github.com/Dvorinka/relay/internal/agentdoc"
	"github.com/Dvorinka/relay/internal/attachments"
	"github.com/Dvorinka/relay/internal/avatars"
	"github.com/Dvorinka/relay/internal/conversations"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/events"
	"github.com/Dvorinka/relay/internal/github"
	"github.com/Dvorinka/relay/internal/localfiles"
	"github.com/Dvorinka/relay/internal/mentions"
	"github.com/Dvorinka/relay/internal/push"
	"github.com/Dvorinka/relay/internal/storage"
)

const requestsPerMinute = 120

type ctxKey int

const agentKey ctxKey = iota

// Agent is the authenticated caller carried through the request context.
type Agent struct {
	ID          pgtype.UUID
	TokenID     pgtype.UUID
	WorkspaceID pgtype.UUID
	Name        string
	Slug        string
	AvatarKey   pgtype.Text
	ReviewMode  string
	GrantAll    bool
	GrantScopes []string
}

// toolEntry is one registered tool's manifest row — whoami's capabilities
// list and get_guide's machine manifest both read it.
type toolEntry struct {
	Name     string   `json:"name"`
	Required []string `json:"required_args"`
	Optional []string `json:"optional_args"`
}

// Service wires tools to the database and object storage.
type Service struct {
	q         *db.Queries
	store     *storage.Store
	maxUpload int64
	limited   bool
	gh        *github.Service
	log       *zap.Logger
	version   string
	tools     []toolEntry
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
func New(q *db.Queries, store *storage.Store, maxUpload int64, limited bool, log *zap.Logger, gh *github.Service, hub *events.Hub, pushSvc *push.Service, version string) gin.HandlerFunc {
	if version == "" {
		version = "dev"
	}
	s := &Service{
		q: q, store: store, maxUpload: maxUpload, limited: limited, gh: gh, log: log,
		Bus: hub, Push: pushSvc, version: version,
		windows: make(map[[16]byte]time.Time),
		counts:  make(map[[16]byte]int),
	}

	mcpSrv := server.NewMCPServer("relay", version,
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
			jsonRPCErrorData(c.Writer, "rate limit exceeded", -32001,
				gin.H{"retry_after_ms": s.retryAfterMs(agent.TokenID)})
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
	jsonRPCErrorData(w, msg, code, nil)
}

// jsonRPCErrorData carries an optional data object — the rate-limit reply
// uses it for retry_after_ms so clients can back off deterministically.
func jsonRPCErrorData(w http.ResponseWriter, msg string, code int, data gin.H) {
	e := gin.H{"code": code, "message": msg}
	if data != nil {
		e["data"] = data
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(gin.H{
		"jsonrpc": "2.0",
		"error":   e,
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
	return &Agent{ID: row.ID, TokenID: row.TokenID, WorkspaceID: row.WorkspaceID,
		Name: row.Name, Slug: row.Slug, AvatarKey: row.AvatarKey,
		ReviewMode: row.ReviewMode, GrantAll: row.GrantAll, GrantScopes: row.GrantScopes}, nil
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

// retryAfterMs reports how long until the token's current rate window
// resets — surfaced as retry_after_ms in the -32001 error payload.
func (s *Service) retryAfterMs(tokenID pgtype.UUID) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	start, ok := s.windows[tokenID.Bytes]
	if !ok {
		return 0
	}
	ms := time.Until(start.Add(time.Minute)).Milliseconds()
	if ms < 0 {
		return 0
	}
	return ms
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

// ideaScope authorizes against the idea's project, or — for platform-wide
// ideas with no project — the union of scopes the agent holds in its
// workspace.
func (s *Service) ideaScope(ctx context.Context, i db.GetIdeaRow, required string) error {
	if i.ProjectID.Valid {
		return s.scope(ctx, i.ProjectID, required)
	}
	scopes, err := s.q.AgentScopeForWorkspace(ctx, db.AgentScopeForWorkspaceParams{
		AgentID: agent(ctx).ID, WorkspaceID: i.WorkspaceID,
	})
	if err != nil || !hasScope(scopes, required) {
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

// errResult is reserved for existence/scope lookups and backend failures —
// "not found or not granted" is the deliberate anti-enumeration text.
// Argument-validation errors (uuidArg, RequireString, bad enum/date) must
// bypass it and return mcp.NewToolResultError(err.Error()) directly so
// callers see what they got wrong.
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

// readOnlyTools mark pure reads: they write no state, so cautious clients
// never need a confirmation prompt for them.
var readOnlyTools = map[string]bool{
	"get_guide": true, "whoami": true, "activity": true, "list_unread": true,
	"list_projects": true, "get_project": true, "list_conversations": true,
	"ops_summary": true, "get_messages": true, "get_message": true,
	"get_attachment": true, "search_messages": true, "list_issues": true,
	"get_issue": true, "list_pins": true, "list_project_files": true,
	"read_project_file": true, "todo_list": true, "list_mentionables": true,
	"get_review": true, "list_reviews": true, "await_review": true,
	"await_message": true, "inbox": true,
	"get_brief_policy": true, "list_briefs": true, "get_brief": true,
	"list_ideas": true, "get_idea": true,
	"github_list_issues": true, "github_get_issue": true, "github_list_prs": true,
	"github_get_pr": true, "github_ci_runs": true,
}

// destructiveTools are the real deletes (plus todo_sync, which deletes
// whatever the caller omits). Everything else that mutates is a reversible
// write — destructiveHint stays false on it.
var destructiveTools = map[string]bool{
	"delete_message": true, "todo_delete": true, "todo_sync": true,
	"delete_brief": true, "delete_idea": true,
}

// toolAnns sets the hints clients gate on. mcp-go defaults every tool to
// destructiveHint:true — mislabeling reads and plain writes — so every
// registered tool gets explicit annotations reflecting what it does.
// github_* are the only tools reaching outside this server (openWorld).
func toolAnns(name string) mcp.ToolAnnotation {
	ro := readOnlyTools[name]
	return mcp.ToolAnnotation{
		ReadOnlyHint:    mcp.ToBoolPtr(ro),
		DestructiveHint: mcp.ToBoolPtr(!ro && destructiveTools[name]),
		OpenWorldHint:   mcp.ToBoolPtr(strings.HasPrefix(name, "github_")),
	}
}

// addTool registers the tool, fixes its annotations, and records its
// manifest row for whoami (capabilities) and get_guide (tool manifest).
func (s *Service) addTool(srv *server.MCPServer, t mcp.Tool, h server.ToolHandlerFunc) {
	t.Annotations = toolAnns(t.Name)
	reqd := map[string]bool{}
	for _, r := range t.InputSchema.Required {
		reqd[r] = true
	}
	opt := make([]string, 0, len(t.InputSchema.Properties))
	for name := range t.InputSchema.Properties {
		if !reqd[name] {
			opt = append(opt, name)
		}
	}
	sort.Strings(opt)
	s.tools = append(s.tools, toolEntry{
		Name: t.Name, Required: t.InputSchema.Required, Optional: opt,
	})
	srv.AddTool(t, h)
}

func (s *Service) registerTools(srv *server.MCPServer) {
	s.addTool(srv, mcp.NewTool("get_guide",
		mcp.WithDescription("The Relay agent onboarding guide — read this before anything else on a new workspace. Returns the prose guide plus a machine-readable manifest of every registered tool (required/optional args), the reply flow, and mention syntax — the self-describing first contact. Also via `relay-cli guide` or GET /api/agent-guide."),
	), func(ctx context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return jsonResult(gin.H{
			"guide": agentdoc.Guide,
			"manifest": gin.H{
				"tools": s.tools,
				"reply_flow": "send_message with reply_to=<message_id> — conversation_id is inferred from the target; pass conversation_id/project_id explicitly only when starting a new top-level message",
				"mention_syntax": "@name mentions a workspace member, @agent:<slug> an agent, KEY-1 an issue, owner/repo#N a GitHub issue/PR, @file:<path> a linked local file",
				"minimal_mode":   "most read tools accept minimal:true — bodies/descriptions become 200-char excerpts with truncated:true",
				"wait_for_reply": "await_message {conversation_id, timeout_s<=55} long-polls for a reply from another author; inbox lists mentions, replies and unread in one call",
			},
		})
	})

	s.addTool(srv, mcp.NewTool("whoami",
		mcp.WithDescription("This agent's identity: name, slug, workspace, review mode, granted projects, server_version, and capabilities (the registered tool list) — call first on a new session to learn who you are and what this server supports."),
	), s.whoami)

	s.addTool(srv, mcp.NewTool("activity",
		mcp.WithDescription("Cross-project work feed across all granted projects: open issues, open GitHub PRs, and the latest messages — what needs attention right now."),
		mcp.WithBoolean("minimal", mcp.Description("true trims message bodies to 200-char excerpts")),
	), s.activity)

	s.addTool(srv, mcp.NewTool("list_unread",
		mcp.WithDescription("Conversations with unread messages — the agent's triage list. Each row carries project key, conversation id, kind, name, unread count, and the latest unread message's id+excerpt. Optional project_id scopes to one project. Start here on a new session; inbox adds mentions/replies."),
		mcp.WithString("project_id", mcp.Description("Scope to one granted project")),
	), s.listUnread)

	s.addTool(srv, mcp.NewTool("inbox",
		mcp.WithDescription("What is aimed at this agent in one call: @mentions, replies to your messages, and unread messages across granted conversations — [{kind: mention|reply|unread, message_id, conversation_id, project, excerpt, at}]."),
		mcp.WithNumber("limit", mcp.Description("Max items, default 50, cap 100")),
	), s.inbox)

	s.addTool(srv, mcp.NewTool("await_message",
		mcp.WithDescription("Block until a message from a different author lands in the conversation — the human-reply wait. Returns {status:'message', message:{...}} on arrival, {status:'timeout'} after timeout_s (default 55, cap 55 — re-call to keep waiting). Also returns immediately if an unread reply is already waiting."),
		mcp.WithString("conversation_id"),
		mcp.WithString("project_id", mcp.Description("Resolves the project's main conversation")),
		mcp.WithNumber("timeout_s", mcp.Description("Max seconds to block, default 55, cap 55")),
	), s.awaitMessage)

	s.addTool(srv, mcp.NewTool("list_projects",
		mcp.WithDescription("List the projects this agent has been granted access to."),
	), s.listProjects)

	s.addTool(srv, mcp.NewTool("get_project",
		mcp.WithDescription("Get one granted project's details."),
		mcp.WithString("project_id", mcp.Required(), mcp.Description("Project UUID")),
	), s.getProject)

	s.addTool(srv, mcp.NewTool("list_conversations",
		mcp.WithDescription("List conversations in a granted project, most recently active first — each row carries last_message_at, last_message_excerpt, and message_count so the active channel is findable without extra calls."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithBoolean("minimal", mcp.Description("true drops the excerpt field")),
	), s.listConversations)

	s.addTool(srv, mcp.NewTool("ops_summary",
		mcp.WithDescription("Control-center view over a channel's structured (meta) posts: latest state per service, a 30-day uptime strip, and per-kind counts. Use on ops/monitoring channels; agents_blocked channels refuse."),
		mcp.WithString("conversation_id", mcp.Required()),
	), s.opsSummary)

	s.addTool(srv, mcp.NewTool("get_messages",
		mcp.WithDescription("List messages in a conversation (newest first). Pass conversation_id, or project_id for the project's main thread. before/after take a message id as the page cursor; next_before in the response is the cursor for the next older page."),
		mcp.WithString("conversation_id"),
		mcp.WithString("project_id", mcp.Description("Resolves the project's main conversation")),
		mcp.WithNumber("limit", mcp.Description("Max messages, default 50, cap 100")),
		mcp.WithString("tag", mcp.Description("Only messages carrying this tag")),
		mcp.WithString("before", mcp.Description("Only messages older than this message id (cursor; before_id also accepted)")),
		mcp.WithString("after", mcp.Description("Only messages newer than this message id (cursor)")),
		mcp.WithBoolean("unread_only", mcp.Description("Only messages this agent has not read")),
		mcp.WithString("author_kind", mcp.Description("user|agent|system")),
		mcp.WithBoolean("minimal", mcp.Description("true replaces body with a 200-char excerpt and drops heavy nested fields")),
	), s.getMessages)

	s.addTool(srv, mcp.NewTool("get_message",
		mcp.WithDescription("Get one message by id."),
		mcp.WithString("message_id", mcp.Required()),
	), s.getMessage)

	s.addTool(srv, mcp.NewTool("get_attachment",
		mcp.WithDescription("Get an attachment's metadata and a download_url — fetch it with your rly_ bearer token (curl -o file \"<relay-base><download_url>\" -H \"Authorization: Bearer $TOKEN\"). Images also arrive as an MCP image block; small non-images inline as data_base64."),
		mcp.WithString("attachment_id", mcp.Required()),
	), s.getAttachment)

	s.addTool(srv, mcp.NewTool("upload_attachment",
		mcp.WithDescription("Upload a file (base64) to a granted project and get an attachment id to pass as send_message's attachment_ids. Images render inline in the app."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithString("name", mcp.Required(), mcp.Description("Filename, e.g. diagram.png")),
		mcp.WithString("data_base64", mcp.Required(), mcp.Description("Base64-encoded file content")),
		mcp.WithString("content_type", mcp.Description("Optional declared MIME type; sniffed type wins")),
	), s.uploadAttachment)

	s.addTool(srv, mcp.NewTool("search_messages",
		mcp.WithDescription("Full-text-ish search (case-insensitive substring) over a project's messages. Inline operators still work (from:, in:, has:image|file, before:, after:); the explicit args below win over them. Returns total plus per-hit excerpt around the match."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithString("query", mcp.Description("Search terms — optional when filters do the work")),
		mcp.WithNumber("limit", mcp.Description("Max results, default 20, cap 100")),
		mcp.WithString("conversation_id", mcp.Description("Scope to one conversation")),
		mcp.WithString("author_kind", mcp.Description("user|agent|system")),
		mcp.WithString("author_name", mcp.Description("Author name pattern (ILIKE)")),
		mcp.WithString("since", mcp.Description("Only messages at/after this time — RFC3339 or YYYY-MM-DD")),
		mcp.WithString("until", mcp.Description("Only messages before this time — RFC3339 or YYYY-MM-DD")),
		mcp.WithBoolean("has_attachments", mcp.Description("true = only with attachments, false = only without")),
		mcp.WithBoolean("minimal", mcp.Description("true drops tags/meta and keeps only the excerpt row")),
	), s.searchMessages)

	s.addTool(srv, mcp.NewTool("list_issues",
		mcp.WithDescription("List issues in a granted project."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithNumber("limit", mcp.Description("Max issues, default 50, cap 200")),
		mcp.WithString("status", mcp.Description("Filter by status: backlog|todo|in_progress|review|done|cancelled")),
		mcp.WithBoolean("minimal", mcp.Description("true replaces description with a 200-char excerpt")),
	), s.listIssues)

	s.addTool(srv, mcp.NewTool("get_issue",
		mcp.WithDescription("Get one issue by id."),
		mcp.WithString("issue_id", mcp.Required()),
		mcp.WithBoolean("minimal", mcp.Description("true replaces description with a 200-char excerpt")),
	), s.getIssue)

	s.addTool(srv, mcp.NewTool("send_message",
		mcp.WithDescription("Post a message as this agent. For a direct, self-contained answer always pass reply_to so the reply threads under the triggering message — conversation_id is inferred from reply_to, so replying never requires knowing the conversation. For anything bigger — plans, work in progress, open questions, anything needing back-and-forth — prefer create_thread first and post inside the thread. @username in the body notifies that user (their inbox + push): use it whenever a specific person's input is needed. Pass client_msg_id (any unique string) to make retries safe — a duplicate returns the original message."),
		mcp.WithString("project_id"),
		mcp.WithString("conversation_id"),
		mcp.WithString("body", mcp.Required(), mcp.Description("Markdown body")),
		mcp.WithString("reply_to", mcp.Description("Message UUID this message replies to")),
		mcp.WithString("tags", mcp.Description("Comma-separated tags classifying the message, e.g. frontend,backend,visual,mcp")),
		mcp.WithBoolean("silent", mcp.Description("true posts without any notification/push — use for routine progress updates inside a work thread. @mentions in a silent message still notify.")),
		mcp.WithString("attachment_ids", mcp.Description("Comma-separated attachment UUIDs from upload_attachment, max 20")),
		mcp.WithString("meta", mcp.Description("Optional JSON object rendered as a structured card — ops channels aggregate it. Recognized keys: kind, service, state (up|degraded|down|maintenance…), latency_ms, level, env, release, url, at, fields{label:value}")),
		mcp.WithString("client_msg_id", mcp.Description("Agent-generated idempotency key — a duplicate submit returns the original message instead of double-posting")),
	), s.sendMessage)

	// reply is an alias of send_message (kept for agents that guess the name);
	// prefer send_message. Same schema, same handler.
	s.addTool(srv, mcp.NewTool("reply",
		mcp.WithDescription("Alias of send_message (kept for agents that guess the name); prefer send_message. Identical args — typically {body, reply_to} suffices, conversation_id is inferred."),
		mcp.WithString("project_id"),
		mcp.WithString("conversation_id"),
		mcp.WithString("body", mcp.Required(), mcp.Description("Markdown body")),
		mcp.WithString("reply_to", mcp.Description("Message UUID this message replies to")),
		mcp.WithString("tags", mcp.Description("Comma-separated tags classifying the message, e.g. frontend,backend,visual,mcp")),
		mcp.WithBoolean("silent", mcp.Description("true posts without any notification/push — use for routine progress updates inside a work thread. @mentions in a silent message still notify.")),
		mcp.WithString("attachment_ids", mcp.Description("Comma-separated attachment UUIDs from upload_attachment, max 20")),
		mcp.WithString("meta", mcp.Description("Optional JSON object rendered as a structured card — ops channels aggregate it. Recognized keys: kind, service, state (up|degraded|down|maintenance…), latency_ms, level, env, release, url, at, fields{label:value}")),
		mcp.WithString("client_msg_id", mcp.Description("Agent-generated idempotency key — a duplicate submit returns the original message instead of double-posting")),
	), s.sendMessage)

	s.addTool(srv, mcp.NewTool("edit_message",
		mcp.WithDescription("Edit one of this agent's own messages. Allowed only while no agent has read it."),
		mcp.WithString("message_id", mcp.Required()),
		mcp.WithString("body", mcp.Required(), mcp.Description("New markdown body")),
	), s.editMessage)

	s.addTool(srv, mcp.NewTool("delete_message",
		mcp.WithDescription("Delete one of this agent's own messages. Allowed only while no agent has read it."),
		mcp.WithString("message_id", mcp.Required()),
	), s.deleteMessage)

	s.addTool(srv, mcp.NewTool("create_thread",
		mcp.WithDescription("Open (or get) the thread rooted at a message: a focused side conversation. Use it for anything bigger than a quick answer — plans in progress, multi-step work, open questions, anything that needs back-and-forth — so the channel stays readable. Posts a 'started a thread' notice into the channel. One thread per message; threads cannot nest. Afterwards post into it via send_message with conversation_id=<thread id>."),
		mcp.WithString("message_id", mcp.Required()),
		mcp.WithString("title", mcp.Description("Optional thread title; defaults to the parent excerpt")),
		mcp.WithNumber("ttl_hours", mcp.Description("Hours until the thread expires. Default 120 (5 days); a negative value makes it permanent.")),
	), s.createThread)

	s.addTool(srv, mcp.NewTool("request_input",
		mcp.WithDescription("Ask a person for input and keep the exchange in one place: opens a thread on the given message (if it isn't already in one), then posts your question inside it @mentioning the user so it lands in their inbox and push. Use this whenever you are blocked on a human — missing context, a decision, credentials — instead of leaving a bare channel message."),
		mcp.WithString("message_id", mcp.Required(), mcp.Description("the message your question responds to; the thread roots on it (or on itself when it already lives in a thread)")),
		mcp.WithString("user", mcp.Required(), mcp.Description("workspace member name to @mention, e.g. tdvorak")),
		mcp.WithString("question", mcp.Required(), mcp.Description("what you need from them")),
	), s.requestInput)

	s.addTool(srv, mcp.NewTool("resolve_input",
		mcp.WithDescription("Mark a request_input question resolved: removes its 'needs-input' tag and, when note is given, posts the answer into the same thread. Call this when the user answered you outside Relay (e.g. in your CLI/IDE harness) so the chat thread shows the question is handled."),
		mcp.WithString("message_id", mcp.Required(), mcp.Description("the request_input question message id")),
		mcp.WithString("note", mcp.Description("optional: how it was resolved, e.g. 'answered in CLI — use staging env'")),
	), s.resolveInput)

	s.addTool(srv, mcp.NewTool("work_start",
		mcp.WithDescription("Announce you are starting work: posts one status message in the project conversation and opens a progress thread on it. Post ongoing updates into that thread with send_message silent=true — never as new top-level messages. Call work_stop when finished."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithString("title", mcp.Required(), mcp.Description("short description of the work, e.g. 'Fixing invite revocation'")),
		mcp.WithString("conversation_id", mcp.Description("override target conversation; defaults to the project chat")),
	), s.workStart)

	s.addTool(srv, mcp.NewTool("work_stop",
		mcp.WithDescription("Finish a work_start status message: clears its 'work-in-progress' tag and posts an optional summary into the progress thread. Always call when you finish or abandon the work so the chat shows the true state."),
		mcp.WithString("message_id", mcp.Required(), mcp.Description("the status message id returned by work_start")),
		mcp.WithString("summary", mcp.Description("optional closing summary posted into the thread")),
	), s.workStop)

	s.addTool(srv, mcp.NewTool("pin_message",
		mcp.WithDescription("Pin (or unpin) a message in its conversation. Pinned messages surface in the channel's pins list."),
		mcp.WithString("message_id", mcp.Required()),
		mcp.WithBoolean("pinned", mcp.Required(), mcp.Description("true to pin, false to unpin")),
	), s.pinMessage)

	s.addTool(srv, mcp.NewTool("list_pins",
		mcp.WithDescription("List a conversation's pinned messages, newest pin first."),
		mcp.WithString("conversation_id"),
		mcp.WithString("project_id", mcp.Description("shorthand for the project's conversation")),
	), s.listPins)

	s.addTool(srv, mcp.NewTool("forward_message",
		mcp.WithDescription("Forward a message into another granted project's conversation. The copy credits the original author."),
		mcp.WithString("message_id", mcp.Required()),
		mcp.WithString("project_id", mcp.Required(), mcp.Description("target project the agent is granted on")),
	), s.forwardMessage)

	s.addTool(srv, mcp.NewTool("react_to_message",
		mcp.WithDescription("Toggle an emoji reaction on a message."),
		mcp.WithString("message_id", mcp.Required()),
		mcp.WithString("emoji", mcp.Required(), mcp.Description("e.g. 👀 ✅ 🎉")),
	), s.reactToMessage)

	s.addTool(srv, mcp.NewTool("set_avatar",
		mcp.WithDescription("Set this agent's profile picture. Pass image_base64 (png/jpeg/gif/webp/avif, max 2 MiB decoded) or image_url and the server fetches it."),
		mcp.WithString("image_base64", mcp.Description("Base64-encoded image bytes")),
		mcp.WithString("image_url", mcp.Description("http(s) image URL the server downloads and stores")),
	), s.setAvatar)

	s.addTool(srv, mcp.NewTool("create_issue",
		mcp.WithDescription("Create an issue in a granted project."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithString("title", mcp.Required()),
		mcp.WithString("description"),
		mcp.WithString("priority", mcp.Description("none|low|medium|high|urgent")),
	), s.createIssue)

	s.addTool(srv, mcp.NewTool("update_issue",
		mcp.WithDescription("Update an issue's title/description/status/priority."),
		mcp.WithString("issue_id", mcp.Required()),
		mcp.WithString("title"),
		mcp.WithString("description"),
		mcp.WithString("status", mcp.Description("backlog|todo|in_progress|review|done|cancelled")),
		mcp.WithString("priority", mcp.Description("none|low|medium|high|urgent")),
	), s.updateIssue)

	s.addTool(srv, mcp.NewTool("github_list_issues",
		mcp.WithDescription("List open GitHub issues on the project's linked repository."),
		mcp.WithString("project_id", mcp.Required()),
	), s.ghListIssues)

	s.addTool(srv, mcp.NewTool("github_get_issue",
		mcp.WithDescription("Get one GitHub issue (with body) from the project's linked repository."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithNumber("number", mcp.Required()),
	), s.ghGetIssue)

	s.addTool(srv, mcp.NewTool("github_list_prs",
		mcp.WithDescription("List pull requests on the project's linked repository."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithString("state", mcp.Description("open|closed|merged|all — default open; merged selects merged PRs")),
		mcp.WithString("author", mcp.Description("GitHub login of the PR author")),
		mcp.WithString("q", mcp.Description("Search query narrowing the list (title/body search syntax)")),
	), s.ghListPRs)

	s.addTool(srv, mcp.NewTool("github_get_pr",
		mcp.WithDescription("Get one pull request from the project's linked repository."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithNumber("number", mcp.Required()),
	), s.ghGetPR)

	s.addTool(srv, mcp.NewTool("github_create_issue",
		mcp.WithDescription("File a new issue on the project's linked GitHub repository. The issue is mirrored onto the project board."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithString("title", mcp.Required()),
		mcp.WithString("body"),
	), s.ghCreateIssue)

	s.addTool(srv, mcp.NewTool("github_create_pr",
		mcp.WithDescription("Open a pull request on the project's linked repository. head = source branch, base defaults to the repo's default branch."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithString("head", mcp.Required()),
		mcp.WithString("title", mcp.Required()),
		mcp.WithString("base"),
		mcp.WithString("body"),
		mcp.WithBoolean("draft"),
	), s.ghCreatePR)

	s.addTool(srv, mcp.NewTool("github_comment",
		mcp.WithDescription("Post a comment on a GitHub issue or pull request."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithNumber("number", mcp.Required()),
		mcp.WithString("body", mcp.Required()),
	), s.ghComment)

	s.addTool(srv, mcp.NewTool("github_review_pr",
		mcp.WithDescription("Submit a review on a pull request. event = APPROVE | REQUEST_CHANGES | COMMENT. body required for REQUEST_CHANGES."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithNumber("number", mcp.Required()),
		mcp.WithString("event", mcp.Required(), mcp.Enum("APPROVE", "REQUEST_CHANGES", "COMMENT")),
		mcp.WithString("body"),
	), s.ghReviewPR)

	s.addTool(srv, mcp.NewTool("github_pr_state",
		mcp.WithDescription("Close or reopen a pull request."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithNumber("number", mcp.Required()),
		mcp.WithString("state", mcp.Required(), mcp.Enum("open", "closed")),
	), s.ghSetPRState)

	s.addTool(srv, mcp.NewTool("github_merge_pr",
		mcp.WithDescription("Merge a pull request. method = merge | squash | rebase. GitHub enforces branch protection and required checks; the call fails if GitHub refuses."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithNumber("number", mcp.Required()),
		mcp.WithString("method", mcp.Enum("merge", "squash", "rebase")),
	), s.ghMergePR)

	s.addTool(srv, mcp.NewTool("github_ci_runs",
		mcp.WithDescription("List recent GitHub Actions workflow runs for the project's linked repository."),
		mcp.WithString("project_id", mcp.Required()),
	), s.ghCIRuns)

	s.addTool(srv, mcp.NewTool("github_rerun",
		mcp.WithDescription("Rerun a completed GitHub Actions workflow run."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithNumber("run_id", mcp.Required()),
	), s.ghRerun)

	s.addTool(srv, mcp.NewTool("list_project_files",
		mcp.WithDescription("List one directory level of the project's linked local folder. Omit path for the root."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithString("path"),
	), s.listProjectFiles)

	s.addTool(srv, mcp.NewTool("read_project_file",
		mcp.WithDescription("Read a UTF-8 file (<=256KB) from the project's linked local folder."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithString("path", mcp.Required()),
	), s.readProjectFile)

	s.addTool(srv, mcp.NewTool("todo_list",
		mcp.WithDescription("List the project's todo/work-tracking list (agent-managed)."),
		mcp.WithString("project_id", mcp.Required()),
	), s.todoList)

	s.addTool(srv, mcp.NewTool("todo_add",
		mcp.WithDescription("Add a todo item to the project's work list. Optionally link an issue_id."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithString("content", mcp.Required()),
		mcp.WithString("issue_id"),
	), s.todoAdd)

	s.addTool(srv, mcp.NewTool("todo_update",
		mcp.WithDescription("Update a todo: content, status (todo|in_progress|done), done flag, or linked issue."),
		mcp.WithString("todo_id", mcp.Required()),
		mcp.WithString("content"),
		mcp.WithBoolean("done"),
		mcp.WithString("status", mcp.Description("todo|in_progress|done — preferred over done")),
		mcp.WithString("issue_id"),
	), s.todoUpdate)

	s.addTool(srv, mcp.NewTool("todo_delete",
		mcp.WithDescription("Delete a todo item."),
		mcp.WithString("todo_id", mcp.Required()),
	), s.todoDelete)

	s.addTool(srv, mcp.NewTool("todo_sync",
		mcp.WithDescription("Mirror your harness task list into Relay in one call: pass the full current list and this tool creates, updates, reorders, and deletes your todos to match. Items echo back the Relay id — pass it on later syncs to keep rows stable. Other agents' todos are untouched. Call it whenever your task list changes so the app shows live progress."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithArray("items", mcp.Required(), mcp.Description("ordered list: [{id?, content, status?, issue_id?}] — status todo|in_progress|done; omit id to create")),
	), s.todoSync)

	s.addTool(srv, mcp.NewTool("mark_message_read",
		mcp.WithDescription("Mark a message as read by this agent."),
		mcp.WithString("message_id", mcp.Required()),
	), s.markRead)

	s.addTool(srv, mcp.NewTool("list_mentionables",
		mcp.WithDescription("Everything addressable in a project: workspace members (@name), agents (@agent-slug), issues (KEY-1), and linked GitHub repos (owner/repo#N). Check this before @mentioning — request_input's user argument takes a member name from this list."),
		mcp.WithString("project_id", mcp.Required()),
	), s.listMentionables)

	// --- work reviews ---
	// Review payloads follow a fixed schema so the web UI can render a
	// consistent board: summary, per-file changes, autonomous decisions,
	// required human actions, verification steps, links.

	s.addTool(srv, mcp.NewTool("submit_review",
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
		mcp.WithArray("scenes", mcp.Items(map[string]any{"type": "object"}),
			mcp.Description("[{title, scene}] - optional diagrams embedded in the review. "+
				"'scene' is an Excalidraw scene object ({elements: [...]}) - keep to "+
				"rectangle|ellipse|diamond|arrow|line|text for the lightweight in-app viewer")),
		mcp.WithString("verify", mcp.Description("Markdown: how to verify the change works")),
		mcp.WithString("supersedes", mcp.Description("Review UUID this revision replaces")),
	), s.submitReview)

	s.addTool(srv, mcp.NewTool("get_review",
		mcp.WithDescription("Get one review with its status and any human response."),
		mcp.WithString("review_id", mcp.Required()),
	), s.getReview)

	s.addTool(srv, mcp.NewTool("list_reviews",
		mcp.WithDescription("List reviews in a granted project, newest first."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithString("status", mcp.Description("Filter: pending|approved|changes_requested|superseded")),
	), s.listReviews)

	s.addTool(srv, mcp.NewTool("await_review",
		mcp.WithDescription("Block until a review gets a human verdict (approved or changes_requested), "+
			"or timeout_s elapses. Use after submit_review when review_mode is 'gate'. Returns the review "+
			"with its final status and the responder's note."),
		mcp.WithString("review_id", mcp.Required()),
		mcp.WithNumber("timeout_s", mcp.Description("Max seconds to block, default 55, cap 55. Returns 'pending' on timeout — re-call to keep waiting. The cap stays under common proxy/client read timeouts so the stream can't be severed mid-flight.")),
	), s.awaitReview)

	// --- visual briefs ---
	// Briefs are Excalidraw-compatible scenes explaining a change set.
	// projects.brief_policy configures expectations: 'never' (agents must not
	// create), 'on_request' (create only when asked), 'pre_merge' (expected
	// before merge-worthy reviews).

	s.addTool(srv, mcp.NewTool("get_brief_policy",
		mcp.WithDescription("Get the project's brief policy (never|on_request|pre_merge) — call before deciding whether to produce a visual brief."),
		mcp.WithString("project_id", mcp.Required()),
	), s.getBriefPolicy)

	s.addTool(srv, mcp.NewTool("list_briefs",
		mcp.WithDescription("List visual briefs in a granted project, newest first."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithString("issue_id", mcp.Description("Filter by linked Relay issue UUID")),
	), s.listBriefs)

	s.addTool(srv, mcp.NewTool("get_brief",
		mcp.WithDescription("Get one brief including its scene JSON and comment conversation id."),
		mcp.WithString("brief_id", mcp.Required()),
	), s.getBrief)

	s.addTool(srv, mcp.NewTool("create_brief",
		mcp.WithDescription("Create a visual brief explaining a change. 'scene' is Excalidraw JSON "+
			"({elements: [...], appState?: {...}, files?: {...}}). Full Excalidraw vocabulary is accepted "+
			"and renders in the app's embedded editor; keep to rectangle|ellipse|diamond|arrow|line|text "+
			"with x, y, width, height, text?/label via bound text, strokeColor?, backgroundColor? if you "+
			"want the lightweight in-app SVG viewer to render it too. The brief gets its own conversation "+
			"(returned as conversation_id) — post walkthrough notes there with send_message and iterate on "+
			"comments. Fails if the project's brief policy is 'never'."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithString("title", mcp.Required(), mcp.Description("One-line title, <= 200 chars")),
		mcp.WithString("summary", mcp.Description("Plain-language summary of what the diagram explains")),
		mcp.WithString("issue_id", mcp.Description("Linked Relay issue UUID")),
		mcp.WithString("scene", mcp.Description("Excalidraw scene as a JSON string")),
	), s.createBrief)

	s.addTool(srv, mcp.NewTool("update_brief",
		mcp.WithDescription("Update a brief's title, summary, status (open|resolved|archived), or replace its "+
			"Excalidraw scene after feedback. Scenes edited by users in the app's embedded Excalidraw editor "+
			"come back as full Excalidraw JSON — preserve elements/files fields when revising."),
		mcp.WithString("brief_id", mcp.Required()),
		mcp.WithString("title"),
		mcp.WithString("summary"),
		mcp.WithString("status", mcp.Description("open|resolved|archived")),
		mcp.WithString("scene", mcp.Description("Replacement Excalidraw scene JSON")),
	), s.updateBrief)

	s.addTool(srv, mcp.NewTool("delete_brief",
		mcp.WithDescription("Delete a brief and its comment conversation. Irreversible."),
		mcp.WithString("brief_id", mcp.Required()),
	), s.deleteBrief)

	// --- ideas ---
	// Ideas are brainstorm docs (Excalidraw scenes: mindmaps, sketches) a human
	// or agent drafts before real work exists. They reuse the brief scopes —
	// same visual-doc family — and convert into issues via idea_to_issue.

	s.addTool(srv, mcp.NewTool("list_ideas",
		mcp.WithDescription("List brainstorm ideas in a granted project, recently updated first."),
		mcp.WithString("project_id", mcp.Required()),
	), s.listIdeas)

	s.addTool(srv, mcp.NewTool("get_idea",
		mcp.WithDescription("Get one idea including its Excalidraw scene JSON."),
		mcp.WithString("idea_id", mcp.Required()),
	), s.getIdea)

	s.addTool(srv, mcp.NewTool("create_idea",
		mcp.WithDescription("Create a brainstorm idea on a granted project: title, plain-language summary, "+
			"and an optional Excalidraw scene ({elements: [...]}) for mindmaps/sketches. Use this to park "+
			"half-formed work on the Ideas page until it's worth an issue."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithString("title", mcp.Required(), mcp.Description("One-line title, <= 200 chars")),
		mcp.WithString("summary", mcp.Description("What the idea is about")),
		mcp.WithString("scene", mcp.Description("Excalidraw scene as a JSON string")),
	), s.createIdea)

	s.addTool(srv, mcp.NewTool("update_idea",
		mcp.WithDescription("Update an idea's title, summary, status (open|converted|archived), or scene JSON."),
		mcp.WithString("idea_id", mcp.Required()),
		mcp.WithString("title"),
		mcp.WithString("summary"),
		mcp.WithString("status", mcp.Description("open|converted|archived")),
		mcp.WithString("scene", mcp.Description("Replacement Excalidraw scene JSON")),
	), s.updateIdea)

	s.addTool(srv, mcp.NewTool("delete_idea",
		mcp.WithDescription("Delete an idea. Irreversible."),
		mcp.WithString("idea_id", mcp.Required()),
	), s.deleteIdea)

	s.addTool(srv, mcp.NewTool("idea_to_issue",
		mcp.WithDescription("Convert an idea into a backlog issue on its project (requires issue:write). "+
			"The idea is kept, marked 'converted'."),
		mcp.WithString("idea_id", mcp.Required()),
		mcp.WithString("title", mcp.Description("Issue title — defaults to the idea's title")),
		mcp.WithString("description", mcp.Description("Issue body — defaults to the idea's summary")),
	), s.ideaToIssue)
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
		truncated := false
		if m.ParentDeleted.Bool {
			preview = ""
		} else if len([]rune(preview)) > 160 {
			preview = string([]rune(preview)[:160]) + "…"
			truncated = true
		}
		parent = gin.H{
			"id":      m.ParentID.String(),
			"author":  m.ParentAuthorName,
			"preview": preview,
			"deleted": m.ParentDeleted.Bool,
			// true when preview was cut — the full body needs get_message on id
			"truncated": truncated,
		}
	}
	var mrefs any
	if len(m.Mentions) > 0 {
		_ = json.Unmarshal(m.Mentions, &mrefs)
	}
	if mrefs == nil {
		mrefs = []any{}
	}
	var thread any
	if m.ThreadID.Valid {
		thread = gin.H{
			"id":          m.ThreadID.String(),
			"title":       m.ThreadTitle.String,
			"reply_count": m.ThreadReplyCount,
		}
	}
	var pinnedAt any
	if m.PinnedAt.Valid {
		pinnedAt = m.PinnedAt.Time
	}
	var forwarded any
	if m.ForwardedFrom.Valid {
		forwarded = gin.H{
			"message_id":      m.ForwardedFrom.String(),
			"conversation_id": m.FwdConversationID.String(),
			"project_id":      m.FwdProjectID.String(),
			"author":          m.FwdAuthorName,
		}
	}
	var meta any
	if len(m.Meta) > 0 {
		_ = json.Unmarshal(m.Meta, &meta)
	}
	return gin.H{
		"id":              m.ID,
		"conversation_id": m.ConversationID,
		"body":            m.Body,
		"mentions":        mrefs,
		"tags":            m.Tags,
		"meta":            meta,
		"silent":          m.Silent,
		"parent":          parent,
		"thread":          thread,
		"pinned_at":       pinnedAt,
		"forwarded":       forwarded,
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

// excerpt collapses whitespace and cuts s at n runes; the bool reports
// truncation so callers can emit truncated:true. minimal:true read modes
// and the inbox/activity feeds use it to bound payload size.
func excerpt(s string, n int) (string, bool) {
	s = strings.Join(strings.Fields(s), " ")
	r := []rune(s)
	if len(r) <= n {
		return s, false
	}
	return string(r[:n]) + "…", true
}

// resolveMentions binds extracted refs to rows. Same contract as the REST
// path — agents see ids and URLs for what a message references.
func (s *Service) resolveMentions(ctx context.Context, projectID pgtype.UUID, refs []mentions.Ref) []mentions.Ref {
	if len(refs) == 0 {
		return []mentions.Ref{}
	}
	wsID, _ := s.q.ProjectWorkspaceID(ctx, projectID)
	for i := range refs {
		r := &refs[i]
		switch r.Kind {
		case "user":
			if u, err := s.q.UserByNameInWorkspace(ctx,
				db.UserByNameInWorkspaceParams{WorkspaceID: wsID, Name: r.Ref}); err == nil {
				r.ID = u.ID.String()
				r.Label = u.Name
				r.Found = true
			}
		case "agent":
			if a, err := s.q.AgentBySlug(ctx,
				db.AgentBySlugParams{WorkspaceID: wsID, Slug: r.Ref}); err == nil {
				r.ID = a.ID.String()
				r.Label = a.Name
				r.Found = true
			}
		case "mention":
			if a, err := s.q.AgentBySlug(ctx,
				db.AgentBySlugParams{WorkspaceID: wsID, Slug: r.Ref}); err == nil {
				r.Kind = "agent"
				r.ID = a.ID.String()
				r.Label = a.Name
				r.Found = true
			} else if u, err := s.q.UserByNameInWorkspace(ctx,
				db.UserByNameInWorkspaceParams{WorkspaceID: wsID, Name: r.Ref}); err == nil {
				r.Kind = "user"
				r.ID = u.ID.String()
				r.Label = u.Name
				r.Found = true
			}
		case "issue":
			if it, err := s.q.IssueByKeyInProject(ctx,
				db.IssueByKeyInProjectParams{ProjectID: projectID, Key: r.Ref}); err == nil {
				r.ID = it.ID.String()
				r.Label = it.Key + " — " + it.Title
				r.Found = true
				if it.GithubUrl.Valid && it.GithubUrl.String != "" {
					r.URL = it.GithubUrl.String
				}
			}
		}
	}
	return refs
}

func authorKind(m db.GetMessageFullRow) string {
	if m.AuthorAgentID.Valid || m.AuthorKindSnapshot == "agent" {
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
	a := agent(ctx)
	rows, err := s.q.ListGrantedProjects(ctx, a.ID)
	if err != nil {
		return errResult(err)
	}
	unread := make(map[string]int)
	if urows, err := s.q.AgentProjectUnread(ctx, a.ID); err == nil {
		for _, u := range urows {
			unread[u.ProjectID.String()] = int(u.Unread)
		}
	}
	out := make([]gin.H, 0, len(rows))
	for _, p := range rows {
		out = append(out, gin.H{
			"id": p.ID, "key": p.Key, "name": p.Name, "description": p.Description,
			"unread_count": unread[p.ID.String()],
		})
	}
	return jsonResult(out)
}

func (s *Service) getProject(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	pid, err := uuidArg(req, "project_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
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
		return mcp.NewToolResultError(err.Error()), nil
	}
	if err := s.scope(ctx, pid, "message:read"); err != nil {
		return errResult(err)
	}
	rows, err := s.q.ListProjectConversations(ctx, pid)
	if err != nil {
		return errResult(err)
	}
	unread := make(map[string]int)
	if urows, err := s.q.AgentConversationUnread(ctx, db.AgentConversationUnreadParams{
		ProjectID: pid, AgentID: agent(ctx).ID,
	}); err == nil {
		for _, u := range urows {
			unread[u.ConversationID.String()] = int(u.Unread)
		}
	}
	// issue conversations carry no title — surface the computed key and
	// title so listings show "INV-3" instead of a bare UUID.
	pkey := ""
	if proj, err := s.q.GetProjectByID(ctx, pid); err == nil {
		pkey = proj.Key
	}
	minimal := req.GetBool("minimal", false)
	out := make([]gin.H, 0, len(rows))
	for _, c := range rows {
		e := gin.H{
			"id": c.ID, "kind": c.Kind, "issue_id": c.IssueID, "created_at": c.CreatedAt.Time,
			"unread_count":  unread[c.ID.String()],
			"message_count": c.MessageCount,
		}
		if c.LastMessageAt.Valid {
			e["last_message_at"] = c.LastMessageAt.Time
			e["last_author"] = c.LastAuthor
			if !minimal {
				ex, tr := excerpt(c.LastBody, 200)
				e["last_message_excerpt"] = ex
				if tr {
					e["last_message_truncated"] = true
				}
			}
		}
		if c.Title.Valid {
			e["name"] = c.Title.String
		}
		if c.IssueNumber.Valid {
			e["issue_key"] = fmt.Sprintf("%s-%d", pkey, c.IssueNumber.Int32)
			if c.IssueTitle.Valid {
				e["issue_title"] = c.IssueTitle.String
			}
		}
		if c.ExpiresAt.Valid {
			e["expires_at"] = c.ExpiresAt.Time
		}
		out = append(out, e)
	}
	return jsonResult(out)
}

// listUnread is the server-side version of `relay-cli unread`: one row per
// conversation that has unread messages for this agent, across every
// granted project (or the one project_id scopes to). Each row carries the
// latest unread message's id + excerpt so an agent can triage without
// opening every conversation.
func (s *Service) listUnread(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	a := agent(ctx)
	var projects []db.Project
	if v := strings.TrimSpace(req.GetString("project_id", "")); v != "" {
		pid, err := uuidArg(req, "project_id")
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		if err := s.scope(ctx, pid, "message:read"); err != nil {
			return errResult(err)
		}
		p, err := s.q.GetProjectByID(ctx, pid)
		if err != nil {
			return errResult(err)
		}
		projects = []db.Project{{ID: p.ID, Key: p.Key, Name: p.Name}}
	} else {
		var err error
		projects, err = s.q.ListGrantedProjects(ctx, a.ID)
		if err != nil {
			return errResult(err)
		}
	}
	out := []gin.H{}
	for _, p := range projects {
		unread := make(map[string]db.AgentConversationUnreadRow)
		if urows, err := s.q.AgentConversationUnread(ctx, db.AgentConversationUnreadParams{
			ProjectID: p.ID, AgentID: a.ID,
		}); err == nil {
			for _, u := range urows {
				unread[u.ConversationID.String()] = u
			}
		}
		if len(unread) == 0 {
			continue
		}
		convs, err := s.q.ListProjectConversations(ctx, p.ID)
		if err != nil {
			return errResult(err)
		}
		for _, c := range convs {
			u, ok := unread[c.ID.String()]
			if !ok || u.Unread == 0 {
				continue
			}
			e := gin.H{
				"id": c.ID, "kind": c.Kind, "unread_count": int(u.Unread),
				"project": gin.H{"id": p.ID, "key": p.Key, "name": p.Name},
			}
			if u.LatestID.Valid {
				ex, tr := excerpt(u.LatestBody, 200)
				latest := gin.H{
					"message_id": u.LatestID, "author": u.LatestAuthor,
					"excerpt": ex, "at": u.LatestAt.Time,
				}
				if tr {
					latest["truncated"] = true
				}
				e["latest_unread"] = latest
			}
			if c.Title.Valid {
				e["name"] = c.Title.String
			}
			if c.IssueNumber.Valid {
				e["issue_key"] = fmt.Sprintf("%s-%d", p.Key, c.IssueNumber.Int32)
				if c.IssueTitle.Valid {
					e["issue_title"] = c.IssueTitle.String
				}
			}
			out = append(out, e)
		}
	}
	return jsonResult(gin.H{"unread": out})
}

// inbox answers "what is aimed at me" in one call: @mentions, replies to
// this agent's messages, and unread messages across granted conversations.
// Priority dedupes a message that qualifies under more than one lane
// (mention > reply > unread); rows carry excerpts, not bodies.
func (s *Service) inbox(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	a := agent(ctx)
	lim := clampInt(req.GetInt("limit", 50), 1, 100)
	// fetch over the cap so priority dedupe doesn't drop distinct lanes
	fetch := int32(lim)

	item := func(id, cid pgtype.UUID, body string, at pgtype.Timestamptz,
		pid pgtype.UUID, pkey, pname, author, kind, lane string, parent pgtype.UUID) gin.H {
		ex, tr := excerpt(body, 200)
		e := gin.H{
			"kind": lane, "message_id": id, "conversation_id": cid,
			"excerpt": ex, "truncated": tr, "at": at.Time,
			"author":  gin.H{"name": author, "kind": kind},
			"project": gin.H{"id": pid, "key": pkey, "name": pname},
		}
		if parent.Valid {
			e["parent_id"] = parent
		}
		return e
	}
	seen := map[string]bool{}
	out := []gin.H{}
	if rows, err := s.q.AgentInboxMentions(ctx, db.AgentInboxMentionsParams{
		AgentID: a.ID, Lim: fetch,
	}); err == nil {
		for _, r := range rows {
			seen[r.ID.String()] = true
			out = append(out, item(r.ID, r.ConversationID, r.Body, r.CreatedAt,
				r.ProjectID, r.ProjectKey, r.ProjectName, r.AuthorName, r.AuthorKind, "mention", pgtype.UUID{}))
		}
	}
	if rows, err := s.q.AgentInboxReplies(ctx, db.AgentInboxRepliesParams{
		AgentID: a.ID, Lim: fetch,
	}); err == nil {
		for _, r := range rows {
			if seen[r.ID.String()] {
				continue
			}
			seen[r.ID.String()] = true
			out = append(out, item(r.ID, r.ConversationID, r.Body, r.CreatedAt,
				r.ProjectID, r.ProjectKey, r.ProjectName, r.AuthorName, r.AuthorKind, "reply", r.ParentID))
		}
	}
	if rows, err := s.q.AgentInboxUnread(ctx, db.AgentInboxUnreadParams{
		AgentID: a.ID, Lim: fetch,
	}); err == nil {
		for _, r := range rows {
			if seen[r.ID.String()] {
				continue
			}
			seen[r.ID.String()] = true
			out = append(out, item(r.ID, r.ConversationID, r.Body, r.CreatedAt,
				r.ProjectID, r.ProjectKey, r.ProjectName, r.AuthorName, r.AuthorKind, "unread", pgtype.UUID{}))
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i]["at"].(time.Time).After(out[j]["at"].(time.Time))
	})
	if len(out) > lim {
		out = out[:lim]
	}
	return jsonResult(gin.H{"items": out})
}

// awaitMessage is the human-reply wait: block until a message from a
// different author lands in the conversation, or the timeout expires. The
// cap mirrors await_review — a streamable-HTTP call that outlives a client
// or proxy read timeout gets severed mid-flight and some MCP clients mark
// the whole transport dead, so 55s stays under the common ceilings and
// callers re-call to keep waiting.
func (s *Service) awaitMessage(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	cid, toolErr := s.resolveConversationArg(ctx, req)
	if toolErr != nil {
		return toolErr, nil
	}
	pid, err := s.q.ResolveConversationProject(ctx, cid)
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "message:read"); err != nil {
		return errResult(err)
	}
	a := agent(ctx)

	// latestUnread returns the newest unread message from another author —
	// the initial check doubles as the hub-less fallback poll.
	latestUnread := func() (*db.ListMessagesRow, error) {
		rows, err := s.q.ListMessages(ctx, db.ListMessagesParams{
			ConversationID: cid, Lim: 1,
			UnreadOnly: pgtype.Bool{Bool: true, Valid: true},
			Reader:     a.ID,
		})
		if err != nil || len(rows) == 0 {
			return nil, err
		}
		return &rows[0], nil
	}
	respond := func(mid pgtype.UUID) (*mcp.CallToolResult, error) {
		m, err := s.q.GetMessageFull(ctx, mid)
		if err != nil {
			return errResult(err)
		}
		return jsonResult(gin.H{"status": "message", "message": s.messageJSONFull(ctx, m)})
	}
	if r, err := latestUnread(); err == nil && r != nil {
		return respond(r.ID)
	}
	timeout := clampInt(req.GetInt("timeout_s", 55), 1, 55)
	timer := time.NewTimer(time.Duration(timeout) * time.Second)
	defer timer.Stop()

	if s.Bus == nil {
		// jarvis: poll fallback for hub-less deployments — 2s tick, still
		// ctx.Done-aware. LISTEN/NOTIFY is the upgrade if replicas appear.
		tick := time.NewTicker(2 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-tick.C:
				if r, err := latestUnread(); err == nil && r != nil {
					return respond(r.ID)
				}
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-timer.C:
				return jsonResult(gin.H{"status": "timeout"})
			}
		}
	}
	sub, ch := s.Bus.Subscribe()
	defer s.Bus.Unsubscribe(sub)
	cidStr := cid.String()
	for {
		select {
		case e, ok := <-ch:
			if !ok {
				return errResult(errors.New("event hub closed"))
			}
			if e.Type != "message.created" || e.Data["conversation_id"] != cidStr {
				continue
			}
			// own post bounced back through the bus isn't a reply
			if msg, ok := e.Data["message"].(map[string]any); ok {
				if au, ok := msg["author"].(map[string]any); ok {
					if fmt.Sprint(au["id"]) == a.ID.String() {
						continue
					}
				}
			}
			if r, err := latestUnread(); err == nil && r != nil {
				return respond(r.ID)
			}
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-timer.C:
			return jsonResult(gin.H{"status": "timeout"})
		}
	}
}

// opsSummary is the agent-facing control center: same fold as the web
// /channels/:id/ops endpoint, gated by checkAgentConversation so
// agents_blocked channels stay dark.
func (s *Service) opsSummary(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	cid, err := uuidArg(req, "conversation_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	if err := s.checkAgentConversation(ctx, cid); err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	pid, err := s.q.ResolveConversationProject(ctx, cid)
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "message:read"); err != nil {
		return errResult(err)
	}
	rows, err := s.q.OpsStatusEvents(ctx, cid)
	if err != nil {
		return errResult(err)
	}
	out := conversations.OpsSummarize(rows, time.Now().UTC())
	out["conversation_id"] = cid.String()
	return jsonResult(out)
}

// checkAgentConversation refuses channels flagged agents_blocked and
// conversations past their expiry — the per-channel agent gate.
func (s *Service) checkAgentConversation(ctx context.Context, cid pgtype.UUID) error {
	conv, err := s.q.GetConversationByID(ctx, cid)
	if err != nil {
		return err
	}
	if conv.AgentsBlocked {
		return errors.New("this channel is not accessible to agents")
	}
	if conv.ExpiresAt.Valid && !conv.ExpiresAt.Time.After(time.Now()) {
		return errors.New("conversation expired")
	}
	return nil
}

// resolveConversationArg accepts a conversation_id, a project_id (whose
// conversation is created lazily), or a bare id that might be either.
func (s *Service) resolveConversationArg(ctx context.Context, req mcp.CallToolRequest) (pgtype.UUID, *mcp.CallToolResult) {
	if v := req.GetString("conversation_id", ""); v != "" {
		cid, err := uuidArg(req, "conversation_id")
		if err != nil {
			return pgtype.UUID{}, mcp.NewToolResultError("invalid conversation_id")
		}
		if err := s.checkAgentConversation(ctx, cid); err != nil {
			return pgtype.UUID{}, mcp.NewToolResultError(err.Error())
		}
		return cid, nil
	}
	if v := req.GetString("project_id", ""); v != "" {
		pid, err := uuidArg(req, "project_id")
		if err != nil {
			return pgtype.UUID{}, mcp.NewToolResultError("invalid project_id")
		}
		conv, err := s.q.GetProjectConversation(ctx, pid)
		if errors.Is(err, pgx.ErrNoRows) {
			// The id may be a conversation (brief/issue thread), not a
			// project — resolve first and only create for real projects.
			// The scope check must come before the insert: without it an
			// ungranted agent could create a conversation row inside a
			// foreign project even though the call itself errors.
			if _, cerr := s.q.ResolveConversationProject(ctx, pid); cerr == nil {
				if cerr := s.checkAgentConversation(ctx, pid); cerr != nil {
					return pgtype.UUID{}, mcp.NewToolResultError(cerr.Error())
				}
				return pid, nil
			}
			if err := s.scope(ctx, pid, "message:read"); err != nil {
				return pgtype.UUID{}, mcp.NewToolResultError(err.Error())
			}
			conv, err = s.q.CreateProjectConversation(ctx, pid)
		}
		if err != nil {
			return pgtype.UUID{}, mcp.NewToolResultError(err.Error())
		}
		return conv.ID, nil
	}
	return pgtype.UUID{}, mcp.NewToolResultError("conversation_id or project_id required")
}

func (s *Service) getMessages(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	cid, toolErr := s.resolveConversationArg(ctx, req)
	if toolErr != nil {
		return toolErr, nil
	}
	pid, err := s.q.ResolveConversationProject(ctx, cid)
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "message:read"); err != nil {
		return errResult(err)
	}
	lim := clampInt(req.GetInt("limit", 50), 1, 100)
	var tag pgtype.Text
	if v := strings.ToLower(strings.TrimSpace(req.GetString("tag", ""))); v != "" {
		tag = pgtype.Text{String: v, Valid: true}
	}
	// before is the page cursor — the older before_id name still works.
	var before pgtype.UUID
	if v := strings.TrimSpace(req.GetString("before", req.GetString("before_id", ""))); v != "" {
		if err := before.Scan(v); err != nil || !before.Valid {
			return mcp.NewToolResultError("invalid before"), nil
		}
	}
	var after pgtype.UUID
	if v := strings.TrimSpace(req.GetString("after", "")); v != "" {
		if err := after.Scan(v); err != nil || !after.Valid {
			return mcp.NewToolResultError("invalid after"), nil
		}
	}
	var kindFilter pgtype.Text
	if v := strings.ToLower(strings.TrimSpace(req.GetString("author_kind", ""))); v != "" {
		if v != "user" && v != "agent" && v != "system" {
			return mcp.NewToolResultError("invalid author_kind — user|agent|system"), nil
		}
		kindFilter = pgtype.Text{String: v, Valid: true}
	}
	unreadOnly := pgtype.Bool{Bool: req.GetBool("unread_only", false), Valid: true}
	rows, err := s.q.ListMessages(ctx, db.ListMessagesParams{
		ConversationID: cid, Lim: int32(lim), Tag: tag, Before: before,
		After: after, AuthorKind: kindFilter, UnreadOnly: unreadOnly,
		Reader: agent(ctx).ID,
	})
	if err != nil {
		return errResult(err)
	}
	// fetching is the agent's read receipt - it is what locks user edits.
	// Snapshot what it already read first so was_unread reports what was new.
	ids := make([]pgtype.UUID, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.ID)
	}
	readBefore := make(map[string]bool, len(rows))
	if rids, err := s.q.AgentOwnReadMessageIDs(ctx, db.AgentOwnReadMessageIDsParams{
		AgentID: agent(ctx).ID, Ids: ids,
	}); err == nil {
		for _, id := range rids {
			readBefore[id.String()] = true
		}
	}
	if err := s.q.MarkMessagesReadAgent(ctx, db.MarkMessagesReadAgentParams{
		AgentID: agent(ctx).ID, Ids: ids,
	}); err != nil {
		s.log.Warn("mark agent read", zap.Error(err))
	}
	newlyRead := make([]pgtype.UUID, 0, len(ids))
	for _, r := range rows {
		// own posts never get a receipt — the author is not a reader
		if !readBefore[r.ID.String()] && r.AuthorAgentID != agent(ctx).ID {
			newlyRead = append(newlyRead, r.ID)
		}
	}
	s.publishRead(ctx, cid, newlyRead)
	minimal := req.GetBool("minimal", false)
	var attsByMsg map[string][]gin.H
	if !minimal {
		attsByMsg = s.attachmentsByMessage(ctx, ids)
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		// own posts are never "new" to their author
		wasUnread := !readBefore[r.ID.String()] && r.AuthorAgentID != agent(ctx).ID
		if minimal {
			ex, tr := excerpt(r.Body, 200)
			out = append(out, gin.H{
				"id": r.ID, "conversation_id": r.ConversationID,
				"excerpt": ex, "truncated": tr,
				"created_at": r.CreatedAt.Time,
				"author":     gin.H{"name": r.AuthorName, "kind": authorKind(db.GetMessageFullRow(r))},
				"was_unread": wasUnread,
			})
			continue
		}
		m := messageJSON(db.GetMessageFullRow(r))
		m["attachments"] = attsByMsg[r.ID.String()]
		m["was_unread"] = wasUnread
		out = append(out, m)
	}
	// next_before continues the page — the oldest row's id is the cursor.
	res := gin.H{"messages": out}
	if len(rows) == lim {
		res["next_before"] = rows[len(rows)-1].ID.String()
	}
	return jsonResult(res)
}

func (s *Service) getMessage(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	mid, err := uuidArg(req, "message_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
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
	own := m.AuthorAgentID == agent(ctx).ID
	wasUnread := !own
	if rids, err := s.q.AgentOwnReadMessageIDs(ctx, db.AgentOwnReadMessageIDsParams{
		AgentID: agent(ctx).ID, Ids: []pgtype.UUID{mid},
	}); err == nil && len(rids) > 0 {
		wasUnread = false
	}
	if !own {
		_ = s.q.MarkMessageReadAgent(ctx, db.MarkMessageReadAgentParams{
			MessageID: mid, AgentID: agent(ctx).ID,
		})
		if wasUnread {
			s.publishRead(ctx, m.ConversationID, []pgtype.UUID{mid})
		}
	}
	out := s.messageJSONFull(ctx, m)
	out["was_unread"] = wasUnread
	return jsonResult(out)
}

func (s *Service) getAttachment(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	aid, err := uuidArg(req, "attachment_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
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
	out := gin.H{
		"id": a.ID, "filename": a.Filename, "content_type": a.ContentType,
		"size_bytes": a.SizeBytes,
		// Same-origin route, bearer rly_ auth — fetchable wherever /mcp is.
		// Agents should curl it to disk instead of decoding data_base64.
		"download_url": "/api/agent/attachments/" + a.ID.String() + "/download",
	}
	// Inline the bytes for small files so agents can consume them without a
	// second fetch. Images go out as a real MCP image content block —
	// vision-capable clients render it; everyone else uses download_url.
	const inlineMax = 8 << 20
	if a.SizeBytes > inlineMax {
		return jsonResult(out)
	}
	obj, err := s.store.Get(ctx, a.StorageKey)
	if err != nil {
		return errResult(err)
	}
	data, err := io.ReadAll(obj)
	_ = obj.Close()
	if err != nil {
		return errResult(err)
	}
	b64 := base64.StdEncoding.EncodeToString(data)
	if storage.InlineSafe(a.ContentType) {
		r, err := mcp.NewToolResultJSON(out)
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		r.Content = append(r.Content, mcp.NewImageContent(b64, a.ContentType))
		return r, nil
	}
	out["data_base64"] = b64
	return jsonResult(out)
}

// messageJSONFull is messageJSON plus the attachments list — the shape for
// MCP tool RESULT payloads. SSE broadcasts must use messageFrame instead,
// which carries the full MessageView wire shape live views expect.
func (s *Service) messageJSONFull(ctx context.Context, m db.GetMessageFullRow) gin.H {
	out := messageJSON(m)
	out["attachments"] = s.attachmentsJSON(ctx, m.ID)
	return out
}

// messageFrame renders one message for SSE broadcast in the exact
// MessageView wire shape the REST API serves (and the SPA consumes):
// reactions/read_by default to [], agent_read to false, the author avatar
// key is avatar_url (not avatar), timestamps are RFC3339 strings.
// Broadcasts must never use the slimmer messageJSON shape — an agent-shaped
// frame once crashed live-append in the browser (see #112; the client still
// normalizes for compatibility with older servers). Pure tool RESULT
// payloads intentionally keep the slim shape for agent-parser compatibility.
func (s *Service) messageFrame(ctx context.Context, m db.GetMessageFullRow) gin.H {
	out := messageJSON(m)
	out["id"] = m.ID.String()
	out["conversation_id"] = m.ConversationID.String()
	if author, ok := out["author"].(gin.H); ok {
		author["avatar_url"] = author["avatar"]
		delete(author, "avatar")
	}
	out["created_at"] = m.CreatedAt.Time.Format("2006-01-02T15:04:05Z07:00")
	if m.EditedAt.Valid {
		out["edited_at"] = m.EditedAt.Time.Format("2006-01-02T15:04:05Z07:00")
	} else {
		out["edited_at"] = nil
	}
	if th, ok := out["thread"].(gin.H); ok {
		var title any
		if m.ThreadTitle.Valid {
			title = m.ThreadTitle.String
		}
		th["title"] = title
	}
	if fwd, ok := out["forwarded"].(gin.H); ok {
		if !m.FwdProjectID.Valid {
			delete(fwd, "project_id")
		}
	}
	out["attachments"] = s.attachmentsJSON(ctx, m.ID)
	out["reactions"] = bucketReactions(s.reactionRows(ctx, m.ID))
	readers := mapReaders(s.readerRows(ctx, m.ID))
	out["read_by"] = readers
	out["agent_read"] = len(readers) > 0
	return out
}

func (s *Service) reactionRows(ctx context.Context, id pgtype.UUID) []db.ListReactionsForMessagesRow {
	rows, err := s.q.ListReactionsForMessages(ctx, []pgtype.UUID{id})
	if err != nil {
		return nil
	}
	return rows
}

func (s *Service) readerRows(ctx context.Context, id pgtype.UUID) []db.AgentReadersForMessagesRow {
	rows, err := s.q.AgentReadersForMessages(ctx, []pgtype.UUID{id})
	if err != nil {
		return nil
	}
	return rows
}

// bucketReactions aggregates reaction rows into the MessageView bucket
// shape (emoji/count/mine/names, first-seen emoji order). Broadcasts have
// no viewing user, so mine is always false. Pure — unit tested.
func bucketReactions(rows []db.ListReactionsForMessagesRow) []gin.H {
	type bucket struct {
		count int
		names []string
	}
	byEmoji := map[string]*bucket{}
	var order []string
	for _, r := range rows {
		b, ok := byEmoji[r.Emoji]
		if !ok {
			b = &bucket{}
			byEmoji[r.Emoji] = b
			order = append(order, r.Emoji)
		}
		b.count++
		if len(b.names) < 8 {
			b.names = append(b.names, r.ReactorName)
		}
	}
	out := make([]gin.H, 0, len(order))
	for _, emoji := range order {
		b := byEmoji[emoji]
		out = append(out, gin.H{
			"emoji": emoji, "count": b.count, "mine": false, "names": b.names,
		})
	}
	return out
}

// mapReaders renders agent read receipts in the MessageView shape.
// Pure — unit tested.
func mapReaders(rows []db.AgentReadersForMessagesRow) []gin.H {
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		var avatar *string
		if r.AvatarKey.Valid {
			a := "/api/files/" + r.AvatarKey.String
			avatar = &a
		}
		out = append(out, gin.H{
			"id": r.AgentID.String(), "name": r.Name,
			"avatar_url": avatar,
			"read_at":    r.ReadAt.Time.Format("2006-01-02T15:04:05Z07:00"),
		})
	}
	return out
}

// attachmentsByMessage batches one ListAttachmentsForMessages call across a
// page of messages so list endpoints don't run a query per row.
func (s *Service) attachmentsByMessage(ctx context.Context, ids []pgtype.UUID) map[string][]gin.H {
	out := make(map[string][]gin.H, len(ids))
	if len(ids) == 0 {
		return out
	}
	rows, err := s.q.ListAttachmentsForMessages(ctx, ids)
	if err != nil {
		return out
	}
	for _, r := range rows {
		mid := r.MessageID.String()
		out[mid] = append(out[mid], attachments.JSON(db.Attachment{
			ID: r.ID, ProjectID: r.ProjectID, Filename: r.Filename,
			ContentType: r.ContentType, SizeBytes: r.SizeBytes, CreatedAt: r.CreatedAt,
		}))
	}
	return out
}

// attachmentsJSON returns the API-shaped attachment list for one message —
// kept out of messageJSON, which has no query context.
func (s *Service) attachmentsJSON(ctx context.Context, messageID pgtype.UUID) []gin.H {
	rows, err := s.q.ListAttachmentsForMessages(ctx, []pgtype.UUID{messageID})
	if err != nil {
		return []gin.H{}
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, attachments.JSON(db.Attachment{
			ID: r.ID, ProjectID: r.ProjectID, Filename: r.Filename,
			ContentType: r.ContentType, SizeBytes: r.SizeBytes, CreatedAt: r.CreatedAt,
		}))
	}
	return out
}

func (s *Service) uploadAttachment(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if s.limited {
		return mcp.NewToolResultError("this hosted instance does not store files — self-host Relay for attachments"), nil
	}
	if s.store == nil {
		return mcp.NewToolResultError("storage not configured"), nil
	}
	pid, err := uuidArg(req, "project_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	if err := s.scope(ctx, pid, "attachment:write"); err != nil {
		return errResult(err)
	}
	name, err := req.RequireString("name")
	if err != nil {
		return mcp.NewToolResultError("name required"), nil
	}
	raw, err := req.RequireString("data_base64")
	if err != nil {
		return mcp.NewToolResultError("data_base64 required"), nil
	}
	data, err := base64.StdEncoding.DecodeString(raw)
	if err != nil || len(data) == 0 {
		return mcp.NewToolResultError("data_base64 is not valid base64"), nil
	}
	if int64(len(data)) > s.maxUpload {
		return mcp.NewToolResultError("file exceeds the upload size cap"), nil
	}
	contentType := attachments.SniffType(data, req.GetString("content_type", ""))
	name = path.Base(name)
	if name == "." || name == "/" || name == "" {
		name = "file"
	}
	id := uuid.New()
	key := pid.String() + "/" + id.String()
	if err := s.store.Put(ctx, key, bytes.NewReader(data), int64(len(data)), contentType); err != nil {
		return errResult(err)
	}
	row, err := s.q.CreateAgentAttachment(ctx, db.CreateAgentAttachmentParams{
		ID:        pgtype.UUID{Bytes: id, Valid: true},
		ProjectID: pid, UploaderAgentID: agent(ctx).ID,
		StorageKey: key, Filename: name,
		ContentType: contentType, SizeBytes: int64(len(data)),
	})
	if err != nil {
		_ = s.store.Remove(ctx, key)
		return errResult(err)
	}
	row, err = s.q.MarkAttachmentReady(ctx, row.ID)
	if err != nil {
		return errResult(err)
	}
	return jsonResult(attachments.JSON(row))
}

func (s *Service) searchMessages(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	pid, err := uuidArg(req, "project_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	if err := s.scope(ctx, pid, "message:read"); err != nil {
		return errResult(err)
	}
	q := strings.TrimSpace(req.GetString("query", ""))
	lim := clampInt(req.GetInt("limit", 20), 1, 100)
	sp := db.SearchMessagesInProjectParams{ProjectID: pid, Lim: int32(lim)}
	var terms []string
	for _, tok := range strings.Fields(q) {
		k, v, ok := strings.Cut(tok, ":")
		switch {
		case !ok || v == "":
			terms = append(terms, tok)
		case k == "from":
			sp.Author = pgtype.Text{String: v, Valid: true}
		case k == "in":
			sp.Chan = pgtype.Text{String: v, Valid: true}
		case k == "has" && (v == "image" || v == "file"):
			if v == "image" {
				sp.HasImage = pgtype.Bool{Bool: true, Valid: true}
			} else {
				sp.HasFile = pgtype.Bool{Bool: true, Valid: true}
			}
		case k == "before" || k == "after":
			ts, err := parseSearchDate(v)
			if err != nil {
				return mcp.NewToolResultError("bad " + k + ": date — use YYYY-MM-DD or RFC3339"), nil
			}
			if k == "before" {
				sp.BeforeTs = ts
			} else {
				sp.AfterTs = ts
			}
		default:
			terms = append(terms, tok)
		}
	}
	// explicit args win over the inline operators
	if v := strings.TrimSpace(req.GetString("author_name", "")); v != "" {
		sp.Author = pgtype.Text{String: v, Valid: true}
	}
	if v := strings.ToLower(strings.TrimSpace(req.GetString("author_kind", ""))); v != "" {
		if v != "user" && v != "agent" && v != "system" {
			return mcp.NewToolResultError("invalid author_kind — user|agent|system"), nil
		}
		sp.AuthorKind = pgtype.Text{String: v, Valid: true}
	}
	if v := strings.TrimSpace(req.GetString("conversation_id", "")); v != "" {
		var cid pgtype.UUID
		if err := cid.Scan(v); err != nil || !cid.Valid {
			return mcp.NewToolResultError("invalid conversation_id"), nil
		}
		sp.ConversationID = cid
	}
	for _, arg := range [][2]string{{"since", "after_ts"}, {"until", "before_ts"}} {
		if v := strings.TrimSpace(req.GetString(arg[0], "")); v != "" {
			ts, err := parseSearchDate(v)
			if err != nil {
				return mcp.NewToolResultError("bad " + arg[0] + " — use YYYY-MM-DD or RFC3339"), nil
			}
			if arg[0] == "since" {
				sp.AfterTs = ts
			} else {
				sp.BeforeTs = ts
			}
		}
	}
	if b, ok := optionalBool(req, "has_attachments"); ok {
		sp.HasAttachments = pgtype.Bool{Bool: b, Valid: true}
	}
	if rest := strings.Join(terms, " "); strings.TrimSpace(rest) != "" {
		sp.Q = pgtype.Text{String: rest, Valid: true}
	}
	rows, err := s.q.SearchMessagesInProject(ctx, sp)
	if err != nil {
		return errResult(err)
	}
	total := 0
	if len(rows) > 0 {
		total = int(rows[0].Total)
	}
	minimal := req.GetBool("minimal", false)
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		// excerpt centers on the first match; unmatched hits lead from the top
		body := r.Body
		needle := sp.Q.String
		idx := -1
		if needle != "" {
			idx = strings.Index(strings.ToLower(body), strings.ToLower(needle))
		}
		if idx > 40 {
			body = "…" + body[idx-40:]
		}
		ex, tr := excerpt(body, 200)
		e := gin.H{
			"id": r.ID, "conversation_id": r.ConversationID,
			"excerpt": ex, "truncated": tr,
			"created_at": r.CreatedAt.Time, "author_name": r.AuthorName,
			"author_kind":       r.AuthorKindSnapshot,
			"conversation_kind": r.ConversationKind,
			"has_attachments":   r.HasAttachments,
		}
		if !minimal {
			e["body"] = r.Body
			e["tags"] = r.Tags
		}
		if r.ConversationTitle.Valid {
			e["conversation_title"] = r.ConversationTitle.String
		}
		out = append(out, e)
	}
	return jsonResult(gin.H{"total": total, "results": out})
}

// optionalBool distinguishes "unset" from false — tri-state filters like
// has_attachments need all three positions.
func optionalBool(req mcp.CallToolRequest, name string) (bool, bool) {
	v, ok := req.GetArguments()[name]
	if !ok {
		return false, false
	}
	b, ok := v.(bool)
	return b, ok
}

// parseSearchDate accepts YYYY-MM-DD or full RFC3339 for the before:/after:
// search operators.
func parseSearchDate(v string) (pgtype.Timestamptz, error) {
	for _, layout := range []string{"2006-01-02", time.RFC3339} {
		if t, err := time.Parse(layout, v); err == nil {
			return pgtype.Timestamptz{Time: t, Valid: true}, nil
		}
	}
	return pgtype.Timestamptz{}, errors.New("bad date")
}

func (s *Service) listIssues(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	pid, err := uuidArg(req, "project_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	if err := s.scope(ctx, pid, "issue:read"); err != nil {
		return errResult(err)
	}
	lim := clampInt(req.GetInt("limit", 50), 1, 200)
	var status pgtype.Text
	if v := strings.ToLower(strings.TrimSpace(req.GetString("status", ""))); v != "" {
		status = pgtype.Text{String: v, Valid: true}
	}
	rows, err := s.q.ListProjectIssuesForAgent(ctx, db.ListProjectIssuesForAgentParams{
		ProjectID: pid, Lim: int32(lim), Status: status,
	})
	if err != nil {
		return errResult(err)
	}
	pKey, _ := s.projectKey(ctx, pid)
	minimal := req.GetBool("minimal", false)
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		j := issueJSON(issueFromRow(r), r.AssigneeName, pKey)
		if minimal {
			ex, tr := excerpt(r.Description, 200)
			delete(j, "description")
			j["excerpt"] = ex
			j["truncated"] = tr
		}
		out = append(out, j)
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
		return mcp.NewToolResultError(err.Error()), nil
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
	pKey, _ := s.projectKey(ctx, pid)
	out := issueJSON(db.Issue{
		ID: r.ID, ProjectID: r.ProjectID, Number: r.Number, Title: r.Title,
		Description: r.Description, Status: r.Status, Priority: r.Priority,
		AssigneeID: r.AssigneeID, AgentID: r.AgentID, CreatedBy: r.CreatedBy,
		CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
	}, r.AssigneeName, pKey)
	if req.GetBool("minimal", false) {
		ex, tr := excerpt(r.Description, 200)
		delete(out, "description")
		out["excerpt"] = ex
		out["truncated"] = tr
	}
	return jsonResult(out)
}

func (s *Service) projectKey(ctx context.Context, pid pgtype.UUID) (string, error) {
	p, err := s.q.GetProjectByID(ctx, pid)
	if err != nil {
		return "", err
	}
	return p.Key, nil
}

func issueJSON(i db.Issue, assigneeName pgtype.Text, projectKey string) gin.H {
	return gin.H{
		"id": i.ID, "project_id": i.ProjectID, "number": i.Number,
		"key":   projectKey + "-" + strconv.Itoa(int(i.Number)),
		"title": i.Title, "description": i.Description,
		"status": i.Status, "priority": i.Priority,
		"assignee_id": i.AssigneeID, "assignee_name": assigneeName.String,
		"agent_id": i.AgentID, "created_at": i.CreatedAt.Time,
	}
}

func (s *Service) sendMessage(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var cid pgtype.UUID
	var pid pgtype.UUID
	// conversation_id is an explicit override — the tool schema documents it
	// as the target and callers legitimately pass both ids (channel inside a
	// project). Read it first; silently preferring project_id posted to the
	// project's main conversation instead of the requested channel.
	if v := req.GetString("conversation_id", ""); v != "" {
		var err error
		cid, err = uuidArg(req, "conversation_id")
		if err != nil {
			return mcp.NewToolResultError("invalid conversation_id"), nil
		}
		pid, err = s.q.ResolveConversationProject(ctx, cid)
		if err != nil {
			return errResult(err)
		}
		if err := s.scope(ctx, pid, "message:write"); err != nil {
			return errResult(err)
		}
	} else if v := req.GetString("project_id", ""); v != "" {
		if err := pid.Scan(v); err != nil || !pid.Valid {
			return mcp.NewToolResultError("invalid project_id"), nil
		}
		conv, err := s.q.GetProjectConversation(ctx, pid)
		if errors.Is(err, pgx.ErrNoRows) {
			// A conversation UUID lands here too (brief/issue threads).
			if cres, cerr := s.q.ResolveConversationProject(ctx, pid); cerr == nil {
				cid = pid
				pid = cres
			} else {
				// Real project with no conversation yet — scope before
				// create so an ungranted agent can't insert a row here.
				if err := s.scope(ctx, pid, "message:write"); err != nil {
					return errResult(err)
				}
				conv, err = s.q.CreateProjectConversation(ctx, pid)
				if err != nil {
					return errResult(err)
				}
				cid = conv.ID
			}
		} else if err != nil {
			return errResult(err)
		} else {
			cid = conv.ID
		}
		if err := s.scope(ctx, pid, "message:write"); err != nil {
			return errResult(err)
		}
	} else if v := req.GetString("reply_to", ""); v != "" {
		// reply_to alone routes: resolve parent → its conversation → its
		// project → scope. One error for missing and ungranted so the id
		// can't be enumerated.
		var p pgtype.UUID
		if err := p.Scan(v); err != nil || !p.Valid {
			return mcp.NewToolResultError("invalid reply_to"), nil
		}
		parentMsg, err := s.q.GetMessageByID(ctx, p)
		if err != nil || parentMsg.DeletedAt.Valid {
			return mcp.NewToolResultError("reply_to not found or not granted"), nil
		}
		cid = parentMsg.ConversationID
		if pid, err = s.q.ResolveConversationProject(ctx, cid); err != nil {
			return mcp.NewToolResultError("reply_to not found or not granted"), nil
		}
		if err := s.scope(ctx, pid, "message:write"); err != nil {
			return mcp.NewToolResultError("reply_to not found or not granted"), nil
		}
	} else {
		return mcp.NewToolResultError("conversation_id or project_id required"), nil
	}
	body, err := req.RequireString("body")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	if strings.TrimSpace(body) == "" || len(body) > conversations.MaxMessageBodyChars {
		return mcp.NewToolResultError("body is empty or too large"), nil
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
	tags, terr := conversations.NormalizeTags(strings.Split(
		req.GetString("tags", ""), ","))
	if terr != nil {
		return mcp.NewToolResultError(terr.Error()), nil
	}
	silent := req.GetBool("silent", false)
	var attIDs []pgtype.UUID
	if v := req.GetString("attachment_ids", ""); v != "" {
		for _, s := range strings.Split(v, ",") {
			var aid pgtype.UUID
			if err := aid.Scan(strings.TrimSpace(s)); err != nil || !aid.Valid {
				return mcp.NewToolResultError("invalid attachment id"), nil
			}
			attIDs = append(attIDs, aid)
		}
	}
	if len(attIDs) > 20 {
		return mcp.NewToolResultError("too many attachments (max 20)"), nil
	}
	if len(attIDs) > 0 {
		n, err := s.q.CountUsableAttachmentsInProject(ctx,
			db.CountUsableAttachmentsInProjectParams{ProjectID: pid, Ids: attIDs})
		if err != nil {
			return errResult(err)
		}
		if int(n) != len(attIDs) {
			return mcp.NewToolResultError("attachments must be ready uploads in this project"), nil
		}
	}
	refs := s.resolveMentions(ctx, pid, mentions.Extract(body))
	mj, _ := json.Marshal(refs)
	// Optional structured meta — ops/status cards. Accepts a JSON object;
	// must be an object (not array/scalar) and stay under 8KiB.
	var meta []byte
	if v := strings.TrimSpace(req.GetString("meta", "")); v != "" {
		var probe map[string]any
		if err := json.Unmarshal([]byte(v), &probe); err != nil || probe == nil {
			return mcp.NewToolResultError("meta must be a JSON object"), nil
		}
		if len(v) > 8<<10 {
			return mcp.NewToolResultError("meta too large (8KiB max)"), nil
		}
		meta = []byte(v)
	}
	var clientMsgID pgtype.Text
	if v := strings.TrimSpace(req.GetString("client_msg_id", "")); v != "" {
		if len(v) > 200 {
			return mcp.NewToolResultError("client_msg_id too long (200 chars max)"), nil
		}
		clientMsgID = pgtype.Text{String: v, Valid: true}
	}
	id, err := s.q.CreateAgentMessage(ctx, db.CreateAgentMessageParams{
		ConversationID: cid, AgentID: agent(ctx).ID, Body: body, ParentID: parent,
		Mentions: mj, Tags: tags, Silent: silent, Meta: meta,
		ClientMsgID: clientMsgID,
	})
	if err != nil {
		// a repeat submit with the same client_msg_id no-ops in SQL —
		// return the original row instead of double-posting.
		if clientMsgID.Valid && errors.Is(err, pgx.ErrNoRows) {
			existing, lerr := s.q.GetMessageIDByClientMsgID(ctx, db.GetMessageIDByClientMsgIDParams{
				ConversationID: cid, ClientMsgID: clientMsgID,
			})
			if lerr != nil {
				return errResult(lerr)
			}
			m, gerr := s.q.GetMessageFull(ctx, existing)
			if gerr != nil {
				return errResult(gerr)
			}
			out := s.messageJSONFull(ctx, m)
			out["deduplicated"] = true
			return jsonResult(out)
		}
		return errResult(err)
	}
	for i, aid := range attIDs {
		if err := s.q.LinkMessageAttachment(ctx, db.LinkMessageAttachmentParams{
			MessageID: id, AttachmentID: aid, Position: int32(i),
		}); err != nil {
			return errResult(err)
		}
	}
	m, err := s.q.GetMessageFull(ctx, id)
	if err != nil {
		return errResult(err)
	}
	out := s.messageJSONFull(ctx, m)
	s.publish(ctx, cid, "message.created", map[string]any{"conversation_id": cid.String(), "message": s.messageFrame(ctx, m)})
	// A reply inside a thread bumps the parent message's chip live.
	if conv, err := s.q.GetConversationByID(ctx, cid); err == nil && conv.Kind == "thread" {
		if tr, err := s.q.GetThread(ctx, cid); err == nil {
			s.publish(ctx, tr.ParentConversationID, "thread.updated", map[string]any{
				"conversation_id":   tr.ParentConversationID.String(),
				"parent_message_id": tr.ParentMessageID.String(),
				"thread":            threadOut(tr),
			})
		}
	}
	// silent = no push; an @mention still earns one — that is the contract
	if s.Push != nil && (!silent || len(refs) > 0) {
		s.Push.NotifyMessage(pid, pgtype.UUID{}, body, m.ID,
			"/app/p/"+pid.String(), agent(ctx).Name,
			mentions.UserIDs(refs))
	}
	return jsonResult(out)
}

func (s *Service) createIssue(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	pid, err := uuidArg(req, "project_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	if err := s.scope(ctx, pid, "issue:write"); err != nil {
		return errResult(err)
	}
	title, err := req.RequireString("title")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
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
	pKey, _ := s.projectKey(ctx, pid)
	s.publishPID(pid, "issue.created", map[string]any{"issue": issueJSON(i, pgtype.Text{}, pKey)})
	return jsonResult(issueJSON(i, pgtype.Text{}, pKey))
}

func (s *Service) updateIssue(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	iid, err := uuidArg(req, "issue_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
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
	pKey, _ := s.projectKey(ctx, pid)
	s.publishPID(pid, "issue.updated", map[string]any{"issue": issueJSON(i, pgtype.Text{}, pKey)})
	return jsonResult(issueJSON(i, pgtype.Text{}, pKey))
}

// editMessage mirrors the REST rule: the author may edit only while no
// agent has read the message. Once any agent (this one included) has a
// read receipt on it, the message is locked.
func (s *Service) editMessage(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	mid, err := uuidArg(req, "message_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
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
		return mcp.NewToolResultError(err.Error()), nil
	}
	if strings.TrimSpace(body) == "" || len(body) > conversations.MaxMessageBodyChars {
		return mcp.NewToolResultError("body is empty or too large"), nil
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
		map[string]any{"conversation_id": m.ConversationID.String(), "message": s.messageFrame(ctx, m)})
	return jsonResult(s.messageJSONFull(ctx, m))
}

// deleteMessage mirrors the REST rule: the author may delete only while no
// agent has read the message. Replies keep a tombstone via parent_deleted.
func (s *Service) deleteMessage(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	mid, err := uuidArg(req, "message_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
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
	row, err := s.q.SoftDeleteMessageAgent(ctx, db.SoftDeleteMessageAgentParams{
		ID: mid, AuthorAgentID: agent(ctx).ID,
	})
	if err != nil {
		return errResult(errors.New("only the author can delete a message"))
	}
	s.publish(ctx, row.ConversationID, "message.deleted",
		map[string]any{"conversation_id": row.ConversationID.String(), "message_id": mid.String()})
	return jsonResult(map[string]any{"deleted": true, "message_id": mid.String()})
}

// openThread gets or creates the thread rooted at mid — the shared core of
// create_thread and request_input. Returns the GetThread row, whether it was
// just created, and the parent conversation id.
func (s *Service) openThread(ctx context.Context, mid, pid pgtype.UUID, title string, ttlHours *float64) (db.GetThreadRow, bool, pgtype.UUID, error) {
	var zero db.GetThreadRow
	parentConvID, err := s.q.GetMessageConversation(ctx, mid)
	if err != nil {
		return zero, false, pgtype.UUID{}, err
	}
	parentConv, err := s.q.GetConversationByID(ctx, parentConvID)
	if err != nil {
		return zero, false, pgtype.UUID{}, err
	}
	if parentConv.AgentsBlocked {
		return zero, false, pgtype.UUID{}, errors.New("this channel is not accessible to agents")
	}
	if parentConv.Kind == "thread" {
		return zero, false, pgtype.UUID{}, errors.New("threads cannot be nested")
	}
	expiresAt, err := agentThreadTTL(ttlHours)
	if err != nil {
		return zero, false, pgtype.UUID{}, err
	}
	title = strings.TrimSpace(title)
	if len([]rune(title)) > 120 {
		return zero, false, pgtype.UUID{}, errors.New("title too long (max 120)")
	}
	if title == "" {
		if m, err := s.q.GetMessageFull(ctx, mid); err == nil {
			title = strings.TrimSpace(m.Body)
			if len([]rune(title)) > 80 {
				title = string([]rune(title)[:80]) + "…"
			}
		}
	}
	conv, err := s.q.GetThreadByParentMessage(ctx, mid)
	created := false
	if err != nil {
		conv, err = s.q.CreateThreadAgent(ctx, db.CreateThreadAgentParams{
			ProjectID:       pid,
			ParentMessageID: mid,
			Title:           pgtype.Text{String: title, Valid: title != ""},
			CreatedByAgent:  agent(ctx).ID,
			ExpiresAt:       expiresAt,
		})
		if err != nil {
			if existing, e2 := s.q.GetThreadByParentMessage(ctx, mid); e2 == nil {
				conv = existing
			} else {
				return zero, false, pgtype.UUID{}, err
			}
		} else {
			created = true
		}
	}
	tr, err := s.q.GetThread(ctx, conv.ID)
	if err != nil {
		return zero, false, pgtype.UUID{}, err
	}
	if created {
		s.postThreadNotice(ctx, parentConvID, conv.ID, title)
		s.publishThreadCreated(ctx, tr)
	}
	return tr, created, parentConvID, nil
}

func (s *Service) publishThreadCreated(ctx context.Context, tr db.GetThreadRow) {
	s.publish(ctx, tr.ParentConversationID, "thread.created", map[string]any{
		"conversation_id":   tr.ParentConversationID.String(),
		"parent_message_id": tr.ParentMessageID.String(),
		"thread":            threadOut(tr),
	})
}

// agentThreadTTL maps the optional ttl_hours argument to expires_at:
// absent → 5-day default, negative → never expires.
func agentThreadTTL(ttl *float64) (pgtype.Timestamptz, error) {
	if ttl == nil {
		return pgtype.Timestamptz{Time: time.Now().Add(5 * 24 * time.Hour), Valid: true}, nil
	}
	if *ttl < 0 {
		return pgtype.Timestamptz{}, nil
	}
	if *ttl == 0 || *ttl > 24*365 {
		return pgtype.Timestamptz{}, errors.New("ttl_hours must be > 0 hours (or negative for never expires)")
	}
	return pgtype.Timestamptz{Time: time.Now().Add(time.Duration(*ttl * float64(time.Hour))), Valid: true}, nil
}

func threadOut(tr db.GetThreadRow) map[string]any {
	out := map[string]any{
		"id":                  tr.ID.String(),
		"parent_message_id":   tr.ParentMessageID.String(),
		"parent_conversation": tr.ParentConversationID.String(),
		"title":               tr.Title.String,
		"reply_count":         tr.ReplyCount,
		"created_by":          tr.CreatorName,
		"created_at":          tr.CreatedAt.Time.Format("2006-01-02T15:04:05Z07:00"),
	}
	if tr.ExpiresAt.Valid {
		out["expires_at"] = tr.ExpiresAt.Time.Format("2006-01-02T15:04:05Z07:00")
	}
	return out
}

// postThreadNotice drops a "started a thread" row into the parent channel so
// the new thread is discoverable from the message stream; the thread id rides
// in mentions (kind=thread) so clients can render the title as a link.
func (s *Service) postThreadNotice(ctx context.Context, parentConvID, threadID pgtype.UUID, title string) {
	refs, _ := json.Marshal([]gin.H{
		{"kind": "thread", "ref": threadID.String(), "id": threadID.String(), "label": title},
	})
	body := "started a thread"
	if title != "" {
		body += ": " + title
	}
	mid, err := s.q.CreateAgentMessage(ctx, db.CreateAgentMessageParams{
		ConversationID: parentConvID, AgentID: agent(ctx).ID, Body: body, Mentions: refs,
	})
	if err != nil {
		return
	}
	if m, err := s.q.GetMessageFull(ctx, mid); err == nil {
		s.publish(ctx, parentConvID, "message.created",
			map[string]any{"conversation_id": parentConvID.String(), "message": s.messageFrame(ctx, m)})
	}
}

// createThread mirrors POST /messages/:id/thread: idempotent per parent
// message, titles fall back to the excerpt, nesting is refused.
func (s *Service) createThread(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	mid, err := uuidArg(req, "message_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	pid, err := s.q.ResolveMessageProject(ctx, mid)
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "message:write"); err != nil {
		return errResult(err)
	}
	title, _ := req.GetArguments()["title"].(string)
	var ttl *float64
	if v, ok := req.GetArguments()["ttl_hours"].(float64); ok {
		ttl = &v
	}
	tr, _, _, err := s.openThread(ctx, mid, pid, title, ttl)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	return jsonResult(gin.H{"thread": threadOut(tr)})
}

// requestInput opens (or finds) the thread on the triggering message and asks
// the named user a question inside it, @mentioning them so it lands in their
// inbox and push — the "blocked on a human" flow in one call.
func (s *Service) requestInput(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	mid, err := uuidArg(req, "message_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	who, err := req.RequireString("user")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	who = strings.TrimSpace(strings.TrimPrefix(who, "@"))
	question, err := req.RequireString("question")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	question = strings.TrimSpace(question)
	if who == "" || question == "" {
		return mcp.NewToolResultError("user and question are required"), nil
	}
	pid, err := s.q.ResolveMessageProject(ctx, mid)
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "message:write"); err != nil {
		return errResult(err)
	}
	// target conversation: the message's own thread when it already lives in
	// one, otherwise the thread rooted at it
	target, err := s.q.GetMessageConversation(ctx, mid)
	if err != nil {
		return errResult(err)
	}
	conv, err := s.q.GetConversationByID(ctx, target)
	if err != nil {
		return errResult(err)
	}
	var tr db.GetThreadRow
	if conv.Kind == "thread" {
		tr, err = s.q.GetThread(ctx, conv.ID)
		if err != nil {
			return errResult(err)
		}
	} else {
		var terr error
		tr, _, _, terr = s.openThread(ctx, mid, pid, "", nil)
		if terr != nil {
			return mcp.NewToolResultError(terr.Error()), nil
		}
	}
	body := "@" + who + " " + question
	refs := s.resolveMentions(ctx, pid, mentions.Extract(body))
	mj, _ := json.Marshal(refs)
	qid, err := s.q.CreateAgentMessage(ctx, db.CreateAgentMessageParams{
		ConversationID: tr.ID, AgentID: agent(ctx).ID, Body: body,
		ParentID: pgtype.UUID{Bytes: mid.Bytes, Valid: true}, Mentions: mj,
		Tags: []string{"needs-input"},
	})
	if err != nil {
		return errResult(err)
	}
	m, err := s.q.GetMessageFull(ctx, qid)
	if err != nil {
		return errResult(err)
	}
	s.publish(ctx, tr.ID, "message.created",
		map[string]any{"conversation_id": tr.ID.String(), "message": s.messageFrame(ctx, m)})
	// the reply bumps the chip's count on the parent message
	if tr2, err := s.q.GetThread(ctx, tr.ID); err == nil {
		s.publish(ctx, tr2.ParentConversationID, "thread.updated", map[string]any{
			"conversation_id":   tr2.ParentConversationID.String(),
			"parent_message_id": tr2.ParentMessageID.String(),
			"thread":            threadOut(tr2),
		})
	}
	if s.Push != nil {
		s.Push.NotifyMessage(pid, pgtype.UUID{}, body, m.ID,
			"/app/p/"+pid.String(), agent(ctx).Name,
			mentions.UserIDs(refs))
	}
	return jsonResult(gin.H{
		"thread":  threadOut(tr),
		"message": s.messageFrame(ctx, m),
	})
}

// resolveInput clears the 'needs-input' tag a request_input question carries
// and optionally posts how it was answered into the same thread — keeps the
// chat honest when the user replied in the harness instead of Relay.
func (s *Service) resolveInput(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	mid, err := uuidArg(req, "message_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	pid, err := s.q.ResolveMessageProject(ctx, mid)
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "message:write"); err != nil {
		return errResult(err)
	}
	m, err := s.q.GetMessageFull(ctx, mid)
	if err != nil {
		return errResult(errors.New("message not found"))
	}
	tags := make([]string, 0, len(m.Tags))
	had := false
	for _, t := range m.Tags {
		if t == "needs-input" {
			had = true
			continue
		}
		tags = append(tags, t)
	}
	if !had {
		return mcp.NewToolResultError("message is not tagged needs-input"), nil
	}
	if err := s.q.SetMessageTags(ctx, db.SetMessageTagsParams{ID: mid, Tags: tags}); err != nil {
		return errResult(err)
	}
	cid, _ := s.q.GetMessageConversation(ctx, mid)
	note := strings.TrimSpace(req.GetString("note", ""))
	if note != "" {
		nid, err := s.q.CreateAgentMessage(ctx, db.CreateAgentMessageParams{
			ConversationID: cid, AgentID: agent(ctx).ID, Body: "Resolved — " + note,
			ParentID: mid, Silent: true,
		})
		if err == nil {
			if nm, err := s.q.GetMessageFull(ctx, nid); err == nil {
				s.publish(ctx, cid, "message.created",
					map[string]any{"conversation_id": cid.String(), "message": s.messageFrame(ctx, nm)})
			}
		}
	}
	if fresh, err := s.q.GetMessageFull(ctx, mid); err == nil {
		s.publish(ctx, cid, "message.updated", map[string]any{
			"conversation_id": cid.String(), "message": s.messageFrame(ctx, fresh)})
	}
	return jsonResult(gin.H{"resolved": mid.String(), "note": note})
}

// workStart posts a single visible status message tagged 'work-in-progress'
// and opens the progress thread on it. The thread id is what progress
// updates reply into — send_message with silent=true keeps them out of
// everyone's notifications.
func (s *Service) workStart(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	pid, err := uuidArg(req, "project_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	if err := s.scope(ctx, pid, "message:write"); err != nil {
		return errResult(err)
	}
	title := strings.TrimSpace(req.GetString("title", ""))
	if title == "" || len([]rune(title)) > 200 {
		return mcp.NewToolResultError("title is required (max 200 chars)"), nil
	}
	var cid pgtype.UUID
	if v := req.GetString("conversation_id", ""); v != "" {
		if err := cid.Scan(v); err != nil || !cid.Valid {
			return mcp.NewToolResultError("invalid conversation_id"), nil
		}
		if cpid, err := s.q.ResolveConversationProject(ctx, cid); err != nil || cpid != pid {
			return mcp.NewToolResultError("conversation_id is not in this project"), nil
		}
	} else {
		conv, err := s.q.GetProjectConversation(ctx, pid)
		if err != nil {
			conv, err = s.q.CreateProjectConversation(ctx, pid)
		}
		if err != nil {
			return errResult(err)
		}
		cid = conv.ID
	}
	mid, err := s.q.CreateAgentMessage(ctx, db.CreateAgentMessageParams{
		ConversationID: cid, AgentID: agent(ctx).ID,
		Body: "Working on: " + title, Tags: []string{"work-in-progress"},
	})
	if err != nil {
		return errResult(err)
	}
	tr, _, _, err := s.openThread(ctx, mid, pid, title, nil)
	if err != nil {
		return errResult(err)
	}
	m, err := s.q.GetMessageFull(ctx, mid)
	if err != nil {
		return errResult(err)
	}
	s.publish(ctx, cid, "message.created",
		map[string]any{"conversation_id": cid.String(), "message": s.messageFrame(ctx, m)})
	return jsonResult(gin.H{
		"message_id":       mid.String(),
		"conversation_id":  cid.String(),
		"thread":           threadOut(tr),
		"progress_updates": "post into the thread with send_message conversation_id=" + tr.ID.String() + " silent=true",
	})
}

// workStop clears 'work-in-progress' from the status message and posts an
// optional summary into the progress thread.
func (s *Service) workStop(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	mid, err := uuidArg(req, "message_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	pid, err := s.q.ResolveMessageProject(ctx, mid)
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "message:write"); err != nil {
		return errResult(err)
	}
	m, err := s.q.GetMessageFull(ctx, mid)
	if err != nil {
		return errResult(errors.New("message not found"))
	}
	tags := make([]string, 0, len(m.Tags))
	for _, t := range m.Tags {
		if t != "work-in-progress" {
			tags = append(tags, t)
		}
	}
	tags = append(tags, "work-done")
	if err := s.q.SetMessageTags(ctx, db.SetMessageTagsParams{ID: mid, Tags: tags}); err != nil {
		return errResult(err)
	}
	cid, _ := s.q.GetMessageConversation(ctx, mid)
	if summary := strings.TrimSpace(req.GetString("summary", "")); summary != "" {
		// summaries belong in the progress thread, not the main chat
		target := cid
		if tr, err := s.q.GetThreadByParentMessage(ctx, mid); err == nil {
			target = tr.ID
		}
		if nid, err := s.q.CreateAgentMessage(ctx, db.CreateAgentMessageParams{
			ConversationID: target, AgentID: agent(ctx).ID, Body: summary, ParentID: mid,
		}); err == nil {
			if nm, err := s.q.GetMessageFull(ctx, nid); err == nil {
				s.publish(ctx, target, "message.created",
					map[string]any{"conversation_id": target.String(), "message": s.messageFrame(ctx, nm)})
			}
		}
	}
	if fresh, err := s.q.GetMessageFull(ctx, mid); err == nil {
		s.publish(ctx, cid, "message.updated", map[string]any{
			"conversation_id": cid.String(), "message": s.messageFrame(ctx, fresh)})
	}
	return jsonResult(gin.H{"stopped": mid.String()})
}

// pinMessage mirrors PUT/DELETE /messages/:id/pin — project members (and
// agents with message:write) may pin; no Manage Messages tier exists.
func (s *Service) pinMessage(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	mid, err := uuidArg(req, "message_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	pid, err := s.q.ResolveMessageProject(ctx, mid)
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "message:write"); err != nil {
		return errResult(err)
	}
	pinned, ok := req.GetArguments()["pinned"].(bool)
	if !ok {
		return mcp.NewToolResultError("pinned (bool) required"), nil
	}
	var convID pgtype.UUID
	if pinned {
		r, e := s.q.PinMessageAgent(ctx, mid)
		if e != nil {
			return mcp.NewToolResultError("message not found"), nil
		}
		convID = r.ConversationID
	} else {
		r, e := s.q.UnpinMessageAgent(ctx, mid)
		if e != nil {
			return mcp.NewToolResultError("message not found"), nil
		}
		convID = r.ConversationID
	}
	if m, err := s.q.GetMessageFull(ctx, mid); err == nil {
		s.publish(ctx, convID, "message.updated", map[string]any{
			"conversation_id": convID.String(), "message": s.messageFrame(ctx, m)})
	}
	return jsonResult(map[string]any{"message_id": mid.String(), "pinned": pinned})
}

// listPins mirrors GET /conversations/:id/pins.
func (s *Service) listPins(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	cid, toolErr := s.resolveConversationArg(ctx, req)
	if toolErr != nil {
		return toolErr, nil
	}
	pid, err := s.q.ResolveConversationProject(ctx, cid)
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "message:read"); err != nil {
		return errResult(err)
	}
	rows, err := s.q.ListPinnedMessages(ctx, cid)
	if err != nil {
		return errResult(err)
	}
	msgs := make([]gin.H, 0, len(rows))
	for _, m := range rows {
		msgs = append(msgs, messageJSON(db.GetMessageFullRow(m)))
	}
	return jsonResult(map[string]any{"messages": msgs})
}

// forwardMessage mirrors POST /messages/:id/forward — the agent needs
// message:write on both the source and the target project.
func (s *Service) forwardMessage(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	mid, err := uuidArg(req, "message_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	tid, err := uuidArg(req, "project_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	src, err := s.q.GetMessageFull(ctx, mid)
	if err != nil || src.DeletedAt.Valid {
		return mcp.NewToolResultError("message not found"), nil
	}
	pid, err := s.q.ResolveMessageProject(ctx, mid)
	if err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "message:write"); err != nil {
		return errResult(err)
	}
	if err := s.scope(ctx, tid, "message:write"); err != nil {
		return errResult(err)
	}
	// Target channel may not exist yet — conversations create lazily.
	target, err := s.q.GetProjectConversation(ctx, tid)
	if err != nil {
		target, err = s.q.CreateProjectConversation(ctx, tid)
		if err != nil {
			target, err = s.q.GetProjectConversation(ctx, tid)
		}
	}
	if err != nil {
		return errResult(err)
	}
	root := src.ForwardedFrom
	if !root.Valid {
		root = mid
	}
	newID, err := s.q.CreateAgentMessage(ctx, db.CreateAgentMessageParams{
		ConversationID: target.ID, AgentID: agent(ctx).ID, Body: src.Body,
		ForwardedFrom: root,
	})
	if err != nil {
		return errResult(err)
	}
	if err := s.q.CopyMessageAttachments(ctx,
		db.CopyMessageAttachmentsParams{MessageID: newID, SourceID: mid}); err != nil {
		s.log.Error("forward attachments failed", zap.Error(err))
	}
	m, err := s.q.GetMessageFull(ctx, newID)
	if err != nil {
		return errResult(err)
	}
	s.publish(ctx, target.ID, "message.created", map[string]any{
		"conversation_id": target.ID.String(), "message": s.messageFrame(ctx, m)})
	return jsonResult(map[string]any{"message": s.messageJSONFull(ctx, m)})
}

// reactToMessage toggles this agent's emoji on a message and publishes the
// new aggregate over SSE.
func (s *Service) reactToMessage(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	mid, err := uuidArg(req, "message_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
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
		return mcp.NewToolResultError(err.Error()), nil
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

// setAvatar lets the agent set its own profile picture - either
// image_base64 bytes or image_url, which the server fetches itself.
func (s *Service) setAvatar(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if s.limited {
		return mcp.NewToolResultError("this hosted instance does not store files — self-host Relay for attachments"), nil
	}
	if s.store == nil {
		return mcp.NewToolResultError("storage not configured"), nil
	}
	var data []byte
	var ct string
	if imageURL := req.GetString("image_url", ""); imageURL != "" {
		d, c, err := avatars.FetchImage(ctx, imageURL)
		if err != nil {
			return mcp.NewToolResultError("could not fetch image_url: " + err.Error()), nil
		}
		if _, ok := avatars.AcceptedImageType(d); !ok {
			return mcp.NewToolResultError("image_url did not return an image (detected " + c + ")"), nil
		}
		data, ct = d, c
	} else {
		raw, err := req.RequireString("image_base64")
		if err != nil {
			return errResult(err)
		}
		data, err = base64.StdEncoding.DecodeString(strings.TrimSpace(raw))
		if err != nil {
			return mcp.NewToolResultError("image_base64 is not valid base64"), nil
		}
		if len(data) == 0 || len(data) > 2<<20 {
			return mcp.NewToolResultError("image must be 1 byte to 2 MiB"), nil
		}
		var ok bool
		ct, ok = avatars.AcceptedImageType(data)
		if !ok {
			return mcp.NewToolResultError("unsupported image type (detected " + ct + "); png, jpeg, gif, webp or avif"), nil
		}
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
		return mcp.NewToolResultError(err.Error()), nil
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
	// own post — the author is not a reader, so no receipt at all
	if m.AuthorAgentID == agent(ctx).ID {
		return jsonResult(gin.H{"ok": true})
	}
	err = s.q.MarkMessageReadAgent(ctx, db.MarkMessageReadAgentParams{
		MessageID: mid, AgentID: agent(ctx).ID,
	})
	if err != nil {
		return errResult(err)
	}
	s.publishRead(ctx, m.ConversationID, []pgtype.UUID{mid})
	return jsonResult(gin.H{"ok": true})
}

// whoami reports the calling agent's identity and reach — the equivalent of
// `relay-cli whoami` for MCP-native clients.
func (s *Service) whoami(ctx context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	a := agent(ctx)
	names := make([]string, 0, len(s.tools))
	for _, t := range s.tools {
		names = append(names, t.Name)
	}
	sort.Strings(names)
	out := gin.H{
		"id": a.ID, "name": a.Name, "slug": a.Slug,
		"review_mode": a.ReviewMode, "grant_all": a.GrantAll,
		"grant_scopes": a.GrantScopes,
		"server_version": s.version,
		// the registered tool list — feature-detect instead of guessing names
		"capabilities": names,
	}
	if ws, err := s.q.GetWorkspaceByID(ctx, a.WorkspaceID); err == nil {
		out["workspace"] = gin.H{"id": ws.ID, "name": ws.Name, "slug": ws.Slug}
	}
	projects, err := s.q.ListGrantedProjects(ctx, a.ID)
	if err != nil {
		return errResult(err)
	}
	list := make([]gin.H, 0, len(projects))
	for _, p := range projects {
		list = append(list, gin.H{"id": p.ID, "key": p.Key, "name": p.Name})
	}
	out["projects"] = list
	return jsonResult(out)
}

// activity mirrors GET /api/me/activity for agents — open issues, GitHub PRs
// and fresh messages across every granted project in one call.
func (s *Service) activity(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	a := agent(ctx)
	minimal := req.GetBool("minimal", false)
	issues := []gin.H{}
	prs := []gin.H{}
	if rows, err := s.q.ListGrantedOpenIssues(ctx, a.ID); err == nil {
		for _, i := range rows {
			item := gin.H{
				"id": i.ID, "project_id": i.ProjectID, "key": i.Key,
				"title": i.Title, "status": i.Status, "priority": i.Priority,
				"updated_at": i.UpdatedAt.Time,
				"project":    gin.H{"id": i.ProjectID, "key": i.ProjectKey, "name": i.ProjectName},
			}
			if i.GithubKind == "pr" {
				prs = append(prs, item)
			} else {
				issues = append(issues, item)
			}
		}
	}
	msgs := []gin.H{}
	if rows, err := s.q.ListGrantedRecentMessages(ctx, a.ID); err == nil {
		for _, m := range rows {
			e := gin.H{
				"id": m.ID, "conversation_id": m.ConversationID,
				"created_at": m.CreatedAt.Time,
				"conversation_kind": m.ConversationKind,
				"project":           gin.H{"id": m.ProjectID, "key": m.ProjectKey, "name": m.ProjectName},
				"author":            gin.H{"name": m.AuthorName, "kind": m.AuthorKind},
			}
			if minimal {
				ex, tr := excerpt(m.Body, 200)
				e["excerpt"] = ex
				e["truncated"] = tr
			} else {
				e["body"] = m.Body
			}
			msgs = append(msgs, e)
		}
	}
	return jsonResult(gin.H{
		"open_issues": issues, "open_prs": prs, "recent_messages": msgs,
	})
}

// listMentionables mirrors GET /api/projects/:id/mentionables for agents —
// the names that actually resolve in @mentions, KEY- refs and repo# refs.
func (s *Service) listMentionables(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	pid, err := uuidArg(req, "project_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	if err := s.scope(ctx, pid, "project:read"); err != nil {
		return errResult(err)
	}
	wsID, _ := s.q.ProjectWorkspaceID(ctx, pid)

	users := []gin.H{}
	if members, err := s.q.ListWorkspaceMembers(ctx, wsID); err == nil {
		for _, m := range members {
			users = append(users, gin.H{"id": m.ID.String(), "name": m.Name})
		}
	}
	agents := []gin.H{}
	if list, err := s.q.ListAgentsMentionable(ctx, wsID); err == nil {
		for _, a := range list {
			agents = append(agents, gin.H{
				"id": a.ID.String(), "name": a.Name, "slug": a.Slug,
				"description": a.Description,
			})
		}
	}
	issues := []gin.H{}
	if list, err := s.q.ListMentionableIssues(ctx, pid); err == nil {
		for _, i := range list {
			issues = append(issues, gin.H{
				"id": i.ID.String(), "key": i.Key, "title": i.Title,
				"status": i.Status,
			})
		}
	}
	repos := []string{}
	if list, err := s.q.ListProjectRepos(ctx, pid); err == nil {
		for _, r := range list {
			repos = append(repos, r.Owner+"/"+r.Name)
		}
	}
	return jsonResult(gin.H{
		"users": users, "agents": agents, "issues": issues, "repos": repos,
	})
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
	wantState := strings.ToLower(strings.TrimSpace(req.GetString("state", "open")))
	state := wantState
	switch state {
	case "open", "closed", "all":
	case "merged":
		// GitHub's API has no merged state — closed + merged_at filter below
		state = "closed"
	default:
		return mcp.NewToolResultError("invalid state — open|closed|merged|all"), nil
	}
	author := strings.ToLower(strings.TrimSpace(req.GetString("author", "")))
	query := strings.ToLower(strings.TrimSpace(req.GetString("q", "")))
	cli, err := s.ghClient(ctx)
	if err != nil {
		return errResult(err)
	}
	prs, err := cli.ListPRsWithState(ctx, r.InstallationID, r.Owner, r.Name, state)
	if err != nil {
		return errResult(err)
	}
	wantMerged := wantState == "merged"
	full := r.Owner + "/" + r.Name
	out := make([]gin.H, 0, len(prs))
	for _, p := range prs {
		if wantMerged && p.MergedAt == nil && !p.Merged {
			continue
		}
		if author != "" && strings.ToLower(p.User.Login) != author {
			continue
		}
		if query != "" && !strings.Contains(strings.ToLower(p.Title), query) &&
			!strings.Contains(strings.ToLower(p.Body), query) {
			continue
		}
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

// ghRepoWrite is ghRepo with the write scope — all GitHub mutations ride it.
func (s *Service) ghRepoWrite(ctx context.Context, req mcp.CallToolRequest) (db.Repository, error) {
	pid, err := uuidArg(req, "project_id")
	if err != nil {
		return db.Repository{}, err
	}
	if err := s.scope(ctx, pid, "issue:write"); err != nil {
		return db.Repository{}, err
	}
	repos, err := s.q.ListProjectRepos(ctx, pid)
	if err != nil || len(repos) == 0 {
		return db.Repository{}, errors.New("no GitHub repository linked to this project")
	}
	return repos[0], nil
}

func (s *Service) ghCreateIssue(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	r, err := s.ghRepoWrite(ctx, req)
	if err != nil {
		return errResult(err)
	}
	title := req.GetString("title", "")
	if title == "" {
		return mcp.NewToolResultError("title required"), nil
	}
	cli, err := s.ghClient(ctx)
	if err != nil {
		return errResult(err)
	}
	gh, err := cli.CreateIssue(ctx, r.InstallationID, r.Owner, r.Name,
		title, req.GetString("body", ""))
	if err != nil {
		return errResult(err)
	}
	var issueID string
	if s.gh != nil {
		if id, err := s.gh.MirrorIssue(ctx, r, *gh); err == nil {
			issueID = id.String()
		}
	}
	out := ghIssueJSON(*gh, r.Owner+"/"+r.Name)
	out["issue_id"] = issueID
	return jsonResult(out)
}

func (s *Service) ghCreatePR(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	r, err := s.ghRepoWrite(ctx, req)
	if err != nil {
		return errResult(err)
	}
	head := req.GetString("head", "")
	title := req.GetString("title", "")
	if head == "" || title == "" {
		return mcp.NewToolResultError("head and title required"), nil
	}
	base := req.GetString("base", r.DefaultBranch)
	cli, err := s.ghClient(ctx)
	if err != nil {
		return errResult(err)
	}
	pr, err := cli.CreatePR(ctx, r.InstallationID, r.Owner, r.Name,
		head, base, title, req.GetString("body", ""), req.GetBool("draft", false))
	if err != nil {
		return errResult(err)
	}
	var issueID string
	if s.gh != nil {
		if id, err := s.gh.MirrorPR(ctx, r, *pr); err == nil {
			issueID = id.String()
		}
	}
	out := ghPRJSON(*pr, r.Owner+"/"+r.Name)
	out["issue_id"] = issueID
	return jsonResult(out)
}

func (s *Service) ghComment(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	r, err := s.ghRepoWrite(ctx, req)
	if err != nil {
		return errResult(err)
	}
	num := req.GetInt("number", 0)
	body := req.GetString("body", "")
	if num < 1 || body == "" {
		return mcp.NewToolResultError("number and body required"), nil
	}
	cli, err := s.ghClient(ctx)
	if err != nil {
		return errResult(err)
	}
	if err := cli.CreateIssueComment(ctx, r.InstallationID, r.Owner, r.Name, num, body); err != nil {
		return errResult(err)
	}
	return jsonResult(gin.H{"commented": true, "number": num})
}

func (s *Service) ghReviewPR(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	r, err := s.ghRepoWrite(ctx, req)
	if err != nil {
		return errResult(err)
	}
	num := req.GetInt("number", 0)
	event := req.GetString("event", "")
	body := req.GetString("body", "")
	if num < 1 {
		return mcp.NewToolResultError("number required"), nil
	}
	switch event {
	case "APPROVE", "COMMENT":
	case "REQUEST_CHANGES":
		if body == "" {
			return mcp.NewToolResultError("body required when requesting changes"), nil
		}
	default:
		return mcp.NewToolResultError("event must be APPROVE | REQUEST_CHANGES | COMMENT"), nil
	}
	cli, err := s.ghClient(ctx)
	if err != nil {
		return errResult(err)
	}
	if err := cli.CreatePRReview(ctx, r.InstallationID, r.Owner, r.Name, num, event, body); err != nil {
		return errResult(err)
	}
	return jsonResult(gin.H{"reviewed": true, "number": num, "event": event})
}

func (s *Service) ghSetPRState(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	r, err := s.ghRepoWrite(ctx, req)
	if err != nil {
		return errResult(err)
	}
	num := req.GetInt("number", 0)
	state := req.GetString("state", "")
	if num < 1 || (state != "open" && state != "closed") {
		return mcp.NewToolResultError("number required; state must be open|closed"), nil
	}
	cli, err := s.ghClient(ctx)
	if err != nil {
		return errResult(err)
	}
	pr, err := cli.SetPRState(ctx, r.InstallationID, r.Owner, r.Name, num, state)
	if err != nil {
		return errResult(err)
	}
	if s.gh != nil {
		st := pr.State
		if pr.Merged {
			st = "merged"
		}
		s.gh.SyncMirroredIssue(ctx, r, num, st)
	}
	return jsonResult(gin.H{"number": num, "state": pr.State, "merged": pr.Merged})
}

func (s *Service) ghMergePR(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	r, err := s.ghRepoWrite(ctx, req)
	if err != nil {
		return errResult(err)
	}
	num := req.GetInt("number", 0)
	method := req.GetString("method", "merge")
	if num < 1 {
		return mcp.NewToolResultError("number required"), nil
	}
	cli, err := s.ghClient(ctx)
	if err != nil {
		return errResult(err)
	}
	res, err := cli.MergePR(ctx, r.InstallationID, r.Owner, r.Name, num, method, "", "")
	if err != nil {
		return errResult(err)
	}
	if s.gh != nil {
		s.gh.SyncMirroredIssue(ctx, r, num, "merged")
	}
	return jsonResult(gin.H{"merged": res.Merged, "sha": res.SHA, "number": num})
}

func (s *Service) ghCIRuns(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	r, err := s.ghRepo(ctx, req)
	if err != nil {
		return errResult(err)
	}
	cli, err := s.ghClient(ctx)
	if err != nil {
		return errResult(err)
	}
	runs, err := cli.ListWorkflowRuns(ctx, r.InstallationID, r.Owner, r.Name, 15)
	if err != nil {
		return errResult(err)
	}
	out := make([]gin.H, 0, len(runs))
	for _, w := range runs {
		out = append(out, gin.H{
			"id": w.ID, "name": w.Name, "status": w.Status,
			"conclusion": w.Conclusion, "branch": w.HeadBranch,
			"event": w.Event, "actor": w.Actor.Login, "url": w.HTMLURL,
			"run_number": w.RunNumber, "created_at": w.CreatedAt,
			"updated_at": w.UpdatedAt,
		})
	}
	return jsonResult(out)
}

func (s *Service) ghRerun(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	r, err := s.ghRepoWrite(ctx, req)
	if err != nil {
		return errResult(err)
	}
	runID := req.GetInt("run_id", 0)
	if runID < 1 {
		return mcp.NewToolResultError("run_id required"), nil
	}
	cli, err := s.ghClient(ctx)
	if err != nil {
		return errResult(err)
	}
	if err := cli.RerunWorkflowRun(ctx, r.InstallationID, r.Owner, r.Name, int64(runID)); err != nil {
		return errResult(err)
	}
	return jsonResult(gin.H{"rerun": true, "run_id": runID})
}

// --- agent todos ---

func todoOut(t db.ListTodosRow) gin.H {
	out := gin.H{
		"id": t.ID.String(), "content": t.Content, "done": t.Done,
		"status": t.Status, "position": t.Position,
		"created_at": t.CreatedAt.Time, "updated_at": t.UpdatedAt.Time,
	}
	if t.AgentID.Valid || t.AgentName != "" {
		a := gin.H{"name": t.AgentName}
		if t.AgentID.Valid {
			a["id"] = t.AgentID.String()
		}
		out["agent"] = a
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
		return mcp.NewToolResultError(err.Error()), nil
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
		return mcp.NewToolResultError(err.Error()), nil
	}
	content, err := req.RequireString("content")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
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
	s.publishPID(pid, "todo.changed", nil)
	return jsonResult(gin.H{"id": row.ID.String(), "done": row.Done, "content": row.Content, "status": row.Status})
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
	if v, ok := args["status"].(string); ok && v != "" {
		switch v {
		case "todo", "in_progress", "done":
			params.Status = pgtype.Text{String: v, Valid: true}
		default:
			return mcp.NewToolResultError("status must be todo|in_progress|done"), nil
		}
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
	s.publishPID(pid, "todo.changed", nil)
	return jsonResult(gin.H{"id": row.ID.String(), "done": row.Done, "content": row.Content, "status": row.Status})
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
	s.publishPID(pid, "todo.changed", nil)
	return jsonResult(gin.H{"deleted": t.ID.String()})
}

// todoSync reconciles this agent's todos in the project against the harness
// list in one round trip. Items carry an optional Relay id for stability
// across syncs — new items get created, missing ones get deleted, order
// becomes position. Other agents' rows are never touched.
func (s *Service) todoSync(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	pid, err := uuidArg(req, "project_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	if err := s.scope(ctx, pid, "issue:write"); err != nil {
		return errResult(err)
	}
	raw, ok := req.GetArguments()["items"].([]any)
	if !ok {
		return mcp.NewToolResultError("items must be an array of {id?, content, status?, issue_id?}"), nil
	}
	if len(raw) > 200 {
		return mcp.NewToolResultError("at most 200 todos"), nil
	}
	type item struct {
		id      pgtype.UUID
		content string
		status  string
		issueID pgtype.UUID
	}
	parsed := make([]item, 0, len(raw))
	for i, e := range raw {
		m, ok := e.(map[string]any)
		if !ok {
			return mcp.NewToolResultError("items must be objects"), nil
		}
		var it item
		if v, _ := m["content"].(string); strings.TrimSpace(v) != "" {
			it.content = strings.TrimSpace(v)
		} else {
			return mcp.NewToolResultError("item " + strconv.Itoa(i) + ": content is required"), nil
		}
		if v, _ := m["status"].(string); v != "" {
			switch v {
			case "todo", "in_progress", "done":
				it.status = v
			default:
				return mcp.NewToolResultError("item " + strconv.Itoa(i) + ": bad status"), nil
			}
		} else {
			it.status = "todo"
		}
		if v, _ := m["id"].(string); v != "" {
			if err := it.id.Scan(v); err != nil || !it.id.Valid {
				return mcp.NewToolResultError("item " + strconv.Itoa(i) + ": bad id"), nil
			}
		}
		if v, _ := m["issue_id"].(string); v != "" {
			if err := it.issueID.Scan(v); err != nil {
				return mcp.NewToolResultError("item " + strconv.Itoa(i) + ": bad issue_id"), nil
			}
		}
		parsed = append(parsed, it)
	}
	existing, err := s.q.ListTodosByAgent(ctx, db.ListTodosByAgentParams{
		ProjectID: pid, AgentID: agent(ctx).ID,
	})
	if err != nil {
		return errResult(err)
	}
	byID := make(map[[16]byte]db.AgentTodo, len(existing))
	for _, t := range existing {
		byID[t.ID.Bytes] = t
	}
	seen := make(map[[16]byte]bool, len(parsed))
	out := make([]gin.H, 0, len(parsed))
	for i, it := range parsed {
		status := pgtype.Text{String: it.status, Valid: true}
		pos := pgtype.Int4{Int32: int32(i), Valid: true}
		var row db.AgentTodo
		if it.id.Valid {
			if cur, ok := byID[it.id.Bytes]; ok {
				row, err = s.q.UpdateTodo(ctx, db.UpdateTodoParams{
					ID: cur.ID, Content: pgtype.Text{String: it.content, Valid: true},
					Status: status, IssueID: it.issueID, Position: pos,
				})
				if err != nil {
					return errResult(err)
				}
			} else {
				// stale id — recreate rather than fail the whole sync
				row, err = s.q.CreateTodo(ctx, db.CreateTodoParams{
					ProjectID: pid, AgentID: agent(ctx).ID, IssueID: it.issueID,
					Content: it.content, Status: status,
				})
				if err == nil {
					row, _ = s.q.UpdateTodo(ctx, db.UpdateTodoParams{ID: row.ID, Position: pos})
				}
			}
			if err != nil {
				return errResult(err)
			}
			seen[row.ID.Bytes] = true
		} else {
			row, err = s.q.CreateTodo(ctx, db.CreateTodoParams{
				ProjectID: pid, AgentID: agent(ctx).ID, IssueID: it.issueID,
				Content: it.content, Status: status,
			})
			if err != nil {
				return errResult(err)
			}
			row, _ = s.q.UpdateTodo(ctx, db.UpdateTodoParams{ID: row.ID, Position: pos})
			seen[row.ID.Bytes] = true
		}
		out = append(out, gin.H{"id": row.ID.String(), "content": row.Content, "status": row.Status})
	}
	for _, t := range existing {
		if !seen[t.ID.Bytes] {
			_ = s.q.DeleteTodo(ctx, t.ID)
		}
	}
	s.publishPID(pid, "todo.changed", nil)
	return jsonResult(out)
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

// publishRead emits a message.read frame so open clients can show the
// named agent read receipt live instead of on next fetch.
func (s *Service) publishRead(ctx context.Context, conversationID pgtype.UUID, messageIDs []pgtype.UUID) {
	if len(messageIDs) == 0 {
		return
	}
	a := agent(ctx)
	var avatar *string
	if a.AvatarKey.Valid {
		v := "/api/files/" + a.AvatarKey.String
		avatar = &v
	}
	ids := make([]string, 0, len(messageIDs))
	for _, id := range messageIDs {
		ids = append(ids, id.String())
	}
	s.publish(ctx, conversationID, "message.read", map[string]any{
		"conversation_id": conversationID.String(),
		"message_ids":     ids,
		"agent": gin.H{
			"id": a.ID.String(), "name": a.Name, "avatar_url": avatar,
		},
	})
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
		"scenes":   raw(r.Scenes),
		"issue_id": issueID, "supersedes": supersedes,
		"response": r.Response, "responder": responder, "responded_at": respondedAt,
		"created_at": r.CreatedAt.Time,
	}
}

func (s *Service) submitReview(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	pid, err := uuidArg(req, "project_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	if err := s.scope(ctx, pid, "review:write"); err != nil {
		return errResult(err)
	}
	title, err := req.RequireString("title")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	title = strings.TrimSpace(title)
	if len(title) == 0 || len(title) > 200 {
		return errResult(errors.New("title must be 1-200 chars"))
	}
	summary, err := req.RequireString("summary")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
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
	scenes, err := jsonbArg(req, "scenes")
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
		Scenes: scenes,
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
		return mcp.NewToolResultError(err.Error()), nil
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
	// Capped low on purpose: a streamable-HTTP call that outlives the
	// client's or a fronting proxy's read timeout gets severed mid-flight,
	// and some MCP clients mark the whole transport dead when that
	// happens. 55s sits under the common 60-100s ceilings; callers that
	// want to wait longer re-call on the returned "pending" state.
	timeout := clampInt(req.GetInt("timeout_s", 55), 1, 55)
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
		return mcp.NewToolResultError(err.Error()), nil
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
		return mcp.NewToolResultError(err.Error()), nil
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

// --- visual briefs ---

func briefJSONMCP(b db.Brief, authorName, issueKey string) gin.H {
	return gin.H{
		"id": b.ID, "project_id": b.ProjectID,
		"issue_id": b.IssueID, "issue_key": issueKey,
		"conversation_id": b.ConversationID,
		"title":           b.Title, "summary": b.Summary,
		"scene": json.RawMessage(b.Scene), "status": b.Status,
		"author_name": authorName,
		"created_at":  b.CreatedAt.Time, "updated_at": b.UpdatedAt.Time,
	}
}

func (s *Service) briefPolicyFor(ctx context.Context, pid pgtype.UUID) string {
	meta, err := s.q.ProjectMeta(ctx, pid)
	if err != nil || meta.BriefPolicy == "" {
		return "on_request"
	}
	return meta.BriefPolicy
}

func (s *Service) getBriefPolicy(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	pid, err := uuidArg(req, "project_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	if err := s.scope(ctx, pid, "project:read"); err != nil {
		return errResult(err)
	}
	return jsonResult(gin.H{"policy": s.briefPolicyFor(ctx, pid)})
}

func (s *Service) listBriefs(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	pid, err := uuidArg(req, "project_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	if err := s.scope(ctx, pid, "brief:read"); err != nil {
		return errResult(err)
	}
	var issueID pgtype.UUID
	if v := req.GetString("issue_id", ""); v != "" {
		if err := issueID.Scan(v); err != nil || !issueID.Valid {
			return mcp.NewToolResultError("invalid issue_id"), nil
		}
	}
	rows, err := s.q.ListBriefs(ctx, db.ListBriefsParams{ProjectID: pid, IssueID: issueID})
	if err != nil {
		return errResult(err)
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, briefJSONMCP(db.Brief{
			ID: r.ID, ProjectID: r.ProjectID, IssueID: r.IssueID,
			ConversationID: r.ConversationID, Title: r.Title, Summary: r.Summary,
			Scene: r.Scene, Status: r.Status, CreatedByUser: r.CreatedByUser,
			CreatedByAgent: r.CreatedByAgent, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
		}, r.AuthorName, issueKey(r.IssueProjectKey, r.IssueNumber)))
	}
	return jsonResult(gin.H{"briefs": out, "policy": s.briefPolicyFor(ctx, pid)})
}

func (s *Service) getBrief(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	bid, err := uuidArg(req, "brief_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	b, err := s.q.GetBrief(ctx, bid)
	if err != nil {
		return mcp.NewToolResultError("brief not found"), nil
	}
	if err := s.scope(ctx, b.ProjectID, "brief:read"); err != nil {
		return errResult(err)
	}
	return jsonResult(briefJSONMCP(db.Brief{
		ID: b.ID, ProjectID: b.ProjectID, IssueID: b.IssueID,
		ConversationID: b.ConversationID, Title: b.Title, Summary: b.Summary,
		Scene: b.Scene, Status: b.Status, CreatedByUser: b.CreatedByUser,
		CreatedByAgent: b.CreatedByAgent, CreatedAt: b.CreatedAt, UpdatedAt: b.UpdatedAt,
	}, b.AuthorName, issueKey(b.IssueProjectKey, b.IssueNumber)))
}

func (s *Service) createBrief(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	pid, err := uuidArg(req, "project_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	if err := s.scope(ctx, pid, "brief:write"); err != nil {
		return errResult(err)
	}
	if pol := s.briefPolicyFor(ctx, pid); pol == "never" {
		return mcp.NewToolResultError("this project's brief policy is 'never' — do not create visual briefs here"), nil
	}
	title, err := req.RequireString("title")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	if t := strings.TrimSpace(title); t == "" || len(t) > 200 {
		return mcp.NewToolResultError("title must be 1..200 chars"), nil
	} else {
		title = t
	}
	scene := []byte("{}")
	if v := req.GetString("scene", ""); v != "" {
		var probe any
		if json.Unmarshal([]byte(v), &probe) != nil {
			return mcp.NewToolResultError("scene must be a JSON string containing the Excalidraw scene"), nil
		}
		scene = []byte(v)
	}
	var issueID pgtype.UUID
	if v := req.GetString("issue_id", ""); v != "" {
		if err := issueID.Scan(v); err != nil || !issueID.Valid {
			return mcp.NewToolResultError("invalid issue_id"), nil
		}
	}
	agentID := agent(ctx).ID
	b, err := s.q.CreateBrief(ctx, db.CreateBriefParams{
		ProjectID: pid, IssueID: issueID, Title: title,
		Summary: req.GetString("summary", ""), Scene: scene,
		CreatedByAgent: agentID,
	})
	if err != nil {
		return errResult(err)
	}
	conv, err := s.q.CreateBriefConversation(ctx, db.CreateBriefConversationParams{
		ProjectID: pid, BriefID: b.ID,
	})
	if err == nil {
		_ = s.q.BriefSetConversation(ctx, db.BriefSetConversationParams{
			ConversationID: conv.ID, ID: b.ID,
		})
		b.ConversationID = conv.ID
	}
	return jsonResult(gin.H{
		"brief":  briefJSONMCP(b, agent(ctx).Name, ""),
		"policy": s.briefPolicyFor(ctx, pid),
	})
}

func (s *Service) updateBrief(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	bid, err := uuidArg(req, "brief_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	b, err := s.q.GetBrief(ctx, bid)
	if err != nil {
		return mcp.NewToolResultError("brief not found"), nil
	}
	if err := s.scope(ctx, b.ProjectID, "brief:write"); err != nil {
		return errResult(err)
	}
	var title, summary, status pgtype.Text
	var scene []byte
	if v := req.GetString("title", ""); v != "" {
		title = pgtype.Text{String: strings.TrimSpace(v), Valid: true}
	}
	if v := req.GetString("summary", ""); v != "" {
		summary = pgtype.Text{String: v, Valid: true}
	}
	if v := req.GetString("status", ""); v != "" {
		if v != "open" && v != "resolved" && v != "archived" {
			return mcp.NewToolResultError("status must be open|resolved|archived"), nil
		}
		status = pgtype.Text{String: v, Valid: true}
	}
	if v := req.GetString("scene", ""); v != "" {
		var probe any
		if json.Unmarshal([]byte(v), &probe) != nil {
			return mcp.NewToolResultError("scene must be valid JSON"), nil
		}
		scene = []byte(v)
	}
	updated, err := s.q.UpdateBrief(ctx, db.UpdateBriefParams{
		ID: bid, Title: title, Summary: summary, Status: status, Scene: scene,
	})
	if err != nil {
		return errResult(err)
	}
	return jsonResult(briefJSONMCP(updated, b.AuthorName, issueKey(b.IssueProjectKey, b.IssueNumber)))
}

func issueKey(projectKey string, number pgtype.Int4) string {
	if !number.Valid || projectKey == "" {
		return ""
	}
	return projectKey + "-" + strconv.Itoa(int(number.Int32))
}

func (s *Service) deleteBrief(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	bid, err := uuidArg(req, "brief_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	b, err := s.q.GetBrief(ctx, bid)
	if err != nil {
		return mcp.NewToolResultError("brief not found"), nil
	}
	if err := s.scope(ctx, b.ProjectID, "brief:write"); err != nil {
		return errResult(err)
	}
	// The comment conversation references briefs via on-delete-set-null, so
	// it must go first or it survives orphaned.
	if err := s.q.DeleteBriefConversation(ctx, bid); err != nil {
		return errResult(err)
	}
	if err := s.q.DeleteBrief(ctx, bid); err != nil {
		return errResult(err)
	}
	return jsonResult(gin.H{"deleted": bid})
}

// --- ideas ---
// Brainstorm docs; same visual family as briefs, so they share the
// brief:read / brief:write grant scopes.

func ideaJSONMCP(i db.Idea, projectKey, authorName string) gin.H {
	var pid any
	if i.ProjectID.Valid {
		pid = i.ProjectID.String()
	}
	return gin.H{
		"id": i.ID, "project_id": pid, "project_key": projectKey,
		"title": i.Title, "summary": i.Summary,
		"scene": json.RawMessage(i.Scene), "status": i.Status,
		"author_name": authorName,
		"created_at":  i.CreatedAt.Time, "updated_at": i.UpdatedAt.Time,
	}
}

func (s *Service) listIdeas(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	pid, err := uuidArg(req, "project_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	if err := s.scope(ctx, pid, "brief:read"); err != nil {
		return errResult(err)
	}
	rows, err := s.q.ListProjectIdeas(ctx, pid)
	if err != nil {
		return errResult(err)
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, ideaJSONMCP(db.Idea{
			ID: r.ID, ProjectID: r.ProjectID, Title: r.Title, Summary: r.Summary,
			Scene: r.Scene, Status: r.Status, CreatedByUser: r.CreatedByUser,
			CreatedByAgent: r.CreatedByAgent, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
		}, r.ProjectKey, r.AuthorName))
	}
	return jsonResult(gin.H{"ideas": out})
}

func (s *Service) getIdea(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	id, err := uuidArg(req, "idea_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	i, err := s.q.GetIdea(ctx, id)
	if err != nil {
		return mcp.NewToolResultError("idea not found"), nil
	}
	if err := s.ideaScope(ctx, i, "brief:read"); err != nil {
		return errResult(err)
	}
	return jsonResult(ideaJSONMCP(db.Idea{
		ID: i.ID, ProjectID: i.ProjectID, WorkspaceID: i.WorkspaceID, Title: i.Title, Summary: i.Summary,
		Scene: i.Scene, Status: i.Status, CreatedByUser: i.CreatedByUser,
		CreatedByAgent: i.CreatedByAgent, CreatedAt: i.CreatedAt, UpdatedAt: i.UpdatedAt,
	}, i.ProjectKey.String, i.AuthorName))
}

func (s *Service) createIdea(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	pid, err := uuidArg(req, "project_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	if err := s.scope(ctx, pid, "brief:write"); err != nil {
		return errResult(err)
	}
	title, err := req.RequireString("title")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	if t := strings.TrimSpace(title); t == "" || len(t) > 200 {
		return mcp.NewToolResultError("title must be 1..200 chars"), nil
	} else {
		title = t
	}
	scene := []byte("{}")
	if v := req.GetString("scene", ""); v != "" {
		var probe any
		if json.Unmarshal([]byte(v), &probe) != nil {
			return mcp.NewToolResultError("scene must be a JSON string containing the Excalidraw scene"), nil
		}
		scene = []byte(v)
	}
	agentID := agent(ctx).ID
	proj, err := s.q.GetProjectByID(ctx, pid)
	if err != nil {
		return errResult(err)
	}
	i, err := s.q.CreateIdea(ctx, db.CreateIdeaParams{
		WorkspaceID: proj.WorkspaceID, ProjectID: pid, Title: title,
		Summary: req.GetString("summary", ""), Scene: scene,
		CreatedByAgent: agentID,
	})
	if err != nil {
		return errResult(err)
	}
	return jsonResult(ideaJSONMCP(i, "", agent(ctx).Name))
}

func (s *Service) updateIdea(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	id, err := uuidArg(req, "idea_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	i, err := s.q.GetIdea(ctx, id)
	if err != nil {
		return mcp.NewToolResultError("idea not found"), nil
	}
	if err := s.ideaScope(ctx, i, "brief:write"); err != nil {
		return errResult(err)
	}
	var title, summary, status pgtype.Text
	var scene []byte
	if v := req.GetString("title", ""); v != "" {
		title = pgtype.Text{String: strings.TrimSpace(v), Valid: true}
	}
	if v := req.GetString("summary", ""); v != "" {
		summary = pgtype.Text{String: v, Valid: true}
	}
	if v := req.GetString("status", ""); v != "" {
		if v != "open" && v != "converted" && v != "archived" {
			return mcp.NewToolResultError("status must be open|converted|archived"), nil
		}
		status = pgtype.Text{String: v, Valid: true}
	}
	if v := req.GetString("scene", ""); v != "" {
		var probe any
		if json.Unmarshal([]byte(v), &probe) != nil {
			return mcp.NewToolResultError("scene must be valid JSON"), nil
		}
		scene = []byte(v)
	}
	updated, err := s.q.UpdateIdea(ctx, db.UpdateIdeaParams{
		ID: id, Title: title, Summary: summary, Status: status, Scene: scene,
	})
	if err != nil {
		return errResult(err)
	}
	return jsonResult(ideaJSONMCP(updated, i.ProjectKey.String, i.AuthorName))
}

func (s *Service) deleteIdea(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	id, err := uuidArg(req, "idea_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	i, err := s.q.GetIdea(ctx, id)
	if err != nil {
		return mcp.NewToolResultError("idea not found"), nil
	}
	if err := s.ideaScope(ctx, i, "brief:write"); err != nil {
		return errResult(err)
	}
	if err := s.q.DeleteIdea(ctx, id); err != nil {
		return errResult(err)
	}
	return jsonResult(gin.H{"deleted": id})
}

func (s *Service) ideaToIssue(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	id, err := uuidArg(req, "idea_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	i, err := s.q.GetIdea(ctx, id)
	if err != nil {
		return mcp.NewToolResultError("idea not found"), nil
	}
	if err := s.ideaScope(ctx, i, "issue:write"); err != nil {
		return errResult(err)
	}
	if !i.ProjectID.Valid {
		return mcp.NewToolResultError("platform-wide idea — convert to issue needs a project idea; attach a project first"), nil
	}
	title := strings.TrimSpace(req.GetString("title", ""))
	if title == "" {
		title = i.Title
	}
	desc := strings.TrimSpace(req.GetString("description", ""))
	if desc == "" {
		desc = i.Summary
	}
	num, err := s.q.NextIssueNumber(ctx, i.ProjectID)
	if err != nil {
		return errResult(err)
	}
	issue, err := s.q.CreateIssueForAgent(ctx, db.CreateIssueForAgentParams{
		ProjectID: i.ProjectID, Number: num, Title: title,
		Description: desc, Priority: "medium",
		AgentID: agent(ctx).ID,
	})
	if err != nil {
		return errResult(err)
	}
	_, _ = s.q.CreateIssueConversation(ctx, db.CreateIssueConversationParams{
		ProjectID: i.ProjectID, IssueID: issue.ID,
	})
	_, _ = s.q.UpdateIdea(ctx, db.UpdateIdeaParams{
		ID:     id,
		Status: pgtype.Text{String: "converted", Valid: true},
	})
	return jsonResult(gin.H{
		"issue": gin.H{"id": issue.ID, "number": issue.Number},
	})
}
