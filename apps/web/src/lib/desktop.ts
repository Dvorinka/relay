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
