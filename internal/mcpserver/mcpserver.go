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
	"io"
	"net/http"
	"os"
	"path"
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
	ID         pgtype.UUID
	TokenID    pgtype.UUID
	Name       string
	AvatarKey  pgtype.Text
	ReviewMode string
}

// Service wires tools to the database and object storage.
type Service struct {
	q         *db.Queries
	store     *storage.Store
	maxUpload int64
	gh        *github.Service
	log       *zap.Logger
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
func New(q *db.Queries, store *storage.Store, maxUpload int64, log *zap.Logger, gh *github.Service, hub *events.Hub, pushSvc *push.Service) gin.HandlerFunc {
	s := &Service{
		q: q, store: store, maxUpload: maxUpload, gh: gh, log: log, Bus: hub, Push: pushSvc,
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
	srv.AddTool(mcp.NewTool("get_guide",
		mcp.WithDescription("The Relay agent onboarding guide — read this before anything else on a new workspace. Covers transports, scopes, the expected workflow, unread/truncation fields, and error handling. Always available here, via `relay-cli guide`, or GET /api/agent-guide."),
	), func(ctx context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return mcp.NewToolResultText(agentdoc.Guide), nil
	})

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
		mcp.WithDescription("List messages in a conversation (newest first). Pass conversation_id, or project_id for the project's main thread."),
		mcp.WithString("conversation_id"),
		mcp.WithString("project_id", mcp.Description("Resolves the project's main conversation")),
		mcp.WithNumber("limit", mcp.Description("Max messages, default 50, cap 200")),
		mcp.WithString("tag", mcp.Description("Only messages carrying this tag")),
	), s.getMessages)

	srv.AddTool(mcp.NewTool("get_message",
		mcp.WithDescription("Get one message by id."),
		mcp.WithString("message_id", mcp.Required()),
	), s.getMessage)

	srv.AddTool(mcp.NewTool("get_attachment",
		mcp.WithDescription("Get an attachment's metadata and a short-lived download URL."),
		mcp.WithString("attachment_id", mcp.Required()),
	), s.getAttachment)

	srv.AddTool(mcp.NewTool("upload_attachment",
		mcp.WithDescription("Upload a file (base64) to a granted project and get an attachment id to pass as send_message's attachment_ids. Images render inline in the app."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithString("name", mcp.Required(), mcp.Description("Filename, e.g. diagram.png")),
		mcp.WithString("data_base64", mcp.Required(), mcp.Description("Base64-encoded file content")),
		mcp.WithString("content_type", mcp.Description("Optional declared MIME type; sniffed type wins")),
	), s.uploadAttachment)

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
		mcp.WithDescription("Post a message as this agent. For a direct, self-contained answer always pass reply_to so the reply threads under the triggering message. For anything bigger — plans, work in progress, open questions, anything needing back-and-forth — prefer create_thread first and post inside the thread. @username in the body notifies that user (their inbox + push): use it whenever a specific person's input is needed."),
		mcp.WithString("project_id"),
		mcp.WithString("conversation_id"),
		mcp.WithString("body", mcp.Required(), mcp.Description("Markdown body")),
		mcp.WithString("reply_to", mcp.Description("Message UUID this message replies to")),
		mcp.WithString("tags", mcp.Description("Comma-separated tags classifying the message, e.g. frontend,backend,visual,mcp")),
		mcp.WithBoolean("silent", mcp.Description("true posts without any notification/push — use for routine progress updates inside a work thread. @mentions in a silent message still notify.")),
		mcp.WithString("attachment_ids", mcp.Description("Comma-separated attachment UUIDs from upload_attachment, max 20")),
	), s.sendMessage)

	srv.AddTool(mcp.NewTool("edit_message",
		mcp.WithDescription("Edit one of this agent's own messages. Allowed only while no agent has read it."),
		mcp.WithString("message_id", mcp.Required()),
		mcp.WithString("body", mcp.Required(), mcp.Description("New markdown body")),
	), s.editMessage)

	srv.AddTool(mcp.NewTool("delete_message",
		mcp.WithDescription("Delete one of this agent's own messages. Allowed only while no agent has read it."),
		mcp.WithString("message_id", mcp.Required()),
	), s.deleteMessage)

	srv.AddTool(mcp.NewTool("create_thread",
		mcp.WithDescription("Open (or get) the thread rooted at a message: a focused side conversation. Use it for anything bigger than a quick answer — plans in progress, multi-step work, open questions, anything that needs back-and-forth — so the channel stays readable. Posts a 'started a thread' notice into the channel. One thread per message; threads cannot nest. Afterwards post into it via send_message with conversation_id=<thread id>."),
		mcp.WithString("message_id", mcp.Required()),
		mcp.WithString("title", mcp.Description("Optional thread title; defaults to the parent excerpt")),
	), s.createThread)

	srv.AddTool(mcp.NewTool("request_input",
		mcp.WithDescription("Ask a person for input and keep the exchange in one place: opens a thread on the given message (if it isn't already in one), then posts your question inside it @mentioning the user so it lands in their inbox and push. Use this whenever you are blocked on a human — missing context, a decision, credentials — instead of leaving a bare channel message."),
		mcp.WithString("message_id", mcp.Required(), mcp.Description("the message your question responds to; the thread roots on it (or on itself when it already lives in a thread)")),
		mcp.WithString("user", mcp.Required(), mcp.Description("workspace member name to @mention, e.g. tdvorak")),
		mcp.WithString("question", mcp.Required(), mcp.Description("what you need from them")),
	), s.requestInput)

	srv.AddTool(mcp.NewTool("resolve_input",
		mcp.WithDescription("Mark a request_input question resolved: removes its 'needs-input' tag and, when note is given, posts the answer into the same thread. Call this when the user answered you outside Relay (e.g. in your CLI/IDE harness) so the chat thread shows the question is handled."),
		mcp.WithString("message_id", mcp.Required(), mcp.Description("the request_input question message id")),
		mcp.WithString("note", mcp.Description("optional: how it was resolved, e.g. 'answered in CLI — use staging env'")),
	), s.resolveInput)

	srv.AddTool(mcp.NewTool("work_start",
		mcp.WithDescription("Announce you are starting work: posts one status message in the project conversation and opens a progress thread on it. Post ongoing updates into that thread with send_message silent=true — never as new top-level messages. Call work_stop when finished."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithString("title", mcp.Required(), mcp.Description("short description of the work, e.g. 'Fixing invite revocation'")),
		mcp.WithString("conversation_id", mcp.Description("override target conversation; defaults to the project chat")),
	), s.workStart)

	srv.AddTool(mcp.NewTool("work_stop",
		mcp.WithDescription("Finish a work_start status message: clears its 'work-in-progress' tag and posts an optional summary into the progress thread. Always call when you finish or abandon the work so the chat shows the true state."),
		mcp.WithString("message_id", mcp.Required(), mcp.Description("the status message id returned by work_start")),
		mcp.WithString("summary", mcp.Description("optional closing summary posted into the thread")),
	), s.workStop)

	srv.AddTool(mcp.NewTool("pin_message",
		mcp.WithDescription("Pin (or unpin) a message in its conversation. Pinned messages surface in the channel's pins list."),
		mcp.WithString("message_id", mcp.Required()),
		mcp.WithBoolean("pinned", mcp.Required(), mcp.Description("true to pin, false to unpin")),
	), s.pinMessage)

	srv.AddTool(mcp.NewTool("list_pins",
		mcp.WithDescription("List a conversation's pinned messages, newest pin first."),
		mcp.WithString("conversation_id"),
		mcp.WithString("project_id", mcp.Description("shorthand for the project's conversation")),
	), s.listPins)

	srv.AddTool(mcp.NewTool("forward_message",
		mcp.WithDescription("Forward a message into another granted project's conversation. The copy credits the original author."),
		mcp.WithString("message_id", mcp.Required()),
		mcp.WithString("project_id", mcp.Required(), mcp.Description("target project the agent is granted on")),
	), s.forwardMessage)

	srv.AddTool(mcp.NewTool("react_to_message",
		mcp.WithDescription("Toggle an emoji reaction on a message."),
		mcp.WithString("message_id", mcp.Required()),
		mcp.WithString("emoji", mcp.Required(), mcp.Description("e.g. 👀 ✅ 🎉")),
	), s.reactToMessage)

	srv.AddTool(mcp.NewTool("set_avatar",
		mcp.WithDescription("Set this agent's profile picture. Pass image_base64 (png/jpeg/gif/webp/avif, max 2 MiB decoded) or image_url and the server fetches it."),
		mcp.WithString("image_base64", mcp.Description("Base64-encoded image bytes")),
		mcp.WithString("image_url", mcp.Description("http(s) image URL the server downloads and stores")),
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
		mcp.WithDescription("Update a todo: content, status (todo|in_progress|done), done flag, or linked issue."),
		mcp.WithString("todo_id", mcp.Required()),
		mcp.WithString("content"),
		mcp.WithBoolean("done"),
		mcp.WithString("status", mcp.Description("todo|in_progress|done — preferred over done")),
		mcp.WithString("issue_id"),
	), s.todoUpdate)

	srv.AddTool(mcp.NewTool("todo_delete",
		mcp.WithDescription("Delete a todo item."),
		mcp.WithString("todo_id", mcp.Required()),
	), s.todoDelete)

	srv.AddTool(mcp.NewTool("todo_sync",
		mcp.WithDescription("Mirror your harness task list into Relay in one call: pass the full current list and this tool creates, updates, reorders, and deletes your todos to match. Items echo back the Relay id — pass it on later syncs to keep rows stable. Other agents' todos are untouched. Call it whenever your task list changes so the app shows live progress."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithArray("items", mcp.Required(), mcp.Description("ordered list: [{id?, content, status?, issue_id?}] — status todo|in_progress|done; omit id to create")),
	), s.todoSync)

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

	// --- visual briefs ---
	// Briefs are Excalidraw-compatible scenes explaining a change set.
	// projects.brief_policy configures expectations: 'never' (agents must not
	// create), 'on_request' (create only when asked), 'pre_merge' (expected
	// before merge-worthy reviews).

	srv.AddTool(mcp.NewTool("get_brief_policy",
		mcp.WithDescription("Get the project's brief policy (never|on_request|pre_merge) — call before deciding whether to produce a visual brief."),
		mcp.WithString("project_id", mcp.Required()),
	), s.getBriefPolicy)

	srv.AddTool(mcp.NewTool("list_briefs",
		mcp.WithDescription("List visual briefs in a granted project, newest first."),
		mcp.WithString("project_id", mcp.Required()),
		mcp.WithString("issue_id", mcp.Description("Filter by linked Relay issue UUID")),
	), s.listBriefs)

	srv.AddTool(mcp.NewTool("get_brief",
		mcp.WithDescription("Get one brief including its scene JSON and comment conversation id."),
		mcp.WithString("brief_id", mcp.Required()),
	), s.getBrief)

	srv.AddTool(mcp.NewTool("create_brief",
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

	srv.AddTool(mcp.NewTool("update_brief",
		mcp.WithDescription("Update a brief's title, summary, status (open|resolved|archived), or replace its "+
			"Excalidraw scene after feedback. Scenes edited by users in the app's embedded Excalidraw editor "+
			"come back as full Excalidraw JSON — preserve elements/files fields when revising."),
		mcp.WithString("brief_id", mcp.Required()),
		mcp.WithString("title"),
		mcp.WithString("summary"),
		mcp.WithString("status", mcp.Description("open|resolved|archived")),
		mcp.WithString("scene", mcp.Description("Replacement Excalidraw scene JSON")),
	), s.updateBrief)
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
	return gin.H{
		"id":              m.ID,
		"conversation_id": m.ConversationID,
		"body":            m.Body,
		"mentions":        mrefs,
		"tags":            m.Tags,
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
	unread := make(map[string]int)
	if urows, err := s.q.AgentConversationUnread(ctx, db.AgentConversationUnreadParams{
		ProjectID: pid, AgentID: agent(ctx).ID,
	}); err == nil {
		for _, u := range urows {
			unread[u.ConversationID.String()] = int(u.Unread)
		}
	}
	out := make([]gin.H, 0, len(rows))
	for _, c := range rows {
		out = append(out, gin.H{
			"id": c.ID, "kind": c.Kind, "issue_id": c.IssueID, "created_at": c.CreatedAt.Time,
			"unread_count": unread[c.ID.String()],
		})
	}
	return jsonResult(out)
}

// resolveConversationArg accepts a conversation_id, a project_id (whose
// conversation is created lazily), or a bare id that might be either.
func (s *Service) resolveConversationArg(ctx context.Context, req mcp.CallToolRequest) (pgtype.UUID, *mcp.CallToolResult) {
	if v := req.GetString("conversation_id", ""); v != "" {
		cid, err := uuidArg(req, "conversation_id")
		if err != nil {
			return pgtype.UUID{}, mcp.NewToolResultError("invalid conversation_id")
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
			conv, err = s.q.CreateProjectConversation(ctx, pid)
		}
		if err != nil {
			// Not a project — treat the id as a conversation (brief threads,
			// issue threads) so `messages <uuid>` works on either.
			if _, cerr := s.q.ResolveConversationProject(ctx, pid); cerr == nil {
				return pid, nil
			}
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
	lim := clampInt(req.GetInt("limit", 50), 1, 200)
	var tag pgtype.Text
	if v := strings.ToLower(strings.TrimSpace(req.GetString("tag", ""))); v != "" {
		tag = pgtype.Text{String: v, Valid: true}
	}
	rows, err := s.q.ListMessages(ctx, db.ListMessagesParams{
		ConversationID: cid, Lim: int32(lim), Tag: tag,
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
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		m := messageJSON(db.GetMessageFullRow(r))
		// own posts are never "new" to their author
		m["was_unread"] = !readBefore[r.ID.String()] && r.AuthorAgentID != agent(ctx).ID
		out = append(out, m)
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
	wasUnread := true
	if rids, err := s.q.AgentOwnReadMessageIDs(ctx, db.AgentOwnReadMessageIDsParams{
		AgentID: agent(ctx).ID, Ids: []pgtype.UUID{mid},
	}); err == nil && len(rids) > 0 {
		wasUnread = false
	}
	_ = s.q.MarkMessageReadAgent(ctx, db.MarkMessageReadAgentParams{
		MessageID: mid, AgentID: agent(ctx).ID,
	})
	out := s.messageJSONFull(ctx, m)
	out["was_unread"] = wasUnread
	return jsonResult(out)
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
	out := gin.H{
		"id": a.ID, "filename": a.Filename, "content_type": a.ContentType,
		"size_bytes": a.SizeBytes,
	}
	// Presigned URLs only work when the public storage endpoint is reachable
	// — often it isn't (dev, NAT, misconfigured deploys). Inline the bytes so
	// agents always get the file; past the cap fall back to the URL.
	const inlineMax = 8 << 20
	if a.SizeBytes <= inlineMax {
		obj, err := s.store.Get(ctx, a.StorageKey)
		if err != nil {
			return errResult(err)
		}
		data, err := io.ReadAll(obj)
		_ = obj.Close()
		if err != nil {
			return errResult(err)
		}
		out["data_base64"] = base64.StdEncoding.EncodeToString(data)
	} else {
		url, err := s.store.PresignGet(ctx, a.StorageKey, a.Filename, a.ContentType)
		if err != nil {
			return errResult(err)
		}
		out["download_url"] = url
		out["note"] = "too large to inline — fetch download_url within its expiry"
	}
	return jsonResult(out)
}

// messageJSONFull is messageJSON plus the attachments list — used wherever a
// message is emitted so live updates never strip attachment rows.
func (s *Service) messageJSONFull(ctx context.Context, m db.GetMessageFullRow) gin.H {
	out := messageJSON(m)
	out["attachments"] = s.attachmentsJSON(ctx, m.ID)
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
	if s.store == nil {
		return mcp.NewToolResultError("storage not configured"), nil
	}
	pid, err := uuidArg(req, "project_id")
	if err != nil {
		return errResult(err)
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
	contentType, ok := attachments.SniffType(data, req.GetString("content_type", ""))
	if !ok {
		return mcp.NewToolResultError("file type not allowed; images, pdf, text and zip are accepted"), nil
	}
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
	pKey, _ := s.projectKey(ctx, pid)
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, issueJSON(issueFromRow(r), r.AssigneeName, pKey))
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
	pKey, _ := s.projectKey(ctx, pid)
	return jsonResult(issueJSON(db.Issue{
		ID: r.ID, ProjectID: r.ProjectID, Number: r.Number, Title: r.Title,
		Description: r.Description, Status: r.Status, Priority: r.Priority,
		AssigneeID: r.AssigneeID, AgentID: r.AgentID, CreatedBy: r.CreatedBy,
		CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
	}, r.AssigneeName, pKey))
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
	if v := req.GetString("project_id", ""); v != "" {
		if err := pid.Scan(v); err != nil || !pid.Valid {
			return mcp.NewToolResultError("invalid project_id"), nil
		}
		conv, err := s.q.GetProjectConversation(ctx, pid)
		if errors.Is(err, pgx.ErrNoRows) {
			conv, err = s.q.CreateProjectConversation(ctx, pid)
		}
		if err != nil {
			// A conversation UUID lands here too (brief/issue threads).
			if cres, cerr := s.q.ResolveConversationProject(ctx, pid); cerr == nil {
				cid = pid
				pid = cres
			} else {
				return errResult(err)
			}
		} else {
			cid = conv.ID
		}
		if err := s.scope(ctx, pid, "message:write"); err != nil {
			return errResult(err)
		}
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
	id, err := s.q.CreateAgentMessage(ctx, db.CreateAgentMessageParams{
		ConversationID: cid, AgentID: agent(ctx).ID, Body: body, ParentID: parent,
		Mentions: mj, Tags: tags, Silent: silent,
	})
	if err != nil {
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
	s.publish(ctx, cid, "message.created", map[string]any{"conversation_id": cid.String(), "message": out})
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
	pKey, _ := s.projectKey(ctx, pid)
	s.publishPID(pid, "issue.created", map[string]any{"issue": issueJSON(i, pgtype.Text{}, pKey)})
	return jsonResult(issueJSON(i, pgtype.Text{}, pKey))
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
		map[string]any{"conversation_id": m.ConversationID.String(), "message": s.messageJSONFull(ctx, m)})
	return jsonResult(s.messageJSONFull(ctx, m))
}

// deleteMessage mirrors the REST rule: the author may delete only while no
// agent has read the message. Replies keep a tombstone via parent_deleted.
func (s *Service) deleteMessage(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
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
func (s *Service) openThread(ctx context.Context, mid, pid pgtype.UUID, title string) (db.GetThreadRow, bool, pgtype.UUID, error) {
	var zero db.GetThreadRow
	parentConvID, err := s.q.GetMessageConversation(ctx, mid)
	if err != nil {
		return zero, false, pgtype.UUID{}, err
	}
	parentConv, err := s.q.GetConversationByID(ctx, parentConvID)
	if err != nil {
		return zero, false, pgtype.UUID{}, err
	}
	if parentConv.Kind == "thread" {
		return zero, false, pgtype.UUID{}, errors.New("threads cannot be nested")
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

func threadOut(tr db.GetThreadRow) map[string]any {
	return map[string]any{
		"id":                  tr.ID.String(),
		"parent_message_id":   tr.ParentMessageID.String(),
		"parent_conversation": tr.ParentConversationID.String(),
		"title":               tr.Title.String,
		"reply_count":         tr.ReplyCount,
		"created_by":          tr.CreatorName,
		"created_at":          tr.CreatedAt.Time.Format("2006-01-02T15:04:05Z07:00"),
	}
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
			map[string]any{"conversation_id": parentConvID.String(), "message": s.messageJSONFull(ctx, m)})
	}
}

// createThread mirrors POST /messages/:id/thread: idempotent per parent
// message, titles fall back to the excerpt, nesting is refused.
func (s *Service) createThread(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
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
	title, _ := req.GetArguments()["title"].(string)
	tr, _, _, err := s.openThread(ctx, mid, pid, title)
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
		return errResult(err)
	}
	who, err := req.RequireString("user")
	if err != nil {
		return errResult(err)
	}
	who = strings.TrimSpace(strings.TrimPrefix(who, "@"))
	question, err := req.RequireString("question")
	if err != nil {
		return errResult(err)
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
		tr, _, _, terr = s.openThread(ctx, mid, pid, "")
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
		map[string]any{"conversation_id": tr.ID.String(), "message": s.messageJSONFull(ctx, m)})
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
		"message": s.messageJSONFull(ctx, m),
	})
}

// resolveInput clears the 'needs-input' tag a request_input question carries
// and optionally posts how it was answered into the same thread — keeps the
// chat honest when the user replied in the harness instead of Relay.
func (s *Service) resolveInput(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
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
					map[string]any{"conversation_id": cid.String(), "message": messageJSON(nm)})
			}
		}
	}
	if fresh, err := s.q.GetMessageFull(ctx, mid); err == nil {
		s.publish(ctx, cid, "message.updated", map[string]any{
			"conversation_id": cid.String(), "message": messageJSON(fresh)})
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
		return errResult(err)
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
	tr, _, _, err := s.openThread(ctx, mid, pid, title)
	if err != nil {
		return errResult(err)
	}
	m, err := s.q.GetMessageFull(ctx, mid)
	if err != nil {
		return errResult(err)
	}
	s.publish(ctx, cid, "message.created",
		map[string]any{"conversation_id": cid.String(), "message": s.messageJSONFull(ctx, m)})
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
		return errResult(err)
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
					map[string]any{"conversation_id": target.String(), "message": messageJSON(nm)})
			}
		}
	}
	if fresh, err := s.q.GetMessageFull(ctx, mid); err == nil {
		s.publish(ctx, cid, "message.updated", map[string]any{
			"conversation_id": cid.String(), "message": messageJSON(fresh)})
	}
	return jsonResult(gin.H{"stopped": mid.String()})
}

