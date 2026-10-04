import type { components, paths } from "./generated/schema";

export type { components, paths };

export type ApiError = components["schemas"]["Error"];
export type User = components["schemas"]["User"];
export type AuthSession = components["schemas"]["AuthSession"];
export type Workspace = components["schemas"]["Workspace"];
export type WorkspaceRole = components["schemas"]["WorkspaceRole"];
export type WorkspaceWithRole = components["schemas"]["WorkspaceWithRole"];
export type WorkspaceMember = components["schemas"]["WorkspaceMember"];
export type LoginRequest = components["schemas"]["LoginRequest"];
export type RegisterRequest = components["schemas"]["RegisterRequest"];
export type Project = components["schemas"]["Project"];
export type CreateProjectRequest = components["schemas"]["CreateProjectRequest"];
export type ProjectOverview = components["schemas"]["ProjectOverview"];
export type Conversation = components["schemas"]["Conversation"];
export type Message = components["schemas"]["Message"];
export type MessageAuthor = components["schemas"]["MessageAuthor"];
export type MessageParent = components["schemas"]["MessageParent"];
export type MentionRef = components["schemas"]["MentionRef"];
export interface Mentionables {
  users: { id: string; name: string; avatar_url?: string | null }[];
  agents: { id: string; name: string; slug: string; description?: string }[];
  issues: {
    id: string;
    key: string;
    title: string;
    status: string;
    kind: "issue" | "github_issue" | "pull_request";
    repo: string;
    github_number: number;
    url: string;
  }[];
  repos: string[];
}
export type Reaction = components["schemas"]["Reaction"];
export type Thread = components["schemas"]["Thread"];
export type ThreadSummary = components["schemas"]["ThreadSummary"];
export type Attachment = components["schemas"]["Attachment"];
export type Issue = components["schemas"]["Issue"];
export type IssueStatus = components["schemas"]["IssueStatus"];
export type IssuePriority = components["schemas"]["IssuePriority"];
export type IssueActivity = components["schemas"]["IssueActivity"];
export type Label = components["schemas"]["Label"];
export type Agent = components["schemas"]["Agent"];
export type AgentScope = components["schemas"]["AgentScope"];
export type AgentGrant = components["schemas"]["AgentGrant"];
export type McpTokenMeta = components["schemas"]["McpTokenMeta"];
export type MintedToken = components["schemas"]["MintedToken"];
export type AgentInvite = components["schemas"]["AgentInvite"];
export type AgentRedeemResult = components["schemas"]["AgentRedeemResult"];
export type AgentReview = components["schemas"]["AgentReview"];
export type ReviewStatus = NonNullable<AgentReview["status"]>;
export type PendingReviewItem = NonNullable<
  paths["/api/me/reviews"]["get"]["responses"]["200"]["content"]["application/json"]["reviews"]
>[number];
export type WebhookSubscription = components["schemas"]["WebhookSubscription"];
export type StatusDef = components["schemas"]["StatusDef"];
export type SavedFilter = components["schemas"]["SavedFilter"];
export type Brief = components["schemas"]["Brief"];
export type BriefPolicy = components["schemas"]["BriefPolicy"];
export type Board = components["schemas"]["Board"];
export type FileEntry = components["schemas"]["FileEntry"];
export type WebhookDelivery = components["schemas"]["WebhookDelivery"];

export interface LinkedRepo {
  id: string;
  owner: string;
  name: string;
  full_name: string;
  default_branch: string;
  installation_id: number;
  url: string;
}

// PullDetail is the in-app PR view payload: the pull plus its changed files,
// commits and CI checks.
export interface PullDetail {
  pull: {
    number: number;
    title: string;
    state: string;
    draft: boolean;
    merged: boolean;
    merged_at?: string | null;
    mergeable: string; // "clean" | "conflicting" | ""
    mergeable_state: string;
    body: string;
    url: string;
    author: string;
    head: string;
    base: string;
    additions: number;
    deletions: number;
    changed_files: number;
    commit_count: number;
    labels: string[];
    created_at: string;
    updated_at: string;
    repo: LinkedRepo;
  };
  files: {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
  }[];
  commits: RepoCommit[];
  checks: {
    name: string;
    status: string;
    conclusion: string;
    url: string;
  }[];
}

