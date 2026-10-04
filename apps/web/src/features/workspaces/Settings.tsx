import { ApiClientError, type WorkspaceRole } from "@relay/api-client";
import {
  createResource,
  createSignal,
  For,
  Show,
  type ParentProps,
} from "solid-js";
import {
  Field,
  FormError,
  ImageURLField,
  SubmitButton,
  inputClass,
  primaryButtonClass,
} from "../../components/ui";
import { DownloadIcon, MoonIcon, SunIcon } from "../../components/icons";
import { api } from "../../lib/api";
import { mediaURL, net } from "../../lib/net";
import { syncToServer } from "../../lib/sync";
import { useSession } from "../../stores/session";
import {
  setChatStyle,
  toggleTheme,
  useChatStyle,
  useTheme,
} from "../../stores/theme";
import AgentsSection from "../agents/AgentsSection";
import GitHubAppSection from "../github/GitHubAppSection";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiClientError
    ? err.message
    : err instanceof Error
      ? err.message
      : fallback;
}

function Section(props: ParentProps<{ title: string }>) {
  return (
    <section class="border-t border-border py-6 first:border-t-0 first:pt-0">
      <h2 class="mb-4 text-[13px] font-semibold">{props.title}</h2>
      {props.children}
    </section>
  );
}

function ChangePasswordForm() {
  const [error, setError] = createSignal<string | null>(null);
  const [done, setDone] = createSignal(false);
  const [pending, setPending] = createSignal(false);

  async function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    setError(null);
    setDone(false);
    setPending(true);
    try {
      await api.changePassword(
        String(data.get("current_password") ?? ""),
        String(data.get("new_password") ?? ""),
      );
      form.reset();
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiClientError && err.status === 401
          ? "Current password is incorrect"
          : errorMessage(err, "Could not update password"),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} class="flex max-w-sm flex-col gap-4">
      <Field label="Current password">
        <input
          type="password"
          name="current_password"
          required
          autocomplete="current-password"
          class={inputClass}
        />
      </Field>
      <Field label="New password">
        <input
          type="password"
          name="new_password"
          required
          autocomplete="new-password"
          class={inputClass}
        />
      </Field>
      <FormError message={error()} />
      <Show when={done()}>
        <p class="text-[13px] text-muted">Password updated.</p>
      </Show>
      <div>
        <SubmitButton pending={pending()}>
          {pending() ? "Updating..." : "Change password"}
        </SubmitButton>
      </div>
    </form>
  );
}

