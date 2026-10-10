import {
  ApiClientError,
  createClient,
  type WorkspaceRole,
} from "@relay/api-client";
import {
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type ParentProps,
} from "solid-js";
import {
  ColorField,
  Field,
  FormError,
  ImageURLField,
  Spinner,
  SubmitButton,
  inputClass,
  primaryButtonClass,
  Tip,
} from "../../components/ui";
import { Select } from "../../components/Select";
import {
  DownloadIcon,
  MoonIcon,
  SunIcon,
  TrashIcon,
} from "../../components/icons";
import {
  activateConnection,
  connectionHue,
  connections,
  forgetConnection,
  rememberConnection,
} from "../../lib/connections";
import { api } from "../../lib/api";
import { browserAuth } from "../../lib/desktop";
import { mediaURL, net } from "../../lib/net";
import {
  deliver,
  notifyCategory,
  notifyEnabled,
  requestNotifyPermission,
  setNotifyCategory,
  setNotifyEnabled,
  type NotifyCategory,
} from "../../lib/notify";
import {
  notifySound,
  playSound,
  setNotifySound,
  SOUNDS,
  type SoundId,
} from "../../lib/sounds";
import {
  desktopAutostart,
  desktopBackground,
  desktopQuit,
  desktopSetAutostart,
  desktopSetBackground,
  desktopServerUrl,
  isDesktop,
  isMobileShell,
} from "../../lib/desktop";
import {
  syncToServer,
  syncWithToken,
  type SyncResult,
} from "../../lib/sync";
import { useSession } from "../../stores/session";
import {
  setChatStyle,
  setClockFormat,
  toggleTheme,
  useChatStyle,
  useClock,
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
  const [inviteRole, setInviteRole] = createSignal("member");
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
            <input type="hidden" name="role" value={inviteRole()} />
            <Select
              value={inviteRole()}
              onChange={setInviteRole}
              ariaLabel="Role"
              options={[
                { value: "member", label: "member" },
                { value: "admin", label: "admin" },
              ]}
            />
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

// Launch-at-login for the desktop shell — backed by the OS mechanism the
// shell manages (HKCU Run key / freedesktop entry / LaunchAgent).
function DesktopSection() {
  const [state, { refetch }] = createResource(desktopAutostart);
  const [bg, { refetch: refetchBg }] = createResource(desktopBackground);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function run(fn: () => Promise<void>, refetchFn: () => void) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      refetchFn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not update");
    } finally {
      setBusy(false);
    }
  }

  const checkCls = "h-3.5 w-3.5 accent-accent";
  const labelCls =
    "flex w-fit cursor-pointer items-center gap-2 text-[12.5px] text-muted transition-colors hover:text-fg";

  return (
    <div class="flex flex-col gap-3">
      <Show
        when={state.state === "ready" && bg.state === "ready"}
        fallback={<Spinner class="h-3.5 w-3.5" />}
      >
        <div>
          <label class={labelCls}>
            <input
              type="checkbox"
              checked={state()!.enabled}
              disabled={busy()}
              onChange={(e) =>
                void run(
                  () => desktopSetAutostart(e.currentTarget.checked),
                  refetch,
                )
              }
              class={checkCls}
            />
            Launch Relay when you sign in
          </label>
          <p class="mt-0.5 text-[11.5px] text-faint">
            Starts the desktop app automatically on system startup.
          </p>
        </div>
        <div>
          <label class={labelCls}>
            <input
              type="checkbox"
              checked={bg()!.enabled}
              disabled={busy()}
              onChange={(e) =>
                void run(
                  () => desktopSetBackground(e.currentTarget.checked),
                  refetchBg,
                )
              }
              class={checkCls}
            />
            Keep running in the background
          </label>
          <p class="mt-0.5 text-[11.5px] text-faint">
            Closing the window keeps Relay connected — @mention alerts still
            arrive as system notifications. The window returns from the system
            tray icon (in the hidden-icons overflow) or by relaunching the app.
          </p>
        </div>
        <Show when={bg()!.enabled}>
          <div>
            <button
              type="button"
              onClick={() => desktopQuit()}
              class="h-8 rounded-md border border-border bg-surface px-3 text-[12.5px] text-muted transition-colors hover:bg-hover hover:text-fg"
            >
              Quit Relay
            </button>
            <p class="mt-0.5 text-[11.5px] text-faint">
              Exits the app entirely — closing the window only hides it while
              background mode is on.
            </p>
          </div>
        </Show>
      </Show>
      <FormError message={error()} />
    </div>
  );
}

