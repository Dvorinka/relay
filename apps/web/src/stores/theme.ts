import { createSignal } from "solid-js";

type Theme = "dark" | "light";

const stored = localStorage.getItem("relay.theme");
const initial: Theme =
  stored === "light" || stored === "dark"
    ? stored
    : window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";

const [theme, setThemeSignal] = createSignal<Theme>(initial);

function apply(t: Theme) {
  document.documentElement.classList.toggle("dark", t === "dark");
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", t === "dark" ? "#0a0a0b" : "#fafaf8");
}

export function useTheme() {
  return { theme };
}

export function toggleTheme() {
  const next = theme() === "dark" ? "light" : "dark";
  setThemeSignal(next);
  localStorage.setItem("relay.theme", next);
  apply(next);
}

// --- accent ---

export const ACCENT_PRESETS = [
  ["Cyan", "#06b6d4"],
  ["Ember", "#f2541b"],
  ["Crimson", "#e11d48"],
  ["Rose", "#f43f5e"],
  ["Pink", "#ec4899"],
  ["Violet", "#8b5cf6"],
  ["Blue", "#3b82f6"],
  ["Teal", "#0d9488"],
  ["Green", "#0dbd8b"],
  ["Lime", "#84cc16"],
  ["Amber", "#f59e0b"],
] as const;

const DEFAULT_ACCENT = "#06b6d4";

const [accent, setAccentSignal] = createSignal(
  /^#[0-9a-fA-F]{6}$/.test(localStorage.getItem("relay.accent") ?? "")
    ? localStorage.getItem("relay.accent")!
    : DEFAULT_ACCENT,
);

function hexToHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) / 255,
    g = ((n >> 8) & 255) / 255,
    b = (n & 255) / 255;
  const mx = Math.max(r, g, b),
    mn = Math.min(r, g, b),
    d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  const l = (mx + mn) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return [h, s * 100, l * 100];
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const v = (n: number) =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${v(r)}${v(g)}${v(b)}`;
}

function applyAccent(hex: string) {
  const [h, s, l] = hexToHsl(hex);
  const ink = hslToHex(h, Math.min(100, s * 1.05), Math.max(12, l - 14));
  const el = document.documentElement;
  el.style.setProperty("--accent", hex);
  el.style.setProperty("--accent-ink", ink);
  // accent-soft is color-mix'd off --accent in .dark; light needs the var too
  // so custom colors get a soft tint in both themes.
  el.style.setProperty(
    "--accent-soft",
    `color-mix(in srgb, ${hex} ${theme() === "dark" ? 14 : 10}%, transparent)`,
  );
}

export function useAccent() {
  return { accent };
}

export function setAccent(hex: string) {
  setAccentSignal(hex);
  localStorage.setItem("relay.accent", hex);
  applyAccent(hex);
}

// apply once at module load - index.html defaults to .dark
apply(initial);
applyAccent(accent());
