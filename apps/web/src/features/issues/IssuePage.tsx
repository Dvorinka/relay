import type {
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
                <GitHubBadge issue={i} />
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
                  />
                </Show>

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
