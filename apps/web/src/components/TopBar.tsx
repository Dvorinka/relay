import { Avatar, Menu } from "@ark-ui/solid";
import { A, useNavigate } from "@solidjs/router";
import { Portal } from "solid-js/web";
import { mediaURL } from "../lib/net";
import { initials } from "../lib/text";
import { useSession } from "../stores/session";
import { useNav } from "../stores/nav";
import { toggleTheme, useTheme } from "../stores/theme";
import { MenuIcon, MoonIcon, SunIcon } from "./icons";
import { RelayMark } from "./icons";

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
            src={mediaURL(session.user()?.avatar_url)}
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
  const { theme } = useTheme();
  const { toggleNav } = useNav();
  return (
    <header class="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 sm:gap-3 sm:px-4">
      <button
        type="button"
        onClick={toggleNav}
        aria-label="Open navigation"
        class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg md:hidden"
      >
        <MenuIcon class="h-4 w-4" />
      </button>
      <A href="/app" class="flex items-center gap-2">
        <RelayMark class="h-5 w-5" />
        <span class="text-[15px] font-semibold tracking-tight">Relay</span>
      </A>

      <div class="flex-1" />

      <button
        type="button"
        onClick={toggleTheme}
        title={theme() === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        aria-label="Toggle color theme"
        class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg"
      >
        {theme() === "dark" ? (
          <SunIcon class="h-3.5 w-3.5" />
        ) : (
          <MoonIcon class="h-3.5 w-3.5" />
        )}
      </button>
      <AccountMenu />
    </header>
  );
}
