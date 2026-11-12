import { A, useNavigate, useSearchParams } from "@solidjs/router";
import {
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import type { WorkspacePulls } from "@relay/api-client";
import { api } from "../lib/api";
import { subscribe } from "../lib/events";
import { timeAgo } from "../lib/time";
import { FullPageSpinner, inputClass } from "../components/ui";
import {
  GitPullRequestIcon,
  SearchIcon,
  ThreadIcon,
} from "../components/icons";
import {
  GhAuthor,
  GhAvatar,
  GhLabelChip,
  markGitHub,
} from "../features/github/GitHub";
import { openCreatePull } from "../features/github/CreateModals";
import { Select } from "../components/Select";
import { useSession } from "../stores/session";
import { activeWorkspace } from "../stores/workspace";

// Workspace-wide pull requests: every linked repo's open PRs in one list so
// nothing waits on per-project discovery. Rows deep-link into the project
// pulls view, where merge/review/close run in-app.
export default function Pulls() {
  const session = useSession();
  const navigate = useNavigate();
  const active = activeWorkspace(session.workspaces);
  const [query, setQuery] = createSignal("");
  const [withPullsOnly, setWithPullsOnly] = createSignal(true);
  // "Needs review" — PRs still waiting on a requested reviewer. When the
  // user has bound their GitHub login in Settings, the Involvement select
  // narrows further to their own authored/reviewing/assigned sets.
  const [needsReview, setNeedsReview] = createSignal(false);
  const me = () => (session.user()?.github_login ?? "").toLowerCase();
  type Who = "any" | "mine" | "review" | "assigned";
  const [who, setWho] = createSignal<Who>("any");
  const involvesMe = (p: Group["pulls"][number]) => {
    switch (who()) {
      case "mine":
        return p.author.toLowerCase() === me();
      case "review":
        return p.reviewers.some((a) => a.login.toLowerCase() === me());
      case "assigned":
        return p.assignees.some((a) => a.login.toLowerCase() === me());
      default:
        return true;
    }
  };
  // state lives in the URL — shareable and survives reload/navigation.
  const [params, setParams] = useSearchParams<{ state?: string }>();
  const stateFilter = () =>
    params.state === "closed" || params.state === "all" ? params.state : "open";
  const setStateFilter = (s: "open" | "closed" | "all") =>
    setParams({ state: s === "open" ? undefined : s });

  const [data, { refetch }] = createResource(
    () => ({ ws: active()?.id, state: stateFilter() }),
    (k) => (k.ws ? api.workspacePulls(k.ws, k.state) : null),
  );

  // Mirrored PR issues emit issue.*; CI/deploy webhooks republish as
  // github.ci — both mean a pull row may have moved.
  const unsub = subscribe((e) => {
    if (
      e.type.startsWith("issue.") ||
      e.type === "github.ci" ||
      e.type === "stream.resync"
    )
      void refetch();
  });
  onCleanup(unsub);

  // Server-side payload is 60s-cached anyway — a quiet refresh keeps the
  // view fresh without hammering GitHub.
  const ticker = setInterval(() => void refetch(), 60_000);
  onCleanup(() => clearInterval(ticker));

  type Group = WorkspacePulls["groups"][number];
  const groups = createMemo(() => {
    const q = query().trim().toLowerCase();
    return (data.latest?.groups ?? [])
      .map((g) => ({
        ...g,
        pulls: g.pulls
          .slice()
          .sort(
            (a, b) =>
              +new Date(b.updated_at) - +new Date(a.updated_at),
          )
          .filter(
            (p) =>
              (!needsReview() ||
                p.reviewers.length > 0 ||
                (p.teams?.length ?? 0) > 0) &&
              involvesMe(p) &&
              (!q ||
                p.title.toLowerCase().includes(q) ||
                p.author.toLowerCase().includes(q) ||
                String(p.number).includes(q) ||
                g.repo.full_name.toLowerCase().includes(q) ||
                g.project_name.toLowerCase().includes(q)),
          ),
      }))
      .filter((g) => !withPullsOnly() || g.pulls.length > 0);
  });
  const total = createMemo(() =>
    groups().reduce((n, g) => n + g.pulls.length, 0),
  );

  const open = (g: Group, number: number) =>
    navigate(
      `/app/p/${g.project_id}?view=pulls&pr=${encodeURIComponent(`${g.repo.full_name}:${number}`)}`,
    );

  return (
    <div class="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
      <div class="flex flex-wrap items-center gap-3">
        <h1 class="text-[17px] font-semibold">Pull requests</h1>
        <div class="flex rounded-md border border-border text-[12px]">
          <For each={["open", "closed", "all"] as const}>
            {(s) => (
              <button
                type="button"
                onClick={() => setStateFilter(s)}
                class={`px-2.5 py-1 capitalize transition-colors first:rounded-l-md last:rounded-r-md ${
                  stateFilter() === s
                    ? "bg-hover text-fg"
                    : "text-muted hover:text-fg"
                }`}
              >
                {s}
              </button>
            )}
          </For>
        </div>
        <Show when={total() > 0}>
          <span class="rounded-full bg-hover px-2 py-px font-mono text-[11px] text-muted">
            {total()}
          </span>
        </Show>
        <div class="relative ml-auto min-w-44 flex-1 sm:max-w-64">
          <SearchIcon class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
          <input
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            placeholder="Filter by title, repo, author…"
            class={`${inputClass} pl-8`}
          />
        </div>
        <button
          type="button"
          onClick={() => void refetch()}
          class="rounded-md border border-border px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          Refresh
        </button>
        <Show when={data.latest?.fetched_at}>
          {(t) => (
            <span class="text-[11px] text-faint">
              fetched {timeAgo(t())}
            </span>
          )}
        </Show>
      </div>

      <div class="mt-3 flex items-center gap-3">
        <label class="flex cursor-pointer items-center gap-2 text-[12px] text-muted">
          <input
            type="checkbox"
            checked={withPullsOnly()}
            onChange={(e) => setWithPullsOnly(e.currentTarget.checked)}
            class="accent-accent"
          />
          Hide repos with no matching PRs
        </label>
        <label class="flex cursor-pointer items-center gap-2 text-[12px] text-muted">
          <input
            type="checkbox"
            checked={needsReview()}
            onChange={(e) => setNeedsReview(e.currentTarget.checked)}
            class="accent-accent"
          />
          Needs review
        </label>
        <Show when={me()}>
          <Select
            value={who()}
            onChange={(v) => setWho(v as Who)}
            ariaLabel="Filter by my involvement"
            triggerClass="rounded-md border border-border bg-transparent px-2 py-1 text-[12px] text-muted"
            options={[
              { value: "any", label: "Everyone" },
              { value: "mine", label: "Filed by me" },
              { value: "review", label: "My review requested" },
              { value: "assigned", label: "Assigned to me" },
            ]}
          />
        </Show>
        <Show when={(data.latest?.failed?.length ?? 0) > 0}>
          <span class="text-[11.5px] text-amber-600 dark:text-amber-400">
            {data.latest!.failed!.join(", ")} failed to load
          </span>
        </Show>
      </div>

      <Show
        when={data.latest}
        fallback={
          <div class="py-16">
            <FullPageSpinner />
          </div>
        }
      >
        <Show
          when={groups().length > 0}
          fallback={
            <p class="py-16 text-center text-[13px] text-muted">
              {data.error
                ? "Could not load pull requests — is GitHub connected?"
                : (data.latest?.groups.length ?? 0) === 0
                  ? "No repositories linked yet. Link one under a project's Development view."
                  : query().trim()
                    ? "Nothing matches the filter."
                    : `No ${stateFilter()} pull requests.`}
            </p>
          }
        >
          <For each={groups()}>
            {(g) => (
              <section class="mt-6">
                <h2 class="mb-1.5 flex items-center gap-2 px-1 text-[12px] font-semibold text-muted">
                  <A
                    href={`/app/p/${g.project_id}`}
                    class="text-fg hover:underline"
                  >
                    {g.project_name}
                  </A>
                  <span class="text-faint">/</span>
                  {markGitHub("", "h-3.5 w-3.5")}
                  <a
                    href={g.repo.url}
                    target="_blank"
                    rel="noreferrer"
                    class="font-mono hover:underline"
                  >
                    {g.repo.full_name}
                  </a>
                  <button
                    type="button"
                    onClick={() =>
                      openCreatePull(g.project_id, g.repo.full_name)
                    }
                    class="ml-auto rounded border border-border px-1.5 py-0.5 font-normal text-muted transition-colors hover:bg-hover hover:text-fg"
                  >
                    + New PR
                  </button>
                </h2>
                <ul class="divide-y divide-border rounded-md border border-border">
                  <For
                    each={g.pulls}
                    fallback={
                      <li class="px-3 py-2.5 text-[12px] text-muted">
                        No open pull requests
                      </li>
                    }
                  >
                    {(p) => (
                      <li>
                        <button
                          type="button"
                          onClick={() => open(g, p.number)}
                          class="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-hover"
                        >
                          <GitPullRequestIcon
                            class={`h-3.5 w-3.5 shrink-0 ${
                              p.merged_at
                                ? "text-violet-400"
                                : p.draft || p.state === "closed"
                                  ? "text-muted"
                                  : "text-emerald-500"
                            }`}
                          />
                          <span class="min-w-0 flex-1">
                            <span class="truncate text-[13.5px] font-medium">
                              <span class="mr-1.5 font-mono text-[12px] font-normal text-muted">
                                #{p.number}
                              </span>
                              {p.title}
                              <Show when={p.draft}>
                                <span class="ml-1.5 rounded border border-border px-1 text-[10px] text-muted">
                                  draft
                                </span>
                              </Show>
                              <Show when={p.merged_at}>
                                <span class="ml-1.5 rounded border border-violet-400/40 px-1 text-[10px] text-violet-400">
                                  merged
                                </span>
                              </Show>
                              <Show when={!p.merged_at && p.state === "closed"}>
                                <span class="ml-1.5 rounded border border-border px-1 text-[10px] text-muted">
                                  closed
                                </span>
                              </Show>
                            </span>
                            <span class="mt-0.5 flex items-center gap-2 truncate text-[11.5px] text-muted">
                              <span class="font-mono">
                                {p.head} → {p.base}
                              </span>
                              <span class="flex items-center gap-1.5 text-fg">
                                <GhAuthor
                                  author={p.author}
                                  url={p.avatar_url}
                                  type={p.author_type}
                                />
                              </span>
                              <For each={p.labels}>
                                {(l) => <GhLabelChip label={l} />}
                              </For>
                            </span>
                          </span>
                          <span class="flex shrink-0 items-center gap-2.5 text-[11px] text-muted">
                            <Show when={p.reviewers.length > 0 || (p.teams?.length ?? 0) > 0}>
                              <span
                                class="flex items-center -space-x-1.5"
                                title={`Review requested: ${[...p.reviewers.map((a) => a.login), ...(p.teams ?? []).map((t) => `${t.slug} (team)`)].join(", ")}`}
                              >
                                <For each={p.reviewers.slice(0, 3)}>
                                  {(a) => (
                                    <GhAvatar
                                      author={a.login}
                                      url={a.avatar_url}
                                      class="h-4.5 w-4.5 ring-1 ring-amber-500/60"
                                    />
                                  )}
                                </For>
                                <For each={p.teams ?? []}>
                                  {(t) => (
                                    <span
                                      class="flex h-4.5 w-4.5 items-center justify-center rounded-full bg-amber-500/15 text-[8px] font-semibold text-amber-600 ring-1 ring-amber-500/60 dark:text-amber-400"
                                      title={`Team review requested: ${t.name}`}
                                    >
                                      T
                                    </span>
                                  )}
                                </For>
                              </span>
                            </Show>
                            <Show when={p.assignees.length > 0}>
                              <span
                                class="flex items-center -space-x-1.5"
                                title={`Assigned: ${p.assignees.map((a) => a.login).join(", ")}`}
                              >
                                <For each={p.assignees.slice(0, 3)}>
                                  {(a) => (
                                    <GhAvatar
                                      author={a.login}
                                      url={a.avatar_url}
                                      class="h-4.5 w-4.5"
                                    />
                                  )}
                                </For>
                              </span>
                            </Show>
                            <Show when={(p.comments ?? 0) > 0}>
                              <span class="flex items-center gap-1">
                                <ThreadIcon class="h-3.5 w-3.5" />
                                {p.comments}
                              </span>
                            </Show>
                            <span title={`opened ${timeAgo(p.created_at)}`}>
                              {timeAgo(p.updated_at)}
                            </span>
                          </span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
}
