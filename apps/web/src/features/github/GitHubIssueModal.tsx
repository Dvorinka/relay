import {
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { api } from "../../lib/api";
import { Markdown } from "../../lib/markdown";
import { timeAgo } from "../../lib/time";
import {
  CircleDotIcon,
  ExternalLinkIcon,
  ThreadIcon,
  XIcon,
} from "../../components/icons";
import { Spinner } from "../../components/ui";
import { GhAuthor, GhIssueMeta } from "./GitHub";

// In-app GitHub issue view — workspace Issues rows that are not mirrored
// open this instead of dead-ending on the project's issues view.
// Same host pattern as CommitModal.

type Target = { projectId: string; repo: string; number: number } | null;

const [target, setTarget] = createSignal<Target>(null);

export function openGhIssue(projectId: string, repo: string, number: number) {
  setTarget({ projectId, repo, number });
}

export function GitHubIssueModalHost() {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") setTarget(null);
  };
  window.addEventListener("keydown", onKey);
  onCleanup(() => window.removeEventListener("keydown", onKey));
  return (
    <Show when={target()} keyed>
      {(t) => (
        <GitHubIssueModal
          projectId={t.projectId}
          repo={t.repo}
          number={t.number}
          onClose={() => setTarget(null)}
        />
      )}
    </Show>
  );
}

