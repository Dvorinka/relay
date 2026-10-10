import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { inputClass } from "./ui";
import { CheckIcon, ChevronDownIcon } from "./icons";

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
}

// Custom dropdown — replaces every native <select> so menus match the app's
// surfaces (border/bg-surface/shadow) instead of the OS picker. Keyboard:
// arrows move, Enter picks, Escape closes; outside click closes.
export function Select(props: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  class?: string;
  triggerClass?: string;
  disabled?: boolean;
  align?: "left" | "right";
}) {
  const [open, setOpen] = createSignal(false);
  const [active, setActive] = createSignal(0);
  let wrap: HTMLDivElement | undefined;

  const current = () =>
    props.options.find((o) => o.value === props.value) ??
    props.options[0] ?? { value: "", label: "" };

  const pick = (v: string) => {
    props.onChange(v);
    setOpen(false);
  };

  createEffect(() => {
    if (!open()) return;
    setActive(Math.max(0, props.options.findIndex((o) => o.value === props.value)));
    const onDoc = (e: MouseEvent) => {
      if (wrap && !wrap.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => Math.min(props.options.length - 1, a + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => Math.max(0, a - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const o = props.options[active()];
        if (o) pick(o.value);
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    });
  });

  return (
    <div ref={(el) => (wrap = el)} class={`relative ${props.class ?? ""}`}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-label={props.ariaLabel}
        onClick={() => setOpen(!open())}
        disabled={props.disabled}
        class={`${props.triggerClass ?? `${inputClass} !w-auto`} flex items-center gap-1.5 pr-6 disabled:cursor-not-allowed disabled:opacity-50`}
      >
        <span class="max-w-48 truncate">{current().label}</span>
        <ChevronDownIcon class="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
      </button>
      <Show when={open()}>
        <ul
          role="listbox"
          aria-label={props.ariaLabel}
          class={`absolute top-full z-40 mt-1 max-h-64 min-w-full w-max max-w-72 overflow-y-auto rounded-lg border border-border bg-surface py-1 shadow-xl ${
            props.align === "right" ? "right-0" : "left-0"
          }`}
        >
          <For each={props.options}>
            {(o, i) => (
              <li>
                <button
                  type="button"
                  role="option"
                  aria-selected={o.value === props.value}
                  onMouseEnter={() => setActive(i())}
                  onClick={() => pick(o.value)}
                  class={`flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-[12.5px] transition-colors ${
                    i() === active() ? "bg-hover" : ""
                  } ${o.value === props.value ? "font-medium text-accent" : ""}`}
                >
                  <span class="min-w-0 flex-1 truncate">{o.label}</span>
                  <Show when={o.hint}>
                    <span class="shrink-0 text-[11px] text-faint">{o.hint}</span>
                  </Show>
                  <Show when={o.value === props.value}>
                    <CheckIcon class="h-3.5 w-3.5 shrink-0" />
                  </Show>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
