import { Avatar } from "@ark-ui/solid";
import type { Message } from "@relay/api-client";
import {
  createEffect,
  createResource,
  createSignal,
  For,
  Show,
} from "solid-js";
import { FormError, Spinner } from "../../components/ui";
import { api } from "../../lib/api";
import { Markdown } from "../../lib/markdown";
import { initials } from "../../lib/text";
import { timeAgo } from "../../lib/time";

const PAGE_SIZE = 50;

function MessageRow(props: { message: Message }) {
  const m = () => props.message;
  return (
    <div class="flex gap-3 px-4 py-2">
      <Avatar.Root class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-surface">
        <Avatar.Fallback class="text-[11px] font-medium text-muted">
          {initials(m().author.name)}
        </Avatar.Fallback>
        <Avatar.Image
          src={m().author.avatar_url ?? undefined}
          alt=""
          class="h-full w-full rounded-full object-cover"
        />
      </Avatar.Root>
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline gap-2">
          <span class="text-[13px] font-medium">{m().author.name}</span>
          <Show when={m().author.kind === "agent"}>
            <span class="rounded border border-border px-1 font-mono text-[10px] leading-4 text-muted">
              agent
            </span>
          </Show>
          <span
            class="text-[11px] text-muted"
            title={new Date(m().created_at).toLocaleString()}
          >
            {timeAgo(m().created_at)}
          </span>
        </div>
        <Markdown body={m().body} />
      </div>
    </div>
  );
}

export function Conversation(props: { conversationId: string }) {
  const [messages, setMessages] = createSignal<Message[]>([]);
  const [hasMore, setHasMore] = createSignal(false);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [sendError, setSendError] = createSignal<string | null>(null);
  let scrollEl: HTMLDivElement | undefined;
  let inputEl: HTMLTextAreaElement | undefined;

  const [firstPage] = createResource(
    () => props.conversationId,
    (id) => api.listMessages(id, { limit: PAGE_SIZE }),
  );

  function markLatestRead() {
    const last = messages().at(-1);
    if (last) {
      void api.markMessageRead(last.id).catch(() => {});
    }
  }

  let seeded = false;
  createEffect(() => {
    const page = firstPage();
    if (page && !seeded) {
      seeded = true;
      setMessages(page.messages);
      setHasMore(page.has_more);
      markLatestRead();
    }
  });

  // Scroll to the bottom only when the latest message changes: initial load
  // and sends scroll, "Load earlier" prepends do not.
  let lastSeenId: string | undefined;
  createEffect(() => {
    const lastId = messages().at(-1)?.id;
    if (lastId && lastId !== lastSeenId) {
      lastSeenId = lastId;
      scrollEl?.scrollTo({ top: scrollEl.scrollHeight });
    }
  });

  async function loadEarlier() {
    const first = messages()[0];
    if (!first || loadingMore()) {
      return;
    }
    setLoadingMore(true);
    try {
      const page = await api.listMessages(props.conversationId, {
        limit: PAGE_SIZE,
        before: first.id,
      });
      const heightBefore = scrollEl?.scrollHeight ?? 0;
      setMessages((cur) => [...page.messages, ...cur]);
      setHasMore(page.has_more);
      if (scrollEl) {
        // Solid applies DOM updates synchronously; keep the viewport anchored.
        scrollEl.scrollTop += scrollEl.scrollHeight - heightBefore;
      }
    } finally {
      setLoadingMore(false);
    }
  }

  function autogrow() {
    if (inputEl) {
      inputEl.style.height = "auto";
      inputEl.style.height = `${Math.min(inputEl.scrollHeight, 160)}px`;
    }
  }

  async function send() {
    const body = draft().trim();
    if (!body || sending()) {
      return;
    }
    setSendError(null);
    setSending(true);
    try {
      const message = await api.postMessage(props.conversationId, body);
      setMessages((cur) => [...cur, message]);
      setDraft("");
      if (inputEl) {
        inputEl.style.height = "auto";
        inputEl.focus();
      }
      markLatestRead();
    } catch (err) {
      setSendError(
        err instanceof Error ? err.message : "Could not send message",
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div
        ref={(el) => {
          scrollEl = el;
        }}
        class="min-h-0 flex-1 overflow-y-auto"
      >
        <Show when={hasMore()}>
          <div class="flex justify-center py-2">
            <button
              type="button"
              disabled={loadingMore()}
              onClick={() => void loadEarlier()}
              class="rounded-md px-2.5 py-1 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
            >
              {loadingMore() ? "Loading..." : "Load earlier"}
            </button>
          </div>
        </Show>

        <Show when={firstPage.state === "pending"}>
          <div class="flex justify-center py-8">
            <Spinner />
          </div>
        </Show>
        <Show when={firstPage.state === "errored"}>
          <p class="py-8 text-center text-[13px] text-muted">
            Could not load messages
          </p>
        </Show>

        <div class="flex flex-col py-2">
          <For
            each={messages()}
            fallback={
              <Show when={firstPage.state === "ready"}>
                <p class="py-8 text-center text-[13px] text-muted">
                  No messages yet
                </p>
              </Show>
            }
          >
            {(m) => <MessageRow message={m} />}
          </For>
        </div>
      </div>

      <div class="shrink-0 border-t border-border px-4 py-3">
        <FormError message={sendError()} />
        <textarea
          ref={(el) => {
            inputEl = el;
          }}
          rows={1}
          value={draft()}
          placeholder="Write a message..."
          aria-label="Message"
          disabled={sending()}
          onInput={(e) => {
            setDraft(e.currentTarget.value);
            autogrow();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          class="w-full resize-none rounded-md border border-border bg-bg px-3 py-2 text-[13px] outline-none transition-colors placeholder:text-muted/60 focus:border-accent disabled:opacity-50"
        />
        <p class="mt-1 text-[11px] text-muted/60">
          Enter to send · Shift+Enter for a new line
        </p>
      </div>
    </div>
  );
}
