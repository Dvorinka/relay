import type { Issue, Project } from "@relay/api-client";
import { A, useNavigate } from "@solidjs/router";
import {
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Avatar } from "@ark-ui/solid";
import { PlusIcon, SearchIcon } from "../../components/icons";
import { Spinner } from "../../components/ui";
import { api } from "../../lib/api";
import { subscribe } from "../../lib/events";
import { initials } from "../../lib/text";
import { useSession } from "../../stores/session";
import {
  isClosed,
  GitHubBadge,
  LabelChip,
  PRIORITY_LABEL,
  PriorityGlyph,
  STATUS_LABEL,
  StatusDot,
} from "./meta";
import { NewIssueDialog } from "./NewIssueDialog";

type Chip = "all" | "open" | "mine" | "done";

const CHIPS: { id: Chip; label: string }[] = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "mine", label: "Mine" },
  { id: "done", label: "Done" },
];

function IssueRow(props: {
  projectId: string;
  issue: Issue;
  selected: boolean;
  onHover: () => void;
}) {
  const i = () => props.issue;
  return (
    <li>
      <A
        href={`/app/p/${props.projectId}/i/${i().id}`}
        onMouseEnter={props.onHover}
        class={`flex items-center gap-2 px-3 py-2 text-[13px] transition-colors ${
          props.selected ? "bg-hover" : ""
        }`}
        data-selected={props.selected || undefined}
      >
        <span class="w-12 shrink-0 font-mono text-[11px] text-muted">
          {i().key}
        </span>
        <span class="min-w-0 flex-1 basis-32 truncate">{i().title}</span>
        <GitHubBadge issue={i()} />
        <Show when={i().labels.length > 0}>
          <span class="hidden shrink-0 gap-1 md:flex">
            <For each={i().labels.slice(0, 3)}>
              {(l) => <LabelChip label={l} />}
            </For>
          </span>
        </Show>
        <span
          class="flex w-14 shrink-0 items-center gap-1.5 text-[11px] text-muted"
          title={`Priority: ${PRIORITY_LABEL[i().priority]}`}
        >
          <PriorityGlyph priority={i().priority} />
          <Show when={i().priority !== "none"}>
            {PRIORITY_LABEL[i().priority]}
          </Show>
        </span>
        <span class="flex w-20 shrink-0 items-center gap-1.5 text-[11px] text-muted">
          <StatusDot status={i().status} />
          <span class="truncate">{STATUS_LABEL[i().status]}</span>
        </span>
        <span class="flex w-24 shrink-0 items-center gap-1.5 text-[12px] text-muted">
          <Show
            when={i().assignee}
            fallback={<span class="text-muted/60">Unassigned</span>}
          >
            {(a) => (
              <>
                <Avatar.Root class="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full border border-border bg-surface">
                  <Avatar.Fallback class="text-[8px] font-medium text-muted">
                    {initials(a().name)}
                  </Avatar.Fallback>
                  <Avatar.Image
                    src={a().avatar_url ?? undefined}
                    alt=""
                    class="h-full w-full rounded-full object-cover"
                  />
                </Avatar.Root>
                <span class="truncate">{a().name}</span>
              </>
            )}
          </Show>
        </span>
      </A>
    </li>
  );
}

