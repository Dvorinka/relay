import { createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { api } from "../../lib/api";
import { subscribe } from "../../lib/events";
import { Spinner, Tip } from "../../components/ui";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CommitIcon,
  GitPullRequestIcon,
  IssueIcon,
  ReviewIcon,
} from "../../components/icons";
import { statusColor } from "./meta";
import type { AgentReview, DevelopmentPanel, Issue, Project } from "@relay/api-client";

// Calendar: the same live feed the Timeline shows — issues, mirrored GitHub
// issues/PRs, commits, review requests — laid on a month grid. Pass a single
// `project` for the per-project view (issues page tab) or a `projects` list
// for the cross-project view on Overview — entries then carry project
// identity and a project filter appears beside the kind/repo filters.
type Kind = "issue" | "gh-issue" | "pr" | "commit" | "review";

type CalEntry = {
  id: string;
  kind: Kind;
  title: string;
  meta: string;
  day: string; // YYYY-MM-DD
  repo?: string;
  projectId?: string;
  projectName?: string;
  href?: string;
  external?: string;
  color?: string;
};

const KIND_LABEL: Record<Kind, string> = {
  issue: "Issues",
  "gh-issue": "GitHub issues",
  pr: "Pull requests",
  commit: "Commits",
  review: "Reviews",
};

const KIND_COLOR: Record<Kind, string> = {
  issue: "#8b5cf6",
  "gh-issue": "#10b981",
  pr: "#a78bfa",
  commit: "#3b82f6",
  review: "#f59e0b",
};

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

type ProjectBundle = {
  project: Project;
  issues: Issue[];
  dev?: DevelopmentPanel;
  reviews: AgentReview[];
};

// projectEntries: one project's slice of the calendar — local issues and PR
// mirrors link in-app, GitHub-only rows link out. Filtering happens in the
// view; this just maps records to day entries.
function projectEntries(b: ProjectBundle): CalEntry[] {
  const out: CalEntry[] = [];
  const p = b.project;
  const tag = { projectId: p.id, projectName: p.name };
  for (const i of b.issues) {
    const isPR = i.github?.kind === "pr";
    out.push({
      id: `i-${i.id}`,
      kind: isPR ? "pr" : "issue",
      title: i.title,
      meta: `${i.key}${i.assignee ? ` · ${i.assignee.name}` : ""}`,
      day: dayKey(i.created_at ?? i.updated_at),
      href: `/app/p/${p.id}/i/${i.id}`,
      color: statusColor(i.status, p.statuses),
      ...tag,
    });
  }
  for (const repo of b.dev?.repos ?? []) {
    const name = `${repo.repo.owner}/${repo.repo.name}`;
    for (const gi of repo.issues) {
      out.push({
        id: `gi-${p.id}-${name}-${gi.number}`,
        kind: "gh-issue",
        title: gi.title,
        meta: `${name}#${gi.number} · ${gi.author}`,
        day: dayKey(gi.updated_at),
        repo: name,
        external: gi.url,
        ...tag,
      });
    }
    for (const pr of repo.prs) {
      out.push({
        id: `pr-${p.id}-${name}-${pr.number}`,
        kind: "pr",
        title: pr.title,
        meta: `${name}#${pr.number} · ${pr.head}→${pr.base}`,
        day: dayKey(pr.updated_at ?? ""),
        repo: name,
        external: pr.url,
        ...tag,
      });
    }
    for (const cm of repo.commits) {
      out.push({
        id: `cm-${p.id}-${name}-${cm.sha}`,
        kind: "commit",
        title: cm.message,
        meta: `${cm.sha.slice(0, 7)} · ${cm.author}`,
        day: dayKey(cm.date),
        repo: name,
        external: cm.url,
        ...tag,
      });
    }
  }
  for (const r of b.reviews) {
    if (!r.created_at) continue;
    out.push({
      id: `rev-${r.id}`,
      kind: "review",
      title: r.title,
      meta: `${r.agent.name ?? "agent"} · ${r.status}`,
      day: dayKey(r.created_at),
      ...tag,
    });
  }
  return out.filter((e) => e.day);
}

