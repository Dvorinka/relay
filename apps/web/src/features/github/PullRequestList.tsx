import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { api } from "../../lib/api";
import { Spinner, Tip } from "../../components/ui";
import { GitPullRequestIcon } from "../../components/icons";
import { markGitHub } from "./GitHub";
import { PullRequestDetail } from "./PullRequestDetail";
import type { Issue } from "@relay/api-client";

// Pull requests mirrored from the linked GitHub repos arrive as issues with
// github.kind="pr" (import + webhooks keep them current). Listed here —
// never in the Issues view — split into open and closed.
export function PullRequestList(props: { projectId: string }) {
  const [issues] = createResource(
    () => props.projectId,
    async (id) => (await api.listIssues(id)).issues,
  );
  const [repos] = createResource(
    () => props.projectId,
    async (id) => (await api.listProjectRepos(id)).repos,
  );
  const [selected, setSelected] = createSignal<{
    repo: string;
    number: number;
  } | null>(null);
  const [query, setQuery] = createSignal("");
  const [stateFilter, setStateFilter] = createSignal<
    "all" | "open" | "merged" | "closed"
  >("all");

  const prs = createMemo(() =>
    (issues.latest ?? []).filter((i) => i.github?.kind === "pr"),
  );
  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase();
    return prs().filter((i) => {
      if (
        stateFilter() !== "all" &&
        (i.github?.state ?? "open") !== stateFilter()
      ) {
        return false;
      }
      if (!q) return true;
      return (
        i.title.toLowerCase().includes(q) ||
        (i.github?.repo ?? "").toLowerCase().includes(q) ||
        String(i.github?.number ?? "").includes(q)
      );
    });
  });
  const open = createMemo(() =>
    filtered().filter((i) => i.github?.state === "open"),
  );
  const closed = createMemo(() =>
    filtered().filter((i) => i.github?.state !== "open"),
  );

  const row = (i: Issue) => (
    <li>
      <button
        type="button"
        onClick={() =>
          setSelected({
            repo: i.github!.repo!,
            number: i.github!.number!,
          })
        }
        class="flex w-full items-center gap-3 px-5 py-2.5 text-left transition-colors hover:bg-hover"
      >
        <span
          class={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${
            i.github?.state === "merged"
              ? "border-violet-400/40 bg-violet-400/10 text-violet-400"
              : i.github?.state === "closed"
                ? "border-border text-muted"
                : "border-emerald-400/40 bg-emerald-400/10 text-emerald-400"
          }`}
        >
          <GitPullRequestIcon class="h-3.5 w-3.5" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="truncate text-[13.5px] font-medium">
            <span class="mr-1.5 font-mono text-[12px] font-normal text-muted">
              #{i.github?.number}
            </span>
            {i.title}
          </p>
          <p class="mt-0.5 flex items-center gap-2 truncate text-[12px] text-muted">
            {markGitHub("", "h-3 w-3")}
            <span class="font-mono">{i.github?.repo}</span>
            <span
              class={`rounded-full px-1.5 py-px text-[10px] font-medium capitalize ${
                i.github?.state === "merged"
                  ? "bg-violet-400/15 text-violet-400"
                  : i.github?.state === "closed"
                    ? "bg-surface text-muted"
                    : "bg-emerald-400/15 text-emerald-400"
              }`}
            >
              {i.github?.state ?? "open"}
            </span>
          </p>
        </div>
      </button>
    </li>
  );

  return (
    <Show
      when={selected() === null}
      fallback={
        <PullRequestDetail
          projectId={props.projectId}
          repo={selected()!.repo}
          number={selected()!.number}
          onBack={() => setSelected(null)}
        />
      }
    >
      <div class="min-h-0 flex-1 overflow-y-auto">
        <Show
          when={issues.state === "ready" || issues.latest}
          fallback={
            <div class="flex flex-1 items-center justify-center py-16">
              <Show
                when={issues.error}
                fallback={<Spinner class="h-4 w-4" />}
              >
                <p class="px-6 py-10 text-center text-[13px] text-muted">
                  Couldn't load pull requests.
                </p>
              </Show>
            </div>
          }
        >
          <Show
            when={(repos.latest?.length ?? 0) > 0}
            fallback={
              <p class="px-6 py-10 text-center text-[13px] text-muted">
                No repositories linked — link one under GitHub.
              </p>
            }
          >
            <div class="flex flex-wrap items-center gap-2 px-5 pb-2">
              <input
                type="text"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
                placeholder="Filter pull requests"
                aria-label="Filter pull requests"
                class="h-7 min-w-0 flex-1 rounded-md border border-transparent bg-surface px-2 text-[12px] placeholder:text-muted/70 focus:border-accent/50 focus:outline-none"
              />
              <div class="flex gap-1">
                <For each={["all", "open", "merged", "closed"] as const}>
                  {(s) => (
                    <button
                      type="button"
                      onClick={() => setStateFilter(s)}
                      class={`rounded-full px-2 py-1 text-[10.5px] font-medium capitalize transition-colors ${
                        stateFilter() === s
                          ? "bg-accent/15 text-accent"
                          : "text-muted hover:bg-hover hover:text-fg"
                      }`}
                    >
                      {s}
                    </button>
                  )}
                </For>
              </div>
            </div>
            <p class="flex items-center gap-2 px-5 pb-2 text-[11.5px] text-muted">
              <Tip
                text="Pull requests"
                hint="Mirrored from GitHub via the repo link. Counts reflect GitHub's real state — merge or close on GitHub and the row moves on the next sync."
                side="bottom"
              >
                <span
                  tabindex={0}
                  class="inline-flex cursor-default items-center text-muted"
                >
                  <GitPullRequestIcon class="h-3.5 w-3.5" />
                </span>
              </Tip>
              {open().length} open · {closed().length} closed
              <Show when={query() || stateFilter() !== "all"}>
                <span class="text-faint">
                  ({prs().length} total — filter active)
                </span>
              </Show>
            </p>
            <Show
              when={prs().length > 0}
              fallback={
                <p class="px-6 py-10 text-center text-[13px] text-muted">
                  No pull requests mirrored yet — run the GitHub import under
                  Development.
                </p>
              }
            >
              <Show when={open().length > 0}>
                <h3 class="mt-1 mb-1 px-5 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted/80">
                  Open
                </h3>
                <ul class="divide-y divide-border">
                  <For each={open()}>{row}</For>
                </ul>
              </Show>
              <Show when={closed().length > 0}>
                <h3 class="mt-4 mb-1 px-5 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted/80">
                  Closed &amp; merged
                </h3>
                <ul class="divide-y divide-border">
                  <For each={closed()}>{row}</For>
                </ul>
              </Show>
              <Show when={filtered().length === 0}>
                <p class="px-6 py-8 text-center text-[13px] text-muted">
                  No pull requests match this filter.
                </p>
              </Show>
            </Show>
          </Show>
        </Show>
      </div>
    </Show>
  );
}