export function IssueList(props: { project: Project }) {
  const session = useSession();
  const navigate = useNavigate();
  const [chip, setChip] = createSignal<Chip>("all");
  const [q, setQ] = createSignal("");
  const [selIdx, setSelIdx] = createSignal(0);
  const [dialogOpen, setDialogOpen] = createSignal(false);
  let listEl: HTMLUListElement | undefined;

  const [issues, { refetch }] = createResource(
    () => props.project.id,
    async (id) => (await api.listIssues(id)).issues,
  );

  const unsub = subscribe((e) => {
    if (e.project_id === props.project.id && e.type.startsWith("issue.")) {
      refetch();
    }
  });
  onCleanup(unsub);

  const filtered = createMemo(() => {
    const me = session.user()?.id;
    const needle = q().trim().toLowerCase();
    return (issues() ?? []).filter((i) => {
      switch (chip()) {
        case "open":
          if (isClosed(i.status)) {
            return false;
          }
          break;
        case "mine":
          if (i.assignee?.id !== me) {
            return false;
          }
          break;
        case "done":
          if (!isClosed(i.status)) {
            return false;
          }
          break;
        default:
          break;
      }
      return needle === "" || i.title.toLowerCase().includes(needle);
    });
  });

  function scrollSelectedIntoView() {
    listEl
      ?.querySelector("[data-selected]")
      ?.scrollIntoView({ block: "nearest" });
  }

  function onKey(e: KeyboardEvent) {
    if (
      e.defaultPrevented ||
      e.metaKey ||
      e.ctrlKey ||
      e.altKey ||
      dialogOpen()
    ) {
      return;
    }
    const el = e.target;
    if (
      el instanceof HTMLElement &&
      el.closest("input, textarea, select, button, a, [contenteditable]")
    ) {
      return;
    }
    const list = filtered();
    if (e.key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      setSelIdx((i) => Math.min(i + 1, list.length - 1));
      scrollSelectedIntoView();
    } else if (e.key === "k" || e.key === "ArrowUp") {
      e.preventDefault();
      setSelIdx((i) => Math.max(i - 1, 0));
      scrollSelectedIntoView();
    } else if (e.key === "Enter") {
      const issue = list[selIdx()];
      if (issue) {
        navigate(`/app/p/${props.project.id}/i/${issue.id}`);
      }
    } else if (e.key === "c") {
      e.preventDefault();
      setDialogOpen(true);
    }
  }

  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="flex shrink-0 flex-wrap items-center gap-2 px-6 py-3">
        <div class="inline-flex rounded-md border border-border p-0.5">
          <For each={CHIPS}>
            {(c) => (
              <button
                type="button"
                onClick={() => {
                  setChip(c.id);
                  setSelIdx(0);
                }}
                class={`rounded-sm px-2.5 py-1 text-[12px] transition-colors ${
                  chip() === c.id
                    ? "bg-hover font-medium text-fg"
                    : "text-muted hover:text-fg"
                }`}
              >
                {c.label}
              </button>
            )}
          </For>
        </div>
        <div class="relative">
          <SearchIcon class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={q()}
            onInput={(e) => {
              setQ(e.currentTarget.value);
              setSelIdx(0);
            }}
            placeholder="Filter by title"
            aria-label="Filter issues by title"
            class="h-8 w-48 rounded-md border border-border bg-bg pl-8 pr-2.5 text-[13px] outline-none transition-colors placeholder:text-muted/60 focus:border-accent"
          />
        </div>
        <div class="flex-1" />
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          title="New issue (c)"
          class="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <PlusIcon class="h-3.5 w-3.5" />
          New issue
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        <Show
          when={issues.state === "ready"}
          fallback={
            <div class="flex justify-center py-10">
              <Show when={issues.state === "errored"} fallback={<Spinner />}>
                <p class="text-[13px] text-muted">Could not load issues</p>
              </Show>
            </div>
          }
        >
          <ul
            ref={(el) => {
              listEl = el;
            }}
            class="divide-y divide-border overflow-hidden rounded-md border border-border"
          >
            <For
              each={filtered()}
              fallback={
                <li class="px-3 py-6 text-center text-[13px] text-muted">
                  No issues match
                </li>
              }
            >
              {(i, idx) => (
                <IssueRow
                  projectId={props.project.id}
                  issue={i}
                  selected={idx() === selIdx()}
                  onHover={() => setSelIdx(idx())}
                />
              )}
            </For>
          </ul>
          <p class="mt-2 text-[11px] text-muted/60">
            j/k or arrows to move · Enter to open · c for a new issue
          </p>
        </Show>
      </div>

      <NewIssueDialog
        project={props.project}
        open={dialogOpen()}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            void refetch();
          }
        }}
      />
    </div>
  );
}
