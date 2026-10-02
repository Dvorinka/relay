import type { AgentReview, Issue, Project } from "@relay/api-client";
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
  IssueIcon,
  SearchIcon,
  SettingsIcon,
  XIcon,
} from "../../components/icons";
import { Spinner } from "../../components/ui";
import { api } from "../../lib/api";
import { openPalette } from "../../components/CommandPalette";
import { subscribe } from "../../lib/events";
import { initials } from "../../lib/text";
import { timeAgo } from "../../lib/time";
import { useProjects } from "../../stores/projects";
import { useSession } from "../../stores/session";
import { Conversation } from "../conversations/Conversation";
import { DevelopmentPanel, markGitHub } from "../github/GitHub";
import { Board } from "../issues/Board";
import { IssueList } from "../issues/IssueList";
import { isClosed, StatusDot } from "../issues/meta";
import { Reviews } from "../reviews/Reviews";
import { WebhooksSection } from "../webhooks/Webhooks";

type View = "board" | "issues" | "reviews" | "development" | "settings";

const VIEWS: { id: View; label: string }[] = [
  { id: "board", label: "Board" },
  { id: "issues", label: "Issues" },
  { id: "reviews", label: "Reviews" },
  { id: "development", label: "Development" },
  { id: "settings", label: "Project settings" },
];

function PanelIcon(props: { class?: string }) {
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
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M15 3v18" />
    </svg>
  );
}

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

function MiniIssue(props: { project: Project; issue: Issue }) {
  return (
    <A
      href={`/app/p/${props.project.id}/i/${props.issue.id}`}
      class="block rounded-lg border border-border bg-surface px-3 py-2 transition-colors hover:border-muted/60"
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
        <StatusDot status={props.issue.status} class="h-1.5 w-1.5" />
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
      class="block w-full rounded-lg border border-border bg-surface px-3 py-2 text-left transition-colors hover:border-muted/60"
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
  const [repos] = createResource(
    () => props.project.id,
    async (id) => (await api.listProjectRepos(id)).repos,
  );
  const [members] = createResource(
    () => props.project.workspace_id,
    async (id) => (await api.listWorkspaceMembers(id)).members,
  );

  const unsub = subscribe((e) => {
    if (e.project_id === props.project.id && e.type.startsWith("issue.")) {
      refetchIssues();
    }
  });
  onCleanup(unsub);

  const openIssues = createMemo(() =>
    (issues() ?? []).filter((i) => !isClosed(i.status)).slice(0, 5),
  );

  return (
    <aside class="h-full w-72 shrink-0 overflow-y-auto border-l border-border pb-6 xl:w-80">
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

      <RailSection label="Pending reviews" count={reviews()?.length ?? 0}>
        <div class="flex flex-col gap-1.5">
          <For
            each={(reviews() ?? []).slice(0, 3)}
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
          when={(repos()?.length ?? 0) > 0}
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
          <For each={repos()}>
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

      <RailSection label="Members" count={members()?.length}>
        <div class="flex flex-col gap-1">
          <For each={members()}>
            {(m) => (
              <div class="flex items-center gap-2.5 py-0.5">
                <Avatar.Root class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface">
                  <Avatar.Fallback class="text-[10px] font-semibold text-muted">
                    {initials(m.user.name)}
                  </Avatar.Fallback>
                  <Avatar.Image
                    src={m.user.avatar_url ?? undefined}
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
        class={`relative z-10 flex h-full flex-col border-l border-border bg-bg shadow-2xl ${
          props.view === "board" ? "w-[min(1100px,94vw)]" : "w-[min(760px,92vw)]"
        }`}
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
          <Show when={props.view === "board"}>
            <Board project={props.project} />
          </Show>
          <Show when={props.view === "issues"}>
            <IssueList project={props.project} />
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
          <Show when={props.view === "settings"}>
            <div class="min-h-0 flex-1 overflow-y-auto">
              <div class="mx-auto w-full max-w-2xl px-6 py-6">
                <WebhooksSection projectId={props.project.id} />
              </div>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}

export default function ProjectPage() {
  const params = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const projects = useProjects();
  const [railOpen, setRailOpen] = createSignal(true);

  // Legacy ?tab= links open the matching sheet once, then drop the param.
  const view = (): View | undefined => {
    const v = searchParams.view ?? searchParams.tab;
    return VIEWS.some((x) => x.id === v) ? (v as View) : undefined;
  };
  const openView = (v: View | undefined) =>
    setSearchParams({ view: v ?? undefined, tab: undefined });

  const [overview] = createResource(
    () => params.projectId,
    (id) => api.projectOverview(id),
  );

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
                <h1 class="truncate text-[14.5px] font-semibold tracking-tight">
                  {p().name}
                </h1>
                <span class="rounded border border-border px-1.5 py-0.5 font-mono text-[10.5px] text-muted">
                  {p().key}
                </span>
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
              active={view() === "board"}
              onClick={() =>
                openView(view() === "board" ? undefined : "board")
              }
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
            <HeadButton title="Search (Ctrl+K)" onClick={openPalette}>
              <SearchIcon class="h-4 w-4" />
            </HeadButton>
            <HeadButton
              title={railOpen() ? "Hide panel" : "Show panel"}
              active={railOpen()}
              onClick={() => setRailOpen((v) => !v)}
            >
              <PanelIcon class="h-4 w-4" />
            </HeadButton>
          </div>
        </header>

        <Conversation projectId={params.projectId} />
      </div>

      <Show when={railOpen() && project()} keyed>
        {(p) => (
          <div class="hidden lg:block">
            <ContextRail project={p} onOpenView={openView} />
          </div>
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
