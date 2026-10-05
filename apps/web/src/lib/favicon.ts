// Unread badge on the favicon: pinned tabs and the desktop taskbar show the
// dot even when the "(N) Relay" title is truncated. Rasterizes /favicon.svg
// once, then composites a badge circle per count.

let base: HTMLImageElement | null = null;
let baseReady = false;
let last = -1;

function link(): HTMLLinkElement | null {
  return document.querySelector<HTMLLinkElement>('link[rel="icon"]');
}

function draw(count: number) {
  const el = link();
  if (!el) return;
  if (count <= 0) {
    if (last !== 0) {
      el.href = "/favicon.svg";
      last = 0;
    }
    return;
  }
  if (!base) {
    base = new Image();
    base.onload = () => {
      baseReady = true;
      draw(count);
    };
    base.onerror = () => {
      base = null;
    };
    base.src = "/favicon.svg";
    return;
  }
  if (!baseReady) return;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(base, 0, 0, 64, 64);
  // accent badge, bottom-right
  const accent =
    getComputedStyle(document.documentElement)
      .getPropertyValue("--accent")
      .trim() || "#06b6d4";
  ctx.beginPath();
  ctx.arc(48, 48, 15, 0, Math.PI * 2);
  ctx.fillStyle = accent;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#0a0a0b";
  ctx.stroke();
  if (count > 1) {
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 22px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(count > 9 ? "9+" : String(count), 48, 49);
  }
  el.href = c.toDataURL("image/png");
  last = count;
}

export function setFaviconBadge(count: number) {
  try {
    draw(count);
  } catch {
    /* favicon is best-effort */
  }
}
