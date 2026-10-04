// Local-mode adapter: a Relay API surface backed by IndexedDB so the app
// runs with no server at all ("This device" workspace). Same wire shapes as
// the real API; sync.ts replays this store onto a server later.
//
// Persistence: the JSON doc lives in the `kv` store; attachment bytes live
// in `blobs` keyed by attachment id — hundreds of MB of quota instead of
// localStorage's ~5MB. A pre-IDB `relay.localdb.v1` document (data-URL
// attachments included) is imported once and removed.
import { emitLocal } from "./events";
import {
  dataUrlToBlob,
  localStore,
} from "./localdb";
import {
  ApiClientError,
  type AgentReview,
  type Attachment,
  type Board,
  type Brief,
  type BriefPolicy,
  type FileEntry,
  type SavedFilter,
  type StatusDef,
  type AuthSession,
  type Conversation,
  type Issue,
  type Label,
  type Message,
  type Project,
  type Reaction,
  type SearchResults,
  type Thread,
  type Todo,
  type User,
  type WorkspaceMember,
  type WorkspaceWithRole,
} from "@relay/api-client";

interface LocalAttachment extends Attachment {
  // Live object URL at runtime; absent in the persisted doc (the bytes are
  // in the blobs store).
  url: string;
}

interface LocalThread {
  id: string; // == conversation id
  parent_message_id: string;
  parent_conversation: string;
  title: string | null;
  created_at: string;
}

interface LocalDB {
  user: User;
  workspace: WorkspaceWithRole;
  projects: Project[];
  conversations: Conversation[]; // project + issue + thread conversations
  threads: LocalThread[]; // thread metadata keyed to conversations
  messages: Message[]; // all conversations, one list
  issues: Issue[];
  todos: Todo[];
  labels: Record<string, Label[]>; // project_id -> labels
  attachments: Record<string, LocalAttachment>;
  myReactions: Record<string, string[]>; // message_id -> emojis I reacted with
  counters: Record<string, number>; // project_id -> next issue number
  savedFilters: Record<string, SavedFilter[]>; // project_id -> views
  boards: Record<string, Board[]>; // project_id -> named boards
  briefs: Brief[]; // visual briefs incl. their scene JSON
  synced_at?: string;
}

const LOCAL_WS_ID = "00000000-0000-4000-8000-0000000000c1";
const LOCAL_USER_ID = "00000000-0000-4000-8000-0000000000a1";

function emptyDB(): LocalDB {
  const now = new Date().toISOString();
  return {
    user: {
      id: LOCAL_USER_ID,
      email: "you@local",
      name: "You",
      avatar_url: null,
      created_at: now,
    },
    workspace: {
      id: LOCAL_WS_ID,
      name: "This device",
      slug: "local",
      role: "owner",
      created_at: now,
    },
    projects: [],
    conversations: [],
    threads: [],
    messages: [],
    issues: [],
    todos: [],
    labels: {},
    attachments: {},
    myReactions: {},
    counters: {},
    savedFilters: {},
    boards: {},
    briefs: [],
  };
}

// Boot order: IDB doc -> runtime db -> object URLs for blobs -> one-time
// localStorage import. Every adapter method awaits `localReady` via the
// proxy at the bottom of the file, so the app can render immediately.
let db: LocalDB = emptyDB();

const LEGACY_KEY = "relay.localdb.v1";

export const localReady: Promise<void> = (async () => {
  try {
    const saved = await localStore.get<LocalDB>("doc");
    if (saved) {
      db = { ...emptyDB(), ...saved };
      await rehydrateUrls();
      return;
    }
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return;
    const legacy = JSON.parse(raw) as LocalDB;
    // data URLs -> blobs before the doc is persisted
    for (const a of Object.values(legacy.attachments ?? {})) {
      if (a.url?.startsWith("data:")) {
        const blob = await dataUrlToBlob(a.url);
        await localStore.putBlob(a.id, blob);
        a.url = URL.createObjectURL(blob);
      }
    }
    const avatar = legacy.user?.avatar_url;
    if (avatar?.startsWith("data:")) {
      const blob = await dataUrlToBlob(avatar);
      await localStore.putBlob("avatar", blob);
      legacy.user.avatar_url = URL.createObjectURL(blob);
    }
    db = { ...emptyDB(), ...legacy };
    save();
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* corrupt/absent store — start clean */
  }
})();