function GitHubIssueModal(props: {
  projectId: string;
  repo: string;
  number: number;
  onClose: () => void;
}) {
  const [detail, { refetch, mutate }] = createResource(
    () => `${props.repo}#${props.number}`,
    () => api.issueDetail(props.projectId, props.repo, props.number),
  );
  const [body, setBody] = createSignal("");
  const [busy, setBusy] = createSignal<"comment" | "state" | null>(null);
  const [error, setError] = createSignal("");
  const issue = () => detail()?.issue;

  // Inline title/body editor — PATCH issues/{n} upstream.
  const [editing, setEditing] = createSignal(false);
  const [editBusy, setEditBusy] = createSignal(false);
  const [draftTitle, setDraftTitle] = createSignal("");
  const [draftBody, setDraftBody] = createSignal("");
  const startEdit = () => {
    const iss = issue();
    if (!iss) return;
    setDraftTitle(iss.title);
    setDraftBody(iss.body);
    setEditing(true);
  };
  const saveEdit = async () => {
    const iss = issue();
    if (!iss || editBusy() || !draftTitle().trim()) return;
    setEditBusy(true);
    setError("");
    try {
      const r = await api.updateGitHubIssue(props.projectId, props.repo, {
        number: iss.number,
        title: draftTitle().trim(),
        body: draftBody(),
      });
      mutate((d) =>
        d
          ? { ...d, issue: { ...d.issue, title: r.title, body: r.body } }
          : d,
      );
      setEditing(false);
    } catch {
      setError("Could not save the issue");
    } finally {
      setEditBusy(false);
    }
  };

  const postComment = async () => {
    const text = body().trim();
    if (!text || busy()) return;
    setBusy("comment");
    setError("");
    try {
      await api.commentOnIssue(props.projectId, props.repo, props.number, text);
      setBody("");
      refetch();
    } catch {
      setError("Could not post the comment");
    } finally {
      setBusy(null);
    }
  };

  const toggleState = async () => {
    const iss = issue();
    if (!iss || busy()) return;
    const next = iss.state === "open" ? "closed" : "open";
    setBusy("state");
    setError("");
    try {
      await api.setIssueState(props.projectId, props.repo, props.number, next);
      mutate((d) =>
        d ? { ...d, issue: { ...d.issue, state: next } } : d,
      );
    } catch {
      setError(`Could not ${next === "closed" ? "close" : "reopen"} the issue`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div class="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-surface shadow-xl">
        <div class="flex items-center gap-2.5 border-b border-border px-5 py-3">
          <CircleDotIcon
            class={`h-4 w-4 shrink-0 ${
              issue()?.state === "closed" ? "text-violet-500" : "text-emerald-500"
            }`}
          />
          <span class="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">
            <Show when={detail.state === "ready"} fallback={`${props.repo}#${props.number}`}>
              {issue()?.title}
              <span class="ml-2 font-normal text-muted">
                {props.repo}#{props.number}
              </span>
            </Show>
          </span>
          <Show when={issue()?.url}>
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
            when={detail.state === "ready" && issue()}
            fallback={
              <div class="flex justify-center py-10">
                <Show
                  when={detail.state === "errored"}
                  fallback={<Spinner class="h-4 w-4" />}
                >
                  <p class="text-[13px] text-muted">Could not load this issue</p>
                </Show>
              </div>
            }
          >
            {(iss) => (
              <>
                <div class="flex flex-wrap items-center gap-2 text-[12px] text-muted">
                  <span
                    class={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      iss().state === "closed"
                        ? "bg-violet-500/15 text-violet-500"
                        : "bg-emerald-500/15 text-emerald-500"
                    }`}
                  >
                    {iss().state}
                  </span>
                  <GhAuthor
                    author={iss().author}
                    url={iss().avatar_url}
                    type={iss().author_type}
                  />
                  <span>opened {timeAgo(iss().created_at)}</span>
                  <Show when={iss().comment_count > 0}>
                    <span class="flex items-center gap-1">
                      <ThreadIcon class="h-3 w-3" />
                      {iss().comment_count}
                    </span>
                  </Show>
                  <Show when={iss().milestone}>
                    <span class="rounded border border-border px-1.5 py-0.5 text-[11px]">
                      {iss().milestone}
                    </span>
                  </Show>
                  <button
                    type="button"
                    onClick={startEdit}
                    class="ml-auto rounded border border-border px-1.5 py-0.5 text-[10.5px] text-muted transition-colors hover:bg-hover hover:text-fg"
                  >
                    edit
                  </button>
                </div>

                <div class="mt-2">
                  <GhIssueMeta
                    projectId={props.projectId}
                    repo={props.repo}
                    number={iss().number}
                    labels={iss().labels ?? []}
                    assignees={iss().assignees ?? []}
                    onApplied={(r) =>
                      mutate((d) =>
                        d
                          ? {
                              ...d,
                              issue: {
                                ...d.issue,
                                labels: r.labels,
                                assignees: r.assignees,
                              },
                            }
                          : d,
                      )
                    }
                  />
                </div>

                <Show
                  when={!editing()}
                  fallback={
                    <div class="mt-3 space-y-2">
                      <input
                        value={draftTitle()}
                        onInput={(e) => setDraftTitle(e.currentTarget.value)}
                        class="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-[13px] text-fg outline-none focus:border-accent"
                        placeholder="Title"
                      />
                      <textarea
                        value={draftBody()}
                        onInput={(e) => setDraftBody(e.currentTarget.value)}
                        rows={8}
                        class="w-full resize-y rounded-lg border border-border bg-transparent px-3 py-2 text-[13px] text-fg outline-none placeholder:text-muted focus:border-accent"
                        placeholder="Body (markdown)"
                      />
                      <div class="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={editBusy() || !draftTitle().trim()}
                          onClick={() => void saveEdit()}
                          class="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-fg disabled:opacity-50"
                        >
                          {editBusy() ? "Saving…" : "Save"}
                        </button>
                        <button
                          type="button"
                          disabled={editBusy()}
                          onClick={() => setEditing(false)}
                          class="rounded-md border border-border px-3 py-1.5 text-[12px] text-muted hover:bg-hover hover:text-fg"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  }
                >
                  <Show when={iss().body?.trim()}>
                    <div class="markdown mt-3 rounded-lg border border-border/60 px-3 py-2">
                      <Markdown body={iss().body} />
                    </div>
                  </Show>
                </Show>

                <Show when={(detail()?.comments.length ?? 0) > 0}>
                  <div class="mt-4 border-t border-border/60 pt-3">
                    <For each={detail()!.comments}>
                      {(cm) => (
                        <div class="mb-3 flex gap-2.5">
                          <div class="min-w-0 flex-1">
                            <div class="flex items-center gap-2 text-[12px] text-muted">
                              <GhAuthor
                                author={cm.author}
                                url={cm.avatar_url}
                                type={cm.author_type}
                              />
                              <span>{timeAgo(cm.created_at)}</span>
                            </div>
                            <div class="markdown mt-1">
                              <Markdown body={cm.body} />
                            </div>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </>
            )}
          </Show>
        </div>

        <Show when={detail.state === "ready" && issue()}>
          {(iss) => (
            <div class="border-t border-border px-5 py-3">
              <Show when={error()}>
                <p class="mb-2 text-[12px] text-red-500">{error()}</p>
              </Show>
              <textarea
                value={body()}
                onInput={(e) => setBody(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey))
                    void postComment();
                }}
                rows={2}
                placeholder="Leave a comment on GitHub"
                class="w-full resize-y rounded-lg border border-border bg-transparent px-3 py-2 text-[13px] text-fg outline-none placeholder:text-muted focus:border-accent"
              />
              <div class="mt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={busy() !== null}
                  onClick={toggleState}
                  class="rounded-md border border-border px-3 py-1.5 text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
                >
                  {busy() === "state"
                    ? "…"
                    : iss().state === "open"
                      ? "Close issue"
                      : "Reopen issue"}
                </button>
                <button
                  type="button"
                  disabled={busy() !== null || !body().trim()}
                  onClick={postComment}
                  title={!body().trim() ? "A comment is required" : ""}
                  class="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {busy() === "comment" ? "…" : "Comment"}
                </button>
              </div>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}
