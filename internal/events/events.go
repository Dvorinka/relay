// Package events is a tiny in-process pub/sub hub. One Hub lives inside the
// API process; handlers Publish and the SSE endpoint fans out to subscribers.
// jarvis: ceiling is single-process; upgrade to LISTEN/NOTIFY if Relay ever
// runs multi-replica.
package events

import (
	"sync"

	"github.com/google/uuid"
)

type Event struct {
	Type      string         `json:"type"`
	ProjectID uuid.UUID      `json:"project_id"`
	Data      map[string]any `json:"data,omitempty"`
}

type Hub struct {
	mu   sync.Mutex
	subs map[uint64]chan Event
	next uint64
}

func New() *Hub {
	return &Hub{subs: map[uint64]chan Event{}}
}

func (h *Hub) Publish(e Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, ch := range h.subs {
		select {
		case ch <- e:
		default: // slow consumer drops; clients refetch on next event anyway
		}
	}
}

func (h *Hub) Subscribe() (uint64, <-chan Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.next++
	ch := make(chan Event, 32)
	h.subs[h.next] = ch
	return h.next, ch
}

func (h *Hub) Unsubscribe(id uint64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if ch, ok := h.subs[id]; ok {
		close(ch)
		delete(h.subs, id)
	}
}
