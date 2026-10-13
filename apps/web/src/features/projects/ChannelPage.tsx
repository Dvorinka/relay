import { createResource, createSignal, Show } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import type { Channel, Conversation as ApiConversation } from "@relay/api-client";
import { api } from "../../lib/api";
import { subscribe } from "../../lib/events";
import { onCleanup } from "solid-js";
import { copyText } from "../../lib/clipboard";
import { confirmDestructive } from "../../components/Confirm";
import { Spinner, Tip } from "../../components/ui";
import {
  CheckIcon,
  InboxIcon,
  LinkIcon,
  LockIcon,
  MailIcon,
  PencilIcon,
  PulseIcon,
  ReplyIcon,
  TrashIcon,
} from "../../components/icons";
import { Conversation } from "../conversations/Conversation";
import { IntakeGuide } from "./IntakeGuide";
import { EmailAlerts } from "./EmailAlerts";
import { OpsBar } from "../../components/OpsBar";

// ChannelPage renders one persistent side channel: the same message surface
// as the project chat, headed by channel controls (rename, agent access,
// delete).
export default function ChannelPage() {
  const params = useParams<{ projectId: string; channelId: string }>();
  const navigate = useNavigate();
  const [channels, { refetch }] = createResource(
    () => params.projectId,
    (id) => api.listChannels(id).then((r) => r.channels),
  );
  const unsub = subscribe((e) => {
    if (e.type === "stream.resync") {
      refetch();
      return;
    }
    if (e.project_id === params.projectId && e.type.startsWith("channel.")) {
      refetch();
    }
  });
  onCleanup(unsub);

  const channel = () => channels()?.find((c) => c.id === params.channelId);

  const [renaming, setRenaming] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [copied, setCopied] = createSignal(false);
  const [guideOpen, setGuideOpen] = createSignal(false);
  const [alertsOpen, setAlertsOpen] = createSignal(false);
  const alertCount = () => channel()?.email_alerts?.length ?? 0;

  async function rename() {
    const ch = channel();
    const name = draft().trim();
    if (!ch || !name || name === ch.name) {
      setRenaming(false);
      return;
    }
    await api.updateChannel(ch.id, { name }).catch(() => {});
    setRenaming(false);
    refetch();
  }

  async function toggleAgents() {
    const ch = channel();
    if (!ch) return;
    await api
      .updateChannel(ch.id, { agents_blocked: !ch.agents_blocked })
      .catch(() => {});
    refetch();
  }

  async function setIntake(mode: "" | "receive" | "chat" | "ops") {
    const ch = channel();
    if (!ch) return;
    await api.updateChannel(ch.id, { intake_mode: mode }).catch(() => {});
    refetch();
    // Any activation opens the setup guide — the mode is pointless
    // without a hook wired to the channel.
    if (mode !== "") setGuideOpen(true);
  }

  async function remove() {
    const ch = channel();
    if (!ch) return;
    const ok = await confirmDestructive({
      title: `Delete #${ch.name ?? "channel"}`,
      body: "All messages in this channel are deleted permanently. Threads and other channels are unaffected.",
      confirmLabel: "Delete channel",
    });
    if (!ok) return;
    await api.deleteChannel(ch.id).catch(() => {});
    navigate(`/app/p/${params.projectId}`);
  }

  const headerBtn =
    "rounded p-1.5 text-muted transition-colors hover:bg-hover hover:text-fg";

  return (
    <div class="flex h-full min-h-0 flex-col">
      <header class="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3 sm:px-4">
        <span class="text-[15px] text-faint">#</span>
        <Show
          when={!renaming()}
          fallback={
            <input
              ref={(el) => queueMicrotask(() => el.focus())}
              value={draft()}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void rename();
                if (e.key === "Escape") setRenaming(false);
              }}
              onBlur={() => void rename()}
              maxLength={60}
              class="h-7 rounded-md border border-border bg-bg px-2 text-[14px] font-semibold text-fg outline-none focus:border-accent"
            />
          }
        >
          <h1 class="min-w-0 truncate text-[14.5px] font-semibold tracking-tight">
            {channel()?.name ?? "channel"}
          </h1>
        </Show>
        <Show when={channel()?.agents_blocked}>
          <Tip
            text="Agents blocked"
            hint="Agents can't see or post in this channel"
          >
            <span class="flex items-center gap-1 rounded-full bg-hover px-2 py-0.5 text-[10.5px] font-medium text-muted">
              <LockIcon class="h-3 w-3" /> agents blocked
            </span>
          </Tip>
        </Show>
        <Show when={channel()?.intake_mode}>
          <Tip
            text={
              channel()?.intake_mode === "chat"
                ? "Support intake — live chat"
                : channel()?.intake_mode === "ops"
                  ? "Ops channel — monitoring & alerts"
                  : "Support intake — receive only"
            }
            hint={
              channel()?.intake_mode === "chat"
                ? "The platform posts reports and pulls replies — click for the setup guide"
                : channel()?.intake_mode === "ops"
                  ? "Monitors, CI and error trackers POST structured events here — click for the setup guide"
                  : "The platform posts reports; replies stay in Relay — click for the setup guide"
            }
          >
            <button
              type="button"
              class="flex items-center gap-1 rounded-full bg-hover px-2 py-0.5 text-[10.5px] font-medium text-muted transition-colors hover:text-fg"
              onClick={() => setGuideOpen(true)}
            >
              <Show
                when={channel()?.intake_mode === "ops"}
                fallback={<InboxIcon class="h-3 w-3" />}
              >
                <PulseIcon class="h-3 w-3" />
              </Show>
              {channel()?.intake_mode === "chat"
                ? "intake · chat"
                : channel()?.intake_mode === "ops"
                  ? "ops"
                  : "intake"}
            </button>
          </Tip>
        </Show>
        <div class="ml-auto flex shrink-0 items-center gap-0.5">
          <Tip text="Copy channel ID" hint="Paste to an agent's harness to address this channel">
            <button
              type="button"
              aria-label="Copy channel ID"
              class={headerBtn}
              onClick={async () => {
                if (await copyText(params.channelId)) {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }
              }}
            >
              <Show when={copied()} fallback={<LinkIcon class="h-4 w-4" />}>
                <CheckIcon class="h-4 w-4" />
              </Show>
            </button>
          </Tip>
          <Tip
            text={
              channel()?.intake_mode
                ? "Receive — on · setup guide"
                : "Enable receive — support intake"
            }
            hint="External products POST reports here via an inbound hook"
          >
            <button
              type="button"
              aria-label="Toggle support intake (receive)"
              aria-pressed={!!channel()?.intake_mode}
              class={`${headerBtn} ${channel()?.intake_mode ? "text-accent" : ""}`}
              onClick={() => {
                if (channel()?.intake_mode) {
                  setGuideOpen(true);
                } else {
                  void setIntake("receive");
                }
              }}
            >
              <InboxIcon class="h-4 w-4" />
            </button>
          </Tip>
          <Show when={channel()?.intake_mode}>
            <Tip
              text={
                channel()?.intake_mode === "chat"
                  ? "Live chat — on"
                  : "Enable live chat — receive & send"
              }
              hint="The platform's users chat with your team: the hook token also pulls replies"
            >
              <button
                type="button"
                aria-label="Toggle live chat (receive & send)"
                aria-pressed={channel()?.intake_mode === "chat"}
                class={`${headerBtn} ${
                  channel()?.intake_mode === "chat" ? "text-accent" : ""
                }`}
                onClick={() =>
                  void setIntake(
                    channel()?.intake_mode === "chat" ? "receive" : "chat",
                  )
                }
              >
                <ReplyIcon class="h-4 w-4" />
              </button>
            </Tip>
            <Tip
              text={
                channel()?.intake_mode === "ops"
                  ? "Ops mode — on"
                  : "Enable ops — monitoring & alerts"
              }
              hint="Ops channels surface a status board and render meta posts as cards"
            >
              <button
                type="button"
                aria-label="Toggle ops mode"
                aria-pressed={channel()?.intake_mode === "ops"}
                class={`${headerBtn} ${
                  channel()?.intake_mode === "ops" ? "text-accent" : ""
                }`}
                onClick={() =>
                  void setIntake(
                    channel()?.intake_mode === "ops" ? "receive" : "ops",
                  )
                }
              >
                <PulseIcon class="h-4 w-4" />
              </button>
            </Tip>
          </Show>
          <Tip
            text={channel()?.agents_blocked ? "Allow agents" : "Block agents"}
            hint="When blocked, agents can't read or post here"
          >
            <button
              type="button"
              aria-label="Toggle agent access"
              aria-pressed={channel()?.agents_blocked ?? false}
              class={`${headerBtn} ${channel()?.agents_blocked ? "text-amber-500" : ""}`}
              onClick={() => void toggleAgents()}
            >
              <LockIcon class="h-4 w-4" />
            </button>
          </Tip>
          <Tip
            text={
              alertCount() > 0
                ? `Email alerts — ${alertCount()} recipient${alertCount() > 1 ? "s" : ""}`
                : "Email alerts"
            }
            hint="Mail every new message in this channel to a list"
          >
            <button
              type="button"
              aria-label="Email alerts"
              aria-pressed={alertCount() > 0}
              class={`${headerBtn} ${alertCount() > 0 ? "text-accent" : ""}`}
              onClick={() => setAlertsOpen(true)}
            >
              <MailIcon class="h-4 w-4" />
            </button>
          </Tip>
          <Tip text="Rename" hint="Rename this channel">
            <button
              type="button"
              aria-label="Rename channel"
              class={headerBtn}
              onClick={() => {
                setDraft(channel()?.name ?? "");
                setRenaming(true);
              }}
            >
              <PencilIcon class="h-4 w-4" />
            </button>
          </Tip>
          <Tip text="Delete channel" hint="Removes the channel and its messages">
            <button
              type="button"
              aria-label="Delete channel"
              class={`${headerBtn} hover:text-red-500`}
              onClick={() => void remove()}
            >
              <TrashIcon class="h-4 w-4" />
            </button>
          </Tip>
        </div>
      </header>
      <div class="flex min-h-0 flex-1">
        <Show
          when={channel()}
          keyed
          fallback={
            <div class="flex flex-1 items-center justify-center">
              <Show when={channels.loading} fallback={<p class="text-[13px] text-muted">Channel not found</p>}>
                <Spinner class="h-4 w-4" />
              </Show>
            </div>
          }
        >
          {(ch: Channel) => (
            <div class="flex min-h-0 flex-1 flex-col">
              <Show when={ch.intake_mode === "ops"}>
                <OpsBar
                  conversationId={ch.id}
                  projectId={params.projectId}
                  onSetup={() => setGuideOpen(true)}
                />
              </Show>
              <Conversation
                projectId={params.projectId}
                conversation={ch as ApiConversation}
              />
            </div>
          )}
        </Show>
      </div>
      <IntakeGuide
        projectId={params.projectId}
        channel={channel}
        open={guideOpen()}
        onOpenChange={setGuideOpen}
        onMode={(m) => void setIntake(m)}
      />
      <EmailAlerts
        channel={channel}
        open={alertsOpen()}
        onOpenChange={setAlertsOpen}
        onSaved={refetch}
      />
    </div>
  );
}
