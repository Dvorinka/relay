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

export default function Register() {
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
      await session.register({
        name: String(data.get("name") ?? ""),
        email: String(data.get("email") ?? ""),
        password: String(data.get("password") ?? ""),
      });
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
      title="Create your account"
      footer={
        <>
          Already have an account?{" "}
          <A href="/login" class="text-fg underline-offset-2 hover:underline">
            Sign in
          </A>
        </>
      }
    >
      <form onSubmit={onSubmit} class="flex flex-col gap-4">
        <Field label="Name">
          <input
            type="text"
            name="name"
            required
            autocomplete="name"
            class={inputClass}
          />
        </Field>
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
            minlength={8}
            autocomplete="new-password"
            class={inputClass}
          />
        </Field>
        <FormError message={error()} />
        <SubmitButton pending={pending()} class="w-full">
          {pending() ? "Creating account..." : "Create account"}
        </SubmitButton>
      </form>
    </AuthLayout>
  );
}
