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
    ?.setAttribute("content", t === "dark" ? "#101318" : "#fafaf8");
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

// apply once at module load — index.html defaults to .dark
apply(initial);
