import type { Channel, Project } from "@relay/api-client";
import { A, useLocation, useNavigate, useParams } from "@solidjs/router";
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
import { mediaURL } from "../lib/net";
import {
  checkForUpdates,
  loadServerVersion,
  parseTag,
  RELEASES_PAGE,
  setAutoUpdate,
  updateAvailable,
  useAutoUpdate,
  useUpdates,
  useVersion,
} from "../lib/updates";
import { subscribe } from "../lib/events";
import { deriveKey, initials } from "../lib/text";
import { useNav } from "../stores/nav";
import { useProjects } from "../stores/projects";
import { useSession } from "../stores/session";
import { activeWorkspace, setActiveWorkspace } from "../stores/workspace";
import {
  refreshUnread,
  usePendingReviews,
  useUnread,
  useUnreadConversations,
} from "../stores/unread";
import {
  activateConnection,
  connectionHue,
  foreignConnections,
  foreignProjects,
} from "../lib/connections";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  InboxIcon,
  LockIcon,
  PlusIcon,
  SettingsIcon,
} from "./icons";
import { RepoPicker } from "./RepoPicker";
import { FormError, inputClass, SubmitButton, Tip } from "./ui";

const navClass =
  "flex items-center gap-2 rounded-md px-2 py-2 text-[14px] text-muted transition-colors hover:bg-hover hover:text-fg sm:py-1.5 sm:text-[13px]";

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
  const location = useLocation();
  const n = () => unread()[props.project.id] ?? 0;
  const pending = () => pendingReviews()[props.project.id] ?? 0;
  // Channels nest under the project Discord-style. The viewed project is
  // always open; others expand on demand so the rail stays quiet.
  const active = () =>
    location.pathname.startsWith(`/app/p/${props.project.id}`);
  const [open, setOpen] = createSignal(false);
  return (
    <div>
      <div class="flex items-center">
        <button
          type="button"
          aria-label={open() || active() ? "Hide channels" : "Show channels"}
          aria-expanded={open() || active()}
          onClick={() => setOpen((v) => !v)}
          class="hidden shrink-0 rounded p-0.5 text-faint transition-colors hover:text-fg sm:block"
        >
          <ChevronDownIcon
            class={`h-3 w-3 transition-transform ${open() || active() ? "" : "-rotate-90"}`}
          />
        </button>
        <div class="min-w-0 flex-1">
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
        </div>
      </div>
      <Show when={open() || active()}>
        <ChannelList project={props.project} />
      </Show>
    </div>
  );
}

