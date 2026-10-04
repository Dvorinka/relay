import { A } from "@solidjs/router";
import { ApiClientError, createClient } from "@relay/api-client";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import {
  Field,
  FormError,
  Spinner,
  SubmitButton,
  inputClass,
} from "../../components/ui";
import {
  desktopOpen,
  desktopServerUrl,
  isDesktop,
} from "../../lib/desktop";
import { net } from "../../lib/net";
import { useSession } from "../../stores/session";
import { AuthLayout } from "./AuthLayout";

export default function Login() {
  const session = useSession();
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);
  const [showServer, setShowServer] = createSignal(!!net.serverUrl());
  const [serverUrl, setServerUrl] = createSignal(net.serverUrl());
  // Browser sign-in (desktop shell): start mints a code on the target server,
  // the system browser approves it, we poll until it lands. The timer id in
  // browserPoll doubles as the "waiting" state.
  const [browserPoll, setBrowserPoll] = createSignal<number | null>(null);
  // The proxied SPA clears localStorage relay.serverUrl on purpose (same-origin
  // calls), so in the desktop shell the configured URL only exists in Go —
  // fetched once for the browser sign-in open URL.
  const [shellUrl, setShellUrl] = createSignal("");
  // "Different server" and "Work locally" only exist where the API isn't
  // same-origin: the desktop app or a cross-origin SPA. On a hosted
  // server's own web UI they would point at itself — meaningless.
  const altPaths = () => isDesktop() || !!net.serverUrl();

  onMount(() => {
    if (isDesktop() && !net.serverUrl()) {
      void desktopServerUrl().then(setShellUrl);
    }
  });

  onCleanup(() => {
    const t = browserPoll();
    if (t !== null) window.clearInterval(t);
  });

  function stopBrowserAuth() {
    const t = browserPoll();
    if (t !== null) window.clearInterval(t);
    setBrowserPoll(null);
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
    const client = createClient(url);
    let code: string;
    try {
      const res = await client.browserAuthStart();
      code = res.code;
    } catch {
      setError("Could not reach that server");
      return;
    }
    const opened = await desktopOpen(
      `${url}/connect?code=${encodeURIComponent(code)}`,
    );
    if (!opened) {
      setError("Could not open the system browser");
      return;
    }
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const res = await client.browserAuthPoll(code);
          if (res.status === "approved" && res.token) {
            stopBrowserAuth();
            await session.adoptToken(url, res.token);
          }
        } catch {
          stopBrowserAuth();
          setError("The approval code expired — try again");
        }
      })();
    }, 2000);
    setBrowserPoll(timer);
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
        err instanceof ApiClientError && err.status === 401
          ? "Invalid email or password"
          : err instanceof Error
            ? err.message
            : "Sign in failed",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthLayout
      title="Sign in"
      footer={
        <>
          New here?{" "}
          <A href="/register" class="text-fg underline-offset-2 hover:underline">
            Create an account
          </A>
        </>
      }
    >
      <form onSubmit={onSubmit} class="flex flex-col gap-4">
        <Field label="Email">
          <input
            type="email"
            name="email"
            required
            autocomplete="email"
            class={inputClass}
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            name="password"
            required
            autocomplete="current-password"
            class={inputClass}
          />
        </Field>
        <Show when={showServer()}>
          <Field label="Server URL">
            <input
              type="url"
              name="server_url"
              placeholder="https://relay.example.com"
              value={serverUrl()}
              onInput={(e) => setServerUrl(e.currentTarget.value)}
              class={inputClass}
            />
          </Field>
        </Show>
        <div class="flex items-center justify-between">
          <Show
            when={altPaths()}
            fallback={<span />}
          >
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
            class="text-[13px] text-muted underline-offset-2 hover:text-fg hover:underline"
          >
            Forgot password?
          </A>
        </div>
        <FormError message={error()} />
        <SubmitButton pending={pending()} class="w-full">
          {pending() ? "Signing in..." : "Sign in"}
        </SubmitButton>
      </form>
      <Show when={isDesktop()}>
        <div class="mt-5 border-t border-border pt-4">
          <Show
            when={browserPoll() === null}
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
