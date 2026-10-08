import { createMemo, createSignal, For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import type { Project } from "@relay/api-client";
import { inputClass, Spinner } from "../../components/ui";
import {
  CommitIcon,
  GitPullRequestIcon,
  IssueIcon,
  ReviewIcon,
  SearchIcon,
} from "../../components/icons";
import { openCommit } from "../github/CommitModal";
import {
  KIND_COLOR,
  KIND_LABEL,
  projectEntries,
  useProjectBundles,
  type CalEntry,
  type Kind,
} from "./Calendar";

// TimelineFeed: the Calendar feed as a chronological agenda — newest days
// first, entries grouped per day under kind sub-headers. Commits open the
// in-app commit modal; issues link in-app; GitHub-only rows link out. This is
// the cross-project "roadmap" view on Overview; the per-project spine lives
// in Timeline.tsx.
export function TimelineFeed(props: { project?: Project; projects?: Project[] }) {
  const navigate = useNavigate();
  const [query, setQuery] = createSignal("");
  const [kinds, setKinds] = createSignal<Set<Kind>>(
    new Set<Kind>(["issue", "gh-issue", "pr", "commit", "review"]),
  );
  const [projFilter, setProjFilter] = createSignal<string | null>(null);

  const projList = () =>
    props.projects ?? (props.project ? [props.project] : []);
  const multi = () => props.projects !== undefined;
  const { bundles } = useProjectBundles(projList);

  const toggleKind = (k: Kind) => {
    setKinds((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  };

  const entries = createMemo((): CalEntry[] => {
    const want = kinds();
    const q = query().trim().toLowerCase();
    const pid = projFilter();
    return (bundles() ?? [])
      .flatMap(projectEntries)
      .filter(
        (e) =>
          want.has(e.kind) &&
          (!pid || e.projectId === pid) &&
          (!q ||
            `${e.title} ${e.meta} ${e.repo ?? ""} ${e.projectName ?? ""}`
              .toLowerCase()
              .includes(q)),
      );
  });

  // Newest day first; entries inside a day grouped by kind in KIND_LABEL order.
  const days = createMemo(() => {
    const m = new Map<string, CalEntry[]>();
    for (const e of entries()) {
      const list = m.get(e.day) ?? [];
      list.push(e);
      m.set(e.day, list);
    }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  });

  const todayKey = new Date().toISOString().slice(0, 10);
  const yestKey = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const dayLabel = (d: string) => {
    const long = new Date(`${d}T12:00:00`).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: d.slice(0, 4) === todayKey.slice(0, 4) ? undefined : "numeric",
    });
    if (d === todayKey) return `Today · ${long}`;
    if (d === yestKey) return `Yesterday · ${long}`;
    return long;
  };

  const iconFor = (e: CalEntry) => {
    switch (e.kind) {
      case "pr":
        return <GitPullRequestIcon class="h-3.5 w-3.5" />;
      case "commit":
        return <CommitIcon class="h-3.5 w-3.5" />;
      case "review":
        return <ReviewIcon class="h-3.5 w-3.5" />;
      default:
        return <IssueIcon class="h-3.5 w-3.5" />;
    }
  };

  const activate = (e: CalEntry) => {
    if (e.kind === "commit" && e.sha && e.repo && e.projectId) {
      openCommit(e.projectId, e.repo, e.sha);
    } else if (e.href) navigate(e.href);
    else if (e.external) window.open(e.external, "_blank", "noreferrer");
  };

  const row = (e: CalEntry) => {
    const body = (
      <>
        <span
          class="mt-0.5 shrink-0"
          style={{ color: e.color ?? KIND_COLOR[e.kind] }}
        >
          {iconFor(e)}
        </span>
        <div class="min-w-0 flex-1">
          <p class="text-[12.5px] font-medium leading-snug">{e.title}</p>
          <p class="mt-0.5 text-[11px] text-muted">
            {e.projectName ? `${e.projectName} · ` : ""}
            {e.repo ? `${e.repo} · ` : ""}
            {e.meta}
          </p>
        </div>
      </>
    );
    const cls =
      "flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-hover";
    if (e.href || (e.kind === "commit" && e.sha)) {
      return (
        <button type="button" onClick={() => activate(e)} class={cls}>
          {body}
        </button>
      );
    }
    if (e.external) {
      return (
        <a href={e.external} target="_blank" rel="noreferrer" class={cls}>
          {body}
        </a>
      );
    }
    return <div class={cls}>{body}</div>;
  };

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-6 pt-3">
        <div class="relative w-52">
          <SearchIcon class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            placeholder="Search timeline"
            aria-label="Search timeline"
            class={`${inputClass} !pl-8 !py-1 text-[12px]`}
          />
        </div>
        <div class="flex flex-wrap items-center gap-1">
          <For each={Object.keys(KIND_LABEL) as Kind[]}>
            {(k) => (
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
                  kinds().has(k) ? { "background-color": KIND_COLOR[k] } : undefined
                }
              >
                {KIND_LABEL[k]}
              </button>
            )}
          </For>
          <Show when={multi() && projList().length > 1}>
            <span class="mx-1 h-4 w-px bg-border" />
            <For each={projList()}>
              {(p) => (
                <button
                  type="button"
                  aria-pressed={projFilter() === p.id}
                  onClick={() =>
                    setProjFilter(projFilter() === p.id ? null : p.id)
                  }
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
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <Show
          when={bundles() !== undefined}
          fallback={
            <div class="flex justify-center py-10">
              <Spinner class="h-4 w-4" />
            </div>
          }
        >
          <Show
            when={days().length > 0}
            fallback={
              <p class="py-10 text-center text-[13px] text-muted">
                Nothing in this range.
              </p>
            }
          >
            <div class="mx-auto max-w-3xl">
              <For each={days()}>
                {([day, list]) => (
                  <section class="relative mb-5 pl-5">
                    {/* rail */}
                    <span class="absolute bottom-2 left-1 top-6 w-px bg-border" />
                    <span class="absolute left-0 top-1.5 h-2.5 w-2.5 rounded-full border-2 border-bg bg-accent" />
                    <h3 class="mb-1.5 flex items-baseline gap-2 text-[12.5px] font-semibold">
                      {dayLabel(day)}
                      <span class="text-[11px] font-normal text-muted">
                        {list.length} event{list.length === 1 ? "" : "s"}
                      </span>
                    </h3>
                    <div class="space-y-2">
                      <For each={Object.keys(KIND_LABEL) as Kind[]}>
                        {(k) => {
                          const group = () =>
                            list.filter((e) => e.kind === k);
                          return (
                            <Show when={group().length > 0}>
                              <div>
                                <p class="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-faint">
                                  {KIND_LABEL[k]} · {group().length}
                                </p>
                                <ul>
                                  <For each={group()}>
                                    {(e) => <li>{row(e)}</li>}
                                  </For>
                                </ul>
                              </div>
                            </Show>
                          );
                        }}
                      </For>
                    </div>
                  </section>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}
