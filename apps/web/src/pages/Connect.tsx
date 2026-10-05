import { useNavigate, useSearchParams } from "@solidjs/router";
import { createSignal, Show } from "solid-js";
import { Spinner } from "../components/ui";
import { api } from "../lib/api";
import { ApiClientError } from "@relay/api-client";
import { useSession } from "../stores/session";

// Desktop-connect approval surface. The desktop shell starts a browser-auth
// code, opens the system browser here, the signed-in user approves it, and
// the desktop picks the resulting session up by polling. Codes are
// short-lived and single-use, enforced server-side.
export default function Connect() {
  const [params] = useSearchParams<{ code?: string }>();
  const session = useSession();
  const nav = useNavigate();
  const [done, setDone] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);

  const code = () => params.code ?? null;
  const shortCode = () => {
    const c = code();
    return c ? `${c.slice(0, 4)}…${c.slice(-4)}` : null;
  };

  async function approve() {
    const c = code();
    if (!c || pending()) return;
    setPending(true);
    setError(null);
    try {
      await api.browserAuthApprove(c);
      setDone(true);
    } catch (e) {
      if (e instanceof ApiClientError && e.status === 409) {
        setError("That code was already used or approved elsewhere.");
      } else if (
        e instanceof ApiClientError &&
        (e.status === 400 || e.status === 404)
      ) {
        setError("This code is expired or invalid — start over from the app.");
      } else {
        setError(e instanceof Error ? e.message : "Approval failed");
      }
    }
    setPending(false);
  }

  return (
    <div class="flex h-full items-center justify-center overflow-y-auto bg-bg p-6">
      <div class="w-full max-w-sm rounded-xl border border-border bg-surface p-6">
        <p class="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted">
          Relay
        </p>
        <h1 class="text-[17px] font-semibold tracking-tight">
          Connect the desktop app?
        </h1>
        <Show when={shortCode()}>
          <p class="mt-1.5 text-[13px] text-muted">
            Approval request{" "}
            <span class="font-mono text-[12px] text-fg">{shortCode()}</span>
          </p>
        </Show>
        <p class="mt-2 text-[12.5px] text-muted">
          Approving signs the desktop app into this server. The code expires
          after 10 minutes and works once.
        </p>
        <Show when={error()}>
          <p class="mt-3 rounded-md border border-red-600/40 bg-red-600/10 px-3 py-2 text-[12.5px] text-red-600 dark:text-red-400">
            {error()}
          </p>
        </Show>
        <div class="mt-5">
          <Show
            when={done()}
            fallback={
              <Show
                when={session.user()}
                fallback={
                  <button
                    type="button"
                    class="w-full rounded-md bg-fg px-3 py-2 text-[13px] font-medium text-bg transition-opacity hover:opacity-90"
                    onClick={() =>
                      nav(
                        `/login?next=${encodeURIComponent(`/connect?code=${code()}`)}`,
                      )
                    }
                  >
                    Sign in to approve
                  </button>
                }
              >
                <button
                  type="button"
                  class="flex w-full items-center justify-center gap-2 rounded-md bg-fg px-3 py-2 text-[13px] font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
                  disabled={pending() || !code()}
                  onClick={() => void approve()}
                >
                  <Show when={pending()}>
                    <Spinner class="h-3.5 w-3.5" />
                  </Show>
                  Approve as {session.user()?.name}
                </button>
              </Show>
            }
          >
            <div class="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-3 text-center text-[13px] text-emerald-700 dark:text-emerald-300">
              Approved — you can close this tab.
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
