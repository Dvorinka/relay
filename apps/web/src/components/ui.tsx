import { Dialog } from "@ark-ui/solid";
import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  Show,
  type JSX,
  type ParentProps,
} from "solid-js";
import { Portal } from "solid-js/web";

export const inputClass =
  "w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-[13px] text-fg outline-none transition-colors placeholder:text-muted/60 focus:border-accent";

export const primaryButtonClass =
  "inline-flex h-8 items-center justify-center rounded-md bg-fg px-3 text-[13px] font-medium text-bg transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-50";

export function Field(props: ParentProps<{ label: string }>) {
  return (
    <label class="block">
      <span class="mb-1.5 block text-[13px] font-medium">{props.label}</span>
      {props.children}
    </label>
  );
}

export function FormError(props: { message: string | null }) {
  return (
    <Show when={props.message}>
      {(msg) => <p class="text-[13px] text-red-600 dark:text-red-400">{msg()}</p>}
    </Show>
  );
}

// Curated swatch set - matches the accent + author palettes the rest of the
// app uses, so picked colors always read as on-theme.
const COLOR_SWATCHES = [
  "#06b6d4", "#0ea5e9", "#3b82f6", "#6366f1", "#8b5cf6", "#a855f7",
  "#d946ef", "#db2777", "#f43f5e", "#ef4444", "#f97316", "#ca8a04",
  "#eab308", "#84cc16", "#16a34a", "#0d9488", "#14b8a6", "#64748b",
] as const;

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// ColorField replaces <input type="color"> - a themed swatch grid plus a hex
// field in a small popover. Fully custom; no native color widget anywhere.
export function ColorField(props: {
  value: string;
  onPick: (hex: string) => void;
  label?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = createSignal(false);
  const [hex, setHex] = createSignal(props.value || "#06b6d4");
  let rootEl: HTMLDivElement | undefined;

  createEffect(() => setHex(props.value || "#06b6d4"));
  createEffect(() => {
    if (!open()) return;
    const onDown = (e: PointerEvent) => {
      if (rootEl && !rootEl.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    });
  });

  const pick = (v: string) => {
    props.onPick(v);
    setHex(v);
  };
  const commitHex = () => {
    const v = hex().trim().toLowerCase();
    if (HEX_RE.test(v)) {
      pick(v);
      setOpen(false);
    }
  };

  return (
    <div class="relative" ref={(el) => (rootEl = el)}>
      <button
        type="button"
        disabled={props.disabled}
        aria-label={props.label ?? "Pick a color"}
        title={props.label ?? "Pick a color"}
        onClick={() => setOpen((v) => !v)}
        class="h-8 w-9 shrink-0 cursor-pointer rounded-md border border-border p-0.5 transition-colors hover:border-border-hi disabled:opacity-50"
      >
        <span
          class="block h-full w-full rounded-[5px]"
          style={{ "background-color": props.value || "#06b6d4" }}
        />
      </button>
      <Show when={open()}>
        <div class="absolute left-0 top-full z-40 mt-1.5 w-[196px] rounded-xl border border-border bg-surface p-2.5 shadow-xl">
          <div class="grid grid-cols-6 gap-1.5">
            <For each={COLOR_SWATCHES}>
              {(c) => (
                <button
                  type="button"
                  aria-label={c}
                  onClick={() => {
                    pick(c);
                    setOpen(false);
                  }}
                  class={`h-6 w-6 rounded-md border transition-transform hover:scale-110 ${
                    c === props.value
                      ? "border-fg ring-1 ring-fg"
                      : "border-transparent"
                  }`}
                  style={{ "background-color": c }}
                />
              )}
            </For>
          </div>
          <div class="mt-2 flex items-center gap-1.5">
            <input
              type="text"
              value={hex()}
              onInput={(e) => setHex(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && commitHex()}
              placeholder="#rrggbb"
              maxlength={7}
              aria-label="Hex color"
              class={`${inputClass} font-mono`}
            />
            <button
              type="button"
              onClick={commitHex}
              disabled={!HEX_RE.test(hex().trim())}
              class="inline-flex h-8 shrink-0 items-center rounded-md border border-border px-2 text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
            >
              Set
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}

// ConfirmDialog is the app's single confirmation surface - every destructive
// or irreversible click funnels here instead of window.confirm.
export function ConfirmDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body?: JSX.Element | string;
  confirmLabel?: string;
  pending?: boolean;
  danger?: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(d) => props.onOpenChange(d.open)}
    >
      <Portal>
        <Dialog.Backdrop class="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Positioner class="fixed inset-0 z-50 flex items-center justify-center p-4">
          <Dialog.Content class="w-full max-w-sm rounded-xl border border-border bg-surface p-5 shadow-xl">
            <Dialog.Title class="text-[15px] font-semibold">
              {props.title}
            </Dialog.Title>
            <Show when={props.body !== undefined}>
              <Dialog.Description class="mt-1.5 text-[13px] text-muted">
                {props.body}
              </Dialog.Description>
            </Show>
            <div class="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => props.onOpenChange(false)}
                class="rounded-md px-3 py-1.5 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={props.pending}
                onClick={props.onConfirm}
                class={`${primaryButtonClass} ${
                  props.danger === false
                    ? ""
                    : "!bg-red-600 !text-white hover:!opacity-90 dark:!bg-red-600"
                }`}
              >
                {props.confirmLabel ?? "Confirm"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

export function Spinner(props: { class?: string }) {
  return (
    <div
      class={`animate-spin rounded-full border-2 border-border border-t-accent ${props.class ?? "h-5 w-5"}`}
      role="status"
      aria-label="Loading"
    />
  );
}

export function FullPageSpinner() {
  return (
    <div class="flex h-full min-h-0 flex-1 items-center justify-center">
      <Spinner />
    </div>
  );
}

export function SubmitButton(
  props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { pending?: boolean },
) {
  const { pending, class: className, ...rest } = props;
  return (
    <button
      type="submit"
      {...rest}
      disabled={props.disabled || pending}
      class={`${primaryButtonClass} ${className ?? ""}`}
    />
  );
}

// ImageURLField is the "paste a link, we fetch it" alternative to a file
// picker on every avatar/icon surface — the server downloads, validates and
// stores the image, so the user never touches a file manager.
export function ImageURLField(props: {
  onSubmit: (url: string) => Promise<unknown> | unknown;
  placeholder?: string;
}) {
  const [url, setUrl] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal("");
  const submit = async () => {
    const u = url().trim();
    if (!u || busy()) return;
    setBusy(true);
    setErr("");
    try {
      await props.onSubmit(u);
      setUrl("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not set image");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <div class="flex gap-1.5">
        <input
          type="url"
          value={url()}
          onInput={(e) => setUrl(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          placeholder={props.placeholder ?? "https://example.com/icon.png"}
          aria-label="Image URL"
          class={`${inputClass} flex-1`}
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy() || !url().trim()}
          class={primaryButtonClass}
        >
          Set
        </button>
      </div>
      <Show when={err()}>
        {(msg) => <p class="mt-1 text-[11.5px] text-red-600 dark:text-red-400">{msg()}</p>}
      </Show>
    </div>
  );
}
