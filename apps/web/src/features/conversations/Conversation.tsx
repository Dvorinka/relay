import { Avatar, Dialog } from "@ark-ui/solid";
import {
  ApiClientError,
  type Attachment,
  type Conversation as ApiConversation,
  type Message,
  type Reaction,
  type Thread,
  type ThreadSummary,
} from "@relay/api-client";
import { useNavigate, useSearchParams } from "@solidjs/router";
import {
  createEffect,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";
import {
  CheckIcon,
  FileIcon,
  ForwardIcon,
  IssueIcon,
  LinkIcon,
  LockIcon,
  PaperclipIcon,
  PencilIcon,
  PinIcon,
  ReplyIcon,
  ThreadIcon,
  TrashIcon,
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
import { loadNameColors, nameColorFor } from "../../lib/namecolors";
import { mediaURL, net } from "../../lib/net";
import { Markdown, renderMarkdown } from "../../lib/markdown";
import { formatBytes, initials, messagePreview } from "../../lib/text";
import { useProjects } from "../../stores/projects";
import { useSession } from "../../stores/session";
import { useChatStyle, useClock } from "../../stores/theme";

const PAGE_SIZE = 50;
const MAX_FILE_MIB = 25;
const MAX_FILE_BYTES = MAX_FILE_MIB * 1024 * 1024;
// Matches the API's attachment_ids maxItems.
const MAX_ATTACHMENTS = 20;
// Quick-react set on the hover toolbar.
const QUICK_REACTIONS = ["👀", "✅", "❤️", "🎉"];

// Shift+hover expands the toolbar with the heavy actions (pin / copy link /
// forward), Discord-style. Listeners attach once, lazily.
const [shiftHeld, setShiftHeld] = createSignal(false);
let shiftTracked = false;
const { clockFormat } = useClock();
function trackShift() {
  if (shiftTracked) return;
  shiftTracked = true;
  window.addEventListener("keydown", (e) => {
    if (e.key === "Shift") setShiftHeld(true);
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Shift") setShiftHeld(false);
  });
  window.addEventListener("blur", () => setShiftHeld(false));
}

type PendingAttachment = {
  localId: string;
  file: File;
  previewUrl: string | null;
  status: "uploading" | "ready" | "error";
  attachmentId?: string;
  error?: string;
};

// Author palette: deterministic hue per name, Element-style. Token-safe in
// both themes because these stay readable on bg/surface.
const AUTHOR_COLORS = [
  "#0d9488", "#3b82f6", "#8b5cf6", "#db2777",
  "#ca8a04", "#16a34a", "#f43f5e", "#0ea5e9",
] as const;

function authorColor(name: string): string {
  const custom = nameColorFor(name);
  if (custom) return custom;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AUTHOR_COLORS[h % AUTHOR_COLORS.length] ?? "#0d9488";
}

function shortTime(iso: string): string {
  const f = clockFormat();
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: f === "system" ? undefined : f === "12",
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

// Discord-style group header stamp: "Today at 09:03", "Yesterday at 09:03".
function stamp(iso: string): string {
  return `${dayLabel(iso)} at ${shortTime(iso)}`;
}

function MessageAvatar(props: { message: Message; small?: boolean }) {
  const m = () => props.message;
  return (
    <Avatar.Root
      class={`mt-0.5 flex shrink-0 items-center justify-center rounded-full border border-border ${
        props.small ? "h-7 w-7" : "h-10 w-10"
      }`}
    >
      <Avatar.Fallback
        class={props.small ? "text-[10px] font-semibold" : "text-[13px] font-semibold"}
        style={{
          color: authorColor(m().author.name),
          "background-color": `color-mix(in srgb, ${authorColor(m().author.name)} 14%, transparent)`,
        }}
      >
        {initials(m().author.name)}
      </Avatar.Fallback>
      <Avatar.Image
        src={mediaURL(m().author.avatar_url)}
        alt=""
        class="h-full w-full rounded-full object-cover"
      />
    </Avatar.Root>
  );
}

// The reply strip above a replied message: curved arrow + parent author +
// one-line snippet. Deleted parents render a muted placeholder.
function ReplyStrip(props: { parent: NonNullable<Message["parent"]> }) {
  return (
    <div class="mb-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-muted">
      <ReplyIcon class="h-3.5 w-3.5 shrink-0 text-faint" />
      <Show
        when={!props.parent.deleted}
        fallback={<span class="italic">Original message was deleted</span>}
      >
        <span
          class="shrink-0 font-semibold"
          style={{ color: authorColor(props.parent.author) }}
        >
          {props.parent.author}
        </span>
        <span class="truncate text-muted/80">{props.parent.preview}</span>
      </Show>
    </div>
  );
}

function ReactionRow(props: {
  messageId: string;
  reactions: Reaction[];
  onChange: (reactions: Reaction[]) => void;
}) {
  async function toggle(emoji: string) {
    try {
      const res = await api.toggleReaction(props.messageId, emoji);
      props.onChange(res.reactions);
    } catch {
      // transient - the SSE reaction.updated frame keeps the truth
    }
  }
  return (
    <Show when={props.reactions.length > 0}>
      <div class="mt-1 flex flex-wrap gap-1">
        <For each={props.reactions}>
          {(r) => (
            <button
              type="button"
              title={r.names.join(", ")}
              onClick={() => void toggle(r.emoji)}
              class={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[12px] transition-colors ${
                r.mine
                  ? "border-accent/60 bg-accent-soft text-accent-ink"
                  : "border-border bg-surface text-muted hover:border-border-hi hover:text-fg"
              }`}
            >
              <span>{r.emoji}</span>
              <span class="font-medium">{r.count}</span>
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}

function AttachmentView(props: { projectId: string; attachment: Attachment }) {
  const url = () =>
    mediaURL(api.attachmentURL(props.projectId, props.attachment.id));
  return (
    <Show
      when={props.attachment.content_type.startsWith("image/")}
      fallback={
        <a
          href={url()}
          download={props.attachment.filename}
          class="inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-[13px] transition-colors hover:bg-hover"
        >
          <FileIcon class="h-4 w-4 shrink-0 text-muted" />
          <span class="truncate">{props.attachment.filename}</span>
          <span class="shrink-0 text-muted">
            {formatBytes(props.attachment.size_bytes)}
          </span>
        </a>
      }
    >
      <ImageLightbox url={url()} filename={props.attachment.filename} />
    </Show>
  );
}

// Click-to-zoom for image attachments: inline thumb opens a lightbox modal
// instead of navigating away. Esc/backdrop close; "Open original" is the
// escape hatch for a full-tab view.
function ImageLightbox(props: { url: string | undefined; filename: string }) {
  const [open, setOpen] = createSignal(false);
  createEffect(() => {
    if (!open()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });
  return (
    <>
      <button
        type="button"
        disabled={!props.url}
        onClick={() => setOpen(true)}
        aria-label={`View ${props.filename}`}
        class="block w-fit cursor-zoom-in"
      >
        <img
          src={props.url ?? ""}
          alt={props.filename}
          loading="lazy"
          class="max-h-[30rem] max-w-full rounded-xl border border-border object-contain sm:max-w-[560px]"
        />
      </button>
      <Show when={open() && props.url}>
        <Portal>
          <div
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
            role="dialog"
            aria-label={props.filename}
            onClick={(e) => {
              if (e.target === e.currentTarget) setOpen(false);
            }}
          >
            <div class="flex max-h-full max-w-full flex-col items-center gap-2">
              <img
                src={props.url}
                alt={props.filename}
                class="max-h-[85vh] max-w-full rounded-lg object-contain"
              />
              <div class="flex items-center gap-3 text-[12px]">
                <span class="max-w-[60vw] truncate text-white/70">
                  {props.filename}
                </span>
                <a
                  href={props.url}
                  target="_blank"
                  rel="noreferrer"
                  class="rounded-md bg-white/10 px-2 py-1 text-white/90 hover:bg-white/20"
                >
                  Open original
                </a>
              </div>
            </div>
          </div>
        </Portal>
      </Show>
    </>
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
      setError(err instanceof Error ? err.message : "Could not create issue");
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
          <Dialog.Content class="w-full max-w-md rounded-xl border border-border bg-surface p-4 shadow-lg outline-none">
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

function DeleteMessageDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (pending()) return;
    setPending(true);
    setError(null);
    try {
      await props.onConfirm();
      props.onOpenChange(false);
    } catch (err) {
      setError(
        err instanceof ApiClientError && err.status === 409
          ? "An agent has read this message - it can no longer be deleted."
          : err instanceof Error
            ? err.message
            : "Could not delete",
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
          <Dialog.Content class="w-full max-w-md rounded-xl border border-border bg-surface p-4 shadow-lg outline-none">
            <Dialog.Title class="text-[14px] font-semibold">
              Delete message
            </Dialog.Title>
            <Dialog.Description class="mt-1 text-[13px] text-muted">
              This message will be permanently removed for everyone. Replies
              to it keep a "deleted" placeholder.
            </Dialog.Description>
            <form onSubmit={submit} class="mt-3">
              <FormError message={error()} />
              <div class="mt-3 flex justify-end gap-2">
                <Dialog.CloseTrigger
                  type="button"
                  class="inline-flex h-8 items-center justify-center rounded-md px-3 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg"
                >
                  Cancel
                </Dialog.CloseTrigger>
                <button
                  type="submit"
                  disabled={pending()}
                  class="inline-flex h-8 items-center justify-center rounded-md bg-red-600 px-3 text-[13px] font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-60"
                >
                  {pending() ? "Deleting..." : "Delete"}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function CreateThreadDialog(props: {
  message: Message;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (t: Thread) => void;
}) {
  const [title, setTitle] = createSignal("");
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  createEffect(() => {
    if (props.open) {
      setTitle("");
      setError(null);
    }
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (pending()) return;
    setPending(true);
    setError(null);
    try {
      const { thread } = await api.createThread(
        props.message.id,
        title().trim() || undefined,
      );
      props.onOpenChange(false);
      props.onCreated(thread);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create thread");
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
          <Dialog.Content class="w-full max-w-md rounded-xl border border-border bg-surface p-4 shadow-lg outline-none">
            <Dialog.Title class="text-[14px] font-semibold">
              Create thread
            </Dialog.Title>
            <Dialog.Description class="mt-1 text-[13px] text-muted">
              A dedicated conversation under this message, so side topics don't
              drown the channel.
            </Dialog.Description>
            <form onSubmit={submit} class="mt-3 flex flex-col gap-3">
              <input
                ref={(el) => requestAnimationFrame(() => el.focus())}
                type="text"
                value={title()}
                onInput={(e) => setTitle(e.currentTarget.value)}
                placeholder="Thread title (optional)"
                aria-label="Thread title"
                maxlength={120}
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
                  {pending() ? "Creating..." : "Create thread"}
                </SubmitButton>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

// Forward a message into another project's conversation. The copy credits
// the original author server-side; the dialog lists every other project the
// caller belongs to.
function ForwardDialog(props: {
  message: Message;
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const projects = useProjects();
  const [busyId, setBusyId] = createSignal<string | null>(null);
  const [sentTo, setSentTo] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  createEffect(() => {
    if (props.open) {
      setSentTo(null);
      setError(null);
    }
  });

  const targets = () =>
    (projects.projects() ?? []).filter((p) => p.id !== props.projectId);

  async function forward(projectId: string) {
    if (busyId()) return;
    setBusyId(projectId);
    setError(null);
    try {
      await api.forwardMessage(props.message.id, projectId);
      setSentTo(projectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not forward");
    } finally {
      setBusyId(null);
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
          <Dialog.Content class="w-full max-w-md rounded-xl border border-border bg-surface p-4 shadow-lg outline-none">
            <Dialog.Title class="text-[14px] font-semibold">
              Forward message
            </Dialog.Title>
            <Dialog.Description class="mt-1 text-[13px] text-muted">
              Share a copy into another project's chat, credited to the
              original author.
            </Dialog.Description>
            <div class="mt-3 max-h-64 overflow-y-auto rounded-lg border border-border">
              <For
                each={targets()}
                fallback={
                  <p class="px-3 py-4 text-center text-[13px] text-muted">
                    No other projects to forward to
                  </p>
                }
              >
                {(p) => (
                  <button
                    type="button"
                    disabled={busyId() !== null}
                    onClick={() => void forward(p.id)}
                    class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13.5px] transition-colors hover:bg-hover disabled:opacity-60"
                  >
                    <Show
                      when={p.icon_url}
                      fallback={
                        <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md font-mono text-[10px] text-muted">
                          {p.key.slice(0, 2)}
                        </span>
                      }
                    >
                      {(url) => (
                        <img
                          src={mediaURL(url())}
                          alt=""
                          class="h-6 w-6 shrink-0 rounded-md object-cover"
                        />
                      )}
                    </Show>
                    <span class="min-w-0 flex-1 truncate">{p.name}</span>
                    <Show when={sentTo() === p.id}>
                      <span class="flex shrink-0 items-center gap-1 text-[12px] text-accent-ink">
                        <CheckIcon class="h-3.5 w-3.5" /> Sent
                      </span>
                    </Show>
                  </button>
                )}
              </For>
            </div>
            <FormError message={error()} />
            <div class="mt-3 flex justify-end">
              <Dialog.CloseTrigger
                type="button"
                class="inline-flex h-8 items-center justify-center rounded-md px-3 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg"
              >
                Done
              </Dialog.CloseTrigger>
            </div>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function MessageRow(props: {
  projectId: string;
  message: Message;
  grouped: boolean;
  meId: string | undefined;
  highlighted: boolean;
  onReply: (m: Message) => void;
  onChanged: (m: Message) => void;
  onDeleted: (id: string) => void;
  onOpenThread?: (t: ThreadSummary) => void;
}) {
  const m = () => props.message;
  const { chatStyle } = useChatStyle();
  const bubbles = () => chatStyle() === "bubbles";
  const [convertOpen, setConvertOpen] = createSignal(false);
  const [deleteOpen, setDeleteOpen] = createSignal(false);
  const [threadOpen, setThreadOpen] = createSignal(false);
  const [forwardOpen, setForwardOpen] = createSignal(false);
  const [editing, setEditing] = createSignal(false);
  const [editDraft, setEditDraft] = createSignal("");
  const [editError, setEditError] = createSignal<string | null>(null);
  const [savingEdit, setSavingEdit] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  let editEl: HTMLTextAreaElement | undefined;
  trackShift();

  const mine = () =>
    props.meId !== undefined &&
    m().author.kind === "user" &&
    m().author.id === props.meId;
  const canEdit = () => mine() && !m().agent_read;
  const canDelete = canEdit; // same lock: agent-read makes messages immutable

  async function doDelete() {
    await api.deleteMessage(m().id);
    props.onDeleted(m().id);
  }

  async function togglePin() {
    try {
      const updated = await api.pinMessage(m().id, !m().pinned_at);
      props.onChanged(updated);
    } catch {
      // SSE message.updated reconciles
    }
  }

  async function copyLink() {
    const base = net.serverUrl() || location.origin;
    const url = `${base}${location.pathname}?msg=${m().id}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // clipboard API unavailable (insecure context) - prompt is the fallback
      window.prompt("Copy link", url);
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function react(emoji: string) {
    try {
      const res = await api.toggleReaction(m().id, emoji);
      props.onChanged({ ...m(), reactions: res.reactions });
    } catch {
      // SSE reaction.updated reconciles
    }
  }

  function startEdit() {
    setEditDraft(m().body);
    setEditError(null);
    setEditing(true);
    requestAnimationFrame(() => {
      editEl?.focus();
      editEl?.setSelectionRange(editEl.value.length, editEl.value.length);
    });
  }

  async function saveEdit() {
    const body = editDraft().trim();
    if (!body || body === m().body.trim()) {
      setEditing(false);
      return;
    }
    setSavingEdit(true);
    setEditError(null);
    try {
      const updated = await api.editMessage(m().id, body);
      props.onChanged(updated);
      setEditing(false);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 409) {
        setEditError("An agent has read this message - it can no longer be edited.");
      } else {
        setEditError(err instanceof Error ? err.message : "Could not edit");
      }
    } finally {
      setSavingEdit(false);
    }
  }

  // Touch devices have no hover: tapping the row toggles the toolbar.
  const [tapped, setTapped] = createSignal(false);

  // Esc cancels edit even when focus has left the textarea (Discord parity).
  createEffect(() => {
    if (!editing()) return;
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        !document.querySelector('[role="dialog"]')
      ) {
        setEditing(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  const toolBtn =
    "flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg";

  return (
    <div
      id={`msg-${m().id}`}
      class={
        (bubbles()
          ? `group relative flex px-4 ${
              mine() ? "justify-end" : "justify-start"
            } ${props.grouped ? "py-[1px]" : "mt-2 py-[1px]"}`
          : `group relative flex gap-3 px-4 hover:bg-hover/60 ${
              props.grouped ? "py-[2px]" : "mt-3 py-1"
            }`) +
        (props.highlighted ? " rounded-xl bg-accent-soft/60 transition-colors" : " transition-colors")
      }
      onClick={(e) => {
        if (window.matchMedia("(hover: none)").matches &&
            !(e.target as HTMLElement).closest("a,button,textarea,input,pre")) {
          setTapped((v) => !v);
        }
      }}
    >
      <Show when={!bubbles()}>
        <Show
          when={!props.grouped}
          fallback={
            <div class="w-10 shrink-0 text-right">
              <span
                class="text-[10px] leading-[22px] text-faint opacity-0 transition-opacity group-hover:opacity-100"
                title={new Date(m().created_at).toLocaleString()}
              >
                {shortTime(m().created_at)}
              </span>
            </div>
          }
        >
          <MessageAvatar message={m()} />
        </Show>
      </Show>
      <Show when={bubbles() && !mine()}>
        {/* fixed slot keeps the left bubble edge aligned across a group */}
        <div class="mr-1.5 flex w-7 shrink-0 items-end">
          <Show when={!props.grouped}>
            <MessageAvatar message={m()} small />
          </Show>
        </div>
      </Show>
      <div
        class={
          bubbles()
            ? `min-w-0 max-w-[78%] rounded-2xl px-3 py-1.5 ${
                mine()
                  ? "rounded-br-md bg-accent-soft"
                  : "rounded-bl-md border border-border bg-surface"
              }`
            : "min-w-0 flex-1"
        }
      >
        <Show when={!props.grouped && (!bubbles() || !mine())}>
          <div class="flex items-baseline gap-2">
            <span
              class="text-[14.5px] font-semibold"
              style={{ color: authorColor(m().author.name) }}
            >
              {m().author.name}
            </span>
            <Show when={m().author.kind === "agent"}>
              <span class="rounded bg-accent-soft px-1 py-px font-mono text-[9.5px] font-semibold uppercase tracking-wide text-accent-ink">
                agent
              </span>
            </Show>
            <Show when={!bubbles()}>
              <span
                class="text-[11.5px] text-faint"
                title={new Date(m().created_at).toLocaleString()}
              >
                {stamp(m().created_at)}
              </span>
            </Show>
          </div>
        </Show>
        <Show when={m().pinned_at}>
          <div class="mb-0.5 flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wide text-faint">
            <PinIcon class="h-3 w-3" />
            Pinned
          </div>
        </Show>
        <Show when={m().forwarded} keyed>
          {(f) => (
            <div class="mb-0.5 flex items-center gap-1.5 text-[12px] italic text-muted">
              <ForwardIcon class="h-3 w-3 shrink-0 text-faint" />
              <span class="truncate">
                Forwarded from <span class="font-medium not-italic">{f.author}</span>
              </span>
            </div>
          )}
        </Show>
        <Show when={m().parent}>{(p) => <ReplyStrip parent={p()} />}</Show>
        <Show
          when={editing()}
          fallback={
            <>
              <Show when={m().body.trim().length > 0}>
                <Markdown body={m().body} projectId={props.projectId} />
              </Show>
              <Show when={m().edited_at && !bubbles()}>
                <span class="ml-0 align-middle text-[10.5px] text-faint">
                  (edited)
                </span>
              </Show>
            </>
          }
        >
          <div class="mt-1 rounded-xl border border-accent/50 bg-surface p-1.5">
            <textarea
              ref={(el) => {
                editEl = el;
              }}
              value={editDraft()}
              rows={2}
              aria-label="Edit message"
              disabled={savingEdit()}
              onInput={(e) => setEditDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void saveEdit();
                }
                if (e.key === "Escape") {
                  setEditing(false);
                }
              }}
              class="max-h-60 w-full resize-none bg-transparent px-2 py-1.5 text-[14px] leading-6 outline-none"
            />
            <div class="flex items-center justify-between px-1.5 pb-0.5 pt-1 text-[10.5px] text-faint">
              <span>Esc to cancel · Enter to save</span>
              <Show when={editError()}>
                <span class="text-red-500">{editError()}</span>
              </Show>
            </div>
          </div>
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
        <ReactionRow
          messageId={m().id}
          reactions={m().reactions}
          onChange={(reactions) => props.onChanged({ ...m(), reactions })}
        />
        <Show when={m().thread} keyed>
          {(t) => (
            <button
              type="button"
              onClick={() => props.onOpenThread?.(t)}
              class="mt-1 flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] font-medium text-accent-ink transition-colors hover:bg-hover"
            >
              <ThreadIcon class="h-3.5 w-3.5" />
              <span class="truncate">
                {t.title || "Thread"}
              </span>
              <span class="text-faint">
                · {t.reply_count} {t.reply_count === 1 ? "reply" : "replies"}
              </span>
            </button>
          )}
        </Show>
        <Show when={bubbles()}>
          <div class="mt-0.5 flex items-center justify-end gap-1.5 text-[10px] leading-3 text-faint">
            <Show when={m().edited_at}>
              <span>(edited)</span>
            </Show>
            <span title={new Date(m().created_at).toLocaleString()}>
              {shortTime(m().created_at)}
            </span>
          </div>
        </Show>
      </div>
      <div
        class={`msg-actions absolute -top-3 hidden items-center gap-0.5 rounded-lg border border-border bg-surface px-1 py-0.5 shadow-sm group-hover:flex ${
          bubbles() && !mine() ? "left-[46px]" : "right-3"
        }`}
        style={{ display: tapped() ? "flex" : undefined }}
      >
        <For each={QUICK_REACTIONS}>
          {(emoji) => (
            <button
              type="button"
              title={`React ${emoji}`}
              aria-label={`React with ${emoji}`}
              onClick={() => void react(emoji)}
              class={`${toolBtn} text-[14px]`}
            >
              {emoji}
            </button>
          )}
        </For>
        <button
          type="button"
          title="Reply"
          aria-label="Reply"
          onClick={() => props.onReply(m())}
          class={toolBtn}
        >
          <ReplyIcon class="h-4 w-4" />
        </button>
        <Show when={shiftHeld() || tapped()}>
          <button
            type="button"
            title={m().pinned_at ? "Unpin message" : "Pin message"}
            aria-label={m().pinned_at ? "Unpin message" : "Pin message"}
            onClick={() => void togglePin()}
            class={toolBtn}
          >
            <PinIcon class="h-4 w-4" />
          </button>
          <button
            type="button"
            title={copied() ? "Copied" : "Copy link"}
            aria-label="Copy link to message"
            onClick={() => void copyLink()}
            class={toolBtn}
          >
            <Show when={!copied()} fallback={<CheckIcon class="h-4 w-4 text-accent-ink" />}>
              <LinkIcon class="h-4 w-4" />
            </Show>
          </button>
          <button
            type="button"
            title="Forward"
            aria-label="Forward message"
            onClick={() => setForwardOpen(true)}
            class={toolBtn}
          >
            <ForwardIcon class="h-4 w-4" />
          </button>
        </Show>
        <Show when={props.onOpenThread && !m().thread}>
          <button
            type="button"
            title="Create thread"
            aria-label="Create thread"
            onClick={() => setThreadOpen(true)}
            class={toolBtn}
          >
            <ThreadIcon class="h-4 w-4" />
          </button>
        </Show>
        <Show
          when={canEdit()}
          fallback={
            <Show when={mine()}>
              <span
                class={`${toolBtn} cursor-not-allowed opacity-60`}
                title="Seen by an agent - editing and deletion locked"
                aria-label="Editing and deletion locked"
              >
                <LockIcon class="h-4 w-4" />
              </span>
            </Show>
          }
        >
          <button
            type="button"
            title="Edit"
            aria-label="Edit message"
            onClick={startEdit}
            class={toolBtn}
          >
            <PencilIcon class="h-4 w-4" />
          </button>
        </Show>
        <button
          type="button"
          onClick={() => setConvertOpen(true)}
          title="Convert to issue"
          aria-label="Convert message to issue"
          class={toolBtn}
        >
          <IssueIcon class="h-4 w-4" />
        </button>
        <Show when={canDelete()}>
          <button
            type="button"
            onClick={() => setDeleteOpen(true)}
            title="Delete message"
            aria-label="Delete message"
            class={`${toolBtn} hover:!text-red-500`}
          >
            <TrashIcon class="h-4 w-4" />
          </button>
        </Show>
      </div>
      <ConvertToIssueDialog
        projectId={props.projectId}
        message={m()}
        open={convertOpen()}
        onOpenChange={setConvertOpen}
      />
      <DeleteMessageDialog
        open={deleteOpen()}
        onOpenChange={setDeleteOpen}
        onConfirm={doDelete}
      />
      <CreateThreadDialog
        message={m()}
        open={threadOpen()}
        onOpenChange={setThreadOpen}
        onCreated={(t) => props.onOpenThread?.(t)}
      />
      <ForwardDialog
        message={m()}
        projectId={props.projectId}
        open={forwardOpen()}
        onOpenChange={setForwardOpen}
      />
    </div>
  );
}

function PendingChip(props: {
  item: PendingAttachment;
  onRemove: () => void;
}) {
  const item = () => props.item;
  const meta = () => {
    const ext = item().file.name.split(".").pop()?.toUpperCase() ?? "FILE";
    if (item().status === "error") {
      return item().error ?? "Upload failed";
    }
    const size = formatBytes(item().file.size);
    return item().status === "uploading"
      ? "uploading…"
      : `pasted from clipboard · ${size} · ${ext} · will upload on send`;
  };
  return (
    <li
      class={`flex items-center gap-3 rounded-xl border bg-surface py-1.5 pl-1.5 pr-2 ${
        item().status === "error" ? "border-red-500/50" : "border-border"
      }`}
    >
      <Show
        when={item().previewUrl}
        fallback={
          <span class="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2">
            <FileIcon class="h-5 w-5 text-muted" />
          </span>
        }
      >
        {(url) => (
          <img
            src={url()}
            alt=""
            class="h-[52px] w-[52px] shrink-0 rounded-lg border border-border object-cover"
          />
        )}
      </Show>
      <div class="min-w-0">
        <p class="truncate text-[13px] font-medium leading-tight">
          {item().file.name}
        </p>
        <p
          class={`mt-0.5 flex items-center gap-1.5 text-[11.5px] leading-tight ${
            item().status === "error" ? "text-red-500" : "text-muted"
          }`}
        >
          <Show when={item().status === "uploading"}>
            <Spinner class="h-2.5 w-2.5" />
          </Show>
          {meta()}
        </p>
      </div>
      <button
        type="button"
        onClick={props.onRemove}
        aria-label={`Remove ${item().file.name}`}
        class="ml-1 shrink-0 rounded-md p-1.5 text-muted transition-colors hover:bg-hover hover:text-red-500"
      >
        <XIcon class="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

function ConversationThread(props: {
  conversationId: string;
  projectId: string;
  onOpenThread?: (t: ThreadSummary) => void;
}) {
  const session = useSession();
  const [searchParams] = useSearchParams();
  const [messages, setMessages] = createSignal<Message[]>([]);
  const [highlightId, setHighlightId] = createSignal<string | null>(null);
  const [pinsOpen, setPinsOpen] = createSignal(false);
  const [hasMore, setHasMore] = createSignal(false);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [sendError, setSendError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal<PendingAttachment[]>([]);
  const [dragging, setDragging] = createSignal(false);
  const [replyTo, setReplyTo] = createSignal<Message | null>(null);

  // Custom name colors come from the workspace member list, loaded once.
  createResource(() => props.projectId, async (id) => {
    try {
      const p = await api.getProject(id);
      await loadNameColors(p.workspace_id);
    } catch {
      /* palette defaults are fine */
    }
  });

  // Mentions: @ opens the unified menu (people, agents, issues, PRs, files),
  // # jumps straight to issues. @file:/@gh: keep their prefixes for paths.
  const [repos] = createResource(
    () => props.projectId,
    async (id) => (await api.listProjectRepos(id)).repos,
  );
  const [mentionables] = createResource(
    () => props.projectId,
    async (id) => {
      try {
        return await api.mentionables(id);
      } catch {
        return { users: [], agents: [], issues: [], repos: [] };
      }
    },
  );
  const [localPaths, setLocalPaths] = createSignal<string[] | null>(null);
  const [ghPaths, setGhPaths] = createSignal<string[] | null>(null);
  const [mention, setMention] = createSignal<{
    kind: "all" | "issue" | "file" | "gh";
    part: string;
    start: number;
  } | null>(null);
  const [mentionIdx, setMentionIdx] = createSignal(0);
  const [preview, setPreview] = createSignal<{
    src: string;
    repo?: string;
    path: string;
  } | null>(null);
  let scrollEl: HTMLDivElement | undefined;
  let inputEl: HTMLTextAreaElement | undefined;
  let fileEl: HTMLInputElement | undefined;

  const [firstPage] = createResource(
    () => props.conversationId,
    (id) => api.listMessages(id, { limit: PAGE_SIZE }),
  );

  const [pins, { refetch: refetchPins }] = createResource(
    () => props.conversationId,
    async (id) => {
      try {
        return (await api.listPins(id)).messages;
      } catch {
        return [] as Message[];
      }
    },
  );

  function markLatestRead() {
    const last = messages().at(-1);
    if (last) {
      void api.markMessageRead(last.id).catch(() => {});
    }
  }

  function replaceMessage(m: Message) {
    setMessages((cur) => cur.map((x) => (x.id === m.id ? { ...m } : x)));
  }

  function removeMessage(id: string) {
    setMessages((cur) =>
      cur
        .filter((x) => x.id !== id)
        .map((x) =>
          x.parent?.id === id
            ? { ...x, parent: { ...x.parent, deleted: true } }
            : x,
        ),
    );
  }

  const unsub = subscribe((e) => {
    const data = e.data as Record<string, unknown> | undefined;
    if (!data || data.conversation_id !== props.conversationId) return;
    if (e.type === "message.created") {
      const m = data.message as Message;
      setMessages((cur) =>
        cur.some((x) => x.id === m.id) ? cur : [...cur, m],
      );
      markLatestRead();
    } else if (e.type === "message.updated") {
      replaceMessage(data.message as Message);
      const upd = data.message as Message;
      if (upd.pinned_at !== undefined) void refetchPins();
    } else if (e.type === "message.deleted") {
      removeMessage(data.message_id as string);
      void refetchPins();
    } else if (e.type === "reaction.updated") {
      const mid = data.message_id as string;
      const reactions = (data.reactions ?? []) as Reaction[];
      setMessages((cur) =>
        cur.map((x) => (x.id === mid ? { ...x, reactions } : x)),
      );
    } else if (e.type === "thread.created" || e.type === "thread.updated") {
      // Events are keyed to the parent conversation — patch the chip on the
      // parent message live (create shows it, replies bump the count).
      const mid = data.parent_message_id as string;
      const t = data.thread as Thread | undefined;
      if (t) {
        const chip: ThreadSummary = {
          id: t.id,
          title: t.title,
          reply_count: t.reply_count,
        };
        setMessages((cur) =>
          cur.map((x) => (x.id === mid ? { ...x, thread: chip } : x)),
        );
      }
    }
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

  // Scroll to the bottom when the latest message changes AND the reader is
  // already near the bottom (or this is the first page). "Load earlier"
  // prepends keep the viewport anchored instead of jumping.
  let stickToBottom = true;
  let lastSeenId: string | undefined;
  createEffect(() => {
    const lastId = messages().at(-1)?.id;
    if (lastId && lastId !== lastSeenId) {
      lastSeenId = lastId;
      if (stickToBottom) {
        scrollEl?.scrollTo({ top: scrollEl.scrollHeight });
      }
    }
  });

  // Late layout shifts (avatars, images arriving after first paint) grow the
  // column — snap back down while the reader is pinned to the bottom.
  const ro = new ResizeObserver(() => {
    if (stickToBottom && scrollEl) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }
  });
  onCleanup(() => ro.disconnect());

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

  // Center a message in the scroll port, paging history back until it mounts
  // (permalinks and pin jumps can target messages older than the first page).
  async function jumpTo(messageId: string) {
    for (let i = 0; i <= 8; i++) {
      const el = document.getElementById(`msg-${messageId}`);
      if (el) {
        el.scrollIntoView({ block: "center" });
        setHighlightId(messageId);
        setTimeout(
          () => setHighlightId((cur) => (cur === messageId ? null : cur)),
          1800,
        );
        return;
      }
      if (!hasMore() || loadingMore() || i === 8) break;
      await loadEarlier();
    }
  }

  // ?msg=<id> permalinks land here after the first page seeds; tracking the
  // last target (not a boolean) lets a second permalink jump work without a
  // remount.
  let permalinkLast: string | null = null;
  createEffect(() => {
    const raw = searchParams.msg;
    const target = (Array.isArray(raw) ? raw[0] : raw) ?? null;
    if (!target) {
      permalinkLast = null;
      return;
    }
    if (target === permalinkLast || firstPage.state !== "ready") return;
    permalinkLast = target;
    void jumpTo(target);
  });

  function autogrow() {
    if (inputEl) {
      inputEl.style.height = "auto";
      inputEl.style.height = `${Math.min(inputEl.scrollHeight, 160)}px`;
    }
  }

  // --- file mentions ---

  async function loadLocalPaths() {
    if (localPaths() !== null) return;
    setLocalPaths([]);
    try {
      const r = await api.listProjectFiles(props.projectId, "", true);
      setLocalPaths(r.entries.map((e) => e.path));
    } catch {
      setLocalPaths([]); // no folder linked or unreadable
    }
  }

  async function loadGhPaths() {
    if (ghPaths() !== null) return;
    setGhPaths([]);
    try {
      const out: string[] = [];
      for (const r of repos() ?? []) {
        const t = await api.repoFileTree(props.projectId, r.full_name);
        for (const e of t.entries) {
          if (!e.dir) {
            out.push(`${r.full_name}:${e.path}`);
          }
        }
      }
      setGhPaths(out);
    } catch {
      setGhPaths([]);
    }
  }

  // Detects the mention token under the caret: "@<part>" (unified), "#<part>"
  // (issues only), "@file:<part>", "@gh:<part>". Trigger must sit at the
  // start of a word — emails and prose don't open the menu.
  function detectMention(text: string, caret: number) {
    const before = text.slice(0, caret);
    const m = before.match(/(?:^|\s)([@#])([\w:./-]*)$/);
    if (!m) {
      setMention(null);
      return;
    }
    const start = caret - m[2]!.length - 1;
    const part = m[2] ?? "";
    let kind: "all" | "issue" | "file" | "gh" = "all";
    if (m[1] === "#") {
      kind = "issue";
    } else if (part.startsWith("file:")) {
      kind = "file";
    } else if (part.startsWith("gh:")) {
      kind = "gh";
    }
    setMention({
      kind,
      part: kind === "file" || kind === "gh" ? part.slice(part.indexOf(":") + 1) : part,
      start,
    });
    setMentionIdx(0);
    if (kind === "file") {
      void loadLocalPaths();
    } else if (kind === "gh") {
      void loadGhPaths();
    }
  }

  interface MentionItem {
    icon: "user" | "agent" | "issue" | "pr" | "file";
    label: string;
    sub?: string;
    insert: string;
  }

  const mentionCandidates = (): MentionItem[] => {
    const m = mention();
    if (!m) return [];
    const needle = m.part.toLowerCase();
    const fit = (...hay: (string | undefined)[]) =>
      !needle || hay.some((h) => h?.toLowerCase().includes(needle));
    if (m.kind === "file" || m.kind === "gh") {
      const src = m.kind === "file" ? (localPaths() ?? []) : (ghPaths() ?? []);
      return src
        .filter((p) => fit(p))
        .slice(0, 8)
        .map((p) => ({
          icon: "file" as const,
          label: p.split("/").pop() ?? p,
          sub: p,
          insert: m.kind === "file" ? `@file:${p}` : `@gh:${p}`,
        }));
    }
    const mm = mentionables();
    if (!mm) return [];
    const out: MentionItem[] = [];
    if (m.kind === "all") {
      for (const u of mm.users) {
        if (fit(u.name)) {
          out.push({
            icon: "user",
            label: u.name,
            sub: "member",
            insert: `@user:${u.name.toLowerCase().replace(/\s+/g, "-")}`,
          });
        }
      }
      for (const a of mm.agents) {
        if (fit(a.name, a.slug)) {
          out.push({
            icon: "agent",
            label: a.name,
            sub: `agent · ${a.slug}`,
            insert: `@agent:${a.slug}`,
          });
        }
      }
    }
    for (const i of mm.issues) {
      if (!fit(i.key, i.title)) continue;
      if (i.kind === "pull_request") {
        out.push({
          icon: "pr",
          label: `${i.repo}#${i.github_number}`,
          sub: i.title,
          insert: `${i.repo}#${i.github_number}`,
        });
      } else {
        out.push({
          icon: "issue",
          label: i.key,
          sub: i.title,
          insert: i.key,
        });
      }
    }
    if (m.kind === "all") {
      for (const r of mm.repos) {
        if (fit(r)) {
          out.push({
            icon: "pr",
            label: `${r}#…`,
            sub: "GitHub issue or PR number",
            insert: `${r}#`,
          });
        }
      }
    }
    return out.slice(0, 8);
  };

  function pickMention(item: MentionItem) {
    const m = mention();
    if (!m || !inputEl) return;
    const text = draft();
    const token = item.insert;
    // repo# items leave the caret mid-token so the user types the number
    const tail = token.endsWith("#") ? "" : " ";
    const next = `${text.slice(0, m.start)}${token}${tail}${text.slice(inputEl.selectionStart)}`;
    setDraft(next);
    setMention(null);
    const el = inputEl;
    queueMicrotask(() => {
      el.focus();
      const pos = m.start + token.length + tail.length;
      el.setSelectionRange(pos, pos);
      autogrow();
      if (tail === "") detectMention(next, pos);
    });
  }

  // File preview modal, opened by md-file chip clicks anywhere in the thread.
  const onOpenFile = (e: Event) => {
    const d = (e as CustomEvent).detail as {
      src: string;
      repo?: string;
      path: string;
      projectId?: string;
    };
    if (d.projectId !== props.projectId || !d.path) return;
    setPreview({ src: d.src, repo: d.repo, path: d.path });
  };
  onMount(() => window.addEventListener("relay:open-file", onOpenFile));
  onCleanup(() => window.removeEventListener("relay:open-file", onOpenFile));

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
      const message = await api.postMessage(
        props.conversationId,
        body,
        ids,
        replyTo()?.id,
      );
      // The SSE message.created frame can land before this POST resolves;
      // skip the local append when it already arrived.
      setMessages((cur) =>
        cur.some((x) => x.id === message.id) ? cur : [...cur, message],
      );
      setDraft("");
      setReplyTo(null);
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

  function startReply(m: Message) {
    setReplyTo(m);
    inputEl?.focus();
  }

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div
        ref={(el) => {
          scrollEl = el;
        }}
        onScroll={() => {
          if (!scrollEl) return;
          const gap =
            scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
          stickToBottom = gap < 60;
        }}
        class="chat-scroll min-h-0 flex-1 overflow-y-auto"
      >
        <Show when={(pins()?.length ?? 0) > 0}>
          <div class="border-b border-border/60 px-4 py-1.5">
            <button
              type="button"
              onClick={() => setPinsOpen((v) => !v)}
              class="flex w-full items-center gap-2 text-[12px] text-muted transition-colors hover:text-fg"
            >
              <PinIcon class="h-3.5 w-3.5" />
              <span class="font-medium">
                {pins()!.length} pinned
              </span>
            </button>
            <Show when={pinsOpen()}>
              <div class="mt-1 flex flex-col gap-0.5 pb-1">
                <For each={pins()}>
                  {(p) => (
                    <div class="group/pin flex items-center gap-2 rounded-md px-2 py-1 text-[12.5px] hover:bg-hover">
                      <button
                        type="button"
                        onClick={() => void jumpTo(p.id)}
                        class="flex min-w-0 flex-1 items-baseline gap-2 text-left"
                      >
                        <span
                          class="shrink-0 font-semibold"
                          style={{ color: authorColor(p.author.name) }}
                        >
                          {p.author.name}
                        </span>
                        <span class="truncate text-muted">
                          {messagePreview(p.body).slice(0, 80) || "(attachment)"}
                        </span>
                      </button>
                      <button
                        type="button"
                        title="Unpin"
                        aria-label="Unpin message"
                        onClick={() =>
                          void api
                            .pinMessage(p.id, false)
                            .then(() => refetchPins())
                        }
                        class="hidden shrink-0 rounded p-0.5 text-muted hover:text-fg group-hover/pin:block"
                      >
                        <XIcon class="h-3 w-3" />
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>
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

        <div ref={(el) => ro.observe(el)} class="flex flex-col px-1 py-2">
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
                  !m.parent && // replies always break the group - strip needs the header slot
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
                    <div class="mx-3 my-3 flex items-center gap-3">
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
                    meId={session.user()?.id}
                    highlighted={highlightId() === m.id}
                    onReply={startReply}
                    onChanged={replaceMessage}
                    onDeleted={removeMessage}
                    onOpenThread={props.onOpenThread}
                  />
                </>
              );
            }}
          </For>
        </div>
      </div>

      <div
        class="relative shrink-0 px-3 pb-4 pt-1 [padding-bottom:max(1rem,env(safe-area-inset-bottom))] sm:px-4"
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
        <Show when={mention() && mentionCandidates().length > 0}>
          <div
            role="listbox"
            aria-label="Mention suggestions"
            class="absolute bottom-full left-3 right-3 z-20 mb-1 max-h-64 overflow-y-auto rounded-lg border border-border bg-surface shadow-lg sm:left-4 sm:right-4"
          >
            <For each={mentionCandidates()}>
              {(item, i) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={i() === mentionIdx()}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickMention(item);
                  }}
                  class={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12.5px] transition-colors ${
                    i() === mentionIdx()
                      ? "bg-hover text-fg"
                      : "text-muted"
                  }`}
                >
                  <span class="w-4 shrink-0 text-center text-[11px] text-faint">
                    {item.icon === "user"
                      ? "@"
                      : item.icon === "agent"
                        ? "◆"
                        : item.icon === "pr"
                          ? "⑃"
                          : item.icon === "issue"
                            ? "#"
                            : "◻"}
                  </span>
                  <span class="truncate font-medium">{item.label}</span>
                  <Show when={item.sub}>
                    <span class="truncate text-[11px] text-faint">
                      {item.sub}
                    </span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
        <div
          class={`rounded-2xl border bg-surface transition-colors ${
            dragging()
              ? "border-accent ring-1 ring-accent/40"
              : "border-border focus-within:border-accent/50"
          }`}
        >
          <Show when={replyTo()}>
            {(target) => (
              <div class="mx-2 mt-2 flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-1.5 text-[12.5px]">
                <ReplyIcon class="h-3.5 w-3.5 shrink-0 text-faint" />
                <span class="text-muted">Replying to</span>
                <span
                  class="font-semibold"
                  style={{ color: authorColor(target().author.name) }}
                >
                  {target().author.name}
                </span>
                <span
                  class="min-w-0 flex-1 truncate text-muted/80"
                  innerHTML={renderMarkdown(
                    messagePreview(target().body).slice(0, 120) ||
                      "(attachment)",
                    props.projectId,
                  )}
                />
                <button
                  type="button"
                  onClick={() => setReplyTo(null)}
                  aria-label="Cancel reply"
                  class="shrink-0 rounded p-0.5 text-muted transition-colors hover:bg-hover hover:text-fg"
                >
                  <XIcon class="h-3 w-3" />
                </button>
              </div>
            )}
          </Show>
          <Show when={pending().length > 0}>
            <ul class="flex flex-wrap gap-2 px-2.5 pt-2.5">
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
              class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-muted transition-colors hover:bg-hover hover:text-fg"
            >
              <PaperclipIcon class="h-4.5 w-4.5" />
            </button>
            <textarea
              ref={(el) => {
                inputEl = el;
              }}
              rows={1}
              value={draft()}
              placeholder="Message — **bold**, `code`, ``` blocks, or Ctrl+V an image"
              aria-label="Message"
              disabled={sending()}
              onInput={(e) => {
                setDraft(e.currentTarget.value);
                autogrow();
                detectMention(
                  e.currentTarget.value,
                  e.currentTarget.selectionStart,
                );
              }}
              onKeyDown={(e) => {
                const m = mention();
                if (m && mentionCandidates().length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setMentionIdx((i) =>
                      Math.min(i + 1, mentionCandidates().length - 1),
                    );
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setMentionIdx((i) => Math.max(i - 1, 0));
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    pickMention(mentionCandidates()[mentionIdx()]!);
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
                if (e.key === "Escape") {
                  if (mention()) {
                    setMention(null);
                  } else if (replyTo()) {
                    setReplyTo(null);
                  }
                }
              }}
              onPaste={(e) => {
                const files = e.clipboardData?.files;
                if (files && files.length > 0) {
                  e.preventDefault();
                  addFiles(Array.from(files));
                }
              }}
              class="max-h-40 flex-1 resize-none bg-transparent px-1.5 py-2.5 text-[14.5px] leading-6 outline-none placeholder:text-faint disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={!canSend()}
              class={`${primaryButtonClass} !h-10 rounded-xl`}
            >
              Send
            </button>
          </div>
          <div class="flex items-center gap-3 border-t border-border/60 px-3 py-1.5 text-[10.5px] text-faint">
            <span>Enter send</span>
            <span>Shift+Enter newline</span>
            <span>Ctrl+V pastes an image</span>
            <Show when={hasUploading()}>
              <span class="ml-auto flex items-center gap-1.5 text-accent-ink">
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
      <Show when={preview()} keyed>
        {(pv) => (
          <FilePreview
            projectId={props.projectId}
            src={pv.src}
            repo={pv.repo}
            path={pv.path}
            onClose={() => setPreview(null)}
          />
        )}
      </Show>
    </div>
  );
}

// FilePreview: read a mentioned local/GitHub file into a modal. Content is
// text-only, capped at 256KB server-side.
function FilePreview(props: {
  projectId: string;
  src: string;
  repo?: string;
  path: string;
  onClose: () => void;
}) {
  const [file] = createResource(
    () => [props.src, props.repo, props.path] as const,
    ([src, repo, path]) =>
      src === "github" && repo
        ? api.repoFileRead(props.projectId, repo, path)
        : api.readProjectFile(props.projectId, path),
  );
  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onClose();
      }}
    >
      <div class="flex max-h-[80vh] w-full max-w-3xl flex-col rounded-xl border border-border bg-surface shadow-xl">
        <div class="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <FileIcon class="h-4 w-4 shrink-0 text-faint" />
          <span class="min-w-0 flex-1 truncate font-mono text-[12px] text-muted">
            <Show when={props.src === "github"}>
              <span class="text-accent-ink">{props.repo}</span>
              <span>:</span>
            </Show>
            {props.path}
          </span>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Close preview"
            class="rounded p-1 text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <XIcon class="h-4 w-4" />
          </button>
        </div>
        <div class="min-h-0 flex-1 overflow-auto">
          <Show
            when={file.state === "ready"}
            fallback={
              <div class="flex justify-center py-10">
                <Show when={file.state === "errored"} fallback={<Spinner />}>
                  <p class="px-4 py-8 text-[13px] text-muted">
                    Could not read file
                  </p>
                </Show>
              </div>
            }
          >
            <pre class="px-4 py-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all">
              {file()?.content}
            </pre>
          </Show>
        </div>
      </div>
    </div>
  );
}

// ThreadPanel: a message-rooted conversation in a side rail. On small
// screens it becomes a full overlay; the rail appears beside the chat on sm+.
function ThreadPanel(props: {
  projectId: string;
  thread: ThreadSummary;
  onClose: () => void;
}) {
  return (
    <div class="fixed inset-0 z-40 flex flex-col bg-surface sm:static sm:z-auto sm:w-80 sm:shrink-0 sm:border-l sm:border-border lg:w-96">
      <div class="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <ThreadIcon class="h-4 w-4 shrink-0 text-faint" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-[13px] font-semibold">
            {props.thread.title || "Thread"}
          </p>
          <p class="text-[10.5px] text-faint">
            {props.thread.reply_count}{" "}
            {props.thread.reply_count === 1 ? "reply" : "replies"}
          </p>
        </div>
        <button
          type="button"
          onClick={props.onClose}
          aria-label="Close thread"
          class="rounded p-1 text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <XIcon class="h-4 w-4" />
        </button>
      </div>
      <ConversationThread
        conversationId={props.thread.id}
        projectId={props.projectId}
      />
    </div>
  );
}

/**
 * Message list + composer for a conversation. Pass `conversation` when the
 * caller already resolved it (e.g. an issue thread); otherwise the project's
 * own conversation is fetched for `projectId`. Messages can spawn threads,
 * which open in a side panel.
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
  const [activeThread, setActiveThread] = createSignal<ThreadSummary | null>(
    null,
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
        <div class="flex min-h-0 flex-1">
          <ConversationThread
            conversationId={c.id}
            projectId={props.projectId}
            onOpenThread={setActiveThread}
          />
          <Show when={activeThread()} keyed>
            {(t) => (
              <ThreadPanel
                projectId={props.projectId}
                thread={t}
                onClose={() => setActiveThread(null)}
              />
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
