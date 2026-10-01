import type {
  IssuePriority,
  IssueStatus,
  Label,
} from "@relay/api-client";

export const ISSUE_STATUSES: IssueStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "done",
  "cancelled",
];

export const ISSUE_PRIORITIES: IssuePriority[] = [
  "none",
  "urgent",
  "high",
  "medium",
  "low",
];

export const STATUS_LABEL: Record<IssueStatus, string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
  cancelled: "Cancelled",
};

export const PRIORITY_LABEL: Record<IssuePriority, string> = {
  none: "None",
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

const STATUS_DOT_CLASS: Record<IssueStatus, string> = {
  backlog: "bg-muted/50",
  todo: "bg-sky-500",
  in_progress: "bg-amber-500",
  review: "bg-violet-500",
  done: "bg-emerald-500",
  cancelled: "bg-muted",
};

export function isClosed(status: IssueStatus): boolean {
  return status === "done" || status === "cancelled";
}

/** Label for a status string that may come from an untyped payload. */
export function statusLabel(s: string): string {
  if ((ISSUE_STATUSES as readonly string[]).includes(s)) {
    // SAFETY: guarded by the includes() check above.
    return STATUS_LABEL[s as IssueStatus];
  }
  return s;
}

export function StatusDot(props: { status: IssueStatus; class?: string }) {
  return (
    <span
      class={`inline-block rounded-full ${STATUS_DOT_CLASS[props.status]} ${props.class ?? "h-2 w-2"}`}
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
