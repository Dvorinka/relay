// IntakeGuide — the setup wizard for a support-intake channel. Shows the
// channel's inbound hook (create/rotate inline), the payload contract,
// copy-paste snippets per language, and a ready-made prompt to hand to an
// AI coding agent so it can wire the integration itself.
import { Dialog } from "@ark-ui/solid";
import type { Channel, InboundHook } from "@relay/api-client";
import { createResource, createSignal, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { copyText } from "../../lib/clipboard";
import { api } from "../../lib/api";
import { net } from "../../lib/net";
import { CheckIcon, CopyIcon, XIcon } from "../../components/icons";
import { FormError, Spinner } from "../../components/ui";

const langTabs = ["curl", "javascript", "python", "go", "ai prompt"] as const;
type LangTab = (typeof langTabs)[number];

// snippet builders — each returns the example for its language, with the
// hook URL inlined so the result is paste-ready.
function snippets(url: string): Record<LangTab, string> {
  return {
    curl: `HOOK_URL="${url}"

curl -X POST "$HOOK_URL" \\
  -H "Content-Type: application/json" \\
  -d '{
    "from":    "user-4821",
    "kind":    "bug",
    "subject": "Invoice totals look wrong",
    "key":     "ticket-4821",
    "message": "The sum on invoice #221 is twice the line items."
  }'`,
    javascript: `const res = await fetch("${url}", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    from: user.id,                 // external sender attribution
    kind: report.type,             // "bug" | "feature" | … your own types
    subject: report.title,         // bold heading in Relay
    key: \`ticket-\${report.id}\`, // follow-ups with the same key thread here
    message: report.body,          // markdown rendered
    // attachments: up to 5 — { name, content_type, data: "<base64>" }
  }),
});
// res.json() -> { posted, message_id, threaded, attachments }`,
    python: `import requests

requests.post("${url}", json={
    "from":    user.email,                    # external sender
    "kind":    report.type,                   # "bug" | "feature" | any type
    "subject": report.title,                  # bold heading in Relay
    "key":     f"ticket-{report.id}",         # same key -> same thread
    "message": report.body,
    # attachments: [{"name": "app.log",
    #                "content_type": "text/plain",
    #                "data": base64_bytes}]   # max 5
})`,
    go: `payload, _ := json.Marshal(map[string]any{
    "from":    user.Email,
    "kind":    report.Type, // "bug" | "feature" | your own types
    "subject": report.Title,
    "key":     fmt.Sprintf("ticket-%d", report.ID), // threads follow-ups
    "message": report.Body,
})
req, _ := http.NewRequest(http.MethodPost,
    "${url}", bytes.NewReader(payload))
req.Header.Set("Content-Type", "application/json")
resp, err := http.DefaultClient.Do(req)`,
    "ai prompt": `You are wiring live customer support into our product. Relay
exposes a token-secured intake endpoint; POST JSON to it whenever a user
submits a report, a support message, or a background job hits an error
worth flagging.

Endpoint: POST ${url}
Content-Type: application/json — no auth header; the path token IS the
credential. Keep it in server-side config only (RELAY_INTAKE_URL env var),
never ship it to browsers or mobile clients — proxy through our backend.

Payload fields:
  message | text | body  required — the report text (markdown rendered)
  from                  sender attribution, e.g. "Alice <alice@acme.com>"
  kind                  report type — free-form, you name your own types
                        ("bug", "feature", "incident"). Renders as a
                        colored chip + a kind label. If the hook has a
                        default kind set, omit to inherit it.
  subject               optional bold heading shown above the body —
                        becomes the sub-chat's title
  key                   stable ticket key (your ticket/conversation id).
                        IMPORTANT: the first post with a key opens a
                        dedicated SUB-CHAT under the channel — its own
                        conversation the support team talks inside.
                        Every later post with the same key lands in that
                        sub-chat, not the channel.
  attachments           up to 5: { name, content_type, data } — base64.
                        Use for stack-trace logs and screenshots.

Responses:
  202 { posted, message_id, conversation_id, thread_id, parent_id,
        threaded, attachments }
      thread_id   the ticket's sub-chat (present whenever key was sent)
      threaded    true when this post joined an existing sub-chat
      202 means durable — do not retry; retry only on network error or 5xx
  400 bad_request    malformed JSON, empty body, >5 attachments, oversized
  404 not_found      wrong token or the hook was disabled
  429 rate_limited   back off — budget is 30 posts/minute per token
  503 storage_disabled  attachments sent but the server has no object
                        storage configured — resend without files

Replies back to the customer — pick one or both:
  a) Pull (live chat): GET ${url}/messages?key=<ticket>&after=<last-id>
     returns { messages: [{ id, body, author_name, author_kind
     ("user"|"agent"), from, key, kind, tags, via_hook, parent_id,
     attachments, created_at }] }, oldest first, up to 200.
     Poll each open ticket every few seconds; pass the last seen
     message id as ?after= for deltas. Budget: 120 reads/minute.
     Messages your platform sent come back tagged with via_hook=true —
     skip them; via_hook=false rows are the support team's replies to
     show the customer. Works only while the channel is in live-chat
     mode; receive-only channels answer 403 intake_read_disabled.
  b) Push: create an outbound webhook subscription for "message.created"
     on the project. Relay POSTs { id, type, project_id, occurred_at,
     data: { conversation_id, message } } to your URL, HMAC-SHA256-signed
     via the X-Relay-Signature-256 header — verify it with the
     subscription secret before trusting the body.

IMPORTANT — echo-loop guard: never forward a message back into the
intake endpoint when its tags contain "webhook" (pull mode:
via_hook=true). Those posts already came from our platform and
re-posting them loops forever.

Visibility: everything posted inside a ticket's sub-chat ships to the
customer in chat mode. Keep internal triage notes in the channel or a
separate thread — only customer-facing answers go in the sub-chat.

Multiple report types or products: either send different "kind" values
to this one endpoint, or create a second inbound hook (each has its own
default kind and header template) pointed at the same or a different
channel — e.g. one channel per customer, kinds per report type.`,
  };
}

// chatRepliesSnippet — the pull path shown when the channel is in
// live-chat mode.
function chatRepliesSnippet(url: string): string {
  return `// Poll for replies on a ticket (chat-mode channels only)
const r = await fetch("${url}/messages?key=ticket-4821&after=" + lastId);
const { messages } = await r.json();
// via_hook=true  -> our own posts coming back — don't re-render them
// via_hook=false -> the support team's replies — show to the customer
for (const m of messages) if (!m.via_hook) render(m);`;
}

function CopyButton(props: { text: () => string }) {
  const [done, setDone] = createSignal(false);
  return (
    <button
      type="button"
      class="flex items-center gap-1 text-[11px] text-muted transition-colors hover:text-fg"
      onClick={async () => {
        if (await copyText(props.text())) {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }
      }}
    >
      <Show when={done()} fallback={<CopyIcon class="h-3 w-3" />}>
        <CheckIcon class="h-3 w-3" />
      </Show>
      {done() ? "Copied" : "Copy"}
    </button>
  );
}

// One hook row / create row — the token is only visible right after
// create or rotate, so the URL is shown in the amber "shown once" box.
function HookBlock(props: {
  projectId: string;
  channelId: string;
  hook: () => InboundHook | undefined;
  freshUrl: () => string;
  onChanged: () => void;
  onFresh: (url: string) => void;
}) {
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal("");
  const base = () => (net.serverUrl() || window.location.origin) + "/api/hooks/";

  const create = async () => {
    if (busy()) return;
    setBusy(true);
    setErr("");
    try {
      const r = await api.createInboundHook(props.projectId, {
        name: "support-intake",
        conversation_id: props.channelId,
      });
      props.onFresh(r.url);
      props.onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "create failed");
    } finally {
      setBusy(false);
    }
  };

  const rotate = async () => {
    const h = props.hook();
    if (!h || busy()) return;
    setBusy(true);
    setErr("");
    try {
      const r = await api.rotateInboundHook(h.id!);
      props.onFresh(r.url);
      props.onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "rotate failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="rounded-md border border-border bg-hover/40 px-3 py-2.5">
      <Show
        when={props.hook()}
        fallback={
          <div class="flex items-center gap-2">
            <code class="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">
              POST {base()}
              {"<token>"}
            </code>
            <button
              type="button"
              disabled={busy()}
              onClick={() => void create()}
              class="shrink-0 rounded bg-accent px-2.5 py-1 text-[11.5px] font-medium text-white transition-opacity disabled:opacity-40"
            >
              {busy() ? "Creating…" : "Create intake hook"}
            </button>
          </div>
        }
      >
        {(h: () => InboundHook) => (
          <div class="flex items-center gap-2">
            <span
              class={`h-1.5 w-1.5 shrink-0 rounded-full ${
                h().enabled ? "bg-emerald-500" : "bg-muted/40"
              }`}
            />
            <code class="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">
              {h().name} · {base()}
              {h().token_hint}…
            </code>
            <button
              type="button"
              disabled={busy()}
              onClick={() => void rotate()}
              class="shrink-0 text-[11.5px] text-muted transition-colors hover:text-fg"
            >
              Rotate URL
            </button>
          </div>
        )}
      </Show>
      <Show when={props.freshUrl()}>
        <div class="mt-2 rounded border border-amber-500/40 bg-amber-500/[0.06] px-2 py-1.5">
          <p class="text-[10px] font-medium uppercase tracking-wider text-amber-600 dark:text-amber-400">
            URL — shown once
          </p>
          <p class="mt-0.5 select-all break-all font-mono text-[11px]">
            {props.freshUrl()}
          </p>
        </div>
      </Show>
      <FormError message={err()} />
    </div>
  );
}

export function IntakeGuide(props: {
  projectId: string;
  channel: () => Channel | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMode: (mode: "" | "receive" | "chat") => void;
}) {
  const [hooks, { refetch }] = createResource(
    () => (props.open ? props.projectId : null),
    (id) => api.listInboundHooks(id).then((r) => r.hooks),
  );
  const hook = () =>
    (hooks() ?? []).find((h) => h.conversation_id === props.channel()?.id);
  const [freshUrl, setFreshUrl] = createSignal("");
  const [tab, setTab] = createSignal<LangTab>("curl");

  const base = () => (net.serverUrl() || window.location.origin) + "/api/hooks/";
  const url = () => freshUrl() || base() + "<token>";
  const body = () => snippets(url())[tab()];

  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(d) => props.onOpenChange(d.open)}
    >
      <Portal>
        <Dialog.Backdrop class="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Positioner class="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto p-4 pt-[6vh]">
          <Dialog.Content class="w-full max-w-2xl rounded-md border border-border bg-surface p-5 shadow-lg outline-none">
            <div class="flex items-start gap-2">
              <div class="min-w-0 flex-1">
                <Dialog.Title class="text-[14px] font-semibold">
                  Support intake — #{props.channel()?.name ?? "channel"}
                </Dialog.Title>
                <Dialog.Description class="mt-1 text-[12px] text-muted">
                  Anything that can POST JSON can file a report into this
                  channel. The path token is the credential — keep it
                  server-side.{" "}
                  {props.channel()?.intake_mode === "chat"
                    ? "Live chat is on — the token can also pull replies."
                    : "Receive-only — replies stay inside Relay."}
                </Dialog.Description>
              </div>
              <Dialog.CloseTrigger class="rounded p-1 text-muted transition-colors hover:bg-hover hover:text-fg">
                <XIcon class="h-4 w-4" />
              </Dialog.CloseTrigger>
            </div>

            <div class="mt-4">
              <h3 class="text-[12px] font-semibold">1 · Endpoint</h3>
              <p class="mt-1 text-[11.5px] text-muted">
                One inbound hook per channel. Create it, copy the URL once,
                store it in your product's config.
              </p>
              <div class="mt-2">
                <Show when={hooks.state === "ready"} fallback={<Spinner class="h-4 w-4" />}>
                  <HookBlock
                    projectId={props.projectId}
                    channelId={props.channel()?.id ?? ""}
                    hook={hook}
                    freshUrl={freshUrl}
                    onChanged={refetch}
                    onFresh={setFreshUrl}
                  />
                </Show>
              </div>
            </div>

            <div class="mt-4">
              <h3 class="text-[12px] font-semibold">2 · Payload</h3>
              <div class="mt-1.5 grid grid-cols-[110px_1fr] gap-y-1 rounded-md border border-border px-3 py-2 text-[11.5px]">
                <code class="font-mono text-fg">message</code>
                <span class="text-muted">
                  required (or <code class="font-mono">text</code> /{" "}
                  <code class="font-mono">body</code>) — markdown rendered
                </span>
                <code class="font-mono text-fg">from</code>
                <span class="text-muted">external sender attribution</span>
                <code class="font-mono text-fg">kind</code>
                <span class="text-muted">
                  report type — free-form, your own names; colored chip +
                  label
                </span>
                <code class="font-mono text-fg">subject</code>
                <span class="text-muted">bold heading above the body</span>
                <code class="font-mono text-fg">key</code>
                <span class="text-muted">
                  stable ticket key — the first post opens a dedicated
                  sub-chat under this channel; same-key posts join it
                </span>
                <code class="font-mono text-fg">attachments</code>
                <span class="text-muted">
                  up to 5 ·{" "}
                  <code class="font-mono">
                    {"{name, content_type, data: base64}"}
                  </code>
                </span>
              </div>
            </div>

            <div class="mt-4">
              <div class="flex items-center gap-2">
                <h3 class="text-[12px] font-semibold">3 · Wire it in</h3>
                <div class="ml-auto flex items-center gap-1">
                  <For each={langTabs}>
                    {(t) => (
                      <button
                        type="button"
                        onClick={() => setTab(t)}
                        class={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                          tab() === t
                            ? "bg-hover font-medium text-fg"
                            : "text-muted hover:text-fg"
                        }`}
                      >
                        {t}
                      </button>
                    )}
                  </For>
                </div>
              </div>
              <div class="mt-1.5 rounded-md border border-border bg-bg">
                <div class="flex items-center justify-between border-b border-border/60 px-3 py-1.5">
                  <span class="text-[10.5px] font-medium uppercase tracking-wider text-muted">
                    {tab()}
                  </span>
                  <CopyButton text={body} />
                </div>
                <pre class="max-h-64 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre">
                  {body()}
                </pre>
              </div>
            </div>

            <div class="mt-4 rounded-md border border-border bg-hover/40 px-3 py-2.5">
              <h3 class="text-[12px] font-semibold">4 · Replies back to your product</h3>
              <Show
                when={props.channel()?.intake_mode === "chat"}
                fallback={
                  <p class="mt-1 text-[11.5px] leading-relaxed text-muted">
                    This channel is{" "}
                    <span class="font-medium text-fg">receive-only</span> —
                    replies stay inside Relay. Flip on{" "}
                    <span class="font-medium text-fg">live chat</span> in the
                    channel header to let the platform pull replies, or create
                    an outbound <code class="font-mono">message.created</code>{" "}
                    webhook (project → Webhooks) to push them.
                  </p>
                }
              >
                <p class="mt-1 text-[11.5px] leading-relaxed text-muted">
                  <span class="font-medium text-fg">Live chat is on.</span>{" "}
                  Each ticket is a sub-chat under this channel — whatever
                  the team posts inside it is what the platform pulls. Poll
                  the same token at{" "}
                  <code class="font-mono">
                    GET {"<hook-url>"}/messages?key=…&after=…
                  </code>{" "}
                  (120 reads/min) or subscribe an outbound webhook to{" "}
                  <code class="font-mono">message.created</code> for push.
                  Either way, skip posts tagged{" "}
                  <code class="font-mono">"webhook"</code> /{" "}
                  <code class="font-mono">via_hook</code> — forwarding them
                  back would echo-loop.
                </p>
                <div class="mt-2 rounded-md border border-border bg-bg">
                  <div class="flex items-center justify-between border-b border-border/60 px-3 py-1.5">
                    <span class="text-[10.5px] font-medium uppercase tracking-wider text-muted">
                      pull replies
                    </span>
                    <CopyButton text={() => chatRepliesSnippet(url())} />
                  </div>
                  <pre class="overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre">
                    {chatRepliesSnippet(url())}
                  </pre>
                </div>
              </Show>
            </div>

            <div class="mt-5 flex items-center justify-between">
              <p class="text-[11px] text-muted">
                Pair with “block agents” in the header if intake should stay
                human-only — or leave it open so agents can triage reports.
              </p>
              <button
                type="button"
                class="shrink-0 rounded px-2.5 py-1 text-[11.5px] text-red-500/80 transition-colors hover:bg-hover hover:text-red-500"
                onClick={() => {
                  props.onMode("");
                  props.onOpenChange(false);
                }}
              >
                Disable intake
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
