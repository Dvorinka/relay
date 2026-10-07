import type {
  Issue,
  IssuePriority,
  IssueStatus,
  Label,
  StatusDef,
} from "@relay/api-client";
import { Show } from "solid-js";
import { Tip } from "../../components/ui";

// Built-in lanes — mirrors internal/statuses.Defaults(). Custom project
// lanes arrive on Project.statuses.
export const DEFAULT_STATUSES: StatusDef[] = [
  { id: "backlog", label: "Backlog", color: "#78716c" },
  { id: "todo", label: "To do", color: "#0891b2" },
  { id: "in_progress", label: "In progress", color: "#d97706" },
  { id: "review", label: "In review", color: "#7c3aed" },
  { id: "other", label: "Other", color: "#64748b" },
  { id: "done", label: "Done", color: "#059669", closed: true },
  { id: "cancelled", label: "Canceled", color: "#dc2626", closed: true },
];

export const ISSUE_STATUSES: IssueStatus[] = DEFAULT_STATUSES.map(
  (s) => s.id,
);

/** The project's lanes; defaults when the project carries none. */
export function statusDefs(p?: {
  statuses?: StatusDef[] | null;
}): StatusDef[] {
  return p?.statuses && p.statuses.length > 0
    ? p.statuses
    : DEFAULT_STATUSES;
}

/** Resolve a status id to its def; unknown ids get a neutral placeholder. */
export function statusDef(defs: StatusDef[], id: string): StatusDef {
  return (
    defs.find((d) => d.id === id) ?? {
      id,
      label: id.replace(/[_-]/g, " "),
      color: "#78716c",
    }
  );
}

export function statusLabel(id: string, defs?: StatusDef[]): string {
  return statusDef(defs ?? DEFAULT_STATUSES, id).label;
}

export function statusColor(id: string, defs?: StatusDef[]): string {
  return statusDef(defs ?? DEFAULT_STATUSES, id).color;
}

export function isClosed(id: string, defs?: StatusDef[]): boolean {
  return statusDef(defs ?? DEFAULT_STATUSES, id).closed === true;
}

export const ISSUE_PRIORITIES: IssuePriority[] = [
  "none",
  "urgent",
  "high",
  "medium",
  "low",
];

export const PRIORITY_LABEL: Record<IssuePriority, string> = {
  none: "None",
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export function StatusDot(props: {
  status: string;
  defs?: StatusDef[];
  class?: string;
}) {
  return (
    <span
      class={`inline-block rounded-full ${props.class ?? "h-2 w-2"}`}
      style={{ "background-color": statusColor(props.status, props.defs) }}
    />
  );
}
const PRIORITY_BARS: Record<IssuePriority, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  urgent: 3,
};

/** Three-bar signal glyph; urgent fills all bars in red. */
export function PriorityGlyph(props: {
  priority: IssuePriority;
  class?: string;
}) {
  const filled = () => PRIORITY_BARS[props.priority];
  return (
    <svg
      viewBox="0 0 12 12"
      class={`${props.priority === "urgent" ? "text-red-600 dark:text-red-400" : "text-muted"} ${props.class ?? "h-3 w-3"}`}
      aria-hidden="true"
    >
      <rect
        x="1"
        y="7"
        width="2.5"
        height="4"
        rx="0.5"
        class={filled() >= 1 ? "fill-current" : "fill-border"}
      />
      <rect
        x="4.75"
        y="4.5"
        width="2.5"
        height="6.5"
        rx="0.5"
        class={filled() >= 2 ? "fill-current" : "fill-border"}
      />
      <rect
        x="8.5"
        y="2"
        width="2.5"
        height="9"
        rx="0.5"
        class={filled() >= 3 ? "fill-current" : "fill-border"}
      />
    </svg>
  );
}

export function LabelChip(props: { label: Label }) {
  return (
    <span class="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted">
      <span
        class="h-1.5 w-1.5 rounded-full"
        style={{ "background-color": props.label.color }}
      />
      {props.label.name}
    </span>
  );
}

export function GitHubBadge(props: { issue: Issue }) {
  const gh = () => props.issue.github;
  const tone = (state?: string) =>
    state === "open"
      ? "border-emerald-500/40 text-emerald-500"
      : state === "merged"
        ? "border-violet-500/40 text-violet-400"
        : "border-border text-muted";
  return (
    <Show when={gh()}>
      {(g) => (
        <Tip
          text={
            g().kind === "pr"
              ? `${g().repo}#${g().number} — pull request`
              : `${g().repo}#${g().number} — GitHub issue`
          }
          hint={
            g().kind === "pr"
              ? "Mirrored pull request — click to open it on GitHub."
              : "Mirrored GitHub issue — click to open it on GitHub."
          }
          side="bottom"
        >
          <a
            href={g().url}
            target="_blank"
            rel="noreferrer"
            aria-label={`${g().repo}#${g().number} ${g().state}`}
            onClick={(e) => e.stopPropagation()}
            class={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10.5px] transition-colors ${tone(g().state)} hover:bg-hover`}
          >
          <Show
            when={g().kind === "pr"}
            fallback={
              <svg viewBox="0 0 16 16" fill="currentColor" class="h-3 w-3" aria-hidden="true">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
              </svg>
            }
          >
            <svg viewBox="0 0 16 16" fill="currentColor" class="h-3 w-3" aria-hidden="true">
              <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 0 1-1.5-2.122Zm0 2.25A.75.75 0 1 0 1.5 4a.75.75 0 0 0 0 1.5Zm10.5 4.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm.75-6.75a2.25 2.25 0 1 1-1.5 2.122V9.5a.75.75 0 0 1-.75.75H7.854a2.25 2.25 0 1 1 0 1.5H5.5v-1.5h4.5V5.372a2.25 2.25 0 0 1 1.5-2.122ZM12 4a.75.75 0 1 0-1.5 0A.75.75 0 0 0 12 4Z" />
            </svg>
          </Show>
          #{g().number} {g().state}
          </a>
        </Tip>
      )}
    </Show>
  );
}
