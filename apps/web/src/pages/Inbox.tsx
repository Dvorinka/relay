import { A } from "@solidjs/router";
import { createResource, For, onCleanup, Show } from "solid-js";
import { Avatar } from "@ark-ui/solid";
import { Spinner } from "../components/ui";
import { api } from "../lib/api";
import { subscribe } from "../lib/events";
import { initials, messagePreview } from "../lib/text";
import { timeAgo } from "../lib/time";

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
          <span class="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
            {reviews()!.length}
          </span>
        </h2>
        <ul class="divide-y divide-border overflow-hidden rounded-md border border-amber-500/30">
          <For each={reviews()}>
            {(r) => (
              <li>
                <A
                  href={`/app/p/${r.project_id}?tab=reviews`}
                  class="flex items-start gap-3 bg-amber-500/[0.04] px-4 py-3 transition-colors hover:bg-amber-500/[0.08]"
                >
                  <Avatar.Root class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-surface">
                    <Avatar.Fallback class="text-[10px] font-medium text-muted">
                      {initials(r.agent.name)}
                    </Avatar.Fallback>
                    <Avatar.Image
                      src={r.agent.avatar_url ?? undefined}
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

export default function Inbox() {
  const [mentions, { refetch }] = createResource(() =>
    api.mentions().then((r) => r.mentions),
  );
  const unsub = subscribe((e) => {
    if (e.type === "message.created") void refetch();
  });
  onCleanup(unsub);

  return (
    <div class="flex h-full flex-col">
      <header class="shrink-0 border-b border-border px-6 py-4">
        <h1 class="text-[15px] font-semibold tracking-tight">Inbox</h1>
        <p class="mt-0.5 text-[12px] text-muted">
          Reviews awaiting you, mentions and unread activity across your workspaces
        </p>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto px-6 py-4">
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
                    href={`/app/p/${m.project_id}`}
                    class={`flex items-start gap-3 px-4 py-3 transition-colors hover:bg-hover ${
                      m.is_read ? "opacity-60" : ""
                    }`}
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
