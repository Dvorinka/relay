// kind:<type> tags — the platform names its own report types, so colors
// can't be a fixed registry. Well-known kinds get semantic colors;
// anything else hashes stably into a palette.

const semantic: Record<string, string> = {
  bug: "border-red-400/50 bg-red-500/10 text-red-600 dark:text-red-400",
  problem: "border-red-400/50 bg-red-500/10 text-red-600 dark:text-red-400",
  error: "border-red-400/50 bg-red-500/10 text-red-600 dark:text-red-400",
  incident:
    "border-rose-400/50 bg-rose-500/10 text-rose-600 dark:text-rose-400",
  outage: "border-rose-400/50 bg-rose-500/10 text-rose-600 dark:text-rose-400",
  feature:
    "border-violet-400/50 bg-violet-500/10 text-violet-600 dark:text-violet-400",
  enhancement:
    "border-violet-400/50 bg-violet-500/10 text-violet-600 dark:text-violet-400",
  suggestion:
    "border-violet-400/50 bg-violet-500/10 text-violet-600 dark:text-violet-400",
  idea: "border-violet-400/50 bg-violet-500/10 text-violet-600 dark:text-violet-400",
  feedback:
    "border-sky-400/50 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  review: "border-sky-400/50 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  question:
    "border-amber-400/50 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  help: "border-amber-400/50 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  security:
    "border-orange-400/50 bg-orange-500/10 text-orange-600 dark:text-orange-400",
  praise:
    "border-emerald-400/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
};

const palette = [
  "border-sky-400/50 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  "border-emerald-400/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  "border-amber-400/50 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  "border-violet-400/50 bg-violet-500/10 text-violet-600 dark:text-violet-400",
  "border-rose-400/50 bg-rose-500/10 text-rose-600 dark:text-rose-400",
  "border-cyan-400/50 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  "border-indigo-400/50 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
  "border-orange-400/50 bg-orange-500/10 text-orange-600 dark:text-orange-400",
];

// tagChip returns the chip's color classes + display label. kind: tags
// render as just the type name — the color is the label.
export function tagChip(t: string): { cls: string; label: string } {
  if (t.startsWith("kind:")) {
    const kind = t.slice(5).toLowerCase();
    const cls = semantic[kind] ?? palette[hash(kind) % palette.length] ?? "";
    return { cls, label: t.slice(5) };
  }
  return {
    cls: "border-accent/40 bg-accent-soft/60 text-accent-ink hover:bg-accent-soft",
    label: t,
  };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}
