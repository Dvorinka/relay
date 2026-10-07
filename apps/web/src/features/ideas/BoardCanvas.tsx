import { useNavigate } from "@solidjs/router";
import {
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import type { Issue } from "@relay/api-client";
import { api } from "../../lib/api";
import { subscribe } from "../../lib/events";
import { isClosed, statusDefs, StatusDot } from "../issues/meta";
import type { Project } from "@relay/api-client";

// Native whiteboard — the idea record's `scene.relay_board` payload:
//   { v: 1, nodes: BoardNode[] }
// SVG-based: pan (drag empty space / space-drag), zoom (wheel), drag nodes,
// draw shapes, place issue/PR mention cards, autosave on change. The JSON
// lives inside idea.scene so agents read/revise the same document over MCP.

export interface BoardNode {
  id: string;
  kind: "note" | "rect" | "ellipse" | "text" | "arrow" | "issue";
  x: number;
  y: number;
  w?: number;
  h?: number;
  x2?: number; // arrow end
  y2?: number;
  text?: string;
  color?: string;
  issue_id?: string;
}

export interface BoardDoc {
  v: 1;
  nodes: BoardNode[];
}

type Tool = "select" | "note" | "rect" | "ellipse" | "text" | "arrow" | "issue";

const NOTE_COLORS = ["#f59e0b", "#10b981", "#8b5cf6", "#ef4444", "#3b82f6"];

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

function parseDoc(scene: Record<string, unknown> | undefined): BoardDoc {
  const raw = scene?.relay_board as { v?: number; nodes?: unknown } | undefined;
  if (raw && Array.isArray(raw.nodes)) {
    return { v: 1, nodes: raw.nodes as BoardNode[] };
  }
  return { v: 1, nodes: [] };
}

export function BoardCanvas(props: {
  project: Project;
  scene: Record<string, unknown> | undefined;
  onSave: (board: BoardDoc) => Promise<void>;
}) {
  const navigate = useNavigate();
  const [nodes, setNodes] = createSignal<BoardNode[]>(
    parseDoc(props.scene).nodes,
  );
  const [tool, setTool] = createSignal<Tool>("select");
  const [sel, setSel] = createSignal<string | null>(null);
  const [pan, setPan] = createSignal({ x: 40, y: 40 });
  const [zoom, setZoom] = createSignal(1);
  const [picking, setPicking] = createSignal<BoardNode | null>(null);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal<"idle" | "dirty" | "saving">("idle");
  let svg: SVGSVGElement | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const [issues, { refetch: refetchIssues }] = createResourceIssues(
    () => props.project.id,
  );
  const issueById = createMemo(() => {
    const m = new Map<string, Issue>();
    for (const i of issues.latest ?? []) m.set(i.id, i);
    return m;
  });

  const unsub = subscribe((e) => {
    if (e.project_id === props.project.id && e.type.startsWith("issue.")) {
      refetchIssues();
    }
  });
  onCleanup(() => {
    unsub();
    if (saveTimer) clearTimeout(saveTimer);
  });

  // --- coordinate plumbing ------------------------------------------------
  // world = (screen - pan) / zoom
  function toWorld(e: { clientX: number; clientY: number }) {
    const r = svg!.getBoundingClientRect();
    return {
      x: (e.clientX - r.left - pan().x) / zoom(),
      y: (e.clientY - r.top - pan().y) / zoom(),
    };
  }

  function commit(up: (n: BoardNode[]) => BoardNode[]) {
    setNodes(up);
    setSaving("dirty");
    scheduleSave();
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      setSaving("saving");
      try {
        await props.onSave({ v: 1, nodes: nodes() });
      } finally {
        setSaving("idle");
      }
    }, 800);
  }

  // --- interactions ---------------------------------------------------------
  let drag:
    | { mode: "pan"; sx: number; sy: number; px: number; py: number }
    | { mode: "move"; id: string; dx: number; dy: number }
    | { mode: "draw"; id: string; x0: number; y0: number }
    | null = null;

  function onBgDown(e: PointerEvent) {
    if (e.button === 1 || tool() === "select") {
      drag = { mode: "pan", sx: e.clientX, sy: e.clientY, px: pan().x, py: pan().y };
    } else {
      const p = toWorld(e);
      const n = spawnNode(tool(), p.x, p.y);
      if (!n) return;
      commit((ns) => [...ns, n]);
      if (n.kind === "arrow" || n.kind === "rect" || n.kind === "ellipse") {
        drag = { mode: "draw", id: n.id, x0: p.x, y0: p.y };
      } else {
        setSel(n.id);
        if (n.kind === "text" || n.kind === "note") setEditingId(n.id);
        if (n.kind === "issue") setPicking(n);
        setTool("select");
      }
    }
    svg!.setPointerCapture(e.pointerId);
  }

  function onNodeDown(e: PointerEvent, n: BoardNode) {
    if (tool() !== "select" || e.button === 1) return;
    e.stopPropagation();
    setSel(n.id);
    const p = toWorld(e);
    drag = { mode: "move", id: n.id, dx: p.x - n.x, dy: p.y - n.y };
    svg!.setPointerCapture(e.pointerId);
  }

  function onMove(e: PointerEvent) {
    if (!drag) return;
    if (drag.mode === "pan") {
      setPan({ x: drag.px + (e.clientX - drag.sx), y: drag.py + (e.clientY - drag.sy) });
      return;
    }
    const p = toWorld(e);
    if (drag.mode === "move") {
      const d = drag;
      setNodes((ns) =>
        ns.map((n) =>
          n.id === d.id
            ? n.kind === "arrow"
              ? {
                  ...n,
                  x: p.x - d.dx,
                  y: p.y - d.dy,
                  x2: (n.x2 ?? n.x) + (p.x - d.dx) - n.x,
                  y2: (n.y2 ?? n.y) + (p.y - d.dy) - n.y,
                }
              : { ...n, x: p.x - d.dx, y: p.y - d.dy }
            : n,
        ),
      );
      setSaving("dirty");
      scheduleSave();
      return;
    }
    // draw: stretch the shape to the cursor
    const d = drag;
    setNodes((ns) =>
      ns.map((n) => {
        if (n.id !== d.id) return n;
        if (n.kind === "arrow") return { ...n, x2: p.x, y2: p.y };
        return {
          ...n,
          x: Math.min(d.x0, p.x),
          y: Math.min(d.y0, p.y),
          w: Math.max(12, Math.abs(p.x - d.x0)),
          h: Math.max(12, Math.abs(p.y - d.y0)),
        };
      }),
    );
  }

  function onUp() {
    const d = drag;
    drag = null;
    if (d?.mode === "draw") {
      // drop degenerate shapes — a click shouldn't leave a sliver
      setNodes((ns) =>
        ns.filter((n) => {
          if (n.id !== d.id) return true;
          const w = n.kind === "arrow" ? Math.abs((n.x2 ?? n.x) - n.x) : n.w ?? 0;
          const h = n.kind === "arrow" ? Math.abs((n.y2 ?? n.y) - n.y) : n.h ?? 0;
          return w + h >= 8;
        }),
      );
      setTool("select");
      commit((ns) => ns);
    } else if (d?.mode === "move") {
      commit((ns) => ns);
    }
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const r = svg!.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const z = zoom();
    const nz = Math.min(3, Math.max(0.25, z * (e.deltaY > 0 ? 0.9 : 1.1)));
    // keep the cursor's world point fixed on screen
    setPan({
      x: mx - ((mx - pan().x) / z) * nz,
      y: my - ((my - pan().y) / z) * nz,
    });
    setZoom(nz);
  }

  onMount(() => {
    svg!.addEventListener("wheel", onWheel, { passive: false });
  });

  function spawnNode(t: Tool, x: number, y: number): BoardNode | null {
    switch (t) {
      case "note":
        return { id: newId(), kind: "note", x, y, w: 170, h: 110, text: "", color: NOTE_COLORS[0] };
      case "rect":
        return { id: newId(), kind: "rect", x, y, w: 120, h: 80 };
      case "ellipse":
        return { id: newId(), kind: "ellipse", x, y, w: 120, h: 80 };
      case "text":
        return { id: newId(), kind: "text", x, y, w: 160, h: 24, text: "" };
      case "arrow":
        return { id: newId(), kind: "arrow", x, y, x2: x, y2: y };
      case "issue":
        return { id: newId(), kind: "issue", x, y, w: 190, h: 64 };
      default:
        return null;
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
    const id = sel();
    if ((e.key === "Delete" || e.key === "Backspace") && id) {
      commit((ns) => ns.filter((n) => n.id !== id));
      setSel(null);
    }
    if (e.key === "Escape") {
      setSel(null);
      setPicking(null);
      setEditingId(null);
      setTool("select");
    }
  }
  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));

  function setText(id: string, text: string) {
    commit((ns) => ns.map((n) => (n.id === id ? { ...n, text } : n)));
  }

  const editingNode = createMemo(() => {
    const id = editingId();
    return id ? nodes().find((n) => n.id === id) : undefined;
  });

  return (
    <div class="relative h-full w-full overflow-hidden bg-[radial-gradient(circle,var(--color-border)_1px,transparent_1px)] [background-size:22px_22px]">
      {/* toolbar */}
      <div class="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-border bg-surface px-1.5 py-1 shadow-md">
        <ToolBtn cur={tool()} id="select" label="Select / pan" onPick={setTool}>
          <path d="M4 2l7 6.5-3 .8L6 13z" />
        </ToolBtn>
        <ToolBtn cur={tool()} id="note" label="Sticky note" onPick={setTool}>
          <rect x="3" y="3" width="10" height="10" rx="1" />
        </ToolBtn>
        <ToolBtn cur={tool()} id="rect" label="Rectangle" onPick={setTool}>
          <rect x="2" y="5" width="12" height="7" />
        </ToolBtn>
        <ToolBtn cur={tool()} id="ellipse" label="Ellipse" onPick={setTool}>
          <ellipse cx="8" cy="8" rx="6" ry="4.5" />
        </ToolBtn>
        <ToolBtn cur={tool()} id="text" label="Text" onPick={setTool}>
          <path d="M3 4h10M8 4v9" />
        </ToolBtn>
        <ToolBtn cur={tool()} id="arrow" label="Arrow" onPick={setTool}>
          <path d="M3 13L13 3M8.5 3H13v4.5" />
        </ToolBtn>
        <ToolBtn cur={tool()} id="issue" label="Issue / PR card" onPick={setTool}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 5.5v5" />
        </ToolBtn>
        <span class="mx-1 h-4 w-px bg-border" />
        <span class="px-1 font-mono text-[10.5px] text-muted">
          {saving() === "saving" ? "saving…" : saving() === "dirty" ? "•" : `${Math.round(zoom() * 100)}%`}
        </span>
      </div>

      <svg
        ref={(el) => (svg = el)}
        class={`h-full w-full touch-none select-none ${tool() === "select" ? "cursor-grab" : "cursor-crosshair"}`}
        onPointerDown={onBgDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
      >
        <defs>
          <marker
            id="board-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0L10 5L0 10z" fill="currentColor" class="text-fg" />
          </marker>
        </defs>
        <g transform={`translate(${pan().x} ${pan().y}) scale(${zoom()})`}>
          <For each={nodes()}>
            {(n) => (
              <BoardNodeView
                node={n}
                project={props.project}
                issue={n.issue_id ? issueById().get(n.issue_id) : undefined}
                selected={sel() === n.id}
                onDown={onNodeDown}
                onText={setText}
                onDblClick={() => {
                  if (n.kind === "text" || n.kind === "note") setEditingId(n.id);
                }}
                onOpenIssue={(id) => navigate(`/app/p/${props.project.id}/i/${id}`)}
                editing={editingId() === n.id}
              />
            )}
          </For>
        </g>
      </svg>

      {/* inline text editor floats over the node in screen space */}
      <Show when={editingNode()}>
        {(n) => {
          const p = () => ({
            left: `${pan().x + n().x * zoom()}px`,
            top: `${pan().y + n().y * zoom()}px`,
            width: `${(n().w ?? 160) * zoom()}px`,
            minHeight: `${Math.max(24, n().h ?? 24) * zoom()}px`,
          });
          return (
            <textarea
              class="absolute z-30 resize-none rounded-md border border-accent bg-surface p-1.5 text-[13px] outline-none"
              style={p()}
              value={n().text ?? ""}
              onInput={(e) => setText(n().id, e.currentTarget.value)}
              onBlur={() => setEditingId(null)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditingId(null);
                e.stopPropagation();
              }}
              autofocus
            />
          );
        }}
      </Show>

      {/* issue/PR picker — placed when a mention card lands */}
      <Show when={picking()}>
        {(n) => (
          <IssuePicker
            project={props.project}
            issues={issues.latest ?? []}
            node={n()}
            pan={pan()}
            zoom={zoom()}
            onPick={(issue) => {
              commit((ns) =>
                ns.map((x) =>
                  x.id === n().id ? { ...x, issue_id: issue.id } : x,
                ),
              );
              setPicking(null);
            }}
            onCancel={() => {
              commit((ns) => ns.filter((x) => x.id !== n().id));
              setPicking(null);
            }}
          />
        )}
      </Show>
    </div>
  );
}

