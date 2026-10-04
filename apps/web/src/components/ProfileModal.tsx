import { Avatar } from "@ark-ui/solid";
import { A } from "@solidjs/router";
import {
  createEffect,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { api } from "../lib/api";
import { mediaURL } from "../lib/net";
import { initials } from "../lib/text";
import { timeAgo } from "../lib/time";
import { nameColorFor } from "../lib/namecolors";
import { Spinner } from "./ui";
import { XIcon } from "./icons";

// Discord-style profile card — opens instead of navigating to the profile
// page when a mention chip or a member row is clicked. The full profile page
// stays reachable through the "Open profile" link.

type Target = { id: string; kind: string } | null;

const [target, setTarget] = createSignal<Target>(null);

export function openProfile(id: string, kind: string) {
  setTarget({ id, kind });
}

export function ProfileModalHost() {
  const onOpen = (e: Event) => {
    const d = (e as CustomEvent).detail as { id?: string; kind?: string };
    if (d?.id && d.kind) setTarget({ id: d.id, kind: d.kind });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") setTarget(null);
  };
  window.addEventListener("relay:open-profile", onOpen);
  window.addEventListener("keydown", onKey);
  onCleanup(() => {
    window.removeEventListener("relay:open-profile", onOpen);
    window.removeEventListener("keydown", onKey);
  });
  return (
    <Show when={target()} keyed>
      {(t) => <ProfileModal id={t.id} kind={t.kind} onClose={() => setTarget(null)} />}
    </Show>
  );
}

function ProfileModal(props: { id: string; kind: string; onClose: () => void }) {
  const [user] = createResource(
    () => (props.kind === "agent" ? null : props.id),
    (id) => api.userProfile(id),
  );
  const [agent] = createResource(
    () => (props.kind === "agent" ? props.id : null),
    (id) => api.getAgent(id),
  );
  const loading = () =>
    props.kind === "agent" ? !agent.latest : !user.latest;
  const href = () =>
    props.kind === "agent" ? `/app/ag/${props.id}` : `/app/u/${props.id}`;

  // Accent strip: user's chosen name color, agent tint, or the name palette.
  const banner = () => {
    if (props.kind === "agent") return "#8b5cf6";
    const u = user.latest?.user;
    return u?.name_color || nameColorFor(u?.name ?? "x") || "#06b6d4";
  };

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        class="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
        onClick={props.onClose}
      />
      <div
        role="dialog"
        aria-label="Profile"
        class="relative w-[min(400px,94vw)] overflow-hidden rounded-xl border border-border bg-bg shadow-2xl"
      >
        {/* Banner */}
        <div class="h-16 w-full" style={{ background: banner() }} />
        <button
          type="button"
          onClick={props.onClose}
          aria-label="Close profile"
          class="absolute right-2.5 top-2.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/40 text-white/90 transition-colors hover:bg-black/60"
        >
          <XIcon class="h-4 w-4" />
        </button>

        <div class="px-4 pb-4">
          <Avatar.Root class="-mt-8 flex h-16 w-16 items-center justify-center rounded-full border-4 border-bg bg-surface text-[20px] font-semibold">
            <Avatar.Fallback>
              {initials(
                props.kind === "agent"
                  ? (agent.latest?.agent.name ?? "?")
                  : (user.latest?.user.name ?? "?"),
              )}
            </Avatar.Fallback>
            <Avatar.Image
              src={mediaURL(
                props.kind === "agent"
                  ? (agent.latest?.agent.avatar_url ?? null)
                  : user.latest?.user.avatar_key
                    ? `/api/files/${user.latest!.user.avatar_key}`
                    : null,
              )}
              alt=""
              class="h-full w-full rounded-full object-cover"
            />
          </Avatar.Root>

          <Show
            when={!loading()}
            fallback={
              <div class="flex justify-center py-6">
                <Spinner class="h-4 w-4" />
              </div>
            }
          >
            <Show
              when={props.kind === "agent" ? agent.latest : user.latest}
              fallback={
                <p class="py-4 text-center text-[12.5px] text-muted">
                  Could not load this profile.
                </p>
              }
            >
              <Show
                when={props.kind !== "agent"}
                fallback={
                  <>
                    <div class="mt-2 flex items-center gap-2">
                      <h2 class="truncate text-[17px] font-semibold">
                        {agent.latest!.agent.name}
                      </h2>
                      <span class="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent">
                        Agent
                      </span>
                    </div>
                    <p class="mt-0.5 font-mono text-[11.5px] text-muted">
                      @{agent.latest!.agent.slug}
                    </p>
                    <Show when={agent.latest!.agent.description}>
                      <p class="mt-2.5 text-[12.5px] leading-relaxed text-muted">
                        {agent.latest!.agent.description}
                      </p>
                    </Show>
                    <div class="mt-3 rounded-lg border border-border bg-surface px-3 py-2 text-[12px] text-muted">
                      Reviews:{" "}
                      <span class="font-medium text-fg">
                        {agent.latest!.agent.review_mode === "gate"
                          ? "gated — waits for your verdict"
                          : "notify — informational"}
                      </span>
                    </div>
                  </>
                }
              >
                <div class="mt-2 flex items-center gap-2">
                  <h2
                    class="truncate text-[17px] font-semibold"
                    style={{
                      color:
                        user.latest!.user.name_color ||
                        nameColorFor(user.latest!.user.name),
                    }}
                  >
                    {user.latest!.user.name}
                  </h2>
                </div>
                <p class="mt-0.5 text-[12px] text-muted">
                  Member since {timeAgo(user.latest!.user.created_at)} ·{" "}
                  {user.latest!.stats.messages} messages ·{" "}
                  {user.latest!.stats.issues} issues
                </p>
                <Show when={(user.latest!.workspaces ?? []).length > 0}>
                  <div class="mt-3 flex flex-wrap gap-1.5">
                    <For each={user.latest!.workspaces}>
                      {(w) => (
                        <span class="rounded-full border border-border bg-surface px-2.5 py-0.5 text-[11.5px] text-muted">
                          {w.name}
                          <Show when={w.role !== "member"}>
                            <span class="ml-1 font-medium text-accent">
                              {w.role}
                            </span>
                          </Show>
                        </span>
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
            </Show>
          </Show>

          <A
            href={href()}
            onClick={props.onClose}
            class="mt-4 block rounded-md border border-border bg-surface px-3 py-2 text-center text-[12.5px] font-medium text-fg transition-colors hover:bg-hover"
          >
            Open full profile
          </A>
        </div>
      </div>
    </div>
  );
}

// Re-export the event helper for surfaces that can't use markdown chips
// (member rows, author names) — same modal, direct call.
export { openProfile as openProfileCard };
