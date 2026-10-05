// relay:// deep links target web-app routes inside the WebView, not native
// routes — the shell maps them via Linking and injects the path itself.
// Swallowing the URL here (returning null) keeps expo-router from navigating
// to an unmatched route and remounting the WebView back to the server root.
export function redirectSystemPath({ path }: { path: string }): string | null {
  try {
    if (path.startsWith("relay://")) return null;
  } catch {
    // fall through — a bad URL shouldn't crash the router
  }
  return path;
}
