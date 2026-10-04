// Foreground notifications: SSE message.created events that @mention the
// signed-in user or reply to one of their messages surface a desktop
// notification while the app runs. This is the path that works inside the
// Wails shell — web-push needs a service worker + VAPID keys the shell
// lacks, which is why "Enable notifications" used to be a dead button there.
import type { Message } from "@relay/api-client";
import { desktopNotify, isDesktop } from "./desktop";
import { subscribe, type RelayEvent } from "./events";
import { notifySound, playSound } from "./sounds";

const K_NOTIFY = "relay.notify";
const K_NOTIFY_CATS = "relay.notify.categories";

export function notifyEnabled(): boolean {
  return localStorage.getItem(K_NOTIFY) === "1";
}

export function setNotifyEnabled(on: boolean) {
  localStorage.setItem(K_NOTIFY, on ? "1" : "0");
}

// Per-category switches — "specific things" the user wants alerts for.
// Agent progress spam rides on silent messages instead of notifications, so
// the defaults keep directs (mentions/replies/reviews) on and bulk state
// changes off.
export type NotifyCategory = "mentions" | "replies" | "agents" | "todos" | "reviews";

const CATEGORY_DEFAULTS: Record<NotifyCategory, boolean> = {
  mentions: true,
  replies: true,
  agents: false,
  todos: false,
  reviews: true,
};

export function notifyCategory(cat: NotifyCategory): boolean {
  try {
    const raw = localStorage.getItem(K_NOTIFY_CATS);
    if (!raw) return CATEGORY_DEFAULTS[cat];
    const prefs = JSON.parse(raw) as Partial<Record<NotifyCategory, boolean>>;
    return prefs[cat] ?? CATEGORY_DEFAULTS[cat];
  } catch {
    return CATEGORY_DEFAULTS[cat];
  }
}

export function setNotifyCategory(cat: NotifyCategory, on: boolean) {
  let prefs: Partial<Record<NotifyCategory, boolean>> = {};
  try {
    prefs = JSON.parse(localStorage.getItem(K_NOTIFY_CATS) ?? "{}");
  } catch {
    /* corrupt — reset */
  }
  prefs[cat] = on;
  localStorage.setItem(K_NOTIFY_CATS, JSON.stringify(prefs));
}

// deliver routes to the OS: the Wails bridge inside the desktop app, the
// Notification API in a real browser. Silent no-op without permission.
export async function deliver(title: string, body: string) {
  playSound(notifySound());
  if (isDesktop()) {
    if (await desktopNotify(title, body)) return;
  }
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, icon: "/icon.png" });
  } catch {
    /* some webviews throw on construction */
  }
}

export async function requestNotifyPermission(): Promise<boolean> {
  // Ask the web API first — WebView2 (Windows desktop) has a real
  // Notification implementation we want granted; on Linux the webview
  // lacks it entirely and the Wails bridge needs no permission anyway.
  if (typeof Notification !== "undefined") {
    try {
      if (Notification.permission === "granted") return true;
      if ((await Notification.requestPermission()) === "granted") {
        return true;
      }
    } catch {
      /* some webviews throw on permission calls */
    }
  }
  return isDesktop();
}

interface Me {
  id: string;
  name: string;
}

// initNotify subscribes once; call after login with the session user.
export function initNotify(me: () => Me | null) {
  subscribe((e: RelayEvent) => {
    if (!notifyEnabled()) return;
    if (e.type === "todo.changed") {
      if (!notifyCategory("todos")) return;
      void deliver("Relay", "A todo list changed");
      return;
    }
    if (e.type === "review.created") {
      if (!notifyCategory("reviews")) return;
      void deliver("Relay", "An agent requested a work review");
      return;
    }
    if (e.type !== "message.created") return;
    const user = me();
    if (!user) return;
    const data = e.data as Record<string, unknown> | undefined;
    const m = data?.message as Message | undefined;
    if (!m || m.author.id === user.id) return;

    const mentioned = (m.mentions ?? []).some(
      (r) => r.kind === "user" && r.id === user.id,
    );
    const replyToMe = m.parent?.author === user.name;
    // Silent agent updates only alert on a direct @mention.
    if (m.silent && !mentioned) return;
    let category: NotifyCategory | null = null;
    let title = "";
    if (mentioned && notifyCategory("mentions")) {
      category = "mentions";
      title = `${m.author.name} mentioned you`;
    } else if (replyToMe && notifyCategory("replies")) {
      category = "replies";
      title = `${m.author.name} replied to you`;
    } else if (!mentioned && !replyToMe && m.author.kind === "agent" && notifyCategory("agents")) {
      // non-silent agent broadcasts (work_start status lines, …)
      category = "agents";
      title = `${m.author.name} (agent)`;
    }
    if (!category) return;
    const body =
      m.body.replace(/\s+/g, " ").slice(0, 140) || "(attachment)";
    void deliver(title, body);
  });
}
