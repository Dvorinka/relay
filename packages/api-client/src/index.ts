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
export type Reaction = components["schemas"]["Reaction"];
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
  is_read: boolean;
  author: { name: string; avatar: string | null; kind: string };
}

export interface Todo {
  id: string;
  content: string;
  done: boolean;
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

export function createClient(baseUrl: string) {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      credentials: "include",
      ...init,
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
    projectOverview: (projectId: string) =>
      request<ProjectOverview>(`/api/projects/${projectId}/overview`),
    projectConversation: (projectId: string) =>
      request<Conversation>(`/api/projects/${projectId}/conversation`),

    // Conversations
    listMessages: (
      conversationId: string,
      opts?: { limit?: number; before?: string },
    ) => {
      const query = new URLSearchParams();
      if (opts?.limit !== undefined) {
        query.set("limit", String(opts.limit));
      }
      if (opts?.before) {
        query.set("before", opts.before);
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
    ) =>
      post<Message>(`/api/conversations/${conversationId}/messages`, {
        body,
        attachment_ids: attachmentIds,
        parent_id: parentId,
      }),
    editMessage: (messageId: string, body: string) =>
      patch<Message>(`/api/messages/${messageId}`, { body }),
    toggleReaction: (messageId: string, emoji: string) =>
      put<{ reactions: Reaction[] }>(`/api/messages/${messageId}/reactions`, {
        emoji,
      }),
    markMessageRead: (messageId: string) =>
      post<void>(`/api/messages/${messageId}/read`),

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
      input: { name?: string; description?: string; review_mode?: "notify" | "gate" },
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
      post<{ manifest: Record<string, unknown>; post_url: string }>(
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
        repos: {
          installation_id: number;
          full_name: string;
          owner: string;
          name: string;
          default_branch: string;
          private: boolean;
        }[];
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
      body: { content?: string; done?: boolean; issue_id?: string },
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
      body: { url: string; events: string[]; active?: boolean },
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

    // Realtime / notifications
    unread: () =>
      request<{ unread: Record<string, number>; reviews?: Record<string, number> }>(
        `/api/me/unread`,
      ),
    mentions: () =>
      request<{ mentions: Mention[] }>(`/api/me/mentions`),

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
