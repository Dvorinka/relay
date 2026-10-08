import type { PullDetail } from "@relay/api-client";
import {
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { api } from "../../lib/api";
import { subscribe } from "../../lib/events";
import { Markdown } from "../../lib/markdown";
import { timeAgo } from "../../lib/time";
import { FormError, Spinner } from "../../components/ui";
import { confirmDestructive } from "../../components/Confirm";
import { markGitHub } from "./GitHub";
import { openCommit } from "./CommitModal";
import { ArrowLeftIcon, ExternalLinkIcon } from "../../components/icons";

// PullRequestDetail: the in-app PR view — body, CI checks, commits and the
// changed-file list, fetched live through the linked repo's installation.
// Reached by clicking a row in PullRequestList; "Open on GitHub" links out.
export function PullRequestDetail(props: {
  projectId: string;
  repo: string; // owner/name
  number: number;
  onBack: () => void;
}) {
  const [detail, { refetch }] = createResource(
    () => `${props.repo}#${props.number}`,
    () => api.pullDetail(props.projectId, props.repo, props.number),
  );
  // check-run webhooks repaint the Checks section while the page is open
  const unsub = subscribe((e) => {
    if (e.type === "github.ci" && e.data?.repo === props.repo) void refetch();
  });
  onCleanup(unsub);

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <button
          type="button"
          onClick={props.onBack}
          class="flex h-6 w-6 items-center justify-center rounded text-muted transition-colors hover:bg-hover hover:text-fg"
          aria-label="Back to pull requests"
        >
          <ArrowLeftIcon class="h-3.5 w-3.5" />
        </button>
        <span class="min-w-0 flex-1 truncate font-mono text-[12px] text-muted">
          {props.repo}#{props.number}
        </span>
        <Show when={detail.latest?.pull.url}>
          {(url) => (
            <a
              href={url()}
              target="_blank"
              rel="noopener"
              class="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-accent hover:underline"
            >
              Open on GitHub
              <ExternalLinkIcon class="h-3 w-3" />
            </a>
          )}
        </Show>
      </div>

      <Show
        when={detail.latest}
        fallback={
          <div class="flex flex-1 items-center justify-center py-16">
            <Show
              when={detail.error}
              fallback={<Spinner class="h-4 w-4" />}
            >
              {(err) => (
                <FormError
                  message={
                    (err() as Error)?.message ?? "Could not load the pull request"
                  }
                />
              )}
            </Show>
          </div>
        }
      >
        {(d) => (
          <div class="min-h-0 flex-1 overflow-y-auto">
            <PRBody
              detail={d()}
              projectId={props.projectId}
              repo={props.repo}
              onMerged={() => void refetch()}
            />
            <PRChecks checks={d().checks} />
            <PRCommits
              commits={d().commits}
              projectId={props.projectId}
              repo={props.repo}
            />
            <PRFiles files={d().files} />
          </div>
        )}
      </Show>
    </div>
  );
}

