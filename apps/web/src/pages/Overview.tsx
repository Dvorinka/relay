import { A } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import type { ActivityIssue, Project } from "@relay/api-client";
import { api } from "../lib/api";
import { subscribe } from "../lib/events";
import { FullPageSpinner, inputClass } from "../components/ui";
import {
  ChevronDownIcon,
  GitPullRequestIcon,
  IssueIcon,
  SearchIcon,
} from "../components/icons";
import { useProjects } from "../stores/projects";
import { useSession } from "../stores/session";
import { activeWorkspace } from "../stores/workspace";
import { StatusDot } from "../features/issues/meta";
import { Calendar } from "../features/issues/Calendar";
import { TimelineFeed } from "../features/issues/TimelineFeed";
import { timeAgo } from "../lib/time";

type Kind = "all" | "issue" | "pr";
type View = "list" | "calendar" | "timeline";

// Custom project picker — searchable, shows the project color dot, closes on
// outside click and Escape. Replaces the bare <select>.
function ProjectPicker(props: {
  projects: Project[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [q, setQ] = createSignal("");
  let wrap: HTMLDivElement | undefined;
  let input: HTMLInputElement | undefined;

  const selected = () => props.projects.find((p) => p.id === props.value);
  const shown = () => {
    const needle = q().trim().toLowerCase();
    if (!needle) return props.projects;
    return props.projects.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        p.key.toLowerCase().includes(needle),
    );
  };
  const pick = (id: string) => {
    props.onChange(id);
    setOpen(false);
    setQ("");
  };

  createEffect(() => {
    if (!open()) return;
    const onDoc = (e: MouseEvent) => {
      if (wrap && !wrap.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    input?.focus();
    onCleanup(() => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    });
  });

  return (
    <div ref={(el) => (wrap = el)} class="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
        class={`${inputClass} !w-auto flex items-center gap-1.5 pr-6`}
      >
        <Show when={selected()?.color}>
          <span
            class="h-2 w-2 shrink-0 rounded-full"
            style={{ "background-color": selected()!.color! }}
          />
        </Show>
        <span class="max-w-40 truncate">
          {selected()?.name ?? "All projects"}
        </span>
        <ChevronDownIcon class="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
      </button>
      <Show when={open()}>
        <div class="absolute left-0 top-full z-30 mt-1 w-60 overflow-hidden rounded-lg border border-border bg-surface shadow-xl">
          <div class="border-b border-border p-1.5">
            <input
              ref={(el) => (input = el)}
              type="search"
              value={q()}
              onInput={(e) => setQ(e.currentTarget.value)}
              placeholder="Search projects…"
              aria-label="Search projects"
              class={inputClass}
            />
          </div>
          <ul role="listbox" class="max-h-64 overflow-y-auto py-1">
            <li>
              <button
                type="button"
                role="option"
                aria-selected={props.value === ""}
                onClick={() => pick("")}
                class={`w-full px-3 py-1.5 text-left text-[12.5px] transition-colors hover:bg-hover ${
                  props.value === "" ? "font-medium text-accent" : ""
                }`}
              >
                All projects
              </button>
            </li>
            <For
              each={shown()}
              fallback={
                <li class="px-3 py-2 text-[12px] text-muted">No matches</li>
              }
            >
              {(p) => (
                <li>
                  <button
                    type="button"
                    role="option"
                    aria-selected={props.value === p.id}
                    onClick={() => pick(p.id)}
                    class={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors hover:bg-hover ${
                      props.value === p.id ? "font-medium text-accent" : ""
                    }`}
                  >
                    <span
                      class="h-2 w-2 shrink-0 rounded-full"
                      style={{
                        "background-color": p.color ?? "var(--accent)",
                      }}
                    />
                    <span class="min-w-0 flex-1 truncate">{p.name}</span>
                    <span class="shrink-0 font-mono text-[10px] text-muted">
                      {p.key}
                    </span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>
    </div>
  );
}

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
                ["timeline", "Timeline"],
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
        <ProjectPicker
          projects={wsProjects()}
          value={proj()}
          onChange={setProj}
        />
        </Show>
      </div>
      <Switch>
        <Match when={view() === "calendar"}>
          <Calendar projects={wsProjects()} />
        </Match>
        <Match when={view() === "timeline"}>
          <TimelineFeed projects={wsProjects()} />
        </Match>
        <Match when={view() === "list"}>
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
        </Match>
      </Switch>
    </div>
  );
}
