import type { JSX, ParentProps } from "solid-js";
import { RelayMark } from "../../components/icons";
import { RequireAnon } from "./guards";

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
