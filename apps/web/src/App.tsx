import type { ParentProps } from "solid-js";
import { createEffect, onCleanup } from "solid-js";
import { CommandPalette } from "./components/CommandPalette";
import { ConfirmHost } from "./components/Confirm";
import { ProfileModalHost } from "./components/ProfileModal";
import { Rail } from "./components/Rail";
import { TopBar } from "./components/TopBar";
import { RequireAuth } from "./features/auth/guards";
import { setFaviconBadge } from "./lib/favicon";
import { attachPullToRefresh } from "./lib/pullrefresh";
import { ProjectsProvider } from "./stores/projects";
import { useUnread } from "./stores/unread";

// "(N) Relay" in the tab/window title plus a badge on the favicon — unread
// survives tab-dense browsers and the desktop shell's window chrome.
function TitleBadge() {
  const { unread } = useUnread();
  createEffect(() => {
    const n = Object.values(unread()).reduce((a, b) => a + b, 0);
    document.title = n > 0 ? `(${n > 99 ? "99+" : n}) Relay` : "Relay";
    setFaviconBadge(n);
  });
  return null;
}

export default function App(props: ParentProps) {
  // SolidJS calls the ref callback on mount — attach the phone pull-to-
  // refresh gesture to the scroll container.
  let detachPull: (() => void) | undefined;
  onCleanup(() => detachPull?.());
  return (
    <RequireAuth>
      <ProjectsProvider>
        <TitleBadge />
        <div class="flex h-full flex-col">
          <TopBar />
          <div class="flex min-h-0 flex-1">
            <Rail />
            <main
              ref={(el) => {
                detachPull = attachPullToRefresh(el);
              }}
              class="min-w-0 flex-1 overflow-y-auto overflow-x-hidden"
            >
              {props.children}
            </main>
          </div>
          <CommandPalette />
          <ProfileModalHost />
          <ConfirmHost />
        </div>
      </ProjectsProvider>
    </RequireAuth>
  );
}
