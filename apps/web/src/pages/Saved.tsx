// Saved: the personal "for later" tray — saved messages plus pending
// reminders. Both lists deep-link back into the conversation via ?msg=.
import { A } from "@solidjs/router";
import { createResource, For, Show, type JSX } from "solid-js";
import type { Reminder } from "@relay/api-client";
import { api } from "../lib/api";
import { timeAgo, timeUntil } from "../lib/time";
import { savedItems, seedSaved } from "../stores/saved";
import { BookmarkIcon, ClockIcon, TrashIcon } from "../components/icons";

function fireLabel(r: Reminder): string {
  if (r.fired_at) return `fired ${timeAgo(r.fired_at)}`;
  return timeUntil(r.fire_at);
}

export default function Saved(): JSX.Element {
  seedSaved();
  const [reminders, { refetch }] = createResource(async () => {
    try {
      return (await api.listReminders()).reminders;
    } catch {
      return [] as Reminder[];
    }
  });

  const pending = () => (reminders() ?? []).filter((r) => !r.fired_at);
  const fired = () => (reminders() ?? []).filter((r) => r.fired_at);

  async function cancel(id: string) {
    try {
      await api.deleteReminder(id);
    } catch {
      /* gone already */
    }
    refetch();
  }

  return (
    <div class="mx-auto w-full max-w-3xl px-4 py-6">
      <h1 class="mb-4 text-[15px] font-semibold">Saved</h1>

      <Show when={pending().length + fired().length > 0}>
        <section class="mb-6">
          <h2 class="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">
            Reminders
          </h2>
          <ul class="divide-y divide-border overflow-hidden rounded-md border border-border">
            <For each={[...pending(), ...fired()]}>
              {(r) => (
                <li class="group relative flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-hover">
                  <ClockIcon class="mt-1 h-4 w-4 shrink-0 text-faint" />
                  <A
                    href={`/app/p/${r.project_id}?msg=${r.message_id}`}
                    class="min-w-0 flex-1"
                  >
                    <div class="flex items-baseline gap-2">
                      <span class="truncate text-[13px] font-medium">
                        {r.author_name}
                      </span>
                      <span
                        class={`text-[11px] ${r.fired_at ? "text-faint" : "text-accent"}`}
                      >
                        {fireLabel(r)}
                      </span>
                    </div>
                    <div class="truncate text-[12.5px] text-muted">
                      {r.snippet || "(attachment)"}
                    </div>
                  </A>
                  <button
                    type="button"
                    title="Cancel reminder"
                    aria-label="Cancel reminder"
                    onClick={() => void cancel(r.id)}
                    class="invisible rounded p-1 text-muted transition-colors hover:bg-surface hover:text-fg group-hover:visible"
                  >
                    <TrashIcon class="h-3.5 w-3.5" />
                  </button>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>

      <section>
        <h2 class="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">
          Messages
        </h2>
        <Show
          when={(savedItems() ?? []).length > 0}
          fallback={
            <p class="rounded-md border border-border px-4 py-6 text-center text-[13px] text-muted">
              Nothing saved yet — hover a message and choose{" "}
              <BookmarkIcon class="inline h-3.5 w-3.5 align-[-2px]" /> Save for
              later.
            </p>
          }
        >
          <ul class="divide-y divide-border overflow-hidden rounded-md border border-border">
            <For each={savedItems()}>
              {(m) => (
                <li class="group relative flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-hover">
                  <BookmarkIcon class="mt-1 h-4 w-4 shrink-0 text-faint" />
                  <A
                    href={`/app/p/${m.project_id}?msg=${m.id}`}
                    class="min-w-0 flex-1"
                  >
                    <div class="flex items-baseline gap-2">
                      <span class="truncate text-[13px] font-medium">
                        {m.author.name}
                      </span>
                      <span class="text-[11px] text-faint">
                        {m.project_name}
                      </span>
                      <span class="ml-auto text-[11px] text-faint">
                        {timeAgo(m.saved_at)}
                      </span>
                    </div>
                    <div class="truncate text-[12.5px] text-muted">
                      {m.body || "(attachment)"}
                    </div>
                  </A>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
    </div>
  );
}
