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

// Phone gesture: swipe in from the left edge opens the drawer, a leftward
// fling while it's open closes it — the same convention every mobile app
// with a side drawer uses. Vertical scrolls are ignored by the axis check.
export function initNavSwipe() {
  if (!("ontouchstart" in window)) return;
  let x0 = 0;
  let y0 = 0;
  let tracking = false;
  window.addEventListener(
    "touchstart",
    (e) => {
      const t = e.touches[0];
      if (!t) return;
      // opening requires starting at the screen edge; closing works anywhere
      // (when open, the drawer + backdrop cover the content anyway)
      tracking = (!navOpen() && t.clientX <= 28) || navOpen();
      x0 = t.clientX;
      y0 = t.clientY;
    },
    { passive: true },
  );
  window.addEventListener(
    "touchend",
    (e) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - x0;
      const dy = t.clientY - y0;
      if (Math.abs(dy) >= Math.abs(dx)) return;
      if (!navOpen() && dx > 56) setNavOpen(true);
      else if (navOpen() && dx < -56) setNavOpen(false);
    },
    { passive: true },
  );
}
