import type { ParentProps } from "solid-js";
import { Rail } from "./components/Rail";
import { TopBar } from "./components/TopBar";

export default function App(props: ParentProps) {
  return (
    <div class="flex h-full flex-col">
      <TopBar />
      <div class="flex min-h-0 flex-1">
        <Rail />
        <main class="min-w-0 flex-1">{props.children}</main>
      </div>
    </div>
  );
}
