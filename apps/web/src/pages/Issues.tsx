import { A, useNavigate, useSearchParams } from "@solidjs/router";
import {
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import type { WorkspaceIssues } from "@relay/api-client";
import { api } from "../lib/api";
import { subscribe } from "../lib/events";
import { timeAgo } from "../lib/time";
import { FullPageSpinner, inputClass } from "../components/ui";
import { IssueIcon, SearchIcon, ThreadIcon } from "../components/icons";
import {
  GhAuthor,
  GhAvatar,
  GhLabelChip,
  markGitHub,
} from "../features/github/GitHub";
import { openGhIssue } from "../features/github/GitHubIssueModal";
import { openCreateIssue } from "../features/github/CreateModals";
import { Select } from "../components/Select";
import { useSession } from "../stores/session";
import { activeWorkspace } from "../stores/workspace";

// Workspace-wide GitHub issues: every linked repo's open issues in one list,
// sibling of the Pulls page. Rows deep-link to the mirrored Relay issue when
// one exists, else to the project's issues view.
export default function Issues() {
  const session = useSession();
  const navigate = useNavigate();
  const active = activeWorkspace(session.workspaces);
  const [query, setQuery] = createSignal("");
  const [withIssuesOnly, setWithIssuesOnly] = createSignal(true);
  // Involvement filter — only offered once the user binds their GitHub
  // login in Settings (free-text bind, GitHub App is server-scoped).
  const me = () => (session.user()?.github_login ?? "").toLowerCase();
  type Who = "any" | "mine" | "assigned";
  const [who, setWho] = createSignal<Who>("any");
  const involvesMe = (i: Group["issues"][number]) => {
    switch (who()) {
      case "mine":
        return i.author.toLowerCase() === me();
      case "assigned":
        return i.assignees.some((a) => a.login.toLowerCase() === me());
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
    (k) => (k.ws ? api.workspaceIssues(k.ws, k.state) : null),
  );

  const unsub = subscribe((e) => {
    if (e.type.startsWith("issue.") || e.type === "stream.resync")
      void refetch();
  });
  onCleanup(unsub);

  // The server-side payload is 60s-cached anyway — a quiet refresh keeps the
  // workspace view fresh without hammering GitHub.
  const ticker = setInterval(() => void refetch(), 60_000);
  onCleanup(() => clearInterval(ticker));

  type Group = WorkspaceIssues["groups"][number];
  const groups = createMemo(() => {
    const q = query().trim().toLowerCase();
    return (data.latest?.groups ?? [])
      .map((g) => ({
        ...g,
        issues: g.issues
          .slice()
          .sort(
            (a, b) =>
              +new Date(b.updated_at) - +new Date(a.updated_at),
          )
          .filter(
            (i) =>
              involvesMe(i) &&
              (!q ||
                i.title.toLowerCase().includes(q) ||
                i.author.toLowerCase().includes(q) ||
                String(i.number).includes(q) ||
                g.repo.full_name.toLowerCase().includes(q) ||
                g.project_name.toLowerCase().includes(q)),
          ),
      }))
      .filter((g) => !withIssuesOnly() || g.issues.length > 0);
  });
  const total = createMemo(() =>
    groups().reduce((n, g) => n + g.issues.length, 0),
  );

  const open = (g: Group, i: Group["issues"][number]) => {
    if (i.issue_id) {
      navigate(`/app/p/${g.project_id}/i/${i.issue_id}`);
    } else {
      // Not mirrored — show the live GitHub issue in-app instead of
      // dead-ending on the project's issues view.
      openGhIssue(g.project_id, g.repo.full_name, i.number);
    }
  };

  return (
    <div class="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
      <div class="flex flex-wrap items-center gap-3">
        <h1 class="text-[17px] font-semibold">Issues</h1>
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
            checked={withIssuesOnly()}
            onChange={(e) => setWithIssuesOnly(e.currentTarget.checked)}
            class="accent-accent"
          />
          Hide repos with no matching issues
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
                ? "Could not load issues — is GitHub connected?"
                : (data.latest?.groups.length ?? 0) === 0
                  ? "No repositories linked yet. Link one under a project's Development view."
                  : query().trim()
                    ? "Nothing matches the filter."
                    : `No ${stateFilter()} issues.`}
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
                      openCreateIssue(g.project_id, g.repo.full_name)
                    }
                    class="ml-auto rounded border border-border px-1.5 py-0.5 font-normal text-muted transition-colors hover:bg-hover hover:text-fg"
                  >
                    + New issue
                  </button>
                </h2>
                <ul class="divide-y divide-border rounded-md border border-border">
                  <For
                    each={g.issues}
                    fallback={
                      <li class="px-3 py-2.5 text-[12px] text-muted">
                        No open issues
                      </li>
                    }
                  >
                    {(i) => (
                      <li>
                        <button
                          type="button"
                          onClick={() => open(g, i)}
                          class="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-hover"
                        >
                          <IssueIcon
                            class={`h-3.5 w-3.5 shrink-0 ${i.state === "closed" ? "text-violet-400" : "text-emerald-500"}`}
                          />
                          <span class="min-w-0 flex-1">
                            <span class="truncate text-[13.5px] font-medium">
                              <span class="mr-1.5 font-mono text-[12px] font-normal text-muted">
                                #{i.number}
                              </span>
                              {i.title}
                              <Show when={i.state === "closed"}>
                                <span class="ml-1.5 rounded border border-violet-400/40 px-1 text-[10px] text-violet-400">
                                  closed
                                </span>
                              </Show>
                            </span>
                            <span class="mt-0.5 flex items-center gap-2 truncate text-[11.5px] text-muted">
                              <span class="flex items-center gap-1.5 text-fg">
                                <GhAuthor
                                  author={i.author}
                                  url={i.avatar_url}
                                  type={i.author_type}
                                />
                              </span>
                              <Show when={i.milestone}>
                                <span
                                  class="rounded border border-border px-1 text-[10px]"
                                  title="Milestone"
                                >
                                  {i.milestone}
                                </span>
                              </Show>
                              <For each={i.labels}>
                                {(l) => <GhLabelChip label={l} />}
                              </For>
                            </span>
                          </span>
                          <span class="flex shrink-0 items-center gap-2.5 text-[11px] text-muted">
                            <Show when={i.assignees.length > 0}>
                              <span
                                class="flex items-center -space-x-1.5"
                                title={`Assigned: ${i.assignees.map((a) => a.login).join(", ")}`}
                              >
                                <For each={i.assignees.slice(0, 3)}>
                                  {(a) => (
                                    <GhAvatar
                                      author={a.login}
                                      url={a.avatar_url}
                                      class="h-4.5 w-4.5"
                                    />
                                  )}
                                </For>
                                <Show when={i.assignees.length > 3}>
                                  <span class="pl-2">
                                    +{i.assignees.length - 3}
                                  </span>
                                </Show>
                              </span>
                            </Show>
                            <Show when={i.comments > 0}>
                              <span class="flex items-center gap-1">
                                <ThreadIcon class="h-3.5 w-3.5" />
                                {i.comments}
                              </span>
                            </Show>
                            <span title={`opened ${timeAgo(i.created_at)}`}>
                              {timeAgo(i.updated_at)}
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
