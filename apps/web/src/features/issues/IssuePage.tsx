import type {
  AgentReview,
  Issue,
  IssueActivity,
  UpdateIssueRequest,
} from "@relay/api-client";
import { A, useParams } from "@solidjs/router";
import { createResource, createSignal, For, Show } from "solid-js";
import { FormError, Spinner } from "../../components/ui";
import { api } from "../../lib/api";
import { Markdown } from "../../lib/markdown";
import { timeAgo } from "../../lib/time";
import { Conversation } from "../conversations/Conversation";
import { ReviewStatusChip } from "../reviews/Reviews";
import { statusDefs } from "./meta";
import { AssigneeSelect, LabelsPicker, PrioritySelect, StatusSelect } from "./fields";
import { GitHubBadge, LabelChip, statusLabel } from "./meta";

function activityText(a: IssueActivity): string {
  const payload = a.payload ?? {};
  const from = typeof payload["from"] === "string" ? payload["from"] : null;
  const to = typeof payload["to"] === "string" ? payload["to"] : null;
  const field =
    typeof payload["field"] === "string" ? payload["field"] : null;
  switch (a.kind) {
    case "created":
      return "created the issue";
    case "status_changed":
      return from && to
        ? `changed status ${statusLabel(from)} → ${statusLabel(to)}`
        : "changed status";
    case "field_changed":
      if (field && (from !== null || to !== null)) {
        return `changed ${field} from ${from ?? "none"} to ${to ?? "none"}`;
      }
      return field ? `changed ${field}` : "updated fields";
    case "commented":
      return "commented";
    case "from_message":
      return "converted from a message";
    default:
      return a.kind.replaceAll("_", " ");
  }
}

// Compact list of agent work reviews linked to this issue; clicking through
// lands on the project's Reviews tab.
function IssueReviews(props: { issueId: string; projectId: string }) {
  const [data] = createResource(
    () => props.issueId,
    (id) => api.issueReviews(id).then((r) => r.reviews),
  );
  return (
    <Show when={(data() ?? []).length > 0}>
      <h2 class="mb-2 mt-8 text-[13px] font-semibold">
        Agent reviews ({data()!.length})
      </h2>
      <ul class="flex flex-col gap-1.5">
        <For each={data() ?? []}>
          {(r: AgentReview) => (
            <li>
              <A
                href={`/app/p/${props.projectId}?tab=reviews`}
                class="flex items-center gap-2.5 rounded-md border border-border px-3 py-2 transition-colors hover:bg-hover"
              >
                <ReviewStatusChip status={r.status} />
                <span class="min-w-0 flex-1 truncate text-[13px]">
                  {r.title}
                </span>
                <span class="shrink-0 text-[11px] text-muted">
                  {r.agent?.name} · {timeAgo(r.created_at)}
                </span>
              </A>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

function ActivityFeed(props: { activity: IssueActivity[] }) {
  return (
    <ul class="flex flex-col gap-2.5">
      <For
        each={props.activity}
        fallback={<li class="text-[13px] text-muted">No activity yet</li>}
      >
        {(a) => (
          <li class="flex items-baseline gap-2 text-[13px]">
            <Show
              when={a.actor}
              fallback={<span class="font-medium text-muted">Someone</span>}
            >
              {(actor) => (
                <span class="font-medium">{actor().name}</span>
              )}
            </Show>
            <span class="text-muted">{activityText(a)}</span>
            <span
              class="shrink-0 text-[11px] text-muted"
              title={new Date(a.created_at).toLocaleString()}
            >
              {timeAgo(a.created_at)}
            </span>
          </li>
        )}
      </For>
    </ul>
  );
}

function EditableTitle(props: {
  issue: Issue;
  saving: boolean;
  onSave: (title: string) => Promise<void>;
}) {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");

  function start() {
    setDraft(props.issue.title);
    setEditing(true);
  }

  async function commit() {
    const t = draft().trim();
    setEditing(false);
    if (t && t !== props.issue.title) {
      await props.onSave(t);
    }
  }

  return (
    <Show
      when={!editing()}
      fallback={
        <input
          ref={(el) => {
            el.focus();
            el.select();
          }}
          type="text"
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setEditing(false);
            }
          }}
          disabled={props.saving}
          aria-label="Issue title"
          maxlength={200}
          class="w-full rounded-md border border-border bg-bg px-2 py-1 text-[15px] font-semibold outline-none focus:border-accent"
        />
      }
    >
      <h1
        class="cursor-text rounded px-2 py-1 text-[15px] font-semibold tracking-tight hover:bg-hover"
        title="Click to edit"
        onClick={start}
      >
        {props.issue.title}
      </h1>
    </Show>
  );
}

function PushToGitHub(props: {
  projectId: string;
  issueId: string;
  onPushed: () => void;
}) {
  const [repos] = createResource(
    () => props.projectId,
    async (id) => (await api.listProjectRepos(id)).repos,
  );
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  const [repoId, setRepoId] = createSignal("");

  const push = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.pushIssueToGitHub(props.issueId, repoId() || undefined);
      props.onPushed();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Push failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Show when={repos() && repos()!.length > 0}>
      <div class="flex items-center gap-1.5">
        <Show when={repos()!.length > 1}>
          <select
            class="rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] text-muted"
            value={repoId()}
            onChange={(e) => setRepoId(e.currentTarget.value)}
          >
            <option value="">Pick repo…</option>
            <For each={repos()}>
              {(r) => <option value={r.id}>{r.full_name}</option>}
            </For>
          </select>
        </Show>
        <button
          type="button"
          disabled={busy() || (repos()!.length > 1 && !repoId())}
          onClick={push}
          title={repos()!.length === 1 ? repos()!.at(0)?.full_name : undefined}
          class="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[10.5px] text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" class="h-3 w-3" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>
          {busy() ? "Pushing…" : "Push to GitHub"}
        </button>
        <Show when={err()}>
          <span class="text-[11px] text-red-500">{err()}</span>
        </Show>
      </div>
    </Show>
  );
}

