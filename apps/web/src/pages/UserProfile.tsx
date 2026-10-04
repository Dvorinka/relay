import { A, useParams } from "@solidjs/router";
import { createResource, For, Show } from "solid-js";
import { Avatar } from "@ark-ui/solid";
import { Spinner } from "../components/ui";
import { api } from "../lib/api";
import { mediaURL } from "../lib/net";
import { initials, messagePreview } from "../lib/text";
import { timeAgo } from "../lib/time";
import { nameColorFor } from "../lib/namecolors";

// User details: profile card plus everything the caller may see of this
// person inside shared workspaces — assigned issues, mentions of them, and
// their recent messages. Reached by clicking any author name in chat.
export default function UserProfile() {
  const params = useParams<{ userId: string }>();
  const [profile] = createResource(
    () => params.userId,
    (id) => api.userProfile(id),
  );

  return (
    <div class="flex h-full flex-col">
      <Show
        when={profile.latest}
        fallback={
          <div class="flex flex-1 items-center justify-center">
            <Show
              when={profile.error}
              fallback={<Spinner class="h-4 w-4" />}
            >
              <p class="text-[13px] text-muted">
                Could not load this user — you may share no workspaces.
              </p>
            </Show>
          </div>
        }
      >
        {(p) => (
          <div class="min-h-0 flex-1 overflow-y-auto">
            <div class="mx-auto w-full max-w-2xl px-6 py-8">
              <div class="flex items-center gap-4">
                <Avatar.Root class="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-[20px] font-semibold">
                  <Avatar.Fallback>
                    {initials(p().user.name)}
                  </Avatar.Fallback>
                  <Avatar.Image
                    src={mediaURL(
                      p().user.avatar_key
                        ? `/api/files/${p().user.avatar_key}`
                        : null,
                    )}
                    alt=""
                    class="h-full w-full rounded-full object-cover"
                  />
                </Avatar.Root>
                <div class="min-w-0">
                  <h1
                    class="truncate text-[20px] font-semibold tracking-tight"
                    style={{
                      color: p().user.name_color || nameColorFor(p().user.name),
                    }}
                  >
                    {p().user.name}
                  </h1>
                  <p class="mt-0.5 text-[12.5px] text-muted">
                    Member since {timeAgo(p().user.created_at)} ·{" "}
                    {p().stats.messages} messages · {p().stats.issues} issues
                    touched
                  </p>
                  <div class="mt-2 flex flex-wrap gap-1.5">
                    <For each={p().workspaces}>
                      {(w) => (
                        <span class="rounded-full border border-border bg-surface px-2.5 py-0.5 text-[11.5px] text-muted">
                          {w.name}
                          <Show when={w.role !== "member"}>
                            <span class="ml-1 text-accent">{w.role}</span>
                          </Show>
                        </span>
                      )}
                    </For>
                  </div>
                </div>
              </div>

              <section class="mt-8">
                <h2 class="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">
                  Assigned issues
                </h2>
                <ul class="divide-y divide-border overflow-hidden rounded-md border border-border">
                  <For
                    each={p().issues}
                    fallback={
                      <li class="px-4 py-6 text-center text-[13px] text-muted">
                        No assigned issues in shared workspaces
                      </li>
                    }
                  >
                    {(i) => (
                      <li>
                        <A
                          href={`/app/p/${i.project_id}/i/${i.id}`}
                          class="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-hover"
                        >
                          <span class="shrink-0 font-mono text-[11.5px] text-accent">
                            {i.key}
                          </span>
                          <span class="min-w-0 flex-1 truncate text-[13px]">
                            {i.title}
                          </span>
                          <span class="shrink-0 rounded border border-border px-1.5 py-px text-[10.5px] text-muted">
                            {i.status}
                          </span>
                          <span class="shrink-0 text-[11px] text-faint">
                            {timeAgo(i.updated_at)}
                          </span>
                        </A>
                      </li>
                    )}
                  </For>
                </ul>
              </section>

              <section class="mt-6">
                <h2 class="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">
                  Mentions of {p().user.name}
                </h2>
                <ul class="divide-y divide-border overflow-hidden rounded-md border border-border">
                  <For
                    each={p().mentions}
                    fallback={
                      <li class="px-4 py-6 text-center text-[13px] text-muted">
                        Nobody has @'d them lately
                      </li>
                    }
                  >
                    {(m) => (
                      <li>
                        <A
                          href={`/app/p/${m.project_id}`}
                          class="block px-4 py-2.5 transition-colors hover:bg-hover"
                        >
                          <div class="flex items-baseline gap-2">
                            <span class="text-[12.5px] font-medium">
                              {m.author.name}
                            </span>
                            <Show when={m.author.kind === "agent"}>
                              <span class="rounded border border-violet-500/40 px-1 py-px text-[9px] text-violet-500 dark:text-violet-300">
                                agent
                              </span>
                            </Show>
                            <span class="ml-auto text-[11px] text-faint">
                              {timeAgo(m.created_at)}
                            </span>
                          </div>
                          <p class="mt-0.5 truncate text-[13px] text-muted">
                            {messagePreview(m.body)}
                          </p>
                        </A>
                      </li>
                    )}
                  </For>
                </ul>
              </section>

              <section class="mt-6">
                <h2 class="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">
                  Recent messages
                </h2>
                <ul class="divide-y divide-border overflow-hidden rounded-md border border-border">
                  <For
                    each={p().recent_messages}
                    fallback={
                      <li class="px-4 py-6 text-center text-[13px] text-muted">
                        No messages yet
                      </li>
                    }
                  >
                    {(m) => (
                      <li>
                        <A
                          href={`/app/p/${m.project_id}`}
                          class="block px-4 py-2.5 transition-colors hover:bg-hover"
                        >
                          <p class="truncate text-[13px]">
                            {messagePreview(m.body)}
                          </p>
                          <p class="mt-0.5 text-[11.5px] text-muted">
                            {m.project} · {timeAgo(m.created_at)}
                          </p>
                        </A>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
