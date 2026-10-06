import { ApiClientError, createClient } from "@relay/api-client";

// Desktop-shell bridge: the Wails app serves /~desktop-open on its webview
// origin and hands the URL to the OS browser. Used for flows that need the
// user's real browser session (GitHub App registration — the webview has no
// github.com login). Returns false in a normal browser (404/unreachable) so
// callers can fall back to plain navigation.
export async function desktopOpen(url: string): Promise<boolean> {
  try {
    const r = await fetch("/~desktop-open?u=" + encodeURIComponent(url), {
      cache: "no-store",
    });
    return r.status === 204;
  } catch {
    return false;
  }
}

// --- Upload bridge ---
//
// The desktop shell's WebKitGTK scheme handler can silently drop request
// bodies (multipart POST/PUT never reaches the proxy). App.ProxyRequest is
// bound on window.go.main.App and replays the request from Go's HTTP stack,
// so uploads send {"name","data"} base64 JSON through it instead of fetch.
// In a normal browser window.go is absent and callers use fetch as usual.

type WailsApp = {
  ProxyRequest?: (
    method: string,
    path: string,
    contentType: string,
    bodyB64: string,
    token: string,
  ) => Promise<{ status: number; body: string }>;
  Notify?: (title: string, body: string) => Promise<void>;
  Quit?: () => Promise<void>;
  ServerConfig?: () => Promise<{ server_url?: string; offline?: boolean }>;
  Version?: () => Promise<string>;
  Platform?: () => Promise<string>;
  SelfUpdate?: (tag: string) => Promise<void>;
  SubscribeEvents?: (token: string) => Promise<void>;
  StopEvents?: () => Promise<void>;
};

function wailsApp(): WailsApp | undefined {
  return (window as unknown as { go?: { main?: { App?: WailsApp } } }).go?.main
    ?.App;
}

export function hasUploadBridge(): boolean {
  return typeof wailsApp()?.ProxyRequest === "function";
}

// Synchronous "am I inside the Wails desktop shell" check: the shell serves
// the SPA from wails.localhost and injects window.go for bound methods.
export function isDesktop(): boolean {
  return (
    window.location.hostname === "wails.localhost" ||
    (window as unknown as { go?: unknown }).go !== undefined
  );
}

// The webview's Notification API either doesn't exist (WebKitGTK without an
// embedder handler) or silently drops calls — App.Notify on the Go side
// pipes to the OS notification daemon instead.
export async function desktopNotify(
  title: string,
  body: string,
): Promise<boolean> {
  const app = wailsApp();
  if (typeof app?.Notify !== "function") return false;
  try {
    await app.Notify(title, body);
    return true;
  } catch {
    return false;
  }
}

function bytesToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

// bridgeUpload sends one upload-ish request through the Wails bound method.
// `file` becomes {"name","data"} JSON; `url` becomes {"url"} — the server
// accepts both shapes on every avatar/icon/attachment endpoint. Returns the
// parsed JSON body, or throws an Error carrying the server's message.
export async function bridgeUpload(
  method: string,
  path: string,
  token: string,
  file?: File,
  url?: string,
): Promise<unknown> {
  const app = wailsApp();
  if (!app?.ProxyRequest) throw new Error("desktop bridge unavailable");
  const payload = url !== undefined ? { url } : {
    name: file!.name,
    data: bytesToB64(await file!.arrayBuffer()),
  };
  const res = await app.ProxyRequest(
    method,
    path,
    "application/json",
    bytesToB64(new TextEncoder().encode(JSON.stringify(payload)).buffer as ArrayBuffer),
    token,
  );
  const body = JSON.parse(res.body || "null");
  if (res.status < 200 || res.status >= 300) {
    throw new ApiClientError(
      res.status,
      body?.error?.message ?? `HTTP ${res.status}`,
    );
  }
  return body;
}