export function Calendar(props: { project?: Project; projects?: Project[] }) {
  const navigate = useNavigate();
  const today = new Date();
  const [year, setYear] = createSignal(today.getFullYear());
  const [month, setMonth] = createSignal(today.getMonth()); // 0-based
  const [repoFilter, setRepoFilter] = createSignal<string | null>(null);
  const [projFilter, setProjFilter] = createSignal<string | null>(null);
  const [kinds, setKinds] = createSignal<Set<Kind>>(
    new Set<Kind>(["issue", "gh-issue", "pr", "commit", "review"]),
  );
  const [openDay, setOpenDay] = createSignal<string | null>(null);

  const projList = () => props.projects ?? (props.project ? [props.project] : []);
  const multi = () => props.projects !== undefined;

  // One resource keyed on the project list — fans out per project in
  // parallel and merges. Development (GitHub) failures degrade to no
  // repo rows for that project instead of blanking the calendar.
  const [bundles, { refetch }] = createResource(
    () => projList().map((p) => p.id).join(","),
    async () => {
      const out = await Promise.all(
        projList().map(async (p): Promise<ProjectBundle> => {
          const [issues, dev, reviews] = await Promise.all([
            api.listIssues(p.id, {}).then((r) => r.issues).catch(() => [] as Issue[]),
            api.projectDevelopment(p.id).catch(() => undefined),
            api.listReviews(p.id).then((r) => r.reviews).catch(() => [] as AgentReview[]),
          ]);
          return { project: p, issues, dev, reviews };
        }),
      );
      return out;
    },
  );

  const unsub = subscribe((e) => {
    if (!e.project_id || !projList().some((p) => p.id === e.project_id)) return;
    if (
      e.type.startsWith("issue.") ||
      e.type.startsWith("review.") ||
      e.type.startsWith("github.")
    ) {
      refetch();
    }
  });
  onCleanup(unsub);

  const repos = createMemo(() => {
    const set = new Set<string>();
    for (const b of bundles() ?? []) {
      for (const r of b.dev?.repos ?? []) {
        set.add(`${r.repo.owner}/${r.repo.name}`);
      }
    }
    return [...set].sort();
  });

  const entries = createMemo((): CalEntry[] => {
    const want = kinds();
    const repoOk = (r?: string) => !repoFilter() || r === repoFilter();
    const projOk = (p?: string) => !projFilter() || p === projFilter();
    return (bundles() ?? [])
      .flatMap(projectEntries)
      .filter(
        (e) =>
          want.has(e.kind) && repoOk(e.repo) && projOk(e.projectId),
      );
  });

  const byDay = createMemo(() => {
    const m = new Map<string, CalEntry[]>();
    for (const e of entries()) {
      const list = m.get(e.day) ?? [];
      list.push(e);
      m.set(e.day, list);
    }
    return m;
  });

  // Grid cells: leading blanks for the first weekday, then 1..daysInMonth.
  const cells = createMemo(() => {
    const y = year();
    const m = month();
    const first = new Date(y, m, 1);
    const lead = (first.getDay() + 6) % 7; // week starts Monday
    const dim = new Date(y, m + 1, 0).getDate();
    const days: (string | null)[] = [];
    for (let i = 0; i < lead; i++) days.push(null);
    for (let d = 1; d <= dim; d++) {
      days.push(`${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    }
    while (days.length % 7) days.push(null);
    return days;
  });

  const todayKey = dayKey(today.toISOString());
  const monthLabel = () =>
    new Date(year(), month(), 1).toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    });

  const shift = (delta: number) => {
    const d = new Date(year(), month() + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
    setOpenDay(null);
  };

  const toggleKind = (k: Kind) => {
    setKinds((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  };

  const iconFor = (e: CalEntry) => {
    switch (e.kind) {
      case "pr":
        return <GitPullRequestIcon class="h-3 w-3" />;
      case "commit":
        return <CommitIcon class="h-3 w-3" />;
      case "review":
        return <ReviewIcon class="h-3 w-3" />;
      default:
        return <IssueIcon class="h-3 w-3" />;
    }
  };

  const chip = (e: CalEntry) => (
    <button
      type="button"
      title={`${KIND_LABEL[e.kind]}${e.projectName ? ` · ${e.projectName}` : ""} — ${e.title}\n${e.meta}`}
      onClick={(ev) => {
        ev.stopPropagation();
        if (e.href) navigate(e.href);
        else if (e.external) window.open(e.external, "_blank", "noreferrer");
      }}
      class="flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left text-[10.5px] transition-colors hover:bg-hover"
      style={{ color: e.color ?? KIND_COLOR[e.kind] }}
    >
      <span class="shrink-0 opacity-80">{iconFor(e)}</span>
      <span class="min-w-0 flex-1 truncate text-fg">{e.title}</span>
    </button>
  );

  const openDayEntries = createMemo(() =>
    openDay() ? (byDay().get(openDay()!) ?? []) : [],
  );

  const dayRow = (e: CalEntry, inner: "a" | "link") => {
    const body = (
      <>
        <span
          class="shrink-0"
          style={{ color: e.color ?? KIND_COLOR[e.kind] }}
        >
          {iconFor(e)}
        </span>
        <span class="min-w-0 flex-1 truncate font-medium">{e.title}</span>
        <span class="shrink-0 text-[10.5px] text-muted">
          {KIND_LABEL[e.kind]}
          {e.projectName ? ` · ${e.projectName}` : ""} · {e.meta}
        </span>
      </>
    );
    const cls =
      "flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] transition-colors hover:border-muted/60";
    if (inner === "a") {
      return (
        <a href={e.external} target="_blank" rel="noreferrer" class={cls}>
          {body}
        </a>
      );
    }
    return (
      <A href={e.href!} class={cls}>
        {body}
      </A>
    );
  };

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      {/* toolbar: month nav + filters */}
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-6 pt-3">
        <div class="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => shift(-1)}
            class="rounded-md p-1 text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <ChevronLeftIcon class="h-4 w-4" />
          </button>
          <span class="min-w-32 text-center text-[13px] font-semibold">
            {monthLabel()}
          </span>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => shift(1)}
            class="rounded-md p-1 text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <ChevronRightIcon class="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              setYear(today.getFullYear());
              setMonth(today.getMonth());
            }}
            class="ml-1 rounded border border-border px-2 py-0.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            Today
          </button>
        </div>
        <div class="flex flex-wrap items-center gap-1">
          <For each={Object.keys(KIND_LABEL) as Kind[]}>
            {(k) => (
              <Tip text={`Toggle ${KIND_LABEL[k].toLowerCase()}`} hint="" side="bottom">
                <button
                  type="button"
                  aria-pressed={kinds().has(k)}
                  onClick={() => toggleKind(k)}
                  class={`rounded-full border px-2 py-0.5 text-[10.5px] transition-colors ${
                    kinds().has(k)
                      ? "border-transparent text-white"
                      : "border-border text-muted hover:text-fg"
                  }`}
                  style={
                    kinds().has(k)
                      ? { "background-color": KIND_COLOR[k] }
                      : undefined
                  }
                >
                  {KIND_LABEL[k]}
                </button>
              </Tip>
            )}
          </For>
          <Show when={multi() && projList().length > 1}>
            <span class="mx-1 h-4 w-px bg-border" />
            <For each={projList()}>
              {(p) => (
                <button
                  type="button"
                  aria-pressed={projFilter() === p.id}
                  onClick={() => setProjFilter(projFilter() === p.id ? null : p.id)}
                  class={`rounded-full border px-2 py-0.5 text-[10.5px] transition-colors ${
                    projFilter() === p.id
                      ? "border-accent bg-accent/15 text-accent"
                      : "border-border text-muted hover:text-fg"
                  }`}
                >
                  {p.name}
                </button>
              )}
            </For>
          </Show>
          <Show when={repos().length > 0}>
            <span class="mx-1 h-4 w-px bg-border" />
            <button
              type="button"
              aria-pressed={repoFilter() === null}
              onClick={() => setRepoFilter(null)}
              class={`rounded-full border px-2 py-0.5 text-[10.5px] transition-colors ${
                repoFilter() === null
                  ? "border-accent bg-accent/15 text-accent"
                  : "border-border text-muted hover:text-fg"
              }`}
            >
              All repos
            </button>
            <For each={repos()}>
              {(r) => (
                <button
                  type="button"
                  aria-pressed={repoFilter() === r}
                  onClick={() => setRepoFilter(repoFilter() === r ? null : r)}
                  class={`rounded-full border px-2 py-0.5 font-mono text-[10.5px] transition-colors ${
                    repoFilter() === r
                      ? "border-accent bg-accent/15 text-accent"
                      : "border-border text-muted hover:text-fg"
                  }`}
                >
                  {r.split("/")[1] ?? r}
                </button>
              )}
            </For>
          </Show>
        </div>
      </div>

      <Show
        when={bundles() !== undefined}
        fallback={
          <div class="flex flex-1 items-center justify-center">
            <Spinner class="h-4 w-4" />
          </div>
        }
      >
        <div class="min-h-0 flex-1 overflow-y-auto px-6 py-3">
          <div class="grid grid-cols-7 gap-px rounded-lg border border-border bg-border/60 text-[10.5px]">
            <For each={["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]}>
              {(d) => (
                <div class="bg-bg px-2 py-1 font-medium uppercase tracking-wide text-muted">
                  {d}
                </div>
              )}
            </For>
            <For each={cells()}>
              {(day) => (
                <Show
                  when={day}
                  fallback={<div class="min-h-20 bg-bg/60" />}
                >
                  {(d) => {
                    const items = () => byDay().get(d()) ?? [];
                    const extra = () => items().length - 3;
                    return (
                      <div
                        class={`min-h-20 cursor-pointer bg-bg p-1 transition-colors hover:bg-surface/60 ${
                          d() === todayKey ? "bg-accent/5" : ""
                        }`}
                        onClick={() => setOpenDay(openDay() === d() ? null : d())}
                      >
                        <span
                          class={`mb-0.5 inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full px-1 text-[10px] font-medium ${
                            d() === todayKey
                              ? "bg-accent text-white"
                              : "text-muted"
                          }`}
                        >
                          {Number(d().slice(8))}
                        </span>
                        <div class="flex flex-col">
                          <For each={items().slice(0, 3)}>{chip}</For>
                          <Show when={extra() > 0}>
                            <span class="px-1 text-[10px] text-muted">
                              +{extra()} more
                            </span>
                          </Show>
                        </div>
                      </div>
                    );
                  }}
                </Show>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* day detail strip */}
      <Show when={openDay()}>
        {(d) => (
          <div class="shrink-0 border-t border-border bg-surface/40 px-6 py-3">
            <div class="mb-1.5 flex items-center justify-between">
              <span class="text-[12px] font-semibold">
                {new Date(`${d()}T12:00:00`).toLocaleDateString(undefined, {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })}
              </span>
              <button
                type="button"
                aria-label="Close day detail"
                onClick={() => setOpenDay(null)}
                class="rounded-md p-0.5 text-muted hover:bg-hover hover:text-fg"
              >
                <ChevronLeftIcon class="h-3.5 w-3.5 rotate-90" />
              </button>
            </div>
            <Show
              when={openDayEntries().length > 0}
              fallback={<p class="text-[12px] text-muted">Nothing this day.</p>}
            >
              <ul class="flex max-h-40 flex-col gap-1 overflow-y-auto">
                <For each={openDayEntries()}>
                  {(e) => (
                    <li>{e.href ? dayRow(e, "link") : dayRow(e, "a")}</li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