export default function IssuePage() {
  const params = useParams<{ projectId: string; issueId: string }>();
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);

  const [detail, { refetch }] = createResource(
    () => params.issueId,
    (id) => api.getIssue(id),
  );
  const [project] = createResource(
    () => params.projectId,
    (id) => api.getProject(id),
  );
  const [members] = createResource(
    () => project()?.workspace_id ?? null,
    async (id) => (await api.listWorkspaceMembers(id)).members,
  );
  const [labels, { mutate: mutateLabels }] = createResource(
    () => params.projectId,
    async (id) => (await api.listLabels(id)).labels,
  );
  const [thread] = createResource(
    () => params.issueId,
    (id) => api.getIssueConversation(id),
  );

  const issue = () => detail()?.issue;

  async function patch(body: UpdateIssueRequest) {
    if (saving()) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await api.updateIssue(params.issueId, body);
      await refetch();
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : "Could not update issue",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="flex h-full flex-col">
      <Show
        when={issue()}
        keyed
        fallback={
          <div class="flex min-h-0 flex-1 items-center justify-center">
            <Show when={detail.state === "errored"} fallback={<Spinner />}>
              <p class="text-[13px] text-muted">Issue not found</p>
            </Show>
          </div>
        }
      >
        {(i) => (
          <>
            <header class="shrink-0 px-6 pt-5">
              <div class="flex items-center gap-2 text-[13px] text-muted">
                <A
                  href={`/app/p/${params.projectId}`}
                  class="transition-colors hover:text-fg"
                >
                  {project()?.name ?? "Project"}
                </A>
                <span>/</span>
                <span class="rounded border border-border px-1.5 py-0.5 font-mono text-[11px]">
                  {i.key}
                </span>
                <Show
                  when={i.github}
                  fallback={
                    <PushToGitHub
                      projectId={params.projectId}
                      issueId={params.issueId}
                      onPushed={() => void refetch()}
                    />
                  }
                >
                  <GitHubBadge issue={i} />
                </Show>
              </div>
              <div class="mt-2 max-w-3xl">
                <EditableTitle
                  issue={i}
                  saving={saving()}
                  onSave={(title) => patch({ title })}
                />
              </div>
            </header>

            <div class="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto px-6 py-5 lg:flex-row">
              <div class="min-w-0 flex-1">
                <h2 class="mb-2 text-[13px] font-semibold">Description</h2>
                <Show
                  when={i.description.trim().length > 0}
                  fallback={
                    <p class="text-[13px] text-muted/60">No description</p>
                  }
                >
                  <Markdown
                    body={i.description}
                    class="max-w-3xl"
                    projectId={params.projectId}
                    allowHtml={i.github != null}
                  />
                </Show>

                <IssueReviews
                  issueId={params.issueId}
                  projectId={params.projectId}
                />

                <h2 class="mb-3 mt-8 text-[13px] font-semibold">Activity</h2>
                <ActivityFeed activity={detail()?.activity ?? []} />

                <h2 class="mb-3 mt-8 text-[13px] font-semibold">Thread</h2>
                <div class="flex min-h-72 flex-col rounded-md border border-border">
                  <Show
                    when={thread()}
                    keyed
                    fallback={
                      <div class="flex flex-1 items-center justify-center py-8">
                        <Show
                          when={thread.state === "errored"}
                          fallback={<Spinner />}
                        >
                          <p class="text-[13px] text-muted">
                            Could not load thread
                          </p>
                        </Show>
                      </div>
                    }
                  >
                    {(c) => (
                      <Conversation
                        projectId={params.projectId}
                        conversation={c}
                      />
                    )}
                  </Show>
                </div>
              </div>

              <aside class="w-full shrink-0 lg:w-64">
                <div class="flex flex-col gap-4 rounded-md border border-border bg-surface p-4">
                  <div>
                    <p class="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted">
                      Status
                    </p>
                    <StatusSelect
                      value={i.status}
                      onChange={(v) => void patch({ status: v })}
                      disabled={saving()}
                      defs={statusDefs(project())}
                    />
                  </div>
                  <div>
                    <p class="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted">
                      Priority
                    </p>
                    <PrioritySelect
                      value={i.priority}
                      onChange={(v) => void patch({ priority: v })}
                      disabled={saving()}
                    />
                  </div>
                  <div>
                    <p class="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted">
                      Assignee
                    </p>
                    <AssigneeSelect
                      members={members() ?? []}
                      value={i.assignee?.id ?? null}
                      onChange={(v) => void patch({ assignee_id: v })}
                      disabled={saving()}
                    />
                  </div>
                  <div>
                    <p class="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted">
                      Labels
                    </p>
                    <Show when={i.labels.length > 0}>
                      <div class="mb-2 flex flex-wrap gap-1.5">
                        <For each={i.labels}>
                          {(l) => <LabelChip label={l} />}
                        </For>
                      </div>
                    </Show>
                    <LabelsPicker
                      projectId={params.projectId}
                      labels={labels() ?? []}
                      value={i.labels.map((l) => l.id)}
                      onChange={(ids) => void patch({ label_ids: ids })}
                      onLabelCreated={(l) =>
                        mutateLabels((cur) => [...(cur ?? []), l])
                      }
                      disabled={saving()}
                    />
                  </div>
                  <div class="border-t border-border pt-3 text-[11px] text-muted">
                    <p>Created {timeAgo(i.created_at)}</p>
                    <p>Updated {timeAgo(i.updated_at)}</p>
                  </div>
                  <FormError message={saveError()} />
                </div>
              </aside>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}
