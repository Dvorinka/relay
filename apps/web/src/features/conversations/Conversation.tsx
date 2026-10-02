import { Avatar, Dialog } from "@ark-ui/solid";
import {
  ApiClientError,
  type Attachment,
  type Conversation as ApiConversation,
  type Message,
} from "@relay/api-client";
import { useNavigate } from "@solidjs/router";
import {
  createEffect,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";
import {
  FileIcon,
  IssueIcon,
  PaperclipIcon,
  XIcon,
} from "../../components/icons";
import {
  FormError,
  inputClass,
  primaryButtonClass,
  Spinner,
  SubmitButton,
} from "../../components/ui";
import { api } from "../../lib/api";
import { subscribe } from "../../lib/events";
import { Markdown } from "../../lib/markdown";
import { formatBytes, initials, messagePreview } from "../../lib/text";
import { timeAgo } from "../../lib/time";

const PAGE_SIZE = 50;
const MAX_FILE_MIB = 25;
const MAX_FILE_BYTES = MAX_FILE_MIB * 1024 * 1024;
// Matches the API's attachment_ids maxItems.
const MAX_ATTACHMENTS = 20;

type PendingAttachment = {
  localId: string;
  file: File;
  previewUrl: string | null;
  status: "uploading" | "ready" | "error";
  attachmentId?: string;
  error?: string;
};

function AttachmentView(props: { projectId: string; attachment: Attachment }) {
  const url = () => api.attachmentURL(props.projectId, props.attachment.id);
  return (
    <Show
      when={props.attachment.content_type.startsWith("image/")}
      fallback={
        <a
          href={url()}
          download={props.attachment.filename}
          class="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-[12px] transition-colors hover:bg-hover"
        >
          <FileIcon class="h-3.5 w-3.5 shrink-0 text-muted" />
          <span class="truncate">{props.attachment.filename}</span>
          <span class="shrink-0 text-muted">
            {formatBytes(props.attachment.size_bytes)}
          </span>
        </a>
      }
    >
      <a href={url()} target="_blank" rel="noreferrer">
        <img
          src={url()}
          alt={props.attachment.filename}
          loading="lazy"
          class="max-h-60 max-w-full rounded-md border border-border object-cover sm:max-w-xs"
        />
      </a>
    </Show>
  );
}

function PendingChip(props: {
  item: PendingAttachment;
  onRemove: () => void;
}) {
  const item = () => props.item;
  return (
    <li
      class={`flex items-center gap-2 rounded-md border bg-surface py-1 pl-1 pr-1 ${
        item().status === "error" ? "border-red-500/50" : "border-border"
      }`}
    >
      <Show
        when={item().previewUrl}
        fallback={
          <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border bg-bg">
            <FileIcon class="h-4 w-4 text-muted" />
          </span>
        }
      >
        {(url) => (
          <img
            src={url()}
            alt=""
            class="h-8 w-8 shrink-0 rounded border border-border object-cover"
          />
        )}
      </Show>
      <div class="min-w-0 max-w-44">
        <p class="truncate text-[12px]">{item().file.name}</p>
        <Show when={item().status === "uploading"}>
          <p class="flex items-center gap-1 text-[11px] text-muted">
            <Spinner class="h-2.5 w-2.5" />
            Uploading...
          </p>
        </Show>
        <Show when={item().status === "ready"}>
          <p class="text-[11px] text-muted">{formatBytes(item().file.size)}</p>
        </Show>
        <Show when={item().status === "error"}>
          <p class="text-[11px] text-red-600 dark:text-red-400">
            {item().error ?? "Upload failed"}
          </p>
        </Show>
      </div>
      <button
        type="button"
        onClick={props.onRemove}
        aria-label={`Remove ${item().file.name}`}
        class="shrink-0 rounded p-1 text-muted transition-colors hover:bg-hover hover:text-fg"
      >
        <XIcon class="h-3 w-3" />
      </button>
    </li>
  );
}

function ConvertToIssueDialog(props: {
  projectId: string;
  message: Message;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const [title, setTitle] = createSignal("");
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  createEffect(() => {
    if (props.open) {
      // Prefill from the message body, stripped of markdown.
      setTitle(messagePreview(props.message.body).slice(0, 60));
      setError(null);
    }
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (pending()) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      const t = title().trim();
      const issue = await api.createIssueFromMessage(
        props.message.id,
        t === "" ? undefined : t,
      );
      props.onOpenChange(false);
      navigate(`/app/p/${props.projectId}/i/${issue.id}`);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not create issue",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(d) => props.onOpenChange(d.open)}
    >
      <Portal>
        <Dialog.Backdrop class="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Positioner class="fixed inset-0 z-40 flex items-start justify-center p-4 pt-[15vh]">
          <Dialog.Content class="w-full max-w-md rounded-md border border-border bg-surface p-4 shadow-lg outline-none">
            <Dialog.Title class="text-[14px] font-semibold">
              Convert to issue
            </Dialog.Title>
            <Dialog.Description class="mt-1 text-[13px] text-muted">
              Creates an issue in this project and copies the message into its
              thread.
            </Dialog.Description>
            <form onSubmit={submit} class="mt-3 flex flex-col gap-3">
              <input
                ref={(el) => requestAnimationFrame(() => el.focus())}
                type="text"
                value={title()}
                onInput={(e) => setTitle(e.currentTarget.value)}
                placeholder="Issue title"
                aria-label="Issue title"
                maxlength={200}
                class={inputClass}
              />
              <FormError message={error()} />
              <div class="flex justify-end gap-2">
                <Dialog.CloseTrigger
                  type="button"
                  class="inline-flex h-8 items-center justify-center rounded-md px-3 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg"
                >
                  Cancel
                </Dialog.CloseTrigger>
                <SubmitButton pending={pending()}>
                  {pending() ? "Creating..." : "Create issue"}
                </SubmitButton>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

// Author palette: deterministic hue per name, Element-style. Token-safe in
// both themes because these stay readable on bg/surface.
const AUTHOR_COLORS = [
  "#2dd4bf", "#60a5fa", "#a78bfa", "#f472b6",
  "#fbbf24", "#34d399", "#fb7185", "#38bdf8",
] as const;

function authorColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AUTHOR_COLORS[h % AUTHOR_COLORS.length] ?? "#2dd4bf";
}

function shortTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function MessageRow(props: {
  projectId: string;
  message: Message;
  grouped: boolean;
}) {
  const m = () => props.message;
  const [convertOpen, setConvertOpen] = createSignal(false);
  return (
    <div
      class={`group relative flex gap-3 rounded-md px-4 hover:bg-hover ${
        props.grouped ? "py-0.5" : "mt-3 py-1"
      }`}
    >
      <Show
        when={!props.grouped}
        fallback={
          <div class="w-8 shrink-0 text-right">
            <span
              class="text-[10px] leading-[22px] text-muted opacity-0 transition-opacity group-hover:opacity-100"
              title={new Date(m().created_at).toLocaleString()}
            >
              {shortTime(m().created_at)}
            </span>
          </div>
        }
      >
        <Avatar.Root class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface">
          <Avatar.Fallback class="text-[11px] font-semibold text-muted">
            {initials(m().author.name)}
          </Avatar.Fallback>
          <Avatar.Image
            src={m().author.avatar_url ?? undefined}
            alt=""
            class="h-full w-full rounded-lg object-cover"
          />
        </Avatar.Root>
      </Show>
      <div class="min-w-0 flex-1">
        <Show when={!props.grouped}>
          <div class="flex items-baseline gap-2">
            <span
              class="text-[13.5px] font-semibold"
              style={{ color: authorColor(m().author.name) }}
            >
              {m().author.name}
            </span>
            <Show when={m().author.kind === "agent"}>
              <span class="rounded bg-accent/10 px-1 py-px font-mono text-[9.5px] font-semibold uppercase tracking-wide text-accent">
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
        </Show>
        <Show when={m().body.trim().length > 0}>
          <Markdown body={m().body} projectId={props.projectId} />
        </Show>
        <Show when={m().attachments.length > 0}>
          <div class="mt-1.5 flex flex-wrap items-center gap-2">
            <For each={m().attachments}>
              {(a) => (
                <AttachmentView projectId={props.projectId} attachment={a} />
              )}
            </For>
          </div>
        </Show>
      </div>
      <button
        type="button"
        onClick={() => setConvertOpen(true)}
        title="Convert to issue"
        aria-label="Convert message to issue"
        class="absolute right-3 top-1.5 rounded-md border border-border bg-surface p-1.5 text-muted opacity-0 shadow-sm transition-opacity hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
      >
        <IssueIcon class="h-3.5 w-3.5" />
      </button>
      <ConvertToIssueDialog
        projectId={props.projectId}
        message={m()}
        open={convertOpen()}
        onOpenChange={setConvertOpen}
      />
    </div>
  );
}

function ConversationThread(props: {
  conversationId: string;
  projectId: string;
}) {
  const [messages, setMessages] = createSignal<Message[]>([]);
  const [hasMore, setHasMore] = createSignal(false);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [sendError, setSendError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal<PendingAttachment[]>([]);
  const [dragging, setDragging] = createSignal(false);
  let scrollEl: HTMLDivElement | undefined;
  let inputEl: HTMLTextAreaElement | undefined;
  let fileEl: HTMLInputElement | undefined;

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

  const unsub = subscribe((e) => {
    if (e.type !== "message.created") return;
    if (e.data?.conversation_id !== props.conversationId) return;
    const m = e.data.message as Message;
    setMessages((cur) => (cur.some((x) => x.id === m.id) ? cur : [...cur, m]));
    markLatestRead();
  });
  onCleanup(unsub);

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

  onCleanup(() => {
    for (const p of pending()) {
      if (p.previewUrl) {
        URL.revokeObjectURL(p.previewUrl);
      }
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

  // --- attachments ---

  const hasUploading = () =>
    pending().some((p) => p.status === "uploading");

  function updatePending(localId: string, patch: Partial<PendingAttachment>) {
    setPending((cur) =>
      cur.map((p) => (p.localId === localId ? { ...p, ...patch } : p)),
    );
  }

  function removePending(localId: string) {
    const item = pending().find((p) => p.localId === localId);
    if (item?.previewUrl) {
      URL.revokeObjectURL(item.previewUrl);
    }
    setPending((cur) => cur.filter((p) => p.localId !== localId));
  }

  async function upload(localId: string, file: File) {
    try {
      const attachment = await api.uploadAttachment(props.projectId, file);
      updatePending(localId, { status: "ready", attachmentId: attachment.id });
    } catch (err) {
      updatePending(localId, {
        status: "error",
        error:
          err instanceof ApiClientError && err.status === 413
            ? `Files can be at most ${MAX_FILE_MIB} MiB`
            : err instanceof Error
              ? err.message
              : "Upload failed",
      });
    }
  }

  // crypto.randomUUID requires a secure context; LAN dev origins are not.
  const newLocalId = () =>
    crypto.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  function addFiles(files: readonly File[]) {
    for (const file of files) {
      const localId = newLocalId();
      let entry: PendingAttachment;
      if (file.size > MAX_FILE_BYTES) {
        entry = {
          localId,
          file,
          previewUrl: null,
          status: "error",
          error: `Files can be at most ${MAX_FILE_MIB} MiB`,
        };
      } else if (
        pending().filter((p) => p.status !== "error").length >=
        MAX_ATTACHMENTS
      ) {
        entry = {
          localId,
          file,
          previewUrl: null,
          status: "error",
          error: `A message can have at most ${MAX_ATTACHMENTS} attachments`,
        };
      } else {
        entry = {
          localId,
          file,
          previewUrl: file.type.startsWith("image/")
            ? URL.createObjectURL(file)
            : null,
          status: "uploading",
        };
      }
      setPending((cur) => [...cur, entry]);
      if (entry.status === "uploading") {
        void upload(localId, file);
      }
    }
  }

  const readyIds = () =>
    pending().flatMap((p) =>
      p.attachmentId === undefined ? [] : [p.attachmentId],
    );

  const canSend = () =>
    !sending() &&
    !hasUploading() &&
    (draft().trim().length > 0 || readyIds().length > 0);

  async function send() {
    const body = draft().trim();
    if (!canSend()) {
      return;
    }
    const ids = readyIds();
    setSendError(null);
    setSending(true);
    try {
      const message = await api.postMessage(props.conversationId, body, ids);
      // The SSE message.created frame can land before this POST resolves;
      // skip the local append when it already arrived.
      setMessages((cur) =>
        cur.some((x) => x.id === message.id) ? cur : [...cur, message],
      );
      setDraft("");
      // Drop the attachments that were sent; failed uploads stay listed.
      const sentIds = new Set(ids);
      const keep: PendingAttachment[] = [];
      for (const p of pending()) {
        if (p.attachmentId !== undefined && sentIds.has(p.attachmentId)) {
          if (p.previewUrl) {
            URL.revokeObjectURL(p.previewUrl);
          }
        } else {
          keep.push(p);
        }
      }
      setPending(keep);
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

        <div class="flex flex-col px-2 py-2">
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
            {(m, i) => {
              // Group under the same avatar when the author repeats within
              // 5 minutes on the same day; insert a day separator otherwise.
              const prev = () => (i() > 0 ? messages()[i() - 1] : undefined);
              const grouped = () => {
                const p = prev();
                if (!p) return false;
                const a = new Date(p.created_at).getTime();
                const b = new Date(m.created_at).getTime();
                return (
                  p.author.id === m.author.id &&
                  p.author.kind === m.author.kind &&
                  b - a < 5 * 60 * 1000 &&
                  dayLabel(p.created_at) === dayLabel(m.created_at)
                );
              };
              const newDay = () => {
                const p = prev();
                return !p || dayLabel(p.created_at) !== dayLabel(m.created_at);
              };
              return (
                <>
                  <Show when={newDay()}>
                    <div class="mx-2 my-3 flex items-center gap-3">
                      <span class="h-px flex-1 bg-border" />
                      <span class="text-[11px] font-semibold tracking-wide text-muted">
                        {dayLabel(m.created_at)}
                      </span>
                      <span class="h-px flex-1 bg-border" />
                    </div>
                  </Show>
                  <MessageRow
                    projectId={props.projectId}
                    message={m}
                    grouped={grouped()}
                  />
                </>
              );
            }}
          </For>
        </div>
      </div>

      <div
        class="shrink-0 px-4 pb-4 pt-1"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (
            !(e.relatedTarget instanceof Node) ||
            !e.currentTarget.contains(e.relatedTarget)
          ) {
            setDragging(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(Array.from(e.dataTransfer?.files ?? []));
        }}
      >
        <FormError message={sendError()} />
        <div
          class={`rounded-xl border bg-surface transition-colors ${
            dragging()
              ? "border-accent ring-1 ring-accent/40"
              : "border-border focus-within:border-accent/60"
          }`}
        >
          <Show when={pending().length > 0}>
            <ul class="flex flex-wrap gap-2 px-2 pt-2">
              <For each={pending()}>
                {(p) => (
                  <PendingChip
                    item={p}
                    onRemove={() => removePending(p.localId)}
                  />
                )}
              </For>
            </ul>
          </Show>
          <div class="flex items-end gap-1 p-1.5">
            <button
              type="button"
              onClick={() => fileEl?.click()}
              aria-label="Attach files"
              title="Attach files"
              class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg"
            >
              <PaperclipIcon class="h-4.5 w-4.5" />
            </button>
            <textarea
              ref={(el) => {
                inputEl = el;
              }}
              rows={1}
              value={draft()}
              placeholder="Message — paste an image with Ctrl+V"
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
              onPaste={(e) => {
                const files = e.clipboardData?.files;
                if (files && files.length > 0) {
                  e.preventDefault();
                  addFiles(Array.from(files));
                }
              }}
              class="max-h-40 flex-1 resize-none bg-transparent px-1.5 py-2 text-[13.5px] leading-6 outline-none placeholder:text-muted/60 disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={!canSend()}
              class={`${primaryButtonClass} !h-9 rounded-lg`}
            >
              Send
            </button>
          </div>
          <div class="flex items-center gap-3 border-t border-border/60 px-3 py-1.5 text-[10.5px] text-muted/70">
            <span>Enter to send</span>
            <span>Shift+Enter newline</span>
            <span>Ctrl+V pastes an image</span>
            <Show when={hasUploading()}>
              <span class="ml-auto flex items-center gap-1.5 text-accent">
                <Spinner class="h-2.5 w-2.5" /> uploading…
              </span>
            </Show>
          </div>
        </div>
        <input
          ref={(el) => {
            fileEl = el;
          }}
          type="file"
          multiple
          class="hidden"
          onChange={(e) => {
            const files = Array.from(e.currentTarget.files ?? []);
            e.currentTarget.value = "";
            addFiles(files);
          }}
        />
      </div>
    </div>
  );
}

/**
 * Message list + composer for a conversation. Pass `conversation` when the
 * caller already resolved it (e.g. an issue thread); otherwise the project's
 * own conversation is fetched for `projectId`.
 */
export function Conversation(props: {
  projectId: string;
  conversation?: ApiConversation;
}) {
  const [resolved] = createResource(
    () => props.conversation?.id ?? props.projectId,
    () =>
      props.conversation
        ? Promise.resolve(props.conversation)
        : api.projectConversation(props.projectId),
  );
  return (
    <Show
      when={resolved()}
      keyed
      fallback={
        <div class="flex min-h-0 flex-1 items-center justify-center">
          <Show when={resolved.state === "errored"} fallback={<Spinner />}>
            <p class="text-[13px] text-muted">Could not load conversation</p>
          </Show>
        </div>
      }
    >
      {(c) => (
        <ConversationThread
          conversationId={c.id}
          projectId={props.projectId}
        />
      )}
    </Show>
  );
}
