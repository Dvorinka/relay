// React island: mounts the real Excalidraw editor inside a host element.
// This file deliberately avoids JSX — the app's .tsx pipeline is Solid's,
// and Solid's transform output is not a React tree. createElement keeps
// this module transform-agnostic.
//
// Loaded lazily from ExcalidrawEditor.tsx so React + Excalidraw (~1.5MB gz)
// only land in the bundle when someone opens an editor.

import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Excalidraw, restore } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";

export interface SceneDraft {
  elements: unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}

export interface CanvasHandle {
  scene: () => SceneDraft;
  unmount: () => void;
}

// Mounts Excalidraw into el. The scene we persist is the same JSON shape
// the MCP layer documents, so user-drawn and agent-drawn canvases are
// interchangeable. restore() repairs minimal agent-authored elements
// (missing seed/angle/etc.) before the editor sees them.
export function mountCanvas(
  el: HTMLElement,
  opts: {
    scene: Record<string, unknown>;
    theme: "light" | "dark";
    onChange: (draft: SceneDraft) => void;
  },
): CanvasHandle {
  const raw = opts.scene ?? {};
  const restored = restore(
    {
      elements: (Array.isArray(raw.elements) ? raw.elements : []) as never,
      appState: { ...(raw.appState as object), theme: opts.theme } as never,
      files: (raw.files ?? {}) as never,
    },
    null,
    null,
  );

  const draft: SceneDraft = {
    elements: [...restored.elements],
    appState: restored.appState as Record<string, unknown>,
    files: (restored.files ?? {}) as Record<string, unknown>,
  };

  const root: Root = createRoot(el);
  root.render(
    createElement(Excalidraw, {
      theme: opts.theme,
      initialData: {
        elements: restored.elements as never,
        appState: restored.appState as never,
        files: draft.files as never,
      },
      onChange: (
        elements: readonly unknown[],
        appState: unknown,
        files: unknown,
      ) => {
        draft.elements = [...elements];
        draft.appState = appState as Record<string, unknown>;
        draft.files = (files ?? {}) as Record<string, unknown>;
        opts.onChange(draft);
      },
    } as Parameters<typeof Excalidraw>[0]),
  );

  return {
    scene: () => draft,
    // Defer — React warns when a root unmounts while it may be rendering.
    unmount: () => queueMicrotask(() => root.unmount()),
  };
}
