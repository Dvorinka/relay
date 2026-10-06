import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { useTheme } from "../../stores/theme";
import { primaryButtonClass } from "../../components/ui";
import { XIcon } from "../../components/icons";
import type { CanvasHandle, SceneDraft } from "./excalidrawCanvas";

// SceneEditor is a near-fullscreen modal hosting the real Excalidraw canvas
// (mounted as a React island — see excalidrawCanvas.ts). The heavy chunk
// loads on demand. onSave receives the serialized Excalidraw scene; briefs
// and ideas both persist that same JSON shape.
export function SceneEditor(props: {
  title: string;
  hint?: string;
  saveLabel?: string;
  scene: Record<string, unknown> | undefined;
  onSave: (scene: Record<string, unknown>) => Promise<void>;
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
        scene: props.scene ?? {},
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
      // collaborators is a Map — JSON.stringify turns it into {} and the
      // next restore crashes on forEach. Non-serializable runtime state,
      // not scene data; drop it.
      const { collaborators: _c, ...appState } = d.appState;
      await props.onSave({
        type: "excalidraw",
        version: 2,
        elements: d.elements,
        appState,
        files: d.files,
      });
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
              Edit — {props.title}
            </h3>
            <p class="text-[11px] text-muted">
              {props.hint ??
                "Full Excalidraw canvas. Agents read and revise the same scene."}
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
              {saving() ? "Saving…" : (props.saveLabel ?? "Save")}
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
