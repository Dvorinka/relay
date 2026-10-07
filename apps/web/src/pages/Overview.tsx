import { A } from "@solidjs/router";
import { createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import type { ActivityIssue } from "@relay/api-client";
import { api } from "../lib/api";
import { subscribe } from "../lib/events";
import { FullPageSpinner, inputClass } from "../components/ui";
import { GitPullRequestIcon, IssueIcon, SearchIcon } from "../components/icons";
import { useProjects } from "../stores/projects";
import { useSession } from "../stores/session";
import { activeWorkspace } from "../stores/workspace";
import { StatusDot } from "../features/issues/meta";
import { Calendar } from "../features/issues/Calendar";
import { timeAgo } from "../lib/time";

type Kind = "all" | "issue" | "pr";
type View = "list" | "calendar";

// Every open issue and GitHub-linked PR across the caller's projects — the
// "Across projects" feed on Home unrolled into a full page. myActivity is
// one aggregate call for the list; the calendar view fans out per project
// so it can also show commits, reviews and repo events.
export default function Overview() {
  const projects = useProjects();
  const session = useSession();
  const [activity, { refetch }] = createResource(() => api.myActivity());
  const [query, setQuery] = createSignal("");
  const [kind, setKind] = createSignal<Kind>("all");
  const [proj, setProj] = createSignal("");
  const [view, setView] = createSignal<View>(
    (localStorage.getItem("relay.overviewView") as View) || "list",
  );
  const pickView = (v: View) => {
    setView(v);
    localStorage.setItem("relay.overviewView", v);
  };

  const active = activeWorkspace(session.workspaces);
  const wsProjects = createMemo(() =>
    (projects.sorted() ?? []).filter(
      (p) => !active() || p.workspace_id === active()!.id,
    ),
  );

  const unsub = subscribe((e) => {
    if (e.type.startsWith("issue.") || e.type === "review.created") {
      void refetch();
    }
  });
  onCleanup(unsub);

  const items = (): ActivityIssue[] => {
    const a = activity();
    if (!a) return [];
    const q = query().trim().toLowerCase();
    const all =
      kind() === "issue" ? a.open_issues
      : kind() === "pr" ? a.open_prs
      : [...a.open_prs, ...a.open_issues].sort(
          (x, y) => Date.parse(y.updated_at) - Date.parse(x.updated_at),
        );
    return all.filter(
      (i) =>
        (!proj() || i.project_id === proj()) &&
        (!q ||
          i.title.toLowerCase().includes(q) ||
          i.key.toLowerCase().includes(q) ||
          i.project_name.toLowerCase().includes(q)),
    );
  };

  const projectName = (id: string) =>
    projects.projects()?.find((p) => p.id === id)?.name ?? id.slice(0, 8);
  const projectColor = (id: string) =>
    projects.projects()?.find((p) => p.id === id)?.color;

  return (
    <div class="flex h-full flex-col">
      <header class="shrink-0 border-b border-border px-6 py-4">
        <h1 class="text-[15px] font-semibold tracking-tight">Overview</h1>
        <p class="mt-0.5 text-[12px] text-muted">
          Open issues and pull requests across all your projects
        </p>
      </header>
      <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-6 py-2.5">
        <div class="flex items-center gap-1 rounded-lg border border-border p-0.5">
          <For
            each={
              [
                ["list", "List"],
                ["calendar", "Calendar"],
              ] as const
            }
          >
            {([v, label]) => (
              <button
                type="button"
                onClick={() => pickView(v)}
                class={`rounded-md px-2.5 py-1 text-[12px] transition-colors ${
                  view() === v
                    ? "bg-hover font-medium text-fg"
                    : "text-muted hover:text-fg"
                }`}
              >
                {label}
              </button>
            )}
          </For>
        </div>
        <Show when={view() === "list"}>
          <div class="relative w-56">
          <SearchIcon class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            placeholder="Search title or key"
            aria-label="Search issues and PRs"
            class={`${inputClass} !pl-8`}
          />
        </div>
        <div class="flex items-center gap-1 rounded-lg border border-border p-0.5">
          <For
            each={
              [
                ["all", "All"],
                ["issue", "Issues"],
                ["pr", "PRs"],
              ] as const
            }
          >
            {([v, label]) => (
              <button
                type="button"
                onClick={() => setKind(v)}
                class={`rounded-md px-2.5 py-1 text-[12px] transition-colors ${
                  kind() === v
                    ? "bg-hover font-medium text-fg"
                    : "text-muted hover:text-fg"
                }`}
              >
                {label}
              </button>
            )}
          </For>
        </div>
        <select
          value={proj()}
          onChange={(e) => setProj(e.currentTarget.value)}
          aria-label="Filter by project"
          class={`${inputClass} !w-auto`}
        >
          <option value="">All projects</option>
          <For each={wsProjects()}>
            {(p) => <option value={p.id}>{p.name}</option>}
          </For>
        </select>
        </Show>
      </div>
      <Show
        when={view() === "list"}
        fallback={<Calendar projects={wsProjects()} />}
      >
      <div class="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <Show
          when={activity.state === "ready"}
          fallback={
            <div class="flex justify-center py-10">
              <FullPageSpinner />
            </div>
          }
        >
          <ul class="divide-y divide-border overflow-hidden rounded-md border border-border">
            <For
              each={items()}
              fallback={
                <li class="px-4 py-10 text-center text-[13px] text-muted">
                  Nothing open — all caught up.
                </li>
              }
            >
              {(i) => (
                <li>
                  <A
                    href={`/app/p/${i.project_id}/i/${i.id}`}
                    class="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-hover"
                  >
                    <Show
                      when={i.github_kind === "pr"}
                      fallback={
                        <IssueIcon class="h-4 w-4 shrink-0 text-faint" />
                      }
                    >
                      <GitPullRequestIcon class="h-4 w-4 shrink-0 text-faint" />
                    </Show>
                    <span class="shrink-0 font-mono text-[11px] text-muted">
                      {i.key}
                    </span>
                    <span class="min-w-0 flex-1 truncate text-[13px]">
                      {i.title}
                    </span>
                    <span
                      class="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{
                        "background-color":
                          projectColor(i.project_id) ?? "var(--accent)",
                      }}
                    />
                    <span class="w-28 shrink-0 truncate text-[12px] text-muted">
                      {projectName(i.project_id)}
                    </span>
                    <StatusDot status={i.status} class="h-1.5 w-1.5 shrink-0" />
                    <span class="w-14 shrink-0 text-right text-[11px] text-faint">
                      {timeAgo(i.updated_at)}
                    </span>
                  </A>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
      </Show>
    </div>
  );
}
