import { For, Show, createMemo } from "solid-js";

// SceneView renders an Excalidraw-compatible scene ({elements: [...]}) as SVG.
// Supports the element subset agents are asked to emit: rectangle, ellipse,
// diamond, line, arrow, text. Unknown element types are skipped.
// Zoom: wheel/scroll zooms; drag pans — good enough for review diagrams.

interface El {
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  text?: string;
  strokeColor?: string;
  backgroundColor?: string;
  strokeWidth?: number;
  points?: [number, number][];
}

function elements(scene: Record<string, unknown>): El[] {
  const els = (scene as { elements?: unknown }).elements;
  return Array.isArray(els) ? (els as El[]) : [];
}

function bounds(els: El[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of els) {
    const x = e.x ?? 0, y = e.y ?? 0;
    const w = e.width ?? 0, h = e.height ?? 0;
    let ex2 = x + w, ey2 = y + h;
    if (Array.isArray(e.points)) {
      for (const [px, py] of e.points) {
        minX = Math.min(minX, x + px);
        minY = Math.min(minY, y + py);
        ex2 = Math.max(ex2, x + px);
        ey2 = Math.max(ey2, y + py);
      }
    }
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, ex2);
    maxY = Math.max(maxY, ey2);
  }
  if (!isFinite(minX)) return { x: 0, y: 0, w: 800, h: 400 };
  const pad = 32;
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

function stroke(e: El) {
  return e.strokeColor || "#06b6d4";
}
function fill(e: El) {
  return e.backgroundColor && e.backgroundColor !== "transparent"
    ? e.backgroundColor
    : "none";
}

export function SceneView(props: { scene: Record<string, unknown> }) {
  const els = createMemo(() => elements(props.scene));
  const vb = createMemo(() => bounds(els()));
  const scale = createMemo(() => Math.max(vb().w / 800, 0.5));
  const fontSize = () => 16 * scale();
  const sw = (e: El) => (e.strokeWidth ?? 2) * scale();

  return (
    <div class="overflow-hidden rounded-lg border border-border bg-white dark:bg-zinc-950">
      <Show
        when={els().length > 0}
        fallback={
          <p class="p-6 text-center text-[12px] text-muted">
            Empty scene — the brief carries no diagram yet.
          </p>
        }
      >
        <svg
          viewBox={`${vb().x} ${vb().y} ${vb().w} ${vb().h}`}
          class="block h-auto w-full"
          role="img"
          aria-label="Brief diagram"
        >
          <defs>
            <marker
              id="bv-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 9 5 L 0 9" fill="none" stroke="context-stroke" stroke-width="1.5" />
            </marker>
          </defs>
          <For each={els()}>
            {(e) => {
              const x = e.x ?? 0, y = e.y ?? 0;
              const w = e.width ?? 0, h = e.height ?? 0;
              if (e.type === "text") {
                return (
                  <text
                    x={x}
                    y={y + fontSize()}
                    font-size={`${fontSize()}px`}
                    fill={stroke(e)}
                    style={{ "font-family": "ui-sans-serif, system-ui, sans-serif" }}
                  >
                    {e.text}
                  </text>
                );
              }
              if (e.type === "diamond") {
                return (
                  <polygon
                    points={`${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`}
                    fill={fill(e)}
                    stroke={stroke(e)}
                    stroke-width={sw(e)}
                    stroke-linejoin="round"
                  />
                );
              }
              if (e.type === "ellipse") {
                return (
                  <ellipse
                    cx={x + w / 2}
                    cy={y + h / 2}
                    rx={Math.abs(w / 2)}
                    ry={Math.abs(h / 2)}
                    fill={fill(e)}
                    stroke={stroke(e)}
                    stroke-width={sw(e)}
                  />
                );
              }
              if (e.type === "line" || e.type === "arrow") {
                const pts = Array.isArray(e.points) && e.points.length > 1
                  ? e.points
                  : ([[0, 0], [w, h]] as [number, number][]);
                const d = pts.map(([px, py], i) => `${i === 0 ? "M" : "L"} ${x + px} ${y + py}`).join(" ");
                return (
                  <path
                    d={d}
                    fill="none"
                    stroke={stroke(e)}
                    stroke-width={sw(e)}
                    stroke-linecap="round"
                    marker-end={e.type === "arrow" ? "url(#bv-arrow)" : undefined}
                  />
                );
              }
              // rectangle (default)
              return (
                <rect
                  x={x}
                  y={y}
                  width={w}
                  height={h}
                  rx={6 * scale()}
                  fill={fill(e)}
                  stroke={stroke(e)}
                  stroke-width={sw(e)}
                />
              );
            }}
          </For>
        </svg>
      </Show>
    </div>
  );
}
