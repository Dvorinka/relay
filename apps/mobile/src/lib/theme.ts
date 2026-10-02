import { useColorScheme } from "react-native";

// Mirrors apps/web: cyan accent, warm light surfaces, neutral near-black dark.
const dark = {
  scheme: "dark" as const,
  onAccent: "#062a30",
  bg: "#0a0a0b",
  surface: "#131416",
  surface2: "#1a1b1f",
  border: "#232427",
  text: "#e9e9eb",
  muted: "#9c9fa7",
  faint: "#61646d",
  accent: "#06b6d4",
  danger: "#e05d4f",
};

const light = {
  scheme: "light" as const,
  onAccent: "#062a30",
  bg: "#fafaf8",
  surface: "#ffffff",
  surface2: "#f4f2ee",
  border: "#e6e3dc",
  text: "#1a1c20",
  muted: "#5c6470",
  faint: "#9aa0aa",
  accent: "#06b6d4",
  danger: "#d03e30",
};

export type Palette = Omit<typeof dark, "scheme"> & { scheme: "dark" | "light" };

export function useTheme(): Palette {
  return useColorScheme() === "light" ? light : dark;
}
