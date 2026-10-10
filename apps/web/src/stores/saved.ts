// Saved messages: the id set backs the Save/Unsave menu state; the full
// list loads lazily for the Saved page. Refetch on save/unsave is cheap
// enough that no SSE event is needed.
import { createSignal } from "solid-js";
import type { SavedMessage } from "@relay/api-client";
import { api } from "../lib/api";
import { net } from "../lib/net";

const [ids, setIds] = createSignal<Set<string>>(new Set());
const [items, setItems] = createSignal<SavedMessage[] | null>(null);
let seeded = false;

async function refresh() {
  if (net.isLocal()) return;
  try {
    const r = await api.listSaved();
    setItems(r.messages);
    setIds(new Set(r.messages.map((m) => m.id)));
  } catch {
    /* leave stale state */
  }
}

// seed loads the id set once — called when the message actions menu first
// opens, so a cold chat render doesn't pay for a request it may not need.
export function seedSaved() {
  if (seeded) return;
  seeded = true;
  void refresh();
}

export function isSaved(messageId: string): boolean {
  return ids().has(messageId);
}

export function savedItems(): SavedMessage[] | null {
  return items();
}

export async function toggleSaved(messageId: string) {
  const next = !ids().has(messageId);
  setIds((s) => {
    const n = new Set(s);
    if (next) n.add(messageId);
    else n.delete(messageId);
    return n;
  });
  try {
    await api.saveMessage(messageId, next);
  } catch {
    setIds((s) => {
      const n = new Set(s);
      if (next) n.delete(messageId);
      else n.add(messageId);
      return n;
    });
    return;
  }
  void refresh();
}
