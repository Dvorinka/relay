import { A, useParams } from "@solidjs/router";
import { createResource, Show } from "solid-js";
import { api } from "../../lib/api";
import { Spinner } from "../../components/ui";
import { IssueIcon } from "../../components/icons";
import { Board } from "./Board";

// Standalone kanban page — the chat header's Board button lands here so the
// board gets the full window instead of a sheet.
export default function BoardPage() {
  const params = useParams<{ projectId: string }>();
  const [project] = createResource(
    () => params.projectId,
    (id) => api.getProject(id),
  );

  return (
    <div class="flex h-full min-h-0 flex-col">
      <header class="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
        <A
          href={`/app/p/${params.projectId}`}
          class="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <IssueIcon class="h-3.5 w-3.5 rotate-180" />
          Chat
        </A>
        <Show when={project()}>
          {(p) => (
            <>
              <span
                class="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ "background-color": p().color ?? "var(--accent)" }}
              />
              <h1 class="truncate text-[14.5px] font-semibold tracking-tight">
                {p().name}
              </h1>
              <span class="rounded border border-border px-1.5 py-0.5 font-mono text-[10.5px] text-muted">
                {p().key}
              </span>
              <span class="text-[12.5px] text-muted">· Board</span>
            </>
          )}
        </Show>
      </header>
      <div class="flex min-h-0 flex-1 flex-col">
        <Show
          when={project()}
          fallback={
            <div class="flex flex-1 items-center justify-center">
              <Spinner class="h-4 w-4" />
            </div>
          }
        >
          {(p) => <Board project={p()} />}
        </Show>
      </div>
    </div>
  );
}