// mint object URLs for blobs restored from IDB
async function rehydrateUrls() {
  for (const a of Object.values(db.attachments)) {
    if (a.url) continue;
    const blob = await localStore.getBlob(a.id);
    if (blob) a.url = URL.createObjectURL(blob);
  }
  if (db.user.avatar_url === "blob:avatar") {
    const blob = await localStore.getBlob("avatar");
    if (blob) db.user.avatar_url = URL.createObjectURL(blob);
  }
  for (const p of db.projects) {
    if (p.icon_url === `blob:icon:${p.id}`) {
      const blob = await localStore.getBlob(`icon:${p.id}`);
      if (blob) p.icon_url = URL.createObjectURL(blob);
      else p.icon_url = null;
    }
  }
  if (db.workspace.avatar_url === "blob:icon:workspace") {
    const blob = await localStore.getBlob("icon:workspace");
    if (blob) db.workspace.avatar_url = URL.createObjectURL(blob);
    else db.workspace.avatar_url = null;
  }
}

function save() {
  // Strip live object URLs — they're per-session; blobs re-mint on load.
  const doc: LocalDB = {
    ...db,
    attachments: Object.fromEntries(
      Object.entries(db.attachments).map(([id, a]) => [
        id,
        { ...a, url: "" },
      ]),
    ),
    user: {
      ...db.user,
      avatar_url: db.user.avatar_url?.startsWith("blob:")
        ? "blob:avatar"
        : (db.user.avatar_url ?? null),
    },
    workspace: {
      ...db.workspace,
      avatar_url: db.workspace.avatar_url?.startsWith("blob:")
        ? "blob:icon:workspace"
        : (db.workspace.avatar_url ?? null),
    },
    projects: db.projects.map((p) => ({
      ...p,
      icon_url: p.icon_url?.startsWith("blob:")
        ? `blob:icon:${p.id}`
        : (p.icon_url ?? null),
    })),
  };
  void localStore.put("doc", doc).catch(() => {
    console.warn("local store write failed — change kept in memory only");
  });
}

export function dumpLocal(): LocalDB {
  return db;
}

export function markSynced() {
  db.synced_at = new Date().toISOString();
  save();
}

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

const me = () => ({
  kind: "user" as const,
  id: db.user.id,
  name: db.user.name,
  avatar_url: db.user.avatar_url ?? null,
});

const findMessage = (id: string) => db.messages.find((m) => m.id === id);
const findIssue = (id: string) => db.issues.find((i) => i.id === id);
const convOf = (projectId: string, issueId?: string) =>
  db.conversations.find(
    (c) =>
      c.kind !== "thread" &&
      c.project_id === projectId &&
      (c.issue_id ?? null) === (issueId ?? null),
  );

function projectConv(projectId: string, issueId?: string): Conversation {
  const existing = convOf(projectId, issueId);
  if (existing) return existing;
  const conv: Conversation = {
    id: uuid(),
    project_id: projectId,
    kind: issueId ? "issue" : "project",
    issue_id: issueId ?? null,
    created_at: now(),
  };
  db.conversations.push(conv);
  save();
  return conv;
}

function parentPreview(parentId?: string): Message["parent"] {
  if (!parentId) return null;
  const p = findMessage(parentId);
  if (!p) return null;
  return {
    id: p.id,
    author: p.author.name,
    preview: p.body.slice(0, 140),
    deleted: false,
  };
}

function notFound(): never {
  throw new ApiClientError(404, "not found");
}

const threadOf = (messageId: string) =>
  db.threads.find((t) => t.parent_message_id === messageId) ?? null;

