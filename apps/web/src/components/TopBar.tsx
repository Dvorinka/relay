import { Avatar, Menu } from "@ark-ui/solid";
import { A, useNavigate } from "@solidjs/router";
import { Portal } from "solid-js/web";
import { initials } from "../lib/text";
import { useSession } from "../stores/session";
import { RelayMark, SearchIcon } from "./icons";

function AccountMenu() {
  const session = useSession();
  const navigate = useNavigate();

  async function signOut() {
    await session.logout();
    navigate("/login");
  }

  return (
    <Menu.Root positioning={{ placement: "bottom-end" }}>
      <Menu.Trigger
        class="rounded-full outline-none transition-opacity hover:opacity-80"
        aria-label="Account menu"
      >
        <Avatar.Root class="flex h-7 w-7 items-center justify-center rounded-full border border-border bg-surface">
          <Avatar.Fallback class="text-[11px] font-medium text-muted">
            {initials(session.user()?.name ?? "")}
          </Avatar.Fallback>
          <Avatar.Image
            src={session.user()?.avatar_url ?? undefined}
            alt=""
            class="h-full w-full rounded-full object-cover"
          />
        </Avatar.Root>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content class="min-w-40 rounded-md border border-border bg-surface p-1 shadow-sm outline-none">
            <div class="px-2 py-1.5">
              <p class="truncate text-[13px] font-medium">
                {session.user()?.name}
              </p>
              <p class="truncate text-[11px] text-muted">
                {session.user()?.email}
              </p>
            </div>
            <Menu.Separator class="my-1 border-t border-border" />
            <Menu.Item
              value="settings"
              onSelect={() => navigate("/app/settings")}
              class="cursor-default rounded-sm px-2 py-1.5 text-[13px] outline-none data-[highlighted]:bg-hover"
            >
              Settings
            </Menu.Item>
            <Menu.Item
              value="sign-out"
              onSelect={() => void signOut()}
              class="cursor-default rounded-sm px-2 py-1.5 text-[13px] outline-none data-[highlighted]:bg-hover"
            >
              Sign out
            </Menu.Item>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}

export function TopBar() {
  return (
    <header class="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
      <A href="/app" class="flex items-center gap-2">
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

      <AccountMenu />
    </header>
  );
}
