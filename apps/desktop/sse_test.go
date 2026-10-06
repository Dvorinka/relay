package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// The SSE pump must forward each data frame verbatim: multiline data joins
// with \n, comments and control lines are skipped, and a mid-stream write is
// delivered without the connection closing.
func TestStreamEventsDispatchesFrames(t *testing.T) {
	var mu sync.Mutex
	var got []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fl, _ := w.(http.Flusher)
		fmt.Fprint(w, ": heartbeat\n\n")
		fmt.Fprint(w, "event: message\ndata: {\"type\":\"message.created\"}\n\n")
		if fl != nil {
			fl.Flush()
		}
		fmt.Fprint(w, "data: first\ndata: second\n\n")
		if fl != nil {
			fl.Flush()
		}
		<-time.After(50 * time.Millisecond)
	}))
	defer srv.Close()

	a := &App{}
	emit := func(s string) {
		mu.Lock()
		got = append(got, s)
		mu.Unlock()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if !a.streamEvents(ctx, srv.URL, emit) {
		t.Fatal("stream rejected")
	}
	mu.Lock()
	defer mu.Unlock()
	want := []string{`{"type":"message.created"}`, "first\nsecond"}
	if len(got) != len(want) {
		t.Fatalf("frames %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("frame %d: got %q want %q", i, got[i], want[i])
		}
	}
}

func TestStreamEventsRejectsNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	if (&App{}).streamEvents(context.Background(), srv.URL, func(string) {}) {
		t.Fatal("401 reported as connected")
	}
}
