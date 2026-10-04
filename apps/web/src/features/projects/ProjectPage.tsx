import {
  ApiClientError,
  type AgentReview,
  type Issue,
  type Project,
  type SearchResults,
  type Todo,
} from "@relay/api-client";
import { A, useNavigate, useParams, useSearchParams } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { Avatar } from "@ark-ui/solid";
import {
  BriefsIcon,
  CheckIcon,
  DownloadIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  IssueIcon,
  PlusIcon,
  SettingsIcon,
  TrashIcon,
  XIcon,
} from "../../components/icons";
import {
  ColorField,
  FormError,
  ImageURLField,
  inputClass,
  Spinner,
  SubmitButton,
} from "../../components/ui";
import { api } from "../../lib/api";
import { mediaURL, net } from "../../lib/net";
import { subscribe } from "../../lib/events";
import { initials } from "../../lib/text";
import { timeAgo } from "../../lib/time";
import { useProjects } from "../../stores/projects";
import { useSession } from "../../stores/session";
import { RepoPicker } from "../../components/RepoPicker";
import { Conversation } from "../conversations/Conversation";
import { DevelopmentPanel, markGitHub } from "../github/GitHub";
import { GitLog } from "../github/GitLog";
import { PullRequestList } from "../github/PullRequestList";
import { IssueList } from "../issues/IssueList";
import { isClosed, statusDefs, StatusDot } from "../issues/meta";
import { Reviews } from "../reviews/Reviews";
import { WebhooksSection } from "../webhooks/Webhooks";
import { BriefsPanel } from "../briefs/BriefsPanel";

type View =
  | "issues"
  | "pulls"
  | "reviews"
  | "development"
  | "commits"
  | "settings";

const VIEWS: { id: View; label: string }[] = [
  { id: "issues", label: "Issues" },
  { id: "pulls", label: "Pull requests" },
  { id: "reviews", label: "Reviews" },
  { id: "development", label: "Development" },
  { id: "commits", label: "Commits" },
  { id: "settings", label: "Project settings" },
];

function BoardIcon(props: { class?: string }) {
  return (
    <svg
      class={props.class}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect x="3" y="3" width="5" height="18" rx="1.5" />
      <rect x="10" y="3" width="5" height="12" rx="1.5" />
      <rect x="17" y="3" width="5" height="8" rx="1.5" />
    </svg>
  );
}

