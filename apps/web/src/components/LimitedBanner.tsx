import { createSignal, onMount, Show } from "solid-js";
import { net } from "../lib/net";

// Slim notice shown when the connected server is a limited hosted tier
// (RELAY_LIMITED): uploads are compressed and capped. Dismiss persists per
// host — the point is awareness once, not a permanent nag.
export function LimitedBanner() {
  const [uploadMiB, setUploadMiB] = createSignal(0);
  const dismissKey = () => `relay.limitedDismissed.${net.serverUrl() || location.host}`;
  const [dismissed, setDismissed] = createSignal(
    localStorage.getItem(dismissKey()) === "1",
  );

  onMount(async () => {
    if (net.isLocal() || dismissed()) return;
    try {
      const r = await fetch(
        (net.serverUrl() || "") + "/api/health",
        { cache: "no-store" },
      );
      if (!r.ok) return;
      const body = (await r.json()) as {
        limited?: boolean;
        limits?: { upload_mib?: number };
      };
      if (body.limited) setUploadMiB(body.limits?.upload_mib ?? 0);
    } catch {
      /* unreachable — ServerBanner owns that case */
    }
  });

  function dismiss() {
    localStorage.setItem(dismissKey(), "1");
    setDismissed(true);
  }

  return (
    <Show when={uploadMiB() > 0 && !dismissed()}>
      <div class="flex items-center gap-2 border-b border-border bg-surface px-3 py-1.5 text-[12.5px] text-muted">
        <span class="flex-1 truncate">
          Free hosted Relay — uploads are compressed and capped at {uploadMiB()}{" "}
          MiB.{" "}
          <a
            href="https://github.com/Dvorinka/relay#quick-start"
            target="_blank"
            rel="noreferrer"
            class="text-accent underline-offset-2 hover:underline"
          >
            Self-host for the full thing →
          </a>
        </span>
        <button
          type="button"
          aria-label="Dismiss"
          class="shrink-0 text-muted transition-colors hover:text-fg"
          onClick={dismiss}
        >
          ✕
        </button>
      </div>
    </Show>
  );
}
