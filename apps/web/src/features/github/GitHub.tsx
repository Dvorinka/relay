import type {
  DevelopmentPanel as DevPanel,
  DevRepoPanel,
  LinkedRepo,
} from "@relay/api-client";
import { A } from "@solidjs/router";
import type { JSX } from "solid-js";
import {
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import { Spinner } from "../../components/ui";
import { api } from "../../lib/api";
import { timeAgo } from "../../lib/time";

export function markGitHub(path: string, cls = "h-4 w-4") {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" class={cls} aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
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

function IssueRow(props: {
  number: number;
  title: string;
  url: string;
  author: string;
  updated_at: string;
}) {
  return (
    <li class="flex items-center gap-2.5 px-3 py-1.5">
      <span class="h-2 w-2 shrink-0 rounded-full border-2 border-emerald-500" />
      <a
        href={props.url}
        target="_blank"
        rel="noreferrer"
        class="min-w-0 flex-1 truncate text-[13px] hover:underline"
      >
        {props.title}
      </a>
      <span class="shrink-0 font-mono text-[11px] text-muted">
        #{props.number}
      </span>
      <span class="w-20 shrink-0 text-right text-[11px] text-muted">
        {timeAgo(props.updated_at)}
      </span>
    </li>
  );
}

function PrRow(props: DevRepoPanel["prs"][number]) {
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
      <a
        href={props.url}
        target="_blank"
        rel="noreferrer"
        class="min-w-0 flex-1 truncate text-[13px] hover:underline"
      >
        {props.title}
      </a>
      <Show when={props.draft}>
        <span class="shrink-0 rounded border border-border px-1 text-[10px] text-muted">
          draft
        </span>
      </Show>
      <span class="shrink-0 font-mono text-[11px] text-muted">
        {props.head} → {props.base}
      </span>
    </li>
  );
}

function CommitRow(props: DevRepoPanel["commits"][number]) {
  return (
    <li class="flex items-center gap-2.5 px-3 py-1.5">
      <span class="shrink-0 font-mono text-[11px] text-accent">
        {props.sha.slice(0, 7)}
      </span>
      <a
        href={props.url}
        target="_blank"
        rel="noreferrer"
        class="min-w-0 flex-1 truncate text-[13px] hover:underline"
      >
        {props.message}
      </a>
      <span class="shrink-0 text-[11px] text-muted">{props.author}</span>
      <span class="w-20 shrink-0 text-right text-[11px] text-muted">
        {timeAgo(props.date)}
      </span>
    </li>
  );
}

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <div class="mt-4">
      <h4 class="mb-1 px-1 text-[11px] font-medium uppercase tracking-wider text-muted">
        {props.title}
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
  const [dev] = createResource(
    () => (linked.state === "ready" && (linked()?.repos.length ?? 0) > 0
      ? props.projectId
      : undefined),
    (id) => api.projectDevelopment(id),
  );
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

  const hasRepos = createMemo(() => (linked()?.repos.length ?? 0) > 0);

  return (
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto w-full max-w-3xl px-6 py-6">
        <Show when={hasRepos()}>
          <For each={linked()?.repos}>
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
          <Match when={dev()}>
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
                      <Section title={`Open issues (${rp.issues.length})`}>
                        <For
                          each={rp.issues}
                          fallback={
                            <li class="px-3 py-2 text-[12px] text-muted">
                              None open
                            </li>
                          }
                        >
                          {(i) => <IssueRow {...i} />}
                        </For>
                      </Section>
                      <Section title={`Pull requests (${rp.prs.length})`}>
                        <For
                          each={rp.prs}
                          fallback={
                            <li class="px-3 py-2 text-[12px] text-muted">
                              None open
                            </li>
                          }
                        >
                          {(p) => <PrRow {...p} />}
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
                          {(c) => <CommitRow {...c} />}
                        </For>
                      </Section>
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
