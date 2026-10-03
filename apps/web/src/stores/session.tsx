import {
  createContext,
  createResource,
  useContext,
  type Accessor,
  type ParentProps,
  type Resource,
} from "solid-js";
import {
  createClient,
  type AuthSession,
  type LoginRequest,
  type RegisterRequest,
  type User,
  type WorkspaceWithRole,
} from "@relay/api-client";
import { api } from "../lib/api";
import { desktopApplyConfig } from "../lib/desktop";
import { net } from "../lib/net";

export interface SessionStore {
  session: Resource<AuthSession | null>;
  user: Accessor<User | null>;
  workspaces: Accessor<WorkspaceWithRole[]>;
  /** True only during the initial session fetch, not background refetches. */
  loading: Accessor<boolean>;
  login: (input: LoginRequest, serverUrl?: string) => Promise<void>;
  register: (input: RegisterRequest, serverUrl?: string) => Promise<void>;
  /** Enter local mode: no server, all data on this device. */
  enterLocal: () => Promise<void>;
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
    login: async (input, serverUrl) => {
      const res = await createClient(serverUrl ?? net.serverUrl()).login(
        input,
      );
      // Persist the bearer so off-origin deployments keep working; the
      // cookie still rides along same-origin.
      const url = serverUrl ?? net.serverUrl();
      const wasLocal = net.isLocal();
      net.connect(url, res.token ?? "");
      // Leaving local mode inside the desktop shell: sync its config so
      // the next launch proxies this server instead of the embedded bundle.
      if (wasLocal && url) void desktopApplyConfig(url, false);
      mutate(res);
    },
    register: async (input, serverUrl) => {
      const res = await createClient(serverUrl ?? net.serverUrl()).register(
        input,
      );
      const url = serverUrl ?? net.serverUrl();
      const wasLocal = net.isLocal();
      net.connect(url, res.token ?? "");
      if (wasLocal && url) void desktopApplyConfig(url, false);
      mutate(res);
    },
    enterLocal: async () => {
      net.enterLocal();
      // Going local inside the desktop shell: it should serve the embedded
      // bundle next launch, not proxy the old server.
      void desktopApplyConfig("", true);
      await refetch(); // api.session resolves the local workspace
    },
    logout: async () => {
      try {
        await api.logout();
      } finally {
        net.disconnect();
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
