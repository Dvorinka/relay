import { createSignal, Show, type JSX, type ParentProps } from "solid-js";

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
