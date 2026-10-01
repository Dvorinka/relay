import { A, useSearchParams } from "@solidjs/router";
import { ApiClientError } from "@relay/api-client";
import { createSignal, Show } from "solid-js";
import {
  Field,
  FormError,
  SubmitButton,
  inputClass,
} from "../../components/ui";
import { api } from "../../lib/api";
import { AuthLayout } from "./AuthLayout";

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
    <AuthLayout title="Set a new password">
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
          <form onSubmit={onSubmit} class="flex flex-col gap-4">
            <Field label="New password">
              <input
                type="password"
                name="password"
                required
                minlength={8}
                autocomplete="new-password"
                class={inputClass}
              />
            </Field>
            <Field label="Confirm password">
              <input
                type="password"
                name="confirm"
                required
                minlength={8}
                autocomplete="new-password"
                class={inputClass}
              />
            </Field>
            <FormError message={error()} />
            <SubmitButton pending={pending()} class="w-full">
              {pending() ? "Updating..." : "Update password"}
            </SubmitButton>
          </form>
        </Show>
      </Show>
    </AuthLayout>
  );
}
