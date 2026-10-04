import { A, useParams } from "@solidjs/router";
import { createResource, For, Show } from "solid-js";
import { Avatar } from "@ark-ui/solid";
import { Spinner } from "../components/ui";
import { api } from "../lib/api";
import { mediaURL } from "../lib/net";
import { initials } from "../lib/text";
import { timeAgo } from "../lib/time";

// Agent details: identity card plus every project grant and the MCP token
// inventory. Reached by clicking an agent's name or avatar anywhere in chat,
// the rail, or the agents settings section.
export default function AgentProfile() {
  const params = useParams<{ agentId: string }>();
  const [detail] = createResource(
    () => params.agentId,
    (id) => api.getAgent(id),
  );

  return (
    <Show
      when={detail.latest}
      fallback={
        <div class="flex flex-1 items-center justify-center">
          <Show when={detail.error} fallback={<Spinner class="h-4 w-4" />}>
            <p class="text-[13px] text-muted">
              Could not load this agent — you may share no workspaces.
            </p>
          </Show>
        </div>
      }
    >
      {(d) => {
        const lastSeen = () => d().agent.last_seen_at;
        return (
        <div class="mx-auto w-full max-w-2xl px-6 py-8">
          <div class="flex items-center gap-4">
            <Avatar.Root class="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border border-border bg-surface text-[20px] font-semibold">
              <Avatar.Fallback>{initials(d().agent.name)}</Avatar.Fallback>
              <Avatar.Image
                src={mediaURL(d().agent.avatar_url)}
                alt=""
                class="h-full w-full rounded-2xl object-cover"
              />
            </Avatar.Root>
            <div class="min-w-0">
              <h1 class="flex items-center gap-2 truncate text-[20px] font-semibold tracking-tight">
                {d().agent.name}
                <span class="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-accent-ink">
                  agent
                </span>
              </h1>
              <p class="mt-0.5 font-mono text-[12px] text-muted">
                @{d().agent.slug}
              </p>
              <Show when={d().agent.description}>
                <p class="mt-1 text-[13px] text-muted">
                  {d().agent.description}
                </p>
              </Show>
              <p class="mt-1.5 text-[12.5px] text-muted">
                {lastSeen()
                  ? `last seen ${timeAgo(lastSeen()!)}`
                  : "never connected"}
                {" · "}
                review mode {d().agent.review_mode}
              </p>
            </div>
          </div>

          <section class="mt-8">
            <h2 class="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">
              Project access
            </h2>
            <ul class="divide-y divide-border overflow-hidden rounded-md border border-border">
              <Show when={d().agent.grant_all}>
                <li class="flex items-center gap-3 bg-accent-soft/40 px-4 py-2.5">
                  <span class="font-medium text-accent-ink">
                    Every project
                  </span>
                  <span class="text-[11.5px] text-muted">
                    current and future
                  </span>
                  <span class="flex-1" />
                  <For each={d().agent.grant_scopes ?? []}>
                    {(s) => (
                      <span class="rounded border border-border px-1 font-mono text-[10px] text-muted">
                        {s}
                      </span>
                    )}
                  </For>
                </li>
              </Show>
              <For
                each={d().agent.grants}
                fallback={
                  <Show when={!d().agent.grant_all}>
                    <li class="px-4 py-6 text-center text-[13px] text-muted">
                      No project access — this agent is idle
                    </li>
                  </Show>
                }
              >
                {(g) => (
                  <li class="flex items-center gap-3 px-4 py-2.5">
                    <A
                      href={`/app/p/${g.project_id}`}
                      class="shrink-0 font-mono text-[12px] font-medium text-accent hover:underline"
                    >
                      {g.project_key}
                    </A>
                    <span class="min-w-0 flex-1 truncate text-[13px] text-muted">
                      {g.project_name}
                    </span>
                    <For each={g.scopes}>
                      {(s) => (
                        <span class="rounded border border-border px-1 font-mono text-[10px] text-muted">
                          {s}
                        </span>
                      )}
                    </For>
                  </li>
                )}
              </For>
            </ul>
          </section>

          <section class="mt-6">
            <h2 class="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">
              MCP tokens
            </h2>
            <ul class="divide-y divide-border overflow-hidden rounded-md border border-border">
              <For
                each={d().tokens}
                fallback={
                  <li class="px-4 py-6 text-center text-[13px] text-muted">
                    No tokens issued
                  </li>
                }
              >
                {(t) => (
                  <li class="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                    <span class="font-medium">{t.name}</span>
                    <span class="flex-1" />
                    <span class="text-[11.5px] text-muted">
                      {t.last_used_at
                        ? `used ${timeAgo(t.last_used_at)}`
                        : "unused"}
                      {" · "}
                      {t.expires_at
                        ? `expires ${new Date(t.expires_at).toLocaleDateString()}`
                        : "never expires"}
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </div>
        );
      }}
    </Show>
  );
}