// ChannelList: the project's persistent side channels nested under its rail
// row, plus an inline create field. Refetches on channel.* SSE frames.
function ChannelList(props: { project: Project }) {
  const { unreadConversations } = useUnreadConversations();
  const navigate = useNavigate();
  const params = useParams<{ channelId?: string }>();
  const [channels, { refetch }] = createResource(
    () => props.project.id,
    (id) => api.listChannels(id).then((r) => r.channels),
  );
  const [adding, setAdding] = createSignal(false);
  const [name, setName] = createSignal("");
  const [error, setError] = createSignal("");
  const unsub = subscribe((e) => {
    if (e.project_id === props.project.id && e.type.startsWith("channel.")) {
      refetch();
    }
  });
  onCleanup(unsub);

  const unreadFor = (id: string) =>
    unreadConversations().find((c) => c.conversation_id === id)?.unread ?? 0;

  async function add(e: SubmitEvent) {
    e.preventDefault();
    const n = name().trim();
    if (!n) return;
    try {
      const res = await api.createChannel(props.project.id, n);
      setName("");
      setAdding(false);
      setError("");
      refetch();
      navigate(`/app/p/${props.project.id}/c/${res.channel.id}`);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not create channel",
      );
    }
  }

  return (
    <div class="ml-4 flex flex-col gap-0.5 border-l border-border pl-1.5">
      <For each={channels.latest}>
        {(ch: Channel) => (
          <A
            href={`/app/p/${props.project.id}/c/${ch.id}`}
            class={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] transition-colors hover:bg-hover ${
              params.channelId === ch.id
                ? "bg-hover text-fg"
                : "text-muted hover:text-fg"
            }`}
          >
            <span class="text-faint">#</span>
            <span class="min-w-0 flex-1 truncate">{ch.name}</span>
            <Show when={ch.agents_blocked}>
              <Tip
                text="Agents blocked"
                hint="Agents can't see or post in this channel"
                class="shrink-0"
              >
                <LockIcon class="h-3 w-3 shrink-0 text-faint" />
              </Tip>
            </Show>
            <Show when={unreadFor(ch.id) > 0}>
              <span class="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium leading-none text-white">
                {unreadFor(ch.id)}
              </span>
            </Show>
          </A>
        )}
      </For>
      <Show
        when={adding()}
        fallback={
          <button
            type="button"
            onClick={() => setAdding(true)}
            class="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-faint transition-colors hover:bg-hover hover:text-fg"
          >
            <PlusIcon class="h-3 w-3" />
            New channel
          </button>
        }
      >
        <form onSubmit={add} class="px-2 py-1">
          <input
            ref={(el) => queueMicrotask(() => el.focus())}
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setAdding(false);
                setName("");
              }
            }}
            placeholder="channel-name"
            maxLength={60}
            class={inputClass + " h-6 px-1.5 text-[12px]"}
          />
          <FormError message={error()} />
        </form>
      </Show>
    </div>
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
  const active = activeWorkspace(session.workspaces);
  const [repos] = createResource(
    () => active()?.id,
    (ws) => api.listAvailableRepos(ws).catch(() => null),
  );
  const repoList = () => repos()?.repos ?? [];

  async function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    const workspace = active();
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
  const session = useSession();
  const { unread } = useUnread();
  const { pendingReviews } = usePendingReviews();
  const active = activeWorkspace(session.workspaces);
  const list = () =>
    projects
      .sorted()
      .filter((p) => !active() || p.workspace_id === active()!.id);
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
  const active = activeWorkspace(session.workspaces);
  // The rail shows one workspace at a time — workspaces are separate
  // namespaces, so switching swaps the whole project list.
  const list = () =>
    projects
      .sorted()
      .filter((p) => !active() || p.workspace_id === active()!.id);
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
      <WorkspaceSwitcher />

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

        <div class="flex flex-col gap-0.5">
          <For each={list()}>
            {(p) => <ProjectRow project={p} />}
          </For>
        </div>

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

// Workspace switcher: the rail header shows the active workspace and opens
// a dropdown with every workspace plus an inline "new workspace" form.
// Switching is client-side only — the project list filters to the pick.
function WorkspaceSwitcher() {
  const session = useSession();
  const active = activeWorkspace(session.workspaces);
  const [open, setOpen] = createSignal(false);
  const [creatingWs, setCreatingWs] = createSignal(false);
  const [wsName, setWsName] = createSignal("");
  const [pending, setPending] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  let rootEl: HTMLDivElement | undefined;

  createEffect(() => {
    if (!open()) return;
    const onDown = (e: PointerEvent) => {
      if (rootEl && !rootEl.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    });
  });

  async function createWs(e: SubmitEvent) {
    e.preventDefault();
    const name = wsName().trim();
    if (!name) return;
    setErr(null);
    setPending(true);
    try {
      const ws = await api.createWorkspace({ name });
      await session.refresh();
      setActiveWorkspace(ws.id);
      setWsName("");
      setCreatingWs(false);
      setOpen(false);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Could not create workspace");
    } finally {
      setPending(false);
    }
  }

  return (
    <Show when={active()}>
      {(ws) => (
        <div class="relative border-b border-border" ref={(el) => (rootEl = el)}>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open()}
            aria-label="Switch workspace"
            class="flex w-full items-center gap-2 px-4 py-2.5 pr-8 text-left transition-colors hover:bg-hover"
          >
            <Show when={ws().avatar_url}>
              {(url) => (
                <img
                  src={mediaURL(url())}
                  alt=""
                  class="h-4.5 w-4.5 shrink-0 rounded-md object-cover"
                />
              )}
            </Show>
            <span class="min-w-0 flex-1 truncate text-[13px] font-medium">
              {ws().name}
            </span>
            <Show when={net.isLocal()}>
              <span class="shrink-0 rounded border border-border px-1 py-px font-mono text-[9.5px] uppercase tracking-wide text-muted">
                local
              </span>
            </Show>
            <ChevronDownIcon class="h-3 w-3 shrink-0 text-faint" />
          </button>
          <Show when={open()}>
            <div class="absolute left-2 right-2 top-full z-40 mt-1 overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-xl">
              <For each={session.workspaces()}>
                {(w) => (
                  <button
                    type="button"
                    onClick={() => {
                      setActiveWorkspace(w.id);
                      setOpen(false);
                    }}
                    class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-hover"
                  >
                    <Show when={w.avatar_url}>
                      {(url) => (
                        <img
                          src={mediaURL(url())}
                          alt=""
                          class="h-4 w-4 shrink-0 rounded object-cover"
                        />
                      )}
                    </Show>
                    <span
                      class={`min-w-0 flex-1 truncate ${w.id === ws().id ? "font-medium text-fg" : "text-muted"}`}
                    >
                      {w.name}
                    </span>
                    <Show when={w.id === ws().id}>
                      <CheckIcon class="h-3.5 w-3.5 shrink-0 text-accent" />
                    </Show>
                  </button>
                )}
              </For>
              <div class="mt-1 border-t border-border pt-1">
                <Show
                  when={creatingWs()}
                  fallback={
                    <button
                      type="button"
                      onClick={() => setCreatingWs(true)}
                      class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg"
                    >
                      <PlusIcon class="h-3.5 w-3.5" />
                      New workspace
                    </button>
                  }
                >
                  <form onSubmit={createWs} class="flex flex-col gap-1.5 p-1.5">
                    <input
                      ref={(el) => el.focus()}
                      type="text"
                      required
                      value={wsName()}
                      onInput={(e) => setWsName(e.currentTarget.value)}
                      placeholder="Workspace name"
                      aria-label="Workspace name"
                      class={inputClass}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setCreatingWs(false);
                      }}
                    />
                    <FormError message={err()} />
                    <div class="flex gap-1.5">
                      <SubmitButton pending={pending()} class="h-7 px-2.5">
                        {pending() ? "Creating..." : "Create"}
                      </SubmitButton>
                      <button
                        type="button"
                        onClick={() => setCreatingWs(false)}
                        class="inline-flex h-7 items-center justify-center rounded-md px-2.5 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                </Show>
              </div>
            </div>
          </Show>
        </div>
      )}
    </Show>
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
  const autoUpdate = useAutoUpdate();
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
      <Show when={canSelfUpdate()}>
        <label class="flex cursor-pointer items-center gap-1.5 self-start text-faint transition-colors hover:text-fg">
          <input
            type="checkbox"
            checked={autoUpdate()}
            onChange={(e) => setAutoUpdate(e.currentTarget.checked)}
            class="h-3 w-3 accent-accent"
          />
          auto-install on launch
        </label>
      </Show>
    </div>
  );
}