function MemberList(props: { workspaceId: string; canInvite: boolean }) {
  const [members, { refetch }] = createResource(
    () => props.workspaceId,
    async (id) => (await api.listWorkspaceMembers(id)).members,
  );
  const [inviteError, setInviteError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);

  async function onInvite(e: SubmitEvent) {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    setInviteError(null);
    setPending(true);
    try {
      await api.inviteToWorkspace(props.workspaceId, {
        email: String(data.get("email") ?? ""),
        role: String(data.get("role") ?? "member") as WorkspaceRole,
      });
      form.reset();
      await refetch();
    } catch (err) {
      setInviteError(
        err instanceof ApiClientError && err.status === 404
          ? "No account exists for that email"
          : errorMessage(err, "Invite failed"),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div class="flex flex-col gap-4">
      <ul class="divide-y divide-border rounded-md border border-border">
        <For
          each={members()}
          fallback={
            <li class="px-3 py-2.5 text-[13px] text-muted">
              {members.state === "errored"
                ? "Could not load members"
                : "Loading members..."}
            </li>
          }
        >
          {(m) => (
            <li class="flex items-center gap-3 px-3 py-2.5">
              <div class="min-w-0 flex-1">
                <p class="truncate text-[13px] font-medium">{m.user.name}</p>
                <p class="truncate text-[13px] text-muted">{m.user.email}</p>
              </div>
              <span class="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted">
                {m.role}
              </span>
            </li>
          )}
        </For>
      </ul>

      <Show when={props.canInvite}>
        <form onSubmit={onInvite} class="flex max-w-sm flex-col gap-3">
          <div class="flex gap-2">
            <input
              type="email"
              name="email"
              required
              placeholder="teammate@example.com"
              aria-label="Invite email"
              class={inputClass}
            />
            <select name="role" class={inputClass} aria-label="Role">
              <option value="member">member</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <FormError message={inviteError()} />
          <div>
            <SubmitButton pending={pending()}>
              {pending() ? "Adding..." : "Add member"}
            </SubmitButton>
          </div>
        </form>
      </Show>
    </div>
  );
}

function NewWorkspaceForm(props: { onCreated: () => void }) {
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);

  async function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    const data = new FormData(e.currentTarget as HTMLFormElement);
    const slug = String(data.get("slug") ?? "").trim();
    setError(null);
    setPending(true);
    try {
      await api.createWorkspace({
        name: String(data.get("name") ?? "").trim(),
        ...(slug ? { slug } : {}),
      });
      props.onCreated();
    } catch (err) {
      setError(errorMessage(err, "Could not create workspace"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} class="flex max-w-sm flex-col gap-4">
      <Field label="Workspace name">
        <input type="text" name="name" required class={inputClass} />
      </Field>
      <Field label="Slug (optional)">
        <input
          type="text"
          name="slug"
          pattern="[a-z0-9-]+"
          class={inputClass}
        />
      </Field>
      <FormError message={error()} />
      <div>
        <SubmitButton pending={pending()}>
          {pending() ? "Creating..." : "Create workspace"}
        </SubmitButton>
      </div>
    </form>
  );
}

// Theme toggle + chat layout — the accent is the fixed brand cyan.
function AppearanceSection() {
  const { theme } = useTheme();
  const { chatStyle } = useChatStyle();
  const seg = (active: boolean) =>
    `rounded-md px-2.5 py-1 text-[12.5px] transition-colors ${
      active
        ? "bg-accent-soft font-medium text-accent-ink"
        : "text-muted hover:text-fg"
    }`;
  return (
    <div class="flex flex-col gap-4">
      <div class="flex items-center gap-2">
        <span class="w-20 text-[12px] text-muted">Theme</span>
        <button
          type="button"
          onClick={toggleTheme}
          class="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-[12.5px] transition-colors hover:bg-hover"
        >
          <Show
            when={theme() === "dark"}
            fallback={<SunIcon class="h-3.5 w-3.5" />}
          >
            <MoonIcon class="h-3.5 w-3.5" />
          </Show>
          {theme() === "dark" ? "Dark" : "Light"}
        </button>
      </div>
      <div class="flex items-center gap-2">
        <span class="w-20 text-[12px] text-muted">Chat layout</span>
        <div
          class="flex gap-0.5 rounded-lg border border-border bg-surface p-0.5"
          role="group"
          aria-label="Chat layout"
        >
          <button
            type="button"
            onClick={() => setChatStyle("grouped")}
            class={seg(chatStyle() === "grouped")}
            aria-pressed={chatStyle() === "grouped"}
          >
            Left aligned
          </button>
          <button
            type="button"
            onClick={() => setChatStyle("bubbles")}
            class={seg(chatStyle() === "bubbles")}
            aria-pressed={chatStyle() === "bubbles"}
          >
            Two-sided
          </button>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <span class="w-20 text-[12px] text-muted">Accent</span>
        <span class="flex items-center gap-1.5">
          <span
            class="h-5 w-5 rounded-full"
            style={{ "background-color": "#06b6d4" }}
          />
          <code class="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted">
            #06B6D4
          </code>
          <span class="text-[11px] text-muted/70">brand</span>
        </span>
      </div>
    </div>
  );
}


// urlB64ToUint8Array converts the VAPID public key (URL-safe base64) into
// the ArrayBuffer PushManager.subscribe wants.
function urlB64ToUint8Array(b64: string): Uint8Array {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function NotificationsSection() {
  const supported = () =>
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
  const [permission, setPermission] = createSignal(
    supported() ? Notification.permission : "unsupported",
  );
  const [subscribed, setSubscribed] = createSignal(false);
  const [ephemeral, setEphemeral] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  createResource(async () => {
    if (!supported() || net.isLocal()) return;
    try {
      const v = await api.pushVapid();
      setEphemeral(v.ephemeral === true);
      if (!v.enabled) return;
      const reg = await navigator.serviceWorker.getRegistration("/sw.js");
      const sub = await reg?.pushManager.getSubscription();
      setSubscribed(!!sub);
    } catch {
      /* server without push */
    }
  });

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      if (subscribed()) {
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await api.pushUnsubscribe(sub.endpoint);
          await sub.unsubscribe();
        }
        setSubscribed(false);
        return;
      }
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") {
        setError("Notification permission was not granted");
        return;
      }
      const vapid = await api.pushVapid();
      if (!vapid.enabled || !vapid.public_key) {
        setError("This server has no push keys configured");
        return;
      }
      setEphemeral(vapid.ephemeral === true);
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(
          vapid.public_key,
        ).buffer as ArrayBuffer,
      });
      const json = sub.toJSON();
      await api.pushSubscribe(sub.endpoint, {
        p256dh: json.keys?.p256dh ?? "",
        auth: json.keys?.auth ?? "",
      });
      setSubscribed(true);
    } catch (err) {
      setError(errorMessage(err, "Subscription failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="flex flex-col gap-3">
      <div class="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void toggle()}
          disabled={busy() || !supported() || permission() === "unsupported"}
          class="h-8 rounded-md border border-border bg-surface px-3 text-[12.5px] transition-colors hover:bg-hover disabled:opacity-50"
        >
          {subscribed() ? "Disable notifications" : "Enable notifications"}
        </button>
        <span class="text-[12px] text-muted">
          {subscribed()
            ? "On — mentions, replies, and reviews reach this browser"
            : permission() === "denied"
              ? "Blocked by the browser — allow notifications in site settings"
              : "Mentions, replies, and review requests"}
        </span>
      </div>
      <Show when={ephemeral() && subscribed()}>
        <p class="text-[11px] text-amber-600 dark:text-amber-400">
          Server uses ephemeral push keys — notifications stop after a server
          restart until you toggle this off and on.
        </p>
      </Show>
      <FormError message={error()} />
    </div>
  );
}

// Connection card: which backend this app talks to. Local mode stores
// everything on this device; "Connect a server" moves to a real Relay
// backend, and "Sync to server" pushes the local store up once connected.
function ConnectionSection() {
  const session = useSession();
  const [syncPending, setSyncPending] = createSignal(false);
  const [connectPending, setConnectPending] = createSignal(false);
  const [step, setStep] = createSignal("");
  const [result, setResult] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const mode = () =>
    net.isLocal()
      ? "This device (local)"
      : net.serverUrl() || window.location.origin;

  async function onSync(e: SubmitEvent) {
    e.preventDefault();
    const data = new FormData(e.currentTarget as HTMLFormElement);
    setError(null);
    setResult(null);
    setSyncPending(true);
    try {
      const r = await syncToServer(
        String(data.get("server_url") ?? ""),
        String(data.get("email") ?? ""),
        String(data.get("password") ?? ""),
        setStep,
      );
      setResult(
        `Synced ${r.projects} project(s), ${r.messages} message(s), ${r.issues} issue(s), ${r.todos} todo(s), ${r.briefs} brief(s). Local data is unchanged.`,
      );
    } catch (err) {
      setError(errorMessage(err, "Sync failed"));
    } finally {
      setSyncPending(false);
      setStep("");
    }
  }

  async function onConnect(e: SubmitEvent) {
    e.preventDefault();
    const data = new FormData(e.currentTarget as HTMLFormElement);
    setError(null);
    setConnectPending(true);
    try {
      await session.login(
        {
          email: String(data.get("email") ?? ""),
          password: String(data.get("password") ?? ""),
        },
        String(data.get("server_url") ?? ""),
      );
    } catch (err) {
      setError(errorMessage(err, "Could not connect"));
      setConnectPending(false);
      return;
    }
    setConnectPending(false);
  }

  return (
    <div class="flex flex-col gap-4">
      <div class="flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2.5">
        <span
          class={`h-2 w-2 rounded-full ${net.isLocal() ? "bg-amber-500" : "bg-emerald-500"}`}
        />
        <div class="min-w-0 flex-1">
          <p class="text-[13px] font-medium">{mode()}</p>
          <p class="text-[12px] text-muted">
            {net.isLocal()
              ? "Everything is stored on this device. Nothing is shared."
              : "Connected — syncs across devices signed in here."}
          </p>
        </div>
        <Show
          when={!net.isLocal()}
          fallback={null}
        >
          <button
            type="button"
            class="rounded-md border border-border px-2.5 py-1 text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg"
            onClick={async () => {
              await session.enterLocal();
            }}
          >
            Work locally
          </button>
        </Show>
      </div>

      <Show when={net.isLocal()}>
        <form onSubmit={onSync} class="flex max-w-sm flex-col gap-3">
          <p class="text-[12.5px] text-muted">
            Copy this device's workspace to a server. Creates projects,
            replays messages and issues — local data stays here either way.
          </p>
          <input
            type="url"
            name="server_url"
            required
            placeholder="https://relay.example.com"
            aria-label="Server URL"
            class={inputClass}
          />
          <input
            type="email"
            name="email"
            required
            autocomplete="email"
            placeholder="you@example.com"
            aria-label="Account email"
            class={inputClass}
          />
          <input
            type="password"
            name="password"
            required
            autocomplete="current-password"
            placeholder="Password"
            aria-label="Account password"
            class={inputClass}
          />
          <Show when={step()}>
            <p class="text-[12px] text-muted">{step()}…</p>
          </Show>
          <div>
            <SubmitButton pending={syncPending()}>
              {syncPending() ? "Syncing..." : "Sync to server"}
            </SubmitButton>
          </div>
        </form>
      </Show>

      <Show when={net.isLocal()}>
        <form onSubmit={onConnect} class="flex max-w-sm flex-col gap-3 border-t border-border pt-4">
          <p class="text-[12.5px] text-muted">
            Or connect a server now — you'll sign in there and leave local
            mode. Sync first if you want this device's data kept.
          </p>
          <input
            type="url"
            name="server_url"
            required
            placeholder="https://relay.example.com"
            aria-label="Server URL"
            class={inputClass}
          />
          <input
            type="email"
            name="email"
            required
            autocomplete="email"
            placeholder="you@example.com"
            aria-label="Account email"
            class={inputClass}
          />
          <input
            type="password"
            name="password"
            required
            autocomplete="current-password"
            placeholder="Password"
            aria-label="Account password"
            class={inputClass}
          />
          <div>
            <SubmitButton pending={connectPending()}>
              {connectPending() ? "Connecting..." : "Connect & sign in"}
            </SubmitButton>
          </div>
        </form>
      </Show>

      <FormError message={error()} />
      <Show when={result()}>
        <p class="text-[13px] text-emerald-500">{result()}</p>
      </Show>
    </div>
  );
}

export default function Settings() {
  const session = useSession();
  const current = () => session.workspaces()[0];
  const canInvite = () => {
    const role = current()?.role;
    return role === "owner" || role === "admin";
  };
  const [showNew, setShowNew] = createSignal(false);
  const [avatarError, setAvatarError] = createSignal<string | null>(null);

  return (
    <div class="mx-auto w-full max-w-2xl px-6 py-8">
      <h1 class="mb-6 text-[15px] font-semibold">Settings</h1>

      <Section title="Connection">
        <ConnectionSection />
      </Section>

      <Section title="Appearance">
        <AppearanceSection />
      </Section>

      <Show when={!net.isLocal()}>
        <Section title="Notifications">
          <NotificationsSection />
        </Section>
      </Show>

      <Section title="Account">
        <div class="mb-5 flex items-center gap-3">
          <Show
            when={session.user()?.avatar_url}
            fallback={
              <span class="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface font-mono text-[13px] text-muted">
                {(session.user()?.name ?? "?").slice(0, 1).toUpperCase()}
              </span>
            }
          >
            {(url) => (
              <img
                src={mediaURL(url())}
                alt=""
                class="h-10 w-10 rounded-full border border-border object-cover"
              />
            )}
          </Show>
          <div class="min-w-0 flex-1">
            <p class="text-[13px] font-medium">{session.user()?.name}</p>
            <p class="text-[13px] text-muted">{session.user()?.email}</p>
          </div>
          <label class="cursor-pointer rounded-md border border-border bg-surface px-2.5 py-1 text-[12px] hover:bg-hover">
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp,image/x-icon"
              class="sr-only"
              onChange={async (e) => {
                const f = e.currentTarget.files?.[0];
                if (!f) return;
                try {
                  await api.uploadAvatar(f);
                  await session.refresh();
                } catch (err) {
                  setAvatarError(errorMessage(err, "Upload failed"));
                }
                e.currentTarget.value = "";
              }}
            />
            Set avatar
          </label>
          <Show when={session.user()?.avatar_url}>
            {(url) => (
              <a
                href={url().startsWith("blob:") ? url() : mediaURL(`${url()}?download=1`)}
                download="avatar"
                title="Download avatar"
                aria-label="Download avatar"
                class="rounded-md border border-border bg-surface p-1.5 text-muted hover:bg-hover hover:text-fg"
              >
                <DownloadIcon class="h-3.5 w-3.5" />
              </a>
            )}
          </Show>
        </div>
        <Show when={!net.isLocal()}>
          <div class="mt-3 max-w-sm">
            <ImageURLField
              placeholder="https://example.com/avatar.png"
              onSubmit={async (u) => {
                await api.uploadImageURL("/api/me/avatar", u);
                await session.refresh();
              }}
            />
          </div>
        </Show>
        <FormError message={avatarError()} />
        <Show when={!net.isLocal()}>
          <ChangePasswordForm />
        </Show>
      </Section>

      <Section title="Workspace">
        <Show
          when={current()}
          fallback={
            <div class="flex flex-col gap-4">
              <p class="text-[13px] text-muted">
                You are not in a workspace yet.
              </p>
              <NewWorkspaceForm onCreated={() => session.refresh()} />
            </div>
          }
        >
          {(ws) => (
            <div class="flex flex-col gap-5">
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-[13px] font-medium">{ws().name}</p>
                  <p class="font-mono text-[11px] text-muted">
                    {ws().slug} · {ws().role}
                  </p>
                </div>
                <button
                  type="button"
                  class={primaryButtonClass}
                  onClick={() => setShowNew((v) => !v)}
                >
                  New workspace
                </button>
              </div>
              <div class="flex items-center gap-3">
                <Show
                  when={ws().avatar_url}
                  fallback={
                    <span class="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-surface font-mono text-[13px] text-muted">
                      {ws().name.slice(0, 1).toUpperCase()}
                    </span>
                  }
                >
                  {(url) => (
                    <img
                      src={mediaURL(url())}
                      alt=""
                      class="h-10 w-10 rounded-lg border border-border object-cover"
                    />
                  )}
                </Show>
                <div class="min-w-0 flex-1 text-[12px] text-muted">
                  Workspace icon — shown in the rail header.
                </div>
                <Show when={ws().avatar_url}>
                  {(url) => (
                    <a
                      href={url().startsWith("blob:") ? url() : mediaURL(`${url()}?download=1`)}
                      download="workspace-icon"
                      title="Download icon"
                      aria-label="Download workspace icon"
                      class="rounded-md border border-border bg-surface p-1.5 text-muted hover:bg-hover hover:text-fg"
                    >
                      <DownloadIcon class="h-3.5 w-3.5" />
                    </a>
                  )}
                </Show>
                <Show when={canInvite()}>
                  <label class="cursor-pointer rounded-md border border-border bg-surface px-2.5 py-1 text-[12px] hover:bg-hover">
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp,image/x-icon"
                      class="sr-only"
                      onChange={async (e) => {
                        const f = e.currentTarget.files?.[0];
                        if (!f) return;
                        try {
                          await api.uploadWorkspaceIcon(ws().id, f);
                          await session.refresh();
                        } catch (err) {
                          setAvatarError(errorMessage(err, "Upload failed"));
                        }
                        e.currentTarget.value = "";
                      }}
                    />
                    Set icon
                  </label>
                </Show>
              </div>
              <Show when={canInvite() && !net.isLocal()}>
                <div class="max-w-sm">
                  <ImageURLField
                    placeholder="https://example.com/icon.png"
                    onSubmit={async (u) => {
                      await api.uploadImageURL(
                        `/api/workspaces/${ws().id}/icon`,
                        u,
                      );
                      await session.refresh();
                    }}
                  />
                </div>
              </Show>
              <Show when={showNew()}>
                <NewWorkspaceForm
                  onCreated={() => {
                    setShowNew(false);
                    session.refresh();
                  }}
                />
              </Show>
              <MemberList workspaceId={ws().id} canInvite={canInvite()} />
            </div>
          )}
        </Show>
      </Section>

      <Show when={!net.isLocal() && current()}>
        {(ws) => (
          <>
            <Section title="Agents">
              <AgentsSection workspaceId={ws().id} canManage={canInvite()} />
            </Section>
            <Section title="GitHub">
              <GitHubAppSection workspaceId={ws().id} canManage={canInvite()} />
            </Section>
          </>
        )}
      </Show>
    </div>
  );
}