// pinMessage mirrors PUT/DELETE /messages/:id/pin — project members (and
// agents with message:write) may pin; no Manage Messages tier exists.
func (s *Service) pinMessage(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
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
			"conversation_id": convID.String(), "message": s.messageJSONFull(ctx, m)})
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
		return errResult(err)
	}
	tid, err := uuidArg(req, "project_id")
	if err != nil {
		return errResult(err)
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
		"conversation_id": target.ID.String(), "message": s.messageJSONFull(ctx, m)})
	return jsonResult(map[string]any{"message": s.messageJSONFull(ctx, m)})
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

// setAvatar lets the agent set its own profile picture - either
// image_base64 bytes or image_url, which the server fetches itself.
func (s *Service) setAvatar(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
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
		return errResult(err)
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
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "project:read"); err != nil {
		return errResult(err)
	}
	return jsonResult(gin.H{"policy": s.briefPolicyFor(ctx, pid)})
}

func (s *Service) listBriefs(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	pid, err := uuidArg(req, "project_id")
	if err != nil {
		return errResult(err)
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
		return errResult(err)
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
		return errResult(err)
	}
	if err := s.scope(ctx, pid, "brief:write"); err != nil {
		return errResult(err)
	}
	if pol := s.briefPolicyFor(ctx, pid); pol == "never" {
		return mcp.NewToolResultError("this project's brief policy is 'never' — do not create visual briefs here"), nil
	}
	title, err := req.RequireString("title")
	if err != nil {
		return errResult(err)
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
		return errResult(err)
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
