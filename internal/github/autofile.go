// Auto-filing: a message in a project channel that opens with an explicit
// report marker ("bug: …", "enhancement: …", "/feature …") and whose project
// has exactly one linked repo is filed upstream as a GitHub issue, mirrored
// back onto the Relay board, and announced as a reply in the source
// conversation. Marker-based on purpose — a casual mention of "bug" in
// prose must never reach the repo.
package github

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/Dvorinka/relay/internal/auth"
	"github.com/Dvorinka/relay/internal/conversations"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/events"
	"github.com/Dvorinka/relay/internal/httpx"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"go.uber.org/zap"
)

// autoFileMarker matches an explicit report marker at the very start of a
// message — either a keyword prefix ("bug:", "feature request —") or a
// slash-command token ("/issue"). The colon/dash must hug the keyword, so
// prose like "features: nice work" or "the bug we saw" never fires.
var autoFileMarker = regexp.MustCompile(
	`(?i)^[ \t]*(?:/(?:bug|issue|enhancement|feature|suggestion)|(?:bug|issue|enhancement|feature(?:[ _-]request)?|suggestion|proposal)[:;\-–—])[ \t]*`)

// WatchMessages subscribes to the shared event hub and files qualifying
// user messages as GitHub issues. Called once from server wiring after Bus
// is assigned; the subscription lives for the process lifetime.
func (s *Service) WatchMessages() {
	if s.Bus == nil {
		return
	}
	_, ch := s.Bus.Subscribe()
	go func() {
		for e := range ch {
			if e.Type != "message.created" {
				continue
			}
			if msg, ok := e.Data["message"].(gin.H); ok {
				// Per event: a slow GitHub call must not head-of-line-block
				// the shared event buffer and drop later reports.
				go s.maybeAutoFile(e.ProjectID, msg)
			}
		}
	}()
}

func (s *Service) maybeAutoFile(projectID uuid.UUID, msg gin.H) {
	author, _ := msg["author"].(gin.H)
	// Agents and the announce replies below never trigger — only people
	// file reports, and only once per message.
	if kind, _ := author["kind"].(string); kind != "user" {
		return
	}
	body, _ := msg["body"].(string)
	report := autoFileMarker.ReplaceAllString(body, "")
	report = strings.TrimSpace(report)
	if report == "" || report == body {
		return
	}
	authorID, ok := scanUUID(asString(author["id"]))
	if !ok {
		return
	}
	msgID, ok := scanUUID(asString(msg["id"]))
	if !ok {
		return
	}
	convID, ok := scanUUID(asString(msg["conversation_id"]))
	if !ok {
		return
	}
	authorName, _ := author["name"].(string)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Only open discussion surfaces — a message inside an issue or brief
	// conversation is already tracked work, not a fresh report.
	conv, err := s.q.GetConversationByID(ctx, convID)
	if err != nil || !fileableKind(conv.Kind) {
		return
	}
	// One linked repo only — with several we can't guess where it belongs.
	repos, err := s.q.ListProjectRepos(ctx, pgtype.UUID{Bytes: projectID, Valid: true})
	if err != nil || len(repos) == 0 {
		return
	}
	if len(repos) > 1 {
		// GitHub is clearly in use but the target is ambiguous — point the
		// reporter at the explicit action instead of silently dropping it.
		s.reply(ctx, conv, msgID, authorID, fmt.Sprintf(
			"Couldn't auto-file — this project links %d repos. Message menu → File on GitHub picks one explicitly.",
			len(repos)))
		return
	}
	repo := repos[0]
	if _, err := s.githubClient(ctx); err != nil {
		return // GitHub app not connected on this server
	}

	title := firstLineOf(report, 100)
	if title == "" {
		title = "Untitled report"
	}
	if _, err := s.fileMessage(ctx, repo, conv, msgID, authorID, authorName,
		title, report, "auto_file"); err != nil && !errors.Is(err, errAlreadyFiled) {
		s.log.Warn("auto-file GitHub issue failed", zap.Error(err))
	}
}

// filedTag marks the source message once an upstream issue exists for it —
// claimed atomically before the GitHub call, so a repeated file is refused
// instead of duplicating the issue.
const filedTag = "filed"

var errAlreadyFiled = errors.New("message already filed on GitHub")

