import {
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { api } from "../../lib/api";
import { XIcon } from "../../components/icons";
import { inputClass, Spinner } from "../../components/ui";

// In-app "file a GitHub issue" / "open a pull request" modals — the created
// item is mirrored back as a Relay issue server-side, so it appears on the
// board immediately. Same module-signal + host pattern as CommitModal.

type Target = { projectId: string; repo: string } | null;

const [issueTarget, setIssueTarget] = createSignal<Target>(null);
const [prTarget, setPrTarget] = createSignal<Target>(null);

export function openCreateIssue(projectId: string, repo: string) {
  setIssueTarget({ projectId, repo });
}

export function openCreatePull(projectId: string, repo: string) {
  setPrTarget({ projectId, repo });
}

export function GitHubCreateModalHost() {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      setIssueTarget(null);
      setPrTarget(null);
    }
  };
  window.addEventListener("keydown", onKey);
  onCleanup(() => window.removeEventListener("keydown", onKey));
  return (
    <>
      <Show when={issueTarget()} keyed>
        {(t) => <CreateIssueModal {...t} onClose={() => setIssueTarget(null)} />}
      </Show>
      <Show when={prTarget()} keyed>
        {(t) => <CreatePullModal {...t} onClose={() => setPrTarget(null)} />}
      </Show>
    </>
  );
}

function ModalShell(props: {
  title: string;
  onClose: () => void;
  children: import("solid-js").JSX.Element;
}) {
  return (
    <div
      class="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[12vh]"
      onClick={(e) => e.target === e.currentTarget && props.onClose()}
    >
      <div class="w-full max-w-lg rounded-lg border border-border bg-surface shadow-xl">
        <div class="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 class="text-[14px] font-semibold">{props.title}</h2>
          <button
            class="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg"
            onClick={props.onClose}
          >
            <XIcon class="h-4 w-4" />
          </button>
        </div>
        <div class="p-4">{props.children}</div>
      </div>
    </div>
  );
}

function CreateIssueModal(props: {
  projectId: string;
  repo: string;
  onClose: () => void;
}) {
  const [title, setTitle] = createSignal("");
  const [body, setBody] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  const submit = async () => {
    if (!title().trim() || busy()) return;
    setBusy(true);
    setError("");
    try {
      await api.createGitHubIssue(props.projectId, props.repo, {
        title: title().trim(),
        body: body(),
      });
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create issue");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      title={`New issue · ${props.repo}`}
      onClose={props.onClose}
    >
      <input
        class={`${inputClass} w-full`}
        placeholder="Issue title"
        value={title()}
        onInput={(e) => setTitle(e.currentTarget.value)}
        autofocus
      />
      <textarea
        class={`${inputClass} mt-2 w-full`}
        rows={6}
        placeholder="Description (Markdown supported)"
        value={body()}
        onInput={(e) => setBody(e.currentTarget.value)}
      />
      <Show when={error()}>
        <p class="mt-2 text-[12px] text-danger">{error()}</p>
      </Show>
      <div class="mt-3 flex justify-end gap-2">
        <button
          class="rounded-md px-3 py-1.5 text-[13px] text-muted hover:text-fg"
          onClick={props.onClose}
        >
          Cancel
        </button>
        <button
          class="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
          disabled={!title().trim() || busy()}
          onClick={submit}
        >
          {busy() ? "Filing…" : "File issue on GitHub"}
        </button>
      </div>
    </ModalShell>
  );
}

function CreatePullModal(props: {
  projectId: string;
  repo: string;
  onClose: () => void;
}) {
  const [title, setTitle] = createSignal("");
  const [body, setBody] = createSignal("");
  const [head, setHead] = createSignal("");
  const [base, setBase] = createSignal("");
  const [draft, setDraft] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  const [branches] = createResource(
    () => `${props.projectId}:${props.repo}`,
    () => api.repoBranches(props.projectId, props.repo),
  );

  const submit = async () => {
    if (!title().trim() || !head() || busy()) return;
    setBusy(true);
    setError("");
    try {
      await api.createPullRequest(props.projectId, props.repo, {
        head: head(),
        base: base() || undefined,
        title: title().trim(),
        body: body(),
        draft: draft(),
      });
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to open pull request");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      title={`New pull request · ${props.repo}`}
      onClose={props.onClose}
    >
      <Show when={branches.loading}>
        <p class="flex items-center gap-2 py-2 text-[12px] text-muted">
          <Spinner /> Loading branches…
        </p>
      </Show>
      <div class="flex items-center gap-2">
        <select
          class={`${inputClass} flex-1`}
          value={head()}
          onChange={(e) => setHead(e.currentTarget.value)}
        >
          <option value="">head branch…</option>
          <For each={branches()?.branches ?? []}>
            {(b) => <option value={b.name}>{b.name}</option>}
          </For>
        </select>
        <span class="text-muted">→</span>
        <select
          class={`${inputClass} flex-1`}
          value={base()}
          onChange={(e) => setBase(e.currentTarget.value)}
        >
          <option value={branches()?.default_branch ?? "main"}>
            {branches()?.default_branch ?? "main"} (default)
          </option>
          <For
            each={(branches()?.branches ?? []).filter(
              (b) => b.name !== branches()?.default_branch,
            )}
          >
            {(b) => <option value={b.name}>{b.name}</option>}
          </For>
        </select>
      </div>
      <input
        class={`${inputClass} mt-2 w-full`}
        placeholder="Pull request title"
        value={title()}
        onInput={(e) => setTitle(e.currentTarget.value)}
      />
      <textarea
        class={`${inputClass} mt-2 w-full`}
        rows={5}
        placeholder="Description (Markdown supported)"
        value={body()}
        onInput={(e) => setBody(e.currentTarget.value)}
      />
      <label class="mt-2 flex items-center gap-2 text-[13px] text-muted">
        <input
          type="checkbox"
          checked={draft()}
          onChange={(e) => setDraft(e.currentTarget.checked)}
        />
        Open as draft
      </label>
      <Show when={error()}>
        <p class="mt-2 text-[12px] text-danger">{error()}</p>
      </Show>
      <div class="mt-3 flex justify-end gap-2">
        <button
          class="rounded-md px-3 py-1.5 text-[13px] text-muted hover:text-fg"
          onClick={props.onClose}
        >
          Cancel
        </button>
        <button
          class="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
          disabled={!title().trim() || !head() || busy()}
          onClick={submit}
        >
          {busy() ? "Opening…" : "Open pull request"}
        </button>
      </div>
    </ModalShell>
  );
}
