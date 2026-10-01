import type { ParentProps } from "solid-js";
import { Rail } from "./components/Rail";
import { TopBar } from "./components/TopBar";
import { RequireAuth } from "./features/auth/guards";

export default function App(props: ParentProps) {
  return (
    <RequireAuth>
      <div class="flex h-full flex-col">
        <TopBar />
        <div class="flex min-h-0 flex-1">
          <Rail />
          <main class="min-w-0 flex-1 overflow-y-auto">{props.children}</main>
        </div>
      </div>
    </RequireAuth>
  );
}