// fileMessage runs the shared tail of auto- and manual filing: claim the
// message, create the GitHub issue, mirror it onto the board, record
// provenance, and reply in the source conversation with the link.
func (s *Service) fileMessage(ctx context.Context, repo db.Repository, conv db.Conversation,
	msgID, authorID pgtype.UUID, authorName, title, report, activityKind string) (*GHIssue, error) {
	cli, err := s.githubClient(ctx)
	if err != nil {
		return nil, err
	}
	n, err := s.q.AddMessageTag(ctx, db.AddMessageTagParams{ID: msgID, Tag: filedTag})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, errAlreadyFiled
	}
	s.publishMessage(ctx, conv, msgID, "message.updated")
	gh, err := cli.CreateIssue(ctx, repo.InstallationID, repo.Owner, repo.Name,
		title, s.issueBody(ctx, msgID, report, authorName))
	if err != nil {
		// Nothing exists upstream — release the claim so a retry can file.
		_ = s.q.RemoveMessageTag(ctx, db.RemoveMessageTagParams{ID: msgID, Tag: filedTag})
		return nil, err
	}
	if gh.Title == "" {
		gh.Title = title // sparse response — the check constraint needs a title
	}
	issueID, err := s.MirrorIssue(ctx, repo, *gh)
	if err != nil {
		s.log.Warn("file mirror failed", zap.Error(err))
	} else {
		s.ghActivity(ctx, issueID, activityKind,
			fmt.Sprintf(`{"message_id":%q,"author":%q}`, msgID.String(), authorName))
	}
	s.invalidateDevPanel(repo.ProjectID)
	s.announce(ctx, conv, msgID, authorID, repo, gh)
	return gh, nil
}

