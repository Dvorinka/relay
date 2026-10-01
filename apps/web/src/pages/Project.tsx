import { useParams } from "@solidjs/router";

export default function Project() {
  const params = useParams<{ projectId: string }>();
  return (
    <div class="flex h-full flex-col items-center justify-center gap-2">
      <span class="rounded-md border border-border bg-surface px-1.5 py-0.5 font-mono text-[11px] text-muted">
        {params.projectId}
      </span>
      <p class="text-sm text-muted">Project overview</p>
    </div>
  );
}
