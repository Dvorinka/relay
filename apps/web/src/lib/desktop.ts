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
