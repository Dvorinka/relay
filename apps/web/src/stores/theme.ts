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
  applyAccent(); // accent-soft mix is theme-dependent
}

// --- accent ---
// The accent is the brand color, not a preference — cyan everywhere.

export const BRAND_ACCENT = "#06b6d4";
const BRAND_ACCENT_INK = "#0891b2";

function applyAccent() {
  const el = document.documentElement;
  el.style.setProperty("--accent", BRAND_ACCENT);
  el.style.setProperty("--accent-ink", BRAND_ACCENT_INK);
  el.style.setProperty(
    "--accent-soft",
    `color-mix(in srgb, ${BRAND_ACCENT} ${theme() === "dark" ? 14 : 10}%, transparent)`,
  );
}

// apply once at module load - index.html defaults to .dark
apply(initial);
applyAccent();
localStorage.removeItem("relay.accent"); // dropped pref — brand is fixed

// --- chat layout ---
// "grouped" = left-aligned Discord-style rows (default). "bubbles" =
// WhatsApp-style two-sided bubbles: own messages right, others left.

export type ChatStyle = "grouped" | "bubbles";

const [chatStyle, setChatStyleSignal] = createSignal<ChatStyle>(
  localStorage.getItem("relay.chatStyle") === "bubbles"
    ? "bubbles"
    : "grouped",
);

export function useChatStyle() {
  return { chatStyle };
}

export function setChatStyle(s: ChatStyle) {
  setChatStyleSignal(s);
  localStorage.setItem("relay.chatStyle", s);
}
