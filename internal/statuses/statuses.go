// Package statuses: per-project issue status definitions. projects.statuses
// is NULL for the built-in six; otherwise a JSON array of {id,label,color,
// closed}. "closed" marks terminal states (mirrors the old done|cancelled
// rule for GitHub sync and board collapsing).
package statuses

import (
	"encoding/json"
	"regexp"
)

// Def is one column/lane a project issue may sit in.
type Def struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Color  string `json:"color"`
	Closed bool   `json:"closed,omitempty"`
}

// Defaults mirrors the pre-migration CHECK constraint exactly.
func Defaults() []Def {
	return []Def{
		{ID: "backlog", Label: "Backlog", Color: "#78716c"},
		{ID: "todo", Label: "To do", Color: "#0891b2"},
		{ID: "in_progress", Label: "In progress", Color: "#d97706"},
		{ID: "review", Label: "In review", Color: "#7c3aed"},
		{ID: "done", Label: "Done", Color: "#059669", Closed: true},
		{ID: "cancelled", Label: "Cancelled", Color: "#dc2626", Closed: true},
	}
}

var idPattern = regexp.MustCompile(`^[a-z0-9_-]{1,32}$`)
var colorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// Parse decodes a project.statuses blob; nil/empty yields Defaults.
func Parse(raw []byte) []Def {
	if len(raw) == 0 {
		return Defaults()
	}
	var defs []Def
	if json.Unmarshal(raw, &defs) != nil || len(defs) == 0 {
		return Defaults()
	}
	return defs
}

// Validate checks a user-supplied list; ok=false carries a message for 400s.
func Validate(defs []Def) (string, bool) {
	if len(defs) == 0 || len(defs) > 24 {
		return "provide 1-24 statuses", false
	}
	seen := map[string]bool{}
	for _, d := range defs {
		if !idPattern.MatchString(d.ID) {
			return "status ids must match ^[a-z0-9_-]{1,32}$", false
		}
		if seen[d.ID] {
			return "duplicate status id: " + d.ID, false
		}
		seen[d.ID] = true
		if d.Label == "" || len(d.Label) > 40 {
			return "status labels must be 1-40 characters", false
		}
		if d.Color != "" && !colorPattern.MatchString(d.Color) {
			return "status colors must be #rrggbb", false
		}
	}
	if !defs[len(defs)-1].Closed {
		return "at least the last status must be marked closed", false
	}
	return "", true
}

// Contains reports whether id is a usable status in defs.
func Contains(defs []Def, id string) bool {
	for _, d := range defs {
		if d.ID == id {
			return true
		}
	}
	return false
}

// IsClosed reports whether id is a terminal status in defs.
func IsClosed(defs []Def, id string) bool {
	for _, d := range defs {
		if d.ID == id {
			return d.Closed
		}
	}
	return false
}
