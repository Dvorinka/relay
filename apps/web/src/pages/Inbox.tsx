import { A } from "@solidjs/router";
import { createResource, For, onCleanup, Show } from "solid-js";
import { Avatar } from "@ark-ui/solid";
import { Spinner } from "../components/ui";
import { api } from "../lib/api";
import { mediaURL } from "../lib/net";
import { subscribe } from "../lib/events";
import { initials, messagePreview } from "../lib/text";
import { timeAgo } from "../lib/time";
import { useProjects } from "../stores/projects";
import { refreshUnread, useUnread } from "../stores/unread";

function PendingReviews() {
  const [reviews, { refetch }] = createResource(() =>
    api.myReviews().then((r) => r.reviews),
  );
  const unsub = subscribe((e) => {
    if (e.type === "review.created" || e.type === "review.responded") {
      void refetch();
    }
  });
  onCleanup(unsub);

  return (
    <Show when={(reviews() ?? []).length > 0}>
      <section class="mb-6">
        <h2 class="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-muted">
          Awaiting your verdict
          <span class="rounded-full bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-400">
            {reviews()!.length}
          </span>
        </h2>
        <ul class="divide-y divide-border overflow-hidden rounded-md border border-violet-500/30">
          <For each={reviews()}>
            {(r) => (
              <li>
                <A
                  href={`/app/p/${r.project_id}?tab=reviews`}
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

// Channels with unread messages — each row jumps to the project, where the
// "New" divider lands on the oldest unread message.
function UnreadChannels() {
  const { unread } = useUnread();
  const projects = useProjects();
  const rows = () =>
    Object.entries(unread())
      .map(([projectId, count]) => ({
        count,
        project: projects.projects()?.find((p) => p.id === projectId),
      }))
      .filter((r) => r.count > 0 && r.project);

  return (
    <Show when={rows().length > 0}>
      <section class="mb-6">
        <h2 class="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-muted">
          Unread
          <span class="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
            {rows().reduce((s, r) => s + r.count, 0)}
          </span>
        </h2>
        <ul class="divide-y divide-border overflow-hidden rounded-md border border-border">
          <For each={rows()}>
            {(r) => (
              <li>
                <A
                  href={`/app/p/${r.project!.id}`}
                  class="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-hover"
                >
                  <span
                    class="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{
                      "background-color": r.project!.color ?? "var(--accent)",
                    }}
                  />
                  <span class="truncate text-[13px] font-medium">
                    {r.project!.name}
                  </span>
                  <span class="font-mono text-[11px] text-muted">
                    {r.project!.key}
                  </span>
                  <span class="ml-auto rounded-full bg-accent px-1.5 py-px font-mono text-[10px] font-semibold leading-4 text-white">
                    {r.count > 99 ? "99+" : r.count}
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

export default function Inbox() {
  const [mentions, { refetch }] = createResource(() =>
    api.mentions().then((r) => r.mentions),
  );
  const { unread } = useUnread();
  const totalUnread = () =>
    Object.values(unread()).reduce((s, n) => s + n, 0);
  const unsub = subscribe((e) => {
    if (e.type === "message.created") {
      void refetch();
      void refreshUnread();
    }
  });
  onCleanup(unsub);

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
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <UnreadChannels />
        <PendingReviews />
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
          <ul class="divide-y divide-border overflow-hidden rounded-md border border-border">
            <For
              each={mentions()}
              fallback={
                <li class="px-4 py-8 text-center text-[13px] text-muted">
                  No mentions yet — someone will say your name eventually
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
      </div>
    </div>
  );
}