function PRBody(props: {
  detail: PullDetail;
  projectId: string;
  repo: string;
  onMerged: () => void;
}) {
  const pr = () => props.detail.pull;
  const [confirming, setConfirming] = createSignal(false);
  const [method, setMethod] = createSignal<"merge" | "squash" | "rebase">(
    "merge",
  );
  const [merging, setMerging] = createSignal(false);
  const [mergeError, setMergeError] = createSignal("");
  const [reviewBody, setReviewBody] = createSignal("");
  const [reviewBusy, setReviewBusy] = createSignal("");
  const [reviewError, setReviewError] = createSignal("");
  const [stateBusy, setStateBusy] = createSignal(false);
  const [stateError, setStateError] = createSignal("");
  const canMerge = () =>
    state() === "open" && !pr().draft && !merging();
  const doMerge = async () => {
    setMerging(true);
    setMergeError("");
    try {
      await api.mergePullRequest(
        props.projectId,
        props.repo,
        pr().number,
        method(),
      );
      props.onMerged();
    } catch (e) {
      setMergeError(e instanceof Error ? e.message : "Merge failed");
      setConfirming(false);
    } finally {
      setMerging(false);
    }
  };
  const submitReview = async (
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  ) => {
    setReviewBusy(event);
    setReviewError("");
    try {
      if (event === "COMMENT") {
        // plain conversation comment, not a review — matches what users
        // expect from a single text box
        await api.commentOnIssue(
          props.projectId,
          props.repo,
          pr().number,
          reviewBody().trim(),
        );
      } else {
        await api.reviewPullRequest(
          props.projectId,
          props.repo,
          pr().number,
          event,
          reviewBody().trim(),
        );
      }
      setReviewBody("");
      props.onMerged(); // generic "something changed" — refetch detail
    } catch (e) {
      setReviewError(e instanceof Error ? e.message : "Review failed");
    } finally {
      setReviewBusy("");
    }
  };
  const toggleState = async () => {
    const next = pr().state === "open" ? "closed" : "open";
    setStateBusy(true);
    setStateError("");
    try {
      await api.setPullState(props.projectId, props.repo, pr().number, next);
      props.onMerged();
    } catch (e) {
      setStateError(e instanceof Error ? e.message : "State change failed");
    } finally {
      setStateBusy(false);
    }
  };
  const state = () =>
    pr().merged ? "merged" : pr().draft ? "draft" : pr().state;
  const badge = () =>
    state() === "merged"
      ? "border-violet-400/40 bg-violet-500/10 text-violet-500 dark:text-violet-300"
      : state() === "closed"
        ? "border-red-400/40 bg-red-500/10 text-red-500 dark:text-red-300"
        : state() === "draft"
          ? "border-border bg-hover/60 text-muted"
          : "border-emerald-400/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300";

  return (
    <div class="border-b border-border px-4 py-3">
      <div class="flex items-center gap-2">
        <h2 class="min-w-0 flex-1 text-[15px] font-semibold leading-snug">
          {pr().title}
        </h2>
        <span
          class={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize ${badge()}`}
        >
          {state()}
        </span>
      </div>
      <p class="mt-1 text-[12px] text-muted">
        {markGitHub("", "inline-block h-3 w-3 align-[-1px]")}
        <span class="font-mono"> {pr().repo.full_name}#{pr().number}</span>
        <span>
          {" "}
          · {pr().author} · {pr().head} → {pr().base} · opened{" "}
          {timeAgo(pr().created_at)}
        </span>
      </p>
      <div class="mt-1.5 flex flex-wrap items-center gap-2 text-[11.5px] text-muted">
        <span class="text-emerald-600 dark:text-emerald-400">
          +{pr().additions}
        </span>
        <span class="text-red-600 dark:text-red-400">−{pr().deletions}</span>
        <span>
          {pr().changed_files} file{pr().changed_files === 1 ? "" : "s"} ·{" "}
          {pr().commit_count} commit{pr().commit_count === 1 ? "" : "s"}
        </span>
        <Show when={pr().mergeable === "clean"}>
          <span class="text-emerald-600 dark:text-emerald-400">
            mergeable
          </span>
        </Show>
        <Show when={pr().mergeable === "conflicting"}>
          <span class="text-red-600 dark:text-red-400">conflicts</span>
        </Show>
        <For each={pr().labels}>
          {(l) => (
            <span class="rounded-full border border-border px-1.5 text-[10.5px] text-muted">
              {l}
            </span>
          )}
        </For>
      </div>
      <Show when={state() === "open" && !pr().draft}>
        <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
          <Show
            when={!confirming()}
            fallback={
              <>
                <select
                  value={method()}
                  onChange={(e) =>
                    setMethod(
                      e.currentTarget.value as "merge" | "squash" | "rebase",
                    )
                  }
                  class="rounded border border-border bg-transparent px-2 py-1 text-[12px]"
                >
                  <option value="merge">Merge commit</option>
                  <option value="squash">Squash and merge</option>
                  <option value="rebase">Rebase and merge</option>
                </select>
                <button
                  type="button"
                  disabled={!canMerge()}
                  onClick={() => void doMerge()}
                  class="rounded bg-emerald-600 px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
                >
                  {merging() ? "Merging…" : "Confirm merge"}
                </button>
                <button
                  type="button"
                  disabled={merging()}
                  onClick={() => setConfirming(false)}
                  class="rounded px-2 py-1 text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg"
                >
                  Cancel
                </button>
              </>
            }
          >
            <button
              type="button"
              disabled={!canMerge()}
              onClick={() => setConfirming(true)}
              class="rounded bg-emerald-600 px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
            >
              Merge pull request
            </button>
            <span class="text-[11.5px] text-muted">
              {pr().mergeable === "conflicting"
                ? "GitHub reports conflicts — merge may be refused"
                : "GitHub enforces checks and reviews before merging"}
            </span>
          </Show>
        </div>
        <Show when={mergeError()}>
          {(msg) => <div class="mt-2"><FormError message={msg()} /></div>}
        </Show>
      </Show>
      <Show when={state() === "open"}>
        <div class="mt-3 border-t border-border/60 pt-3">
          <label class="mb-1.5 block text-[12px] font-semibold text-muted">
            Review — lands on GitHub as the Relay app
          </label>
          <textarea
            value={reviewBody()}
            onInput={(e) => setReviewBody(e.currentTarget.value)}
            rows={3}
            placeholder="Optional summary — required when requesting changes"
            class="w-full resize-y rounded border border-border bg-transparent px-2 py-1.5 text-[12.5px] outline-none placeholder:text-muted/60 focus:border-accent/50"
          />
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={reviewBusy() !== ""}
              onClick={() => void submitReview("APPROVE")}
              class="rounded bg-emerald-600/90 px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
            >
              {reviewBusy() === "APPROVE" ? "Approving…" : "Approve"}
            </button>
            <button
              type="button"
              disabled={reviewBusy() !== "" || !reviewBody().trim()}
              title={!reviewBody().trim() ? "A body is required" : ""}
              onClick={() => void submitReview("COMMENT")}
              class="rounded border border-border px-2.5 py-1 text-[12px] font-medium transition-colors hover:bg-hover disabled:opacity-50"
            >
              {reviewBusy() === "COMMENT" ? "Commenting…" : "Comment"}
            </button>
            <button
              type="button"
              disabled={reviewBusy() !== "" || !reviewBody().trim()}
              title={!reviewBody().trim() ? "A body is required" : ""}
              onClick={() => void submitReview("REQUEST_CHANGES")}
              class="rounded border border-red-400/50 px-2.5 py-1 text-[12px] font-medium text-red-600 transition-colors hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"
            >
              {reviewBusy() === "REQUEST_CHANGES"
                ? "Requesting…"
                : "Request changes"}
            </button>
            <button
              type="button"
              disabled={stateBusy() || reviewBusy() !== ""}
              onClick={() => {
                void confirmDestructive({
                  title: `Close PR #${pr().number}`,
                  body: "The pull request closes on GitHub. It can be reopened.",
                  confirmLabel: "Close pull request",
                }).then((ok) => {
                  if (ok) void toggleState();
                });
              }}
              class="ml-auto rounded px-2 py-1 text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
            >
              {stateBusy() ? "Closing…" : "Close pull request"}
            </button>
          </div>
          <Show when={reviewError()}>
            {(msg) => <div class="mt-2"><FormError message={msg()} /></div>}
          </Show>
        </div>
      </Show>
      <Show when={state() === "closed"}>
        <div class="mt-3 border-t border-border/60 pt-3">
          <button
            type="button"
            disabled={stateBusy()}
            onClick={() => void toggleState()}
            class="rounded border border-border px-2.5 py-1 text-[12px] font-medium transition-colors hover:bg-hover disabled:opacity-50"
          >
            {stateBusy() ? "Reopening…" : "Reopen pull request"}
          </button>
          <Show when={stateError()}>
            {(msg) => <div class="mt-2"><FormError message={msg()} /></div>}
          </Show>
        </div>
      </Show>
      <Show when={pr().body.trim()}>
        <div class="markdown mt-3 border-t border-border/60 pt-3">
          <Markdown
            body={pr().body}
            projectId={props.projectId}
            allowHtml
          />
        </div>
      </Show>
    </div>
  );
}

