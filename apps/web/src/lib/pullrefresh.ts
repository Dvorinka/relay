// Phone-only pull-to-refresh: drag down past 72px while every scrollable
// ancestor of the touch point is at top fires a `relay:refresh` window
// event — pages with live data (Home, Inbox) refetch. A small haptic tick
// marks the threshold.

const THRESHOLD = 72;

// Every scrollable element between the touch target and `root` must sit at
// scrollTop 0 — nested scrollers (Inbox's inner list) hold their own offset
// while the outer container reads 0, so the deepest one decides.
function atTop(target: EventTarget | null, root: HTMLElement): boolean {
  let n = target instanceof HTMLElement ? target : null;
  while (n && n !== root) {
    if (n.scrollTop > 0) return false;
    n = n.parentElement;
  }
  return root.scrollTop <= 0;
}

export function attachPullToRefresh(el: HTMLElement): () => void {
  if (!("ontouchstart" in window)) return () => {};

  let startY = -1;
  let armed = false;

  const onStart = (e: TouchEvent) => {
    armed = false;
    startY =
      e.touches.length === 1 && atTop(e.target, el)
        ? e.touches[0]!.clientY
        : -1;
  };
  const onMove = (e: TouchEvent) => {
    if (startY < 0 || !atTop(e.target, el)) return;
    const dy = e.touches[0]!.clientY - startY;
    if (!armed && dy > THRESHOLD) {
      armed = true;
      navigator.vibrate?.(8);
    }
    // pulling back up past the threshold disarms — release then does nothing
    if (armed && dy < THRESHOLD * 0.5) armed = false;
  };
  const onEnd = (e: TouchEvent) => {
    if (armed) {
      window.dispatchEvent(new CustomEvent("relay:refresh"));
      // swallow the release tap so it can't hit a row under the finger
      e.preventDefault();
    }
    startY = -1;
    armed = false;
  };

  el.addEventListener("touchstart", onStart, { passive: true });
  el.addEventListener("touchmove", onMove, { passive: true });
  el.addEventListener("touchend", onEnd);
  return () => {
    el.removeEventListener("touchstart", onStart);
    el.removeEventListener("touchmove", onMove);
    el.removeEventListener("touchend", onEnd);
  };
}
