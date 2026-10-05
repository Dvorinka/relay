import type { Project } from "@relay/api-client";
import { A, useNavigate } from "@solidjs/router";
import {
  createEffect,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type ParentProps,
} from "solid-js";
import { api } from "../lib/api";
import { mediaURL, net } from "../lib/net";
import {
  checkForUpdates,
  loadServerVersion,
  parseTag,
  RELEASES_PAGE,
  updateAvailable,
  useUpdates,
  useVersion,
} from "../lib/updates";
import { subscribe } from "../lib/events";
import { deriveKey, initials } from "../lib/text";
import { useNav } from "../stores/nav";
import { useProjects } from "../stores/projects";
import { useSession } from "../stores/session";
import {
  refreshUnread,
  usePendingReviews,
  useUnread,
} from "../stores/unread";
import {
  activateConnection,
  connectionHue,
  foreignConnections,
  foreignProjects,
} from "../lib/connections";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  InboxIcon,
  PlusIcon,
  SettingsIcon,
} from "./icons";
import { RepoPicker } from "./RepoPicker";
import { FormError, inputClass, SubmitButton, Tip } from "./ui";

const navClass =
  "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg";

function NavItem(props: ParentProps<{ href: string }>) {
  const { closeNav } = useNav();
  return (
    <A
      href={props.href}
      class={navClass}
      activeClass="bg-hover text-fg"
      onClick={closeNav}
    >
      {props.children}
    </A>
  );
}

function ProjectRow(props: { project: Project }) {
  const { unread } = useUnread();
  const { pendingReviews } = usePendingReviews();
  const n = () => unread()[props.project.id] ?? 0;
  const pending = () => pendingReviews()[props.project.id] ?? 0;
  return (
    <NavItem href={`/app/p/${props.project.id}`}>
      <span
        class="h-2 w-2 shrink-0 rounded-full"
        style={{
          "background-color": props.project.color ?? "var(--accent)",
        }}
      />
      <Show
        when={props.project.icon_url}
        fallback={
          <span class="shrink-0 text-[11px] font-medium text-muted">
            {initials(props.project.name)}
          </span>
        }
      >
        {(url) => (
          <img
            src={mediaURL(url())}
            alt=""
            class="h-4.5 w-4.5 shrink-0 rounded-md object-cover"
          />
        )}
      </Show>
      <span class="truncate">{props.project.name}</span>
      <Show when={pending() > 0}>
        <Tip
          text="Pending reviews"
          hint={`${pending()} agent review(s) awaiting a verdict`}
          class="ml-auto"
        >
          <span class="ml-auto rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium leading-none text-amber-600 dark:text-amber-400">
            {pending()}
          </span>
        </Tip>
      </Show>
      <Show when={n() > 0}>
        <span
          class={`rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium leading-none text-white ${pending() > 0 ? "" : "ml-auto"}`}
        >
          {n() > 99 ? "99+" : n()}
        </span>
      </Show>
    </NavItem>
  );
}

