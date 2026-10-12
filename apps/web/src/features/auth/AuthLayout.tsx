import type { JSX, ParentProps } from "solid-js";
import { RelayMark } from "../../components/icons";
import { RequireAnon } from "./guards";

const choiceCardClass =
  "w-full rounded-lg border border-border bg-surface px-4 py-3.5 text-left transition-colors hover:border-accent";
const choiceTitleClass = "text-[14px] font-medium text-fg";
const choiceBodyClass = "mt-1 text-[12.5px] leading-snug text-muted";

/**
 * First-run fork for shells that can run without a server (desktop, mobile,
 * cross-origin SPA): work locally, connect to a server, try the free hosted
 * instance, or self-host one. Without it the login form assumes a server
 * exists and the local path hides as a footnote — newcomers registered
 * accounts they never needed.
 */
export function AuthChoice(props: {
  onLocal: () => void;
  onServer: () => void;
  onFree: () => void;
}) {
  return (
    <div class="flex flex-col gap-3">
      <button type="button" class={choiceCardClass} onClick={props.onLocal}>
        <span class={choiceTitleClass}>Work locally on this device</span>
        <span class={`block ${choiceBodyClass}`}>
          Fully functional offline — chats, issues and boards live on this
          device. No account needed. Sync to a server later in Settings.
        </span>
      </button>
      <button type="button" class={choiceCardClass} onClick={props.onServer}>
        <span class={choiceTitleClass}>Connect to a server</span>
        <span class={`block ${choiceBodyClass}`}>
          You or your team run a Relay server. Sign in or create an account —
          data syncs across devices.
        </span>
      </button>
      <button type="button" class={choiceCardClass} onClick={props.onFree}>
        <span class={choiceTitleClass}>Try the free hosted server</span>
        <span class={`block ${choiceBodyClass}`}>
          Shared free instance, no setup — messages sync across devices.
          File attachments aren't stored here; for the full thing, host your
          own (one command, link below).
        </span>
      </button>
      <a
        href="https://github.com/Dvorinka/relay#quick-start"
        target="_blank"
        rel="noreferrer"
        class="mt-1 text-center text-[13px] text-muted underline-offset-2 hover:text-fg hover:underline"
      >
        Need a server? Host your own — one command →
      </a>
    </div>
  );
}

// Discord-style auth rhythm: taller inset inputs with small caps labels.
export const authInputClass =
  "h-11 w-full rounded-lg border border-border bg-bg px-3 text-[14px] text-fg outline-none transition-colors placeholder:text-muted/60 focus:border-accent";

export const authButtonClass =
  "h-11 w-full rounded-lg bg-fg text-[15px] font-medium text-bg transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-50";

export function AuthField(props: ParentProps<{ label: string }>) {
  return (
    <label class="block">
      <span class="mb-2 block text-[12px] font-semibold uppercase tracking-wider text-muted">
        {props.label}
      </span>
      {props.children}
    </label>
  );
}

/**
 * Centered card layout for unauthenticated pages (login/register/forgot/reset).
 * Includes the anon guard so signed-in users never see these forms.
 */
export function AuthLayout(
  props: ParentProps<{
    title: string;
    subtitle?: string;
    footer?: JSX.Element;
  }>,
) {
  return (
    <RequireAnon>
      <div class="flex h-full items-start justify-center overflow-y-auto px-4 pb-8 pt-[14vh] sm:items-center sm:pt-8">
        <div class="w-full max-w-[400px]">
          <div class="mb-8 flex flex-col items-center gap-3">
            <RelayMark class="h-14 w-14" />
            <span class="text-xl font-semibold tracking-tight">Relay</span>
          </div>
          <div class="rounded-xl border border-border bg-surface p-8">
            <h1 class="text-center text-[22px] font-bold leading-7">
              {props.title}
            </h1>
            {props.subtitle && (
              <p class="mt-2 text-center text-[14px] text-muted">
                {props.subtitle}
              </p>
            )}
            <div class="mt-6">{props.children}</div>
          </div>
          {props.footer && (
            <p class="mt-5 text-center text-[14px] text-muted">
              {props.footer}
            </p>
          )}
        </div>
      </div>
    </RequireAnon>
  );
}
