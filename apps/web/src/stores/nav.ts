import { createSignal } from "solid-js";

// Mobile nav drawer — the Rail renders as a static column on md+ and as an
// overlay below that; TopBar's hamburger toggles this.
const [navOpen, setNavOpen] = createSignal(false);

export function useNav() {
  return {
    navOpen,
    toggleNav: () => setNavOpen((v) => !v),
    closeNav: () => setNavOpen(false),
  };
}
