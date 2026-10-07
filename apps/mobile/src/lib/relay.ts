import AsyncStorage from "@react-native-async-storage/async-storage";
import { fetch } from "expo/fetch";

// The WebView session lives in the web app's localStorage; the shell copies
// the bearer token out (see index.tsx bridge) so native features — share
// sheet, download fallback — can call the same REST endpoints the SPA does.
const TOKEN_KEY = "relay.sessionToken";

export function loadSessionToken(): Promise<string | null> {
  return AsyncStorage.getItem(TOKEN_KEY);
}

export function saveSessionToken(token: string | null): Promise<void> {
  if (token) return AsyncStorage.setItem(TOKEN_KEY, token);
  return AsyncStorage.removeItem(TOKEN_KEY);
}

export async function apiGet<T>(server: string, path: string): Promise<T> {
  const token = await loadSessionToken();
  const res = await fetch(server + path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 401 || res.status === 403) throw new Error("auth");
  if (!res.ok) throw new Error(`api_${res.status}`);
  return (await res.json()) as T;
}

export async function apiPost<T>(
  server: string,
  path: string,
  body: unknown,
): Promise<T> {
  const token = await loadSessionToken();
  const res = await fetch(server + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401 || res.status === 403) throw new Error("auth");
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`api_${res.status}:${t.slice(0, 120)}`);
  }
  return (await res.json()) as T;
}

// filenameFromDisposition parses `Content-Disposition: attachment;
// filename="x.png"` — the download route always sends it.
export function filenameFromDisposition(
  header: string | null,
  fallback: string,
): string {
  if (!header) return fallback;
  const m = /filename\*?=(?:UTF-8''|")?([^";]+)"?/i.exec(header);
  return m ? decodeURIComponent(m[1]).trim() : fallback;
}
