import { A } from "@solidjs/router";
import { createSignal, Show } from "solid-js";
import {
  Field,
  SubmitButton,
  inputClass,
} from "../../components/ui";
import { api } from "../../lib/api";
import { AuthLayout } from "./AuthLayout";

export default function ForgotPassword() {
  const [sent, setSent] = createSignal(false);
  const [pending, setPending] = createSignal(false);

  async function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    const data = new FormData(e.currentTarget as HTMLFormElement);
    setPending(true);
    try {
      // Always 204 by design; never reveals whether the email exists.
      await api.forgotPassword(String(data.get("email") ?? ""));
    } catch {
      // Even a failure shows the same message — no account enumeration.
    } finally {
      setSent(true);
      setPending(false);
    }
  }

  return (
    <AuthLayout
      title="Reset your password"
      footer={
        <>
          Remembered it?{" "}
          <A href="/login" class="text-fg underline-offset-2 hover:underline">
            Back to sign in
          </A>
        </>
      }
    >
      <Show
        when={!sent()}
        fallback={
          <p class="text-[13px] text-muted">
            If an account exists for that email, a reset link was sent.
          </p>
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
          <SubmitButton pending={pending()} class="w-full">
            {pending() ? "Sending..." : "Send reset link"}
          </SubmitButton>
        </form>
      </Show>
    </AuthLayout>
  );
}
