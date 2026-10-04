import { A } from "@solidjs/router";
import { ApiClientError } from "@relay/api-client";
import { createSignal, Show } from "solid-js";
import {
  Field,
  FormError,
  SubmitButton,
  inputClass,
} from "../../components/ui";
import { isDesktop } from "../../lib/desktop";
import { net } from "../../lib/net";
import { useSession } from "../../stores/session";
import { AuthLayout } from "./AuthLayout";

export default function Login() {
  const session = useSession();
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);
  const [showServer, setShowServer] = createSignal(!!net.serverUrl());
  // "Different server" and "Work locally" only exist where the API isn't
  // same-origin: the desktop app or a cross-origin SPA. On a hosted
  // server's own web UI they would point at itself — meaningless.
  const altPaths = () => isDesktop() || !!net.serverUrl();

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
              placeholder={window.location.origin}
              value={net.serverUrl()}
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
      <Show when={altPaths()}>
        <div class="mt-5 border-t border-border pt-4">
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
