// Package mentions extracts structured entity references from message
// bodies. Syntax is the same family the composer inserts:
//
//	@user:<name>          workspace member
//	@agent:<slug>         agent
//	KEY-123               Relay issue (also mirrors GitHub issues/PRs)
//	owner/repo#123        GitHub issue or PR
//	@file:<path>          linked local folder file
//	@gh:<owner/repo>:<path> GitHub repo file
//
// Extraction is deliberately tolerant — refs that fail to resolve still get
// stored with just kind+ref so agents see the intent.
package mentions

import (
	"regexp"
)

// Ref is one structured mention on a message.
type Ref struct {
	Kind  string `json:"kind"`            // user|agent|mention|issue|gh|file
	Ref   string `json:"ref"`             // slug | KEY-1 | owner/repo#1 | path
	Label string `json:"label"`           // human label for UI/agent
	ID    string `json:"id,omitempty"`    // resolved entity uuid
	URL   string `json:"url,omitempty"`   // web URL when known
	Found bool   `json:"found,omitempty"` // false when ref didn't resolve
}

var (
	userAgentRe   = regexp.MustCompile(`@(?:user|agent):([A-Za-z0-9][A-Za-z0-9._-]{0,59})`)
	ghRe          = regexp.MustCompile(`@gh:([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+):(\S+)`)
	fileRe        = regexp.MustCompile(`@file:(\S+)`)
	ghNumRe       = regexp.MustCompile(`\b([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)#(\d+)\b`)
	issueKeyRe    = regexp.MustCompile(`\b([A-Z][A-Z0-9]{1,9}-\d+)\b`)
	userAgentKind = regexp.MustCompile(`@(user|agent):`)
	bareMentionRe = regexp.MustCompile(`@([A-Za-z0-9][A-Za-z0-9._-]{0,59})`)
)

// Extract scans a body once and returns every mention, deduped by
// kind+ref. Order follows first appearance.
func Extract(body string) []Ref {
	var out []Ref
	seen := map[string]bool{}
	add := func(r Ref) {
		k := r.Kind + ":" + r.Ref
		if !seen[k] {
			seen[k] = true
			out = append(out, r)
		}
	}

	// Span bookkeeping: tokens consumed by earlier patterns must not re-fire
	// (e.g. `KEY-1` inside `@gh:o/r:KEY-1.md` is a filename, not an issue).
	used := map[int]bool{}
	mark := func(locs [][]int) {
		for _, l := range locs {
			for i := l[0]; i < l[1]; i++ {
				used[i] = true
			}
		}
	}
	free := func(idx int) bool { return !used[idx] }
	// @ tokens need a word boundary — emails like me@x.com aren't mentions.
	boundary := func(idx int) bool {
		if idx == 0 {
			return true
		}
		return body[idx-1] == ' ' || body[idx-1] == '\n' || body[idx-1] == '\t' ||
			body[idx-1] == '(' || body[idx-1] == '[' || body[idx-1] == '"'
	}
	atTokens := func(locs [][]int) [][]int {
		out := locs[:0]
		for _, l := range locs {
			if boundary(l[0]) {
				out = append(out, l)
			}
		}
		return out
	}

	mark(atTokens(userAgentRe.FindAllStringIndex(body, -1)))
	ghSpans := atTokens(ghRe.FindAllStringSubmatchIndex(body, -1))
	fileSpans := atTokens(fileRe.FindAllStringSubmatchIndex(body, -1))
	mark(ghSpans)
	mark(fileSpans)

	for _, m := range atTokens(userAgentKind.FindAllStringSubmatchIndex(body, -1)) {
		kind := body[m[2]:m[3]]
		name := body[m[0]:]
		full := userAgentRe.FindStringSubmatch(name)
		if len(full) < 2 {
			continue
		}
		add(Ref{Kind: kind, Ref: full[1], Label: full[1]})
	}
	for _, m := range ghSpans {
		repo := body[m[2]:m[3]]
		path := body[m[4]:m[5]]
		add(Ref{Kind: "file", Ref: "gh:" + repo + ":" + path, Label: path,
			URL: "https://github.com/" + repo + "/blob/HEAD/" + path})
	}
	for _, m := range fileSpans {
		path := body[m[2]:m[3]]
		add(Ref{Kind: "file", Ref: path, Label: path})
	}
	for _, m := range ghNumRe.FindAllStringSubmatchIndex(body, -1) {
		if !free(m[0]) {
			continue
		}
		repo := body[m[2]:m[3]]
		num := body[m[4]:m[5]]
		add(Ref{Kind: "gh", Ref: repo + "#" + num, Label: repo + "#" + num,
			URL: "https://github.com/" + repo + "/issues/" + num})
	}
	// Bare @name — resolves agent-slug first, then user name/email-part.
	// `@file:`/`@gh:`/`@user:`/`@agent:` spans are already marked used.
	var bare [][]int
	for _, m := range atTokens(bareMentionRe.FindAllStringSubmatchIndex(body, -1)) {
		if !free(m[0]) {
			continue
		}
		// a colon right after the name means a prefixed token handled above
		if m[1] < len(body) && body[m[1]] == ':' {
			continue
		}
		bare = append(bare, m)
		name := body[m[2]:m[3]]
		add(Ref{Kind: "mention", Ref: name, Label: name})
	}
	mark(bare)
	for _, m := range issueKeyRe.FindAllStringIndex(body, -1) {
		if !free(m[0]) || !free(m[1]) {
			continue
		}
		key := body[m[0]:m[1]]
		add(Ref{Kind: "issue", Ref: key, Label: key})
	}
	return out
}
