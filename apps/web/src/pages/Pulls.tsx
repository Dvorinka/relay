import { A, useNavigate } from "@solidjs/router";
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
import { GitPullRequestIcon, SearchIcon } from "../components/icons";
import { markGitHub } from "../features/github/GitHub";
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

  const [data, { refetch }] = createResource(
    () => active()?.id,
    (ws) => api.workspacePulls(ws),
  );

  // Mirrored PR issues emit issue.*; CI/deploy webhooks republish as
  // github.ci — both mean a pull row may have moved.
  const unsub = subscribe((e) => {
    if (e.type.startsWith("issue.") || e.type === "github.ci") void refetch();
  });
  onCleanup(unsub);

  type Group = WorkspacePulls["groups"][number];
  const groups = createMemo(() => {
    const q = query().trim().toLowerCase();
    return (data.latest?.groups ?? [])
      .map((g) => ({
        ...g,
        pulls: g.pulls.filter(
          (p) =>
            !q ||
            p.title.toLowerCase().includes(q) ||
            p.author.toLowerCase().includes(q) ||
            String(p.number).includes(q) ||
            g.repo.full_name.toLowerCase().includes(q) ||
            g.project_name.toLowerCase().includes(q),
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
        <Show when={total() > 0}>
          <span class="rounded-full bg-hover px-2 py-px font-mono text-[11px] text-muted">
            {total()} open
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
      </div>

      <label class="mt-3 flex cursor-pointer items-center gap-2 text-[12px] text-muted">
        <input
          type="checkbox"
          checked={withPullsOnly()}
          onChange={(e) => setWithPullsOnly(e.currentTarget.checked)}
          class="accent-accent"
        />
        Hide repos with no open PRs
      </label>

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
                  : "Nothing matches the filter."}
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
                            class={`h-3.5 w-3.5 shrink-0 ${p.draft ? "text-muted" : "text-emerald-500"}`}
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
                            </span>
                            <span class="mt-0.5 flex items-center gap-2 truncate text-[11.5px] text-muted">
                              <span class="font-mono">
                                {p.head} → {p.base}
                              </span>
                              <span>{p.author}</span>
                              <For each={p.labels}>
                                {(l) => (
                                  <span class="rounded-full border border-border px-1.5 text-[10px]">
                                    {l}
                                  </span>
                                )}
                              </For>
                            </span>
                          </span>
                          <span class="shrink-0 text-[11px] text-muted">
                            {timeAgo(p.updated_at)}
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
