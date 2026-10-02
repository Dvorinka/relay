// Outbound webhook management for a project. Agents point their listener
// here; Relay POSTs a signed event envelope for each matching domain event.
import type { WebhookDelivery, WebhookSubscription } from "@relay/api-client";
import { createResource, createSignal, For, Show } from "solid-js";
import { FormError, inputClass, Spinner } from "../../components/ui";
import { api } from "../../lib/api";
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
    if (!confirm(`Delete webhook for ${w().url}?`)) return;
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
          onClick={remove}
          class="text-[11.5px] text-red-500/80 transition-colors hover:text-red-500"
        >
          Delete
        </button>
      </div>
      <FormError message={err()} />
      <Show when={showDeliveries()}>
        <Deliveries webhookId={w().id!} />
      </Show>
    </li>
  );
}

export function WebhooksSection(props: { projectId: string }) {
  const [data, { refetch }] = createResource(
    () => props.projectId,
    (id) => api.listWebhooks(id),
  );
  const [url, setUrl] = createSignal("");
  const [picked, setPicked] = createSignal<string[]>([]);
  const [secret, setSecret] = createSignal("");
  const [err, setErr] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const toggleEvent = (e: string) =>
    setPicked((p) =>
      p.includes(e) ? p.filter((x) => x !== e) : [...p, e],
    );

  const create = async () => {
    setErr("");
    setBusy(true);
    try {
      const w = await api.createWebhook(props.projectId, {
        url: url().trim(),
        events: picked(),
      });
      setSecret(w.secret ?? "");
      setUrl("");
      setPicked([]);
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
        <input
          class={inputClass}
          placeholder="https://agent.example.com/relay/events"
          value={url()}
          onInput={(e) => setUrl(e.currentTarget.value)}
        />
        <Show when={data()?.catalog}>
          {(cat) => (
            <div class="mt-2 flex flex-wrap gap-1.5">
              <For each={["*", ...cat()]}>
                {(e) => (
                  <button
                    type="button"
                    onClick={() => toggleEvent(e)}
                    class={`rounded-md border px-2 py-1 font-mono text-[11px] transition-colors ${
                      picked().includes(e)
                        ? "border-accent/50 bg-accent/10 text-fg"
                        : "border-border text-muted hover:text-fg"
                    }`}
                  >
                    {e}
                  </button>
                )}
              </For>
            </div>
          )}
        </Show>
        <button
          type="button"
          disabled={busy() || !url().trim() || picked().length === 0}
          onClick={create}
          class="mt-3 rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white transition-opacity disabled:opacity-40"
        >
          {busy() ? "Creating…" : "Subscribe"}
        </button>
        <FormError message={err()} />
      </div>
    </div>
  );
}
