// Reviews renders structured agent work reports ("whiteboard" reviews).
// Design inspired by devdotfast/whiteboard (MIT): a fixed-schema review
// card - summary, per-file changes, autonomous decisions, required human
// actions - that a user approves or sends back with a note.
import type { AgentReview, Project } from "@relay/api-client";
import { A } from "@solidjs/router";
import {
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { inputClass, Spinner } from "../../components/ui";
import { api } from "../../lib/api";
import { subscribe } from "../../lib/events";
import { Markdown } from "../../lib/markdown";
import { initials } from "../../lib/text";
import { timeAgo } from "../../lib/time";

type ReviewFile = {
  path: string;
  status?: string;
  additions?: number;
  deletions?: number;
  note?: string;
  patch?: string;
};
type ReviewDecision = { decision: string; rationale?: string };
type ReviewAction = { kind?: string; label: string; detail?: string };
type ReviewLink = { label: string; url: string };

const STATUS_FALLBACK = { label: "Pending", cls: "border-border text-muted" };
const ACTION_FALLBACK = { label: "STEP", cls: "border-border text-muted" };
const FILE_FALLBACK = { letter: "M", cls: "text-amber-500" };

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  pending: {
    label: "Awaiting review",
    cls: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  approved: {
    label: "Approved",
    cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  changes_requested: {
    label: "Changes requested",
    cls: "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400",
  },
  superseded: {
    label: "Superseded",
    cls: "border-border bg-hover text-muted",
  },
};

const ACTION_KIND: Record<string, { label: string; cls: string }> = {
  env: { label: "ENV", cls: "border-amber-500/40 text-amber-600 dark:text-amber-400" },
  secret: { label: "SECRET", cls: "border-red-500/40 text-red-600 dark:text-red-400" },
  ci: { label: "CI", cls: "border-sky-500/40 text-sky-600 dark:text-sky-400" },
  deploy: { label: "DEPLOY", cls: "border-sky-500/40 text-sky-600 dark:text-sky-400" },
  migration: { label: "MIGRATION", cls: "border-violet-500/40 text-violet-600 dark:text-violet-400" },
  config: { label: "CONFIG", cls: "border-violet-500/40 text-violet-600 dark:text-violet-400" },
  other: { label: "STEP", cls: "border-border text-muted" },
};

const FILE_STATUS: Record<string, { letter: string; cls: string }> = {
  added: { letter: "A", cls: "text-emerald-500" },
  modified: { letter: "M", cls: "text-amber-500" },
  deleted: { letter: "D", cls: "text-red-500" },
  renamed: { letter: "R", cls: "text-sky-500" },
};

/** Shared status chip — also used by the issue page's review list. */
export function ReviewStatusChip(props: { status?: string | null }) {
  const st = () => STATUS_STYLE[props.status ?? "pending"] ?? STATUS_FALLBACK;
  return (
    <span
      class={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${st().cls}`}
    >
      {st().label}
    </span>
  );
}

function Avatar(props: { name: string; url?: string | null; size?: string }) {
  return (
    <Show
      when={props.url}
      fallback={
        <span
          class={`inline-flex items-center justify-center rounded-full bg-hover font-medium text-muted ${props.size ?? "h-6 w-6 text-[10px]"}`}
        >
          {initials(props.name)}
        </span>
      }
    >
      <img
        src={props.url ?? undefined}
        alt={props.name}
        class={`rounded-full object-cover ${props.size ?? "h-6 w-6"}`}
      />
    </Show>
  );
}

function Section(props: { title: string; children: any }) {
  return (
    <section class="mt-5">
      <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}

function DiffBar(props: { add: number; del: number }) {
  const total = () => Math.max(props.add + props.del, 1);
  return (
    <span class="inline-flex h-2 w-16 overflow-hidden rounded-full bg-hover">
      <span
        class="bg-emerald-500"
        style={{ width: `${(props.add / total()) * 100}%` }}
      />
      <span
        class="bg-red-500"
        style={{ width: `${(props.del / total()) * 100}%` }}
      />
    </span>
  );
}

function ReviewCard(props: { review: AgentReview; onResponded: () => void }) {
  const r = () => props.review;
  const files = () => (r().files ?? []) as ReviewFile[];
  const decisions = () => (r().decisions ?? []) as ReviewDecision[];
  const actions = () => (r().actions ?? []) as ReviewAction[];
  const links = () => (r().links ?? []) as ReviewLink[];
  const [open, setOpen] = createSignal<string | null>(null);
  const [note, setNote] = createSignal("");
  const [busy, setBusy] = createSignal<"" | "approved" | "changes_requested">("");
  const [err, setErr] = createSignal("");

  const totals = () =>
    files().reduce(
      (t, f) => ({
        add: t.add + (f.additions ?? 0),
        del: t.del + (f.deletions ?? 0),
      }),
      { add: 0, del: 0 },
    );

  const respond = async (status: "approved" | "changes_requested") => {
    if (busy() || (status === "changes_requested" && !note().trim())) return;
    setBusy(status);
    setErr("");
    try {
      await api.respondToReview(r().id, status, note().trim() || undefined);
      props.onResponded();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "respond failed");
    } finally {
      setBusy("");
    }
  };

  return (
    <article class="rounded-lg border border-border bg-surface">
      {/* header */}
      <header class="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-3">
        <Avatar name={r().agent?.name ?? "?"} url={r().agent?.avatar_url} />
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="truncate text-[13.5px] font-semibold">{r().title}</span>
          </div>
          <p class="text-[11.5px] text-muted">
            {r().agent?.name} · {timeAgo(r().created_at)}
            <Show when={r().issue}>
              {(i) => (
                <>
                  {" "}
                  ·{" "}
                  <A
                    href={`/app/p/${r().project_id}/i/${i().id}`}
                    class="font-mono text-accent hover:underline"
                  >
                    {i().key}
                  </A>
                </>
              )}
            </Show>
          </p>
        </div>
        <ReviewStatusChip status={r().status} />
      </header>

      <div class="px-4 pb-4">
        {/* required human actions - the part a user must not miss */}
        <Show when={actions().length > 0}>
          <section class="mt-4 rounded-md border border-amber-500/30 bg-amber-500/5 px-3.5 py-3">
            <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
              Required from you ({actions().length})
            </h3>
            <ul class="space-y-2">
              <For each={actions()}>
                {(a) => {
                  const k = () =>
                    ACTION_KIND[a.kind ?? "other"] ?? ACTION_FALLBACK;
                  return (
                    <li class="flex items-start gap-2.5">
                      <span
                        class={`mt-px shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${k().cls}`}
                      >
                        {k().label}
                      </span>
                      <div class="min-w-0 text-[13px]">
                        <span class="font-medium">{a.label}</span>
                        <Show when={a.detail}>
                          <p class="text-muted">{a.detail}</p>
                        </Show>
                      </div>
                    </li>
                  );
                }}
              </For>
            </ul>
          </section>
        </Show>

        {/* summary */}
        <Section title="What changed">
          <Markdown body={r().summary} class="text-[13px]" />
        </Section>

        {/* files */}
        <Show when={files().length > 0}>
          <Section title={`Files (${files().length})`}>
            <ul class="divide-y divide-border rounded-md border border-border">
              <For each={files()}>
                {(f) => {
                  const fs = () =>
                    FILE_STATUS[f.status ?? "modified"] ?? FILE_FALLBACK;
                  return (
                    <li class="px-3 py-2">
                      <div class="flex items-center gap-2.5">
                        <span
                          class={`w-3.5 text-center font-mono text-[11px] font-semibold ${fs().cls}`}
                        >
                          {fs().letter}
                        </span>
                        <span class="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                          {f.path}
                        </span>
                        <span class="shrink-0 font-mono text-[11px] tabular-nums">
                          <span class="text-emerald-500">+{f.additions ?? 0}</span>
                          {" "}
                          <span class="text-red-500">-{f.deletions ?? 0}</span>
                        </span>
                        <DiffBar add={f.additions ?? 0} del={f.deletions ?? 0} />
                        <Show when={f.patch}>
                          <button
                            type="button"
                            onClick={() =>
                              setOpen(open() === f.path ? null : f.path)
                            }
                            class="shrink-0 text-[11px] text-accent hover:underline"
                          >
                            {open() === f.path ? "Hide diff" : "Diff"}
                          </button>
                        </Show>
                      </div>
                      <Show when={f.note}>
                        <p class="mt-1 pl-6 text-[12.5px] text-muted">
                          {f.note}
                        </p>
                      </Show>
                      <Show when={open() === f.path && f.patch}>
                        <pre class="mt-2 max-h-80 overflow-auto rounded-md border border-border bg-bg p-3 font-mono text-[11.5px] leading-relaxed">
                          {f.patch}
                        </pre>
                      </Show>
                    </li>
                  );
                }}
              </For>
            </ul>
            <p class="mt-1.5 text-right font-mono text-[11px] text-muted">
              <span class="text-emerald-500">+{totals().add}</span>{" "}
              <span class="text-red-500">-{totals().del}</span> across{" "}
              {files().length} file{files().length === 1 ? "" : "s"}
            </p>
          </Section>
        </Show>

        {/* autonomous decisions */}
        <Show when={decisions().length > 0}>
          <Section title="Decisions the agent made">
            <ul class="space-y-2">
              <For each={decisions()}>
                {(d, i) => (
                  <li class="flex gap-2.5 text-[13px]">
                    <span class="mt-0.5 shrink-0 font-mono text-[11px] text-muted">
                      {i() + 1}
                    </span>
                    <div class="min-w-0">
                      <span class="font-medium">{d.decision}</span>
                      <Show when={d.rationale}>
                        <p class="text-muted">{d.rationale}</p>
                      </Show>
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </Section>
        </Show>

        {/* verification */}
        <Show when={r().verify}>
          <Section title="How to verify">
            <div class="rounded-md border border-border bg-bg px-3.5 py-3">
              <Markdown body={r().verify} class="text-[13px]" />
            </div>
          </Section>
        </Show>

        {/* links */}
        <Show when={links().length > 0}>
          <Section title="Links">
            <div class="flex flex-wrap gap-2">
              <For each={links()}>
                {(l) => (
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noreferrer"
                    class="rounded-md border border-border px-2.5 py-1 text-[12.5px] text-accent transition-colors hover:bg-hover"
                  >
                    {l.label} ↗
                  </a>
                )}
              </For>
            </div>
          </Section>
        </Show>

        {/* verdict area */}
        <footer class="mt-5 border-t border-border pt-4">
          <Switch>
            <Match when={r().status === "pending"}>
              <textarea
                value={note()}
                onInput={(e) => setNote(e.currentTarget.value)}
                placeholder="Feedback for the agent - required when requesting changes. Explain what to reshape and the logic it should follow."
                rows={2}
                class={`${inputClass} resize-none`}
              />
              <div class="mt-2.5 flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy() !== ""}
                  onClick={() => respond("approved")}
                  class="rounded-md bg-emerald-600 px-3 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {busy() === "approved" ? "Approving…" : "Approve"}
                </button>
                <button
                  type="button"
                  disabled={busy() !== "" || !note().trim()}
                  onClick={() => respond("changes_requested")}
                  class="rounded-md border border-red-500/40 px-3 py-1.5 text-[13px] font-medium text-red-600 transition-colors hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"
                >
                  {busy() === "changes_requested"
                    ? "Sending…"
                    : "Request changes"}
                </button>
                <Show when={err()}>
                  <span class="text-[12px] text-red-500">{err()}</span>
                </Show>
              </div>
            </Match>
            <Match when={r().responder}>
              {(res) => (
                <div class="flex items-start gap-2.5">
                  <Avatar
                    name={res().name ?? "?"}
                    url={res().avatar_url}
                    size="h-5 w-5 text-[9px]"
                  />
                  <div class="min-w-0 text-[13px]">
                    <span class="font-medium">{res().name}</span>
                    <span class="text-muted">
                      {" "}
                      {r().status === "approved" ? "approved" : "requested changes"}
                      <Show when={r().responded_at}>
                        {" "}
                        · {timeAgo(r().responded_at as string)}
                      </Show>
                    </span>
                    <Show when={r().response}>
                      <p class="mt-1 rounded-md border border-border bg-bg px-3 py-2 text-muted">
                        {r().response}
                      </p>
                    </Show>
                  </div>
                </div>
              )}
            </Match>
          </Switch>
        </footer>
      </div>
    </article>
  );
}

const FILTERS: { id: string; label: string }[] = [
  { id: "", label: "All" },
  { id: "pending", label: "Awaiting" },
  { id: "approved", label: "Approved" },
  { id: "changes_requested", label: "Changes requested" },
  { id: "superseded", label: "Superseded" },
];

export function Reviews(props: { project: Project }) {
  const [filter, setFilter] = createSignal("");
  const [data, { refetch }] = createResource(
    () => [props.project.id, filter()] as const,
    async ([id, status]) => api.listReviews(id, status || undefined),
  );

  const unsub = subscribe((e) => {
    if (e.project_id !== props.project.id) return;
    if (e.type === "review.created" || e.type === "review.responded") refetch();
  });
  onCleanup(unsub);

  return (
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto w-full max-w-3xl px-6 py-6">
        <Show
          when={data()}
          fallback={
            <div class="flex items-center justify-center py-16">
              <Spinner />
            </div>
          }
        >
          {(d) => (
            <>
              <div class="mb-4">
                <div class="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 class="text-[13px] font-semibold">
                    Agent reviews
                    <Show when={d().pending > 0}>
                      <span class="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                        {d().pending} awaiting
                      </span>
                    </Show>
                  </h2>
                  <p class="text-[11.5px] text-muted">
                    Agents submit these after finishing work via MCP
                  </p>
                </div>
                <div class="mt-2 inline-flex rounded-md border border-border p-0.5">
                  <For each={FILTERS}>
                    {(f) => (
                      <button
                        type="button"
                        onClick={() => setFilter(f.id)}
                        class={`whitespace-nowrap rounded-sm px-2 py-0.5 text-[11.5px] transition-colors ${
                          filter() === f.id
                            ? "bg-hover font-medium text-fg"
                            : "text-muted hover:text-fg"
                        }`}
                      >
                        {f.label}
                      </button>
                    )}
                  </For>
                </div>
              </div>
              <div class="space-y-4">
                <For
                  each={d().reviews}
                  fallback={
                    <div class="rounded-lg border border-dashed border-border px-6 py-12 text-center">
                      <p class="text-[13px] font-medium">
                        {filter()
                          ? "Nothing in this state"
                          : "No reviews yet"}
                      </p>
                      <Show when={!filter()}>
                        <p class="mt-1 text-[12.5px] text-muted">
                          When an agent finishes work it submits a structured
                          report here - what changed, which files, what it
                          decided on its own, and what you need to do (new env
                          vars, deploy steps) before it breaks CI.
                        </p>
                      </Show>
                    </div>
                  }
                >
                  {(r) => <ReviewCard review={r} onResponded={refetch} />}
                </For>
              </div>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}
