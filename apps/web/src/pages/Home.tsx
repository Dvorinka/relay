import { A } from "@solidjs/router";
import { For, Show } from "solid-js";
import { FullPageSpinner } from "../components/ui";
import { useProjects } from "../stores/projects";

export default function Home() {
  const projects = useProjects();
  const list = () => projects.projects() ?? [];

  return (
    <Show when={!projects.loading()} fallback={<FullPageSpinner />}>
      <Show
        when={list().length > 0}
        fallback={
          <div class="flex h-full items-center justify-center">
            <p class="text-sm text-muted">No projects yet</p>
          </div>
        }
      >
        <div class="mx-auto w-full max-w-4xl px-6 py-8">
          <h1 class="mb-4 text-[15px] font-semibold">Projects</h1>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <For each={list()}>
              {(p) => (
                <A
                  href={`/app/p/${p.id}`}
                  class="block rounded-md border border-border bg-surface p-4 transition-colors hover:bg-hover"
                >
                  <div class="flex items-center gap-2">
                    <span
                      class="h-2 w-2 shrink-0 rounded-full"
                      style={{
                        "background-color": p.color ?? "var(--accent)",
                      }}
                    />
                    <span class="truncate text-[13px] font-medium">
                      {p.name}
                    </span>
                    <span class="ml-auto shrink-0 font-mono text-[11px] text-muted">
                      {p.key}
                    </span>
                  </div>
                  <Show when={p.description}>
                    <p class="mt-1.5 line-clamp-2 text-[13px] text-muted">
                      {p.description}
                    </p>
                  </Show>
                </A>
              )}
            </For>
          </div>
        </div>
      </Show>
    </Show>
  );
}
