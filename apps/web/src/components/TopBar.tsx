import { Avatar } from "@ark-ui/solid";
import { A } from "@solidjs/router";
import { RelayMark, SearchIcon } from "./icons";

export function TopBar() {
  return (
    <header class="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
      <A href="/" class="flex items-center gap-2">
        <RelayMark class="h-5 w-5" />
        <span class="text-[15px] font-semibold tracking-tight">relay</span>
      </A>

      <div class="flex-1" />

      <button
        type="button"
        class="flex h-7 w-64 items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-[13px] text-muted transition-colors hover:bg-hover"
      >
        <SearchIcon class="h-3.5 w-3.5" />
        <span class="flex-1 text-left">Search</span>
        <kbd class="rounded border border-border px-1 font-mono text-[10px] leading-4 text-muted">
          ⌘K
        </kbd>
      </button>

      <Avatar.Root class="flex h-7 w-7 items-center justify-center rounded-full border border-border bg-surface">
        <Avatar.Fallback class="text-[11px] font-medium text-muted">
          R
        </Avatar.Fallback>
      </Avatar.Root>
    </header>
  );
}