// Reads the shell's configured server URL. In proxy mode the SPA runs
// same-origin on wails.localhost with localStorage relay.serverUrl cleared,
// so flows that need the real URL — browser sign-in opens it in the system
// browser — ask the shell. Returns "" in a normal browser or unconfigured.
export async function desktopServerUrl(): Promise<string> {
  // The bound method can't be intercepted by the SPA's service worker;
  // the fetch path is the fallback for a shell without it.
  const app = wailsApp();
  if (typeof app?.ServerConfig === "function") {
    try {
      const cfg = await app.ServerConfig();
      return typeof cfg?.server_url === "string" ? cfg.server_url : "";
    } catch {
      return "";
    }
  }
  try {
    const r = await fetch("/~desktop-config", { cache: "no-store" });
    if (r.status !== 200 || !r.headers.get("content-type")?.includes("json")) {
      return "";
    }
    const body = (await r.json()) as { server_url?: string };
    return typeof body?.server_url === "string" ? body.server_url : "";
  } catch {
    return "";
  }
}

// Persists a mode change into the desktop shell's relay-desktop.json and
// hot-swaps its handler (embedded SPA ↔ server proxy). Called when the SPA
// itself changes mode — sign-in from local mode, or "Work locally" while
// connected — so the next launch boots the right bundle. In a normal
// browser the request hits the server, which answers 200 HTML, not 204.
export async function desktopApplyConfig(
  serverUrl: string,
  offline: boolean,
): Promise<boolean> {
  try {
    const r = await fetch(
      `/~desktop-config?server_url=${encodeURIComponent(serverUrl)}&offline=${offline ? "1" : "0"}`,
      { cache: "no-store" },
    );
    return r.status === 204;
  } catch {
    return false;
  }
}

// Launch-at-login state from the desktop shell (HKCU Run key on Windows,
// freedesktop entry on Linux, LaunchAgent on macOS). Same-origin fetch —
// wails.localhost is routed by the shell's mux, not the proxied server.
export async function desktopAutostart(): Promise<{
  enabled: boolean;
  supported: boolean;
}> {
  const r = await fetch("/~desktop-autostart", { cache: "no-store" });
  if (!r.ok) throw new Error("autostart status unavailable");
  return r.json();
}

export async function desktopSetAutostart(on: boolean): Promise<void> {
  const r = await fetch(`/~desktop-autostart?enabled=${on ? 1 : 0}`, {
    method: "POST",
  });
  if (!r.ok) throw new Error("could not update autostart");
}

// Close-to-background mode ("alerts when the app is closed" on desktop):
// the shell hides the window instead of quitting, SSE stays connected and
// native toasts keep firing. Relaunching the exe re-shows the window via
// the single-instance lock.
export async function desktopBackground(): Promise<{ enabled: boolean }> {
  const r = await fetch("/~desktop-background", { cache: "no-store" });
  if (!r.ok) throw new Error("background status unavailable");
  return r.json();
}

export async function desktopSetBackground(on: boolean): Promise<void> {
  const r = await fetch(`/~desktop-background?enabled=${on ? 1 : 0}`, {
    method: "POST",
  });
  if (!r.ok) throw new Error("could not update background mode");
}

// Real exit — with background mode on every other close path just hides the
// window. Bound as window.go.main.App.Quit.
export function desktopQuit(): void {
  void wailsApp()?.Quit?.();
}

// The desktop binary's own release tag — what "update available" should be
// measured against inside the shell. The proxied SPA carries the SERVER's
// build version, which is a different artifact. null outside the shell or
// on builds predating the binding.
export async function desktopVersion(): Promise<string | null> {
  const app = wailsApp();
  if (typeof app?.Version !== "function") return null;
  try {
    return await app.Version();
  } catch {
    return null;
  }
}

export type DesktopPlatform = "windows" | "linux" | "darwin" | null;

export async function desktopPlatform(): Promise<DesktopPlatform> {
  const app = wailsApp();
  if (typeof app?.Platform !== "function") return null;
  try {
    const p = await app.Platform();
    return p === "windows" || p === "linux" || p === "darwin" ? p : null;
  } catch {
    return null;
  }
}

