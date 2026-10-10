// Presence: which users have an open /events stream right now. The server
// marks connect/disconnect on its side and broadcasts presence.update; the
// initial set comes from GET /api/me/presence. Local mode has no stream —
// the current device user counts as online, everyone else is unknown.
import { createSignal } from "solid-js";
import { api } from "../lib/api";
import { net } from "../lib/net";
import { subscribe, type RelayEvent } from "../lib/events";

const [onlineIds, setOnlineIds] = createSignal<Set<string>>(new Set());
let inited = false;

export function initPresence() {
  if (inited) return;
  inited = true;
  if (!net.isLocal()) {
    api
      .presence()
      .then((r) => setOnlineIds(new Set(r.online)))
      .catch(() => {});
  }
  subscribe((e: RelayEvent) => {
    if (e.type !== "presence.update") return;
    const d = e.data as { user_id?: string; online?: boolean } | undefined;
    if (!d?.user_id) return;
    setOnlineIds((s) => {
      const next = new Set(s);
      if (d.online) next.add(d.user_id!);
      else next.delete(d.user_id!);
      return next;
    });
  });
}

export function isOnline(userId: string | undefined): boolean {
  return !!userId && onlineIds().has(userId);
}
