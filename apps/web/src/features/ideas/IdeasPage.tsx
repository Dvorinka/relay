import { A, useNavigate, useParams } from "@solidjs/router";
import { createResource, createSignal, For, Show } from "solid-js";
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
  XIcon,
} from "../../components/icons";
import { inputClass, primaryButtonClass, Spinner } from "../../components/ui";
import { SceneEditor } from "../briefs/SceneEditor";
import { SceneView } from "../briefs/SceneView";
import { Markdown } from "../../lib/markdown";

const STATUS_STYLE: Record<string, string> = {
  open: "bg-accent/15 text-accent",
  converted: "bg-emerald-500/15 text-emerald-500",
  archived: "bg-surface-2 text-muted",
};

// IdeasPage — a project's brainstorm shelf. Each idea pairs a title/summary
// with an Excalidraw canvas (mindmaps, sketches); once it turns into real
// work it converts into an issue or a new project.
export default function IdeasPage() {
  const params = useParams<{ projectId: string }>();
  const [ideas, { refetch }] = createResource(
    () => params.projectId,
    async (id) => (await api.listIdeas(id)).ideas,
  );
  const [open, setOpen] = createSignal<Idea | null>(null);
  const [creating, setCreating] = createSignal(false);

  return (
    <div class="flex h-full flex-col">
      <header class="flex shrink-0 items-center gap-3 border-b border-border px-6 py-4">
        <A
          href={`/app/p/${params.projectId}`}
          aria-label="Back to project"
          class="rounded-md p-1 text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <ChevronLeftIcon class="h-4 w-4" />
        </A>
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
              projectId={params.projectId}
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
              each={ideas.latest}
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
  projectId: string;
  onDone: (i: Idea | null) => void;
}) {
  const [title, setTitle] = createSignal("");
  const [summary, setSummary] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal("");
  return (
    <form
      class="mb-1 flex flex-col gap-2 rounded-lg border border-accent/40 bg-accent/5 p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title().trim() || busy()) return;
        setBusy(true);
        setErr("");
        try {
          const i = await api.createIdea(props.projectId, {
            title: title().trim(),
            summary: summary(),
            scene: {},
          });
          props.onDone(i);
        } catch (ex) {
          setErr(ex instanceof Error ? ex.message : "could not create idea");
        } finally {
          setBusy(false);
        }
      }}
    >
      <input
        value={title()}
        onInput={(e) => setTitle(e.currentTarget.value)}
        placeholder="Idea title — what are we exploring?"
        class={inputClass}
        autofocus
      />
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

// IdeaView: canvas preview + summary + convert/delete actions. Conversion
// lands the user on the created issue or project.
function IdeaView(props: {
  idea: Idea;
  onClose: () => void;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const [idea, setIdea] = createSignal(props.idea);
  const [editing, setEditing] = createSignal(false);
  const [convertOpen, setConvertOpen] = createSignal(false);
  const [err, setErr] = createSignal("");

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
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div class="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-xl border border-border bg-surface shadow-2xl">
        <div class="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
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
          <div class="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setEditing(true)}
              title="Open in the Excalidraw editor"
              class="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] text-muted hover:bg-hover hover:text-fg"
            >
              <PencilIcon class="h-3 w-3" /> Edit canvas
            </button>
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
            <button
              type="button"
              onClick={props.onClose}
              aria-label="Close"
              class="rounded p-1 text-muted transition-colors hover:bg-hover hover:text-fg"
            >
              <XIcon class="h-4 w-4" />
            </button>
          </div>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <Show when={convertOpen()}>
            <ConvertForm
              idea={idea()}
              onDone={(dest) => {
                setConvertOpen(false);
                if (dest === "issue" || dest === "project") {
                  props.onChanged();
                }
              }}
              onConverted={async (kind, ref) => {
                props.onChanged();
                if (kind === "issue") {
                  navigate(`/app/p/${idea().project_id}/i/${ref}`);
                } else {
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
          <SceneView scene={idea().scene} />
          <Show when={idea().summary}>
            <div class="mt-3 rounded-lg border border-border bg-surface-2/40 px-3 py-2 text-[13px]">
              <Markdown body={idea().summary} projectId={idea().project_id} />
            </div>
          </Show>
        </div>
      </div>

      <Show when={editing()}>
        <SceneEditor
          title={idea().title}
          saveLabel="Save to idea"
          hint="Mindmap canvas — agents can read and revise the same scene."
          scene={idea().scene}
          onSave={async (scene) => {
            const i = await api.updateIdea(idea().id, { scene });
            setIdea(i);
            setEditing(false);
          }}
          onClose={() => setEditing(false)}
        />
      </Show>
    </div>
  );
}

// ConvertForm turns the idea into real work — an issue on this project, or a
// new project in the workspace. The idea is kept, marked "converted".
function ConvertForm(props: {
  idea: Idea;
  onDone: (dest: "issue" | "project" | null) => void;
  onConverted: (kind: "issue" | "project", id: string) => void;
  onError: (msg: string) => void;
}) {
  const [kind, setKind] = createSignal<"issue" | "project">("issue");
  const [title, setTitle] = createSignal(props.idea.title);
  const [description, setDescription] = createSignal(props.idea.summary);
  const [key, setKey] = createSignal("");
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
      });
      if (r.issue) props.onConverted("issue", r.issue.id);
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
          Issue in this project
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
        <button type="submit" disabled={busy()} class={primaryButtonClass}>
          {busy() ? "Converting…" : "Convert"}
        </button>
      </div>
    </form>
  );
}
