import { useNavigate } from "@solidjs/router";
import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";
import { api } from "../lib/api";
import { messagePreview } from "../lib/text";
import { STATUS_LABEL } from "../features/issues/meta";
import type { IssueStatus } from "@relay/api-client";

interface Results {
  projects: { id: string; key: string; name: string }[];
  issues: {
    id: string;
    key: string;
    title: string;
    status: string;
    project_id: string;
  }[];
  messages: {
    id: string;
    body: string;
    project_id: string;
    author: string;
  }[];
  todos: { id: string; content: string; done: boolean; project_id: string }[];
}

type Entry = { label: string; sub?: string; href: string; group: string };

const [open, setOpen] = createSignal(false);
export function openPalette() {
  setOpen(true);
}

export function CommandPalette() {
  const navigate = useNavigate();
  const [q, setQ] = createSignal("");
  const [results, setResults] = createSignal<Results | null>(null);
  const [sel, setSel] = createSignal(0);
  let input: HTMLInputElement | undefined;

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  let debounce: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const query = q().trim();
    clearTimeout(debounce);
    if (query.length < 2) {
      setResults(null);
      return;
    }
    debounce = setTimeout(async () => {
      try {
        setResults(await api.search(query));
      } catch {
        setResults(null);
      }
      setSel(0);
    }, 180);
  });

  const entries = (): Entry[] => {
    const r = results();
    if (!r) return [];
    return [
      ...r.projects.map((p) => ({
        label: p.name,
        sub: p.key,
        href: `/app/p/${p.id}`,
        group: "Projects",
      })),
      ...r.issues.map((i) => ({
        label: i.title,
        sub: `${i.key} · ${STATUS_LABEL[i.status as IssueStatus] ?? i.status}`,
        href: `/app/p/${i.project_id}/i/${i.id}`,
        group: "Issues",
      })),
      ...r.todos.map((t) => ({
        label: t.content,
        sub: t.done ? "done" : "open",
        href: `/app/p/${t.project_id}`,
        group: "Work list",
      })),
      ...r.messages.map((m) => ({
        label: messagePreview(m.body),
        sub: m.author,
        href: `/app/p/${m.project_id}`,
        group: "Messages",
      })),
    ];
  };

  const go = (href: string) => {
    setOpen(false);
    setQ("");
    navigate(href);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const list = entries();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((i) => Math.min(i + 1, list.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      const entry = list[sel()];
      if (entry) go(entry.href);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  let lastGroup = "";
  return (
    <Show when={open()}>
      <Portal>
        <div
          class="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh]"
          onClick={() => setOpen(false)}
        >
          <div
            class="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-bg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Command palette"
          >
            <input
              ref={(el) => {
                input = el;
                setTimeout(() => input?.focus());
              }}
              value={q()}
              onInput={(e) => setQ(e.currentTarget.value)}
              onKeyDown={onKeyDown}
              placeholder="Search projects, issues, messages, work items…"
              class="h-12 w-full border-b border-border bg-transparent px-4 text-[14px] outline-none placeholder:text-muted/60"
            />
            <div class="max-h-80 overflow-y-auto p-1.5">
              <Show
                when={entries().length > 0}
                fallback={
                  <p class="px-3 py-6 text-center text-[13px] text-muted">
                    {q().trim().length < 2
                      ? "Type to search"
                      : results()
                        ? "No results"
                        : "Searching…"}
                  </p>
                }
              >
                <For each={entries()}>
                  {(entry, idx) => {
                    const showGroup = entry.group !== lastGroup;
                    lastGroup = entry.group;
                    return (
                      <>
                        <Show when={showGroup}>
                          <div class="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted/70">
                            {entry.group}
                          </div>
                        </Show>
                        <button
                          type="button"
                          class={`flex w-full items-baseline gap-2 rounded-md px-2.5 py-1.5 text-left ${
                            idx() === sel() ? "bg-hover" : ""
                          }`}
                          onMouseEnter={() => setSel(idx())}
                          onClick={() => go(entry.href)}
                        >
                          <span class="min-w-0 flex-1 truncate text-[13px]">
                            {entry.label}
                          </span>
                          <Show when={entry.sub}>
                            <span class="shrink-0 font-mono text-[10.5px] text-muted">
                              {entry.sub}
                            </span>
                          </Show>
                        </button>
                      </>
                    );
                  }}
                </For>
              </Show>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}
