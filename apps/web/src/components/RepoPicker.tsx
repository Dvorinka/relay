import type { AvailableRepo } from "@relay/api-client";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { timeAgo } from "../lib/time";
import { inputClass } from "./ui";

// RepoPicker: searchable dropdown for choosing a GitHub repository —
// replaces the plain <select>, which doesn't scale past a handful of repos
// and can't show descriptions or activity. Sorted most-recent-push first.
export function RepoPicker(props: {
  repos: AvailableRepo[];
  value: string; // "" or a repo's full_name
  onPick: (repo: AvailableRepo | null) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = createSignal(false);
  const [q, setQ] = createSignal("");
  let rootEl: HTMLDivElement | undefined;

  const selected = () => props.repos.find((r) => r.full_name === props.value);
  const filtered = () => {
    const needle = q().trim().toLowerCase();
    const list = [...props.repos].sort((a, b) =>
      (b.pushed_at ?? "").localeCompare(a.pushed_at ?? ""),
    );
    if (!needle) return list;
    return list.filter(
      (r) =>
        r.full_name.toLowerCase().includes(needle) ||
        (r.description ?? "").toLowerCase().includes(needle),
    );
  };

  const onDocClick = (e: MouseEvent) => {
    if (rootEl && !rootEl.contains(e.target as Node)) setOpen(false);
  };
  const onDocKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") setOpen(false);
  };
  const watch = (on: boolean) => {
    if (on) {
      document.addEventListener("mousedown", onDocClick);
      document.addEventListener("keydown", onDocKey);
    } else {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onDocKey);
    }
  };
  onCleanup(() => watch(false));

  return (
    <div
      ref={(el) => {
        rootEl = el;
      }}
      class="relative"
    >
      <button
        type="button"
        disabled={props.disabled}
        onClick={() => {
          const next = !open();
          setOpen(next);
          setQ("");
          watch(next);
        }}
        aria-haspopup="listbox"
        aria-expanded={open()}
        class={`${inputClass} flex items-center gap-2 text-left disabled:opacity-60`}
      >
        <Show
          when={selected()}
          fallback={
            <span class="flex-1 truncate text-muted/70">
              {props.placeholder ?? "Pick a repository…"}
            </span>
          }
        >
          {(r) => (
            <>
              <RepoAvatar repo={r()} class="h-4 w-4" />
              <span class="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                {r().full_name}
              </span>
              <Show when={r().private}>
                <span class="rounded border border-border px-1 text-[10px] text-muted">
                  private
                </span>
              </Show>
            </>
          )}
        </Show>
        <svg
          viewBox="0 0 16 16"
          class="h-3 w-3 shrink-0 text-muted"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      <Show when={open()}>
        <div class="absolute z-30 mt-1 w-full min-w-72 overflow-hidden rounded-lg border border-border bg-surface shadow-lg">
          <div class="border-b border-border p-1.5">
            <input
              ref={(el) => el.focus()}
              type="text"
              value={q()}
              onInput={(e) => setQ(e.currentTarget.value)}
              placeholder="Search repositories…"
              aria-label="Search repositories"
              class={`${inputClass} !py-1 text-[12.5px]`}
            />
          </div>
          <div class="max-h-64 overflow-y-auto py-1" role="listbox">
            <Show
              when={filtered().length > 0}
              fallback={
                <p class="px-3 py-2 text-[12px] text-muted">
                  No repositories match.
                </p>
              }
            >
              <For each={filtered()}>
                {(r) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={r.full_name === props.value}
                    onClick={() => {
                      props.onPick(r);
                      setOpen(false);
                      watch(false);
                    }}
                    class="flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors hover:bg-hover"
                  >
                    <RepoAvatar repo={r} class="mt-0.5 h-4 w-4" />
                    <span class="min-w-0 flex-1">
                      <span class="flex items-center gap-1.5">
                        <span class="truncate font-mono text-[12.5px] text-fg">
                          {r.full_name}
                        </span>
                        <Show when={r.private}>
                          <span class="shrink-0 rounded border border-border px-1 text-[10px] text-muted">
                            private
                          </span>
                        </Show>
                      </span>
                      <Show when={r.description}>
                        <span class="block truncate text-[11.5px] text-muted">
                          {r.description}
                        </span>
                      </Show>
                    </span>
                    <Show when={r.pushed_at}>
                      {(t) => (
                        <span class="shrink-0 pt-0.5 text-[10.5px] text-faint">
                          {timeAgo(t())}
                        </span>
                      )}
                    </Show>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

function RepoAvatar(props: { repo: AvailableRepo; class?: string }) {
  return (
    <Show
      when={props.repo.owner_avatar}
      fallback={
        <span
          class={`${props.class ?? "h-4 w-4"} flex shrink-0 items-center justify-center rounded bg-hover text-[9px] font-semibold uppercase text-muted`}
        >
          {props.repo.owner.slice(0, 2)}
        </span>
      }
    >
      {(url) => (
        <img
          src={url()}
          alt=""
          class={`${props.class ?? "h-4 w-4"} shrink-0 rounded`}
          loading="lazy"
        />
      )}
    </Show>
  );
}
