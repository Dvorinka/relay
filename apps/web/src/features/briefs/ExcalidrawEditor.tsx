import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type { Brief } from "@relay/api-client";
import { api } from "../../lib/api";
import { useTheme } from "../../stores/theme";
import { primaryButtonClass } from "../../components/ui";
import { XIcon } from "../../components/icons";
import type { CanvasHandle, SceneDraft } from "./excalidrawCanvas";

// ExcalidrawEditor is a near-fullscreen modal hosting the real Excalidraw
// canvas (mounted as a React island — see excalidrawCanvas.ts). The heavy
// chunk loads on demand. Save persists the Excalidraw scene back onto the
// brief so agents see the exact same JSON the user drew.
export function ExcalidrawEditor(props: {
  brief: Brief;
  onSaved: (b: Brief) => void;
  onClose: () => void;
}) {
  const { theme } = useTheme();
  let host: HTMLDivElement | undefined;
  let canvas: CanvasHandle | undefined;
  const [ready, setReady] = createSignal(false);
  const [dirty, setDirty] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [err, setErr] = createSignal("");

  onMount(async () => {
    try {
      const { mountCanvas } = await import("./excalidrawCanvas");
      if (!host) return;
      canvas = mountCanvas(host, {
        scene: props.brief.scene ?? {},
        theme: theme(),
        onChange: () => setDirty(true),
      });
      setReady(true);
    } catch {
      setErr("Could not load the editor.");
    }
  });
  onCleanup(() => canvas?.unmount());

  const save = async () => {
    if (!canvas || saving()) return;
    setSaving(true);
    setErr("");
    try {
      const d: SceneDraft = canvas.scene();
      const updated = await api.updateBrief(props.brief.id, {
        scene: {
          type: "excalidraw",
          version: 2,
          elements: d.elements,
          appState: d.appState,
          files: d.files,
        },
      });
      props.onSaved(updated);
    } catch {
      setErr("Save failed — try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      class="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4"
      onKeyDown={(e) => {
        // Excalidraw owns Escape (deselect/tool); only close via the button.
        if (e.key === "Escape") e.stopPropagation();
      }}
    >
      <div class="flex h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
        <div class="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div class="min-w-0">
            <h3 class="truncate text-[14px] font-semibold">
              Edit — {props.brief.title}
            </h3>
            <p class="text-[11px] text-muted">
              Full Excalidraw canvas. Agents read and revise the same scene.
            </p>
          </div>
          <div class="flex items-center gap-2">
            <Show when={err()}>
              <span class="text-[12px] text-red-500">{err()}</span>
            </Show>
            <Show when={dirty()}>
              <span class="text-[11px] text-muted">unsaved changes</span>
            </Show>
            <button
              type="button"
              onClick={save}
              disabled={saving() || !ready()}
              class={primaryButtonClass}
            >
              {saving() ? "Saving…" : "Save to brief"}
            </button>
            <button
              type="button"
              onClick={props.onClose}
              aria-label="Close editor"
              class="rounded p-1 text-muted transition-colors hover:bg-hover hover:text-fg"
            >
              <XIcon class="h-4 w-4" />
            </button>
          </div>
        </div>
        <div class="relative min-h-0 flex-1">
          <Show when={!ready()}>
            <p class="absolute inset-0 grid place-items-center text-[13px] text-muted">
              Loading editor…
            </p>
          </Show>
          <div ref={(el) => (host = el)} class="absolute inset-0" />
        </div>
      </div>
    </div>
  );
}