function HeadButton(props: {
  title: string;
  active?: boolean;
  onClick: () => void;
  children: any;
}) {
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      aria-pressed={props.active}
      onClick={props.onClick}
      class={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
        props.active
          ? "bg-accent/10 text-accent"
          : "text-muted hover:bg-hover hover:text-fg"
      }`}
    >
      {props.children}
    </button>
  );
}

function RailSection(props: {
  label: string;
  count?: number;
  children: any;
}) {
  return (
    <section class="px-4 pt-5">
      <h3 class="mb-2 flex items-center text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted/80">
        {props.label}
        <Show when={props.count !== undefined}>
          <span class="ml-auto rounded-md bg-surface px-1.5 py-0.5 text-[10px] font-medium text-muted">
            {props.count}
          </span>
        </Show>
      </h3>
      {props.children}
    </section>
  );
}

// TodoList: the project's shared work list in the right rail — add, check
// off, delete. Agents write to the same list via the todo_* MCP tools.
function TodoList(props: {
  projectId: string;
  todos: Todo[];
  onChanged: () => void;
}) {
  const [text, setText] = createSignal("");
  const [err, setErr] = createSignal("");
  // in_progress floats to the top — that's what an agent is doing right now.
  const order = (t: Todo) =>
    t.status === "in_progress" ? 0 : t.done ? 2 : 1;
  const sorted = () =>
    [...props.todos].sort((a, b) => order(a) - order(b));
  const working = () =>
    props.todos.filter((t) => t.status === "in_progress");

  async function add(e: SubmitEvent) {
    e.preventDefault();
    const content = text().trim();
    if (!content) return;
    setErr("");
    try {
      await api.createTodo(props.projectId, content);
      setText("");
      props.onChanged();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "could not add todo");
    }
  }

  async function toggle(t: Todo) {
    try {
      await api.updateTodo(t.id, {
        done: !t.done,
        status: t.done ? "todo" : "done",
      });
      props.onChanged();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "could not update todo");
    }
  }

  async function remove(t: Todo) {
    try {
      await api.deleteTodo(t.id);
      props.onChanged();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "could not delete todo");
    }
  }

  return (
    <div class="flex flex-col gap-1">
      <Show when={working().length > 0}>
        <p class="mb-0.5 flex items-center gap-1.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
          <span class="relative flex h-2 w-2">
            <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500 opacity-60" />
            <span class="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
          </span>
          {working().map((t) => t.agent?.name ?? "Someone").join(", ")}{" "}
          working — {working().length} active
        </p>
      </Show>
      <form onSubmit={add} class="flex gap-1.5">
        <input
          type="text"
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          placeholder="Add a todo…"
          aria-label="New todo"
          class={`${inputClass} !py-1 text-[12.5px]`}
        />
        <button
          type="submit"
          disabled={!text().trim()}
          aria-label="Add todo"
          class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40"
        >
          <PlusIcon class="h-3.5 w-3.5" />
        </button>
      </form>
      <For
        each={sorted()}
        fallback={<p class="text-[12px] text-muted">Nothing tracked yet.</p>}
      >
        {(t) => (
          <div class="group flex items-start gap-2 rounded-md px-1 py-1 transition-colors hover:bg-hover">
            <button
              type="button"
              role="checkbox"
              aria-checked={t.done}
              aria-label={t.done ? "Mark not done" : "Mark done"}
              onClick={() => void toggle(t)}
              class={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition-colors ${
                t.done
                  ? "border-accent bg-accent text-white"
                  : t.status === "in_progress"
                    ? "border-amber-500 text-transparent"
                    : "border-muted/60 text-transparent hover:border-accent"
              }`}
            >
              <CheckIcon class="h-2.5 w-2.5" />
            </button>
            <span
              class={`min-w-0 flex-1 text-[12.5px] leading-snug ${
                t.done
                  ? "text-muted line-through"
                  : t.status === "in_progress"
                    ? "font-medium"
                    : ""
              }`}
            >
              {t.content}
              <Show when={t.status === "in_progress"}>
                <span class="ml-1 text-[10.5px] font-medium text-amber-600 dark:text-amber-400">
                  in progress
                </span>
              </Show>
              <Show when={t.agent}>
                <span class="ml-1 text-[10.5px] text-muted">
                  · {t.agent!.name}
                </span>
              </Show>
            </span>
            <button
              type="button"
              onClick={() => void remove(t)}
              aria-label="Delete todo"
              class="invisible shrink-0 rounded p-0.5 text-muted transition-colors hover:text-red-500 group-hover:visible"
            >
              <TrashIcon class="h-3 w-3" />
            </button>
          </div>
        )}
      </For>
      <FormError message={err() || null} />
    </div>
  );
}

// Status-colored left edge, matching design/design.html's issue cards.
const ISSUE_EDGE: Record<string, string> = {
  backlog: "border-l-faint",
  todo: "border-l-blue-500",
  in_progress: "border-l-amber-500",
  review: "border-l-violet-500",
};

function MiniIssue(props: { project: Project; issue: Issue }) {
  return (
    <A
      href={`/app/p/${props.project.id}/i/${props.issue.id}`}
      class={`block rounded-lg border border-l-2 border-border bg-surface px-3 py-2 transition-colors hover:border-muted/60 ${
        ISSUE_EDGE[props.issue.status] ?? "border-l-border"
      }`}
    >
      <div class="flex items-baseline gap-2">
        <span class="font-mono text-[10.5px] font-medium text-accent">
          {props.project.key}-{props.issue.number}
        </span>
        <span class="min-w-0 flex-1 truncate text-[12.5px] font-medium">
          {props.issue.title}
        </span>
      </div>
      <div class="mt-1 flex items-center gap-2 text-[11px] text-muted">
        <StatusDot
          status={props.issue.status}
          defs={statusDefs(props.project)}
          class="h-1.5 w-1.5"
        />
        <Show when={props.issue.assignee}>
          {(a) => <span class="truncate">{a().name}</span>}
        </Show>
        <span class="ml-auto shrink-0">{timeAgo(props.issue.created_at)}</span>
      </div>
    </A>
  );
}

