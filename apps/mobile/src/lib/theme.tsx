import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
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
export type ThemePreference = "system" | "light" | "dark";

const THEME_KEY = "relay.theme";

const ThemeCtx = createContext<{
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
}>({ preference: "system", setPreference: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPref] = useState<ThemePreference>("system");

  useEffect(() => {
    void AsyncStorage.getItem(THEME_KEY).then((v) => {
      if (v === "light" || v === "dark" || v === "system") setPref(v);
    });
  }, []);

  const value = useMemo(
    () => ({
      preference,
      setPreference: (p: ThemePreference) => {
        setPref(p);
        void AsyncStorage.setItem(THEME_KEY, p);
      },
    }),
    [preference],
  );

  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export function useThemePreference() {
  return useContext(ThemeCtx);
}

export function useTheme(): Palette {
  const system = useColorScheme();
  const { preference } = useContext(ThemeCtx);
  const scheme =
    preference === "system" ? (system === "light" ? "light" : "dark") : preference;
  return scheme === "light" ? light : dark;
}
