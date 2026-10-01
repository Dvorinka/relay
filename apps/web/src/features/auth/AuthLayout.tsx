import type { JSX, ParentProps } from "solid-js";
import { RelayMark } from "../../components/icons";
import { RequireAnon } from "./guards";

/**
 * Centered card layout for unauthenticated pages (login/register/forgot/reset).
 * Includes the anon guard so signed-in users never see these forms.
 */
export function AuthLayout(
  props: ParentProps<{ title: string; footer?: JSX.Element }>,
) {
  return (
    <RequireAnon>
      <div class="flex h-full items-center justify-center px-4">
        <div class="w-full max-w-[340px]">
          <div class="mb-6 flex items-center justify-center gap-2">
            <RelayMark class="h-6 w-6" />
            <span class="text-lg font-semibold tracking-tight">relay</span>
          </div>
          <div class="rounded-lg border border-border bg-surface p-6">
            <h1 class="mb-5 text-[15px] font-semibold">{props.title}</h1>
            {props.children}
          </div>
          {props.footer && (
            <p class="mt-4 text-center text-[13px] text-muted">
              {props.footer}
            </p>
          )}
        </div>
      </div>
    </RequireAnon>
  );
}
