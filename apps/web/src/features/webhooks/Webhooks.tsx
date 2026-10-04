// Outbound webhook management for a project. Agents point their listener
// here; Relay POSTs a signed event envelope for each matching domain event.
import type { WebhookDelivery, WebhookSubscription } from "@relay/api-client";
import { createResource, createSignal, For, Show } from "solid-js";
import { ConfirmDialog, FormError, inputClass, Spinner } from "../../components/ui";
import { api } from "../../lib/api";
import { net } from "../../lib/net";
import { timeAgo } from "../../lib/time";

function Deliveries(props: { webhookId: string }) {
  const [rows] = createResource(
    () => props.webhookId,
    (id) => api.webhookDeliveries(id).then((r) => r.deliveries),
  );
  return (
    <ul class="mt-2 divide-y divide-border rounded-md border border-border text-[12px]">
      <For
        each={rows()}
        fallback={
          <li class="px-3 py-2.5 text-muted">
            {rows.loading ? "Loading…" : "No deliveries yet"}
          </li>
        }
      >
        {(d: WebhookDelivery) => (
          <li class="flex items-center gap-3 px-3 py-2">
            <span
              class={`h-1.5 w-1.5 shrink-0 rounded-full ${
                d.success ? "bg-emerald-500" : "bg-red-500"
              }`}
            />
            <span class="font-mono text-[11px]">{d.event_type}</span>
            <span class="text-muted">
              {d.status_code ?? "—"} · {d.attempts}{" "}
              {d.attempts === 1 ? "attempt" : "attempts"} · {d.duration_ms}ms
            </span>
            <span class="ml-auto shrink-0 text-[11px] text-muted">
              {timeAgo(d.created_at)}
            </span>
          </li>
        )}
      </For>
    </ul>
  );
}

function WebhookRow(props: {
  w: WebhookSubscription;
  onChanged: () => void;
}) {
  const [showDeliveries, setShowDeliveries] = createSignal(false);
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const [err, setErr] = createSignal("");
  const w = () => props.w;

  const toggle = async () => {
    try {
      await api.updateWebhook(w().id!, { active: !w().active });
      props.onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "update failed");
    }
  };
  const remove = async () => {
    setConfirmDelete(false);
    try {
      await api.deleteWebhook(w().id!);
      props.onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "delete failed");
    }
  };
  const test = async () => {
    try {
      await api.testWebhook(w().id!);
      setShowDeliveries(true);
      setTimeout(() => props.onChanged(), 800);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "test failed");
    }
  };

  return (
    <li class="rounded-md border border-border px-3 py-2.5">
      <div class="flex items-center gap-2.5">
        <span
          class={`h-1.5 w-1.5 shrink-0 rounded-full ${
            w().active ? "bg-emerald-500" : "bg-muted/40"
          }`}
        />
        <span class="min-w-0 flex-1 truncate font-mono text-[12px]">
          {w().url}
        </span>
        <span class="shrink-0 font-mono text-[10px] text-muted">
          {w().secret_hint}
        </span>
      </div>
      <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
        <For each={w().events}>
          {(e) => (
            <span class="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted">
              {e}
            </span>
          )}
        </For>
        <span class="ml-auto" />
        <button
          type="button"
          onClick={test}
          class="text-[11.5px] text-muted transition-colors hover:text-fg"
        >
          Send test
        </button>
        <button
          type="button"
          onClick={() => setShowDeliveries(!showDeliveries())}
          class="text-[11.5px] text-muted transition-colors hover:text-fg"
        >
          {showDeliveries() ? "Hide deliveries" : "Deliveries"}
        </button>
        <button
          type="button"
          onClick={toggle}
          class="text-[11.5px] text-muted transition-colors hover:text-fg"
        >
          {w().active ? "Disable" : "Enable"}
        </button>
        <button
          type="button"
          onClick={() => setConfirmDelete(true)}
          class="text-[11.5px] text-red-500/80 transition-colors hover:text-red-500"
        >
          Delete
        </button>
      </div>
      <FormError message={err()} />
      <Show when={showDeliveries()}>
        <Deliveries webhookId={w().id!} />
      </Show>
      <ConfirmDialog
        open={confirmDelete()}
        onOpenChange={setConfirmDelete}
        title="Delete webhook"
        body={`Delete the webhook for ${w().url}? Deliveries stop immediately; history stays.`}
        confirmLabel="Delete"
        onConfirm={() => void remove()}
      />
    </li>
  );
}

