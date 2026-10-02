import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";

export const defaultServer =
  (Constants.expoConfig?.extra?.relayUrl as string) ?? "http://10.0.2.2:8080";

let server = defaultServer;
let cookie = "";

export function getServer() {
  return server;
}

export function getCookie() {
  return cookie;
}

// RN's native cookie jar does not survive process death and treats
// "Secure" cookies as undeliverable on plain-HTTP dev servers, so we
// carry the session cookie ourselves and persist it for cold starts.
export async function hydrate() {
  const [s, c] = await Promise.all([
    AsyncStorage.getItem("relay.server"),
    AsyncStorage.getItem("relay.session"),
  ]);
  if (s) server = s;
  if (c) cookie = c;
}

export async function setServer(u: string) {
  server = u.replace(/\/+$/, "");
  await AsyncStorage.setItem("relay.server", server);
}

export async function logout() {
  cookie = "";
  await AsyncStorage.removeItem("relay.session");
}

export interface ApiErr {
  error?: string | { code?: string; message?: string };
  message?: string;
}

function errMsg(data: unknown, status: number): string {
  const e = data as ApiErr;
  const nested = typeof e.error === "object" ? e.error.message : e.error;
  return nested ?? e.message ?? `HTTP ${status}`;
}

async function captureSession(res: Response) {
  const setc = res.headers.get("set-cookie");
  const m = setc?.match(/relay_session=([^;]+)/);
  if (m) {
    cookie = `relay_session=${m[1]}`;
    await AsyncStorage.setItem("relay.session", cookie);
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (cookie) headers["cookie"] = cookie;
  const res = await fetch(server + path, {
    method,
    headers,
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined,
  });
  await captureSession(res);
  const text = await res.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  if (!res.ok) throw new Error(errMsg(data, res.status));
  return data as T;
}

export const api = {
  me: () =>
    req<{ user: { id: string; email: string; name: string } }>(
      "GET",
      "/api/auth/session",
    ),
  login: (email: string, password: string) =>
    req<{ id: string; email: string; name: string }>("POST", "/api/auth/login", {
      email,
      password,
    }),
  register: (email: string, password: string, name: string) =>
    req<{ id: string }>("POST", "/api/auth/register", { email, password, name }),
  logout: () => req("POST", "/api/auth/logout").then(logout),
  projects: () =>
    req<{ projects: Project[] }>("GET", "/api/projects"),
  issues: (projectId: string) =>
    req<{ issues: Issue[] }>("GET", `/api/projects/${projectId}/issues`),
  updateIssue: (id: string, patch: { status?: string }) =>
    req<Issue>("PATCH", `/api/issues/${id}`, patch),
  todos: (projectId: string) =>
    req<{ todos: Todo[] }>("GET", `/api/projects/${projectId}/todos`),
  conversation: (projectId: string) =>
    req<Conversation>("GET", `/api/projects/${projectId}/conversation`),
  messages: (conversationId: string) =>
    req<{ messages: Message[] }>(
      "GET",
      `/api/conversations/${conversationId}/messages`,
    ),
  postMessage: (
    conversationId: string,
    body: string,
    attachment_ids?: string[],
  ) =>
    req<Message>("POST", `/api/conversations/${conversationId}/messages`, {
      body,
      attachment_ids: attachment_ids ?? [],
    }),
  upload: async (file: {
    uri: string;
    name: string;
    type: string;
  }): Promise<Attachment> => {
    const form = new FormData();
    // @ts-expect-error — React Native FormData accepts {uri,name,type}
    form.append("file", file);
    const res = await fetch(server + "/api/attachments", {
      method: "POST",
      headers: cookie ? { cookie } : undefined,
      body: form,
    });
    if (!res.ok) throw new Error(`upload HTTP ${res.status}`);
    return res.json() as Promise<Attachment>;
  },
};

export interface Project {
  id: string;
  name: string;
  key: string;
}
export interface Issue {
  id: string;
  project_id: string;
  number: number;
  key?: string;
  title: string;
  status: string;
  priority: string;
}
export interface Todo {
  id: string;
  content: string;
  done: boolean;
}
export interface Conversation {
  id: string;
  project_id: string;
  title: string;
}
export interface Attachment {
  id: string;
  filename: string;
  content_type: string;
  url?: string;
}
export interface Message {
  id: string;
  body: string;
  created_at: string;
  author: { id: string; name: string; kind: string; avatar_url: string | null };
  attachments?: Attachment[];
}
