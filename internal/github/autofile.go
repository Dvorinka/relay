// Auto-filing: a message in a project channel that opens with an explicit
// report marker ("bug: …", "enhancement: …", "/feature …") and whose project
// has exactly one linked repo is filed upstream as a GitHub issue, mirrored
// back onto the Relay board, and announced as a reply in the source
// conversation. Marker-based on purpose — a casual mention of "bug" in
// prose must never reach the repo.
package github

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/Dvorinka/relay/internal/conversations"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/events"
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
	if err != nil {
		return
	}
	switch conv.Kind {
	case "project", "channel", "thread":
	default:
		return
	}
	// One linked repo only — with several we can't guess where it belongs.
	repos, err := s.q.ListProjectRepos(ctx, pgtype.UUID{Bytes: projectID, Valid: true})
	if err != nil || len(repos) != 1 {
		return
	}
	repo := repos[0]
	cli, err := s.githubClient(ctx)
	if err != nil {
		return // GitHub app not connected on this server
	}

	title := firstLineOf(report, 100)
	if title == "" {
		title = "Untitled report"
	}
	gh, err := cli.CreateIssue(ctx, repo.InstallationID, repo.Owner, repo.Name,
		title, s.issueBody(ctx, msgID, report, authorName))
	if err != nil {
		s.log.Warn("auto-file GitHub issue failed", zap.Error(err))
		return
	}
	if gh.Title == "" {
		gh.Title = title // sparse response — the check constraint needs a title
	}
	issueID, err := s.MirrorIssue(ctx, repo, *gh)
	if err != nil {
		s.log.Warn("auto-file mirror failed", zap.Error(err))
	} else {
		s.ghActivity(ctx, issueID, "auto_file",
			fmt.Sprintf(`{"message_id":%q,"author":%q}`, msgID.String(), authorName))
	}
	s.invalidateDevPanel(repo.ProjectID)
	s.announce(ctx, conv, msgID, authorID, repo, gh)
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

// announce replies to the triggering message with the GitHub link, as the
// reporter — the same convention postThreadNotice uses for "started a
// thread" lines. Published on the bus so the reply appears live.
func (s *Service) announce(ctx context.Context, conv db.Conversation, parentID, authorID pgtype.UUID, repo db.Repository, gh *GHIssue) {
	id, err := s.q.CreateMessage(ctx, db.CreateMessageParams{
		ConversationID: conv.ID,
		AuthorUserID:   authorID,
		ParentID:       parentID,
		Body: fmt.Sprintf("Filed on GitHub → %s/%s#%d — %s",
			repo.Owner, repo.Name, gh.Number, gh.HTMLURL),
	})
	if err != nil {
		s.log.Warn("auto-file announce failed", zap.Error(err))
		return
	}
	m, err := s.q.GetMessageByID(ctx, id)
	if err != nil || s.Bus == nil {
		return
	}
	out := conversations.MessageJSON(conversations.MessageView{
		ID: m.ID, ConversationID: m.ConversationID, ParentID: m.ParentID,
		Body: m.Body, Mentions: m.Mentions, Tags: m.Tags, Silent: m.Silent,
		CreatedAt: m.CreatedAt, EditedAt: m.EditedAt,
		AuthorUserID: m.AuthorUserID, AuthorAgentID: m.AuthorAgentID,
		AuthorKindSnapshot: m.AuthorKindSnapshot,
		AuthorName:         m.AuthorName, AuthorAvatar: m.AuthorAvatar,
		ParentAuthorName: m.ParentAuthorName, ParentBody: m.ParentBody,
		ParentDeleted: m.ParentDeleted,
	})
	s.Bus.Publish(events.Event{Type: "message.created", ProjectID: conv.ProjectID.Bytes,
		Data: map[string]any{"conversation_id": m.ConversationID.String(), "message": out}})
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
