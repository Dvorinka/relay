import { createResource, For, Show } from "solid-js";
import { api } from "../../lib/api";
import { Spinner } from "../../components/ui";
import { markGitHub } from "./GitHub";

// Compact PR list across the project's linked repos — same data as the
// Development panel's PR section, minus issues/commits.
export function PullRequestList(props: { projectId: string }) {
  const [dev] = createResource(
    () => props.projectId,
    (id) => api.projectDevelopment(id),
  );

  const rows = () =>
    (dev()?.repos ?? []).flatMap((r) =>
      r.prs.map((pr) => ({ ...pr, repo: r.repo.full_name })),
    );

  return (
    <div class="min-h-0 flex-1 overflow-y-auto">
      <Show
        when={dev()}
        fallback={
          <div class="flex flex-1 items-center justify-center py-16">
            <Spinner class="h-4 w-4" />
          </div>
        }
      >
        {(d) => (
          <Show
            when={d().repos.length > 0}
            fallback={
              <p class="px-6 py-10 text-center text-[13px] text-muted">
                No repositories linked — link one under GitHub.
              </p>
            }
          >
            <Show
              when={rows().length > 0}
              fallback={
                <p class="px-6 py-10 text-center text-[13px] text-muted">
                  No open pull requests.
                </p>
              }
            >
              <ul class="divide-y divide-border">
                <For each={rows()}>
                  {(pr) => (
                    <li>
                      <a
                        href={pr.url}
                        target="_blank"
                        rel="noreferrer"
                        class="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-hover"
                      >
                        <span
                          class={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${
                            pr.state === "merged"
                              ? "border-violet-400/40 text-violet-400"
                              : pr.state === "closed"
                                ? "border-border text-muted"
                                : "border-emerald-400/40 text-emerald-400"
                          }`}
                        >
                          <svg
                            viewBox="0 0 16 16"
                            class="h-3.5 w-3.5"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.5"
                            aria-hidden="true"
                          >
                            <circle cx="4.5" cy="4" r="2" />
                            <circle cx="4.5" cy="12" r="2" />
                            <circle cx="11.5" cy="12" r="2" />
                            <path d="M4.5 6v4M11.5 10V6.5a2 2 0 0 0-2-2h-1" />
                          </svg>
                        </span>
                        <div class="min-w-0 flex-1">
                          <p class="truncate text-[13.5px] font-medium">
                            {pr.title}
                            <Show when={pr.draft}>
                              <span class="ml-2 rounded border border-border px-1 font-mono text-[10px] text-muted">
                                draft
                              </span>
                            </Show>
                          </p>
                          <p class="mt-0.5 flex items-center gap-2 truncate text-[12px] text-muted">
                            {markGitHub("", "h-3 w-3")}
                            <span class="font-mono">{pr.repo}#{pr.number}</span>
                            <span>
                              {pr.head} → {pr.base}
                            </span>
                            <span>· {pr.author}</span>
                          </p>
                        </div>
                      </a>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        )}
      </Show>
    </div>
  );
}
