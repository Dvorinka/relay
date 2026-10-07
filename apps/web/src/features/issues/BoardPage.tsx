import { A, useParams } from "@solidjs/router";
import { createResource, createSignal, For, Match, Show, Switch } from "solid-js";
import { api } from "../../lib/api";
import { confirmDestructive } from "../../components/Confirm";
import { Spinner, Tip } from "../../components/ui";
import { IssueIcon, PlusIcon, SettingsIcon, XIcon } from "../../components/icons";
import { Board } from "./Board";
import { Timeline } from "./Timeline";
import { Calendar } from "./Calendar";
import type { IssueFilters } from "@relay/api-client";

// Standalone kanban page — the chat header's Board button lands here so the
// board gets the full window instead of a sheet. Named boards (saved views)
// show up as tabs.
export default function BoardPage() {
  const params = useParams<{ projectId: string }>();
  const [project] = createResource(
    () => params.projectId,
    (id) => api.getProject(id),
  );
  const [boards, { refetch: refetchBoards }] = createResource(
    () => params.projectId,
    async (id) => (await api.listBoards(id)).boards,
  );
  const [activeBoard, setActiveBoard] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  // Board|Timeline|Calendar pick — persisted so the page reopens where it left.
  type ViewMode = "board" | "timeline" | "calendar";
  const [view, setView] = createSignal<ViewMode>(
    (["board", "timeline", "calendar"] as const).find(
      (v) => v === localStorage.getItem("relay.boardView"),
    ) ?? "board",
  );
  const setViewMode = (v: ViewMode) => {
    localStorage.setItem("relay.boardView", v);
    setView(v);
  };
  let nameEl: HTMLInputElement | undefined;

  const active = () => boards()?.find((b) => b.id === activeBoard());

  const saveBoard = async () => {
    const name = nameEl?.value.trim();
    if (!name) return;
    await api.createBoard(params.projectId, { name, filters: {} });
    if (nameEl) nameEl.value = "";
    setSaving(false);
    refetchBoards();
  };

  return (
    <div class="flex h-full min-h-0 flex-col">
      <header class="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
        <A
          href={`/app/p/${params.projectId}`}
          class="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <IssueIcon class="h-3.5 w-3.5 rotate-180" />
          Chat
        </A>
        <Show when={project()}>
          {(p) => (
            <>
              <span
                class="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ "background-color": p().color ?? "var(--accent)" }}
              />
              <h1 class="truncate text-[14.5px] font-semibold tracking-tight">
                {p().name}
              </h1>
              <span class="rounded border border-border px-1.5 py-0.5 font-mono text-[10.5px] text-muted">
                {p().key}
              </span>
            </>
          )}
        </Show>
        <div class="flex min-w-0 items-center gap-1 overflow-x-auto">
          <span class="text-[12.5px] text-muted">·</span>
          <button
            type="button"
            onClick={() => {
              setActiveBoard(null);
              setViewMode("board");
            }}
            class={`rounded px-2 py-1 text-[12.5px] transition-colors ${
              activeBoard() === null && view() === "board"
                ? "bg-hover font-medium text-fg"
                : "text-muted hover:text-fg"
            }`}
          >
            Board
          </button>
          <button
            type="button"
            onClick={() => setViewMode("timeline")}
            class={`rounded px-2 py-1 text-[12.5px] transition-colors ${
              view() === "timeline"
                ? "bg-hover font-medium text-fg"
                : "text-muted hover:text-fg"
            }`}
          >
            Timeline
          </button>
          <button
            type="button"
            onClick={() => setViewMode("calendar")}
            class={`rounded px-2 py-1 text-[12.5px] transition-colors ${
              view() === "calendar"
                ? "bg-hover font-medium text-fg"
                : "text-muted hover:text-fg"
            }`}
          >
            Calendar
          </button>
          <For each={boards() ?? []}>
            {(b) => (
              <span class="inline-flex items-center rounded border border-transparent">
                <button
                  type="button"
                  onClick={() => {
                    setActiveBoard(b.id);
                    setViewMode("board");
                  }}
                  class={`rounded px-2 py-1 text-[12.5px] transition-colors ${
                    activeBoard() === b.id && view() === "board"
                      ? "bg-hover font-medium text-fg"
                      : "text-muted hover:text-fg"
                  }`}
                >
                  {b.name}
                </button>
                <button
                  type="button"
                  aria-label={`Delete board ${b.name}`}
                  onClick={async () => {
                    if (
                      !(await confirmDestructive({
                        title: "Delete board",
                        body: `Delete the "${b.name}" view? Issues are unaffected.`,
                      }))
                    )
                      return;
                    await api.deleteBoard(params.projectId, b.id);
                    if (activeBoard() === b.id) setActiveBoard(null);
                    refetchBoards();
                  }}
                  class="rounded p-0.5 text-muted/50 opacity-0 transition-opacity hover:text-fg [span:hover>&]:opacity-100"
                >
                  <XIcon class="h-3 w-3" />
                </button>
              </span>
            )}
          </For>
          <Show when={view() === "board"}>
          <Show
            when={saving()}
            fallback={
              <button
                type="button"
                onClick={() => {
                  setSaving(true);
                  queueMicrotask(() => nameEl?.focus());
                }}
                class="flex h-6 items-center gap-1 rounded px-1.5 text-[11.5px] text-muted/70 transition-colors hover:bg-hover hover:text-fg"
              >
                <PlusIcon class="h-3 w-3" />
                Board
              </button>
            }
          >
            <span class="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface pl-2">
              <input
                ref={(el) => (nameEl = el)}
                placeholder="Board name"
                aria-label="Board name"
                class="w-28 bg-transparent text-[12.5px] outline-none placeholder:text-muted/60"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveBoard();
                  if (e.key === "Escape") setSaving(false);
                }}
              />
              <button
                type="button"
                onClick={() => void saveBoard()}
                class="h-full px-2 text-[12px] text-accent-ink hover:text-fg"
              >
                Save
              </button>
            </span>
          </Show>
          </Show>
        </div>
        <div class="flex-1" />
        <Tip
          text="Project settings"
          hint="Issue lanes, linked folder, brief policy, repos and webhooks."
          side="bottom"
        >
          <A
            href={`/app/p/${params.projectId}?view=settings`}
            aria-label="Project settings"
            class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <SettingsIcon class="h-4 w-4" />
          </A>
        </Tip>
      </header>
      <div class="flex min-h-0 flex-1 flex-col">
        <Show
          when={project()}
          fallback={
            <div class="flex flex-1 items-center justify-center">
              <Spinner class="h-4 w-4" />
            </div>
          }
        >
          {(p) => (
            <Switch
              fallback={
                <Board
                  project={p()}
                  filters={active()?.filters as IssueFilters | undefined}
                />
              }
            >
              <Match when={view() === "timeline"}>
                <Timeline project={p()} />
              </Match>
              <Match when={view() === "calendar"}>
                <Calendar project={p()} />
              </Match>
            </Switch>
          )}
        </Show>
      </div>
    </div>
  );
}