function MiniReview(props: { review: AgentReview; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onOpen}
      class="block w-full rounded-lg border border-l-2 border-border border-l-violet-500 bg-surface px-3 py-2 text-left transition-colors hover:border-muted/60"
    >
      <div class="flex items-baseline gap-2">
        <span class="font-mono text-[10.5px] font-medium text-violet-500">
          REV
        </span>
        <span class="min-w-0 flex-1 truncate text-[12.5px] font-medium">
          {props.review.title}
        </span>
      </div>
      <div class="mt-1 flex items-center gap-2 text-[11px] text-muted">
        <span class="truncate">{props.review.agent.name ?? "agent"}</span>
        <span class="ml-auto shrink-0">
          {props.review.created_at ? timeAgo(props.review.created_at) : ""}
        </span>
      </div>
    </button>
  );
}

// Discord-style rail search: field pinned above the issues list, results
// scoped to this project swap in while typing; Esc/✕ returns to context.
function RailSearch(props: { projectId: string }) {
  const [q, setQ] = createSignal("");
  const [results, setResults] = createSignal<SearchResults | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));

  function onInput(v: string) {
    setQ(v);
    clearTimeout(timer);
    const needle = v.trim();
    if (needle.length < 2) {
      setResults(null);
      return;
    }
    timer = setTimeout(async () => {
      try {
        const r = await api.search(needle);
        const pid = props.projectId;
        setResults({
          messages: r.messages.filter((m) => m.project_id === pid),
          issues: r.issues.filter((i) => i.project_id === pid),
          todos: r.todos.filter((t) => t.project_id === pid),
          projects: [],
        });
      } catch {
        setResults(null);
      }
    }, 250);
  }

  return (
    <div class="px-4 pt-4">
      <div class="relative">
        <input
          type="text"
          value={q()}
          placeholder="Search"
          title="Text search, or qualifiers: from:name · has:image · has:file · before:YYYY-MM-DD · after:YYYY-MM-DD"
          aria-label="Search this project"
          onInput={(e) => onInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setQ("");
              setResults(null);
              e.currentTarget.blur();
            }
          }}
          class="h-8 w-full rounded-md border border-transparent bg-surface px-2.5 pr-7 text-[12.5px] placeholder:text-muted/70 focus:border-accent/50 focus:outline-none"
        />
        <Show when={q()}>
          <button
            type="button"
            aria-label="Clear search"
            class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted hover:text-fg"
            onClick={() => {
              setQ("");
              setResults(null);
            }}
          >
            <XIcon class="h-3 w-3" />
          </button>
        </Show>
      </div>
      <SearchResultsView results={results()} query={q().trim()} />
    </div>
  );
}

function SearchResultsView(props: {
  results: SearchResults | null;
  query: string;
}) {
  return (
    <Show when={props.results}>
      {(r) => {
        const empty = () =>
          r().messages.length + r().issues.length + r().todos.length === 0;
        return (
          <div class="mt-3 flex flex-col gap-3 border-b border-border pb-4">
            <p class="text-[11px] font-medium uppercase tracking-[0.07em] text-muted/80">
              {empty() ? `No results for “${props.query}”` : "Results"}
            </p>
            <For each={r().issues.slice(0, 5)}>
              {(i) => (
                <A
                  href={`/app/p/${i.project_id}/i/${i.id}`}
                  class="flex items-center gap-2 text-[12.5px] transition-colors hover:text-accent"
                >
                  <span class="font-mono text-[10.5px] text-accent">
                    {i.key}
                  </span>
                  <span class="truncate">{i.title}</span>
                </A>
              )}
            </For>
            <For each={r().messages.slice(0, 5)}>
              {(m) => (
                <p class="text-[12px] text-muted">
                  <span class="font-medium text-fg">{m.author}</span>
                  {": "}
                  {m.body.slice(0, 90)}
                </p>
              )}
            </For>
            <For each={r().todos.slice(0, 3)}>
              {(t) => (
                <p class="text-[12px] text-muted">
                  {t.done ? "☑" : "☐"} {t.content}
                </p>
              )}
            </For>
          </div>
        );
      }}
    </Show>
  );
}

