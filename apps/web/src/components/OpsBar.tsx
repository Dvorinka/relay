import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import type { OpsSummary } from "@relay/api-client";
import { api } from "../lib/api";
import { subscribe } from "../lib/events";
import { opsDotCls, opsPillCls, stateTone } from "./OpsCard";
import { PulseIcon } from "./icons";

// OpsBar — the control-center strip atop an intake_mode="ops" channel:
// live service pills (worst first), a 30-day uptime strip, per-kind event
// counts. Refetches when a meta post lands in this channel.

type Day = { date?: string; worst?: string; events?: number };
type Service = {
  service?: string;
  state?: string;
  latency_ms?: number;
  env?: string;
  at?: string;
  message_id?: string;
};

function dayTone(d: Day): string {
  const w = (d.worst ?? "no_data").toLowerCase();
  if (w === "no_data") return "bg-faint/25";
  return `${opsDotCls(stateTone(w))} opacity-80`;
}

function rel(ts?: string | null): string {
  if (!ts) return "";
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function OpsBar(props: {
  conversationId: string;
  projectId: string;
  onSetup?: () => void;
}) {
  const [tick, setTick] = createSignal(0);
  const unsub = subscribe((e) => {
    if (
      e.type === "message.created" &&
      e.data?.conversation_id === props.conversationId
    ) {
      // meta posts shift the board; plain chatter doesn't
      const msg = e.data.message as { meta?: unknown } | undefined;
      if (msg?.meta) setTick((t) => t + 1);
    }
    if (e.type === "stream.resync") setTick((t) => t + 1);
  });
  onCleanup(unsub);
  const [summary] = createResource(
    () => [props.conversationId, tick()] as const,
    ([id]) => api.opsSummary(id).catch(() => null),
  );

  const data = () => (summary() ?? null) as OpsSummary | null;
  const services = () => (data()?.services ?? []) as Service[];
  const days = () => (data()?.days ?? []) as Day[];
  const kinds = () => Object.entries(data()?.kinds ?? {});
  const empty = () =>
    summary.state === "ready" && services().length === 0 && days().every(
      (d) => (d.events ?? 0) === 0,
    );

  return (
    <div class="border-b border-border bg-bg/60 px-3 py-2 sm:px-4">
      <div class="flex items-center gap-2">
        <PulseIcon class="h-3.5 w-3.5 text-accent" />
        <span class="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Ops
        </span>
        <Show when={data()?.last_event_at}>
          <span class="text-[10.5px] text-faint">
            last event {rel(data()?.last_event_at)}
          </span>
        </Show>
        <div class="ml-auto flex items-center gap-2">
          <For each={kinds()}>
            {([k, n]) => (
              <span class="rounded-full bg-hover px-1.5 py-px font-mono text-[9.5px] text-muted">
                {k} {n}
              </span>
            )}
          </For>
        </div>
      </div>
      <Show when={services().length > 0}>
        <div class="mt-1.5 flex flex-wrap gap-1.5">
          <For each={services()}>
            {(s) => (
              <span
                class={`inline-flex items-center gap-1.5 rounded-full border border-border bg-bg px-2 py-0.5 text-[11px] font-medium text-fg`}
                title={s.at ? `updated ${new Date(s.at).toLocaleString()}` : ""}
              >
                <span
                  class={`h-1.5 w-1.5 rounded-full ${opsDotCls(stateTone(s.state))}`}
                />
                {s.service}
                <span
                  class={`rounded-full px-1 py-px text-[9px] font-semibold uppercase ${opsPillCls(stateTone(s.state))}`}
                >
                  {s.state}
                </span>
                <Show when={s.latency_ms}>
                  <span class="font-mono text-[9.5px] text-faint">
                    {s.latency_ms}ms
                  </span>
                </Show>
                <Show when={s.env}>
                  <span class="font-mono text-[9px] text-faint">{s.env}</span>
                </Show>
              </span>
            )}
          </For>
        </div>
      </Show>
      <Show when={days().length > 0}>
        <div
          class="mt-1.5 flex h-3 items-stretch gap-px overflow-hidden rounded"
          title="30 days — color is the day's worst reported state"
        >
          <For each={days()}>
            {(d) => (
              <div
                class={`flex-1 ${dayTone(d)}`}
                title={`${d.date} — ${d.worst ?? "no data"}${d.events ? ` · ${d.events} events` : ""}`}
              />
            )}
          </For>
        </div>
      </Show>
      <Show when={empty()}>
        <p class="mt-1.5 text-[11.5px] text-muted">
          No signals yet — point an inbound hook at this channel and POST{" "}
          <code class="rounded bg-hover px-1 font-mono text-[10px]">
            {"{kind, service, state, latency_ms}"}
          </code>{" "}
          from any monitor.{" "}
          <button
            type="button"
            class="font-medium text-accent hover:underline"
            onClick={() => props.onSetup?.()}
          >
            Setup guide
          </button>
        </p>
      </Show>
    </div>
  );
}
