import { A } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { Avatar } from "@ark-ui/solid";
import type { UnreadConversation } from "@relay/api-client";
import { inputClass, Spinner } from "../components/ui";
import { SearchIcon, XIcon } from "../components/icons";
import { api } from "../lib/api";
import { mediaURL } from "../lib/net";
import { subscribe } from "../lib/events";
import { initials, messagePreview } from "../lib/text";
import { timeAgo } from "../lib/time";
import { useProjects } from "../stores/projects";
import {
  markAllRead,
  markConversationRead,
  refreshUnread,
  useUnread,
  useUnreadConversations,
} from "../stores/unread";

// Filter kinds unify the three sections: "unread" means any unread row or
// unread mention; thread/issue/channel match both unread rows and mentions
// living inside those surfaces.
type Kind =
  | "all"
  | "unread"
  | "mention"
  | "review"
  | "thread"
  | "issue"
  | "channel";

const KIND_CHIPS: { id: Kind; label: string }[] = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
  { id: "mention", label: "Mentions" },
  { id: "review", label: "Reviews" },
  { id: "thread", label: "Threads" },
  { id: "issue", label: "Issues" },
  { id: "channel", label: "Channels" },
];

type Filters = {
  q: () => string;
  kind: () => Kind;
  project: () => string;
};

