import { useMemo } from "react";
import { Text, View } from "react-native";
import Svg, {
  Defs,
  G,
  Ellipse,
  Marker,
  Path,
  Polygon,
  Rect,
  Text as SvgText,
} from "react-native-svg";
import { useTheme } from "../lib/theme";

// SceneSvg renders an Excalidraw-compatible scene ({elements: [...]}) with
// react-native-svg — the mobile counterpart of the web's SceneView. Same
// subset: rectangle, ellipse, diamond, line, arrow, text + shape labels.

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

const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

function elements(scene: Record<string, unknown> | undefined): El[] {
  const els = scene?.elements;
  if (!Array.isArray(els)) return [];
  return (els as Record<string, unknown>[]).flatMap((raw) => {
    const e: El = {
      type: typeof raw.type === "string" ? raw.type : "rectangle",
      x: num(raw.x) ?? 0,
      y: num(raw.y) ?? 0,
      width: num(raw.width) ?? 0,
      height: num(raw.height) ?? 0,
      text: typeof raw.text === "string" ? raw.text : undefined,
      strokeColor: typeof raw.strokeColor === "string" ? raw.strokeColor : undefined,
      backgroundColor:
        typeof raw.backgroundColor === "string" ? raw.backgroundColor : undefined,
      strokeWidth: num(raw.strokeWidth),
      points: Array.isArray(raw.points)
        ? raw.points.flatMap((p): [number, number][] => {
            const px = Array.isArray(p) ? num(p[0]) : num((p as { x?: number })?.x);
            const py = Array.isArray(p) ? num(p[1]) : num((p as { y?: number })?.y);
            return px !== undefined && py !== undefined ? [[px, py]] : [];
          })
        : undefined,
    };
    // Drop degenerate shapes (tap-artifacts): zero-area box/ellipse/diamond
    // with no text renders nothing anyway.
    const degenerate =
      e.type !== "text" &&
      e.type !== "line" &&
      e.type !== "arrow" &&
      (e.width ?? 0) < 2 &&
      (e.height ?? 0) < 2 &&
      (e.points?.length ?? 0) < 2;
    return degenerate ? [] : [e];
  });
}

function bounds(els: El[]) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const e of els) {
    const x = e.x ?? 0,
      y = e.y ?? 0;
    const w = e.width ?? 0,
      h = e.height ?? 0;
    let ex2 = x + w,
      ey2 = y + h;
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
  return {
    x: minX - pad,
    y: minY - pad,
    w: maxX - minX + pad * 2,
    h: maxY - minY + pad * 2,
  };
}

const stroke = (e: El) => e.strokeColor || "#06b6d4";
const fill = (e: El) =>
  e.backgroundColor && e.backgroundColor !== "transparent"
    ? e.backgroundColor
    : "none";

// Label color picked by fill luminance — light text on dark shapes.
function labelColor(bg: string | undefined): string {
  const m = /^#([0-9a-f]{6})$/i.exec(bg ?? "");
  if (!m) return "#1e293b";
  const n = parseInt(m[1], 16);
  const lum =
    (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum < 0.45 ? "#f8fafc" : "#1e293b";
}

function ShapeLabel(p: {
  e: El;
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
}) {
  const lines = (p.e.text ?? "").split("\n").filter(Boolean);
  if (!lines.length) return null;
  const lineH = p.size * 1.2;
  const startY = p.y + p.h / 2 - ((lines.length - 1) * lineH) / 2;
  return (
    <>
      {lines.map((line, i) => (
        <SvgText
          key={i}
          x={p.x + p.w / 2}
          y={startY + i * lineH}
          textAnchor="middle"
          alignmentBaseline="central"
          fontSize={p.size}
          fill={labelColor(p.e.backgroundColor)}
        >
          {line}
        </SvgText>
      ))}
    </>
  );
}

export function SceneSvg(props: {
  scene: Record<string, unknown> | undefined;
  width?: number;
}) {
  const C = useTheme();
  const els = useMemo(() => elements(props.scene), [props.scene]);
  const vb = useMemo(() => bounds(els), [els]);
  const scale = Math.max(vb.w / 800, 0.5);
  const fontSize = 16 * scale;
  const sw = (e: El) => (e.strokeWidth ?? 2) * scale;

  if (!els.length) {
    return (
      <View style={{ padding: 24, alignItems: "center" }}>
        <Text style={{ color: C.muted, fontSize: 13 }}>Empty canvas</Text>
      </View>
    );
  }

  return (
    <Svg
      viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
      width={props.width ?? "100%"}
      height={((props.width ?? 340) / vb.w) * vb.h}
    >
      <Defs>
        <Marker
          id="arr"
          viewBox="0 0 10 10"
          refX={9}
          refY={5}
          markerWidth={7}
          markerHeight={7}
          orient="auto-start-reverse"
        >
          <Path d="M 0 1 L 9 5 L 0 9" strokeWidth={1.5} fill="none" />
        </Marker>
      </Defs>
      {els.map((e, i) => {
        const x = e.x ?? 0,
          y = e.y ?? 0;
        const w = e.width ?? 0,
          h = e.height ?? 0;
        if (e.type === "text") {
          return (
            <SvgText
              key={i}
              x={x}
              y={y + fontSize}
              fontSize={fontSize}
              fill={stroke(e)}
            >
              {e.text}
            </SvgText>
          );
        }
        if (e.type === "diamond") {
          return (
            <G key={i}>
              <Polygon
                points={`${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`}
                fill={fill(e)}
                stroke={stroke(e)}
                strokeWidth={sw(e)}
                strokeLinejoin="round"
              />
              <ShapeLabel e={e} x={x} y={y} w={w} h={h} size={fontSize} />
            </G>
          );
        }
        if (e.type === "ellipse") {
          return (
            <G key={i}>
              <Ellipse
                cx={x + w / 2}
                cy={y + h / 2}
                rx={Math.abs(w / 2)}
                ry={Math.abs(h / 2)}
                fill={fill(e)}
                stroke={stroke(e)}
                strokeWidth={sw(e)}
              />
              <ShapeLabel e={e} x={x} y={y} w={w} h={h} size={fontSize} />
            </G>
          );
        }
        if (e.type === "line" || e.type === "arrow") {
          const pts =
            Array.isArray(e.points) && e.points.length > 1
              ? e.points
              : ([[0, 0], [w, h]] as [number, number][]);
          const d = pts
            .map(([px, py], j) => `${j === 0 ? "M" : "L"} ${x + px} ${y + py}`)
            .join(" ");
          return (
            <Path
              key={i}
              d={d}
              fill="none"
              stroke={stroke(e)}
              strokeWidth={sw(e)}
              strokeLinecap="round"
              markerEnd={e.type === "arrow" ? "url(#arr)" : undefined}
            />
          );
        }
        // rectangle (default)
        return (
          <G key={i}>
            <Rect
              x={x}
              y={y}
              width={w}
              height={h}
              rx={6 * scale}
              fill={fill(e)}
              stroke={stroke(e)}
              strokeWidth={sw(e)}
            />
            <ShapeLabel e={e} x={x} y={y} w={w} h={h} size={fontSize} />
          </G>
        );
      })}
    </Svg>
  );
}
