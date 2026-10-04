import type { Issue, Project, SavedFilter, StatusDef } from "@relay/api-client";
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
import { XIcon, PlusIcon, SearchIcon, IssueIcon } from "../../components/icons";
import { Spinner, Tip } from "../../components/ui";
import { markGitHub } from "../github/GitHub";
import { api } from "../../lib/api";
import { confirmDestructive } from "../../components/Confirm";
import { subscribe } from "../../lib/events";
import { mediaURL } from "../../lib/net";
import { initials } from "../../lib/text";
import { useSession } from "../../stores/session";
import {
  isClosed,
  GitHubBadge,
  LabelChip,
  PRIORITY_LABEL,
  PriorityGlyph,
  statusDefs,
  statusLabel,
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
  defs: StatusDef[];
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
        <Tip
          text={`Priority: ${PRIORITY_LABEL[i().priority]}`}
          hint="How urgent this issue is — set on the issue page."
          side="bottom"
        >
          <span class="flex w-14 shrink-0 cursor-default items-center gap-1.5 text-[11px] text-muted">
            <PriorityGlyph priority={i().priority} />
            <Show when={i().priority !== "none"}>
              {PRIORITY_LABEL[i().priority]}
            </Show>
          </span>
        </Tip>
        <span class="flex w-20 shrink-0 items-center gap-1.5 text-[11px] text-muted">
          <StatusDot status={i().status} defs={props.defs} />
          <span class="truncate">{statusLabel(i().status, props.defs)}</span>
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
                    src={mediaURL(a().avatar_url)}
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

// IssueSection renders one labelled group (Local or GitHub) inside the list.
// The small glyph carries a custom Tip explaining what the section is.
function IssueSection(props: {
  label: string;
  hint: string;
  gh?: boolean;
  issues: Issue[];
  filtered: Issue[];
  projectId: string;
  defs: StatusDef[];
  selectedId: string | undefined;
  onHover: (idx: number) => void;
}) {
  return (
    <Show when={props.issues.length > 0}>
      <h3 class="mt-4 mb-1.5 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted/80 first:mt-0">
        <Tip
          text={props.gh ? "GitHub issues" : "Local issues"}
          hint={props.hint}
          side="bottom"
        >
          <span
            tabindex={0}
            class="inline-flex cursor-default items-center text-muted"
          >
            {props.gh ? (
              markGitHub("h-3.5 w-3.5")
            ) : (
              <IssueIcon class="h-3.5 w-3.5" />
            )}
          </span>
        </Tip>
        {props.label}
        <span class="ml-auto rounded-md bg-surface px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-muted">
          {props.issues.length}
        </span>
      </h3>
      <ul class="divide-y divide-border overflow-hidden rounded-md border border-border">
        <For each={props.issues}>
          {(i) => (
            <IssueRow
              projectId={props.projectId}
              issue={i}
              selected={i.id === props.selectedId}
              onHover={() =>
                props.onHover(props.filtered.findIndex((x) => x.id === i.id))
              }
              defs={props.defs}
            />
          )}
        </For>
      </ul>
    </Show>
  );
}

export function IssueList(props: { project: Project }) {
  const session = useSession();
  const navigate = useNavigate();
  const [chip, setChip] = createSignal<Chip>("all");
  const [q, setQ] = createSignal("");
  const [selIdx, setSelIdx] = createSignal(0);
  const [dialogOpen, setDialogOpen] = createSignal(false);
  let listEl: HTMLDivElement | undefined;

  const defs = () => statusDefs(props.project);

  const [issues, { refetch }] = createResource(
    () => props.project.id,
    async (id) => (await api.listIssues(id)).issues,
  );

  const [savedFilters, { refetch: refetchSaved }] = createResource(
    () => props.project.id,
    async (id) => (await api.listSavedFilters(id)).filters,
  );
  const [savingView, setSavingView] = createSignal(false);
  let filterNameEl: HTMLInputElement | undefined;

  const applySaved = (f: SavedFilter) => {
    const fl = f.filters as { chip?: Chip; q?: string };
    if (fl.chip === "all" || fl.chip === "open" || fl.chip === "mine" || fl.chip === "done") {
      setChip(fl.chip);
    }
    if (typeof fl.q === "string") {
      setQ(fl.q);
    }
    setSelIdx(0);
  };

  const saveView = async () => {
    const name = filterNameEl?.value.trim();
    if (!name) {
      return;
    }
    await api.createSavedFilter(props.project.id, {
      name,
      filters: { chip: chip(), q: q() },
    });
    if (filterNameEl) filterNameEl.value = "";
    setSavingView(false);
    refetchSaved();
  };

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
      // GitHub PRs are mirrored as issues (github.kind="pr") but are pull
      // requests, not issues — they live under the Pull requests view.
      if (i.github?.kind === "pr") {
        return false;
      }
      switch (chip()) {
        case "open":
          if (isClosed(i.status, defs())) {
            return false;
          }
          break;
        case "mine":
          if (i.assignee?.id !== me) {
            return false;
          }
          break;
        case "done":
          if (!isClosed(i.status, defs())) {
            return false;
          }
          break;
        default:
          break;
      }
      return needle === "" || i.title.toLowerCase().includes(needle);
    });
  });

  // Two sections: issues authored in Relay vs issues mirrored from the
  // linked GitHub repository. Selection stays one flat list for j/k nav.
  const localIssues = createMemo(() =>
    filtered().filter((i) => i.github === undefined),
  );
  const ghIssues = createMemo(() =>
    filtered().filter((i) => i.github?.kind === "issue"),
  );
  const selectedId = () => filtered()[selIdx()]?.id;

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
        <For each={savedFilters() ?? []}>
          {(f) => (
            <span class="inline-flex items-center gap-0.5 rounded-full border border-border bg-surface pl-2.5 pr-1 text-[12px]">
              <Tip text={f.name} hint="Apply this saved view">
                <button
                  type="button"
                  onClick={() => applySaved(f)}
                  class="py-0.5 text-muted transition-colors hover:text-fg"
                >
                  {f.name}
                </button>
              </Tip>
              <button
                type="button"
                aria-label={`Delete filter ${f.name}`}
                onClick={async () => {
                  if (
                    !(await confirmDestructive({
                      title: "Delete saved view",
                      body: `Delete "${f.name}"?`,
                    }))
                  )
                    return;
                  await api.deleteSavedFilter(props.project.id, f.id);
                  refetchSaved();
                }}
                class="rounded p-0.5 text-muted/60 transition-colors hover:text-fg"
              >
                <XIcon class="h-3 w-3" />
              </button>
            </span>
          )}
        </For>
        <div class="flex-1" />
        <Show
          when={savingView()}
          fallback={
            <Tip text="Save view" hint="Keeps the current chip and search as a named, one-click filter." side="bottom">
              <button
                type="button"
                onClick={() => {
                  setSavingView(true);
                  queueMicrotask(() => filterNameEl?.focus());
                }}
                class="h-8 rounded-md border border-border px-2.5 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg"
              >
                Save view
              </button>
            </Tip>
          }
        >
          <span class="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-surface pl-2">
            <input
              ref={(el) => (filterNameEl = el)}
              placeholder="View name"
              aria-label="Saved view name"
              class="w-28 bg-transparent text-[13px] outline-none placeholder:text-muted/60"
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveView();
                if (e.key === "Escape") setSavingView(false);
              }}
            />
            <button
              type="button"
              onClick={() => void saveView()}
              class="h-full px-2 text-[12px] text-accent-ink transition-colors hover:text-fg"
            >
              Save
            </button>
            <button
              type="button"
              aria-label="Cancel"
              onClick={() => setSavingView(false)}
              class="h-full px-1.5 text-muted/60 transition-colors hover:text-fg"
            >
              <XIcon class="h-3 w-3" />
            </button>
          </span>
        </Show>
        <Tip text="New issue" hint="Creates a local Relay issue — press c anywhere in this list." side="bottom">
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            class="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <PlusIcon class="h-3.5 w-3.5" />
            New issue
          </button>
        </Tip>
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
          <div
            ref={(el) => {
              listEl = el;
            }}
          >
            <IssueSection
              label="Local"
              hint="Created in Relay — these exist only here, not on GitHub."
              issues={localIssues()}
              filtered={filtered()}
              projectId={props.project.id}
              defs={defs()}
              selectedId={selectedId()}
              onHover={(i) => setSelIdx(i)}
            />
            <IssueSection
              label="GitHub"
              hint="Mirrored from the linked repository — pull requests are under the Pull requests icon."
              gh
              issues={ghIssues()}
              filtered={filtered()}
              projectId={props.project.id}
              defs={defs()}
              selectedId={selectedId()}
              onHover={(i) => setSelIdx(i)}
            />
            <Show when={filtered().length === 0}>
              <p class="rounded-md border border-border px-3 py-6 text-center text-[13px] text-muted">
                No issues match
              </p>
            </Show>
          </div>
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
