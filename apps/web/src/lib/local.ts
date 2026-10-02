// Local-mode adapter: a Relay API surface backed by localStorage so the app
// runs with no server at all ("This device" workspace). Same wire shapes as
// the real API; sync.ts replays this store onto a server later.
//
// ponytail: localStorage ceiling ~5MB incl. data-URL attachments — fine for
// notes/projects; upgrade path is IndexedDB or file handles if this pinches.
import {
  ApiClientError,
  type AgentReview,
  type Attachment,
  type AuthSession,
  type Conversation,
  type Issue,
  type Label,
  type Message,
  type Project,
  type Reaction,
  type SearchResults,
  type Todo,
  type User,
  type WorkspaceMember,
  type WorkspaceWithRole,
} from "@relay/api-client";

interface LocalAttachment extends Attachment {
  url: string; // data URL
}

interface LocalDB {
  user: User;
  workspace: WorkspaceWithRole;
  projects: Project[];
  conversations: Conversation[]; // project + issue conversations
  messages: Message[]; // all conversations, one list
  issues: Issue[];
  todos: Todo[];
  labels: Record<string, Label[]>; // project_id -> labels
  attachments: Record<string, LocalAttachment>;
  myReactions: Record<string, string[]>; // message_id -> emojis I reacted with
  counters: Record<string, number>; // project_id -> next issue number
  synced_at?: string;
}

const DB_KEY = "relay.localdb.v1";
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
    messages: [],
    issues: [],
    todos: [],
    labels: {},
    attachments: {},
    myReactions: {},
    counters: {},
  };
}

let db: LocalDB = load();

function load(): LocalDB {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) return { ...emptyDB(), ...(JSON.parse(raw) as LocalDB) };
  } catch {
    /* corrupt store — start clean */
  }
  return emptyDB();
}

function save() {
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  } catch {
    // Quota exceeded (usually a big data-URL attachment). Keep running —
    // the mutation is in memory; warn via console for debugging.
    console.warn("local store full — change kept in memory only");
  }
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
    (c) => c.project_id === projectId && (c.issue_id ?? null) === (issueId ?? null),
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

// --- the adapter surface (subset of the server client) ---

export const local = {
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
    return { messages: all.slice(start, end), has_more: start > 0 };
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
    const url = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
    const a: LocalAttachment = {
      id: uuid(),
      project_id: projectId,
      filename: file.name,
      content_type: file.type || "application/octet-stream",
      size_bytes: file.size,
      created_at: now(),
      url,
    };
    db.attachments[a.id] = a;
    save();
    const { url: _u, ...wire } = a;
    return wire;
  },
  attachmentURL: (_projectId: string, attachmentId: string) =>
    db.attachments[attachmentId]?.url ?? "",

  uploadAvatar: async (file: File) => {
    const url = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
    db.user.avatar_url = url;
    save();
    return { avatar_url: url };
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

// Todos carry project_id internally (server shape has none) for local
// filtering; strip it before returning.
function projectOf(t: Todo): string | undefined {
  return (t as Todo & { project_id?: string }).project_id;
}