// createResource wrapper kept local so the canvas file stays self-contained.
function createResourceIssues(id: () => string) {
  return createResource(id, async (pid) => (await api.listIssues(pid)).issues);
}

function ToolBtn(props: {
  cur: Tool;
  id: Tool;
  label: string;
  onPick: (t: Tool) => void;
  children: JSX.Element;
}) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.cur === props.id}
      onClick={() => props.onPick(props.id)}
      class={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
        props.cur === props.id
          ? "bg-accent text-white"
          : "text-muted hover:bg-hover hover:text-fg"
      }`}
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="h-4 w-4"
      >
        {props.children}
      </svg>
    </button>
  );
}

function BoardNodeView(props: {
  node: BoardNode;
  project: Project;
  issue?: Issue;
  selected: boolean;
  editing: boolean;
  onDown: (e: PointerEvent, n: BoardNode) => void;
  onText: (id: string, s: string) => void;
  onDblClick: () => void;
  onOpenIssue: (id: string) => void;
}) {
  const selCls = () =>
    props.selected ? "stroke-accent" : "stroke-border";
  return (
    <g
      onPointerDown={(e) => props.onDown(e, props.node)}
      onDblClick={(e) => {
        e.stopPropagation();
        props.onDblClick();
      }}
      class="cursor-move"
    >
      <Show
        when={props.node.kind === "arrow"}
        fallback={
          <>
            {/* shape body */}
            <Show when={props.node.kind === "rect"}>
              <rect
                x={props.node.x}
                y={props.node.y}
                width={props.node.w ?? 0}
                height={props.node.h ?? 0}
                rx={4}
                class={`fill-surface stroke-2 ${selCls()}`}
              />
            </Show>
            <Show when={props.node.kind === "ellipse"}>
              <ellipse
                cx={props.node.x + (props.node.w ?? 0) / 2}
                cy={props.node.y + (props.node.h ?? 0) / 2}
                rx={(props.node.w ?? 0) / 2}
                ry={(props.node.h ?? 0) / 2}
                class={`fill-surface stroke-2 ${selCls()}`}
              />
            </Show>
            <Show when={props.node.kind === "note"}>
              <rect
                x={props.node.x}
                y={props.node.y}
                width={props.node.w ?? 0}
                height={props.node.h ?? 0}
                rx={3}
                style={{ fill: `${props.node.color ?? NOTE_COLORS[0]}26` }}
                class={`stroke-2 ${selCls()}`}
              />
            </Show>
            <Show when={props.node.kind === "issue"}>
              <rect
                x={props.node.x}
                y={props.node.y}
                width={props.node.w ?? 190}
                height={props.node.h ?? 64}
                rx={6}
                class={`fill-surface stroke-2 ${selCls()}`}
              />
            </Show>
            {/* text */}
            <Show
              when={
                (props.node.kind === "note" ||
                  props.node.kind === "text" ||
                  props.node.kind === "rect" ||
                  props.node.kind === "ellipse") &&
                !props.editing
              }
            >
              <foreignObject
                x={props.node.x + 6}
                y={props.node.y + 6}
                width={Math.max(20, (props.node.w ?? 160) - 12)}
                height={Math.max(16, (props.node.h ?? 24) - 12)}
                pointer-events="none"
              >
                <div
                  class={`overflow-hidden text-[12.5px] leading-snug ${
                    props.node.kind === "text" ? "" : "p-1"
                  }`}
                  style={{ "white-space": "pre-wrap" }}
                >
                  {props.node.text || (
                    <span class="opacity-40">double-click to edit</span>
                  )}
                </div>
              </foreignObject>
            </Show>
            <Show when={props.node.kind === "issue"}>
              <foreignObject
                x={props.node.x}
                y={props.node.y}
                width={props.node.w ?? 190}
                height={props.node.h ?? 64}
                pointer-events="none"
              >
                <Show
                  when={props.issue}
                  fallback={
                    <div class="flex h-full flex-col items-center justify-center px-3 text-[11.5px] opacity-50">
                      {props.node.issue_id ? "Issue removed" : "Pick an issue"}
                    </div>
                  }
                >
                  {(i) => (
                    <div class="flex h-full flex-col justify-center px-3">
                      <span class="truncate text-[12px] font-medium">
                        <span class="font-mono text-[10.5px] text-accent">
                          {props.project.key}-{i().number}{" "}
                        </span>
                        <Show when={i().github?.kind === "pr"}>
                          <span class="text-violet-400">PR </span>
                        </Show>
                        {i().title}
                      </span>
                      <span class="mt-1 flex items-center gap-1.5 text-[10.5px] text-muted">
                        <StatusDot
                          status={i().status}
                          defs={statusDefs(props.project)}
                          class="h-1.5 w-1.5"
                        />
                        {i().status}
                        <Show when={isClosed(i().status, statusDefs(props.project))}>
                          <span class="opacity-60">(closed)</span>
                        </Show>
                      </span>
                    </div>
                  )}
                </Show>
              </foreignObject>
              {/* click-through overlay to open the issue */}
              <Show when={props.issue}>
                {(i) => (
                  <rect
                    x={props.node.x}
                    y={props.node.y}
                    width={props.node.w ?? 190}
                    height={props.node.h ?? 64}
                    fill="transparent"
                    onDblClick={(e) => {
                      e.stopPropagation();
                      props.onOpenIssue(i().id);
                    }}
                  />
                )}
              </Show>
            </Show>
            <Show when={props.selected}>
              <rect
                x={props.node.x - 4}
                y={props.node.y - 4}
                width={(props.node.w ?? 160) + 8}
                height={(props.node.h ?? 24) + 8}
                fill="none"
                rx={8}
                class="stroke-accent"
                stroke-dasharray="4 3"
                stroke-width="1.5"
              />
            </Show>
          </>
        }
      >
        {/* arrow */}
        <line
          x1={props.node.x}
          y1={props.node.y}
          x2={props.node.x2 ?? props.node.x}
          y2={props.node.y2 ?? props.node.y}
          marker-end="url(#board-arrow)"
          class={`stroke-2 ${props.selected ? "stroke-accent" : "stroke-fg"}`}
        />
        <line
          x1={props.node.x}
          y1={props.node.y}
          x2={props.node.x2 ?? props.node.x}
          y2={props.node.y2 ?? props.node.y}
          stroke="transparent"
          stroke-width="12"
        />
      </Show>
    </g>
  );
}

// Filterable picker for issues + PRs placed on the board.
function IssuePicker(props: {
  project: Project;
  issues: Issue[];
  node: BoardNode;
  pan: { x: number; y: number };
  zoom: number;
  onPick: (i: Issue) => void;
  onCancel: () => void;
}) {
  const [q, setQ] = createSignal("");
  const list = createMemo(() => {
    const needle = q().toLowerCase();
    const defs = statusDefs(props.project);
    return props.issues
      .filter(
        (i) =>
          !needle ||
          i.title.toLowerCase().includes(needle) ||
          `${props.project.key}-${i.number}`.toLowerCase().includes(needle) ||
          i.status.includes(needle),
      )
      .sort((a, b) => Number(isClosed(a.status, defs)) - Number(isClosed(b.status, defs)))
      .slice(0, 30);
  });

  const pos = createMemo(() => ({
    left: `${Math.min(window.innerWidth - 320, props.pan.x + props.node.x * props.zoom)}px`,
    top: `${props.pan.y + props.node.y * props.zoom + (props.node.h ?? 64) * props.zoom + 8}px`,
  }));

  return (
    <div
      class="absolute z-40 w-72 rounded-lg border border-border bg-surface shadow-xl"
      style={pos()}
    >
      <input
        class="w-full border-b border-border bg-transparent px-3 py-2 text-[12.5px] outline-none"
        placeholder="Search issues and PRs…"
        value={q()}
        onInput={(e) => setQ(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onCancel();
          e.stopPropagation();
        }}
        autofocus
      />
      <ul class="max-h-64 overflow-y-auto p-1">
        <For
          each={list()}
          fallback={<li class="px-3 py-2 text-[12px] text-muted">No matches</li>}
        >
          {(i) => (
            <li>
              <button
                type="button"
                onClick={() => props.onPick(i)}
                class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-hover"
              >
                <StatusDot
                  status={i.status}
                  defs={statusDefs(props.project)}
                  class="h-2 w-2 shrink-0"
                />
                <span class="shrink-0 font-mono text-[10.5px] text-accent">
                  {props.project.key}-{i.number}
                </span>
                <Show when={i.github?.kind === "pr"}>
                  <span class="shrink-0 rounded border border-border px-1 text-[9.5px] text-violet-400">
                    PR
                  </span>
                </Show>
                <span class="min-w-0 flex-1 truncate">{i.title}</span>
              </button>
            </li>
          )}
        </For>
      </ul>
      <button
        type="button"
        onClick={props.onCancel}
        class="w-full border-t border-border px-3 py-1.5 text-[11.5px] text-muted hover:text-fg"
      >
        Cancel
      </button>
    </div>
  );
}
