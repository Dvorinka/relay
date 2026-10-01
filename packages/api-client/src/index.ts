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

  function post<T>(path: string, body?: unknown): Promise<T> {
    return request<T>(path, {
      method: "POST",
      headers:
        body === undefined
          ? undefined
          : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
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
    postMessage: (conversationId: string, body: string) =>
      post<Message>(`/api/conversations/${conversationId}/messages`, { body }),
    markMessageRead: (messageId: string) =>
      post<void>(`/api/messages/${messageId}/read`),
  };
}

export type ApiClient = ReturnType<typeof createClient>;
