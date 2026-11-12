// Horizontal gesture decision shared by message rows, the thread panel,
// and the nav edge swipe. Vertical movement wins so a scroll never
// becomes a reply or a back.

export type HSwipe = "left" | "right" | null;

export function horizontalSwipe(
  dx: number,
  dy: number,
  threshold = 56,
): HSwipe {
  if (Math.abs(dy) >= Math.abs(dx)) return null;
  if (dx >= threshold) return "right";
  if (dx <= -threshold) return "left";
  return null;
}
