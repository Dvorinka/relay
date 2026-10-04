package mentions

import (
	"testing"

	"github.com/google/uuid"
)

func TestUserIDs(t *testing.T) {
	uid := uuid.New()
	refs := []Ref{
		{Kind: "user", Ref: "td", Found: true, ID: uid.String()},
		{Kind: "agent", Ref: "devin", Found: true, ID: uuid.New().String()},
		{Kind: "user", Ref: "ghost", Found: false, ID: ""},
		{Kind: "issue", Ref: "REL-1"},
		{Kind: "user", Ref: "bad", Found: true, ID: "not-a-uuid"},
	}
	ids := UserIDs(refs)
	if len(ids) != 1 || ids[0].Bytes != uid {
		t.Fatalf("expected only the resolved user id, got %v", ids)
	}
}