// handleFileMessage is the explicit version of auto-filing: POST
// /api/messages/:id/github pushes any message — marker or not — onto a
// linked repo. With several repos the caller names one via {"repo_id"}.
func (s *Service) handleFileMessage(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "id")
	if !ok {
		return
	}
	user := auth.CurrentUser(c)
	msg, err := s.q.GetMessageWithProjectForUser(c.Request.Context(), db.GetMessageWithProjectForUserParams{
		ID: id, UserID: user.ID,
	})
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "message not found")
		return
	}
	var req struct {
		RepoID string `json:"repo_id"`
		Title  string `json:"title"`
	}
	if c.Request.Body != nil && c.Request.ContentLength > 0 && !httpx.BindJSON(c, &req) {
		return
	}
	repos, err := s.q.ListProjectRepos(c.Request.Context(), msg.ProjectID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	if len(repos) == 0 {
		httpx.Error(c, http.StatusConflict, "no_repo", "project has no linked GitHub repository")
		return
	}
	repo := repos[0]
	if len(repos) > 1 {
		matched := false
		for _, r := range repos {
			if r.ID.String() == req.RepoID {
				repo, matched = r, true
			}
		}
		if !matched {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "repo_id is not linked to this project")
			return
		}
	}
	m, err := s.q.GetMessageByID(c.Request.Context(), msg.ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	conv, err := s.q.GetConversationByID(c.Request.Context(), m.ConversationID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	if !fileableKind(conv.Kind) {
		httpx.Error(c, http.StatusBadRequest, "bad_request",
			"messages in this conversation can't be filed on GitHub")
		return
	}
	// The marker is filing metadata, not content — strip it here too.
	report := strings.TrimSpace(autoFileMarker.ReplaceAllString(msg.Body, ""))
	if report == "" {
		report = strings.TrimSpace(msg.Body)
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = firstLineOf(report, 100)
	}
	if title == "" {
		title = "Untitled report"
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()
	gh, err := s.fileMessage(ctx, repo, conv, msg.ID, user.ID, user.Name,
		title, report, "manual_file")
	if err != nil {
		if errors.Is(err, errAlreadyFiled) {
			httpx.Error(c, http.StatusConflict, "already_filed",
				"this message is already filed on GitHub")
			return
		}
		httpx.Error(c, http.StatusBadGateway, "github_error", truncate(err.Error(), 300))
		return
	}
	c.JSON(http.StatusCreated, gin.H{
		"issue": gin.H{"number": gh.Number, "url": gh.HTMLURL, "state": gh.State},
	})
}

// issueBody renders the GitHub issue body: the report text, an attachment
// section whose images embed via short-lived presigned URLs (GitHub's camo
// fetches them on first render and caches permanently), and a provenance
// line naming the Relay author.
func (s *Service) issueBody(ctx context.Context, msgID pgtype.UUID, report, authorName string) string {
	var b strings.Builder
	b.WriteString(report)
	atts, err := s.q.ListAttachmentsForMessages(ctx, []pgtype.UUID{msgID})
	if err == nil && len(atts) > 0 && s.Store != nil {
		b.WriteString("\n\n### Attachments\n")
		for _, a := range atts {
			url, err := s.Store.PresignGet(ctx, a.StorageKey, a.Filename, a.ContentType)
			if err != nil {
				continue
			}
			if strings.HasPrefix(a.ContentType, "image/") {
				fmt.Fprintf(&b, "![%s](%s)\n", a.Filename, url)
			} else {
				fmt.Fprintf(&b, "- [%s (%s)](%s)\n", a.Filename, humanSize(a.SizeBytes), url)
			}
		}
		b.WriteString("\n_(hosted by Relay — file links expire, images are cached by GitHub on first view)_\n")
	}
	fmt.Fprintf(&b, "\n---\n_Filed by %s via Relay._", authorName)
	return b.String()
}

// announce replies to the triggering message with the GitHub link.
func (s *Service) announce(ctx context.Context, conv db.Conversation, parentID, authorID pgtype.UUID, repo db.Repository, gh *GHIssue) {
	s.reply(ctx, conv, parentID, authorID, fmt.Sprintf("Filed on GitHub → %s/%s#%d — %s",
		repo.Owner, repo.Name, gh.Number, gh.HTMLURL))
}

// reply posts a short system-narrated reply under the triggering message,
// as the reporter — the same convention postThreadNotice uses for "started
// a thread" lines. Published on the bus so the reply appears live.
func (s *Service) reply(ctx context.Context, conv db.Conversation, parentID, authorID pgtype.UUID, body string) {
	id, err := s.q.CreateMessage(ctx, db.CreateMessageParams{
		ConversationID: conv.ID,
		AuthorUserID:   authorID,
		ParentID:       parentID,
		Body:           body,
		Tags:           []string{"autofile"},
	})
	if err != nil {
		s.log.Warn("auto-file reply failed", zap.Error(err))
		return
	}
	m, err := s.q.GetMessageByID(ctx, id)
	if err != nil || s.Bus == nil {
		return
	}
	s.Bus.Publish(events.Event{Type: "message.created", ProjectID: conv.ProjectID.Bytes,
		Data: map[string]any{"conversation_id": m.ConversationID.String(), "message": messageJSON(m)}})
}

// publishMessage pushes a message.created/updated frame for the given
// message — used to repaint rows after the filed tag lands.
func (s *Service) publishMessage(ctx context.Context, conv db.Conversation, msgID pgtype.UUID, eventType string) {
	m, err := s.q.GetMessageByID(ctx, msgID)
	if err != nil || s.Bus == nil {
		return
	}
	s.Bus.Publish(events.Event{Type: eventType, ProjectID: conv.ProjectID.Bytes,
		Data: map[string]any{"conversation_id": m.ConversationID.String(), "message": messageJSON(m)}})
}

func messageJSON(m db.GetMessageByIDRow) gin.H {
	return conversations.MessageJSON(conversations.MessageView{
		ID: m.ID, ConversationID: m.ConversationID, ParentID: m.ParentID,
		Body: m.Body, Mentions: m.Mentions, Tags: m.Tags, Silent: m.Silent,
		CreatedAt: m.CreatedAt, EditedAt: m.EditedAt,
		AuthorUserID: m.AuthorUserID, AuthorAgentID: m.AuthorAgentID,
		AuthorKindSnapshot: m.AuthorKindSnapshot,
		AuthorName:         m.AuthorName, AuthorAvatar: m.AuthorAvatar,
		ParentAuthorName: m.ParentAuthorName, ParentBody: m.ParentBody,
		ParentDeleted: m.ParentDeleted,
	})
}

// fileableKind limits filing — auto or manual — to open discussion
// surfaces; issue/brief conversations are already tracked work.
func fileableKind(kind string) bool {
	switch kind {
	case "project", "channel", "thread":
		return true
	}
	return false
}

func scanUUID(s string) (pgtype.UUID, bool) {
	var id pgtype.UUID
	if s == "" {
		return id, false
	}
	return id, id.Scan(s) == nil
}

func asString(v any) string {
	s, _ := v.(string)
	return s
}

func firstLineOf(s string, max int) string {
	line, _, _ := strings.Cut(s, "\n")
	line = strings.TrimSpace(line)
	if r := []rune(line); len(r) > max {
		line = string(r[:max-1]) + "…"
	}
	return line
}

func humanSize(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/float64(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f KB", float64(n)/float64(1<<10))
	default:
		return fmt.Sprintf("%d B", n)
	}
}
