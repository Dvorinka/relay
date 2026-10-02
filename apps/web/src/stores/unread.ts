import { createSignal } from "solid-js";
import { api } from "../lib/api";

const [unread, setUnread] = createSignal<Record<string, number>>({});
const [pendingReviews, setPendingReviews] = createSignal<
  Record<string, number>
>({});

export function useUnread() {
  return { unread };
}

export function usePendingReviews() {
  return { pendingReviews };
}

export async function refreshUnread() {
  try {
    const r = await api.unread();
    setUnread(r.unread);
    setPendingReviews(r.reviews ?? {});
  } catch {
    /* offline — keep the last known counts */
  }
}
