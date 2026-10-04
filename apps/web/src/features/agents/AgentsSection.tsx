import {
  type Agent,
  type AgentInvite,
  type AgentScope,
  type McpTokenMeta,
  type MintedToken,
  type Project,
} from "@relay/api-client";
import { A } from "@solidjs/router";
import { createResource, createSignal, For, Show } from "solid-js";
import {
  ConfirmDialog,
  FormError,
  ImageURLField,
  SubmitButton,
  inputClass,
  Tip,
} from "../../components/ui";
import { api } from "../../lib/api";
import { confirmDestructive } from "../../components/Confirm";
import { mediaURL, net } from "../../lib/net";
import { timeAgo, timeUntil } from "../../lib/time";

const ALL_SCOPES: AgentScope[] = [
  "project:read",
  "message:read",
  "message:write",
  "attachment:read",
  "issue:read",
  "issue:write",
  "review:read",
  "review:write",
  "file:read",
  "brief:read",
  "brief:write",
];

// Mirrors agents.DefaultInviteScopes on the server.
const DEFAULT_INVITE_SCOPES: AgentScope[] = [
  "project:read",
  "message:read",
  "message:write",
  "attachment:read",
  "issue:read",
  "issue:write",
  "review:read",
  "review:write",
];

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function AgentRow(props: {
  agent: Agent;
  projects: Project[];
  canManage: boolean;
  expanded: boolean;
  minted: MintedToken | undefined;
  onMinted: (t: MintedToken) => void;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const open = () => props.expanded;
  const [detail, { refetch }] = createResource(open, async (isOpen) => {
    if (!isOpen) return null;
    return api.getAgent(props.agent.id);
  });
  const [error, setError] = createSignal<string | null>(null);
  const [grantProject, setGrantProject] = createSignal("");
  const [grantScopes, setGrantScopes] = createSignal<AgentScope[]>([
    "project:read",
    "message:read",
  ]);
  const [deleteOpen, setDeleteOpen] = createSignal(false);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await refetch();
      props.onChanged();
    } catch (err) {
      setError(errorMessage(err, "Something went wrong"));
    }
  }

  async function onGrant(e: SubmitEvent) {
    e.preventDefault();
    const pid = grantProject();
    if (!pid) return;
    await run(() => api.grantAgentProject(props.agent.id, pid, grantScopes()));
  }

  async function onMint(e: SubmitEvent) {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    await run(async () => {
      const t = await api.mintAgentToken(props.agent.id, {
        name: String(data.get("name") ?? "default"),
      });
      props.onMinted(t);
    });
    form.reset();
  }

  function toggleScope(s: AgentScope) {
    setGrantScopes((cur) =>
      cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s],
    );
  }

  const grantedIds = () =>
    new Set((detail()?.agent.grants ?? []).map((g) => g.project_id));

  return (
    <li class="px-3 py-2.5">
      <button
        type="button"
        class="flex w-full items-center gap-3 text-left"
        onClick={() => props.onToggle()}
      >
        <Show
          when={props.agent.avatar_url}
          fallback={
            <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-surface font-mono text-[11px] text-muted">
              {props.agent.name.slice(0, 1).toUpperCase()}
            </span>
          }
        >
          {(url) => (
            <img
              src={mediaURL(url())}
              alt=""
              class="h-7 w-7 shrink-0 rounded-md border border-border object-cover"
            />
          )}
        </Show>
        <div class="min-w-0 flex-1">
          <Tip text={props.agent.name} hint="Open this agent's details">
            <A
              href={`/app/ag/${props.agent.id}`}
              onClick={(e) => e.stopPropagation()}
              class="block truncate text-[13px] font-medium hover:underline"
            >
              {props.agent.name}
            </A>
          </Tip>
          <p class="truncate font-mono text-[11px] text-muted">
            @{props.agent.slug}
          </p>
        </div>
        <Show when={props.agent.grant_all}>
          <Tip text="All projects" hint="Can access every workspace project, including ones created later">
            <span class="rounded-full border border-accent/40 bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent-ink">
              all projects
            </span>
          </Tip>
        </Show>
        <Show when={props.agent.review_mode === "gate"}>
          <Tip text="Review-gated" hint="Must wait for a human verdict on each submitted review">
            <span class="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
              review-gated
            </span>
          </Tip>
        </Show>
        <span class="text-[11px] text-muted">
          {props.agent.last_seen_at
            ? `last seen ${timeAgo(props.agent.last_seen_at)}`
            : "never used"}
        </span>
      </button>

      <Show when={open()}>
        <div class="mt-3 flex flex-col gap-4 border-t border-border pt-3">
          <Show when={detail()} fallback={<p class="text-[13px] text-muted">Loading...</p>}>
            {(d) => (
              <>
                <Show when={props.canManage}>
                  <div>
                    <h3 class="mb-2 text-[12px] font-semibold">Logo</h3>
                    <div class="flex items-center gap-3">
                      <Show
                        when={d().agent.avatar_url}
                        fallback={
                          <span class="flex h-9 w-9 items-center justify-center rounded-md border border-dashed border-border font-mono text-[12px] text-muted">
                            {d().agent.name.slice(0, 1).toUpperCase()}
                          </span>
                        }
                      >
                        {(url) => (
                          <img
                            src={mediaURL(url())}
                            alt=""
                            class="h-9 w-9 rounded-md border border-border object-cover"
                          />
                        )}
                      </Show>
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp,image/x-icon"
                        aria-label="Agent logo"
                        class="text-[12px] text-muted file:mr-3 file:rounded-md file:border file:border-border file:bg-surface file:px-2.5 file:py-1 file:text-[12px] file:text-fg hover:file:bg-hover"
                        onChange={(e) => {
                          const f = e.currentTarget.files?.[0];
                          if (f) {
                            void run(() =>
                              api.uploadAgentAvatar(props.agent.id, f),
                            );
                            e.currentTarget.value = "";
                          }
                        }}
                      />
                    </div>
                    <div class="mt-2 max-w-sm">
                      <ImageURLField
                        onSubmit={(u) =>
                          run(() =>
                            api.uploadImageURL(
                              `/api/agents/${props.agent.id}/avatar`,
                              u,
                            ),
                          )
                        }
                      />
                    </div>
                  </div>
                </Show>
                <div>
                  <h3 class="mb-2 text-[12px] font-semibold">Review mode</h3>
                  <div class="flex items-center gap-2 text-[13px]">
                    <select
                      class={inputClass}
                      value={d().agent.review_mode ?? "notify"}
                      disabled={!props.canManage}
                      aria-label="Review mode"
                      onChange={(e) =>
                        run(() =>
                          api.updateAgent(props.agent.id, {
                            review_mode: e.currentTarget.value as
                              | "notify"
                              | "gate",
                          }),
                        )
                      }
                    >
                      <option value="notify">
                        Notify - agent reports after finishing work
                      </option>
                      <option value="gate">
                        Gate - agent waits for approval on each review
                      </option>
                    </select>
                  </div>
                  <p class="mt-1 text-[11px] text-muted">
                    Gate makes the agent block on <code>await_review</code>{" "}
                    until you approve or request changes on the review card.
                  </p>
                </div>

                <div>
                  <h3 class="mb-2 text-[12px] font-semibold">Project access</h3>
                  <Show when={d().agent.grant_all}>
                    <div class="mb-2 flex items-center gap-2 rounded-md border border-accent/40 bg-accent-soft/50 px-2 py-1.5 text-[13px]">
                      <span class="font-medium text-accent-ink">
                        Every project
                      </span>
                      <span class="text-[11px] text-muted">
                        including ones created later
                      </span>
                      <span class="flex-1" />
                      <For each={d().agent.grant_scopes ?? []}>
                        {(s) => (
                          <span class="rounded border border-border px-1 font-mono text-[10px] text-muted">
                            {s}
                          </span>
                        )}
                      </For>
                      <Show when={props.canManage}>
                        <button
                          type="button"
                          class="text-[11px] text-muted hover:text-red-600 dark:hover:text-red-400"
                          onClick={() =>
                            run(() =>
                              api.updateAgent(props.agent.id, {
                                grant_all: false,
                              }),
                            )
                          }
                        >
                          revoke all
                        </button>
                      </Show>
                    </div>
                  </Show>
                  <ul class="mb-2 flex flex-col gap-1.5">
                    <For each={d().agent.grants}>
                      {(g) => (
                        <li class="flex items-center gap-2 text-[13px]">
                          <span class="font-mono text-[12px]">
                            {g.project_key}
                          </span>
                          <span class="text-muted">{g.project_name}</span>
                          <span class="flex-1" />
                          <For each={g.scopes}>
                            {(s) => (
                              <span class="rounded border border-border px-1 font-mono text-[10px] text-muted">
                                {s}
                              </span>
                            )}
                          </For>
                          <Show when={props.canManage}>
                            <button
                              type="button"
                              class="text-[11px] text-muted hover:text-red-600 dark:hover:text-red-400"
                              onClick={async () => {
                                if (
                                  !(await confirmDestructive({
                                    title: "Revoke project access",
                                    body: `Revoke ${props.agent.name}'s access to ${g.project_name}? Its tokens keep working on other granted projects.`,
                                    confirmLabel: "Revoke",
                                  }))
                                )
                                  return;
                                run(() =>
                                  api.revokeAgentProject(
                                    props.agent.id,
                                    g.project_id,
                                  ),
                                );
                              }}
                            >
                              revoke
                            </button>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                  <Show when={props.canManage}>
                    <Show when={!d().agent.grant_all}>
                      <button
                        type="button"
                        class="mb-2 text-[11.5px] font-medium text-accent-ink underline-offset-2 hover:underline"
                        onClick={() =>
                          run(() =>
                            api.updateAgent(props.agent.id, {
                              grant_all: true,
                            }),
                          )
                        }
                      >
                        Grant every project, including future ones
                      </button>
                    </Show>
                    <Show
                      when={props.projects.some(
                        (p) => !grantedIds().has(p.id),
                      )}
                      fallback={
                        <p class="text-[11px] text-muted">
                          All projects already granted.
                        </p>
                      }
                    >
                      <form onSubmit={onGrant} class="flex flex-col gap-2">
                      <select
                        class={inputClass}
                        value={grantProject()}
                        onChange={(e) => setGrantProject(e.currentTarget.value)}
                        aria-label="Project"
                      >
                        <option value="">Grant a project...</option>
                        <For
                          each={props.projects.filter(
                            (p) => !grantedIds().has(p.id),
                          )}
                        >
                          {(p) => <option value={p.id}>{p.name}</option>}
                        </For>
                      </select>
                      <div class="flex flex-wrap gap-x-3 gap-y-1">
                        <For each={ALL_SCOPES}>
                          {(s) => (
                            <label class="flex items-center gap-1.5 font-mono text-[11px] text-muted">
                              <input
                                type="checkbox"
                                checked={grantScopes().includes(s)}
                                onChange={() => toggleScope(s)}
                                class="accent-accent"
                              />
                              {s}
                            </label>
                          )}
                        </For>
                      </div>
                      <div>
                        <SubmitButton pending={false} disabled={!grantProject()}>
                          Grant
                        </SubmitButton>
                      </div>
                      </form>
                    </Show>
                  </Show>
                </div>

                <div>
                  <h3 class="mb-2 text-[12px] font-semibold">MCP tokens</h3>
                  <ul class="mb-2 flex flex-col gap-1.5">
                    <For
                      each={d().tokens}
                      fallback={
                        <li class="text-[13px] text-muted">No tokens yet.</li>
                      }
                    >
                      {(t: McpTokenMeta) => (
                        <li class="flex items-center gap-2 text-[13px]">
                          <span class="font-medium">{t.name}</span>
                          <span class="text-[11px] text-muted">
                            {t.last_used_at
                              ? `used ${timeAgo(t.last_used_at)}`
                              : "unused"}
                            {" · "}
                            {t.expires_at
                              ? `expires ${new Date(t.expires_at).toLocaleDateString()}`
                              : "never expires"}
                          </span>
                          <span class="flex-1" />
                          <Show when={props.canManage}>
                            <button
                              type="button"
                              class="text-[11px] text-muted hover:text-red-600 dark:hover:text-red-400"
                              onClick={async () => {
                                if (
                                  !(await confirmDestructive({
                                    title: "Revoke token",
                                    body: `Revoke the "${t.name}" token? Any service using it loses access immediately.`,
                                    confirmLabel: "Revoke",
                                  }))
                                )
                                  return;
                                run(() =>
                                  api.revokeAgentToken(props.agent.id, t.id),
                                );
                              }}
                            >
                              revoke
                            </button>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                  <Show when={props.minted}>
                    {(t) => (
                      <div class="mb-2 rounded-md border border-accent bg-surface p-2">
                        <p class="mb-1 text-[11px] font-medium">
                          Token shown once — copy it now:
                        </p>
                        <code class="block break-all font-mono text-[12px]">
                          {t().token}
                        </code>
                        <button
                          type="button"
                          class="mt-1 text-[11px] text-accent"
                          onClick={(e) =>
                            copyText(t().token, e.currentTarget)
                          }
                        >
                          copy
                        </button>
                      </div>
                    )}
                  </Show>
                  <Show when={props.canManage}>
                    <form onSubmit={onMint} class="flex gap-2">
                      <input
                        type="text"
                        name="name"
                        required
                        placeholder="token name"
                        aria-label="Token name"
                        class={inputClass}
                      />
                      <SubmitButton pending={false}>Mint</SubmitButton>
                    </form>
                  </Show>
                </div>
                <Show when={props.canManage}>
                  <div class="border-t border-border pt-3">
                    <button
                      type="button"
                      class="text-[12px] text-red-600 hover:underline dark:text-red-400"
                      onClick={() => setDeleteOpen(true)}
                    >
                      Delete agent
                    </button>
                  </div>
                </Show>
              </>
            )}
          </Show>
          <FormError message={error()} />
        </div>
      </Show>
      <ConfirmDialog
        open={deleteOpen()}
        onOpenChange={setDeleteOpen}
        title={`Delete ${props.agent.name}?`}
        body="Its tokens and project access are revoked immediately; past messages stay."
        confirmLabel="Delete agent"
        onConfirm={() => {
          setDeleteOpen(false);
          void run(() => api.deleteAgent(props.agent.id));
        }}
      />
    </li>
  );
}

function copyText(text: string, el: HTMLButtonElement) {
  // navigator.clipboard is secure-context only; LAN origins need the
  // execCommand fallback.
  const done = () => {
    el.textContent = "copied";
    setTimeout(() => {
      el.textContent = "copy";
    }, 1500);
  };
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).then(done, () => fallback());
  } else {
    fallback();
  }
  function fallback() {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    done();
  }
}

// A fresh invite renders as one self-contained prompt the user pastes into
// the agent: register with the rli_ token, then wire the returned rly_ token
// into MCP config or the CLI.
function InviteCard(props: {
  invite: AgentInvite & { token: string };
  apiBase: string;
  workspaceId: string;
  onRevoked: () => void;
}) {
  const [revokeOpen, setRevokeOpen] = createSignal(false);

  const scopeText = () =>
    props.invite.project_ids.length === 0
      ? "every project in this workspace (including ones created later)"
      : `${props.invite.project_ids.length} project(s)`;

  const promptText = () => `You have been invited to a Relay workspace at ${props.apiBase}.

1. Register yourself with this one-shot invite token (pick any name for yourself):
   curl -sS -X POST ${props.apiBase}/api/agent-invites/redeem \\
     -H "Content-Type: application/json" \\
     -d '{"token":"${props.invite.token}","name":"my-agent","review_mode":"notify"}'
   The response returns a live rly_ MCP token - shown exactly once, keep it secret.

2. Point your MCP client at Relay using that token:
   {"mcpServers":{"relay":{"url":"${props.apiBase}/mcp","headers":{"Authorization":"Bearer <token from step 1>"}}}}
   Or from a terminal instead:
   export RELAY_URL=${props.apiBase}
   export RELAY_TOKEN=$(relay-cli redeem ${props.invite.token} --name my-agent)
   relay-cli projects

Your scopes: ${props.invite.scopes.join(", ")} on ${scopeText()}.
You can set your own profile picture with the set_avatar MCP tool.`;

  return (
    <div class="rounded-md border border-accent bg-surface p-3">
      <div class="mb-2 flex items-center justify-between">
        <p class="text-[12px] font-semibold">
          Invite created - paste this prompt into your agent
        </p>
        <p class="text-[11px] text-muted">
          expires {timeUntil(props.invite.expires_at)}
        </p>
      </div>
      <div class="relative mb-2">
        <pre class="overflow-x-auto whitespace-pre-wrap rounded-md border border-border bg-bg p-2 font-mono text-[11px] leading-relaxed">
          {promptText()}
        </pre>
        <button
          type="button"
          class="absolute right-1.5 top-1.5 rounded bg-surface/80 px-1 text-[11px] text-accent"
          onClick={(e) => copyText(promptText(), e.currentTarget)}
        >
          copy
        </button>
      </div>
      <p class="mb-2 text-[11px] text-muted">
        The agent registers itself - no console setup needed. The invite is
        single-use and expires {timeUntil(props.invite.expires_at)}.
      </p>
      <button
        type="button"
        class="text-[11px] text-muted hover:text-red-600 dark:hover:text-red-400"
        onClick={() => setRevokeOpen(true)}
      >
        revoke invite
      </button>
      <ConfirmDialog
        open={revokeOpen()}
        onOpenChange={setRevokeOpen}
        title="Revoke invite?"
        body="The invite token stops working immediately. Agents that already registered keep their access."
        confirmLabel="Revoke"
        onConfirm={() => {
          setRevokeOpen(false);
          void api
            .deleteAgentInvite(props.workspaceId, props.invite.id)
            .catch(() => {})
            .then(() => props.onRevoked());
        }}
      />
    </div>
  );
}

export default function AgentsSection(props: {
  workspaceId: string;
  canManage: boolean;
}) {
  const [agents, { refetch }] = createResource(
    () => props.workspaceId,
    async (id) => (await api.listAgents(id)).agents,
  );
  const [invites, { refetch: refetchInvites }] = createResource(
    () => props.workspaceId,
    async (id) =>
      props.canManage ? (await api.listAgentInvites(id)).invites : [],
  );
  const [projects] = createResource(
    () => props.workspaceId,
    async () => (await api.listProjects()).projects,
  );
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);
  const [expandedId, setExpandedId] = createSignal<string | null>(null);
  const [mintedTokens, setMintedTokens] = createSignal<
    Record<string, MintedToken>
  >({});
  const [freshInvite, setFreshInvite] = createSignal<
    (AgentInvite & { token: string }) | null
  >(null);
  // Invite options: inviteAll = every workspace project including ones
  // created later; otherwise invitePicked lists the granted set explicitly.
  const [inviteOpen, setInviteOpen] = createSignal(false);
  const [inviteAll, setInviteAll] = createSignal(true);
  const [invitePicked, setInvitePicked] = createSignal<Set<string>>(new Set());
  const [inviteScopes, setInviteScopes] = createSignal<AgentScope[]>([
    ...DEFAULT_INVITE_SCOPES,
  ]);

  // Prefer the configured server URL over the page origin: the desktop app
  // serves the SPA from wails.localhost while talking to a real server.
  const apiBase = () => net.serverUrl() || window.location.origin;

  const inviteProjectIds = () => {
    if (inviteAll()) return undefined; // every project, present and future
    return [...invitePicked()];
  };

  function toggleInviteProject(id: string) {
    setInvitePicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleInviteScope(s: AgentScope) {
    setInviteScopes((cur) =>
      cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s],
    );
  }

  async function onInvite(e: SubmitEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const scopes = inviteScopes();
      setFreshInvite(
        await api.createAgentInvite(props.workspaceId, {
          project_ids: inviteProjectIds(),
          // empty list means "server default" on the wire — only send a
          // narrowed set when the user actually unchecked something
          scopes:
            scopes.length === DEFAULT_INVITE_SCOPES.length &&
            DEFAULT_INVITE_SCOPES.every((s) => scopes.includes(s))
              ? undefined
              : scopes,
        }),
      );
      setInviteOpen(false);
      await refetchInvites();
    } catch (err) {
      setError(errorMessage(err, "Could not create invite"));
    } finally {
      setPending(false);
    }
  }

  const pendingInvites = () =>
    (invites() ?? []).filter(
      (i) => !i.used_by && new Date(i.expires_at) > new Date(),
    );
  const [revokingInvite, setRevokingInvite] =
    createSignal<AgentInvite | null>(null);

  return (
    <div class="flex flex-col gap-4">
      <ul class="divide-y divide-border rounded-md border border-border">
        <For
          each={agents()}
          fallback={
            <li class="px-3 py-2.5 text-[13px] text-muted">
              {agents.state === "errored"
                ? "Could not load agents"
                : "No agents yet. Invite one below - it registers itself."}
            </li>
          }
        >
          {(a) => (
            <AgentRow
              agent={a}
              projects={projects() ?? []}
              canManage={props.canManage}
              expanded={expandedId() === a.id}
              minted={mintedTokens()[a.id]}
              onMinted={(t) =>
                setMintedTokens((cur) => ({ ...cur, [a.id]: t }))
              }
              onToggle={() =>
                setExpandedId((cur) => (cur === a.id ? null : a.id))
              }
              onChanged={() => refetch()}
            />
          )}
        </For>
      </ul>

      <Show when={props.canManage}>
        <Show when={freshInvite()}>
          {(inv) => (
            <InviteCard
              invite={inv()}
              apiBase={apiBase()}
              workspaceId={props.workspaceId}
              onRevoked={() => {
                setFreshInvite(null);
                void refetchInvites();
              }}
            />
          )}
        </Show>

        <Show when={pendingInvites().length > 0}>
          <div>
            <h3 class="mb-1.5 text-[12px] font-semibold">Open invites</h3>
            <ul class="flex flex-col gap-1.5">
              <For each={pendingInvites()}>
                {(i) => {
                  const projNames = () =>
                    i.project_ids
                      .map((id) => projects()?.find((p) => p.id === id)?.name)
                      .filter((n): n is string => !!n);
                  const allProjects = () => i.project_ids.length === 0;
                  const scopes = () =>
                    i.scopes.length === 0 ? DEFAULT_INVITE_SCOPES : i.scopes;
                  return (
                    <li class="rounded-lg border border-border bg-surface px-3 py-2">
                      <div class="flex items-center gap-2">
                        <span class="font-mono text-[11px] text-faint">
                          #{i.id.slice(0, 8)}
                        </span>
                        <span class="min-w-0 flex-1 truncate text-[12.5px] text-fg">
                          {allProjects()
                            ? "All workspace projects — current and future"
                            : projNames().length > 0
                              ? projNames().join(", ")
                              : `${i.project_ids.length} project(s)`}
                        </span>
                        <Tip
                          text={`Expires ${new Date(i.expires_at).toLocaleString()}`}
                          side="top"
                        >
                          <span class="shrink-0 rounded-full border border-accent/40 bg-accent-soft/60 px-1.5 py-px font-mono text-[10px] text-accent-ink">
                            {timeUntil(i.expires_at)} left
                          </span>
                        </Tip>
                        <button
                          type="button"
                          class="shrink-0 rounded px-1.5 py-0.5 text-[11.5px] text-muted transition-colors hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
                          onClick={() => setRevokingInvite(i)}
                        >
                          Revoke
                        </button>
                      </div>
                      <div class="mt-1 flex flex-wrap items-center gap-1">
                        <For each={scopes()}>
                          {(s) => (
                            <span class="rounded bg-surface-2 px-1.5 py-px font-mono text-[10px] text-muted">
                              {s}
                            </span>
                          )}
                        </For>
                      </div>
                      <p class="mt-1 text-[11px] text-faint">
                        <Show when={i.created_by} fallback="Created">
                          Created by {i.created_by}
                        </Show>{" "}
                        {timeAgo(i.created_at)} · single-use · agent registers
                        itself with the token
                      </p>
                    </li>
                  );
                }}
              </For>
            </ul>
          </div>
        </Show>
        <ConfirmDialog
          open={revokingInvite() !== null}
          onOpenChange={(o) => {
            if (!o) setRevokingInvite(null);
          }}
          title="Revoke invite?"
          body="The invite token stops working immediately. Agents that already registered keep their access."
          confirmLabel="Revoke"
          onConfirm={() => {
            const i = revokingInvite();
            setRevokingInvite(null);
            if (i) {
              void api
                .deleteAgentInvite(props.workspaceId, i.id)
                .catch(() => {})
                .then(() => refetchInvites());
            }
          }}
        />

        <div class="max-w-lg">
          <Show
            when={inviteOpen()}
            fallback={
              <SubmitButton type="button" onClick={() => setInviteOpen(true)}>
                Invite agent
              </SubmitButton>
            }
          >
            <form
              onSubmit={onInvite}
              class="flex flex-col gap-3 rounded-md border border-border p-3"
            >
              <div>
                <h3 class="mb-1.5 text-[12px] font-semibold">Projects</h3>
                <div class="flex flex-col gap-1.5">
                  <label class="flex items-center gap-1.5 text-[12px]">
                    <input
                      type="radio"
                      name="invite-projects"
                      checked={inviteAll()}
                      onChange={() => setInviteAll(true)}
                      class="accent-accent"
                    />
                    All projects
                    <span class="text-[11px] text-muted">
                      - including ones created later
                    </span>
                  </label>
                  <label class="flex items-center gap-1.5 text-[12px]">
                    <input
                      type="radio"
                      name="invite-projects"
                      checked={!inviteAll()}
                      onChange={() => setInviteAll(false)}
                      class="accent-accent"
                    />
                    Only the projects checked below
                  </label>
                  <Show when={!inviteAll()}>
                    <div class="flex flex-wrap gap-x-3 gap-y-1 pl-5 pt-0.5">
                      <For each={projects() ?? []}>
                        {(p) => (
                          <label class="flex items-center gap-1.5 text-[12px]">
                            <input
                              type="checkbox"
                              checked={invitePicked().has(p.id)}
                              onChange={() => toggleInviteProject(p.id)}
                              class="accent-accent"
                            />
                            {p.name}
                          </label>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </div>
              <div>
                <h3 class="mb-1.5 text-[12px] font-semibold">Permissions</h3>
                <div class="flex flex-wrap gap-x-3 gap-y-1">
                  <For each={ALL_SCOPES}>
                    {(s) => (
                      <label class="flex items-center gap-1.5 font-mono text-[11px] text-muted">
                        <input
                          type="checkbox"
                          checked={inviteScopes().includes(s)}
                          onChange={() => toggleInviteScope(s)}
                          class="accent-accent"
                        />
                        {s}
                      </label>
                    )}
                  </For>
                </div>
              </div>
              <div class="flex items-center gap-2">
                <SubmitButton
                  pending={pending()}
                  disabled={
                    inviteProjectIds()?.length === 0 ||
                    inviteScopes().length === 0
                  }
                >
                  {pending() ? "Creating invite..." : "Create invite"}
                </SubmitButton>
                <button
                  type="button"
                  class="text-[12px] text-muted hover:text-fg"
                  onClick={() => setInviteOpen(false)}
                >
                  cancel
                </button>
              </div>
            </form>
          </Show>
          <p class="mt-1.5 text-[11px] text-muted">
            The agent registers itself with the invite - it picks its own name
            and receives a working MCP token. No manual setup on your side.
          </p>
          <FormError message={error()} />
        </div>
      </Show>
    </div>
  );
}