// Self-update: download the platform installer/binary for `tag` and swap it
// in. The shell exits mid-call — the new version relaunches itself. Only
// resolves on failure; on success the process is already gone.
export async function desktopSelfUpdate(tag: string): Promise<void> {
  const app = wailsApp();
  if (typeof app?.SelfUpdate !== "function") {
    throw new Error("this desktop build cannot self-update");
  }
  await app.SelfUpdate(tag);
}

// Browser sign-in (desktop shell): start mints a code on the target server,
// the system browser approves it on /connect, and we poll until the token
// lands. Resolves with the token; cancel() stops polling — callers own the
// "waiting" UI state.
export function browserAuth(serverUrl: string): {
  promise: Promise<string | null>;
  cancel: () => void;
} {
  const url = serverUrl.replace(/\/+$/, "");
  const client = createClient(url);
  let timer: number | null = null;
  // Settled with the token on approval, null on cancel — cancel must settle
  // the promise or an awaiting caller hangs.
  let settle: ((t: string | null) => void) | null = null;
  let done = false;
  const stop = () => {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
    settle = null;
  };
  const cancel = () => {
    done = true;
    settle?.(null);
    stop();
  };
  const promise = (async () => {
    let code: string;
    try {
      ({ code } = await client.browserAuthStart());
    } catch {
      throw new Error("Could not reach that server");
    }
    const opened = await desktopOpen(
      `${url}/connect?code=${encodeURIComponent(code)}`,
    );
    if (!opened) throw new Error("Could not open the system browser");
    if (done) return null; // cancelled while the browser was opening
    return await new Promise<string | null>((resolve, reject) => {
      settle = resolve;
      timer = window.setInterval(() => {
        client
          .browserAuthPoll(code)
          .then((res) => {
            if (res.status === "approved" && res.token) {
              stop();
              resolve(res.token);
            }
          })
          .catch(() => {
            stop();
            reject(new Error("The approval code expired — try again"));
          });
      }, 2000);
    });
  })();
  return { promise, cancel };
}

// SSE bridge: EventSource through the shell's asset-server proxy never
// dispatches — the proxied response is buffered until close, and an SSE
// stream never closes. The Go side pumps /api/events itself and re-emits
// each data frame as the "relay:sse" runtime event; events.ts subscribes to
// that instead. null in a normal browser or a shell predating the binding.
export function desktopEventPump(): {
  subscribe: (token: string) => void;
  stop: () => void;
} | null {
  const app = wailsApp();
  if (typeof app?.SubscribeEvents !== "function") return null;
  return {
    subscribe: (token) => void app.SubscribeEvents!(token),
    stop: () => void app.StopEvents?.(),
  };
}

// relay:// deep links arrive as wails events ("relay:deeplink"). Emitted once
// at startup and again ~1.2s later because listeners attach after the webview
// finishes loading — handlers must be idempotent.
export function onDeepLink(cb: (url: string) => void): () => void {
  const rt = (
    window as unknown as {
      runtime?: { EventsOn?: (n: string, cb: (d: string) => void) => void };
    }
  ).runtime;
  if (typeof rt?.EventsOn !== "function") return () => {};
  rt.EventsOn("relay:deeplink", cb);
  // Wails v2 has no EventsOff return contract here; the listener is
  // process-lifetime anyway (registered once at module scope).
  return () => {};
}

// Map a relay:// URL to an app route. Grammar: relay://open/<path> or
// relay://open?to=<path> — anything else (host-shaped URLs from the OS) is
// folded to /connect for safety instead of navigating blind.
export function deepLinkRoute(raw: string): string | null {
  const m = /^relay:\/\/(?:open\/)?(.*)$/.exec(raw.trim());
  if (!m) return null;
  let rest = m[1] ?? "";
  if (rest.startsWith("open?to=")) rest = decodeURIComponent(rest.slice(8));
  rest = rest.replace(/^\/+/, "");
  const path = "/" + rest.split("?")[0];
  const query = rest.includes("?") ? "?" + rest.split("?").slice(1).join("?") : "";
  // Only in-app surfaces — never let a link jump us to /login-ish or API paths.
  const allowed = ["/connect", "/app", "/login", "/register"];
  return allowed.some((p) => path === p || path.startsWith(p + "/"))
    ? path + query
    : "/connect";
}