function PRChecks(props: { checks: PullDetail["checks"] }) {
  const icon = (c: PullDetail["checks"][number]) =>
    c.status !== "completed"
      ? { cls: "text-amber-500", mark: "◐" }
      : c.conclusion === "success"
        ? { cls: "text-emerald-500", mark: "●" }
        : c.conclusion === "neutral" || c.conclusion === "skipped"
          ? { cls: "text-muted", mark: "○" }
          : { cls: "text-red-500", mark: "●" };
  return (
    <Show when={props.checks.length > 0}>
      <section class="border-b border-border px-4 py-3">
        <h3 class="mb-1.5 text-[12px] font-semibold text-muted">Checks</h3>
        <ul class="flex flex-col gap-1">
          <For each={props.checks}>
            {(c) => {
              const i = icon(c);
              return (
                <li class="flex items-center gap-2 text-[12.5px]">
                  <span class={`${i.cls} text-[10px]`}>{i.mark}</span>
                  <span class="min-w-0 flex-1 truncate">{c.name}</span>
                  <span class="shrink-0 text-[11px] text-muted">
                    {c.status === "completed" ? c.conclusion : c.status}
                  </span>
                  <Show when={c.url}>
                    {(url) => (
                      <a
                        href={url()}
                        target="_blank"
                        rel="noopener"
                        class="shrink-0 text-accent hover:underline"
                        aria-label={`${c.name} details`}
                      >
                        <ExternalLinkIcon class="h-3 w-3" />
                      </a>
                    )}
                  </Show>
                </li>
              );
            }}
          </For>
        </ul>
      </section>
    </Show>
  );
}

