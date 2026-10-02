import { createResource, Show } from "solid-js";
import { Navigate, useParams } from "@solidjs/router";
import { Spinner } from "../../components/ui";
import { api } from "../../lib/api";

/** Resolves a RLY-42 style key inside a project to the issue's real id. */
export default function IssueKeyRedirect() {
  const params = useParams<{ projectId: string; key: string }>();
  const [issue] = createResource(
    () => ({ p: params.projectId, k: params.key }),
    ({ p, k }) => api.issueByKey(p, k),
  );
  return (
    <Show
      when={issue()}
      fallback={
        <div class="flex h-full items-center justify-center">
          <Show when={issue.state === "errored"} fallback={<Spinner />}>
            <p class="text-[13px] text-muted">
              No issue {params.key} in this project
            </p>
          </Show>
        </div>
      }
    >
      {(i) => (
        <Navigate href={`/app/p/${params.projectId}/i/${i().id}`} />
      )}
    </Show>
  );
}