function ContextRail(props: {
  project: Project;
  onOpenView: (v: View) => void;
}) {
  const session = useSession();
  const [issues, { refetch: refetchIssues }] = createResource(
    () => props.project.id,
    async (id) => (await api.listIssues(id)).issues,
  );
  const [reviews] = createResource(
    () => props.project.id,
    async (id) => (await api.listReviews(id, "pending")).reviews,
  );
  const [todos, { refetch: refetchTodos }] = createResource(
    () => props.project.id,
    async (id) => (await api.listTodos(id)).todos,
  );
  const [repos] = createResource(
    () => props.project.id,
    async (id) => (await api.listProjectRepos(id)).repos,
  );
  const [members] = createResource(
    () => props.project.workspace_id,
    async (id) => (await api.listWorkspaceMembers(id)).members,
  );

  const [agents] = createResource(
    () => props.project.id,
    async (id) => (await api.listProjectAgents(id)).agents,
  );

  const unsub = subscribe((e) => {
    if (e.project_id === props.project.id && e.type.startsWith("issue.")) {
      refetchIssues();
    }
    if (e.project_id === props.project.id && e.type.startsWith("todo.")) {
      refetchTodos();
    }
  });
  onCleanup(unsub);

  const openIssues = createMemo(() =>
    (issues.latest ?? []).filter((i) => !isClosed(i.status, statusDefs(props.project))).slice(0, 5),
  );

  return (
    <aside class="h-full w-72 shrink-0 overflow-y-auto border-l border-border pb-6 xl:w-80">
      <RailSearch projectId={props.project.id} />
      <RailSection label="Open issues" count={openIssues().length}>
        <div class="flex flex-col gap-1.5">
          <For
            each={openIssues()}
            fallback={
              <p class="text-[12px] text-muted">Nothing open. Nice.</p>
            }
          >
            {(i) => <MiniIssue project={props.project} issue={i} />}
          </For>
        </div>
        <button
          type="button"
          onClick={() => props.onOpenView("issues")}
          class="mt-1.5 text-[12px] text-accent hover:underline"
        >
          All issues →
        </button>
      </RailSection>

      <RailSection label="Pending reviews" count={reviews.latest?.length ?? 0}>
        <div class="flex flex-col gap-1.5">
          <For
            each={(reviews.latest ?? []).slice(0, 3)}
            fallback={<p class="text-[12px] text-muted">Queue is clear.</p>}
          >
            {(r) => (
              <MiniReview
                review={r}
                onOpen={() => props.onOpenView("reviews")}
              />
            )}
          </For>
        </div>
        <button
          type="button"
          onClick={() => props.onOpenView("reviews")}
          class="mt-1.5 text-[12px] text-accent hover:underline"
        >
          All reviews →
        </button>
      </RailSection>

      <RailSection label="Development">
        <Show
          when={(repos.latest?.length ?? 0) > 0}
          fallback={
            <button
              type="button"
              onClick={() => props.onOpenView("development")}
              class="w-full rounded-lg border border-dashed border-border px-3 py-2.5 text-left text-[12px] text-muted transition-colors hover:border-accent hover:text-fg"
            >
              Link a GitHub repo →
            </button>
          }
        >
          <For each={repos.latest}>
            {(r) => (
              <a
                href={r.url}
                target="_blank"
                rel="noreferrer"
                class="mb-1.5 flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 transition-colors hover:border-muted/60"
              >
                <span class="text-fg">{markGitHub("h-4 w-4")}</span>
                <span class="min-w-0">
                  <span class="block truncate text-[12.5px] font-medium">
                    {r.full_name}
                  </span>
                  <span class="block font-mono text-[10.5px] text-muted">
                    {r.default_branch}
                  </span>
                </span>
              </a>
            )}
          </For>
          <button
            type="button"
            onClick={() => props.onOpenView("development")}
            class="mt-0.5 text-[12px] text-accent hover:underline"
          >
            Commits &amp; PRs →
          </button>
        </Show>
      </RailSection>

      <RailSection label="Members" count={members.latest?.length}>
        <div class="flex flex-col gap-1">
          <For each={members.latest}>
            {(m) => (
              <div class="flex items-center gap-2.5 py-0.5">
                <Avatar.Root class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface">
                  <Avatar.Fallback class="text-[10px] font-semibold text-muted">
                    {initials(m.user.name)}
                  </Avatar.Fallback>
                  <Avatar.Image
                    src={mediaURL(m.user.avatar_url)}
                    alt=""
                    class="h-full w-full rounded-full object-cover"
                  />
                </Avatar.Root>
                <span class="min-w-0 flex-1 truncate text-[12.5px]">
                  {m.user.name}
                  <Show when={m.user.id === session.user()?.id}>
                    <span class="text-muted"> (you)</span>
                  </Show>
                </span>
                <Show when={m.role !== "member"}>
                  <span class="text-[10.5px] text-muted">{m.role}</span>
                </Show>
              </div>
            )}
          </For>
        </div>
      </RailSection>

      <Show when={(agents.latest ?? []).length > 0}>
        <RailSection label="Agents" count={agents.latest?.length}>
          <div class="flex flex-col gap-1">
            <For each={agents.latest}>
              {(a) => (
                <div class="flex items-center gap-2.5 py-0.5">
                  <Avatar.Root class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface">
                    <Avatar.Fallback class="text-[10px] font-semibold text-muted">
                      {initials(a.name)}
                    </Avatar.Fallback>
                    <Avatar.Image
                      src={mediaURL(a.avatar_url)}
                      alt=""
                      class="h-full w-full rounded-full object-cover"
                    />
                  </Avatar.Root>
                  <span class="min-w-0 flex-1 truncate text-[12.5px]">
                    {a.name}
                  </span>
                  <span class="text-[10.5px] text-muted">agent</span>
                </div>
              )}
            </For>
          </div>
        </RailSection>
      </Show>

      <RailSection
        label="Todos"
        count={(todos.latest ?? []).filter((t) => !t.done).length}
      >
        <TodoList
          projectId={props.project.id}
          todos={todos.latest ?? []}
          onChanged={refetchTodos}
        />
      </RailSection>

      <RailSection label="Workspace">
        <button
          type="button"
          onClick={() => props.onOpenView("settings")}
          class="flex w-full items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-[12.5px] transition-colors hover:border-muted/60"
        >
          <SettingsIcon class="h-3.5 w-3.5 text-muted" />
          Webhooks &amp; project settings
        </button>
      </RailSection>
    </aside>
  );
}