export interface RepoCommit {
  sha: string;
  message: string;
  url: string;
  author: string;
  date: string;
}

// An installable repository offered by the GitHub App / PAT — carries enough
// metadata for the picker (search, recent-first sort, project prefill).
export interface AvailableRepo {
  installation_id: number;
  full_name: string;
  owner: string;
  name: string;
  default_branch: string;
  private: boolean;
  description?: string;
  owner_avatar?: string;
  pushed_at?: string;
}

export interface DevRepoPanel {
  repo: LinkedRepo;
  issues: {
    number: number;
    title: string;
    state: string;
    url: string;
    author: string;
    updated_at: string;
  }[];
  prs: {
    number: number;
    title: string;
    state: string;
    draft: boolean;
    url: string;
    author: string;
    head: string;
    base: string;
  }[];
  commits: {
    sha: string;
    message: string;
    url: string;
    author: string;
    date: string;
  }[];
  error?: string;
}

export interface SearchResults {
  projects: { id: string; key: string; name: string }[];
  issues: {
    id: string;
    key: string;
    title: string;
    status: string;
    priority: string;
    project_id: string;
  }[];
  messages: {
    id: string;
    body: string;
    project_id: string;
    author: string;
    created_at: string;
  }[];
  todos: { id: string; content: string; done: boolean; project_id: string }[];
}

export interface Mention {
  id: string;
  body: string;
  created_at: string;
  project_id: string;
  conversation_id: string;
  conversation_kind: string;
  parent_message_id?: string;
  parent_conversation_id?: string;
  issue_id?: string;
  is_read: boolean;
  author: { name: string; avatar: string | null; kind: string };
}

export interface UserProfile {
  user: {
    id: string;
    name: string;
    name_color: string;
    avatar_key: string;
    created_at: string;
  };
  workspaces: { id: string; name: string; slug: string; role: string }[];
  stats: { messages: number; issues: number };
  issues: {
    id: string;
    project_id: string;
    key: string;
    title: string;
    status: string;
    priority: string;
    project: string;
    updated_at: string;
  }[];
  recent_messages: {
    id: string;
    body: string;
    project_id: string;
    project: string;
    created_at: string;
  }[];
  mentions: {
    id: string;
    body: string;
    project_id: string;
    created_at: string;
    author: { name: string; kind: string };
  }[];
}

export interface Todo {
  id: string;
  content: string;
  done: boolean;
  status?: "todo" | "in_progress" | "done";
  agent?: { id: string; name: string };
  issue?: { id: string; key: string };
  created_at?: string;
  updated_at?: string;
}

export interface DevelopmentPanel {
  repos: DevRepoPanel[];
  fetched_at: string;
}

export type CreateIssueRequest = NonNullable<
  paths["/api/projects/{projectId}/issues"]["post"]["requestBody"]
>["content"]["application/json"];
export type UpdateIssueRequest = NonNullable<
  paths["/api/issues/{issueId}"]["patch"]["requestBody"]
>["content"]["application/json"];
export type IssueFilters = NonNullable<
  paths["/api/projects/{projectId}/issues"]["get"]["parameters"]["query"]
>;

export type Health =
  paths["/api/health"]["get"]["responses"]["200"]["content"]["application/json"];

export class ApiClientError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
  }
}

