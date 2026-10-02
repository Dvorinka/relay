import { createSignal, For, Show, createResource } from "solid-js";
import type { Brief, BriefPolicy, Message, Project } from "@relay/api-client";
import { api } from "../../lib/api";
import { net } from "../../lib/net";
import { SceneView } from "./SceneView";
import { Markdown } from "../../lib/markdown";
import { XIcon, PlusIcon, CheckIcon } from "../../components/icons";
import { inputClass, primaryButtonClass } from "../../components/ui";

const POLICY_LABEL: Record<BriefPolicy, string> = {
  never: "Never — agents must not create briefs",
  on_request: "On request — only when asked",
  pre_merge: "Pre-merge — expected before approvals",
};

// BriefsPanel lists a project's visual briefs and opens a viewer with the
// diagram plus its comment thread (a normal conversation underneath).
export function BriefsPanel(props: {
  project: Project;
  issueId?: string;
  onClose: () => void;
}) {
  const [open, setOpen] = createSignal<Brief | null>(null);
  const [creating, setCreating] = createSignal(false);
  const [policy, setPolicy] = createSignal<BriefPolicy>(
    (props.project.brief_policy as BriefPolicy) || "on_request",
  );
  const [briefs, { refetch }] = createResource(
    () => props.project.id,
    async (id) => {
      if (net.isLocal()) return { briefs: [] as Brief[], policy: policy() };
      const r = await api.listBriefs(id, props.issueId);
      setPolicy(r.policy);
      return r;
    },
    { initialValue: { briefs: [] as Brief[], policy: policy() } },
  );

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onClose();
      }}
    >
      <div class="flex max-h-[88vh] w-full max-w-3xl flex-col rounded-xl border border-border bg-surface shadow-xl">
        <div class="flex items-center justify-between border-b border-border px-5 py-3.5">
          <div>
            <h2 class="text-[14px] font-semibold">Briefs</h2>
            <p class="text-[11px] text-muted">
              Visual explanations agents attach to work. {POLICY_LABEL[policy()]}.
            </p>
          </div>
          <div class="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCreating(true)}
              disabled={net.isLocal() || policy() === "never"}
              class="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40"
            >
              <PlusIcon class="h-3 w-3" /> New brief
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
          <Show when={net.isLocal()}>
            <p class="mb-3 rounded-md border border-dashed border-border px-3 py-2 text-[12px] text-muted">
              Briefs need a server connection — they exist so agents can post
              diagrams back to you.
            </p>
          </Show>
          <Show
            when={(briefs()?.briefs.length ?? 0) > 0 || creating()}
            fallback={
              <p class="py-10 text-center text-[13px] text-muted">
                No briefs yet. Ask your agent to "explain this change" and it
                can post a diagram here.
              </p>
            }
          >
            <Show when={creating()}>
              <NewBrief
                projectId={props.project.id}
                issueId={props.issueId}
                onDone={(b) => {
                  setCreating(false);
                  if (b) {
                    refetch();
                    setOpen(b);
                  }
                }}
              />
            </Show>
            <ul class="flex flex-col gap-2">
              <For each={briefs()?.briefs}>
                {(b) => (
                  <li>
                    <button
                      type="button"
                      onClick={() => setOpen(b)}
                      class="flex w-full items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:bg-hover"
                    >
                      <span class="flex-1 truncate text-[13px] font-medium">
                        {b.title}
                      </span>
                      <Show when={b.issue_id}>
                        <span class="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-muted">
                          issue
                        </span>
                      </Show>
                      <span class={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${
                        b.status === "resolved"
                          ? "bg-emerald-500/15 text-emerald-500"
                          : b.status === "archived"
                            ? "bg-surface-2 text-muted"
                            : "bg-accent/15 text-accent"
                      }`}>
                        {b.status}
                      </span>
                      <span class="text-[11px] text-muted">{b.author_name}</span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </div>

      <Show when={open()}>
        {(b) => (
          <BriefView
            brief={b()}
            onClose={() => setOpen(null)}
            onChanged={refetch}
          />
        )}
      </Show>
    </div>
  );
}

// Minimal composer for human-authored briefs — scene stays empty; comments
// do the iterating. Agents produce real scenes via MCP.
function NewBrief(props: {
  projectId: string;
  issueId?: string;
  onDone: (b: Brief | null) => void;
}) {
  const [title, setTitle] = createSignal("");
  const [summary, setSummary] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  return (
    <form
      class="mb-3 flex flex-col gap-2 rounded-lg border border-accent/40 bg-accent/5 p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title().trim() || busy()) return;
        setBusy(true);
        try {
          const b = await api.createBrief(props.projectId, {
            title: title().trim(),
            summary: summary(),
            issue_id: props.issueId,
            scene: {},
          });
          props.onDone(b);
        } catch {
          props.onDone(null);
        } finally {
          setBusy(false);
        }
      }}
    >
      <input
        value={title()}
        onInput={(e) => setTitle(e.currentTarget.value)}
        placeholder="Brief title — what does this explain?"
        class={inputClass}
        autofocus
      />
      <textarea
        value={summary()}
        onInput={(e) => setSummary(e.currentTarget.value)}
        placeholder="Summary (markdown)"
        rows={2}
        class={`${inputClass} resize-none`}
      />
      <div class="flex justify-end gap-2">
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

// BriefView: diagram + summary + the comment thread. Comments are ordinary
// messages in the brief's conversation — agents subscribed to it can iterate.
function BriefView(props: {
  brief: Brief;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [convId, setConvId] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [brief, setBrief] = createSignal(props.brief);

  const [comments, { refetch: refetchComments }] = createResource(
    () => brief().id,
    async (id) => {
      const conv = await api.briefConversation(id);
      setConvId(conv.id);
      const r = await api.listMessages(conv.id, { limit: 100 });
      return r.messages.slice().reverse();
    },
    { initialValue: [] as Message[] },
  );

  const send = async () => {
    const body = draft().trim();
    const cid = convId();
    if (!body || !cid || sending()) return;
    setSending(true);
    try {
      await api.postMessage(cid, body);
      setDraft("");
      refetchComments();
    } finally {
      setSending(false);
    }
  };

  const setStatus = async (status: "open" | "resolved" | "archived") => {
    const b = await api.updateBrief(brief().id, { status });
    setBrief(b);
    props.onChanged();
  };

  return (
    <div
      class="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div class="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-xl border border-border bg-surface shadow-2xl">
        <div class="flex items-center justify-between border-b border-border px-5 py-3.5">
          <div class="min-w-0">
            <h3 class="truncate text-[14px] font-semibold">{brief().title}</h3>
            <p class="text-[11px] text-muted">
              by {brief().author_name} · {brief().status}
            </p>
          </div>
          <div class="flex items-center gap-2">
            <Show when={brief().status !== "resolved"}>
              <button
                type="button"
                onClick={() => setStatus("resolved")}
                class="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] text-muted hover:bg-hover hover:text-fg"
              >
                <CheckIcon class="h-3 w-3" /> Resolve
              </button>
            </Show>
            <Show when={brief().status === "resolved"}>
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
              onClick={props.onClose}
              aria-label="Close"
              class="rounded p-1 text-muted transition-colors hover:bg-hover hover:text-fg"
            >
              <XIcon class="h-4 w-4" />
            </button>
          </div>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <SceneView scene={brief().scene} />
          <Show when={brief().summary}>
            <div class="mt-3 rounded-lg border border-border bg-surface-2/40 px-3 py-2 text-[13px]">
              <Markdown body={brief().summary} projectId={brief().project_id} />
            </div>
          </Show>

          <p class="mb-2 mt-5 text-[11px] font-medium uppercase tracking-wider text-muted">
            Comments — the agent watching this project can iterate on them
          </p>
          <ul class="flex flex-col gap-2.5">
            <For each={comments()}>
              {(m) => (
                <li class="rounded-lg border border-border px-3 py-2">
                  <p class="mb-0.5 text-[11px] font-medium text-muted">
                    {m.author.name}
                  </p>
                  <div class="text-[13px]">
                    <Markdown body={m.body} projectId={brief().project_id} />
                  </div>
                </li>
              )}
            </For>
            <Show when={comments().length === 0}>
              <p class="text-[12px] text-muted">
                No comments yet — suggest changes here and the agent can revise
                the diagram.
              </p>
            </Show>
          </ul>
        </div>

        <form
          class="flex items-center gap-2 border-t border-border px-5 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <input
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            placeholder="Comment on this brief…"
            class={`${inputClass} flex-1`}
          />
          <button
            type="submit"
            disabled={sending() || !draft().trim()}
            class={primaryButtonClass}
            aria-label="Send comment"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
