// Server-reachability strips under the top bar.
// Connected + server down: amber strip — cached data stays on screen, a
// probe loop reconnects on its own, and "Work locally" is offered where
// local mode exists.
// Local mode + remembered server back: emerald strip offering one-click
// sync-and-reconnect; while it's still down a dim strip says we're waiting.
import { useNavigate } from "@solidjs/router";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { connections } from "../lib/connections";
import { desktopServerUrl, isDesktop, isMobileShell } from "../lib/desktop";
import { net } from "../lib/net";
import {
  onServerUp,
  probeNow,
  serverState,
  watchServer,
} from "../lib/offline";
import { syncWithToken } from "../lib/sync";
import { useSession } from "../stores/session";
import { refreshUnread } from "../stores/unread";
import { Spinner } from "./ui";

export function ServerBanner() {
  const session = useSession();
  const navigate = useNavigate();
  const [retrying, setRetrying] = createSignal(false);
  const [syncing, setSyncing] = createSignal(false);
  const [syncErr, setSyncErr] = createSignal("");
  const [shellUrl, setShellUrl] = createSignal("");

  const activeOrigin = () => net.serverUrl() || location.origin;
  const host = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  };
  const down = () =>
    !net.isLocal() && serverState(activeOrigin()) === "down";

  // Local mode keeps the last server URL (net.serverUrl, or the desktop
  // shell's config): watch it so "back online" appears without a reload.
  const remembered = () => net.serverUrl() || shellUrl();
  const rememberedState = () =>
    remembered() ? serverState(remembered()) : "unknown";
  const savedConn = () =>
    connections().find((c) => c.url === remembered() && c.token);

  // "Work locally" exists on the shells and cross-origin builds only —
  // same rule the login page and settings use.
  const altPaths = () => isDesktop() || isMobileShell() || !!net.serverUrl();

  onMount(() => {
    const off = onServerUp((origin) => {
      // Active server recovered: pull fresh session + unread state.
      if (!net.isLocal() && origin === activeOrigin()) {
        void session.refresh();
        void refreshUnread();
      }
    });
    onCleanup(off);
    if (net.isLocal()) {
      void desktopServerUrl().then((u) => {
        setShellUrl(u);
        const r = net.serverUrl() || u;
        if (r) watchServer(r);
      });
    } else {
      watchServer(activeOrigin());
    }
  });

  async function retryNow() {
    setRetrying(true);
    try {
      await probeNow(activeOrigin());
    } finally {
      setRetrying(false);
    }
  }

  // Saved-connection token present → replay local changes then adopt that
  // session; without one the Settings connect form is the path.
  async function reconnect() {
    const c = savedConn();
    if (!c) {
      navigate("/app/settings");
      return;
    }
    setSyncing(true);
    setSyncErr("");
    try {
      await syncWithToken(c.url, c.token);
      await session.adoptToken(c.url, c.token);
    } catch (e) {
      setSyncErr(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <>
      <Show when={down()}>
        <div class="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[12.5px] text-amber-600 dark:text-amber-400">
          <span class="h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-500" />
          <span class="min-w-0 flex-1 truncate">
            Can't reach {host(activeOrigin())} — showing last saved data.
            Reconnecting automatically.
          </span>
          <button
            type="button"
            onClick={() => void retryNow()}
            disabled={retrying()}
            class="shrink-0 rounded border border-amber-500/40 px-2 py-0.5 text-[11.5px] transition-colors hover:bg-amber-500/20"
          >
            {retrying() ? "Checking…" : "Retry now"}
          </button>
          <Show when={altPaths()}>
            <button
              type="button"
              onClick={() => void session.enterLocal()}
              class="shrink-0 rounded border border-amber-500/40 px-2 py-0.5 text-[11.5px] transition-colors hover:bg-amber-500/20"
            >
              Work locally
            </button>
          </Show>
        </div>
      </Show>
      <Show when={net.isLocal() && rememberedState() === "up"}>
        <div class="flex items-center gap-2 border-b border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-[12.5px] text-emerald-600 dark:text-emerald-400">
          <span class="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
          <span class="min-w-0 flex-1 truncate">
            {host(remembered())} is back online.
            <Show when={syncErr()}>
              <span class="text-red-500"> {syncErr()}</span>
            </Show>
          </span>
          <button
            type="button"
            onClick={() => void reconnect()}
            disabled={syncing()}
            class="flex shrink-0 items-center gap-1.5 rounded border border-emerald-500/40 px-2 py-0.5 text-[11.5px] transition-colors hover:bg-emerald-500/20"
          >
            <Show when={syncing()}>
              <Spinner class="h-3 w-3" />
            </Show>
            {syncing()
              ? "Syncing…"
              : savedConn()
                ? "Sync local changes & reconnect"
                : "Reconnect"}
          </button>
        </div>
      </Show>
      <Show when={net.isLocal() && rememberedState() === "down"}>
        <div class="flex items-center gap-2 border-b border-border bg-surface px-3 py-1.5 text-[12.5px] text-muted">
          <span class="h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-500" />
          <span class="min-w-0 flex-1 truncate">
            Waiting for {host(remembered())} to come back — everything stays
            on this device.
          </span>
        </div>
      </Show>
    </>
  );
}
