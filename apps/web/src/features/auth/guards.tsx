import { Navigate } from "@solidjs/router";
import { Show, type ParentProps } from "solid-js";
import { FullPageSpinner } from "../../components/ui";
import { useSession } from "../../stores/session";

/**
 * Blocks rendering until the session resolves; redirects to /login when
 * unauthenticated. Wraps the app shell so no authed UI flashes for anon users.
 */
export function RequireAuth(props: ParentProps) {
  const session = useSession();
  return (
    <Show when={!session.loading()} fallback={<FullPageSpinner />}>
      <Show when={session.user()} fallback={<Navigate href="/login" />}>
        {props.children}
      </Show>
    </Show>
  );
}

/** Inverse of RequireAuth: sends signed-in users back to /. */
export function RequireAnon(props: ParentProps) {
  const session = useSession();
  return (
    <Show when={!session.loading()} fallback={<FullPageSpinner />}>
      <Show when={!session.user()} fallback={<Navigate href="/" />}>
        {props.children}
      </Show>
    </Show>
  );
}