// Theme toggle + chat layout — the accent is the fixed brand cyan.
function AppearanceSection() {
  const { theme } = useTheme();
  const { chatStyle } = useChatStyle();
  const { clockFormat } = useClock();
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
        <span class="w-20 text-[12px] text-muted">Clock</span>
        <div
          class="flex gap-0.5 rounded-lg border border-border bg-surface p-0.5"
          role="group"
          aria-label="Clock format"
        >
          <button
            type="button"
            onClick={() => setClockFormat("system")}
            class={seg(clockFormat() === "system")}
            aria-pressed={clockFormat() === "system"}
          >
            System
          </button>
          <button
            type="button"
            onClick={() => setClockFormat("12")}
            class={seg(clockFormat() === "12")}
            aria-pressed={clockFormat() === "12"}
          >
            12-hour
          </button>
          <button
            type="button"
            onClick={() => setClockFormat("24")}
            class={seg(clockFormat() === "24")}
            aria-pressed={clockFormat() === "24"}
          >
            24-hour
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

// DigestRow is the server-side batching toggle — with it on, push for this
// user queues and flushes as one bundled notification roughly every half
// hour instead of per event.
function DigestRow() {
  const [on, setOn] = createSignal<boolean | null>(null);
  const [busy, setBusy] = createSignal(false);
  onMount(() => {
    void api
      .getDigestMode()
      .then((r) => setOn(r.digest_enabled))
      .catch(() => setOn(false));
  });
  async function toggleDigest() {
    if (on() === null || busy()) return;
    setBusy(true);
    try {
      const r = await api.setDigestMode(!on());
      setOn(r.digest_enabled);
    } catch {
      // Leave the toggle as it was — a failed flip reads as unchanged.
    } finally {
      setBusy(false);
    }
  }
  return (
    <Show when={on() !== null}>
      <div class="flex items-center gap-3 border-t border-border/60 pt-3">
        <button
          type="button"
          onClick={() => void toggleDigest()}
          disabled={busy()}
          class="h-8 rounded-md border border-border bg-surface px-3 text-[12.5px] transition-colors hover:bg-hover disabled:opacity-50"
        >
          {on() ? "Disable digest" : "Enable digest"}
        </button>
        <span class="text-[12px] text-muted">
          {on()
            ? "Digest on — push batches into one summary every ~30 min"
            : "Digest mode — batch push alerts into a periodic summary"}
        </span>
      </div>
    </Show>
  );
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

  // Foreground notifications fire while the app runs — the only delivery
  // path the desktop shell has (no service worker push there).
  const [fg, setFg] = createSignal(notifyEnabled());
  const [fgBusy, setFgBusy] = createSignal(false);
  const [fgError, setFgError] = createSignal<string | null>(null);
  const [sound, setSound] = createSignal<SoundId>(notifySound());

  async function toggleFg() {
    setFgBusy(true);
    setFgError(null);
    try {
      if (!fg()) {
        const ok = await requestNotifyPermission();
        if (!ok) {
          setFgError("Notification permission was not granted");
          return;
        }
        setNotifyEnabled(true);
        setFg(true);
        await deliver("Relay", "Notifications are on");
      } else {
        setNotifyEnabled(false);
        setFg(false);
      }
    } finally {
      setFgBusy(false);
    }
  }

  return (
    <div class="flex flex-col gap-4">
      <div class="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void toggleFg()}
          disabled={fgBusy()}
          class="h-8 rounded-md border border-border bg-surface px-3 text-[12.5px] transition-colors hover:bg-hover disabled:opacity-50"
        >
          {fg() ? "Disable notifications" : "Enable notifications"}
        </button>
        <span class="text-[12px] text-muted">
          {fg()
            ? "On — @mentions and replies alert while the app is running"
            : "@mentions and replies, while the app is running"}
        </span>
      </div>
      <Show when={fg()}>
        <div class="grid gap-1.5 rounded-md border border-border/60 p-3">
          <p class="text-[11px] font-medium uppercase tracking-wide text-faint">
            Notify me about
          </p>
          <For
            each={
              [
                ["mentions", "@mentions — someone needs you specifically"],
                ["replies", "Replies to your messages"],
                ["messages", "All new messages in channels"],
                ["agents", "Agent status updates (progress goes to threads silently)"],
                ["todos", "Todo list changes"],
                ["reviews", "Review requests from agents"],
              ] as [NotifyCategory, string][]
            }
          >
            {([cat, label]) => (
              <label class="flex cursor-pointer items-center gap-2 text-[12.5px] text-muted transition-colors hover:text-fg">
                <input
                  type="checkbox"
                  checked={notifyCategory(cat)}
                  onChange={(e) =>
                    setNotifyCategory(cat, e.currentTarget.checked)
                  }
                  class="h-3.5 w-3.5 accent-accent"
                />
                {label}
              </label>
            )}
          </For>
        </div>
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="mr-1 text-[11px] font-medium uppercase tracking-wide text-faint">
            Sound
          </span>
          <For each={SOUNDS}>
            {(s) => (
              <Tip text={s.hint} side="top">
                <button
                  type="button"
                  onClick={() => {
                    setNotifySound(s.id);
                    setSound(s.id);
                    playSound(s.id);
                  }}
                  class={`rounded-full border px-2.5 py-1 text-[11.5px] transition-colors ${
                    sound() === s.id
                      ? "border-accent/60 bg-accent-soft text-accent-ink"
                      : "border-border text-muted hover:bg-hover hover:text-fg"
                  }`}
                >
                  {s.label}
                </button>
              </Tip>
            )}
          </For>
        </div>
      </Show>
      <FormError message={fgError()} />
      {/* Web push needs a service worker + push service — absent in the
          desktop webview. There, "Keep running in the background" (Settings →
          Desktop) plays the same role: toasts arrive while the app runs
          hidden. */}
      <DigestRow />
      <Show when={supported() && !isDesktop()}>
        <div class="flex items-center gap-3 border-t border-border/60 pt-3">
          <button
            type="button"
            onClick={() => void toggle()}
            disabled={busy() || permission() === "unsupported"}
            class="h-8 rounded-md border border-border bg-surface px-3 text-[12.5px] transition-colors hover:bg-hover disabled:opacity-50"
          >
            {subscribed() ? "Disable push" : "Enable push"}
          </button>
          <span class="text-[12px] text-muted">
            {subscribed()
              ? "Push on — reaches this browser even when closed"
              : permission() === "denied"
                ? "Blocked by the browser — allow notifications in site settings"
                : "Background push — alerts when the app is closed"}
          </span>
        </div>
        <Show when={ephemeral() && subscribed()}>
          <p class="text-[11px] text-amber-600 dark:text-amber-400">
            Server uses ephemeral push keys — notifications stop after a
            server restart until you toggle this off and on.
          </p>
        </Show>
      </Show>
      <FormError message={error()} />
    </div>
  );
}

// Chat name color: #rrggbb stored on the user; empty clears back to the
// deterministic palette color.
function NameColorRow() {
  const session = useSession();
  const [value, setValue] = createSignal(session.user()?.name_color ?? "");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function save(v: string) {
    setBusy(true);
    setError(null);
    try {
      await api.updateMe({ name_color: v });
      await session.refresh();
      setValue(v);
    } catch (err) {
      setError(errorMessage(err, "Could not save color"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="mt-4 flex items-center gap-2">
      <span class="w-20 text-[12px] text-muted">Name color</span>
      <ColorField
        value={value() || "#3b82f6"}
        disabled={busy()}
        label="Chat name color"
        onPick={(hex) => void save(hex)}
      />
      <span class="font-mono text-[11.5px] text-muted">
        {value() || "palette default"}
      </span>
      <Show when={value()}>
        <button
          type="button"
          disabled={busy()}
          onClick={() => void save("")}
          class="text-[12px] text-muted underline-offset-2 hover:text-fg hover:underline"
        >
          Clear
        </button>
      </Show>
      <FormError message={error()} />
    </div>
  );
}

// Connection card: which backend this app talks to. Local mode stores
// everything on this device; one connect form handles both auth styles —
// email+password in-app or approval in the system browser — and the
// "copy data" checkbox decides whether the local store syncs up first.
function ConnectionSection() {
  const session = useSession();
  const [syncPending, setSyncPending] = createSignal(false);
  const [connectPending, setConnectPending] = createSignal(false);
  const [browserPending, setBrowserPending] = createSignal(false);
  const [switching, setSwitching] = createSignal(false);
  const [step, setStep] = createSignal("");
  const [result, setResult] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let cancelAuth: (() => void) | null = null;
  onCleanup(() => cancelAuth?.());

  // Local mode and server switching only make sense off the server's own
  // hosted UI — the desktop app or a cross-origin client. Same rule as
  // the login page.
  const altPaths = () => isDesktop() || isMobileShell() || !!net.serverUrl();

  // Prefill the connect form with the last server this device used — held
  // in localStorage for cross-origin sessions, or the desktop shell's
  // config after a server-outage fallback into local mode.
  const [remembered, setRemembered] = createSignal(net.serverUrl());
  onMount(() => {
    if (!net.serverUrl()) void desktopServerUrl().then(setRemembered);
  });

  const mode = () =>
    net.isLocal()
      ? "This device (local)"
      : net.serverUrl() || window.location.origin;

  const syncSummary = (r: SyncResult) =>
    `Synced ${r.projects} project(s), ${r.messages} message(s), ${r.issues} issue(s), ${r.todos} todo(s), ${r.briefs} brief(s).`;

  // Any button inside the merged connect form reaches the shared fields.
  function formData(el: HTMLElement): FormData | null {
    const form = el.closest("form");
    return form ? new FormData(form) : null;
  }

  // "Copy data without connecting": sync and stay local.
  async function onSyncOnly(e: MouseEvent) {
    const form = (e.currentTarget as HTMLElement).closest("form");
    if (!form?.reportValidity()) return;
    const data = new FormData(form);
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
      setResult(`${syncSummary(r)} Local data is unchanged.`);
    } catch (err) {
      setError(errorMessage(err, "Sync failed"));
    } finally {
      setSyncPending(false);
      setStep("");
    }
  }

  // "Connect & sign in": optional sync first (data lands before we leave
  // local mode), then the normal login switches the session over.
  async function onConnect(e: SubmitEvent) {
    e.preventDefault();
    const data = new FormData(e.currentTarget as HTMLFormElement);
    const url = String(data.get("server_url") ?? "");
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");
    setError(null);
    setResult(null);
    setConnectPending(true);
    try {
      if (data.get("copy") === "on") {
        setResult(`${syncSummary(await syncToServer(url, email, password, setStep))}`);
      }
      await session.login({ email, password }, url);
    } catch (err) {
      setError(errorMessage(err, "Could not connect"));
    } finally {
      setConnectPending(false);
      setStep("");
    }
  }

  // Browser sign-in: no password fields needed — approval happens on the
  // server's /connect page in the system browser. Sync runs on the minted
  // token before the session switches.
  async function onBrowserAuth(e: MouseEvent) {
    const el = e.currentTarget as HTMLElement;
    const urlInput = el.closest("form")?.elements.namedItem("server_url");
    if (urlInput instanceof HTMLInputElement && !urlInput.reportValidity()) {
      return;
    }
    const data = formData(el);
    const url = String(data?.get("server_url") ?? "");
    setError(null);
    setResult(null);
    setBrowserPending(true);
    const { promise, cancel } = browserAuth(url);
    cancelAuth = cancel;
    try {
      const token = await promise;
      if (token === null) return; // user cancelled
      if (data?.get("copy") === "on") {
        setResult(`${syncSummary(await syncWithToken(url, token, setStep))}`);
      }
      await session.adoptToken(url, token);
    } catch (err) {
      setError(errorMessage(err, "Browser sign-in failed"));
    } finally {
      setBrowserPending(false);
      cancelAuth = null;
      setStep("");
    }
  }

  function stopBrowserAuth() {
    cancelAuth?.();
    setBrowserPending(false);
  }

  // Add a second server WITHOUT leaving the current one: sign in there,
  // stash the bearer, and its projects join the rail's foreign group.
  const [adding, setAdding] = createSignal(false);
  const [addPending, setAddPending] = createSignal(false);
  async function onAddServer(e: SubmitEvent) {
    e.preventDefault();
    const data = new FormData(e.currentTarget as HTMLFormElement);
    const url = String(data.get("server_url") ?? "").replace(/\/+$/, "");
    setError(null);
    setAddPending(true);
    try {
      const res = await createClient(url).login({
        email: String(data.get("email") ?? ""),
        password: String(data.get("password") ?? ""),
      });
      if (!res.token) throw new Error("server did not return a token");
      rememberConnection(url, res.token);
      (e.currentTarget as HTMLFormElement).reset();
      setAdding(false);
    } catch (err) {
      setError(errorMessage(err, "Could not reach or sign in"));
    } finally {
      setAddPending(false);
    }
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
        <Show when={!net.isLocal() && altPaths()}>
          <button
            type="button"
            class="rounded-md border border-border px-2.5 py-1 text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg"
            onClick={() => setSwitching((v) => !v)}
          >
            Different server
          </button>
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

      <Show when={!net.isLocal() && switching()}>
        <form onSubmit={onConnect} class="flex max-w-sm flex-col gap-3 border-t border-border pt-4">
          <p class="text-[12.5px] text-muted">
            Sign in on a different Relay server — you'll leave this one.
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

      <Show when={net.isLocal()}>
        <form onSubmit={onConnect} class="flex max-w-sm flex-col gap-3">
          <p class="text-[12.5px] text-muted">
            Connect to a Relay server — you'll sign in there and leave local
            mode. Tick "copy data" to bring this device's workspace with you;
            it stays here either way.
          </p>
          <input
            type="url"
            name="server_url"
            required
            placeholder="https://relay.example.com"
            aria-label="Server URL"
            value={remembered()}
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
          <label class="flex items-center gap-2 text-[12.5px] text-muted">
            <input type="checkbox" name="copy" checked />
            Copy this device's data to the server
          </label>
          <Show when={step()}>
            <p class="text-[12px] text-muted">{step()}…</p>
          </Show>
          <div class="flex items-center gap-3">
            <SubmitButton pending={connectPending()}>
              {connectPending() ? "Connecting..." : "Connect & sign in"}
            </SubmitButton>
            <button
              type="button"
              onClick={onSyncOnly}
              disabled={syncPending() || connectPending() || browserPending()}
              class="text-[12px] text-muted underline-offset-2 hover:text-fg hover:underline disabled:opacity-60"
            >
              {syncPending() ? "Syncing..." : "Copy data without connecting"}
            </button>
          </div>
          <Show when={isDesktop()}>
            <div class="border-t border-border pt-3">
              <Show
                when={!browserPending()}
                fallback={
                  <div class="flex items-center gap-2.5 rounded-md border border-border bg-surface px-3 py-2.5">
                    <Spinner class="h-3.5 w-3.5" />
                    <p class="flex-1 text-[12.5px] text-muted">
                      Waiting for approval in your browser…
                    </p>
                    <button
                      type="button"
                      class="text-[12px] text-muted underline-offset-2 hover:text-fg hover:underline"
                      onClick={stopBrowserAuth}
                    >
                      cancel
                    </button>
                  </div>
                }
              >
                <button
                  type="button"
                  onClick={onBrowserAuth}
                  disabled={syncPending() || connectPending()}
                  class="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-60"
                >
                  Sign in via browser — approve there, no password needed
                </button>
              </Show>
            </div>
          </Show>
        </form>
      </Show>

      <Show when={!net.isLocal()}>
        <div class="flex max-w-md flex-col gap-2 border-t border-border pt-4">
          <div class="flex items-center justify-between">
            <span class="text-[12.5px] font-medium">Saved servers</span>
            <button
              type="button"
              onClick={() => setAdding((v) => !v)}
              class="rounded-md border border-border px-2.5 py-1 text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg"
            >
              Add server
            </button>
          </div>
          <p class="text-[12px] text-muted">
            Sign in to additional Relay servers — their projects appear in
            the rail under their own label, and clicking one hops over.
          </p>
          <For
            each={[...connections()].sort(
              (a, b) =>
                Number(b.url === net.serverUrl()) -
                Number(a.url === net.serverUrl()),
            )}
          >
            {(c) => {
              const active = () => c.url === net.serverUrl();
              const hue = connectionHue(c.url);
              return (
                <div
                  class={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 ${
                    active()
                      ? "border-accent/30 bg-accent/5"
                      : "border-border bg-surface"
                  }`}
                >
                  <span
                    class="h-2 w-2 shrink-0 rounded-full"
                    style={{
                      "background-color": active()
                        ? "var(--color-emerald-500, #10b981)"
                        : `hsl(${hue} 65% 55%)`,
                    }}
                  />
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-[12.5px] font-medium">{c.label}</p>
                    <p class="truncate text-[11px] text-muted">{c.url}</p>
                  </div>
                  <Show
                    when={active()}
                    fallback={
                      <>
                        <button
                          type="button"
                          onClick={() => activateConnection(c, "/app")}
                          class="rounded-md border border-border px-2 py-0.5 text-[11.5px] text-muted transition-colors hover:bg-hover hover:text-fg"
                        >
                          Switch
                        </button>
                        <Tip
                          text="Forget server"
                          hint="Remove this server from the list — sign-in required to reconnect"
                        >
                          <button
                            type="button"
                            aria-label={`Forget ${c.label}`}
                            onClick={() => forgetConnection(c.id)}
                            class="rounded p-1 text-muted transition-colors hover:text-red-500"
                          >
                            <TrashIcon class="h-3.5 w-3.5" />
                          </button>
                        </Tip>
                      </>
                    }
                  >
                    <span class="rounded border border-accent/40 bg-accent-soft px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-accent-ink">
                      active
                    </span>
                  </Show>
                </div>
              );
            }}
          </For>
          <Show when={connections().length === 0}>
            <p class="text-[12px] text-muted/70">
              No saved servers — signing in on another origin saves it here.
            </p>
          </Show>
          <Show when={adding()}>
            <form onSubmit={onAddServer} class="flex flex-col gap-2 pt-1">
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
                autocomplete="off"
                placeholder="Password"
                aria-label="Account password"
                class={inputClass}
              />
              <div>
                <SubmitButton pending={addPending()}>
                  {addPending() ? "Signing in…" : "Save connection"}
                </SubmitButton>
              </div>
            </form>
          </Show>
        </div>
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

      <Show when={isDesktop()}>
        <Section title="Desktop">
          <DesktopSection />
        </Section>
      </Show>

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
          <label class="relative cursor-pointer rounded-md border border-border bg-surface px-2.5 py-1 text-[12px] hover:bg-hover">
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
              <Tip text="Download avatar">
                <a
                  href={url().startsWith("blob:") ? url() : mediaURL(`${url()}?download=1`)}
                  download="avatar"
                  aria-label="Download avatar"
                  class="rounded-md border border-border bg-surface p-1.5 text-muted hover:bg-hover hover:text-fg"
                >
                  <DownloadIcon class="h-3.5 w-3.5" />
                </a>
              </Tip>
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
          <NameColorRow />
        </Show>
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
                    <Tip text="Download icon">
                      <a
                        href={url().startsWith("blob:") ? url() : mediaURL(`${url()}?download=1`)}
                        download="workspace-icon"
                        aria-label="Download workspace icon"
                        class="rounded-md border border-border bg-surface p-1.5 text-muted hover:bg-hover hover:text-fg"
                      >
                        <DownloadIcon class="h-3.5 w-3.5" />
                      </a>
                    </Tip>
                  )}
                </Show>
                <Show when={canInvite()}>
                  <label class="relative cursor-pointer rounded-md border border-border bg-surface px-2.5 py-1 text-[12px] hover:bg-hover">
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
