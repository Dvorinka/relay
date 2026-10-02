import {
  ApiClientError,
  type Agent,
  type AgentScope,
  type McpTokenMeta,
  type MintedToken,
  type Project,
} from "@relay/api-client";
import { createResource, createSignal, For, Show } from "solid-js";
import {
  Field,
  FormError,
  SubmitButton,
  inputClass,
} from "../../components/ui";
import { api } from "../../lib/api";
import { timeAgo } from "../../lib/time";

const ALL_SCOPES: AgentScope[] = [
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
              src={url()}
              alt=""
              class="h-7 w-7 shrink-0 rounded-md border border-border object-cover"
            />
          )}
        </Show>
        <div class="min-w-0 flex-1">
          <p class="truncate text-[13px] font-medium">{props.agent.name}</p>
          <p class="truncate font-mono text-[11px] text-muted">
            @{props.agent.slug}
          </p>
        </div>
        <Show when={props.agent.review_mode === "gate"}>
          <span
            class="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
            title="Agent must wait for a human verdict on each submitted review"
          >
            review-gated
          </span>
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
                            src={url()}
                            alt=""
                            class="h-9 w-9 rounded-md border border-border object-cover"
                          />
                        )}
                      </Show>
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/gif,image/webp"
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
                              onClick={() =>
                                run(() =>
                                  api.revokeAgentProject(
                                    props.agent.id,
                                    g.project_id,
                                  ),
                                )
                              }
                            >
                              revoke
                            </button>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                  <Show when={props.canManage}>
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
                        <SubmitButton pending={false}>Grant</SubmitButton>
                      </div>
                    </form>
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
                          </span>
                          <span class="flex-1" />
                          <Show when={props.canManage}>
                            <button
                              type="button"
                              class="text-[11px] text-muted hover:text-red-600 dark:hover:text-red-400"
                              onClick={() =>
                                run(() =>
                                  api.revokeAgentToken(props.agent.id, t.id),
                                )
                              }
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
                          onClick={() => navigator.clipboard.writeText(t().token)}
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
              </>
            )}
          </Show>
          <FormError message={error()} />
        </div>
      </Show>
    </li>
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

  async function onCreate(e: SubmitEvent) {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    setError(null);
    setPending(true);
    try {
      const slug = String(data.get("slug") ?? "").trim();
      await api.createAgent(props.workspaceId, {
        name: String(data.get("name") ?? "").trim(),
        ...(slug ? { slug } : {}),
        description: String(data.get("description") ?? "").trim(),
        review_mode:
          String(data.get("review_mode") ?? "notify") === "gate"
            ? "gate"
            : "notify",
      });
      form.reset();
      await refetch();
    } catch (err) {
      setError(
        err instanceof ApiClientError && err.status === 409
          ? "That slug is taken in this workspace"
          : errorMessage(err, "Could not create agent"),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div class="flex flex-col gap-4">
      <ul class="divide-y divide-border rounded-md border border-border">
        <For
          each={agents()}
          fallback={
            <li class="px-3 py-2.5 text-[13px] text-muted">
              {agents.state === "errored"
                ? "Could not load agents"
                : "No agents yet. Agents connect through MCP with scoped tokens."}
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
        <form onSubmit={onCreate} class="flex max-w-sm flex-col gap-3">
          <Field label="Agent name">
            <input type="text" name="name" required class={inputClass} />
          </Field>
          <div class="flex gap-2">
            <Field label="Slug (optional)">
              <input
                type="text"
                name="slug"
                pattern="[a-z0-9-]+"
                class={inputClass}
              />
            </Field>
            <Field label="Description">
              <input type="text" name="description" class={inputClass} />
            </Field>
          </div>
          <Field label="Review mode">
            <select name="review_mode" class={inputClass}>
              <option value="notify">
                Notify - agent reports after finishing work
              </option>
              <option value="gate">
                Gate - agent waits for your approval on each review
              </option>
            </select>
          </Field>
          <FormError message={error()} />
          <div>
            <SubmitButton pending={pending()}>
              {pending() ? "Creating..." : "New agent"}
            </SubmitButton>
          </div>
        </form>
      </Show>
    </div>
  );
}
