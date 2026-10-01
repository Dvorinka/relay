import { A } from "@solidjs/router";
import { ApiClientError } from "@relay/api-client";
import { createSignal } from "solid-js";
import {
  Field,
  FormError,
  SubmitButton,
  inputClass,
} from "../../components/ui";
import { useSession } from "../../stores/session";
import { AuthLayout } from "./AuthLayout";

export default function Login() {
  const session = useSession();
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);

  async function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    const data = new FormData(e.currentTarget as HTMLFormElement);
    setError(null);
    setPending(true);
    try {
      // On success the store updates and RequireAnon redirects to /.
      await session.login({
        email: String(data.get("email") ?? ""),
        password: String(data.get("password") ?? ""),
      });
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
        <div class="flex justify-end">
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
    </AuthLayout>
  );
}
