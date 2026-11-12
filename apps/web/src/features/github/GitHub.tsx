import type {
  DevelopmentPanel as DevPanel,
  DevRepoPanel,
  LinkedRepo,
  WorkflowRun,
} from "@relay/api-client";
import { A, useNavigate } from "@solidjs/router";
import { Avatar } from "@ark-ui/solid";
import type { JSX } from "solid-js";
import {
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { Spinner } from "../../components/ui";
import { ThreadIcon } from "../../components/icons";
import { api } from "../../lib/api";
import { subscribe } from "../../lib/events";
import { confirmDestructive } from "../../components/Confirm";
import { Markdown } from "../../lib/markdown";
import { timeAgo } from "../../lib/time";
import { initials } from "../../lib/text";
import { openCommit } from "./CommitModal";
import { openCreateIssue, openCreatePull } from "./CreateModals";
import { openGhIssue } from "./GitHubIssueModal";

export function markGitHub(path: string, cls = "h-4 w-4") {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" class={cls} aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

// GhAvatar shows a GitHub user's avatar with initials fallback. avatar_url
// hotlinks straight to avatars.githubusercontent.com — img-src https: already
// covers it, no proxy needed.
export function GhAvatar(props: {
  author: string;
  url?: string;
  class?: string;
}) {
  return (
    <Avatar.Root
      class={`flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-surface ${props.class ?? "h-5 w-5"}`}
    >
      <Avatar.Fallback class="text-[8px] font-semibold text-muted">
        {initials(props.author)}
      </Avatar.Fallback>
      <Avatar.Image
        src={props.url}
        alt=""
        class="h-full w-full rounded-full object-cover"
      />
    </Avatar.Root>
  );
}

// GhLabelChip renders one GitHub label in its own color — the API returns
// bare hex (no #), absent for labels created outside GitHub's palette.
export function GhLabelChip(props: {
  label: { name: string; color?: string };
}) {
  const c = () => (props.label.color ? `#${props.label.color}` : undefined);
  return (
    <span
      class={`rounded-full border px-1.5 text-[10px] ${c() ? "" : "border-border"}`}
      style={
        c()
          ? {
              "border-color": `${c()}66`,
              color: c(),
              "background-color": `${c()}1a`,
            }
          : undefined
      }
    >
      {props.label.name}
    </span>
  );
}

// isGhBot spots GitHub App/bot authors — the API's `type` field says "Bot"
// reliably; the [bot] suffix stays as the fallback for older payloads.
export function isGhBot(login: string, type?: string): boolean {
  return type === "Bot" || login.endsWith("[bot]");
}

// GhAuthor renders a GitHub login with avatar — the highlighted filer on
// every issue/PR row. Bots get a small badge instead of pretending human.
export function GhAuthor(props: {
  author: string;
  url?: string;
  type?: string;
  avatarClass?: string;
}) {
  return (
    <span class="flex items-center gap-1.5 text-fg">
      <GhAvatar
        author={props.author}
        url={props.url}
        class={props.avatarClass ?? "h-4.5 w-4.5"}
      />
      <span class="font-medium">{props.author}</span>
      <Show when={isGhBot(props.author, props.type)}>
        <span class="rounded border border-border px-1 text-[9.5px] uppercase tracking-wide text-muted">
          bot
        </span>
      </Show>
    </span>
  );
}

// GhIssueMeta renders labels + assignees with an inline editor — the
// catalogs lazy-load on first expand and the PATCH replaces each set
// wholesale. Shared by the issue modal and the PR detail.
export function GhIssueMeta(props: {
  projectId: string;
  repo: string;
  number: number;
  labels: { name: string; color?: string }[];
  assignees: { login: string; avatar_url?: string }[];
  onApplied: (r: {
    labels: { name: string; color?: string }[];
    assignees: { login: string; avatar_url?: string }[];
  }) => void;
}) {
  const [editing, setEditing] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal("");
  // Draft selections seed from the live values each time editing opens.
  const [draftLabels, setDraftLabels] = createSignal<string[]>([]);
  const [draftAssignees, setDraftAssignees] = createSignal<string[]>([]);
  const [catalogs, { mutate: mutateCatalogs }] = createResource(
    () => (editing() ? `${props.repo}` : null),
    () =>
      Promise.all([
        api.repoLabels(props.projectId, props.repo),
        api.repoAssignees(props.projectId, props.repo),
      ]),
  );

  // Inline label creation — POSTs to the repo's label list, then the new
  // label lands in the catalog pre-checked.
  const [creatingLabel, setCreatingLabel] = createSignal(false);
  const [labelName, setLabelName] = createSignal("");
  const [labelColor, setLabelColor] = createSignal("#888888");
  const [labelBusy, setLabelBusy] = createSignal(false);
  const createLabel = async () => {
    const name = labelName().trim();
    if (!name || labelBusy()) return;
    setLabelBusy(true);
    setErr("");
    try {
      const l = await api.createRepoLabel(props.projectId, props.repo, {
        name,
        color: labelColor().replace("#", ""),
      });
      mutateCatalogs((c) =>
        c ? [{ labels: [...c[0].labels, { name: l.name, color: l.color ?? "", description: l.description ?? "" }] }, c[1]] : c,
      );
      setDraftLabels((d) => (d.includes(l.name) ? d : [...d, l.name]));
      setLabelName("");
      setCreatingLabel(false);
    } catch {
      setErr("Could not create the label");
    } finally {
      setLabelBusy(false);
    }
  };

  const toggle = (list: () => string[], set: (v: string[]) => void, v: string) =>
    set(list().includes(v) ? list().filter((x) => x !== v) : [...list(), v]);

  const open = () => {
    setDraftLabels(props.labels.map((l) => l.name));
    setDraftAssignees(props.assignees.map((a) => a.login));
    setErr("");
    setEditing(true);
  };

  const apply = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await api.updateGitHubIssue(props.projectId, props.repo, {
        number: props.number,
        labels: draftLabels(),
        assignees: draftAssignees(),
      });
      props.onApplied(r);
      setEditing(false);
    } catch {
      setErr("Could not update — check permissions");
    } finally {
      setBusy(false);
    }
  };

  return (
    <span class="block w-full">
      <span class="flex flex-wrap items-center gap-2">
        <For each={props.labels}>{(l) => <GhLabelChip label={l} />}</For>
        <Show when={props.assignees.length > 0}>
          <span
            class="flex items-center -space-x-1.5"
            title={`Assigned: ${props.assignees.map((a) => a.login).join(", ")}`}
          >
            <For each={props.assignees.slice(0, 4)}>
              {(a) => (
                <GhAvatar author={a.login} url={a.avatar_url} class="h-4.5 w-4.5" />
              )}
            </For>
          </span>
        </Show>
        <button
          type="button"
          onClick={() => (editing() ? setEditing(false) : open())}
          class="rounded border border-border px-1.5 py-0.5 text-[10.5px] text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          {editing() ? "cancel" : "edit labels & assignees"}
        </button>
      </span>
      <Show when={editing()}>
        <div class="mt-2 grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
          <div>
            <p class="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
              Labels
            </p>
            <Show
              when={catalogs.latest}
              fallback={<Spinner class="h-3.5 w-3.5" />}
            >
              <div class="max-h-36 space-y-1 overflow-y-auto">
                <For each={catalogs.latest![0].labels}>
                  {(l) => (
                    <label class="flex cursor-pointer items-center gap-2 text-[12px]">
                      <input
                        type="checkbox"
                        checked={draftLabels().includes(l.name)}
                        onChange={() =>
                          toggle(draftLabels, setDraftLabels, l.name)
                        }
                        class="accent-accent"
                      />
                      <span
                        class="h-2.5 w-2.5 rounded-full"
                        style={{ "background-color": `#${l.color}` }}
                        title={l.description}
                      />
                      {l.name}
                    </label>
                  )}
                </For>
              </div>
              <div class="mt-1.5 border-t border-border/60 pt-1.5">
                <Show
                  when={!creatingLabel()}
                  fallback={
                    <div class="flex items-center gap-1.5">
                      <input
                        type="color"
                        value={labelColor()}
                        onInput={(e) => setLabelColor(e.currentTarget.value)}
                        class="h-5 w-6 cursor-pointer rounded border border-border bg-transparent p-0"
                        title="Label color"
                      />
                      <input
                        value={labelName()}
                        onInput={(e) => setLabelName(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void createLabel();
                          }
                        }}
                        class="min-w-0 flex-1 rounded border border-border bg-transparent px-1.5 py-0.5 text-[11.5px] text-fg outline-none focus:border-accent"
                        placeholder="label name"
                      />
                      <button
                        type="button"
                        disabled={labelBusy() || !labelName().trim()}
                        onClick={() => void createLabel()}
                        class="rounded border border-border px-1.5 py-0.5 text-[10.5px] text-fg hover:bg-hover disabled:opacity-50"
                      >
                        {labelBusy() ? "…" : "Create"}
                      </button>
                    </div>
                  }
                >
                  <button
                    type="button"
                    onClick={() => setCreatingLabel(true)}
                    class="text-[10.5px] text-muted hover:text-fg"
                  >
                    + new label
                  </button>
                </Show>
              </div>
            </Show>
          </div>
          <div>
            <p class="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
              Assignees
            </p>
            <Show
              when={catalogs.latest}
              fallback={<Spinner class="h-3.5 w-3.5" />}
            >
              <div class="max-h-36 space-y-1 overflow-y-auto">
                <For each={catalogs.latest![1].users}>
                  {(u) => (
                    <label class="flex cursor-pointer items-center gap-2 text-[12px]">
                      <input
                        type="checkbox"
                        checked={draftAssignees().includes(u.login)}
                        onChange={() =>
                          toggle(draftAssignees, setDraftAssignees, u.login)
                        }
                        class="accent-accent"
                      />
                      <GhAvatar author={u.login} url={u.avatar_url} class="h-4 w-4" />
                      {u.login}
                      <Show when={u.type === "Bot"}>
                        <span class="text-[10px] text-muted">bot</span>
                      </Show>
                    </label>
                  )}
                </For>
              </div>
            </Show>
          </div>
          <div class="flex items-center gap-2 sm:col-span-2">
            <button
              type="button"
              disabled={busy()}
              onClick={() => void apply()}
              class="rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-accent-fg disabled:opacity-50"
            >
              {busy() ? "Applying…" : "Apply"}
            </button>
            <Show when={err()}>
              <span class="text-[12px] text-red-500">{err()}</span>
            </Show>
          </div>
        </div>
      </Show>
    </span>
  );
}