function PendingReviews(props: {
  f: Filters;
  onCount: (n: number) => void;
}) {
  const [reviews, { refetch }] = createResource(() =>
    api.myReviews().then((r) => r.reviews),
  );
  const unsub = subscribe((e) => {
    if (e.type === "review.created" || e.type === "review.responded") {
      void refetch();
    }
  });
  onCleanup(unsub);

  const shown = createMemo(() => {
    const q = props.f.q().toLowerCase();
    const k = props.f.kind();
    const pid = props.f.project();
    return (reviews() ?? []).filter((r) => {
      if (k !== "all" && k !== "review") return false;
      if (pid !== "all" && r.project_id !== pid) return false;
      if (
        q &&
        !`${r.title} ${r.agent.name} ${r.project_name} ${r.project_key}`
          .toLowerCase()
          .includes(q)
      )
        return false;
      return true;
    });
  });
  createEffect(() => props.onCount(shown().length));

  return (
    <Show when={shown().length > 0}>
      <section class="mb-6">
        <h2 class="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-muted">
          Awaiting your verdict
          <span class="rounded-full bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-400">
            {shown().length}
          </span>
        </h2>
        <ul class="divide-y divide-border overflow-hidden rounded-md border border-violet-500/30">
          <For each={shown()}>
            {(r) => (
              <li>
                <A
                  href={`/app/p/${r.project_id}?view=reviews`}
                  class="flex items-start gap-3 bg-violet-500/[0.04] px-4 py-3 transition-colors hover:bg-violet-500/[0.08]"
                >
                  <Avatar.Root class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-surface">
                    <Avatar.Fallback class="text-[10px] font-medium text-muted">
                      {initials(r.agent.name)}
                    </Avatar.Fallback>
                    <Avatar.Image
                      src={mediaURL(r.agent.avatar_url)}
                      alt=""
                      class="h-full w-full rounded-full object-cover"
                    />
                  </Avatar.Root>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-baseline gap-2">
                      <span class="truncate text-[13px] font-medium">
                        {r.title}
                      </span>
                      <span class="ml-auto shrink-0 text-[11px] text-muted">
                        {timeAgo(r.created_at)}
                      </span>
                    </div>
                    <p class="mt-0.5 truncate text-[13px] text-muted">
                      {r.agent.name} · {r.project_name}{" "}
                      <span class="font-mono text-[11px]">{r.project_key}</span>
                    </p>
                  </div>
                </A>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  );
}

// Conversations with unread messages — each row lands on the exact place:
// the channel scrolls to its "New" divider, issues open their page, threads
// jump to the parent message. Older servers return only per-project counts —
// fall back to project rows for those.
function UnreadChannels(props: {
  f: Filters;
  onCount: (n: number) => void;
}) {
  const { unread } = useUnread();
  const { unreadConversations } = useUnreadConversations();
  const projects = useProjects();
  const projectOf = (id: string) =>
    projects.projects()?.find((p) => p.id === id);

  type Row = {
    count: number;
    project: NonNullable<ReturnType<typeof projectOf>>;
    where: string | null;
    href: string;
    conv: UnreadConversation | null;
  };

  const hrefFor = (c: UnreadConversation): string => {
    switch (c.kind) {
      case "issue":
        return `/app/p/${c.project_id}/i/${c.issue_id}`;
      case "brief":
        return `/app/p/${c.project_id}?view=reviews`;
      case "thread":
        return `/app/p/${c.project_id}?msg=${c.parent_message_id}`;
      default:
        return `/app/p/${c.project_id}`;
    }
  };

  const whereFor = (c: UnreadConversation, key: string): string => {
    switch (c.kind) {
      case "issue":
        return `${key}-${c.issue_number ?? "?"}${c.issue_title ? ` · ${c.issue_title}` : ""}`;
      case "brief":
        return `review${c.brief_title ? ` · ${c.brief_title}` : ""}`;
      case "thread":
        return `thread${c.title ? ` · ${c.title}` : ""}`;
      default:
        return "channel";
    }
  };

  const rows = (): Row[] => {
    const k = props.f.kind();
    const pid = props.f.project();
    const q = props.f.q().toLowerCase();
    const keep = (r: Row): boolean => {
      if (pid !== "all" && r.project.id !== pid) return false;
      if (k !== "all" && k !== "unread") {
        // Generic project rows have no sub-kind; only conv rows match.
        if (!r.conv || r.conv.kind !== k) return false;
      }
      if (q) {
        const hay =
          `${r.project.name} ${r.project.key} ${r.where ?? ""} ${r.conv?.snippet ?? ""} ${r.conv?.author_name ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    };
    const convs = unreadConversations();
    if (convs.length > 0) {
      return convs
        .map((c): Row | null => {
          const p = projectOf(c.project_id);
          if (!p || c.unread <= 0) return null;
          return {
            count: c.unread,
            project: p,
            where: whereFor(c, p.key),
            href: hrefFor(c),
            conv: c,
          };
        })
        .filter((r): r is Row => r !== null && keep(r))
        .sort((a, b) => b.count - a.count);
    }
    return Object.entries(unread())
      .map(([projectId, count]): Row | null => {
        const p = projectOf(projectId);
        if (!p || count <= 0) return null;
        return {
          count,
          project: p,
          where: null,
          href: `/app/p/${projectId}`,
          conv: null,
        };
      })
      .filter((r): r is Row => r !== null && keep(r));
  };
  createEffect(() => props.onCount(rows().length));

  return (
    <Show when={rows().length > 0}>
      <section class="mb-6">
        <h2 class="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-muted">
          Unread
          <span class="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
            {rows().reduce((s, r) => s + r.count, 0)}
          </span>
          <Show when={unreadConversations().length > 0}>
            <button
              type="button"
              onClick={() => void markAllRead()}
              class="ml-auto text-[11px] font-normal normal-case tracking-normal text-muted transition-colors hover:text-accent"
            >
              mark all read
            </button>
          </Show>
        </h2>
        <ul class="divide-y divide-border overflow-hidden rounded-md border border-border">
          <For each={rows()}>
            {(r) => (
              <li class="group relative">
                <A
                  href={r.href}
                  class="flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-hover"
                >
                  <span
                    class="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{
                      "background-color": r.project.color ?? "var(--accent)",
                    }}
                  />
                  <div class="min-w-0 flex-1">
                    <div class="flex items-baseline gap-2">
                      <span class="truncate text-[13px] font-medium">
                        {r.project.name}
                      </span>
                      <span class="min-w-0 flex-1 truncate text-[12px] text-muted">
                        {r.where ?? r.project.key}
                      </span>
                      <Show when={r.conv?.first_unread_at}>
                        {(t) => (
                          <span class="shrink-0 text-[11px] text-faint">
                            {timeAgo(t())}
                          </span>
                        )}
                      </Show>
                      <span class="ml-auto shrink-0 rounded-full bg-accent px-1.5 py-px font-mono text-[10px] font-semibold leading-4 text-white">
                        {r.count > 99 ? "99+" : r.count}
                      </span>
                    </div>
                    <Show when={r.conv?.snippet}>
                      {(s) => (
                        <p class="mt-0.5 truncate text-[12px] text-muted">
                          <Show when={r.conv?.author_name}>
                            <span class="text-fg/70">
                              {r.conv!.author_name}
                            </span>
                            {": "}
                          </Show>
                          {messagePreview(s())}
                        </p>
                      )}
                    </Show>
                  </div>
                </A>
                <Show when={r.conv}>
                  {(c) => (
                    <button
                      type="button"
                      aria-label={`Mark ${r.project.name} ${r.where ?? "channel"} read`}
                      title="Mark read"
                      onClick={() => void markConversationRead(c())}
                      class="absolute right-10 top-1/2 -translate-y-1/2 rounded p-1 text-faint opacity-60 transition-opacity hover:text-accent sm:opacity-0 sm:group-hover:opacity-100"
                    >
                      <svg viewBox="0 0 16 16" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M2.5 8.5l3.5 3.5 7-8" />
                      </svg>
                    </button>
                  )}
                </Show>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  );
}

export default function Inbox() {
  const [mentions, { refetch }] = createResource(() =>
    api.mentions().then((r) => r.mentions),
  );
  const { unread } = useUnread();
  const projects = useProjects();
  const totalUnread = () =>
    Object.values(unread()).reduce((s, n) => s + n, 0);

  const [query, setQuery] = createSignal("");
  const [kind, setKind] = createSignal<Kind>("all");
  const [projectId, setProjectId] = createSignal("all");
  const f: Filters = { q: query, kind, project: projectId };
  const hasFilters = () =>
    query().trim() !== "" || kind() !== "all" || projectId() !== "all";
  const clearFilters = () => {
    setQuery("");
    setKind("all");
    setProjectId("all");
  };

  const [unreadN, setUnreadN] = createSignal(0);
  const [reviewN, setReviewN] = createSignal(0);
  const projectName = (id: string) =>
    projects.projects()?.find((p) => p.id === id)?.name ?? "";

  const shownMentions = createMemo(() => {
    const q = query().toLowerCase();
    const k = kind();
    const pid = projectId();
    return (mentions() ?? []).filter((m) => {
      switch (k) {
        case "all":
          break;
        case "unread":
          if (m.is_read) return false;
          break;
        case "mention":
          break;
        case "thread":
          if (m.conversation_kind !== "thread") return false;
          break;
        case "issue":
          if (!m.issue_id) return false;
          break;
        case "channel":
          if (m.conversation_kind !== "channel" || m.issue_id) return false;
          break;
        default:
          return false;
      }
      if (pid !== "all" && m.project_id !== pid) return false;
      if (
        q &&
        !`${m.body} ${m.author.name} ${projectName(m.project_id)}`
          .toLowerCase()
          .includes(q)
      )
        return false;
      return true;
    });
  });

  const nothingFound = () =>
    hasFilters() &&
    mentions.state === "ready" &&
    unreadN() === 0 &&
    reviewN() === 0 &&
    shownMentions().length === 0;

  const unsub = subscribe((e) => {
    if (e.type === "message.created") {
      void refetch();
      void refreshUnread();
    }
  });
  const onPull = () => {
    void refetch();
    void refreshUnread();
  };
  window.addEventListener("relay:refresh", onPull);
  onCleanup(() => {
    unsub();
    window.removeEventListener("relay:refresh", onPull);
  });

  return (
    <div class="flex h-full flex-col">
      <header class="shrink-0 border-b border-border px-6 py-4">
        <h1 class="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
          Inbox
          <Show when={totalUnread() > 0}>
            <span class="rounded-full bg-accent px-1.5 py-px font-mono text-[10.5px] font-semibold leading-4 text-white">
              {totalUnread() > 99 ? "99+" : totalUnread()}
            </span>
          </Show>
        </h1>
        <p class="mt-0.5 text-[12px] text-muted">
          Reviews awaiting you, mentions and unread activity across your workspaces
        </p>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <div class="relative min-w-40 flex-1 sm:max-w-xs">
            <SearchIcon class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <input
              type="search"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              placeholder="Search inbox…"
              aria-label="Search inbox"
              class={`${inputClass} pl-8`}
            />
          </div>
          <div class="flex flex-wrap items-center gap-1">
            <For each={KIND_CHIPS}>
              {(c) => (
                <button
                  type="button"
                  onClick={() => setKind(c.id)}
                  aria-pressed={kind() === c.id}
                  class={`rounded-full border px-2.5 py-1 text-[11.5px] transition-colors ${
                    kind() === c.id
                      ? "border-accent bg-accent/10 font-medium text-accent"
                      : "border-border text-muted hover:border-muted/60 hover:text-fg"
                  }`}
                >
                  {c.label}
                </button>
              )}
            </For>
          </div>
          <select
            value={projectId()}
            onChange={(e) => setProjectId(e.currentTarget.value)}
            aria-label="Filter by project"
            class={`${inputClass} w-auto`}
          >
            <option value="all">All projects</option>
            <For each={projects.projects() ?? []}>
              {(p) => <option value={p.id}>{p.name}</option>}
            </For>
          </select>
          <Show when={hasFilters()}>
            <button
              type="button"
              onClick={clearFilters}
              class="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11.5px] text-muted transition-colors hover:border-muted/60 hover:text-fg"
            >
              <XIcon class="h-3 w-3" />
              Clear
            </button>
          </Show>
        </div>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <UnreadChannels f={f} onCount={setUnreadN} />
        <PendingReviews f={f} onCount={setReviewN} />
        <Show
          when={mentions.state === "ready"}
          fallback={
            <div class="flex justify-center py-10">
              <Show when={mentions.state === "errored"} fallback={<Spinner />}>
                <p class="text-[13px] text-muted">Could not load inbox</p>
              </Show>
            </div>
          }
        >
          <Show
            when={(mentions() ?? []).some((m) => !m.is_read)}
          >
            <div class="mb-2 flex justify-end">
              <button
                type="button"
                onClick={() => {
                  const unread = (mentions() ?? []).filter((m) => !m.is_read);
                  void Promise.allSettled(
                    unread.map((m) => api.markMessageRead(m.id)),
                  ).then(refetch);
                }}
                class="text-[11px] font-medium text-muted transition-colors hover:text-accent"
              >
                mark all mentions read
              </button>
            </div>
          </Show>
          <ul class="divide-y divide-border overflow-hidden rounded-md border border-border">
            <For
              each={shownMentions()}
              fallback={
                <li class="px-4 py-8 text-center text-[13px] text-muted">
                  {hasFilters()
                    ? "No mentions match these filters"
                    : "No mentions yet — someone will say your name eventually"}
                </li>
              }
            >
              {(m) => (
                <li>
                  <A
                    href={
                      m.issue_id
                        ? `/app/p/${m.project_id}/i/${m.issue_id}`
                        : `/app/p/${m.project_id}?msg=${
                            m.conversation_kind === "thread" &&
                            m.parent_message_id
                              ? m.parent_message_id
                              : m.id
                          }`
                    }
                    class={`flex items-start gap-3 px-4 py-3 transition-colors hover:bg-hover ${
                      m.is_read ? "opacity-60" : ""
                    }`}
                    onClick={() => {
                      if (!m.is_read) {
                        void api.markMessageRead(m.id).then(refetch);
                      }
                    }}
                  >
                    <Avatar.Root class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-surface">
                      <Avatar.Fallback class="text-[10px] font-medium text-muted">
                        {initials(m.author.name)}
                      </Avatar.Fallback>
                      <Avatar.Image
                        src={m.author.avatar ?? undefined}
                        alt=""
                        class="h-full w-full rounded-full object-cover"
                      />
                    </Avatar.Root>
                    <div class="min-w-0 flex-1">
                      <div class="flex items-baseline gap-2">
                        <span class="text-[13px] font-medium">
                          {m.author.name}
                        </span>
                        <Show when={m.author.kind === "agent"}>
                          <span class="rounded border border-violet-500/40 px-1 py-0.5 text-[9px] text-violet-500 dark:text-violet-300">
                            agent
                          </span>
                        </Show>
                        <Show when={m.conversation_kind === "thread"}>
                          <span class="rounded border border-border px-1 py-0.5 text-[9px] text-muted">
                            thread
                          </span>
                        </Show>
                        <span class="text-[11px] text-muted">
                          {timeAgo(m.created_at)}
                        </span>
                        <Show when={!m.is_read}>
                          <span class="ml-auto h-1.5 w-1.5 rounded-full bg-accent" />
                        </Show>
                      </div>
                      <p class="mt-0.5 truncate text-[13px] text-muted">
                        {messagePreview(m.body)}
                      </p>
                    </div>
                  </A>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={nothingFound()}>
          <div class="flex flex-col items-center gap-2 py-14 text-center">
            <p class="text-[13px] text-muted">
              Nothing matches these filters.
            </p>
            <button
              type="button"
              onClick={clearFilters}
              class="text-[12px] font-medium text-accent hover:underline"
            >
              Clear filters
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}
