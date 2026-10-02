const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** "2m ago" / "3h ago" / "5d ago", then a short date past a week. */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "";
  }
  const diff = Date.now() - then;
  if (diff < MINUTE) {
    return "just now";
  }
  if (diff < HOUR) {
    return `${Math.floor(diff / MINUTE)}m ago`;
  }
  if (diff < DAY) {
    return `${Math.floor(diff / HOUR)}h ago`;
  }
  if (diff < WEEK) {
    return `${Math.floor(diff / DAY)}d ago`;
  }
  const date = new Date(then);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (date.getFullYear() !== new Date().getFullYear()) {
    opts.year = "numeric";
  }
  return date.toLocaleDateString(undefined, opts);
}

/** "in 5m" / "in 3h" / "in 2d" — future counterpart to timeAgo. */
export function timeUntil(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "";
  }
  const diff = then - Date.now();
  if (diff <= 0) {
    return "now";
  }
  if (diff < HOUR) {
    return `in ${Math.max(1, Math.floor(diff / MINUTE))}m`;
  }
  if (diff < DAY) {
    return `in ${Math.floor(diff / HOUR)}h`;
  }
  return `in ${Math.floor(diff / DAY)}d`;
}