function RepoLinker(props: {
  projectId: string;
  workspaceId: string;
  onLinked: () => void;
}) {
  const [repos, { refetch }] = createResource(
    () => props.workspaceId,
    (ws) => api.listAvailableRepos(ws),
  );
  const [busy, setBusy] = createSignal<string | null>(null);
  const [err, setErr] = createSignal("");

  async function link(full: string) {
    const repo = repos()?.repos.find((r) => r.full_name === full);
    if (!repo) return;
    setBusy(full);
    setErr("");
    try {
      await api.linkRepo(props.projectId, {
        installation_id: repo.installation_id,
        owner: repo.owner,
        name: repo.name,
        default_branch: repo.default_branch,
      });
      props.onLinked();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Link failed");
      setBusy(null);
    }
  }

  const [installUrl, setInstallUrl] = createSignal<string>();
  const [installCount, setInstallCount] = createSignal<number>();
  createResource(
    () => props.workspaceId,
    async (ws) => {
      const inst = await api.listGitHubInstallations(ws);
      setInstallUrl(inst.install_url);
      setInstallCount(inst.installations.length);
      return inst.installations.length;
    },
  );

  return (
    <div class="rounded-md border border-border bg-surface p-4">
      <div class="flex items-center gap-2">
        {markGitHub("", "h-4 w-4 text-fg")}
        <h3 class="text-[13px] font-semibold">Connect a repository</h3>
      </div>
      <Switch>
        <Match when={repos.state === "ready" && (repos()?.repos.length ?? 0) > 0}>
          <p class="mt-1.5 text-[12px] text-muted">
            Repositories your GitHub App installation can see. Linking mirrors
            issues and powers the development panel.
          </p>
          <ul class="mt-3 divide-y divide-border rounded-md border border-border">
            <For each={repos()?.repos}>
              {(r) => (
                <li class="flex items-center justify-between gap-3 px-3 py-2">
                  <div class="min-w-0">
                    <p class="truncate font-mono text-[12.5px]">{r.full_name}</p>
                    <Show when={r.private}>
                      <span class="text-[10.5px] text-muted">private</span>
                    </Show>
                  </div>
                  <button
                    type="button"
                    disabled={busy() !== null}
                    onClick={() => link(r.full_name)}
                    class="shrink-0 rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-hover disabled:opacity-50"
                  >
                    {busy() === r.full_name ? "Linking…" : "Link"}
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Match>
        <Match when={repos.state === "ready"}>
          <p class="mt-1.5 text-[12px] text-muted">
            No repositories available. Install the Relay GitHub App on the
            repositories you want to connect.
          </p>
          <Show when={installUrl()}>
            <a
              href={installUrl()}
              class="mt-3 inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white"
            >
              {markGitHub("", "h-3.5 w-3.5")}
              Install the GitHub App
            </a>
          </Show>
          <Show when={installUrl() === undefined && repos.state === "ready"}>
            <p class="mt-2 text-[12px] text-muted">
              A workspace admin must first register the GitHub App in workspace
              settings.
            </p>
          </Show>
        </Match>
        <Match when={repos.state === "errored"}>
          <div class="mt-2">
            <Show
              when={installUrl()}
              fallback={
                <>
                  <p class="text-[12px] text-muted">
                    GitHub is not connected for this workspace.
                  </p>
                  <A
                    href="/app/settings"
                    class="mt-2 inline-block rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-hover"
                  >
                    Connect in Settings
                  </A>
                </>
              }
            >
              <Show
                when={(installCount() ?? 0) === 0}
                fallback={
                  <>
                    <p class="text-[12px] text-muted">
                      Could not list repositories.
                    </p>
                    <button
                      type="button"
                      onClick={() => refetch()}
                      class="mt-2 rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-hover"
                    >
                      Retry
                    </button>
                  </>
                }
              >
                <p class="text-[12px] text-muted">
                  No repositories available. Install the Relay GitHub App on
                  the repositories you want to connect.
                </p>
                <a
                  href={installUrl()}
                  class="mt-3 inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white"
                >
                  {markGitHub("", "h-3.5 w-3.5")}
                  Install the GitHub App
                </a>
              </Show>
            </Show>
          </div>
        </Match>
        <Match when={true}>
          <div class="mt-4 flex justify-center">
            <Spinner class="h-4 w-4" />
          </div>
        </Match>
      </Switch>
      <Show when={err()}>
        <p class="mt-2 text-[12px] text-danger">{err()}</p>
      </Show>
    </div>
  );
}

function IssueRow(
  props: DevRepoPanel["issues"][number] & { projectId: string; repo: string },
) {
  return (
    <li class="flex items-center gap-2.5 px-3 py-1.5">
      <span
        class={`h-2 w-2 shrink-0 rounded-full border-2 ${
          props.state === "closed" ? "border-violet-400" : "border-emerald-500"
        }`}
      />
      <button
        type="button"
        onClick={() => openGhIssue(props.projectId, props.repo, props.number)}
        class="min-w-0 flex-1 truncate text-left text-[13px] hover:underline"
      >
        {props.title}
      </button>
      <span class="shrink-0 font-mono text-[11px] text-muted">
        #{props.number}
      </span>
      <span class="shrink-0 text-[11px]">
        <GhAuthor author={props.author} url={props.avatar_url} type={props.author_type} />
      </span>
      <Show when={(props.comments ?? 0) > 0}>
        <span class="flex shrink-0 items-center gap-1 text-[11px] text-muted">
          <ThreadIcon class="h-3 w-3" />
          {props.comments}
        </span>
      </Show>
      <span class="w-20 shrink-0 text-right text-[11px] text-muted">
        {timeAgo(props.updated_at)}
      </span>
    </li>
  );
}

function PrRow(props: DevRepoPanel["prs"][number] & { projectId: string; repo: string }) {
  const navigate = useNavigate();
  return (
    <li class="flex items-center gap-2.5 px-3 py-1.5">
      <svg
        viewBox="0 0 16 16"
        fill="currentColor"
        class="h-3.5 w-3.5 shrink-0 text-violet-400"
        aria-hidden="true"
      >
        <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354Z" />
      </svg>
      <button
        type="button"
        onClick={() =>
          navigate(
            `/app/p/${props.projectId}?view=pulls&pr=${encodeURIComponent(`${props.repo}:${props.number}`)}`,
          )
        }
        class="min-w-0 flex-1 truncate text-left text-[13px] hover:underline"
      >
        {props.title}
      </button>
      <Show when={props.draft}>
        <span class="shrink-0 rounded border border-border px-1 text-[10px] text-muted">
          draft
        </span>
      </Show>
      <span class="shrink-0 font-mono text-[11px] text-muted">
        {props.head} → {props.base}
      </span>
      <span class="shrink-0 text-[11px]">
        <GhAuthor author={props.author} url={props.avatar_url} type={props.author_type} />
      </span>
    </li>
  );
}

function CommitRow(props: DevRepoPanel["commits"][number] & { repo: string; projectId: string }) {
  return (
    <li class="flex items-center gap-2.5 px-3 py-1.5">
      <span class="shrink-0 font-mono text-[11px] text-accent">
        {props.sha.slice(0, 7)}
      </span>
      <button
        type="button"
        onClick={() => openCommit(props.projectId, props.repo, props.sha)}
        class="min-w-0 flex-1 truncate text-left text-[13px] hover:underline"
      >
        {props.message}
      </button>
      <a
        href={props.url}
        target="_blank"
        rel="noreferrer"
        aria-label="Open commit on GitHub"
        class="shrink-0 text-muted transition-colors hover:text-fg"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class="h-3 w-3" aria-hidden="true">
          <path d="M6 3h7v7M13 3 7.5 8.5" />
        </svg>
      </a>
      <span class="shrink-0 text-[11px] text-muted">{props.author}</span>
      <span class="w-20 shrink-0 text-right text-[11px] text-muted">
        {timeAgo(props.date)}
      </span>
    </li>
  );
}

const RUN_NEUTRAL = { cls: "text-muted", mark: "○" };
const RUN_STYLE: Record<string, { cls: string; mark: string }> = {
  success: { cls: "text-emerald-500", mark: "●" },
  failure: { cls: "text-red-500", mark: "●" },
  cancelled: RUN_NEUTRAL,
  skipped: RUN_NEUTRAL,
  neutral: RUN_NEUTRAL,
  in_progress: { cls: "text-amber-500", mark: "◐" },
  queued: { cls: "text-amber-500", mark: "◐" },
  requested: { cls: "text-amber-500", mark: "◐" },
  waiting: { cls: "text-amber-500", mark: "◐" },
};

function runMark(r: WorkflowRun) {
  return (
    RUN_STYLE[r.status !== "completed" ? r.status : r.conclusion] ??
    RUN_NEUTRAL
  );
}

// Actions runs for one repo — the CI/CD readout plus an in-app rerun
// button for finished runs. Details link out to GitHub.
function ActionsRuns(props: { projectId: string; repo: string }) {
  const [runs, { refetch }] = createResource(
    () => props.repo,
    (r) => api.repoActions(props.projectId, r).catch(() => undefined),
  );
  // webhook → bus → SSE: a check/workflow event on this repo refreshes the list
  const unsub = subscribe((e) => {
    if (e.type === "stream.resync") {
      void refetch();
      return;
    }
    if (e.type === "github.ci" && e.data?.repo === props.repo) void refetch();
  });
  onCleanup(unsub);
  const [rerunning, setRerunning] = createSignal<number | null>(null);
  const [err, setErr] = createSignal("");
  const rerun = async (id: number) => {
    setRerunning(id);
    setErr("");
    try {
      await api.rerunAction(props.projectId, props.repo, id);
      // the run flips to queued — give GitHub a beat then refresh
      setTimeout(() => void refetch(), 1500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Rerun failed");
    } finally {
      setRerunning(null);
    }
  };
  return (
    <Show when={(runs()?.runs.length ?? 0) > 0}>
      <Section title={`CI runs (${runs()?.runs.length ?? 0})`}>
        <For each={runs()!.runs}>
          {(r) => (
            <li class="flex items-center gap-2.5 px-3 py-1.5">
              <span
                class={`shrink-0 text-[10px] ${runMark(r).cls}`}
                title={`${r.status}${r.conclusion ? ` · ${r.conclusion}` : ""}`}
              >
                {runMark(r).mark}
              </span>
              <span class="min-w-0 flex-1 truncate text-[13px]">
                {r.name}
                <span class="ml-1.5 font-mono text-[11px] text-muted">
                  #{r.run_number}
                </span>
              </span>
              <span class="hidden shrink-0 font-mono text-[11px] text-muted md:inline">
                {r.head_branch}
              </span>
              <span class="shrink-0 text-[11px] text-muted">
                {r.event} · {timeAgo(r.created_at)}
              </span>
              <Show when={r.status === "completed"}>
                <button
                  type="button"
                  disabled={rerunning() === r.id}
                  onClick={() => void rerun(r.id)}
                  class="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
                >
                  {rerunning() === r.id ? "Rerunning…" : "Rerun"}
                </button>
              </Show>
              <a
                href={r.url}
                target="_blank"
                rel="noreferrer"
                aria-label="Open run on GitHub"
                class="shrink-0 text-muted transition-colors hover:text-fg"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class="h-3 w-3" aria-hidden="true">
                  <path d="M6 3h7v7M13 3 7.5 8.5" />
                </svg>
              </a>
            </li>
          )}
        </For>
        <Show when={err()}>
          <li class="px-3 py-1.5 text-[12px] text-danger">{err()}</li>
        </Show>
      </Section>
    </Show>
  );
}

// Branches + README render in-app so "Development" never sends the user
// out to GitHub; file content arrives through the GitHub files proxy.
function RepoExtras(props: { projectId: string; repo: string }) {
  const [branches] = createResource(
    () => props.repo,
    (r) => api.repoBranches(props.projectId, r).catch(() => undefined),
  );
  const [readme] = createResource(
    () => props.repo,
    async (r) => {
      for (const path of ["README.md", "README", "readme.md"]) {
        try {
          const f = await api.repoFileRead(props.projectId, r, path);
          if (f.content) return f;
        } catch {
          /* try the next common filename */
        }
      }
      return undefined;
    },
  );
  const [readmeOpen, setReadmeOpen] = createSignal(false);

  return (
    <>
      <ActionsRuns projectId={props.projectId} repo={props.repo} />
      <Section title={`Branches (${branches()?.branches.length ?? 0})`}>
        <Show
          when={branches() && branches()!.branches.length > 0}
          fallback={
            <li class="px-3 py-2 text-[12px] text-muted">
              {branches() === undefined ? "Loading…" : "No branches"}
            </li>
          }
        >
          <For each={branches()!.branches.slice(0, 12)}>
            {(b) => (
              <li class="flex items-center gap-2.5 px-3 py-1.5">
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  class="h-3.5 w-3.5 shrink-0 text-muted"
                  aria-hidden="true"
                >
                  <circle cx="4.5" cy="3.5" r="1.8" />
                  <circle cx="4.5" cy="12.5" r="1.8" />
                  <circle cx="11.5" cy="6.5" r="1.8" />
                  <path d="M4.5 5.3v5.4" />
                  <path d="M11.5 8.3c0 1.7-1.4 2.7-3.2 2.7H6.3" />
                </svg>
                <span class="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                  {b.name}
                </span>
                <Show when={b.name === branches()!.default_branch}>
                  <span class="shrink-0 rounded border border-border px-1 text-[10px] text-muted">
                    default
                  </span>
                </Show>
                <Show when={b.protected}>
                  <span class="shrink-0 text-[10px] text-muted">protected</span>
                </Show>
              </li>
            )}
          </For>
          <Show when={(branches()?.branches.length ?? 0) > 12}>
            <li class="px-3 py-1.5 text-[11px] text-muted">
              +{(branches()!.branches.length ?? 0) - 12} more
            </li>
          </Show>
        </Show>
      </Section>

      <Show when={readme()}>
        {(f) => (
          <Section title={f().path}>
            <li class="px-3 py-2">
              <button
                type="button"
                onClick={() => setReadmeOpen((v) => !v)}
                class="text-[12px] text-accent hover:underline"
              >
                {readmeOpen() ? "Hide README" : "Show README"}
              </button>
              <Show when={readmeOpen()}>
                <div class="mt-2 max-h-96 overflow-auto rounded-md bg-surface p-3">
                  <Markdown
                    body={f().content.slice(0, 20000)}
                    allowHtml
                    class="text-[13px]"
                  />
                </div>
              </Show>
            </li>
          </Section>
        )}
      </Show>
    </>
  );
}

function Section(props: {
  title: string;
  action?: JSX.Element;
  children: JSX.Element;
}) {
  return (
    <div class="mt-4">
      <h4 class="mb-1 flex items-center justify-between px-1 text-[11px] font-medium uppercase tracking-wider text-muted">
        {props.title}
        {props.action}
      </h4>
      <ul class="divide-y divide-border rounded-md border border-border">
        {props.children}
      </ul>
    </div>
  );
}

export function DevelopmentPanel(props: {
  projectId: string;
  workspaceId: string;
}) {
  const [linked, { refetch: refetchLinked }] = createResource(
    () => props.projectId,
    (id) => api.listProjectRepos(id),
  );
  const [dev, { refetch: refetchDev }] = createResource(
    () => (linked.state === "ready" && (linked()?.repos.length ?? 0) > 0
      ? props.projectId
      : undefined),
    (id) => api.projectDevelopment(id),
  );
  // Mirror flips (issue.updated), CI runs (github.ci) and reconnects repaint
  // the linked list and snapshot — repo link/unlink has no event yet.
  const unsubDev = subscribe((e) => {
    if (e.type === "stream.resync") {
      void refetchLinked();
      return;
    }
    if (e.project_id !== props.projectId) return;
    if (e.type.startsWith("issue.") || e.type === "github.ci") {
      void refetchLinked();
      void refetchDev();
    }
  });
  onCleanup(unsubDev);
  const [confirm, setConfirm] = createSignal<string | null>(null);
  const [importing, setImporting] = createSignal<string | null>(null);
  const [importMsg, setImportMsg] = createSignal<Record<string, string>>({});

  async function runImport(repoId: string) {
    setImporting(repoId);
    setImportMsg((m) => ({ ...m, [repoId]: "" }));
    try {
      const res = await api.importGitHub(props.projectId, repoId);
      const r = res.results[0];
      if (!r) return;
      const msg = r.error
        ? `Import failed — ${r.error}`
        : `Issues: +${r.issues.created} new, ${r.issues.updated} refreshed · PRs: +${r.prs.created} new, ${r.prs.updated} refreshed${r.truncated ? " · capped at 500 per kind" : ""}`;
      setImportMsg((m) => ({ ...m, [repoId]: msg }));
    } catch (err) {
      setImportMsg((m) => ({
        ...m,
        [repoId]: err instanceof Error ? err.message : "Import failed",
      }));
    } finally {
      setImporting(null);
    }
  }

  const hasRepos = createMemo(() => (linked.latest?.repos.length ?? 0) > 0);

  return (
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto w-full max-w-3xl px-6 py-6">
        <Show when={hasRepos()}>
          <For each={linked.latest?.repos}>
            {(repo: LinkedRepo) => (
              <>
                <div class="mb-2 flex items-center justify-between rounded-md border border-border bg-surface px-3 py-2">
                <div class="flex items-center gap-2">
                  {markGitHub("", "h-3.5 w-3.5 text-muted")}
                  <a
                    href={repo.url}
                    target="_blank"
                    rel="noreferrer"
                    class="font-mono text-[12.5px] hover:underline"
                  >
                    {repo.full_name}
                  </a>
                  <span class="text-[11px] text-muted">
                    {repo.default_branch}
                  </span>
                </div>
                <div class="flex items-center gap-3">
                  <button
                    type="button"
                    disabled={importing() === repo.id}
                    onClick={() => runImport(repo.id)}
                    class="text-[11.5px] font-medium text-accent hover:underline disabled:opacity-50"
                  >
                    {importing() === repo.id ? "Importing…" : "Import issues & PRs"}
                  </button>
                  <Show
                    when={confirm() === repo.id}
                    fallback={
                      <button
                        type="button"
                        onClick={() => setConfirm(repo.id)}
                        class="text-[11.5px] text-muted hover:text-danger"
                      >
                        Unlink
                      </button>
                    }
                  >
                  <button
                    type="button"
                    onClick={async () => {
                      if (
                        !(await confirmDestructive({
                          title: "Unlink repository",
                          body: `Unlink ${repo.full_name ?? repo.id}? Mirrored issues and PRs stay; syncing stops.`,
                          confirmLabel: "Unlink",
                        }))
                      )
                        return;
                      await api.unlinkRepo(props.projectId, repo.id);
                      setConfirm(null);
                      refetchLinked();
                    }}
                    class="text-[11.5px] font-medium text-danger"
                  >
                    Confirm unlink
                  </button>
                </Show>
                </div>
              </div>
                <Show when={importMsg()[repo.id]}>
                  {(msg) => (
                    <p class="mb-2 px-1 text-[11.5px] text-muted">{msg()}</p>
                  )}
                </Show>
              </>
            )}
          </For>
        </Show>

        <Switch>
          <Match when={linked.state === "ready" && !hasRepos()}>
            <RepoLinker
              projectId={props.projectId}
              workspaceId={props.workspaceId}
              onLinked={() => refetchLinked()}
            />
          </Match>
          <Match when={dev.state === "pending" || linked.state === "pending"}>
            <div class="flex justify-center py-12">
              <Spinner />
            </div>
          </Match>
          <Match when={dev.state === "errored"}>
            <p class="py-8 text-center text-[13px] text-muted">
              Could not load development data.
            </p>
          </Match>
          <Match when={dev.latest}>
            {(d: () => DevPanel) => (
              <>
                <p class="mt-1 text-[11px] text-muted">
                  Fetched {timeAgo(d().fetched_at)} — cached 60s
                </p>
                <For each={d().repos}>
                  {(rp) => (
                    <div class="mt-4">
                      <h3 class="flex items-center gap-2 text-[13px] font-semibold">
                        {markGitHub("", "h-3.5 w-3.5")}
                        {rp.repo.full_name}
                      </h3>
                      <Show when={rp.error}>
                        <p class="mt-1 px-1 text-[12px] text-danger">
                          {rp.error}
                        </p>
                      </Show>
                      <Section
                        title={`Open issues (${rp.issues.length})`}
                        action={
                          <button
                            class="rounded px-1.5 py-0.5 normal-case tracking-normal text-accent hover:bg-surface-2"
                            onClick={() =>
                              openCreateIssue(props.projectId, rp.repo.full_name)
                            }
                          >
                            + New issue
                          </button>
                        }
                      >
                        <For
                          each={rp.issues}
                          fallback={
                            <li class="px-3 py-2 text-[12px] text-muted">
                              None open
                            </li>
                          }
                        >
                          {(i) => (
                            <IssueRow
                              {...i}
                              projectId={props.projectId}
                              repo={rp.repo.full_name}
                            />
                          )}
                        </For>
                      </Section>
                      <Section
                        title={`Pull requests (${rp.prs.length})`}
                        action={
                          <button
                            class="rounded px-1.5 py-0.5 normal-case tracking-normal text-accent hover:bg-surface-2"
                            onClick={() =>
                              openCreatePull(props.projectId, rp.repo.full_name)
                            }
                          >
                            + New PR
                          </button>
                        }
                      >
                        <For
                          each={rp.prs}
                          fallback={
                            <li class="px-3 py-2 text-[12px] text-muted">
                              None open
                            </li>
                          }
                        >
                          {(p) => (
                            <PrRow
                              {...p}
                              projectId={props.projectId}
                              repo={rp.repo.full_name}
                            />
                          )}
                        </For>
                      </Section>
                      <Section title="Recent commits">
                        <For
                          each={rp.commits}
                          fallback={
                            <li class="px-3 py-2 text-[12px] text-muted">
                              No commits
                            </li>
                          }
                        >
                          {(c) => (
                            <CommitRow
                              {...c}
                              repo={rp.repo.full_name}
                              projectId={props.projectId}
                            />
                          )}
                        </For>
                      </Section>
                      <RepoExtras
                        projectId={props.projectId}
                        repo={rp.repo.full_name}
                      />
                    </div>
                  )}
                </For>
              </>
            )}
          </Match>
        </Switch>
      </div>
    </div>
  );
}