// ViewSheet hosts the heavyweight surfaces (board, full issue list, reviews,
// GitHub, webhooks) as a right-side sheet over the chat - the chat stays the
// page's spine; nothing navigates away.
function ViewSheet(props: {
  view: View;
  project: Project;
  onClose: () => void;
}) {
  createEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  const label = () => VIEWS.find((v) => v.id === props.view)?.label ?? "";

  return (
    <div class="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="Close panel"
        class="absolute inset-0 bg-black/30"
        onClick={props.onClose}
      />
      <div
        role="dialog"
        aria-label={label()}
        class="relative z-10 flex h-full w-[min(760px,92vw)] flex-col border-l border-border bg-bg shadow-2xl"
      >
        <div class="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
          <h2 class="text-[13.5px] font-semibold">{label()}</h2>
          <span class="font-mono text-[11px] text-muted">
            {props.project.key}
          </span>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Close"
            class="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <XIcon class="h-4 w-4" />
          </button>
        </div>
        <div class="flex min-h-0 flex-1 flex-col">
          <Show when={props.view === "issues"}>
            <IssueList project={props.project} />
          </Show>
          <Show when={props.view === "pulls"}>
            <PullRequestList projectId={props.project.id} />
          </Show>
          <Show when={props.view === "reviews"}>
            <Reviews project={props.project} />
          </Show>
          <Show when={props.view === "development"}>
            <DevelopmentPanel
              projectId={props.project.id}
              workspaceId={props.project.workspace_id}
            />
          </Show>
          <Show when={props.view === "commits"}>
            <GitLog projectId={props.project.id} />
          </Show>
          <Show when={props.view === "settings"}>
            <div class="min-h-0 flex-1 overflow-y-auto">
              <div class="mx-auto w-full max-w-2xl px-6 py-6">
                <ProjectDetailsSection project={props.project} />
                <ProjectIconSection project={props.project} />
                <ProjectRepoSection project={props.project} />
                <WebhooksSection projectId={props.project.id} />
              </div>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}

// Rename/recolor an existing project. PATCH /api/projects/:id — the store
// refresh repaints the rail and header.
function ProjectDetailsSection(props: { project: Project }) {
  const projects = useProjects();
  const [error, setError] = createSignal<string | null>(null);
  const [saved, setSaved] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const [color, setColor] = createSignal(props.project.color || "#06b6d4");

  async function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    const data = new FormData(e.currentTarget as HTMLFormElement);
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      await api.updateProject(props.project.id, {
        name: String(data.get("name") ?? "").trim() || undefined,
        description: String(data.get("description") ?? ""),
        color: String(data.get("color") ?? "") || "",
      });
      await projects.refresh();
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div class="mb-6">
      <h3 class="mb-2 text-[13px] font-semibold">Project</h3>
      <form onSubmit={onSubmit} class="flex flex-col gap-3">
        <div class="flex items-center gap-3">
          <label class="w-20 text-[12px] text-muted" for="pd-name">
            Name
          </label>
          <input
            id="pd-name"
            name="name"
            required
            maxlength={80}
            value={props.project.name}
            class={`${inputClass} max-w-xs`}
          />
          <input type="hidden" name="color" value={color()} />
          <ColorField
            value={color()}
            onPick={setColor}
            label="Project color"
          />
        </div>
        <div class="flex items-start gap-3">
          <label class="w-20 pt-2 text-[12px] text-muted" for="pd-desc">
            Description
          </label>
          <textarea
            id="pd-desc"
            name="description"
            rows={2}
            value={props.project.description}
            class={`${inputClass} flex-1 resize-none`}
          />
        </div>
        <div class="flex items-center gap-2 pl-[92px]">
          <SubmitButton pending={pending()}>Save</SubmitButton>
          <Show when={saved()}>
            <span class="text-[12px] text-accent-ink">Saved</span>
          </Show>
        </div>
      </form>
      <FormError message={error()} />
    </div>
  );
}

