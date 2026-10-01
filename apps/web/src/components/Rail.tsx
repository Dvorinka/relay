import { A } from "@solidjs/router";
import { createResource, createSignal, For, type ParentProps } from "solid-js";
import { api } from "../lib/api";
import { InboxIcon, SettingsIcon } from "./icons";

const navClass =
  "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg";

function NavItem(props: ParentProps<{ href: string }>) {
  return (
    <A href={props.href} class={navClass} activeClass="bg-hover text-fg">
      {props.children}
    </A>
  );
}

function HealthStatus() {
  const [health] = createResource(() => api.health());
  return (
    <div
      class="flex items-center gap-2 px-2 py-1.5 text-[13px] text-muted"
      title="API status"
    >
      <span
        class="h-1.5 w-1.5 rounded-full bg-muted"
        classList={{
          "!bg-emerald-500": health.state === "ready",
          "!bg-red-500": health.state === "errored",
        }}
      />
      <span>
        {health.state === "ready"
          ? "api ok"
          : health.state === "errored"
            ? "api offline"
            : "api"}
      </span>
    </div>
  );
}

export function Rail() {
  const [projects] = createSignal<string[]>([]);

  return (
    <aside class="flex w-56 shrink-0 flex-col border-r border-border">
      <nav class="flex flex-col gap-0.5 p-2">
        <NavItem href="/inbox">
          <InboxIcon class="h-3.5 w-3.5" />
          Inbox
        </NavItem>
      </nav>

      <div class="px-2">
        <div class="px-2 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wider text-muted">
          Projects
        </div>
        <For
          each={projects()}
          fallback={
            <p class="px-2 py-1.5 text-[13px] text-muted/60">No projects yet</p>
          }
        >
          {(id) => <NavItem href={`/p/${id}`}>{id}</NavItem>}
        </For>
      </div>

      <div class="mt-auto flex flex-col gap-0.5 border-t border-border p-2">
        <HealthStatus />
        <button type="button" class={`${navClass} w-full text-left`}>
          <SettingsIcon class="h-3.5 w-3.5" />
          Settings
        </button>
      </div>
    </aside>
  );
}
