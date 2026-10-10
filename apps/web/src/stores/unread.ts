import { createEffect, createMemo, createSignal } from "solid-js";
import type { UnreadConversation } from "@relay/api-client";
import { api } from "../lib/api";
import { desktopSetUnread } from "../lib/desktop";

const [unread, setUnread] = createSignal<Record<string, number>>({});
const [unreadConversations, setUnreadConversations] = createSignal<
  UnreadConversation[]
>([]);
const [pendingReviews, setPendingReviews] = createSignal<
  Record<string, number>
>({});

export function useUnread() {
  return { unread };
}

// Which conversations hold unread messages — powers the Inbox breakdown and
// per-issue dots on issue lists.
export function useUnreadConversations() {
  return { unreadConversations };
}

// issue_id -> unread count, for marking issue rows.
const unreadByIssueMap = createMemo(() => {
  const m = new Map<string, number>();
  for (const c of unreadConversations()) {
    if (c.kind === "issue" && c.issue_id) m.set(c.issue_id, c.unread);
  }
  return m;
});

export function useUnreadByIssue() {
  return unreadByIssueMap;
}

// Total unread across conversations — bridged to the desktop shell's
// window title and tray badge. The effect is a no-op in a plain browser.
const unreadTotal = createMemo(() =>
  unreadConversations().reduce((sum, c) => sum + c.unread, 0),
);
createEffect(() => desktopSetUnread(unreadTotal()));

export function usePendingReviews() {
  return { pendingReviews };
}

export async function refreshUnread() {
  try {
    const r = await api.unread();
    setUnread(r.unread);
    setUnreadConversations(r.conversations ?? []);
    setPendingReviews(r.reviews ?? {});
  } catch {
    /* offline — keep the last known counts */
  }
}

// Mark one conversation read: drop the row and decrement the project total
// immediately; a failed call restores truth via refreshUnread.
export async function markConversationRead(c: UnreadConversation) {
  setUnreadConversations((rows) =>
    rows.filter((r) => r.conversation_id !== c.conversation_id),
  );
  setUnread((u) => ({
    ...u,
    [c.project_id]: Math.max(0, (u[c.project_id] ?? 0) - c.unread),
  }));
  try {
    await api.markConversationRead(c.conversation_id);
  } catch {
    void refreshUnread();
  }
}

// Mark every unread conversation read. No bulk endpoint — fan out per
// conversation; the count is small in practice.
export async function markAllRead() {
  const rows = unreadConversations();
  if (rows.length === 0) return;
  setUnreadConversations([]);
  setUnread({});
  await Promise.allSettled(
    rows.map((r) => api.markConversationRead(r.conversation_id)),
  );
  void refreshUnread();
}