function NewProjectForm(props: { onDone: () => void }) {
  const session = useSession();
  const projects = useProjects();
  const navigate = useNavigate();
  const [name, setName] = createSignal("");
  const [key, setKey] = createSignal("");
  const [keyEdited, setKeyEdited] = createSignal(false);
  const [nameEdited, setNameEdited] = createSignal(false);
  const [desc, setDesc] = createSignal("");
  const [descEdited, setDescEdited] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);
  const [repo, setRepo] = createSignal("");
  // null = GitHub not connected (API 400s); resolved list = app installed
  const [repos] = createResource(
    () => session.workspaces()[0]?.id,
    (ws) => api.listAvailableRepos(ws).catch(() => null),
  );
  const repoList = () => repos()?.repos ?? [];

  async function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    const workspace = session.workspaces()[0];
    if (!workspace) {
      setError("No workspace available");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const project = await projects.create({
        workspace_id: workspace.id,
        name: name().trim(),
        key: key().trim(),
        ...(desc().trim() ? { description: desc().trim() } : {}),
      });
      const selected = repoList().find((r) => r.full_name === repo());
      if (selected) {
        // best effort — the link can always be redone from the project's
        // Development tab; don't lose the created project over it
        await api
          .linkRepo(project.id, {
            installation_id: selected.installation_id,
            owner: selected.owner,
            name: selected.name,
            default_branch: selected.default_branch,
          })
          .then(() => api.adoptGithubIcon(project.id).catch(() => {}))
          .catch(() => {});
      }
      props.onDone();
      navigate(`/app/p/${project.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create project");
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      class="flex flex-col gap-1.5 px-2 pb-2"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          props.onDone();
        }
      }}
    >
      <input
        ref={(el) => el.focus()}
        type="text"
        placeholder="Project name"
        aria-label="Project name"
        required
        value={name()}
        onInput={(e) => {
          setName(e.currentTarget.value);
          setNameEdited(true);
          if (!keyEdited()) {
            setKey(deriveKey(e.currentTarget.value));
          }
        }}
        class={inputClass}
      />
      <input
        type="text"
        placeholder="Description (optional)"
        aria-label="Project description"
        value={desc()}
        onInput={(e) => {
          setDesc(e.currentTarget.value);
          setDescEdited(true);
        }}
        class={inputClass}
      />
      <input
        type="text"
        placeholder="KEY"
        aria-label="Project key"
        required
        pattern="[A-Z0-9]{2,6}"
        maxlength={6}
        title="2-6 uppercase letters or digits"
        value={key()}
        onInput={(e) => {
          setKeyEdited(true);
          setKey(e.currentTarget.value.toUpperCase());
        }}
        class={`${inputClass} font-mono uppercase`}
      />
      <Show when={repoList().length > 0}>
        <RepoPicker
          repos={repoList()}
          value={repo()}
          placeholder="Link GitHub repo (optional)"
          onPick={(r) => {
            setRepo(r?.full_name ?? "");
            if (r) {
              // Prefill from GitHub metadata — only while the user hasn't
              // typed their own, so a re-pick still updates the fields.
              if (!nameEdited()) {
                setName(r.name);
                if (!keyEdited()) setKey(deriveKey(r.name));
              }
              if (!descEdited() && r.description) setDesc(r.description);
            }
          }}
        />
      </Show>
      <Show when={repos() === null}>
        <p class="px-0.5 text-[11.5px] text-muted">
          <A href="/app/settings" class="text-accent hover:underline">
            Connect GitHub
          </A>{" "}
          in Settings to link a repository.
        </p>
      </Show>
      <Show when={repos() !== null && repos() !== undefined && repoList().length === 0}>
        <p class="px-0.5 text-[11.5px] text-muted">
          GitHub connected — install the app on repositories from{" "}
          <A href="/app/settings" class="text-accent hover:underline">
            Settings
          </A>
          .
        </p>
      </Show>
      <FormError message={error()} />
      <div class="flex gap-1.5">
        <SubmitButton pending={pending()} class="h-7 px-2.5">
          {pending() ? "Creating..." : "Create"}
        </SubmitButton>
        <button
          type="button"
          onClick={props.onDone}
          class="inline-flex h-7 items-center justify-center rounded-md px-2.5 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// Collapsed icon strip: project icons carry unread/review badges, matching
// the "icons with numbers" minimized look. Clicks navigate as usual.
function CollapsedRail(props: { onExpand: () => void }) {
  const projects = useProjects();
  const { unread } = useUnread();
  const { pendingReviews } = usePendingReviews();
  const list = () => projects.projects() ?? [];
  const totalUnread = () =>
    Object.values(unread()).reduce((s, n) => s + n, 0);
  return (
    <div class="flex w-14 flex-col items-center gap-1 py-2">
      <Tip text="Expand sidebar" hint="Show project names and navigation">
        <button
          type="button"
          onClick={props.onExpand}
          aria-label="Expand sidebar"
          class="mb-1 flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <ChevronRightIcon class="h-4 w-4" />
        </button>
      </Tip>
      <Tip text="Inbox" hint="">
        <A
          href="/app/inbox"
          aria-label="Inbox"
          class="relative flex h-9 w-9 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <InboxIcon class="h-4 w-4" />
          <Show when={totalUnread() > 0}>
            <span class="absolute -bottom-0.5 -right-0.5 rounded-full bg-accent px-1 font-mono text-[8.5px] font-bold leading-3 text-white">
              {totalUnread() > 99 ? "99+" : totalUnread()}
            </span>
          </Show>
        </A>
      </Tip>
      <For each={list()}>
        {(p) => {
          const n = () => unread()[p.id] ?? 0;
          const pending = () => pendingReviews()[p.id] ?? 0;
          return (
            <Tip text={p.name} hint="">
              <A
                href={`/app/p/${p.id}`}
                aria-label={p.name}
                class="relative flex h-9 w-9 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg"
              >
                <Show
                  when={p.icon_url}
                  fallback={
                    <span
                      class="flex h-6 w-6 items-center justify-center rounded-md text-[9px] font-semibold uppercase text-white"
                      style={{
                        "background-color": p.color ?? "var(--accent)",
                      }}
                    >
                      {initials(p.name)}
                    </span>
                  }
                >
                  {(url) => (
                    <img
                      src={mediaURL(url())}
                      alt=""
                      class="h-6 w-6 rounded-md object-cover"
                    />
                  )}
                </Show>
                <Show when={pending() > 0}>
                  <span class="absolute -right-0.5 -top-0.5 rounded-full bg-amber-500 px-1 font-mono text-[8.5px] font-bold leading-3 text-white">
                    {pending()}
                  </span>
                </Show>
                <Show when={n() > 0}>
                  <span class="absolute -bottom-0.5 -right-0.5 rounded-full bg-accent px-1 font-mono text-[8.5px] font-bold leading-3 text-white">
                    {n() > 99 ? "99+" : n()}
                  </span>
                </Show>
              </A>
            </Tip>
          );
        }}
      </For>
      <div class="mt-auto">
        <Tip text="Settings" hint="">
          <A
            href="/app/settings"
            aria-label="Settings"
            class="flex h-9 w-9 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <SettingsIcon class="h-4 w-4" />
          </A>
        </Tip>
      </div>
    </div>
  );
}

export function Rail() {
  const session = useSession();
  const projects = useProjects();
  const { navOpen, closeNav } = useNav();
  const [creating, setCreating] = createSignal(false);
  onMount(refreshUnread);
  const unsub = subscribe((e) => {
    if (e.type === "message.created") void refreshUnread();
    if (e.type === "review.created" || e.type === "review.responded") {
      void refreshUnread();
    }
  });
  onCleanup(unsub);
  createEffect(() => {
    if (!navOpen()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeNav();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });
  const list = () => projects.projects() ?? [];
  const { unread } = useUnread();
  const totalUnread = () =>
    Object.values(unread()).reduce((s, n) => s + n, 0);

  // Width + collapse persist; dragging the right edge resizes (left rail, so
  // dragging right grows it). The mobile drawer ignores both and stays w-64.
  const [railW, setRailW] = createSignal(
    Math.min(400, Math.max(160, Number(localStorage.getItem("relay.leftrail.w")) || 224)),
  );
  const [collapsed, setCollapsed] = createSignal(
    localStorage.getItem("relay.leftrail.collapsed") === "1",
  );
  function startDrag(e: PointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = railW();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      setRailW(Math.min(400, Math.max(160, startW + (ev.clientX - startX))));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      localStorage.setItem("relay.leftrail.w", String(railW()));
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  }
  function toggleCollapsed() {
    setCollapsed((v) => {
      localStorage.setItem("relay.leftrail.collapsed", v ? "0" : "1");
      return !v;
    });
  }

  return (
    <>
      <Show when={navOpen()}>
        <button
          type="button"
          aria-label="Close navigation"
          onClick={closeNav}
          class="fixed inset-0 z-30 bg-black/40 md:hidden"
        />
      </Show>
      <aside
        class={`relative flex shrink-0 flex-col border-r border-border bg-rail ${
          navOpen()
            ? "fixed inset-y-0 left-0 z-40 w-64 shadow-2xl"
            : "hidden md:flex"
        }`}
        style={
          navOpen()
            ? undefined
            : { width: collapsed() ? "3.5rem" : `${railW()}px` }
        }
      >
      <Show when={!collapsed() && !navOpen()}>
        <div
          class="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize transition-colors hover:bg-accent/40"
          onPointerDown={startDrag}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
        />
      </Show>
      <Show when={!collapsed() && !navOpen()}>
        <div class="absolute right-2 top-2.5 z-10">
          <Tip text="Collapse sidebar" hint="Shrink to icons — badges stay visible">
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label="Collapse sidebar"
              class="flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg"
            >
              <ChevronLeftIcon class="h-3.5 w-3.5" />
            </button>
          </Tip>
        </div>
      </Show>
      <Show
        when={!collapsed() || navOpen()}
        fallback={<CollapsedRail onExpand={toggleCollapsed} />}
      >
      <Show when={session.workspaces()[0]}>
        {(ws) => (
          <div class="border-b border-border px-4 py-2.5 pr-8">
            <p class="flex items-center gap-2 truncate text-[13px] font-medium">
              <Show when={ws().avatar_url}>
                {(url) => (
                  <img
                    src={mediaURL(url())}
                    alt=""
                    class="h-4.5 w-4.5 shrink-0 rounded-md object-cover"
                  />
                )}
              </Show>
              <span class="truncate">{ws().name}</span>
              <Show when={net.isLocal()}>
                <span class="shrink-0 rounded border border-border px-1 py-px font-mono text-[9.5px] uppercase tracking-wide text-muted">
                  local
                </span>
              </Show>
            </p>
          </div>
        )}
      </Show>

      <nav class="flex flex-col gap-0.5 p-2">
        <NavItem href="/app/inbox">
          <InboxIcon class="h-3.5 w-3.5" />
          Inbox
          <Show when={totalUnread() > 0}>
            <span class="ml-auto rounded-full bg-accent px-1.5 py-px font-mono text-[10px] font-semibold leading-4 text-white">
              {totalUnread() > 99 ? "99+" : totalUnread()}
            </span>
          </Show>
        </NavItem>
      </nav>

      <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div class="flex items-center justify-between px-2 pb-1 pt-3">
          <span class="text-[11px] font-medium uppercase tracking-wider text-muted">
            Projects
          </span>
          <button
            type="button"
            aria-label="New project"
            title="New project"
            onClick={() => setCreating((v) => !v)}
            class="rounded p-0.5 text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <PlusIcon class="h-3.5 w-3.5" />
          </button>
        </div>

        <Show when={creating()}>
          <NewProjectForm onDone={() => setCreating(false)} />
        </Show>

        <For each={session.workspaces()}>
          {(ws) => {
            const wsProjects = () =>
              list().filter((p) => p.workspace_id === ws.id);
            return (
              <Show when={wsProjects().length > 0}>
                <Show when={session.workspaces().length > 1}>
                  <div class="truncate px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted">
                    {ws.name}
                  </div>
                </Show>
                <div class="flex flex-col gap-0.5">
                  <For each={wsProjects()}>
                    {(p) => <ProjectRow project={p} />}
                  </For>
                </div>
              </Show>
            );
          }}
        </For>

        <Show when={list().length === 0 && !projects.loading()}>
          <p class="px-2 py-1.5 text-[13px] text-muted/60">No projects yet</p>
        </Show>

        <ForeignProjects />
      </div>

      <div class="mt-auto flex flex-col gap-0.5 border-t border-border p-2">
        <VersionFooter />
        <NavItem href="/app/settings">
          <SettingsIcon class="h-3.5 w-3.5" />
          Settings
        </NavItem>
      </div>
      </Show>
      </aside>
    </>
  );
}

// Other signed-in servers contribute their project lists under a labeled
// group; a click swaps the session onto that server (connections.ts).
function ForeignProjects() {
  const conns = foreignConnections;
  return (
    <For each={conns()}>
      {(c) => {
        const [remote] = createResource(() => c.id, () => foreignProjects(c));
        const hue = connectionHue(c.url);
        return (
          <Show when={(remote() ?? []).length > 0}>
            <div class="flex items-center gap-1.5 px-2 pb-1 pt-3">
              <span
                class="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ "background-color": `hsl(${hue} 65% 55%)` }}
              />
              <span class="truncate text-[11px] font-medium uppercase tracking-wider text-muted">
                {c.label}
              </span>
            </div>
            <div class="flex flex-col gap-0.5">
              <For each={remote() ?? []}>
                {(p) => (
                  <button
                    type="button"
                    title={`${p.name} — on ${c.label}`}
                    onClick={() =>
                      activateConnection(c, `/app/p/${p.id}`)
                    }
                    class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg"
                  >
                    <span
                      class="h-2 w-2 shrink-0 rounded-full"
                      style={{
                        "background-color": p.color ?? `hsl(${hue} 65% 55%)`,
                      }}
                    />
                    <span class="truncate">{p.name}</span>
                    <span
                      class="ml-auto shrink-0 rounded border px-1 py-px font-mono text-[9px] uppercase tracking-wide"
                      style={{
                        color: `hsl(${hue} 65% 55%)`,
                        "border-color": `hsl(${hue} 65% 55% / 0.4)`,
                      }}
                    >
                      {c.label}
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        );
      }}
    </For>
  );
}

// VersionFooter: build + server versions and a manual update check, sitting
// above Settings at the bottom of the rail.
function VersionFooter() {
  const { appVersion, serverVersion, clientVersion } = useVersion();
  const {
    latest,
    checking,
    checked,
    checkError,
    canSelfUpdate,
    installing,
    installError,
    installUpdate,
  } = useUpdates();
  onMount(() => {
    void loadServerVersion();
  });

  const versionLabel = () =>
    clientVersion().startsWith("v") ? clientVersion() : `v${clientVersion()}`;

  // Secondary line when a component carries a different *stamped* version —
  // "dev" means unstamped and conveys nothing, so it's filtered out.
  const versionMismatch = (): string | null => {
    if (appVersion !== "dev" && clientVersion() !== appVersion) {
      return `app ${appVersion}`;
    }
    const sv = serverVersion();
    if (sv && sv !== "dev" && sv !== clientVersion()) return `server ${sv}`;
    return null;
  };

  return (
    <div class="flex flex-col gap-1.5 px-2 py-1.5 text-[11px] leading-4 text-faint">
      <div class="flex flex-wrap items-center gap-x-1.5">
        <span class="rounded bg-hover px-1.5 py-px font-mono text-[10.5px] font-medium tracking-tight text-muted">
          {versionLabel()}
        </span>
        <Show when={versionMismatch()}>
          {(m) => <span class="truncate text-faint/80">{m()}</span>}
        </Show>
      </div>
      <Show
        when={!checked()}
        fallback={
          <Show
            when={!checkError()}
            fallback={<span class="text-faint/80">Update check failed</span>}
          >
            <Show
              when={updateAvailable()}
              fallback={
                // dev builds can't be compared — still offer the releases page
                // so downloads are reachable; release builds show "Up to date".
                <Show
                  when={parseTag(clientVersion()) === null}
                  fallback={
                    <span class="inline-flex items-center gap-1 text-faint/80">
                      <span class="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      Up to date
                    </span>
                  }
                >
                  <a
                    href={RELEASES_PAGE}
                    class="text-accent hover:underline"
                    target="_blank"
                    rel="noopener"
                  >
                    {latest()} — download
                  </a>
                </Show>
              }
            >
              <Show
                when={canSelfUpdate()}
                fallback={
                  <a
                    href={RELEASES_PAGE}
                    class="text-accent hover:underline"
                    target="_blank"
                    rel="noopener"
                  >
                    {latest()} available — download
                  </a>
                }
              >
                <button
                  type="button"
                  class="inline-flex items-center gap-1 rounded bg-accent/15 px-1.5 py-px font-medium text-accent transition-colors hover:bg-accent/25 disabled:opacity-60"
                  disabled={installing()}
                  onClick={() => void installUpdate()}
                >
                  {installing()
                    ? `Installing ${latest()}…`
                    : `${latest()} — install update`}
                </button>
              </Show>
              <Show when={installError()}>
                {(msg) => <span class="block text-red-500">{msg()}</span>}
              </Show>
            </Show>
          </Show>
        }
      >
        <button
          type="button"
          onClick={() => void checkForUpdates()}
          disabled={checking()}
          class="self-start text-faint transition-colors hover:text-fg disabled:opacity-60"
        >
          {checking() ? "Checking…" : "Check for updates"}
        </button>
      </Show>
    </div>
  );
}
