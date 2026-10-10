import { A } from "@solidjs/router";
import {
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { ActivityIssue, ActivityMessage, Project } from "@relay/api-client";
import { api } from "../lib/api";
import { subscribe } from "../lib/events";
import { FullPageSpinner, inputClass } from "../components/ui";
import { GripIcon, SearchIcon } from "../components/icons";
import { mediaURL } from "../lib/net";
import { messagePreview } from "../lib/text";
import { timeAgo } from "../lib/time";
import { StatusDot } from "../features/issues/meta";
import {
  setProjectOrder,
  setProjectSort,
  useProjects,
  useProjectSort,
  type ProjectSort,
} from "../stores/projects";
import { usePendingReviews, useUnread } from "../stores/unread";

export default function Home() {
  const projects = useProjects();
  const { unread } = useUnread();
  const { pendingReviews } = usePendingReviews();
  const { projectSort } = useProjectSort();
  const [query, setQuery] = createSignal("");
  const [dragId, setDragId] = createSignal<string | null>(null);
  const [activity, { refetch: refetchActivity }] = createResource(() =>
    api.myActivity(),
  );

  // The feed is live: new messages, issue changes and review events refresh
  // it, debounced so a busy channel doesn't hammer the endpoint. Pull-to-
  // refresh (phones) hits the same path.
  onMount(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      clearTimeout(t);
      // last_activity_at moves too — the activity sort reorders live
      t = setTimeout(() => {
        void refetchActivity();
        void projects.refresh();
      }, 600);
    };
    const unsub = subscribe((e) => {
      if (
        e.type.startsWith("message.") ||
        e.type.startsWith("issue.") ||
        e.type.startsWith("review.")
      ) {
        bump();
      }
    });
    const onPull = () => {
      void refetchActivity();
      void projects.refresh();
    };
    window.addEventListener("relay:refresh", onPull);
    onCleanup(() => {
      unsub();
      clearTimeout(t);
      window.removeEventListener("relay:refresh", onPull);
    });
  });

  const rows = () => {
    const q = query().trim().toLowerCase();
    const list = projects.sorted();
    if (!q) return list;
    return list.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.key.toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q),
    );
  };

  const totals = () => {
    const list = projects.projects() ?? [];
    return {
      projects: list.length,
      unread: Object.values(unread()).reduce((s, n) => s + n, 0),
      issues: list.reduce((s, p) => s + (p.open_issues ?? 0), 0),
      prs: list.reduce((s, p) => s + (p.open_prs ?? 0), 0),
      reviews: Object.values(pendingReviews()).reduce((s, n) => s + n, 0),
    };
  };

  // Manual ordering: drag a card's handle over another card to re-slot it.
  // The order array covers every project — a filtered view disables drag so
  // hidden rows can't corrupt the sequence.
  const dragging = () => dragId() !== null;
  const startDrag = (e: PointerEvent, id: string) => {
    e.preventDefault();
    setDragId(id);
    let order = projects.sorted().map((p) => p.id);
    const move = (ev: PointerEvent) => {
      const over = document
        .elementFromPoint(ev.clientX, ev.clientY)
        ?.closest("[data-pid]")
        ?.getAttribute("data-pid");
      if (!over || over === id) return;
      const from = order.indexOf(id);
      const to = order.indexOf(over);
      if (from < 0 || to < 0) return;
      order = [...order];
      order.splice(to, 0, order.splice(from, 1)[0]!);
      setProjectOrder(order);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setDragId(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  return (
    <Show when={!projects.loading()} fallback={<FullPageSpinner />}>
      <Show
        when={(projects.projects() ?? []).length > 0}
        fallback={
          <div class="flex h-full items-center justify-center">
            <p class="text-sm text-muted">No projects yet</p>
          </div>
        }
      >
        <div class="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-6 sm:py-8">
          <div class="mb-4 flex flex-wrap items-center gap-2 sm:gap-3">
            <h1 class="text-[15px] font-semibold">Projects</h1>
            <span class="text-[12px] text-muted">{totals().projects}</span>
            <div class="relative ml-auto w-48 sm:w-56">
              <SearchIcon class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
              <input
                type="search"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
                placeholder="Search projects"
                aria-label="Search projects"
                class={`${inputClass} !pl-8`}
              />
            </div>
            <select
              value={projectSort()}
              onChange={(e) => setProjectSort(e.currentTarget.value as ProjectSort)}
              aria-label="Sort projects"
              class={`${inputClass} !w-auto`}
            >
              <option value="activity">Active first</option>
              <option value="name">Name</option>
              <option value="manual">Manual</option>
            </select>
          </div>

          <Show when={projectSort() === "manual"}>
            <p class="mb-3 text-[12px] text-muted">
              Drag cards by their handle to set your own order — saved on this
              device and used in the sidebar too.
            </p>
          </Show>

          <div class="flex flex-col gap-6 lg:flex-row">
            <div class="min-w-0 flex-1">
              <div class="mb-4 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-muted">
                <Show when={totals().unread > 0}>
                  <span>
                    <b class="font-medium text-accent">{totals().unread}</b> unread
                  </span>
                </Show>
                <span>
                  <b class="font-medium text-fg">{totals().issues}</b> open issues
                </span>
                <span>
                  <b class="font-medium text-fg">{totals().prs}</b> open PRs
                </span>
                <Show when={totals().reviews > 0}>
                  <span>
                    <b class="font-medium text-amber-500">{totals().reviews}</b>{" "}
                    reviews pending
                  </span>
                </Show>
              </div>

              <Show
                when={rows().length > 0}
                fallback={
                  <p class="py-8 text-center text-[13px] text-muted">
                    No projects match "{query()}"
                  </p>
                }
              >
                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  <For each={rows()}>
                    {(p) => (
                      <ProjectCard
                        project={p}
                        unread={unread()[p.id] ?? 0}
                        reviews={pendingReviews()[p.id] ?? 0}
                        manual={projectSort() === "manual" && !query()}
                        dragging={dragging() && dragId() === p.id}
                        onDragStart={(e) => startDrag(e, p.id)}
                      />
                    )}
                  </For>
                </div>
              </Show>
            </div>

            <FeedPanel activity={activity()} />
          </div>
        </div>
      </Show>
    </Show>
  );
}

// Right-hand work feed: what needs attention across every project — pending
// reviews, open PRs, freshest issues, latest messages. Stacked under the grid
// on phones, a fixed rail on desktop.
function FeedPanel(props: {
  activity: Awaited<ReturnType<typeof api.myActivity>> | undefined;
}) {
  const act = () => props.activity;
  const empty = () =>
    act() !== undefined &&
    act()!.open_issues.length === 0 &&
    act()!.open_prs.length === 0 &&
    act()!.recent_messages.length === 0;
  return (
    <aside class="w-full shrink-0 lg:w-80 xl:w-[22rem]">
      <h2 class="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-muted">
        Across projects
        <A
          href="/app/overview"
          class="ml-auto text-[11px] font-medium normal-case tracking-normal text-muted transition-colors hover:text-accent"
        >
          view all
        </A>
      </h2>
      <Show when={empty()}>
        <p class="text-[12px] text-muted">Nothing in flight — all caught up.</p>
      </Show>
      <IssueFeed title="Open PRs" items={act()?.open_prs ?? []} />
      <IssueFeed title="Open issues" items={act()?.open_issues ?? []} />
      <MessageFeed items={act()?.recent_messages ?? []} />
    </aside>
  );
}

function IssueFeed(props: { title: string; items: ActivityIssue[] }) {
  return (
    <Show when={props.items.length > 0}>
      <section class="mb-4">
        <h3 class="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">
          {props.title}
        </h3>
        <ul class="divide-y divide-border/60 overflow-hidden rounded-md border border-border bg-surface">
          <For each={props.items.slice(0, 5)}>
            {(i) => (
              <li>
                <A
                  href={`/app/p/${i.project_id}/i/${i.id}`}
                  class="flex items-center gap-2 px-3 py-2 transition-colors hover:bg-hover"
                >
                  <StatusDot status={i.status} class="h-1.5 w-1.5 shrink-0" />
                  <span class="shrink-0 font-mono text-[10.5px] text-muted">
                    {i.key}
                  </span>
                  <span class="min-w-0 flex-1 truncate text-[12.5px]">
                    {i.title}
                  </span>
                  <span class="shrink-0 text-[10.5px] text-faint">
                    {timeAgo(i.updated_at)}
                  </span>
                </A>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  );
}

function MessageFeed(props: { items: ActivityMessage[] }) {
  return (
    <Show when={props.items.length > 0}>
      <section>
        <h3 class="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">
          Latest messages
        </h3>
        <ul class="divide-y divide-border/60 overflow-hidden rounded-md border border-border bg-surface">
          <For each={props.items.slice(0, 5)}>
            {(m) => (
              <li>
                <A
                  href={`/app/p/${m.project_id}`}
                  class="block px-3 py-2 transition-colors hover:bg-hover"
                >
                  <span class="flex items-baseline gap-1.5">
                    <span class="shrink-0 text-[12px] font-medium">
                      {m.author.name}
                      {m.author.kind === "agent" ? "·agent" : ""}
                    </span>
                    <span class="shrink-0 font-mono text-[10px] text-faint">
                      {m.project_key}
                    </span>
                    <span class="ml-auto shrink-0 text-[10.5px] text-faint">
                      {timeAgo(m.created_at)}
                    </span>
                  </span>
                  <span class="mt-0.5 block truncate text-[12px] text-muted">
                    {messagePreview(m.body)}
                  </span>
                </A>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  );
}

function ProjectCard(props: {
  project: Project;
  unread: number;
  reviews: number;
  manual: boolean;
  dragging: boolean;
  onDragStart: (e: PointerEvent) => void;
}) {
  const p = () => props.project;
  const stats = () => {
    const out: string[] = [];
    if (p().open_issues) out.push(`${p().open_issues} issue${p().open_issues === 1 ? "" : "s"}`);
    if (p().open_prs) out.push(`${p().open_prs} PR${p().open_prs === 1 ? "" : "s"}`);
    if (p().members) out.push(`${p().members} member${p().members === 1 ? "" : "s"}`);
    return out;
  };
  return (
    <div
      data-pid={p().id}
      class={`relative rounded-md border border-border bg-surface transition-colors hover:bg-hover ${
        props.dragging ? "opacity-50" : ""
      }`}
    >
      <Show when={props.manual}>
        <button
          type="button"
          aria-label={`Reorder ${p().name}`}
          title="Drag to reorder"
          onPointerDown={(e) => props.onDragStart(e)}
          class="absolute left-1.5 top-3.5 z-10 cursor-grab touch-none rounded p-1 text-faint transition-colors hover:text-fg"
        >
          <GripIcon class="h-3.5 w-3.5" />
        </button>
      </Show>
      <A
        href={`/app/p/${p().id}`}
        class={`block p-4 pb-3 ${props.manual ? "pl-8" : ""}`}
      >
        <div class="flex items-center gap-2">
          <Show
            when={p().icon_url}
            fallback={
              <span
                class="h-2 w-2 shrink-0 rounded-full"
                style={{ "background-color": p().color ?? "var(--accent)" }}
              />
            }
          >
            {(url) => (
              <img
                src={mediaURL(url())}
                alt=""
                class="h-4 w-4 shrink-0 rounded object-cover"
              />
            )}
          </Show>
          <span class="truncate text-[13.5px] font-medium">{p().name}</span>
          <span class="ml-auto shrink-0 font-mono text-[11px] text-muted">
            {p().key}
          </span>
          <Show when={props.reviews > 0}>
            <span class="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-px font-mono text-[10px] font-semibold leading-4 text-amber-600 dark:text-amber-400">
              {props.reviews}
            </span>
          </Show>
          <Show when={props.unread > 0}>
            <span class="shrink-0 rounded-full bg-accent px-1.5 py-px font-mono text-[10px] font-semibold leading-4 text-white">
              {props.unread > 99 ? "99+" : props.unread}
            </span>
          </Show>
        </div>
        <p class="mt-1.5 line-clamp-2 min-h-[1em] text-[13px] text-muted">
          {p().description}
        </p>
      </A>
      <div class="flex items-center gap-x-3 gap-y-1 border-t border-border/60 px-4 py-2 text-[11.5px] text-muted">
        <Show when={stats().length > 0} fallback={<span>empty</span>}>
          <For each={stats()}>
            {(s) => <span class="whitespace-nowrap">{s}</span>}
          </For>
        </Show>
        <span class="ml-auto shrink-0 text-faint">
          {p().last_activity_at ? `active ${timeAgo(p().last_activity_at!)}` : ""}
        </span>
      </div>
    </div>
  );
}
