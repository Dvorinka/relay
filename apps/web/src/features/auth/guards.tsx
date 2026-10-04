import { Navigate, useSearchParams } from "@solidjs/router";
import { Show, type ParentProps } from "solid-js";
import { FullPageSpinner } from "../../components/ui";
import { useSession } from "../../stores/session";

// Only same-site paths may be a redirect target — an absolute or
// scheme-relative URL would turn ?next= into an open redirector.
function safeNext(next: string | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/app";
}

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

/** Inverse of RequireAuth: sends signed-in users to ?next or /app. */
export function RequireAnon(props: ParentProps) {
  const session = useSession();
  const [params] = useSearchParams<{ next?: string }>();
  return (
    <Show when={!session.loading()} fallback={<FullPageSpinner />}>
      <Show
        when={!session.user()}
        fallback={<Navigate href={safeNext(params.next)} />}
      >
        {props.children}
      </Show>
    </Show>
  );
}