// Ping open views when a thread conversation gains/loses a reply so the
// parent message's chip count stays live.
function notifyThread(conversationId: string) {
  const t = db.threads.find((x) => x.id === conversationId);
  if (!t) return;
  emitLocal({
    type: "thread.updated",
    project_id:
      db.conversations.find((c) => c.id === t.parent_conversation)
        ?.project_id ?? "",
    data: {
      conversation_id: t.parent_conversation,
      parent_message_id: t.parent_message_id,
      thread: threadOut(t),
    },
  });
}

const withReplyCount = (t: LocalThread | null): Message["thread"] =>
  t
    ? {
        id: t.id,
        title: t.title,
        reply_count: db.messages.filter((m) => m.conversation_id === t.id)
          .length,
      }
    : null;

function threadOut(t: LocalThread): Thread {
  const parent = findMessage(t.parent_message_id);
  const replies = db.messages.filter((m) => m.conversation_id === t.id);
  return {
    id: t.id,
    parent_message_id: t.parent_message_id,
    parent_conversation: t.parent_conversation,
    title: t.title,
    reply_count: replies.length,
    created_by: db.user.name,
    parent: parent
      ? { author: parent.author.name, preview: parent.body.slice(0, 160) }
      : { author: "Deleted", preview: "Original message was deleted" },
    last_reply_at: replies.at(-1)?.created_at ?? null,
    created_at: t.created_at,
  };
}

// --- the adapter surface (subset of the server client) ---

