import {
  createContext,
  createResource,
  useContext,
  type Accessor,
  type ParentProps,
  type Resource,
} from "solid-js";
import type {
  AuthSession,
  LoginRequest,
  RegisterRequest,
  User,
  WorkspaceWithRole,
} from "@relay/api-client";
import { api } from "../lib/api";

export interface SessionStore {
  session: Resource<AuthSession | null>;
  user: Accessor<User | null>;
  workspaces: Accessor<WorkspaceWithRole[]>;
  /** True only during the initial session fetch, not background refetches. */
  loading: Accessor<boolean>;
  login: (input: LoginRequest) => Promise<void>;
  register: (input: RegisterRequest) => Promise<void>;
  logout: () => Promise<void>;
  /** Re-fetch /api/auth/session (e.g. after creating a workspace). */
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionStore>();

export function SessionProvider(props: ParentProps) {
  const [session, { mutate, refetch }] = createResource<AuthSession | null>(
    () => api.session().catch(() => null),
  );

  const user = () => session()?.user ?? null;
  const workspaces = () => session()?.workspaces ?? [];
  const loading = () => session.state === "pending";

  const store: SessionStore = {
    session,
    user,
    workspaces,
    loading,
    login: async (input) => {
      mutate(await api.login(input));
    },
    register: async (input) => {
      mutate(await api.register(input));
    },
    logout: async () => {
      try {
        await api.logout();
      } finally {
        mutate(null);
      }
    },
    refresh: async () => {
      await refetch();
    },
  };

  return (
    <SessionContext.Provider value={store}>
      {props.children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionStore {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error("useSession must be used within <SessionProvider>");
  }
  return ctx;
}
