import type { ParentProps } from "solid-js";
import { CommandPalette } from "./components/CommandPalette";
import { ConfirmHost } from "./components/Confirm";
import { ProfileModalHost } from "./components/ProfileModal";
import { Rail } from "./components/Rail";
import { TopBar } from "./components/TopBar";
import { RequireAuth } from "./features/auth/guards";
import { ProjectsProvider } from "./stores/projects";

export default function App(props: ParentProps) {
  return (
    <RequireAuth>
      <ProjectsProvider>
        <div class="flex h-full flex-col">
          <TopBar />
          <div class="flex min-h-0 flex-1">
            <Rail />
            <main class="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
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
