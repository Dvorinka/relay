package search

import "testing"

func TestSplitQueryQualifiers(t *testing.T) {
	text, author, key, has, mention, before, after := splitQuery(
		"deploy fix from:td in:REL has:link mentions:devin during:2024-05")
	if text != "deploy fix" {
		t.Fatalf("text = %q", text)
	}
	if author != "td" || key != "REL" || has != "link" || mention != "devin" {
		t.Fatalf("qualifiers = %q %q %q %q", author, key, has, mention)
	}
	if !before.Valid || !after.Valid {
		t.Fatal("during: should set both bounds")
	}
	if before.Time.Month() != 6 || after.Time.Month() != 5 {
		t.Fatalf("during:2024-05 = [%v, %v)", after.Time, before.Time)
	}
}

func TestSplitQueryDuringYearAndDay(t *testing.T) {
	_, _, _, _, _, before, _ := splitQuery("during:2024")
	if !before.Valid || before.Time.Year() != 2025 {
		t.Fatalf("year bound = %v", before.Time)
	}
	_, _, _, _, _, before2, after2 := splitQuery("during:2024-05-03")
	if !after2.Valid || !before2.Valid || before2.Time.Day() != 4 {
		t.Fatalf("day bounds = [%v, %v)", after2.Time, before2.Time)
	}
}

func TestSplitQueryQuotedValues(t *testing.T) {
	// Multi-word names arrive quoted — the whole span is the value.
	text, author, _, _, mention, _, _ := splitQuery(
		`hello from:"Jane Smith" mentions:"Agent Bot"`)
	if text != "hello" {
		t.Fatalf("text = %q", text)
	}
	if author != "Jane Smith" {
		t.Fatalf("author = %q", author)
	}
	if mention != "Agent Bot" {
		t.Fatalf("mention = %q", mention)
	}
}

func TestSplitQueryLeavesPlainText(t *testing.T) {
	text, _, _, _, _, _, _ := splitQuery("just words mentions")
	if text != "just words mentions" {
		t.Fatalf("text = %q", text)
	}
}