// Link a different (or first) GitHub repo after creation — picks from the
// workspace's installed App repositories; unlink lives beside each entry.
function ProjectRepoSection(props: { project: Project }) {
  const [repos, { refetch }] = createResource(
    () => props.project.id,
    async (id) => (await api.listProjectRepos(id)).repos,
  );
  const [available] = createResource(
    () => props.project.workspace_id,
    async (id) => {
      try {
        return (await api.listAvailableRepos(id)).repos;
      } catch {
        return [] as Awaited<
          ReturnType<typeof api.listAvailableRepos>
        >["repos"];
      }
    },
  );
  const [picked, setPicked] = createSignal("");
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const linkable = () =>
    (available.latest ?? []).filter(
      (a) =>
        !(repos() ?? []).some(
          (r) => r.owner === a.owner && r.name === a.name,
        ),
    );

  async function link(e: SubmitEvent) {
    e.preventDefault();
    const repo = linkable().find(
      (r) => `${r.owner}/${r.name}` === picked(),
    );
    if (!repo) return;
    setPending(true);
    setError(null);
    try {
      await api.linkRepo(props.project.id, {
        installation_id: repo.installation_id,
        owner: repo.owner,
        name: repo.name,
        default_branch: repo.default_branch,
      });
      setPicked("");
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Link failed");
    } finally {
      setPending(false);
    }
  }

  async function unlink(repoId: string) {
    setError(null);
    try {
      await api.unlinkRepo(props.project.id, repoId);
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unlink failed");
    }
  }

  return (
    <div class="mb-6">
      <h3 class="mb-2 text-[13px] font-semibold">GitHub</h3>
      <For each={repos() ?? []}>
        {(r) => (
          <div class="mb-1.5 flex items-center gap-2 text-[12.5px]">
            <span class="min-w-0 flex-1 truncate font-mono text-muted">
              {r.owner}/{r.name}
            </span>
            <button
              type="button"
              onClick={() => void unlink(r.id)}
              class="shrink-0 rounded px-1.5 py-0.5 text-[11.5px] text-muted hover:bg-hover hover:text-fg"
            >
              unlink
            </button>
          </div>
        )}
      </For>
      <Show
        when={linkable().length > 0}
        fallback={
          <Show when={(repos() ?? []).length === 0}>
            <p class="text-[12px] text-muted">
              {(available.latest?.length ?? 0) === 0
                ? "Install the GitHub App on a repository first (Settings → GitHub App)."
                : "No unlinked repositories available."}
            </p>
          </Show>
        }
      >
        <form onSubmit={link} class="flex items-start gap-2">
          <div class="w-72">
            <RepoPicker
              repos={linkable()}
              value={picked()}
              onPick={(r) => setPicked(r?.full_name ?? "")}
            />
          </div>
          <SubmitButton pending={pending()} disabled={!picked()}>
            Link
          </SubmitButton>
        </form>
      </Show>
      <FormError message={error()} />
    </div>
  );
}