function PRCommits(props: {
  commits: PullDetail["commits"];
  projectId: string;
  repo: string;
}) {
  return (
    <Show when={props.commits.length > 0}>
      <section class="border-b border-border px-4 py-3">
        <h3 class="mb-1.5 text-[12px] font-semibold text-muted">Commits</h3>
        <ul class="flex flex-col gap-1">
          <For each={props.commits}>
            {(cm) => (
              <li class="flex items-baseline gap-2 text-[12.5px]">
                <button
                  type="button"
                  onClick={() =>
                    openCommit(props.projectId, props.repo, cm.sha)
                  }
                  class="shrink-0 font-mono text-[11.5px] text-accent hover:underline"
                >
                  {cm.sha.slice(0, 7)}
                </button>
                <span class="min-w-0 flex-1 truncate">{cm.message}</span>
                <span class="shrink-0 text-[11px] text-muted">
                  {cm.author} · {timeAgo(cm.date)}
                </span>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  );
}

function PRFiles(props: { files: PullDetail["files"] }) {
  const statusColor = (s: string) =>
    s === "added"
      ? "text-emerald-600 dark:text-emerald-400"
      : s === "removed"
        ? "text-red-600 dark:text-red-400"
        : "text-muted";
  return (
    <Show when={props.files.length > 0}>
      <section class="px-4 py-3">
        <h3 class="mb-1.5 text-[12px] font-semibold text-muted">
          Changed files
        </h3>
        <ul class="flex flex-col gap-1">
          <For each={props.files}>
            {(f) => (
              <li class="flex items-baseline gap-2 text-[12px]">
                <span class={`shrink-0 font-mono text-[10.5px] ${statusColor(f.status)}`}>
                  {f.status}
                </span>
                <span class="min-w-0 flex-1 truncate font-mono text-[12px]">
                  {f.filename}
                </span>
                <span class="shrink-0 text-[11px]">
                  <span class="text-emerald-600 dark:text-emerald-400">
                    +{f.additions}
                  </span>{" "}
                  <span class="text-red-600 dark:text-red-400">
                    −{f.deletions}
                  </span>
                </span>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  );
}
