import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as FileSystem from "expo-file-system/legacy";

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

// Relative API paths ("/api/files/...") need the configured server prefix and
// the session cookie for expo-image's source.headers.
export function fileUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return path.startsWith("http") ? path : server + path;
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
    req<{
      user: {
        id: string;
        email: string;
        name: string;
        avatar_url: string | null;
      };
      workspace?: { id: string; name: string };
    }>("GET", "/api/auth/session"),
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
    parent_id?: string,
  ) =>
    req<Message>("POST", `/api/conversations/${conversationId}/messages`, {
      body,
      attachment_ids: attachment_ids ?? [],
      ...(parent_id ? { parent_id } : {}),
    }),
  editMessage: (messageId: string, body: string) =>
    req<{ message: Message }>("PATCH", `/api/messages/${messageId}`, { body }),
  reactMessage: (messageId: string, emoji: string) =>
    req<{ reactions: Reaction[] }>(
      "PUT",
      `/api/messages/${messageId}/reactions`,
      { emoji },
    ),
  reviews: (projectId: string, status?: string) =>
    req<{ reviews: Review[] }>(
      "GET",
      `/api/projects/${projectId}/reviews${status ? `?status=${status}` : ""}`,
    ),
  respondReview: (reviewId: string, status: string, response?: string) =>
    req<{ review: Review }>("POST", `/api/reviews/${reviewId}/respond`, {
      status,
      response: response ?? "",
    }),
  workspaces: () => req<{ workspaces: Workspace[] }>("GET", "/api/workspaces"),
  myReviews: () =>
    req<{ reviews: MyReview[] }>("GET", "/api/me/reviews"),
  unreadCounts: () =>
    req<{ unread: Record<string, number>; reviews: Record<string, number> }>(
      "GET",
      "/api/me/unread",
    ),
  mentions: () =>
    req<{ mentions: Mention[] }>("GET", "/api/me/mentions"),
  upload: async (
    projectId: string,
    file: { uri: string; name: string; type: string },
  ): Promise<Attachment> => {
    // Every upload path in this RN/Expo-Go stack funnels into the same
    // broken FormData native bridge — build the multipart body manually.
    const b64 = await FileSystem.readAsStringAsync(file.uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const boundary = "----relay" + Math.random().toString(36).slice(2);
    const enc = new TextEncoder();
    const head = enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
    );
    const tail = enc.encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(head.length + bytes.length + tail.length);
    body.set(head);
    body.set(bytes, head.length);
    body.set(tail, head.length + bytes.length);
    const res = await fetch(
      server + `/api/projects/${projectId}/attachments`,
      {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          ...(cookie ? { cookie } : {}),
        },
        body: body.buffer as ArrayBuffer,
      },
    );
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
export interface Reaction {
  emoji: string;
  count: number;
  mine: boolean;
  names?: string[];
}
export interface MessageParent {
  id: string;
  author: string;
  preview: string;
  deleted: boolean;
}
export interface Message {
  id: string;
  body: string;
  created_at: string;
  edited_at: string | null;
  agent_read: boolean;
  author: { id: string; name: string; kind: string; avatar_url: string | null };
  parent: MessageParent | null;
  attachments?: Attachment[];
  reactions?: Reaction[];
}
export interface Person {
  id: string | null;
  name: string;
  avatar_url: string | null;
}
export interface Review {
  id: string;
  status: string;
  title: string;
  summary: string;
  verify: string;
  files: unknown[];
  decisions: unknown[];
  actions: unknown[];
  links: unknown[];
  agent: Person;
  issue: { id: string; key: string } | null;
  responder: Person | null;
  response: string | null;
  responded_at: string | null;
  created_at: string;
}
export interface Workspace {
  id: string;
  name: string;
}
export interface MyReview {
  id: string;
  project_id: string;
  title: string;
  agent: Person;
  project_key: string;
  project_name: string;
  created_at: string;
}
export interface Mention {
  id: string;
  body: string;
  created_at: string;
  project_id: string;
  is_read: boolean;
  author: { name: string; avatar: string | null; kind: string };
}
