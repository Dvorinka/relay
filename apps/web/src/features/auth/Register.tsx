import { A } from "@solidjs/router";
import { ApiClientError } from "@relay/api-client";
import { createSignal, Show } from "solid-js";
import { FormError } from "../../components/ui";
import { isDesktop, isMobileShell } from "../../lib/desktop";
import { net } from "../../lib/net";
import { useSession } from "../../stores/session";
import {
  AuthChoice,
  AuthField,
  AuthLayout,
  authButtonClass,
  authInputClass,
} from "./AuthLayout";

export default function Register() {
  const session = useSession();
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);
  const [serverUrl, setServerUrl] = createSignal(net.serverUrl());
  // Same first-run fork as Login: a shell with no configured server can't
  // register anywhere — ask local vs server before showing the form.
  const altPaths = () => isDesktop() || isMobileShell() || !!net.serverUrl();
  const [choseServer, setChoseServer] = createSignal(false);
  const showChoice = () =>
    altPaths() && !net.serverUrl() && !choseServer();

  async function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    const data = new FormData(e.currentTarget as HTMLFormElement);
    setError(null);
    setPending(true);
    try {
      // On success the store updates and RequireAnon redirects to /.
      await session.register(
        {
          name: String(data.get("name") ?? ""),
          email: String(data.get("email") ?? ""),
          password: String(data.get("password") ?? ""),
        },
        String(data.get("server_url") ?? "").trim() || undefined,
      );
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Registration failed",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthLayout
      title={showChoice() ? "How do you want to use Relay?" : "Create an account"}
      subtitle={showChoice() ? undefined : "Join your Relay workspace"}
      footer={
        showChoice() ? undefined : (
          <>
            Already have an account?{" "}
            <A href="/login" class="text-fg underline-offset-2 hover:underline">
              Sign in
            </A>
          </>
        )
      }
    >
      <Show
        when={!showChoice()}
        fallback={
          <AuthChoice
            onLocal={() => void session.enterLocal()}
            onServer={() => setChoseServer(true)}
          />
        }
      >
        <Show when={altPaths() && !net.serverUrl()}>
          <button
            type="button"
            class="mb-4 text-[13px] text-muted underline-offset-2 hover:text-fg hover:underline"
            onClick={() => setChoseServer(false)}
          >
            ← All options
          </button>
        </Show>
        <form onSubmit={onSubmit} class="flex flex-col gap-5">
          <Show when={altPaths()}>
            <AuthField label="Server URL">
              <input
                type="url"
                name="server_url"
                placeholder="https://relay.example.com"
                required={choseServer()}
                value={serverUrl()}
                onInput={(e) => setServerUrl(e.currentTarget.value)}
                class={authInputClass}
              />
            </AuthField>
          </Show>
          <AuthField label="Name">
            <input
              type="text"
              name="name"
              required
              autocomplete="name"
              class={authInputClass}
            />
          </AuthField>
          <AuthField label="Email">
            <input
              type="email"
              name="email"
              required
              autocomplete="email"
              class={authInputClass}
            />
          </AuthField>
          <AuthField label="Password">
            <input
              type="password"
              name="password"
              required
              autocomplete="new-password"
              class={authInputClass}
            />
          </AuthField>
          <FormError message={error()} />
          <button type="submit" disabled={pending()} class={authButtonClass}>
            {pending() ? "Creating account..." : "Create account"}
          </button>
        </form>
      </Show>
    </AuthLayout>
  );
}
