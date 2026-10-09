import { A } from "@solidjs/router";
import { ApiClientError } from "@relay/api-client";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { FormError, Spinner } from "../../components/ui";
import {
  browserAuth,
  desktopServerUrl,
  isDesktop,
  isMobileShell,
} from "../../lib/desktop";
import { net } from "../../lib/net";
import { useSession } from "../../stores/session";
import {
  AuthField,
  AuthLayout,
  authButtonClass,
  authInputClass,
} from "./AuthLayout";

export default function Login() {
  const session = useSession();
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);
  const [showServer, setShowServer] = createSignal(!!net.serverUrl());
  const [serverUrl, setServerUrl] = createSignal(net.serverUrl());
  // Browser sign-in (desktop shell): browserAuth() mints a code on the target
  // server, the system browser approves it, the promise resolves with a token.
  // browserPending is the "waiting" state; cancelAuth stops polling.
  const [browserPending, setBrowserPending] = createSignal(false);
  let cancelAuth: (() => void) | null = null;
  // The proxied SPA clears localStorage relay.serverUrl on purpose (same-origin
  // calls), so in the desktop shell the configured URL only exists in Go —
  // fetched once for the browser sign-in open URL.
  const [shellUrl, setShellUrl] = createSignal("");
  // "Different server" and "Work locally" only exist where the API isn't
  // same-origin: the desktop or mobile shell, or a cross-origin SPA. On a
  // hosted server's own web UI they would point at itself — meaningless.
  const altPaths = () => isDesktop() || isMobileShell() || !!net.serverUrl();

  onMount(() => {
    if (isDesktop() && !net.serverUrl()) {
      void desktopServerUrl().then(setShellUrl);
    }
  });

  onCleanup(() => cancelAuth?.());

  function stopBrowserAuth() {
    cancelAuth?.();
    setBrowserPending(false);
  }

  // The server URL field wins while it is visible; otherwise the stored
  // connection. In the desktop shell there is no same-origin fallback —
  // wails.localhost is the app's own proxy, not a Relay server.
  function targetServer(): string | null {
    const typed = serverUrl().trim().replace(/\/+$/, "");
    if (showServer() && typed) return typed;
    return (
      net.serverUrl() ||
      shellUrl() ||
      (isDesktop() ? null : window.location.origin)
    );
  }

  async function startBrowserAuth() {
    let url = targetServer();
    if (!url && isDesktop()) {
      // The onMount fetch may not have landed yet — ask the shell directly.
      const shell = await desktopServerUrl();
      if (shell) {
        setShellUrl(shell);
        url = shell;
      }
    }
    if (!url) {
      setShowServer(true);
      setError("Enter the server URL first");
      return;
    }
    setError(null);
    setBrowserPending(true);
    const { promise, cancel } = browserAuth(url);
    cancelAuth = cancel;
    try {
      const token = await promise;
      if (token !== null) await session.adoptToken(url, token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setBrowserPending(false);
      cancelAuth = null;
    }
  }

  async function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    const data = new FormData(e.currentTarget as HTMLFormElement);
    setError(null);
    setPending(true);
    try {
      // On success the store updates and RequireAnon redirects to /.
      await session.login(
        {
          email: String(data.get("email") ?? ""),
          password: String(data.get("password") ?? ""),
        },
        String(data.get("server_url") ?? "").trim() || undefined,
      );
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.status === 401
            ? "Invalid email or password"
            : err.message
          : "Can't reach that server — check the URL or try again shortly",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to continue to Relay"
      footer={
        <>
          New here?{" "}
          <A href="/register" class="text-fg underline-offset-2 hover:underline">
            Create an account
          </A>
        </>
      }
    >
      <form onSubmit={onSubmit} class="flex flex-col gap-5">
        <AuthField label="Email">
          <input
            type="email"
            name="email"
            required
            autocomplete="email"
            class={authInputClass}
          />
        </AuthField>
        <div>
          <AuthField label="Password">
            <input
              type="password"
              name="password"
              required
              autocomplete="current-password"
              class={authInputClass}
            />
          </AuthField>
          <div class="mt-1.5 flex items-center justify-between">
            <Show when={altPaths()} fallback={<span />}>
              <button
                type="button"
                class="text-[13px] text-muted underline-offset-2 hover:text-fg hover:underline"
                onClick={() => setShowServer((v) => !v)}
              >
                {showServer() ? "This server" : "Different server"}
              </button>
            </Show>
            <A
              href="/forgot"
              class="text-[13px] text-accent underline-offset-2 hover:underline"
            >
              Forgot password?
            </A>
          </div>
        </div>
        <Show when={showServer()}>
          <AuthField label="Server URL">
            <input
              type="url"
              name="server_url"
              placeholder="https://relay.example.com"
              value={serverUrl()}
              onInput={(e) => setServerUrl(e.currentTarget.value)}
              class={authInputClass}
            />
          </AuthField>
        </Show>
        <FormError message={error()} />
        <button
          type="submit"
          disabled={pending()}
          class={authButtonClass}
        >
          {pending() ? "Signing in..." : "Sign in"}
        </button>
      </form>
      <Show when={isDesktop()}>
        <div class="mt-5 border-t border-border pt-4">
          <Show
            when={!browserPending()}
            fallback={
              <div class="flex items-center gap-2.5 rounded-md border border-border bg-surface px-3 py-2.5">
                <Spinner class="h-3.5 w-3.5" />
                <p class="flex-1 text-[12.5px] text-muted">
                  Waiting for approval in your browser…
                </p>
                <button
                  type="button"
                  class="text-[12px] text-muted underline-offset-2 hover:text-fg hover:underline"
                  onClick={stopBrowserAuth}
                >
                  cancel
                </button>
              </div>
            }
          >
            <button
              type="button"
              class="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg"
              onClick={() => void startBrowserAuth()}
            >
              Sign in via browser — approve in your default browser
            </button>
          </Show>
        </div>
      </Show>
      <Show when={altPaths()}>
        <div class="mt-3">
          <button
            type="button"
            class="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg"
            onClick={() => session.enterLocal()}
          >
            Work locally on this device — no server needed
          </button>
        </div>
      </Show>
    </AuthLayout>
  );
}
