import { A, useSearchParams } from "@solidjs/router";
import { ApiClientError } from "@relay/api-client";
import { createSignal, Show } from "solid-js";
import { FormError } from "../../components/ui";
import { api } from "../../lib/api";
import {
  AuthField,
  AuthLayout,
  authButtonClass,
  authInputClass,
} from "./AuthLayout";

export default function ResetPassword() {
  const [params] = useSearchParams<{ token?: string }>();
  const token = () =>
    typeof params.token === "string" ? params.token : undefined;

  const [error, setError] = createSignal<string | null>(null);
  const [done, setDone] = createSignal(false);
  const [pending, setPending] = createSignal(false);

  async function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    const data = new FormData(e.currentTarget as HTMLFormElement);
    const password = String(data.get("password") ?? "");
    const confirm = String(data.get("confirm") ?? "");
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setError(null);
    setPending(true);
    try {
      await api.resetPassword(token() ?? "", password);
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiClientError && err.status === 400
          ? "This reset link is invalid or has expired"
          : err instanceof Error
            ? err.message
            : "Reset failed",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthLayout
      title="Set a new password"
      subtitle="Choose a strong password for your account"
    >
      <Show
        when={token()}
        fallback={
          <p class="text-[13px] text-muted">
            This reset link is missing its token. Request a{" "}
            <A href="/forgot" class="text-fg underline-offset-2 hover:underline">
              new one
            </A>
            .
          </p>
        }
      >
        <Show
          when={!done()}
          fallback={
            <p class="text-[13px] text-muted">
              Password updated.{" "}
              <A
                href="/login"
                class="text-fg underline-offset-2 hover:underline"
              >
                Sign in
              </A>{" "}
              with your new password.
            </p>
          }
        >
          <form onSubmit={onSubmit} class="flex flex-col gap-5">
            <AuthField label="New password">
              <input
                type="password"
                name="password"
                required
                autocomplete="new-password"
                class={authInputClass}
              />
            </AuthField>
            <AuthField label="Confirm password">
              <input
                type="password"
                name="confirm"
                required
                autocomplete="new-password"
                class={authInputClass}
              />
            </AuthField>
            <FormError message={error()} />
            <button type="submit" disabled={pending()} class={authButtonClass}>
              {pending() ? "Updating..." : "Update password"}
            </button>
          </form>
        </Show>
      </Show>
    </AuthLayout>
  );
}
