// Foreground notifications: SSE message.created events that @mention the
// signed-in user or reply to one of their messages surface a desktop
// notification while the app runs. This is the path that works inside the
// Wails shell — web-push needs a service worker + VAPID keys the shell
// lacks, which is why "Enable notifications" used to be a dead button there.
import type { Message } from "@relay/api-client";
import { desktopNotify, isDesktop } from "./desktop";
import { subscribe, type RelayEvent } from "./events";

const K_NOTIFY = "relay.notify";

export function notifyEnabled(): boolean {
  return localStorage.getItem(K_NOTIFY) === "1";
}

export function setNotifyEnabled(on: boolean) {
  localStorage.setItem(K_NOTIFY, on ? "1" : "0");
}

// deliver routes to the OS: the Wails bridge inside the desktop app, the
// Notification API in a real browser. Silent no-op without permission.
export async function deliver(title: string, body: string) {
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
  if (isDesktop()) return true; // the bridge needs no web permission
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  return (await Notification.requestPermission()) === "granted";
}

interface Me {
  id: string;
  name: string;
}

// initNotify subscribes once; call after login with the session user.
export function initNotify(me: () => Me | null) {
  subscribe((e: RelayEvent) => {
    if (e.type !== "message.created" || !notifyEnabled()) return;
    const user = me();
    if (!user) return;
    const data = e.data as Record<string, unknown> | undefined;
    const m = data?.message as Message | undefined;
    if (!m || m.author.id === user.id) return;

    const mentioned = (m.mentions ?? []).some(
      (r) => r.kind === "user" && r.id === user.id,
    );
    const replyToMe = m.parent?.author === user.name;
    if (!mentioned && !replyToMe) return;

    const title = mentioned
      ? `${m.author.name} mentioned you`
      : `${m.author.name} replied to you`;
    const body =
      m.body.replace(/\s+/g, " ").slice(0, 140) || "(attachment)";
    void deliver(title, body);
  });
}