export function createClient(baseUrl: string, token?: string) {
  // Cross-origin and bearer-token clients carry no cookies: CORS '*' stays
  // valid and SameSite never bites. Same-origin keeps cookie sessions.
  const crossOrigin =
    baseUrl !== "" &&
    typeof window !== "undefined" &&
    new URL(baseUrl, window.location.href).origin !== window.location.origin;
  const credentials: RequestCredentials =
    token || crossOrigin ? "omit" : "include";

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    // Keep headers undefined when empty so FormData requests let the browser
    // set its own multipart boundary.
    const headers =
      token || init?.headers ? new Headers(init?.headers) : undefined;
    if (token) headers!.set("Authorization", `Bearer ${token}`);
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      credentials,
      ...(headers ? { headers } : {}),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as ApiError | null;
      throw new ApiClientError(
        res.status,
        body?.error?.message ?? `HTTP ${res.status}`,
      );
    }
    if (res.status === 204) {
      return undefined as T;
    }
    return (await res.json()) as T;
  }

  function send<T>(method: string, path: string, body?: unknown): Promise<T> {
    return request<T>(path, {
      method,
      headers:
        body === undefined
          ? undefined
          : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  function post<T>(path: string, body?: unknown): Promise<T> {
    return send<T>("POST", path, body);
  }

  function put<T>(path: string, body?: unknown): Promise<T> {
    return send<T>("PUT", path, body);
  }

  function patch<T>(path: string, body?: unknown): Promise<T> {
    return send<T>("PATCH", path, body);
  }

  return {
    health: (signal?: AbortSignal) =>
      request<Health>("/api/health", { signal }),

    // Auth
    register: (input: RegisterRequest) =>
      post<AuthSession>("/api/auth/register", input),
    login: (input: LoginRequest) =>
      post<AuthSession>("/api/auth/login", input),
    logout: () => post<void>("/api/auth/logout"),
    session: (signal?: AbortSignal) =>
      request<AuthSession>("/api/auth/session", { signal }),
    forgotPassword: (email: string) =>
      post<void>("/api/auth/password/forgot", { email }),
    resetPassword: (token: string, password: string) =>
      post<void>("/api/auth/password/reset", { token, password }),
    changePassword: (currentPassword: string, newPassword: string) =>
      post<void>("/api/auth/password/change", {
        current_password: currentPassword,
        new_password: newPassword,
      }),
    updateMe: (input: { name_color: string }) =>
      patch<{ user: User }>("/api/auth/me", input),
    // Browser sign-in for the desktop shell: start, approve (signed-in),
    // poll until approved. The approve call rides the existing session.
    browserAuthStart: () =>
      post<{ code: string; expires_in: number }>("/api/auth/browser/start"),
    browserAuthApprove: (code: string) =>
      post<void>("/api/auth/browser/approve", { code }),
    browserAuthPoll: (code: string) =>
      request<{ status: "pending" | "approved"; token?: string }>(
        `/api/auth/browser/poll?code=${encodeURIComponent(code)}`,
      ),

    // Workspaces
    listWorkspaces: () =>
      request<{ workspaces: WorkspaceWithRole[] }>("/api/workspaces"),
    createWorkspace: (input: { name: string; slug?: string }) =>
      post<Workspace>("/api/workspaces", input),
    getWorkspace: (workspaceId: string) =>
      request<Workspace>(`/api/workspaces/${workspaceId}`),
    listWorkspaceMembers: (workspaceId: string) =>
      request<{ members: WorkspaceMember[] }>(
        `/api/workspaces/${workspaceId}/members`,
      ),
    inviteToWorkspace: (
      workspaceId: string,
      input: { email: string; role?: WorkspaceRole },
    ) =>
      post<WorkspaceMember>(`/api/workspaces/${workspaceId}/invite`, input),

    // Projects
    listProjects: () => request<{ projects: Project[] }>("/api/projects"),
    createProject: (input: CreateProjectRequest) =>
      post<Project>("/api/projects", input),
    getProject: (projectId: string) =>
      request<Project>(`/api/projects/${projectId}`),
    updateProject: (
      projectId: string,
      input: { name?: string; description?: string; icon?: string; color?: string },
    ) => patch<Project>(`/api/projects/${projectId}`, input),
    projectOverview: (projectId: string) =>
      request<ProjectOverview>(`/api/projects/${projectId}/overview`),
    projectConversation: (projectId: string) =>
      request<Conversation>(`/api/projects/${projectId}/conversation`),
    mentionables: (projectId: string) =>
      request<Mentionables>(`/api/projects/${projectId}/mentionables`),

    // Conversations
    listMessages: (
      conversationId: string,
      opts?: { limit?: number; before?: string; tag?: string },
    ) => {
      const query = new URLSearchParams();
      if (opts?.limit !== undefined) {
        query.set("limit", String(opts.limit));
      }
      if (opts?.before) {
        query.set("before", opts.before);
      }
      if (opts?.tag) {
        query.set("tag", opts.tag);
      }
      const qs = query.toString();
      return request<{ messages: Message[]; has_more: boolean }>(
        `/api/conversations/${conversationId}/messages${qs ? `?${qs}` : ""}`,
      );
    },
    postMessage: (
      conversationId: string,
      body: string,
      attachmentIds?: string[],
      parentId?: string,
      tags?: string[],
    ) =>
      post<Message>(`/api/conversations/${conversationId}/messages`, {
        body,
        attachment_ids: attachmentIds,
        parent_id: parentId,
        ...(tags && tags.length ? { tags } : {}),
      }),
    editMessage: (messageId: string, body: string, attachmentIds?: string[]) =>
      patch<Message>(`/api/messages/${messageId}`, {
        body,
        attachment_ids: attachmentIds,
      }),
    deleteMessage: (messageId: string) =>
      request<void>(`/api/messages/${messageId}`, { method: "DELETE" }),
    toggleReaction: (messageId: string, emoji: string) =>
      put<{ reactions: Reaction[] }>(`/api/messages/${messageId}/reactions`, {
        emoji,
      }),
    markMessageRead: (messageId: string) =>
      post<void>(`/api/messages/${messageId}/read`),
    markConversationRead: (conversationId: string) =>
      post<void>(`/api/conversations/${conversationId}/read`),
    clearConversation: (conversationId: string) =>
      request<{ cleared: number }>(
        `/api/conversations/${conversationId}/messages`,
        { method: "DELETE" },
      ),
    createThread: (messageId: string, title?: string) =>
      post<{ thread: Thread }>(`/api/messages/${messageId}/thread`, {
        ...(title ? { title } : {}),
      }),
    listThreads: (projectId: string) =>
      request<{ threads: Thread[] }>(`/api/projects/${projectId}/threads`),
    pinMessage: (messageId: string, pinned: boolean) =>
      request<Message>(`/api/messages/${messageId}/pin`, {
        method: pinned ? "PUT" : "DELETE",
      }),
    listPins: (conversationId: string) =>
      request<{ messages: Message[] }>(
        `/api/conversations/${conversationId}/pins`,
      ),
    forwardMessage: (messageId: string, projectId: string) =>
      post<{ message: Message }>(`/api/messages/${messageId}/forward`, {
        project_id: projectId,
      }),

    // Issues
    listIssues: (projectId: string, filters?: IssueFilters) => {
      const query = new URLSearchParams();
      if (filters?.status !== undefined) {
        query.set("status", filters.status);
      }
      if (filters?.assignee) {
        query.set("assignee", filters.assignee);
      }
      if (filters?.label) {
        query.set("label", filters.label);
      }
      if (filters?.q) {
        query.set("q", filters.q);
      }
      const qs = query.toString();
      return request<{ issues: Issue[] }>(
        `/api/projects/${projectId}/issues${qs ? `?${qs}` : ""}`,
      );
    },
    createIssue: (projectId: string, input: CreateIssueRequest) =>
      post<Issue>(`/api/projects/${projectId}/issues`, input),
    getIssue: (issueId: string) =>
      request<{ issue: Issue; activity: IssueActivity[] }>(
        `/api/issues/${issueId}`,
      ),
    updateIssue: (issueId: string, patchBody: UpdateIssueRequest) =>
      patch<Issue>(`/api/issues/${issueId}`, patchBody),
    getIssueConversation: (issueId: string) =>
      request<Conversation>(`/api/issues/${issueId}/conversation`),
    createIssueFromMessage: (messageId: string, title?: string) =>
      post<Issue>(
        `/api/messages/${messageId}/issue`,
        title === undefined ? undefined : { title },
      ),

    // Labels
    listLabels: (projectId: string) =>
      request<{ labels: Label[] }>(`/api/projects/${projectId}/labels`),
    createLabel: (projectId: string, input: { name: string; color: string }) =>
      post<Label>(`/api/projects/${projectId}/labels`, input),

    // Agents
    listAgents: (workspaceId: string) =>
      request<{ agents: Agent[] }>(`/api/workspaces/${workspaceId}/agents`),
    listProjectAgents: (projectId: string) =>
      request<{ agents: Agent[] }>(`/api/projects/${projectId}/agents`),
    createAgent: (
      workspaceId: string,
      input: {
        name: string;
        slug?: string;
        description?: string;
        review_mode?: "notify" | "gate";
      },
    ) => post<Agent>(`/api/workspaces/${workspaceId}/agents`, input),
    getAgent: (agentId: string) =>
      request<{ agent: Agent; tokens: McpTokenMeta[] }>(
        `/api/agents/${agentId}`,
      ),
    updateAgent: (
      agentId: string,
      input: {
        name?: string;
        description?: string;
        review_mode?: "notify" | "gate";
        grant_all?: boolean;
        grant_scopes?: AgentScope[];
      },
    ) => patch<Agent>(`/api/agents/${agentId}`, input),
    deleteAgent: (agentId: string) =>
      request<void>(`/api/agents/${agentId}`, { method: "DELETE" }),
    grantAgentProject: (
      agentId: string,
      projectId: string,
      scopes: AgentScope[],
    ) =>
      put<AgentGrant>(`/api/agents/${agentId}/projects/${projectId}`, {
        scopes,
      }),
    revokeAgentProject: (agentId: string, projectId: string) =>
      request<void>(`/api/agents/${agentId}/projects/${projectId}`, {
        method: "DELETE",
      }),
    mintAgentToken: (
      agentId: string,
      input: { name: string; expires_in_days?: number },
    ) => post<MintedToken>(`/api/agents/${agentId}/tokens`, input),
    revokeAgentToken: (agentId: string, tokenId: string) =>
      request<void>(`/api/agents/${agentId}/tokens/${tokenId}`, {
        method: "DELETE",
      }),
    createAgentInvite: (
      workspaceId: string,
      input: {
        project_ids?: string[];
        scopes?: AgentScope[];
        expires_hours?: number;
      } = {},
    ) =>
      post<AgentInvite & { token: string }>(
        `/api/workspaces/${workspaceId}/agent-invites`,
        input,
      ),
    listAgentInvites: (workspaceId: string) =>
      request<{ invites: AgentInvite[] }>(
        `/api/workspaces/${workspaceId}/agent-invites`,
      ),
    deleteAgentInvite: (workspaceId: string, inviteId: string) =>
      request<void>(`/api/workspaces/${workspaceId}/agent-invites/${inviteId}`, {
        method: "DELETE",
      }),

    // GitHub
    getGitHubApp: () =>
      request<{
        registered: boolean;
        app_id?: number;
        slug?: string;
        name?: string;
        install_url?: string;
      }>("/api/github/app"),
    githubManifest: (workspaceId: string) =>
      post<{
        manifest: Record<string, unknown>;
        post_url: string;
        page_url?: string;
      }>(
        `/api/github/app/manifest?workspace=${encodeURIComponent(workspaceId)}`,
      ),
    deleteGitHubApp: () =>
      request<void>("/api/github/app", { method: "DELETE" }),
    listGitHubInstallations: (workspaceId: string) =>
      request<{
        installations: {
          id: string;
          installation_id: number;
          account_login: string;
        }[];
        install_url?: string;
      }>(`/api/workspaces/${workspaceId}/github/installations`),
    listAvailableRepos: (workspaceId: string) =>
      request<{
        repos: AvailableRepo[];
      }>(`/api/workspaces/${workspaceId}/github/repos`),
    listProjectRepos: (projectId: string) =>
      request<{ repos: LinkedRepo[] }>(
        `/api/projects/${projectId}/github/repos`,
      ),
    linkRepo: (
      projectId: string,
      input: {
        installation_id: number;
        owner: string;
        name: string;
        default_branch?: string;
      },
    ) =>
      put<LinkedRepo>(`/api/projects/${projectId}/github/repo`, input),
    unlinkRepo: (projectId: string, repoId: string) =>
      request<void>(`/api/projects/${projectId}/github/repo/${repoId}`, {
        method: "DELETE",
      }),
    projectDevelopment: (projectId: string) =>
      request<DevelopmentPanel>(`/api/projects/${projectId}/development`),
    pullDetail: (projectId: string, repo: string, number: number) =>
      request<PullDetail>(
        `/api/projects/${projectId}/github/pull?repo=${encodeURIComponent(repo)}&number=${number}`,
      ),
    repoCommits: (projectId: string, repo: string, branch?: string) =>
      request<{ commits: RepoCommit[]; branch: string }>(
        `/api/projects/${projectId}/github/commits?repo=${encodeURIComponent(repo)}${branch ? `&branch=${encodeURIComponent(branch)}` : ""}`,
      ),
    repoBranches: (projectId: string, repo: string) =>
      request<{ branches: { name: string; protected: boolean }[]; default_branch: string }>(
        `/api/projects/${projectId}/github/branches?repo=${encodeURIComponent(repo)}`,
      ),
    importGitHub: (projectId: string, repoId?: string) =>
      post<{
        results: {
          repo: string;
          issues: { created: number; updated: number };
          prs: { created: number; updated: number };
          truncated?: boolean;
          error?: string;
        }[];
      }>(`/api/projects/${projectId}/github/import`, repoId ? { repo_id: repoId } : {}),

    // Todos
    listTodos: (projectId: string) =>
      request<{ todos: Todo[] }>(`/api/projects/${projectId}/todos`),
    createTodo: (projectId: string, content: string, issueId?: string) =>
      post<Todo>(`/api/projects/${projectId}/todos`, {
        content,
        ...(issueId ? { issue_id: issueId } : {}),
      }),
    updateTodo: (
      todoId: string,
      body: {
        content?: string;
        done?: boolean;
        status?: "todo" | "in_progress" | "done";
        issue_id?: string;
      },
    ) =>
      patch<Todo>(`/api/todos/${todoId}`, body),
    deleteTodo: (todoId: string) =>
      request<void>(`/api/todos/${todoId}`, { method: "DELETE" }),
    issueByKey: (projectId: string, key: string) =>
      request<{ id: string; key: string }>(
        `/api/projects/${projectId}/issues/key/${encodeURIComponent(key)}`,
      ),

    // Search
    search: (q: string) =>
      request<SearchResults>(`/api/search?q=${encodeURIComponent(q)}`),

    // Agent work reviews
    listReviews: (projectId: string, status?: string) =>
      request<{ reviews: AgentReview[]; pending: number }>(
        `/api/projects/${projectId}/reviews${status ? `?status=${status}` : ""}`,
      ),
    getReview: (reviewId: string) =>
      request<{ review: AgentReview }>(`/api/reviews/${reviewId}`),
    respondToReview: (
      reviewId: string,
      status: "approved" | "changes_requested",
      response?: string,
    ) =>
      post<{ review: AgentReview }>(`/api/reviews/${reviewId}/respond`, {
        status,
        ...(response ? { response } : {}),
      }),
    myReviews: () =>
      request<{ reviews: PendingReviewItem[] }>(`/api/me/reviews`),
    issueReviews: (issueId: string) =>
      request<{ reviews: AgentReview[] }>(`/api/issues/${issueId}/reviews`),
    pushIssueToGitHub: (issueId: string, repoId?: string) =>
      post<Issue>(`/api/issues/${issueId}/github`, repoId ? { repo_id: repoId } : {}),

    // Outbound webhooks — project event subscriptions for external agents
    listWebhooks: (projectId: string) =>
      request<{ webhooks: WebhookSubscription[]; catalog: string[] }>(
        `/api/projects/${projectId}/webhooks`,
      ),
    createWebhook: (
      projectId: string,
      body: {
        url?: string;
        events: string[];
        active?: boolean;
        relay_managed?: boolean;
      },
    ) =>
      post<WebhookSubscription>(`/api/projects/${projectId}/webhooks`, body),
    updateWebhook: (
      webhookId: string,
      body: { url?: string; events?: string[]; active?: boolean },
    ) =>
      request<{ webhook: WebhookSubscription }>(`/api/webhooks/${webhookId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    deleteWebhook: (webhookId: string) =>
      request<void>(`/api/webhooks/${webhookId}`, { method: "DELETE" }),
    webhookDeliveries: (webhookId: string) =>
      request<{ deliveries: WebhookDelivery[] }>(
        `/api/webhooks/${webhookId}/deliveries`,
      ),
    testWebhook: (webhookId: string) =>
      post<{ queued: boolean }>(`/api/webhooks/${webhookId}/test`, {}),

    // Avatars — same FormData trick as uploadAttachment
    uploadAvatar: (file: File) => {
      const form = new FormData();
      form.set("file", file);
      return request<{ avatar_url: string }>(`/api/me/avatar`, {
        method: "PUT",
        body: form,
      });
    },
    uploadAgentAvatar: (agentId: string, file: File) => {
      const form = new FormData();
      form.set("file", file);
      return request<{ id: string; avatar_url: string }>(
        `/api/agents/${agentId}/avatar`,
        { method: "PUT", body: form },
      );
    },
    uploadProjectIcon: (projectId: string, file: File) => {
      const form = new FormData();
      form.set("file", file);
      return request<{ id: string; icon_url: string }>(
        `/api/projects/${projectId}/icon`,
        { method: "PUT", body: form },
      );
    },
    adoptGithubIcon: (projectId: string) =>
      post<{ id: string; icon_url: string }>(
        `/api/projects/${projectId}/icon/github`,
      ),
    // Paste-a-link avatar/icon set: every PUT image endpoint also accepts
    // {"url"} and fetches the image server-side.
    uploadImageURL: (path: string, url: string) =>
      put<{ avatar_url?: string; icon_url?: string; id?: string }>(path, {
        url,
      }),
    uploadWorkspaceIcon: (workspaceId: string, file: File) => {
      const form = new FormData();
      form.set("file", file);
      return request<{ id: string; avatar_url: string }>(
        `/api/workspaces/${workspaceId}/icon`,
        { method: "PUT", body: form },
      );
    },

    // Realtime / notifications
    unread: () =>
      request<{ unread: Record<string, number>; reviews?: Record<string, number> }>(
        `/api/me/unread`,
      ),
    mentions: () =>
      request<{ mentions: Mention[] }>(`/api/me/mentions`),
    userProfile: (userId: string) =>
      request<UserProfile>(`/api/users/${userId}/profile`),

    // Statuses / local folder / saved views / boards
    setProjectStatuses: (projectId: string, statuses: StatusDef[] | null) =>
      put<{ statuses: StatusDef[] }>(
        `/api/projects/${projectId}/statuses`,
        { statuses },
      ),
    setProjectLocalPath: (projectId: string, path: string | null) =>
      put<{ local_path: string | null }>(
        `/api/projects/${projectId}/local_path`,
        { path },
      ),
    listProjectFiles: (projectId: string, path = "", recursive = false) =>
      request<{ entries: FileEntry[]; truncated: boolean }>(
        `/api/projects/${projectId}/files?path=${encodeURIComponent(path)}${recursive ? "&recursive=1" : ""}`,
      ),
    readProjectFile: (projectId: string, path: string) =>
      request<{ path: string; content: string; size: number }>(
        `/api/projects/${projectId}/files/read?path=${encodeURIComponent(path)}`,
      ),
    listSavedFilters: (projectId: string) =>
      request<{ filters: SavedFilter[] }>(
        `/api/projects/${projectId}/filters`,
      ),
    createSavedFilter: (
      projectId: string,
      input: { name: string; filters: Record<string, unknown> },
    ) =>
      post<SavedFilter>(`/api/projects/${projectId}/filters`, input),
    deleteSavedFilter: (projectId: string, filterId: string) =>
      request<{ deleted: boolean }>(
        `/api/projects/${projectId}/filters/${filterId}`,
        { method: "DELETE" },
      ),
    listBoards: (projectId: string) =>
      request<{ boards: Board[] }>(`/api/projects/${projectId}/boards`),
    createBoard: (
      projectId: string,
      input: { name: string; filters: Record<string, unknown> },
    ) => post<Board>(`/api/projects/${projectId}/boards`, input),
    deleteBoard: (projectId: string, boardId: string) =>
      request<{ deleted: boolean }>(
        `/api/projects/${projectId}/boards/${boardId}`,
        { method: "DELETE" },
      ),

    // Visual briefs
    listBriefs: (projectId: string, issueId?: string) =>
      request<{ briefs: Brief[]; policy: BriefPolicy }>(
        `/api/projects/${projectId}/briefs${issueId ? `?issue_id=${issueId}` : ""}`,
      ),
    createBrief: (
      projectId: string,
      input: {
        title: string;
        summary?: string;
        issue_id?: string;
        scene?: Record<string, unknown>;
      },
    ) => post<Brief>(`/api/projects/${projectId}/briefs`, input),
    getBrief: (briefId: string) => request<Brief>(`/api/briefs/${briefId}`),
    updateBrief: (
      briefId: string,
      input: {
        title?: string;
        summary?: string;
        status?: "open" | "resolved" | "archived";
        scene?: Record<string, unknown>;
      },
    ) => patch<Brief>(`/api/briefs/${briefId}`, input),
    briefConversation: (briefId: string) =>
      request<{ id: string }>(`/api/briefs/${briefId}/conversation`),
    setBriefPolicy: (projectId: string, policy: BriefPolicy) =>
      post<{ policy: BriefPolicy }>(
        `/api/projects/${projectId}/brief-policy`,
        { policy },
      ),

    // Linked-repo file browsing (file mentions)
    repoFileTree: (projectId: string, repo: string) =>
      request<{
        entries: { path: string; dir: boolean }[];
        truncated: boolean;
        repo: string;
        branch: string;
      }>(`/api/projects/${projectId}/github/files?repo=${encodeURIComponent(repo)}`),
    repoFileRead: (projectId: string, repo: string, path: string) =>
      request<{ path: string; content: string; size: number; repo: string }>(
        `/api/projects/${projectId}/github/files/read?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`,
      ),

    // Web push
    pushVapid: () =>
      request<{ enabled: boolean; public_key?: string; ephemeral?: boolean }>(
        `/api/push/vapid`,
      ),
    pushSubscribe: (endpoint: string, keys: { p256dh: string; auth: string }) =>
      put<{ subscribed: boolean }>(`/api/push/subscriptions`, {
        endpoint,
        keys,
      }),
    pushUnsubscribe: (endpoint: string) =>
      request<{ subscribed: boolean }>(`/api/push/subscriptions`, {
        method: "DELETE",
        body: JSON.stringify({ endpoint }),
        headers: { "Content-Type": "application/json" },
      }),

    // Attachments
    uploadAttachment: (projectId: string, file: File) => {
      const form = new FormData();
      form.set("file", file);
      // No Content-Type header: fetch sets the multipart boundary itself.
      return request<Attachment>(`/api/projects/${projectId}/attachments`, {
        method: "POST",
        body: form,
      });
    },
    // Redirect endpoint; use the returned path directly as img src / link
    // href — the session cookie rides along on the 302.
    attachmentURL: (projectId: string, attachmentId: string) =>
      `${baseUrl}/api/projects/${projectId}/attachments/${attachmentId}/download`,
  };
}

export type ApiClient = ReturnType<typeof createClient>;
