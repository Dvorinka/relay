import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { A } from "@solidjs/router";
import { api } from "../../lib/api";
import { subscribe } from "../../lib/events";
import { timeAgo } from "../../lib/time";
import { Spinner, Tip } from "../../components/ui";
import {
  ExternalLinkIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  IssueIcon,
} from "../../components/icons";
import { statusColor } from "./meta";
import type { Issue, Project } from "@relay/api-client";

// Timeline: every live signal of the project — local issues, mirrored GitHub
// issues/PRs, commits — on one spine, newest first. Vertical stacks down;
// horizontal scrolls sideways. Direction persists per device.
type EntryKind = "issue" | "gh-issue" | "pr" | "commit";

type Entry = {
  id: string;
  kind: EntryKind;
  title: string;
  meta: string;
  at: string;
  href?: string;
  external?: string;
  color?: string;
};

const DIR_KEY = "relay.timelineDir";
type Dir = "v" | "h";

function savedDir(): Dir {
  return localStorage.getItem(DIR_KEY) === "h" ? "h" : "v";
}

export function Timeline(props: { project: Project }) {
  const [dir, setDir] = createSignal<Dir>(savedDir());
  const toggle = () => {
    const d = dir() === "v" ? "h" : "v";
    localStorage.setItem(DIR_KEY, d);
    setDir(d);
  };

  const [issues, { refetch: refetchIssues }] = createResource(
    () => props.project.id,
    async (id) => (await api.listIssues(id, {})).issues,
  );
  const [dev, { refetch: refetchDev }] = createResource(
    () => props.project.id,
    (id) => api.projectDevelopment(id).catch(() => undefined),
  );

  // Real-time: any work event re-pulls; the dev bundle is 60s-cached
  // server-side, so it trails by at most a minute.
  const unsub = subscribe((e) => {
    if (e.project_id !== props.project.id) return;
    if (
      e.type.startsWith("issue.") ||
      e.type.startsWith("review.") ||
      e.type.startsWith("github.") ||
      e.type === "todo.changed"
    ) {
      refetchIssues();
      refetchDev();
    }
  });
  onCleanup(unsub);

  const entries = (): Entry[] => {
    const out: Entry[] = [];
    for (const i of (issues() ?? []) as Issue[]) {
      out.push({
        id: `i-${i.id}`,
        kind: i.github?.kind === "pr" ? "pr" : "issue",
        title: i.title,
        meta: `${i.key}${i.assignee ? ` · ${i.assignee.name}` : ""}`,
        at: i.updated_at,
        href: `/app/p/${props.project.id}/i/${i.id}`,
        color: statusColor(i.status, props.project.statuses),
      });
    }
    for (const repo of dev()?.repos ?? []) {
      const repoName = `${repo.repo.owner}/${repo.repo.name}`;
      for (const gi of repo.issues) {
        out.push({
          id: `gi-${repoName}-${gi.number}`,
          kind: "gh-issue",
          title: gi.title,
          meta: `${repoName}#${gi.number} · ${gi.author}`,
          at: gi.updated_at,
          external: gi.url,
        });
      }
      for (const pr of repo.prs) {
        out.push({
          id: `pr-${repoName}-${pr.number}`,
          kind: "pr",
          title: pr.title,
          meta: `${repoName}#${pr.number} · ${pr.author} · ${pr.head}→${pr.base}`,
          at: pr.updated_at ?? "",
          external: pr.url,
        });
      }
      for (const cm of repo.commits) {
        out.push({
          id: `cm-${repoName}-${cm.sha}`,
          kind: "commit",
          title: cm.message,
          meta: `${cm.sha} · ${cm.author}`,
          at: cm.date,
          external: cm.url,
        });
      }
    }
    return out
      .filter((e) => e.at)
      .sort((a, b) => b.at.localeCompare(a.at));
  };

  const iconFor = (e: Entry) => {
    switch (e.kind) {
      case "pr":
        return <GitPullRequestIcon class="h-3.5 w-3.5" />;
      case "commit":
        return <GitBranchIcon class="h-3.5 w-3.5" />;
      default:
        return <IssueIcon class="h-3.5 w-3.5" />;
    }
  };

  const body = (e: Entry) => (
    <>
      <div class="flex items-center gap-1.5">
        <span
          class="shrink-0 text-muted"
          style={e.color ? { color: e.color } : undefined}
        >
          {iconFor(e)}
        </span>
        <span class="min-w-0 flex-1 truncate text-[13px] font-medium">
          {e.title}
        </span>
        <Show when={e.external}>
          <ExternalLinkIcon class="h-3 w-3 shrink-0 text-faint" />
        </Show>
      </div>
      <div class="mt-0.5 flex items-baseline gap-2">
        <span class="min-w-0 flex-1 truncate text-[11px] text-muted">
          {e.meta}
        </span>
        <span class="shrink-0 text-[10.5px] text-faint">{timeAgo(e.at)}</span>
      </div>
    </>
  );

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="flex items-center justify-between px-6 pt-3">
        <span class="text-[11px] font-medium uppercase tracking-[0.12em] text-muted">
          Timeline
        </span>
        <Tip
          text={dir() === "v" ? "Switch to horizontal" : "Switch to vertical"}
          hint="Timeline direction — saved on this device"
          side="bottom"
        >
          <button
            type="button"
            onClick={toggle}
            class="rounded border border-border px-2 py-0.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            {dir() === "v" ? "Horizontal" : "Vertical"}
          </button>
        </Tip>
      </div>
      <Show
        when={issues() !== undefined && dev() !== undefined}
        fallback={
          <div class="flex flex-1 items-center justify-center">
            <Spinner class="h-4 w-4" />
          </div>
        }
      >
        <div
          class={
            dir() === "v"
              ? "min-h-0 flex-1 overflow-y-auto px-6 py-4"
              : "min-h-0 flex-1 overflow-x-auto py-4"
          }
        >
          <Show
            when={entries().length > 0}
            fallback={
              <p class="px-2 py-10 text-center text-[13px] text-muted">
                Nothing on the timeline yet.
              </p>
            }
          >
            <div
              class={
                dir() === "v"
                  ? "relative ml-2 flex flex-col gap-0 border-l border-border pl-4"
                  : "relative ml-1 flex items-start gap-3 border-t border-border pt-4"
              }
            >
              <For each={entries()}>
                {(e) => (
                  <div
                    class={
                      dir() === "v"
                        ? "relative pb-4"
                        : "relative w-56 shrink-0 pt-1"
                    }
                  >
                    <span
                      class={
                        dir() === "v"
                          ? "absolute -left-[21px] top-1.5 h-2 w-2 rounded-full border border-border bg-surface"
                          : "absolute -top-[21px] left-1.5 h-2 w-2 rounded-full border border-border bg-surface"
                      }
                      style={
                        e.color ? { "background-color": e.color } : undefined
                      }
                    />
                    <Show
                      when={e.href}
                      fallback={
                        <a
                          href={e.external}
                          target="_blank"
                          rel="noreferrer"
                          class="block rounded-md border border-transparent px-2 py-1.5 transition-colors hover:border-border hover:bg-surface/60"
                        >
                          {body(e)}
                        </a>
                      }
                    >
                      {(href) => (
                        <A
                          href={href()}
                          class="block rounded-md border border-transparent px-2 py-1.5 transition-colors hover:border-border hover:bg-surface/60"
                        >
                          {body(e)}
                        </A>
                      )}
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