// Project icon: upload an image, adopt the linked repo's GitHub owner avatar,
// or download the current one. Changes propagate to the rail via the store.
function ProjectIconSection(props: { project: Project }) {
  const projects = useProjects();
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);

  async function onFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    input.value = "";
    if (!f) return;
    setPending(true);
    setError(null);
    try {
      await api.uploadProjectIcon(props.project.id, f);
      await projects.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setPending(false);
    }
  }

  async function adoptGithub() {
    setPending(true);
    setError(null);
    try {
      await api.adoptGithubIcon(props.project.id);
      await projects.refresh();
    } catch (err) {
      setError(
        err instanceof ApiClientError && err.status === 400
          ? "Link a GitHub repository first"
          : err instanceof Error
            ? err.message
            : "Could not fetch the GitHub avatar",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div class="mb-6">
      <h3 class="mb-2 text-[13px] font-semibold">Project icon</h3>
      <div class="flex items-center gap-3">
        <Show
          when={props.project.icon_url}
          fallback={
            <span class="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-surface text-[13px] font-medium text-muted">
              {initials(props.project.name)}
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
        <p class="min-w-0 flex-1 text-[12px] text-muted">
          Shown in the rail and header instead of the project key.
        </p>
        <Show when={props.project.icon_url}>
          {(url) => (
            <a
              href={url().startsWith("blob:") ? url() : mediaURL(`${url()}?download=1`)}
              download="project-icon"
              title="Download icon"
              aria-label="Download project icon"
              class="rounded-md border border-border bg-surface p-1.5 text-muted hover:bg-hover hover:text-fg"
            >
              <DownloadIcon class="h-3.5 w-3.5" />
            </a>
          )}
        </Show>
        <label
          class={`cursor-pointer rounded-md border border-border bg-surface px-2.5 py-1 text-[12px] hover:bg-hover ${pending() ? "pointer-events-none opacity-60" : ""}`}
        >
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp,image/x-icon"
            class="sr-only"
            onChange={onFile}
          />
          Upload
        </label>
        <button
          type="button"
          disabled={pending()}
          onClick={() => void adoptGithub()}
          class="rounded-md border border-border bg-surface px-2.5 py-1 text-[12px] hover:bg-hover disabled:opacity-60"
          title="Use the linked repository's GitHub owner avatar"
        >
          Use GitHub icon
        </button>
      </div>
      <Show when={!net.isLocal()}>
        <div class="mt-2 max-w-sm">
          <ImageURLField
            onSubmit={async (u) => {
              setPending(true);
              setError(null);
              try {
                await api.uploadImageURL(
                  `/api/projects/${props.project.id}/icon`,
                  u,
                );
                await projects.refresh();
              } finally {
                setPending(false);
              }
            }}
          />
        </div>
      </Show>
      <FormError message={error()} />
    </div>
  );
}

export default function ProjectPage() {
  const params = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const projects = useProjects();

  // Legacy ?tab= links open the matching sheet once, then drop the param.
  const view = (): View | undefined => {
    const v = searchParams.view ?? searchParams.tab;
    return VIEWS.some((x) => x.id === v) ? (v as View) : undefined;
  };
  const openView = (v: View | undefined) =>
    setSearchParams({ view: v ?? undefined, tab: undefined });

  // The board became its own page — old ?view=board / ?tab=board links land
  // there instead of opening a sheet.
  createEffect(() => {
    const v = searchParams.view ?? searchParams.tab;
    if (v === "board") {
      navigate(`/app/p/${params.projectId}/board`, { replace: true });
    }
  });


  const [overview] = createResource(
    () => params.projectId,
    (id) => api.projectOverview(id),
  );

  const [briefsOpen, setBriefsOpen] = createSignal(false);

  const project = (): Project | undefined =>
    overview()?.project ??
    projects.projects()?.find((p) => p.id === params.projectId);

  return (
    <div class="flex h-full min-h-0">
      <div class="flex min-w-0 flex-1 flex-col">
        <header class="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
          <Show
            when={project()}
            fallback={
              <Show
                when={overview.state === "errored"}
                fallback={<Spinner class="h-4 w-4" />}
              >
                <button
                  type="button"
                  class="text-[13px] text-muted hover:text-fg"
                  onClick={() => navigate("/app")}
                >
                  Project not found — back home
                </button>
              </Show>
            }
          >
            {(p) => (
              <>
                <span
                  class="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ "background-color": p().color ?? "var(--accent)" }}
                />
                <Show when={p().icon_url}>
                  {(url) => (
                    <img
                      src={mediaURL(url())}
                      alt=""
                      class="h-5.5 w-5.5 shrink-0 rounded-md object-cover"
                    />
                  )}
                </Show>
                <h1 class="truncate text-[14.5px] font-semibold tracking-tight">
                  {p().name}
                </h1>
                <Show when={p().description}>
                  <span class="hidden truncate text-[12.5px] text-muted md:inline">
                    {p().description}
                  </span>
                </Show>
              </>
            )}
          </Show>
          <div class="ml-auto flex items-center gap-1">
            <HeadButton
              title="Board"
              onClick={() => navigate(`/app/p/${params.projectId}/board`)}
            >
              <BoardIcon class="h-4 w-4" />
            </HeadButton>
            <HeadButton
              title="Issues"
              active={view() === "issues"}
              onClick={() =>
                openView(view() === "issues" ? undefined : "issues")
              }
            >
              <IssueIcon class="h-4 w-4" />
            </HeadButton>
            <HeadButton
              title="Pull requests"
              active={view() === "pulls"}
              onClick={() =>
                openView(view() === "pulls" ? undefined : "pulls")
              }
            >
              <GitPullRequestIcon class="h-4 w-4" />
            </HeadButton>
            <HeadButton
              title="Commits"
              active={view() === "commits"}
              onClick={() =>
                openView(view() === "commits" ? undefined : "commits")
              }
            >
              <GitBranchIcon class="h-4 w-4" />
            </HeadButton>
            <HeadButton
              title="Visual briefs"
              active={briefsOpen()}
              onClick={() => setBriefsOpen(!briefsOpen())}
            >
              <BriefsIcon class="h-4 w-4" />
            </HeadButton>
          </div>
        </header>

        <Conversation projectId={params.projectId} />
      </div>

      <Show when={project()} keyed>
        {(p) => (
          <div class="hidden lg:block">
            <ContextRail project={p} onOpenView={openView} />
          </div>
        )}
      </Show>

      <Show when={briefsOpen() && project()} keyed>
        {(p) => (
          <BriefsPanel project={p} onClose={() => setBriefsOpen(false)} />
        )}
      </Show>

      <Show when={view() !== undefined && project()} keyed>
        {(p) => (
          <ViewSheet
            view={view()!}
            project={p}
            onClose={() => openView(undefined)}
          />
        )}
      </Show>
    </div>
  );
}
