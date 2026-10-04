import { ApiClientError } from "@relay/api-client";

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
};

function wailsApp(): WailsApp | undefined {
  return (window as unknown as { go?: { main?: { App?: WailsApp } } }).go?.main
    ?.App;
}

export function hasUploadBridge(): boolean {
  return typeof wailsApp()?.ProxyRequest === "function";
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
