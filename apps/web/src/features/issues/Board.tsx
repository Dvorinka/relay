import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { subscribe } from "../../lib/events";
import { A, useParams } from "@solidjs/router";
import { api } from "../../lib/api";
import type { Issue, IssueStatus, Project, Todo } from "@relay/api-client";
import { GitHubBadge, LabelChip, PriorityGlyph, STATUS_LABEL, StatusDot } from "./meta";

const COLUMNS: IssueStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "done",
];

export function Board(props: { project: Project }) {
  const [issues, { refetch }] = createResource(
    () => props.project.id,
    async (id) => (await api.listIssues(id)).issues,
  );
  const [todos, { refetch: refetchTodos }] = createResource(
    () => props.project.id,
    async (id) => (await api.listTodos(id)).todos,
  );

  const unsub = subscribe((e) => {
    if (e.project_id !== props.project.id) return;
    if (e.type.startsWith("issue.")) refetch();
    if (e.type === "todo.changed") refetchTodos();
  });
  onCleanup(unsub);

  const move = async (issue: Issue, status: IssueStatus) => {
    if (issue.status === status) return;
    await api.updateIssue(issue.id, { status });
    refetch();
  };

  return (
    <div class="flex min-h-0 flex-1 flex-col gap-4 px-6 py-4">
      <div class="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-1">
        <For each={COLUMNS}>
          {(status) => (
            <div
              class="flex w-60 shrink-0 flex-col rounded-lg border border-border bg-surface/50"
              onDragOver={(e) => {
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer?.getData("text/relay-issue");
                const issue = issues()?.find((i) => i.id === id);
                if (issue) void move(issue, status);
              }}
            >
              <div class="flex items-center justify-between border-b border-border px-3 py-2">
                <div class="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.12em] text-muted">
                  <StatusDot status={status} class="h-1.5 w-1.5" />
                  {STATUS_LABEL[status]}
                </div>
                <div class="text-[11px] text-muted/70">
                  {issues()?.filter((i) => i.status === status).length ?? 0}
                </div>
              </div>
              <div class="flex min-h-16 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
                <For each={issues()?.filter((i) => i.status === status)}>
                  {(issue) => (
                    <A
                      href={`/app/p/${props.project.id}/i/${issue.id}`}
                      draggable="true"
                      onDragStart={(e) =>
                        e.dataTransfer?.setData("text/relay-issue", issue.id)
                      }
                      class="rounded-md border border-border bg-bg p-2.5 transition-colors hover:border-accent/50"
                    >
                      <div class="flex items-center gap-1.5">
                        <span class="font-mono text-[10.5px] text-muted">
                          {issue.key}
                        </span>
                        <PriorityGlyph priority={issue.priority} class="h-2.5 w-2.5" />
                        <GitHubBadge issue={issue} />
                      </div>
                      <div class="mt-1.5 text-[13px] leading-snug">
                        {issue.title}
                      </div>
                      <Show when={issue.labels.length > 0}>
                        <div class="mt-2 flex flex-wrap gap-1">
                          <For each={issue.labels.slice(0, 3)}>
                            {(l) => <LabelChip label={l} />}
                          </For>
                        </div>
                      </Show>
                    </A>
                  )}
                </For>
              </div>
            </div>
          )}
        </For>
      </div>

      <TodoStrip project={props.project} todos={todos() ?? []} onChange={() => refetchTodos()} />
    </div>
  );
}

function TodoStrip(props: {
  project: Project;
  todos: Todo[];
  onChange: () => void;
}) {
  let input: HTMLInputElement | undefined;
  const [busy, setBusy] = createSignal(false);

  const add = async (e: Event) => {
    e.preventDefault();
    const content = input?.value.trim();
    if (!content || busy()) return;
    setBusy(true);
    try {
      await api.createTodo(props.project.id, content);
      if (input) input.value = "";
      props.onChange();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="shrink-0 rounded-lg border border-border bg-surface/50">
      <div class="flex items-center justify-between border-b border-border px-3 py-2">
        <div class="text-[11px] font-medium uppercase tracking-[0.12em] text-muted">
          Work list
        </div>
        <div class="text-[11px] text-muted/70">
          {props.todos.filter((t) => !t.done).length} open · agents manage this
          through MCP and the relay CLI
        </div>
      </div>
      <div class="flex max-h-40 flex-col gap-px overflow-y-auto p-1.5">
        <For
          each={props.todos}
          fallback={
            <div class="px-2 py-2 text-[12px] text-muted">
              Nothing queued. Agents add items via `todo_add` — or add one
              below.
            </div>
          }
        >
          {(t) => (
            <div class="group flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-hover/60">
              <input
                type="checkbox"
                checked={t.done}
                class="h-3.5 w-3.5 accent-accent"
                onChange={() =>
                  void api.updateTodo(t.id, { done: !t.done }).then(props.onChange)
                }
              />
              <span
                class="flex-1 text-[13px]"
                classList={{
                  "line-through text-muted": t.done,
                }}
              >
                {t.content}
              </span>
              <Show when={t.issue}>
                {(i) => (
                  <A
                    href={`/app/p/${props.project.id}/i/${i().id}`}
                    class="font-mono text-[10.5px] text-accent hover:underline"
                  >
                    {i().key}
                  </A>
                )}
              </Show>
              <Show when={t.agent}>
                {(a) => (
                  <span class="rounded border border-violet-500/40 px-1.5 py-0.5 text-[10px] text-violet-500 dark:text-violet-300">
                    {a().name}
                  </span>
                )}
              </Show>
              <button
                type="button"
                class="invisible px-1 text-muted transition-colors group-hover:visible hover:text-red-500"
                onClick={() => void api.deleteTodo(t.id).then(props.onChange)}
                title="Remove"
                aria-label="Remove todo"
              >
                ×
              </button>
            </div>
          )}
        </For>
      </div>
      <form onSubmit={add} class="flex gap-2 border-t border-border p-2">
        <input
          ref={input}
          maxlength={500}
          placeholder="Add a work item…"
          class="h-8 flex-1 rounded-md border border-border bg-bg px-2.5 text-[13px] outline-none placeholder:text-muted/60 focus:border-accent"
        />
        <button
          type="submit"
          disabled={busy()}
          class="h-8 rounded-md border border-border px-2.5 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
        >
          Add
        </button>
      </form>
    </section>
  );
}