export function WebhooksSection(props: { projectId: string }) {
  const [data, { refetch }] = createResource(
    () => props.projectId,
    (id) => api.listWebhooks(id),
  );
  // Prefill with this server's base URL — most hooks land back on it.
  const [url, setUrl] = createSignal(
    (net.serverUrl() || window.location.origin) + "/",
  );
  // Sensible defaults pre-picked — everything except wildcard; users toggle.
  const [picked, setPicked] = createSignal<string[]>([
    "message.created",
    "issue.created",
    "issue.updated",
    "todo.created",
    "todo.updated",
    "review.created",
    "review.responded",
    "attachment.created",
  ]);
  const [secret, setSecret] = createSignal("");
  const [err, setErr] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const toggleEvent = (e: string) =>
    setPicked((p) =>
      p.includes(e) ? p.filter((x) => x !== e) : [...p, e],
    );
  const groupEvents = () => {
    const cat = data()?.catalog ?? [];
    const groups: Record<string, string[]> = {};
    for (const e of cat) {
      const g = e.split(".")[0]!;
      (groups[g] ??= []).push(e);
    }
    return groups;
  };

  const create = async (managed: boolean) => {
    setErr("");
    setBusy(true);
    try {
      const w = await api.createWebhook(props.projectId, {
        url: managed ? undefined : url().trim(),
        events: picked(),
        relay_managed: managed || undefined,
      });
      setSecret(w.secret ?? "");
      if (!managed) setUrl("");
      refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "create failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto w-full max-w-2xl px-6 py-6">
        <h2 class="text-[13px] font-semibold">Outbound webhooks</h2>
        <p class="mt-1 text-[12px] text-muted">
          Agents and external services subscribe here. Relay POSTs a signed
          JSON envelope (<code class="font-mono">X-Relay-Signature-256</code>)
          for each matching event.
        </p>

        <Show when={secret()}>
          <div class="mt-3 rounded-md border border-amber-500/40 bg-amber-500/[0.06] px-3 py-2.5">
            <p class="text-[11px] font-medium uppercase tracking-wider text-amber-600 dark:text-amber-400">
              Signing secret — shown once, store it now
            </p>
            <p class="mt-1 select-all break-all font-mono text-[12px]">
              {secret()}
            </p>
          </div>
        </Show>

        <ul class="mt-4 flex flex-col gap-2">
          <Show when={data.state === "ready"} fallback={<Spinner />}>
            <For
              each={data()!.webhooks}
              fallback={
                <li class="rounded-md border border-dashed border-border px-4 py-6 text-center text-[12.5px] text-muted">
                  No subscriptions — add a URL and pick events below.
                </li>
              }
            >
              {(w) => <WebhookRow w={w} onChanged={refetch} />}
            </For>
          </Show>
        </ul>

        <h3 class="mb-2 mt-6 text-[12px] font-semibold uppercase tracking-wider text-muted">
          New subscription
        </h3>

        {/* Event scopes first — a managed listener needs nothing else. */}
        <Show when={data()?.catalog}>
          <div class="mt-1 flex flex-col gap-2">
            <For each={Object.entries(groupEvents())}>
              {([group, events]) => (
                <div class="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      setPicked((p) =>
                        events.every((e) => p.includes(e))
                          ? p.filter((x) => !events.includes(x))
                          : [...new Set([...p, ...events])],
                      )
                    }
                    class="w-24 shrink-0 rounded-md border border-border px-2 py-1 text-left font-mono text-[11px] font-semibold text-muted transition-colors hover:text-fg"
                  >
                    {group}.*
                  </button>
                  <For each={events}>
                    {(e) => (
                      <label
                        class={`flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px] transition-colors ${
                          picked().includes(e)
                            ? "border-accent/50 bg-accent/10 text-fg"
                            : "border-border text-muted hover:text-fg"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={picked().includes(e)}
                          onChange={() => toggleEvent(e)}
                          class="sr-only"
                        />
                        {e}
                      </label>
                    )}
                  </For>
                </div>
              )}
            </For>
            <label
              class={`flex w-fit cursor-pointer items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px] transition-colors ${
                picked().includes("*")
                  ? "border-amber-500/50 bg-amber-500/10 text-fg"
                  : "border-border text-muted hover:text-fg"
              }`}
              title="Subscribe to every current and future event type"
            >
              <input
                type="checkbox"
                checked={picked().includes("*")}
                onChange={() => toggleEvent("*")}
                class="sr-only"
              />
              * (all events)
            </label>
          </div>
        </Show>

        <div class="mt-4 flex items-start gap-2">
          <input
            class={`${inputClass} flex-1`}
            placeholder="https://agent.example.com/relay/events"
            value={url()}
            onInput={(e) => setUrl(e.currentTarget.value)}
          />
          <button
            type="button"
            disabled={busy() || !url().trim() || picked().length === 0}
            onClick={() => void create(false)}
            class="h-[34px] shrink-0 rounded-md bg-accent px-3 text-[12.5px] font-medium text-white transition-opacity disabled:opacity-40"
          >
            {busy() ? "Creating…" : "Subscribe"}
          </button>
        </div>
        <p class="mt-1.5 text-[11.5px] text-muted">
          Or{" "}
          <button
            type="button"
            disabled={busy() || picked().length === 0}
            onClick={() => void create(true)}
            class="font-medium text-accent hover:underline disabled:opacity-40"
          >
            create a Relay-hosted test listener
          </button>{" "}
          — no URL needed; signed deliveries appear under Deliveries.
        </p>
        <FormError message={err()} />
      </div>
    </div>
  );
}
