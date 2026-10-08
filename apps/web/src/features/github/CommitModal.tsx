import {
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { api } from "../../lib/api";
import { timeAgo } from "../../lib/time";
import { ExternalLinkIcon, XIcon } from "../../components/icons";
import { Spinner } from "../../components/ui";

// In-app commit view — clicking a commit anywhere (rail strip, git log)
// opens this modal instead of sending the user out to github.com.
// Module-level target signal + a host mounted in App, same pattern as
// ProfileModal.

type Target = { projectId: string; repo: string; sha: string } | null;

const [target, setTarget] = createSignal<Target>(null);

export function openCommit(projectId: string, repo: string, sha: string) {
  setTarget({ projectId, repo, sha });
}

export function CommitModalHost() {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") setTarget(null);
  };
  window.addEventListener("keydown", onKey);
  onCleanup(() => window.removeEventListener("keydown", onKey));
  return (
    <Show when={target()} keyed>
      {(t) => (
        <CommitModal
          projectId={t.projectId}
          repo={t.repo}
          sha={t.sha}
          onClose={() => setTarget(null)}
        />
      )}
    </Show>
  );
}

const CHECK_STYLE: Record<string, string> = {
  success: "text-emerald-500",
  failure: "text-red-500",
  cancelled: "text-muted",
  skipped: "text-muted",
  neutral: "text-muted",
};

const FILE_STYLE: Record<string, string> = {
  added: "text-emerald-500",
  modified: "text-amber-500",
  removed: "text-red-500",
  renamed: "text-sky-500",
};

function CommitModal(props: {
  projectId: string;
  repo: string;
  sha: string;
  onClose: () => void;
}) {
  const [detail] = createResource(
    () => `${props.repo}@${props.sha}`,
    () => api.repoCommit(props.projectId, props.repo, props.sha),
  );
  const commit = () => detail()?.commit;

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div class="flex max-h-[85vh] w-full max-w-xl flex-col rounded-xl border border-border bg-surface shadow-xl">
        <div class="flex items-center gap-3 border-b border-border px-5 py-3">
          <span class="shrink-0 font-mono text-[13px] font-medium text-accent">
            {props.sha.slice(0, 7)}
          </span>
          <span class="min-w-0 flex-1 truncate text-[12.5px] text-muted">
            <Show when={detail.state === "ready"}>
              {commit()?.author} · {timeAgo(commit()!.date)}
              <Show when={commit()?.repo?.full_name}>
                {" "}
                · {commit()!.repo!.full_name}
              </Show>
            </Show>
          </span>
          <Show when={commit()?.url}>
            {(url) => (
              <a
                href={url()}
                target="_blank"
                rel="noreferrer"
                aria-label="Open on GitHub"
                title="Open on GitHub"
                class="shrink-0 rounded p-1 text-muted transition-colors hover:bg-hover hover:text-fg"
              >
                <ExternalLinkIcon class="h-4 w-4" />
              </a>
            )}
          </Show>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Close"
            class="shrink-0 rounded p-1 text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <XIcon class="h-4 w-4" />
          </button>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <Show
            when={detail.state === "ready" && detail()}
            keyed
            fallback={
              <div class="flex justify-center py-10">
                <Show
                  when={detail.state === "errored"}
                  fallback={<Spinner class="h-4 w-4" />}
                >
                  <p class="text-[13px] text-muted">
                    Could not load this commit
                  </p>
                </Show>
              </div>
            }
          >
            {(d) => (
              <>
                <pre class="whitespace-pre-wrap break-words rounded-md border border-border bg-bg px-3 py-2 font-mono text-[12.5px] leading-relaxed">
                  {d.commit.message}
                </pre>
                <p class="mt-3 font-mono text-[12px]">
                  <span class="text-emerald-500">+{d.commit.additions}</span>{" "}
                  <span class="text-red-500">-{d.commit.deletions}</span>
                  <span class="text-muted">
                    {" "}
                    across {d.files.length}{" "}
                    {d.files.length === 1 ? "file" : "files"}
                  </span>
                </p>

                <Show when={d.files.length > 0}>
                  <ul class="mt-2 divide-y divide-border rounded-md border border-border">
                    <For each={d.files}>
                      {(f) => (
                        <li class="flex items-center gap-2.5 px-3 py-1.5">
                          <span
                            class={`w-3 shrink-0 text-center font-mono text-[11px] font-semibold ${FILE_STYLE[f.status] ?? "text-muted"}`}
                          >
                            {f.status.slice(0, 1).toUpperCase()}
                          </span>
                          <span class="min-w-0 flex-1 truncate font-mono text-[12px]">
                            {f.filename}
                          </span>
                          <span class="shrink-0 font-mono text-[10.5px] tabular-nums">
                            <span class="text-emerald-500">+{f.additions}</span>{" "}
                            <span class="text-red-500">-{f.deletions}</span>
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>

                <Show when={d.checks.length > 0}>
                  <h3 class="mb-1.5 mt-4 text-[11px] font-semibold uppercase tracking-wider text-muted">
                    Checks
                  </h3>
                  <ul class="divide-y divide-border rounded-md border border-border">
                    <For each={d.checks}>
                      {(ch) => (
                        <li class="flex items-center gap-2.5 px-3 py-1.5 text-[12.5px]">
                          <span
                            class={`h-2 w-2 shrink-0 rounded-full ${
                              ch.status === "completed"
                                ? (CHECK_STYLE[ch.conclusion] ?? "text-muted").replace("text-", "bg-")
                                : "bg-amber-500"
                            }`}
                          />
                          <span class="min-w-0 flex-1 truncate">{ch.name}</span>
                          <span
                            class={`shrink-0 text-[11px] ${ch.status === "completed" ? (CHECK_STYLE[ch.conclusion] ?? "text-muted") : "text-amber-500"}`}
                          >
                            {ch.status === "completed"
                              ? ch.conclusion
                              : ch.status.replaceAll("_", " ")}
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}
