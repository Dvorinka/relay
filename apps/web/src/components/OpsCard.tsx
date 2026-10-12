import { For, Show, type JSX } from "solid-js";

// Structured intake/ops payloads — inbound-hook posts can carry
// service/state/level/… (stored on messages.meta) and render as cards
// instead of plain text. The shapes are intentionally open: Relay knows a
// few well-known keys and passes the rest through `fields` untouched.

export type OpsMeta = {
  kind?: string;
  service?: string;
  state?: string;
  latency_ms?: number;
  level?: string;
  env?: string;
  release?: string;
  url?: string;
  at?: string;
  fields?: Record<string, string>;
};

export function opsMetaOf(msg: { meta?: unknown }): OpsMeta | null {
  const m = msg.meta;
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const meta = m as Record<string, unknown>;
  // a lone kind tag isn't a card — need one real data point
  const keys = Object.keys(meta).filter((k) => k !== "kind" && meta[k] != null);
  if (keys.length === 0) return null;
  return meta as OpsMeta;
}

type Tone = "ok" | "warn" | "bad" | "idle" | "neutral";

export function stateTone(state?: string): Tone {
  switch ((state ?? "").toLowerCase()) {
    case "up":
    case "ok":
    case "operational":
    case "healthy":
    case "resolved":
      return "ok";
    case "degraded":
    case "warn":
    case "warning":
      return "warn";
    case "down":
    case "outage":
    case "critical":
    case "crit":
    case "fatal":
      return "bad";
    case "maintenance":
      return "idle";
    default:
      return "neutral";
  }
}

export function levelTone(level?: string): Tone {
  switch ((level ?? "").toLowerCase()) {
    case "debug":
    case "trace":
      return "idle";
    case "info":
    case "notice":
      return "neutral";
    case "warn":
    case "warning":
      return "warn";
    case "error":
    case "fatal":
    case "crit":
      return "bad";
    default:
      return "neutral";
  }
}

// kind drives the card accent when no explicit state/level exists
function kindTone(kind?: string): Tone {
  switch ((kind ?? "").toLowerCase()) {
    case "status":
    case "uptime":
    case "metric":
      return "ok";
    case "error":
    case "incident":
    case "outage":
    case "alert":
    case "bug":
      return "bad";
    case "deploy":
    case "ci":
    case "release":
      return "idle";
    case "log":
      return "idle";
    default:
      return "neutral";
  }
}

export function opsTone(meta: OpsMeta): Tone {
  if (meta.state) return stateTone(meta.state);
  if (meta.level) return levelTone(meta.level);
  return kindTone(meta.kind);
}

const toneClasses: Record<Tone, { frame: string; dot: string; pill: string }> = {
  ok: {
    frame: "border-emerald-500/60 bg-emerald-500/5",
    dot: "bg-emerald-500",
    pill: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
  warn: {
    frame: "border-amber-500/60 bg-amber-500/5",
    dot: "bg-amber-500",
    pill: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  },
  bad: {
    frame: "border-red-500/60 bg-red-500/5",
    dot: "bg-red-500",
    pill: "bg-red-500/15 text-red-600 dark:text-red-400",
  },
  idle: {
    frame: "border-sky-500/60 bg-sky-500/5",
    dot: "bg-sky-500",
    pill: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  },
  neutral: {
    frame: "border-faint/60 bg-hover/40",
    dot: "bg-faint",
    pill: "bg-hover text-muted",
  },
};

export function opsFrameCls(meta: OpsMeta): string {
  return toneClasses[opsTone(meta)].frame;
}
export function opsDotCls(tone: Tone): string {
  return toneClasses[tone].dot;
}
export function opsPillCls(tone: Tone): string {
  return toneClasses[tone].pill;
}

// OpsBanner — the structured head of a meta-carrying message: kind label,
// service, state/level pill, latency, env/release chips. The markdown body
// renders under it, unchanged.
export function OpsBanner(props: { meta: OpsMeta }): JSX.Element {
  const tone = () => opsTone(props.meta);
  const fieldEntries = () =>
    Object.entries(props.meta.fields ?? {}).slice(0, 8);
  return (
    <div class="select-none">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Show when={props.meta.kind}>
          <span class="font-mono text-[10px] font-semibold uppercase tracking-wider text-muted">
            {props.meta.kind}
          </span>
        </Show>
        <Show when={props.meta.service}>
          <span class="text-[12.5px] font-semibold text-fg">
            {props.meta.service}
          </span>
        </Show>
        <Show when={props.meta.state}>
          <span
            class={`inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${toneClasses[tone()].pill}`}
          >
            <span class={`h-1.5 w-1.5 rounded-full ${toneClasses[tone()].dot}`} />
            {props.meta.state}
          </span>
        </Show>
        <Show when={props.meta.level && !props.meta.state}>
          <span
            class={`inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${toneClasses[levelTone(props.meta.level)].pill}`}
          >
            {props.meta.level}
          </span>
        </Show>
        <Show when={props.meta.latency_ms != null}>
          <span class="font-mono text-[10.5px] text-muted">
            {props.meta.latency_ms}ms
          </span>
        </Show>
        <Show when={props.meta.env}>
          <span class="rounded bg-hover px-1 py-px font-mono text-[9.5px] text-muted">
            {props.meta.env}
          </span>
        </Show>
        <Show when={props.meta.release}>
          <span class="rounded bg-hover px-1 py-px font-mono text-[9.5px] text-muted">
            {props.meta.release}
          </span>
        </Show>
        <Show when={props.meta.url}>
          {(u) => (
            <a
              href={u()}
              target="_blank"
              rel="noopener noreferrer"
              class="text-[10.5px] font-medium text-accent hover:underline"
            >
              source ↗
            </a>
          )}
        </Show>
      </div>
      <Show when={fieldEntries().length > 0}>
        <dl class="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <For each={fieldEntries()}>
            {([k, v]) => (
              <>
                <dt class="font-mono text-[10px] leading-5 text-faint">{k}</dt>
                <dd class="truncate font-mono text-[11px] leading-5 text-muted">
                  {v}
                </dd>
              </>
            )}
          </For>
        </dl>
      </Show>
    </div>
  );
}
