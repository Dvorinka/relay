import { useNavigate, useSearchParams } from "@solidjs/router";
import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import type { Idea } from "@relay/api-client";
import { api } from "../../lib/api";
import { timeAgo } from "../../lib/time";
import { confirmDestructive } from "../../components/Confirm";
import {
  BulbIcon,
  CheckIcon,
  ChevronLeftIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from "../../components/icons";
import { inputClass, primaryButtonClass, Spinner } from "../../components/ui";
import { Select } from "../../components/Select";
import { SceneEditor } from "../briefs/SceneEditor";
import { BoardCanvas, type BoardDoc } from "./BoardCanvas";
import { Markdown } from "../../lib/markdown";
import { useProjects } from "../../stores/projects";
import { useSession } from "../../stores/session";
import { activeWorkspace } from "../../stores/workspace";

const STATUS_STYLE: Record<string, string> = {
  open: "bg-accent/15 text-accent",
  converted: "bg-emerald-500/15 text-emerald-500",
  archived: "bg-surface-2 text-muted",
};

// IdeasPage — the workspace's brainstorm shelf. Ideas are workspace-scoped:
// platform-wide by default, optionally attached to one project. Once an idea
// turns into real work it converts into an issue or a new project.
export default function IdeasPage() {
  const session = useSession();
  const projects = useProjects();
  const active = activeWorkspace(session.workspaces);
  const [searchParams] = useSearchParams<{ project?: string }>();

  const wsProjects = () =>
    projects
      .sorted()
      .filter((p) => !active() || p.workspace_id === active()!.id);

  // "" = all, "none" = platform-wide only, else a project id.
  const [filter, setFilter] = createSignal("");
  createEffect(() => {
    const want = searchParams.project;
    if (want && wsProjects().some((p) => p.id === want)) setFilter(want);
  });

  const [ideas, { refetch }] = createResource(
    () => active()?.id,
    async (wsId) => {
      if (!wsId) return [] as Idea[];
      return (await api.listWorkspaceIdeas(wsId)).ideas;
    },
  );
  const [open, setOpen] = createSignal<Idea | null>(null);
  const [creating, setCreating] = createSignal(false);

  const filtered = () => {
    const f = filter();
    const list = ideas.latest ?? [];
    if (f === "") return list;
    if (f === "none") return list.filter((i) => !i.project_id);
    return list.filter((i) => i.project_id === f);
  };

  return (
    <div class="flex h-full flex-col">
      <header class="flex shrink-0 items-center gap-3 border-b border-border px-6 py-4">
        <div class="min-w-0 flex-1">
          <h1 class="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
            <BulbIcon class="h-4 w-4 text-muted" />
            Ideas
          </h1>
          <p class="mt-0.5 text-[12px] text-muted">
            Brainstorm space — sketch mindmaps, then convert into issues or
            projects
          </p>
        </div>
        <Select
          value={filter()}
          onChange={setFilter}
          options={[
            { value: "", label: "All ideas" },
            { value: "none", label: "Platform-wide" },
            ...wsProjects().map((p) => ({ value: p.id, label: p.name })),
          ]}
          ariaLabel="Filter ideas by project"
          class="w-44"
        />
        <button
          type="button"
          onClick={() => setCreating(true)}
          class="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <PlusIcon class="h-3 w-3" /> New idea
        </button>
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <Show
          when={ideas.state === "ready" || ideas.latest}
          fallback={
            <div class="flex justify-center py-10">
              <Show when={ideas.state === "errored"} fallback={<Spinner />}>
                <p class="text-[13px] text-muted">Could not load ideas</p>
              </Show>
            </div>
          }
        >
          <Show when={creating()}>
            <NewIdea
              workspaceId={active()?.id ?? ""}
              projects={wsProjects()}
              initialProject={
                filter() !== "" && filter() !== "none" ? filter() : ""
              }
              onDone={(i) => {
                setCreating(false);
                if (i) {
                  refetch();
                  setOpen(i);
                }
              }}
            />
          </Show>
          <ul class="mt-1 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <For
              each={filtered()}
              fallback={
                <Show when={!creating()}>
                  <li class="col-span-full rounded-lg border border-dashed border-border px-4 py-10 text-center text-[13px] text-muted">
                    Nothing brainstormed yet — start a canvas, or ask an agent
                    to sketch one (create_idea / update_idea MCP tools).
                  </li>
                </Show>
              }
            >
              {(i) => (
                <li>
                  <button
                    type="button"
                    onClick={() => setOpen(i)}
                    class="flex w-full flex-col gap-1.5 rounded-lg border border-border bg-surface px-3.5 py-3 text-left transition-colors hover:border-muted/60"
                  >
                    <span class="flex w-full items-center gap-2">
                      <span class="min-w-0 flex-1 truncate text-[13px] font-medium">
                        {i.title}
                      </span>
                      <span
                        class={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium ${STATUS_STYLE[i.status] ?? STATUS_STYLE.open}`}
                      >
                        {i.status}
                      </span>
                    </span>
                    <Show when={i.summary}>
                      <span class="line-clamp-2 text-[12px] text-muted">
                        {i.summary}
                      </span>
                    </Show>
                    <span class="mt-auto flex items-center gap-2 pt-1 text-[11px] text-faint">
                      <Show
                        when={i.project_id}
                        fallback={
                          <span class="rounded-full bg-surface-2 px-1.5 py-px text-[10px] font-medium text-muted">
                            Platform-wide
                          </span>
                        }
                      >
                        <span class="rounded-full bg-accent/10 px-1.5 py-px text-[10px] font-medium text-accent">
                          {i.project_name ?? i.project_key}
                        </span>
                      </Show>
                      <Show when={i.author_name}>
                        <span class="truncate">{i.author_name}</span>
                      </Show>
                      <Show when={i.updated_at}>
                        {(t) => (
                          <span class="ml-auto shrink-0">{timeAgo(t())}</span>
                        )}
                      </Show>
                    </span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>

      <Show when={open()} keyed>
        {(i) => (
          <IdeaView
            idea={i}
            onClose={() => setOpen(null)}
            onChanged={() => {
              refetch();
              setOpen(null);
            }}
          />
        )}
      </Show>
    </div>
  );
}

// Minimal composer — a canvas is what makes an idea, so "New" creates the
// record and drops straight into the Excalidraw editor.
function NewIdea(props: {
  workspaceId: string;
  projects: { id: string; name: string }[];
  initialProject: string;
  onDone: (i: Idea | null) => void;
}) {
  const [title, setTitle] = createSignal("");
  const [summary, setSummary] = createSignal("");
  const [projectId, setProjectId] = createSignal(props.initialProject);
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal("");
  return (
    <form
      class="mb-1 flex flex-col gap-2 rounded-lg border border-accent/40 bg-accent/5 p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title().trim() || busy() || !props.workspaceId) return;
        setBusy(true);
        setErr("");
        try {
          const i = await api.createWorkspaceIdea(props.workspaceId, {
            title: title().trim(),
            summary: summary(),
            scene: {},
            project_id: projectId() || undefined,
          });
          props.onDone(i);
        } catch (ex) {
          setErr(ex instanceof Error ? ex.message : "could not create idea");
        } finally {
          setBusy(false);
        }
      }}
    >
      <div class="flex items-center gap-2">
        <input
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
          placeholder="Idea title — what are we exploring?"
          class={inputClass}
          autofocus
        />
        <Select
          value={projectId()}
          onChange={setProjectId}
          options={[
            { value: "", label: "Platform-wide" },
            ...props.projects.map((p) => ({ value: p.id, label: p.name })),
          ]}
          ariaLabel="Attach idea to project"
          class="w-44 shrink-0"
        />
      </div>
      <textarea
        value={summary()}
        onInput={(e) => setSummary(e.currentTarget.value)}
        placeholder="Summary (markdown, optional)"
        rows={2}
        class={`${inputClass} resize-none`}
      />
      <div class="flex items-center justify-end gap-2">
        <Show when={err()}>
          <span class="mr-auto text-[12px] text-red-500">{err()}</span>
        </Show>
        <button
          type="button"
          onClick={() => props.onDone(null)}
          class="rounded-md px-2.5 py-1.5 text-[12px] text-muted hover:text-fg"
        >
          Cancel
        </button>
        <button type="submit" disabled={busy()} class={primaryButtonClass}>
          Create
        </button>
      </div>
    </form>
  );
}

// IdeaView: a full-page native whiteboard — the canvas is the document.
// Issue/PR cards, sticky notes, shapes and arrows autosave into
// idea.scene.relay_board; the legacy Excalidraw editor stays reachable for
// agent-drawn scenes that predate the board.
function IdeaView(props: {
  idea: Idea;
  onClose: () => void;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const projects = useProjects();
  const [idea, setIdea] = createSignal(props.idea);
  // Canvas + markdown need a project context (issue refs link there). Use
  // the attached project, else any project in the idea's workspace.
  const wsProjects = () =>
    (projects.projects() ?? []).filter(
      (p) => p.workspace_id === idea().workspace_id,
    );
  const project = () =>
    wsProjects().find((p) => p.id === idea().project_id) ?? wsProjects()[0];
  const [editing, setEditing] = createSignal(false);
  const [convertOpen, setConvertOpen] = createSignal(false);
  const [detailsOpen, setDetailsOpen] = createSignal(false);
  const [err, setErr] = createSignal("");

  const hasLegacyScene = () =>
    Array.isArray((idea().scene as Record<string, unknown>)?.elements) &&
    ((idea().scene as { elements?: unknown[] }).elements?.length ?? 0) > 0;

  const saveBoard = async (board: BoardDoc) => {
    const scene = { ...idea().scene, relay_board: board };
    const i = await api.updateIdea(idea().id, { scene });
    setIdea(i);
  };

  const setStatus = async (status: "open" | "archived") => {
    const i = await api.updateIdea(idea().id, { status });
    setIdea(i);
  };

  const remove = async () => {
    if (
      !(await confirmDestructive({
        title: "Delete idea",
        body: `Delete "${idea().title}"? This cannot be undone.`,
      }))
    )
      return;
    await api.deleteIdea(idea().id);
    props.onChanged();
  };

  return (
    <div class="fixed inset-0 z-50 flex flex-col bg-bg">
      <div class="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-5 py-2.5">
        <div class="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Back to ideas"
            class="rounded-md p-1 text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <ChevronLeftIcon class="h-4 w-4" />
          </button>
          <div class="min-w-0">
            <h3 class="truncate text-[14px] font-semibold">{idea().title}</h3>
            <p class="text-[11px] text-muted">
              <Show when={idea().author_name}>{idea().author_name} · </Show>
              <span
                class={`rounded-full px-1.5 py-px text-[10px] font-medium ${STATUS_STYLE[idea().status] ?? STATUS_STYLE.open}`}
              >
                {idea().status}
              </span>
            </p>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Select
            value={idea().project_id ?? ""}
            onChange={(v) => {
              if (!v) return;
              void api
                .updateIdea(idea().id, { project_id: v })
                .then(setIdea);
            }}
            options={
              idea().project_id
                ? wsProjects().map((p) => ({ value: p.id, label: p.name }))
                : [
                    { value: "", label: "Platform-wide" },
                    ...wsProjects().map((p) => ({
                      value: p.id,
                      label: p.name,
                    })),
                  ]
            }
            ariaLabel="Idea project"
            class="w-40"
          />
          <button
            type="button"
            onClick={() => setDetailsOpen((o) => !o)}
            aria-expanded={detailsOpen()}
            class="rounded-md border border-border px-2 py-1 text-[12px] text-muted hover:bg-hover hover:text-fg"
          >
            Details
          </button>
          <Show when={hasLegacyScene()}>
            <button
              type="button"
              onClick={() => setEditing(true)}
              title="This idea also has an Excalidraw scene — open it in the legacy editor"
              class="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] text-muted hover:bg-hover hover:text-fg"
            >
              <PencilIcon class="h-3 w-3" /> Excalidraw
            </button>
          </Show>
          <Show when={idea().status !== "converted"}>
            <button
              type="button"
              onClick={() => setConvertOpen((o) => !o)}
              class="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] text-muted hover:bg-hover hover:text-fg"
            >
              <CheckIcon class="h-3 w-3" /> Convert
            </button>
          </Show>
          <Show when={idea().status === "open"}>
            <button
              type="button"
              onClick={() => setStatus("archived")}
              class="rounded-md border border-border px-2 py-1 text-[12px] text-muted hover:bg-hover hover:text-fg"
            >
              Archive
            </button>
          </Show>
          <Show when={idea().status === "archived"}>
            <button
              type="button"
              onClick={() => setStatus("open")}
              class="rounded-md border border-border px-2 py-1 text-[12px] text-muted hover:bg-hover hover:text-fg"
            >
              Reopen
            </button>
          </Show>
          <button
            type="button"
            onClick={() => void remove()}
            title="Delete idea"
            aria-label="Delete idea"
            class="rounded-md border border-border p-1.5 text-muted transition-colors hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-500"
          >
            <TrashIcon class="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <Show when={convertOpen() || detailsOpen() || err()}>
        <div class="max-h-64 shrink-0 overflow-y-auto border-b border-border bg-surface px-5 py-3">
          <Show when={convertOpen()}>
            <ConvertForm
              idea={idea()}
              projects={wsProjects()}
              onDone={(dest) => {
                setConvertOpen(false);
                if (dest === "issue" || dest === "project") {
                  props.onChanged();
                }
              }}
              onConverted={async (kind, ref, projectId) => {
                props.onChanged();
                if (kind === "issue" && projectId) {
                  navigate(`/app/p/${projectId}/i/${ref}`);
                } else if (kind === "project") {
                  navigate(`/app/p/${ref}`);
                }
              }}
              onError={setErr}
            />
          </Show>
          <Show when={err()}>
            <p class="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-500">
              {err()}
            </p>
          </Show>
          <Show when={detailsOpen() && idea().summary}>
            <div class="rounded-lg border border-border bg-surface-2/40 px-3 py-2 text-[13px]">
              <Markdown
                body={idea().summary}
                projectId={idea().project_id ?? project()?.id}
              />
            </div>
          </Show>
          <Show when={detailsOpen() && !idea().summary}>
            <p class="text-[12px] text-muted">No summary on this idea.</p>
          </Show>
        </div>
      </Show>

      <div class="min-h-0 flex-1">
        <Show
          when={project()}
          fallback={
            <div class="flex h-full items-center justify-center">
              <Spinner />
            </div>
          }
        >
          {(p) => (
            <BoardCanvas
              project={p()}
              scene={idea().scene as Record<string, unknown> | undefined}
              onSave={saveBoard}
            />
          )}
        </Show>
      </div>

      <Show when={editing()}>
        <SceneEditor
          title={idea().title}
          saveLabel="Save to idea"
          hint="Mindmap canvas — agents can read and revise the same scene."
          scene={idea().scene}
          onSave={async (scene) => {
            // merge — Excalidraw owns `elements`, the board owns `relay_board`
            const merged = {
              ...scene,
              relay_board: (idea().scene as Record<string, unknown>)
                ?.relay_board,
            };
            const i = await api.updateIdea(idea().id, { scene: merged });
            setIdea(i);
            setEditing(false);
          }}
          onClose={() => setEditing(false)}
        />
      </Show>
    </div>
  );
}

// ConvertForm turns the idea into real work — an issue on a chosen project,
// or a new project in the workspace. The idea is kept, marked "converted".
function ConvertForm(props: {
  idea: Idea;
  projects: { id: string; name: string }[];
  onDone: (dest: "issue" | "project" | null) => void;
  onConverted: (
    kind: "issue" | "project",
    id: string,
    projectId?: string,
  ) => void;
  onError: (msg: string) => void;
}) {
  const [kind, setKind] = createSignal<"issue" | "project">("issue");
  const [title, setTitle] = createSignal(props.idea.title);
  const [description, setDescription] = createSignal(props.idea.summary);
  const [key, setKey] = createSignal("");
  const [target, setTarget] = createSignal(
    props.idea.project_id ?? props.projects[0]?.id ?? "",
  );
  const [busy, setBusy] = createSignal(false);

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    if (busy()) return;
    setBusy(true);
    props.onError("");
    try {
      const r = await api.convertIdea(props.idea.id, {
        kind: kind(),
        title: title().trim() || undefined,
        description: description().trim() || undefined,
        key: kind() === "project" ? key().trim() || undefined : undefined,
        project_id: kind() === "issue" ? target() : undefined,
      });
      if (r.issue) props.onConverted("issue", r.issue.id, target());
      else if (r.project) props.onConverted("project", r.project.id);
      else props.onDone(null);
    } catch (ex) {
      props.onError(ex instanceof Error ? ex.message : "could not convert");
      props.onDone(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      class="mb-4 flex flex-col gap-2 rounded-lg border border-accent/40 bg-accent/5 p-3"
    >
      <div class="flex items-center gap-3 text-[12px]">
        <span class="font-medium text-muted">Convert into</span>
        <label class="flex items-center gap-1.5">
          <input
            type="radio"
            name="convert-kind"
            checked={kind() === "issue"}
            onChange={() => setKind("issue")}
            class="accent-accent"
          />
          Issue
        </label>
        <label class="flex items-center gap-1.5">
          <input
            type="radio"
            name="convert-kind"
            checked={kind() === "project"}
            onChange={() => setKind("project")}
            class="accent-accent"
          />
          New project
        </label>
      </div>
      <input
        value={title()}
        onInput={(e) => setTitle(e.currentTarget.value)}
        placeholder="Title"
        aria-label="Title"
        class={inputClass}
      />
      <textarea
        value={description()}
        onInput={(e) => setDescription(e.currentTarget.value)}
        placeholder="Description"
        aria-label="Description"
        rows={2}
        class={`${inputClass} resize-none`}
      />
      <Show when={kind() === "issue"}>
        <Select
          value={target()}
          onChange={setTarget}
          options={props.projects.map((p) => ({
            value: p.id,
            label: p.name,
          }))}
          ariaLabel="Target project"
        />
      </Show>
      <Show when={kind() === "project"}>
        <input
          value={key()}
          onInput={(e) =>
            setKey(e.currentTarget.value.toUpperCase().slice(0, 6))
          }
          placeholder="Project key (e.g. REL)"
          aria-label="Project key"
          class={`${inputClass} font-mono uppercase`}
        />
      </Show>
      <div class="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => props.onDone(null)}
          class="rounded-md px-2.5 py-1.5 text-[12px] text-muted hover:text-fg"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy() || (kind() === "issue" && !target())}
          class={primaryButtonClass}
        >
          {busy() ? "Converting…" : "Convert"}
        </button>
      </div>
    </form>
  );
}