const impl = {
  health: async () => ({ status: "ok", version: "local" }) as const,

  session: async (): Promise<AuthSession> => ({
    user: db.user,
    workspaces: [db.workspace],
  }),

  listWorkspaces: async () => ({ workspaces: [db.workspace] }),
  getWorkspace: async () => db.workspace as unknown,
  listWorkspaceMembers: async (): Promise<{ members: WorkspaceMember[] }> => ({
    members: [{ user: db.user, role: "owner" }],
  }),

  listProjects: async () => ({ projects: db.projects }),
  createProject: async (input: {
    name: string;
    key?: string;
    description?: string;
    icon?: string;
    color?: string;
  }): Promise<Project> => {
    const key = (input.key ?? input.name.slice(0, 3)).toUpperCase();
    const p: Project = {
      id: uuid(),
      workspace_id: LOCAL_WS_ID,
      key,
      name: input.name,
      description: input.description ?? "",
      icon: input.icon ?? null,
      color: input.color ?? null,
      created_at: now(),
    };
    db.projects.push(p);
    db.counters[p.id] = 0;
    projectConv(p.id);
    save();
    return p;
  },
  getProject: async (id: string): Promise<Project> => {
    const p = db.projects.find((x) => x.id === id);
    if (!p) notFound();
    return p;
  },
  projectOverview: async (id: string) => {
    const p = db.projects.find((x) => x.id === id);
    if (!p) notFound();
    const conv = projectConv(id);
    const msgs = db.messages.filter((m) => m.conversation_id === conv.id);
    return {
      project: p,
      counts: { members: 1, messages: msgs.length, conversations: 1 },
      recent_messages: msgs.slice(-3),
      issue_activity: [],
    };
  },
  projectConversation: async (projectId: string) => projectConv(projectId),

  createThread: async (messageId: string, title?: string) => {
    const m = findMessage(messageId);
    if (!m) notFound();
    const parentConv = db.conversations.find(
      (c) => c.id === m.conversation_id,
    );
    if (!parentConv) notFound();
    if (parentConv.kind === "thread")
      throw new ApiClientError(400, "threads cannot be nested");
    let t = threadOf(messageId);
    if (!t) {
      t = {
        id: uuid(),
        parent_message_id: messageId,
        parent_conversation: m.conversation_id,
        title: title?.trim() || m.body.slice(0, 80).trim() || null,
        created_at: now(),
      };
      db.threads.push(t);
      db.conversations.push({
        id: t.id,
        project_id: parentConv.project_id,
        kind: "thread",
        issue_id: null,
        created_at: t.created_at,
      } as Conversation);
      save();
      emitLocal({
        type: "thread.created",
        project_id: parentConv.project_id,
        data: {
          conversation_id: m.conversation_id,
          parent_message_id: messageId,
          thread: threadOut(t),
        },
      });
    }
    return { thread: threadOut(t) };
  },
  listThreads: async (projectId: string) => ({
    threads: db.threads
      .filter(
        (t) =>
          db.conversations.find((c) => c.id === t.parent_conversation)
            ?.project_id === projectId,
      )
      .sort(
        (a, b) =>
          (threadOut(b).last_reply_at ?? b.created_at).localeCompare(
            threadOut(a).last_reply_at ?? a.created_at,
          ),
      )
      .map(threadOut),
  }),

  listMessages: async (
    conversationId: string,
    opts?: { limit?: number; before?: string },
  ) => {
    const all = db.messages
      .filter((m) => m.conversation_id === conversationId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    let end = all.length;
    if (opts?.before) {
      const idx = all.findIndex((m) => m.id === opts.before);
      if (idx >= 0) end = idx;
    }
    const limit = opts?.limit ?? 50;
    const start = Math.max(0, end - limit);
    return {
      messages: all
        .slice(start, end)
        .map((m) => ({ ...m, thread: withReplyCount(threadOf(m.id)) })),
      has_more: start > 0,
    };
  },
  postMessage: async (
    conversationId: string,
    body: string,
    attachmentIds?: string[],
    parentId?: string,
  ): Promise<Message> => {
    const m: Message = {
      id: uuid(),
      conversation_id: conversationId,
      author: me(),
      body,
      parent: parentPreview(parentId),
      attachments: (attachmentIds ?? [])
        .map((id) => db.attachments[id])
        .filter((a): a is LocalAttachment => !!a)
        .map(({ url: _url, ...a }) => a),
      reactions: [],
      created_at: now(),
      edited_at: null,
      agent_read: false,
    };
    db.messages.push(m);
    save();
    notifyThread(conversationId);
    return m;
  },
  editMessage: async (messageId: string, body: string): Promise<Message> => {
    const m = findMessage(messageId);
    if (!m) notFound();
    m.body = body;
    m.edited_at = now();
    // refresh reply previews that quote this body
    for (const other of db.messages) {
      if (other.parent?.id === messageId) {
        other.parent.preview = body.slice(0, 140);
      }
    }
    save();
    return m;
  },
  deleteMessage: async (messageId: string): Promise<void> => {
    const idx = db.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) notFound();
    const convId = db.messages[idx]!.conversation_id;
    db.messages.splice(idx, 1);
    // replies keep a tombstone, mirroring the server's parent_deleted
    for (const other of db.messages) {
      if (other.parent?.id === messageId) {
        other.parent.deleted = true;
      }
    }
    save();
    notifyThread(convId);
  },
  pinMessage: async (messageId: string, pinned: boolean): Promise<Message> => {
    const m = findMessage(messageId);
    if (!m) notFound();
    m.pinned_at = pinned ? now() : null;
    save();
    emitLocal({
      type: "message.updated",
      project_id:
        db.conversations.find((c) => c.id === m.conversation_id)?.project_id ??
        "",
      data: { message: m },
    });
    return m;
  },
  listPins: async (conversationId: string) => ({
    messages: db.messages
      .filter((m) => m.conversation_id === conversationId && m.pinned_at)
      .sort((a, b) => (b.pinned_at ?? "").localeCompare(a.pinned_at ?? ""))
      .map((m) => ({ ...m, thread: withReplyCount(threadOf(m.id)) })),
  }),
  forwardMessage: async (messageId: string, projectId: string) => {
    const src = findMessage(messageId);
    if (!src) notFound();
    const conv = projectConv(projectId);
    const root = src.forwarded ?? {
      message_id: src.id,
      conversation_id: src.conversation_id,
      project_id: db.conversations.find((c) => c.id === src.conversation_id)
        ?.project_id,
      author: src.author.name,
    };
    const m: Message = {
      id: uuid(),
      conversation_id: conv.id,
      author: me(),
      body: src.body,
      parent: null,
      attachments: [...src.attachments],
      reactions: [],
      created_at: now(),
      edited_at: null,
      agent_read: false,
      forwarded: { ...root },
    };
    db.messages.push(m);
    save();
    emitLocal({
      type: "message.created",
      project_id: projectId,
      data: { message: m },
    });
    return { message: m };
  },
  toggleReaction: async (
    messageId: string,
    emoji: string,
  ): Promise<{ reactions: Reaction[] }> => {
    const m = findMessage(messageId);
    if (!m) notFound();
    const mine = (db.myReactions[messageId] ??= []);
    const i = mine.indexOf(emoji);
    if (i >= 0) mine.splice(i, 1);
    else mine.push(emoji);
    m.reactions = mine.map((e) => ({
      emoji: e,
      count: 1,
      mine: true,
      names: [db.user.name],
    }));
    save();
    return { reactions: m.reactions };
  },
  markMessageRead: async () => undefined,

  listIssues: async (
    projectId: string,
    filters?: { status?: string; q?: string; label?: string; assignee?: string },
  ) => {
    let out = db.issues.filter((i) => i.project_id === projectId);
    if (filters?.status) out = out.filter((i) => i.status === filters.status);
    if (filters?.label)
      out = out.filter((i) =>
        i.labels.some((l) => l.name === filters.label),
      );
    if (filters?.q) {
      const q = filters.q.toLowerCase();
      out = out.filter(
        (i) =>
          i.title.toLowerCase().includes(q) ||
          i.description.toLowerCase().includes(q) ||
          i.key.toLowerCase().includes(q),
      );
    }
    return { issues: out };
  },
  createIssue: async (
    projectId: string,
    input: { title: string; description?: string; priority?: string },
  ): Promise<Issue> => {
    const p = db.projects.find((x) => x.id === projectId);
    if (!p) notFound();
    const n = (db.counters[projectId] = (db.counters[projectId] ?? 0) + 1);
    const issue: Issue = {
      id: uuid(),
      project_id: projectId,
      number: n,
      key: `${p.key}-${n}`,
      title: input.title,
      description: input.description ?? "",
      status: "todo",
      priority: (input.priority as Issue["priority"]) ?? "medium",
      assignee: null,
      labels: [],
      created_at: now(),
      updated_at: now(),
    };
    db.issues.push(issue);
    save();
    return issue;
  },
  getIssue: async (issueId: string) => {
    const issue = findIssue(issueId);
    if (!issue) notFound();
    return { issue, activity: [] };
  },
  updateIssue: async (
    issueId: string,
    patch: Partial<Issue> & { assignee_id?: string | null },
  ): Promise<Issue> => {
    const issue = findIssue(issueId);
    if (!issue) notFound();
    const { assignee_id, ...rest } = patch;
    Object.assign(issue, rest);
    if (assignee_id !== undefined) {
      issue.assignee = assignee_id === db.user.id ? me() : null;
    }
    issue.updated_at = now();
    save();
    return issue;
  },
  getIssueConversation: async (issueId: string) => {
    const issue = findIssue(issueId);
    if (!issue) notFound();
    return projectConv(issue.project_id, issueId);
  },
  issueByKey: async (projectId: string, key: string) => {
    const issue = db.issues.find(
      (i) => i.project_id === projectId && i.key === key.toUpperCase(),
    );
    if (!issue) notFound();
    return { id: issue.id, key: issue.key };
  },
  createIssueFromMessage: async (
    messageId: string,
    title?: string,
  ): Promise<Issue> => {
    const m = findMessage(messageId);
    if (!m) notFound();
    const conv = db.conversations.find((c) => c.id === m.conversation_id);
    if (!conv) notFound();
    return local.createIssue(conv.project_id, {
      title: title ?? m.body.slice(0, 80),
      description: m.body,
    });
  },

  listLabels: async (projectId: string) => ({
    labels: db.labels[projectId] ?? [],
  }),
  createLabel: async (
    projectId: string,
    input: { name: string; color: string },
  ): Promise<Label> => {
    const l: Label = { id: uuid(), project_id: projectId, ...input };
    (db.labels[projectId] ??= []).push(l);
    save();
    return l;
  },

  listTodos: async (projectId: string) => ({
    todos: db.todos.filter((t) => projectOf(t) === projectId),
  }),
  createTodo: async (
    projectId: string,
    content: string,
    issueId?: string,
  ): Promise<Todo> => {
    const t: Todo & { project_id: string } = {
      id: uuid(),
      project_id: projectId,
      content,
      done: false,
      created_at: now(),
      updated_at: now(),
      ...(issueId
        ? { issue: { id: issueId, key: findIssue(issueId)?.key ?? "" } }
        : {}),
    };
    db.todos.push(t);
    save();
    return t;
  },
  updateTodo: async (
    todoId: string,
    body: { content?: string; done?: boolean; issue_id?: string },
  ): Promise<Todo> => {
    const t = db.todos.find((x) => x.id === todoId) as
      | (Todo & { project_id: string })
      | undefined;
    if (!t) notFound();
    if (body.content !== undefined) t.content = body.content;
    if (body.done !== undefined) t.done = body.done;
    if (body.issue_id !== undefined) {
      t.issue = body.issue_id
        ? { id: body.issue_id, key: findIssue(body.issue_id)?.key ?? "" }
        : undefined;
    }
    t.updated_at = now();
    save();
    return t;
  },
  deleteTodo: async (todoId: string) => {
    db.todos = db.todos.filter((t) => t.id !== todoId);
    save();
  },

  // No agents/reviews/GitHub off-server — the surfaces render empty rather
  // than break.
  listReviews: async () => ({ reviews: [] as AgentReview[], pending: 0 }),
  issueReviews: async () => ({ reviews: [] as AgentReview[] }),
  myReviews: async () => ({ reviews: [] }),
  unread: async () => ({ unread: {}, reviews: {} }),
  mentions: async () => ({ mentions: [] }),
  listAgents: async () => ({ agents: [] }),
  listProjectRepos: async () => ({ repos: [] }),
  projectDevelopment: async () => ({ repos: [], fetched_at: now() }),
  listWebhooks: async () => ({ webhooks: [], catalog: [] }),
  listAgentInvites: async () => ({ invites: [] }),
  listGitHubInstallations: async () => ({ installations: [] }),
  listAvailableRepos: async () => ({ repos: [] }),
  mentionables: async (projectId: string) => ({
    users: [
      { id: db.user.id, name: db.user.name, avatar_url: db.user.avatar_url },
    ],
    agents: [] as { id: string; name: string; slug: string }[],
    issues: db.issues
      .filter((i) => i.project_id === projectId)
      .map((i) => ({
        id: i.id,
        key: i.key,
        title: i.title,
        status: i.status,
        kind: "issue" as const,
        repo: "",
        github_number: 0,
        url: "",
      })),
    repos: [] as string[],
  }),

  search: async (q: string): Promise<SearchResults> => {
    const needle = q.toLowerCase();
    const convIds = new Map(db.conversations.map((c) => [c.id, c.project_id]));
    return {
      messages: db.messages
        .filter((m) => m.body.toLowerCase().includes(needle))
        .map((m) => ({
          id: m.id,
          body: m.body,
          project_id: convIds.get(m.conversation_id) ?? "",
          author: m.author.name,
          created_at: m.created_at,
        })),
      issues: db.issues
        .filter(
          (i) =>
            i.title.toLowerCase().includes(needle) ||
            i.description.toLowerCase().includes(needle) ||
            i.key.toLowerCase().includes(needle),
        )
        .map((i) => ({
          id: i.id,
          key: i.key,
          title: i.title,
          status: i.status,
          priority: i.priority,
          project_id: i.project_id,
        })),
      projects: db.projects.filter(
        (p) =>
          p.name.toLowerCase().includes(needle) ||
          p.key.toLowerCase().includes(needle),
      ),
      todos: db.todos
        .filter((t) => t.content.toLowerCase().includes(needle))
        .map((t) => ({
          id: t.id,
          content: t.content,
          done: t.done,
          project_id: projectOf(t) ?? "",
        })),
    };
  },

  uploadAttachment: async (
    projectId: string,
    file: File,
  ): Promise<Attachment> => {
    const a: LocalAttachment = {
      id: uuid(),
      project_id: projectId,
      filename: file.name,
      content_type: file.type || "application/octet-stream",
      size_bytes: file.size,
      created_at: now(),
      url: URL.createObjectURL(file),
    };
    await localStore.putBlob(a.id, file);
    db.attachments[a.id] = a;
    save();
    const { url: _u, ...wire } = a;
    return wire;
  },
  attachmentURL: (_projectId: string, attachmentId: string) =>
    db.attachments[attachmentId]?.url ?? "",

  setProjectStatuses: async (projectId: string, statuses: StatusDef[] | null) => {
    const p = db.projects.find((x) => x.id === projectId);
    if (!p) notFound();
    p.statuses = statuses ?? undefined;
    save();
    return { statuses: statuses ?? [] };
  },
  setProjectLocalPath: async (projectId: string, path: string | null) => {
    const p = db.projects.find((x) => x.id === projectId);
    if (!p) notFound();
    p.local_path = path;
    save();
    return { local_path: path };
  },
  // Folder browsing is a server-side capability (the directory lives on the
  // server host). In local mode the browser can't see it — empty tree.
  listProjectFiles: async () => ({ entries: [] as FileEntry[], truncated: false }),
  readProjectFile: async () => {
    throw new ApiClientError(404, "no linked folder in local mode");
  },
  repoFileTree: async () => ({ entries: [], truncated: false, repo: "", branch: "" }),
  repoFileRead: async () => {
    throw new ApiClientError(404, "no GitHub integration in local mode");
  },

  listSavedFilters: async (projectId: string) => ({
    filters: db.savedFilters[projectId] ?? [],
  }),
  createSavedFilter: async (
    projectId: string,
    input: { name: string; filters: Record<string, unknown> },
  ): Promise<SavedFilter> => {
    const f: SavedFilter = {
      id: uuid(),
      name: input.name,
      filters: input.filters,
    };
    (db.savedFilters[projectId] ??= []).push(f);
    save();
    return f;
  },
  deleteSavedFilter: async (projectId: string, filterId: string) => {
    db.savedFilters[projectId] = (db.savedFilters[projectId] ?? []).filter(
      (f) => f.id !== filterId,
    );
    save();
    return { deleted: true };
  },
  listBoards: async (projectId: string) => ({
    boards: db.boards[projectId] ?? [],
  }),
  createBoard: async (
    projectId: string,
    input: { name: string; filters: Record<string, unknown> },
  ): Promise<Board> => {
    const b: Board = { id: uuid(), name: input.name, filters: input.filters };
    (db.boards[projectId] ??= []).push(b);
    save();
    return b;
  },
  deleteBoard: async (projectId: string, boardId: string) => {
    db.boards[projectId] = (db.boards[projectId] ?? []).filter(
      (b) => b.id !== boardId,
    );
    save();
    return { deleted: true };
  },

  // Briefs work locally — the user can sketch canvases offline and sync
  // them later. Agents still need a server (they're not local identities).
  listBriefs: async (projectId: string, issueId?: string) => ({
    briefs: db.briefs
      .filter(
        (b) =>
          b.project_id === projectId &&
          (!issueId || b.issue_id === issueId),
      )
      .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "")),
    policy: (db.projects.find((p) => p.id === projectId)?.brief_policy ??
      "on_request") as BriefPolicy,
  }),
  createBrief: async (
    projectId: string,
    input: {
      title: string;
      summary?: string;
      issue_id?: string;
      scene?: Record<string, unknown>;
    },
  ): Promise<Brief> => {
    const b: Brief = {
      id: uuid(),
      project_id: projectId,
      issue_id: input.issue_id ?? null,
      title: input.title,
      summary: input.summary ?? "",
      scene: input.scene ?? {},
      status: "open",
      author_name: db.user.name,
      created_at: now(),
    };
    db.briefs.push(b);
    save();
    return b;
  },
  getBrief: async (briefId: string) => {
    const b = db.briefs.find((x) => x.id === briefId);
    if (!b) notFound();
    return b;
  },
  updateBrief: async (
    briefId: string,
    input: {
      title?: string;
      summary?: string;
      status?: "open" | "resolved" | "archived";
      scene?: Record<string, unknown>;
    },
  ) => {
    const b = db.briefs.find((x) => x.id === briefId);
    if (!b) notFound();
    if (input.title != null) b.title = input.title;
    if (input.summary != null) b.summary = input.summary;
    if (input.status != null) b.status = input.status;
    if (input.scene != null) b.scene = input.scene;
    b.updated_at = now();
    save();
    return b;
  },
  briefConversation: async (briefId: string) => {
    const b = db.briefs.find((x) => x.id === briefId);
    if (!b) notFound();
    const existing = b.conversation_id
      ? db.conversations.find((c) => c.id === b.conversation_id)
      : undefined;
    if (existing) return existing;
    const conv: Conversation = {
      id: uuid(),
      project_id: b.project_id,
      kind: "brief",
      issue_id: b.issue_id ?? null,
      brief_id: b.id,
      created_at: now(),
    };
    db.conversations.push(conv);
    b.conversation_id = conv.id;
    save();
    return conv;
  },
  setBriefPolicy: async (projectId: string, policy: BriefPolicy) => {
    const p = db.projects.find((x) => x.id === projectId);
    if (!p) notFound();
    p.brief_policy = policy;
    save();
    return { policy };
  },

  pushVapid: async () => ({ enabled: false }),
  pushSubscribe: async () => ({ subscribed: false }),
  pushUnsubscribe: async () => ({ subscribed: false }),

  uploadAvatar: async (file: File) => {
    await localStore.putBlob("avatar", file);
    db.user.avatar_url = URL.createObjectURL(file);
    save();
    return { avatar_url: db.user.avatar_url };
  },
  uploadProjectIcon: async (projectId: string, file: File) => {
    const p = db.projects.find((x) => x.id === projectId);
    if (!p) notFound();
    await localStore.putBlob(`icon:${projectId}`, file);
    p.icon_url = URL.createObjectURL(file);
    save();
    return { id: p.id, icon_url: p.icon_url };
  },
  uploadWorkspaceIcon: async (_workspaceId: string, file: File) => {
    await localStore.putBlob("icon:workspace", file);
    db.workspace.avatar_url = URL.createObjectURL(file);
    save();
    return { id: db.workspace.id, avatar_url: db.workspace.avatar_url };
  },
  createWorkspace: async () => {
    throw new ApiClientError(
      0,
      "This device holds one local workspace — connect a server for more",
    );
  },
  inviteToWorkspace: async () => {
    throw new ApiClientError(0, "Local mode is single-user — connect a server");
  },
  changePassword: async () => {
    throw new ApiClientError(0, "No password in local mode");
  },

  // Auth forms are unreachable in local mode; keeping these defined makes the
  // proxy's contract explicit.
  login: async () => {
    throw new ApiClientError(400, "local mode has no login");
  },
  register: async () => {
    throw new ApiClientError(400, "local mode has no registration");
  },
  logout: async () => undefined,
};

// Every method awaits localReady so callers racing boot see persisted state,
// not an empty store. attachmentURL stays synchronous — it returns the live
// object URL for an already-loaded attachment (img src can't await).
const SYNC_READS = new Set(["attachmentURL"]);
export const local = new Proxy(impl, {
  get(t, k: string) {
    if (SYNC_READS.has(k)) return t[k as keyof typeof t];
    return (...args: unknown[]) =>
      localReady.then(() =>
        (t[k as keyof typeof t] as (...a: unknown[]) => unknown)(...args),
      );
  },
}) as typeof impl;

// Todos carry project_id internally (server shape has none) for local
// filtering; strip it before returning.
function projectOf(t: Todo): string | undefined {
  return (t as Todo & { project_id?: string }).project_id;
}
