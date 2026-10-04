import { createResource, createSignal, For, Show } from "solid-js";
import { api } from "../../lib/api";
import { inputClass, Spinner } from "../../components/ui";
import { markGitHub } from "./GitHub";
import { timeAgo } from "../../lib/time";

// GitLog: commit history for a linked repository — repo switcher when several
// are linked, branch picker, then the commit list with GitHub links. This is
// the "git log" surface; the file tree lives under Development → Files.
export function GitLog(props: { projectId: string }) {
  const [repos] = createResource(
    () => props.projectId,
    async (id) => {
      try {
        return (await api.listProjectRepos(id)).repos;
      } catch {
        return [];
      }
    },
  );
  const [repo, setRepo] = createSignal<string | null>(null);
  const [branch, setBranch] = createSignal<string | null>(null);

  const activeRepo = () => repo() ?? repos()?.[0]?.full_name ?? null;

  const [branches] = createResource(
    () => activeRepo(),
    async (r) => {
      if (!r) return null;
      return api.repoBranches(props.projectId, r).catch(() => null);
    },
  );
  const activeBranch = () =>
    branch() ?? branches()?.default_branch ?? null;

  const [log] = createResource(
    () =>
      activeRepo() && activeBranch()
        ? `${activeRepo()}@${activeBranch()}`
        : null,
    async () => {
      const r = activeRepo();
      if (!r) return null;
      return api.repoCommits(props.projectId, r, activeBranch() ?? undefined);
    },
  );

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <Show
        when={(repos()?.length ?? 0) > 0}
        fallback={
          <p class="px-6 py-10 text-center text-[13px] text-muted">
            No repositories linked — link one under GitHub.
          </p>
        }
      >
        <div class="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
          <Show when={(repos()?.length ?? 0) > 1}>
            <select
              aria-label="Repository"
              value={activeRepo() ?? ""}
              onChange={(e) => {
                setRepo(e.currentTarget.value);
                setBranch(null);
              }}
              class={`${inputClass} w-auto !py-1 font-mono text-[12px]`}
            >
              <For each={repos()}>
                {(r) => <option value={r.full_name}>{r.full_name}</option>}
              </For>
            </select>
          </Show>
          <Show when={(branches()?.branches.length ?? 0) > 0}>
            <select
              aria-label="Branch"
              value={activeBranch() ?? ""}
              onChange={(e) => setBranch(e.currentTarget.value)}
              class={`${inputClass} w-auto !py-1 font-mono text-[12px]`}
            >
              <For each={branches()?.branches}>
                {(b) => <option value={b.name}>{b.name}</option>}
              </For>
            </select>
          </Show>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto">
          {/* .latest instead of (): an errored fetch degrades to an
              inline message instead of throwing (no ErrorBoundary). */}
          <Show
            when={log.latest}
            fallback={
              <div class="flex justify-center py-16">
                <Show when={log.error} fallback={<Spinner class="h-4 w-4" />}>
                  <p class="px-6 py-10 text-center text-[13px] text-muted">
                    Couldn't load commits for this branch.
                  </p>
                </Show>
              </div>
            }
          >
            {(l) => (
              <ul class="divide-y divide-border">
                <For
                  each={l().commits}
                  fallback={
                    <li class="px-6 py-10 text-center text-[13px] text-muted">
                      No commits on this branch.
                    </li>
                  }
                >
                  {(cm) => (
                    <li class="flex items-baseline gap-3 px-5 py-2.5">
                      <a
                        href={cm.url}
                        target="_blank"
                        rel="noopener"
                        class="shrink-0 font-mono text-[12px] text-accent hover:underline"
                      >
                        {cm.sha.slice(0, 7)}
                      </a>
                      <div class="min-w-0 flex-1">
                        <p class="truncate text-[13px]">{cm.message}</p>
                        <p class="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-muted">
                          {markGitHub("", "h-3 w-3")}
                          <span>
                            {cm.author} · {timeAgo(cm.date)}
                          </span>
                        </p>
                      </div>
                    </li>
                  )}
                </For>
              </ul>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
}
