import type { Project, ProjectOverview } from "@relay/api-client";
import { useParams } from "@solidjs/router";
import {
  createResource,
  createSignal,
  For,
  Show,
} from "solid-js";
import { Spinner } from "../../components/ui";
import { api } from "../../lib/api";
import { messagePreview } from "../../lib/text";
import { timeAgo } from "../../lib/time";
import { useProjects } from "../../stores/projects";
import { Conversation } from "../conversations/Conversation";
import { DevelopmentPanel } from "../github/GitHub";
import { IssueList } from "../issues/IssueList";

type Tab = "overview" | "issues" | "conversation" | "development";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "issues", label: "Issues" },
  { id: "conversation", label: "Conversation" },
  { id: "development", label: "Development" },
];

function ProjectDot(props: { color?: string | null; class?: string }) {
  return (
    <span
      class={`rounded-full ${props.class ?? "h-2.5 w-2.5"}`}
      style={{ "background-color": props.color ?? "var(--accent)" }}
    />
  );
}

function Stat(props: { label: string; value: number }) {
  return (
    <div class="rounded-md border border-border bg-surface px-4 py-3">
      <p class="text-[15px] font-semibold tabular-nums">{props.value}</p>
      <p class="mt-0.5 text-[11px] uppercase tracking-wider text-muted">
        {props.label}
      </p>
    </div>
  );
}

function Overview(props: { overview: ProjectOverview }) {
  const counts = () => props.overview.counts;
  return (
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto w-full max-w-2xl px-6 py-6">
        <div class="grid grid-cols-3 gap-3">
          <Stat label="Members" value={counts().members} />
          <Stat label="Messages" value={counts().messages} />
          <Stat label="Conversations" value={counts().conversations} />
        </div>

        <h2 class="mb-2 mt-8 text-[13px] font-semibold">Recent activity</h2>
        <ul class="divide-y divide-border rounded-md border border-border">
          <For
            each={props.overview.recent_messages}
            fallback={
              <li class="px-3 py-2.5 text-[13px] text-muted">
                No activity yet
              </li>
            }
          >
            {(m) => (
              <li class="px-3 py-2.5">
                <div class="flex items-baseline gap-2">
                  <span class="text-[13px] font-medium">{m.author.name}</span>
                  <span class="text-[11px] text-muted">
                    {timeAgo(m.created_at)}
                  </span>
                </div>
                <p class="truncate text-[13px] text-muted">
                  {messagePreview(m.body)}
                </p>
              </li>
            )}
          </For>
        </ul>
      </div>
    </div>
  );
}

export default function ProjectPage() {
  const params = useParams<{ projectId: string }>();
  const projects = useProjects();
  const [tab, setTab] = createSignal<Tab>("overview");

  const [overview] = createResource(
    () => params.projectId,
    (id) => api.projectOverview(id),
  );

  // Header is instant when the list store already holds this project.
  const project = (): Project | undefined =>
    overview()?.project ??
    projects.projects()?.find((p) => p.id === params.projectId);

  return (
    <div class="flex h-full flex-col">
      <header class="shrink-0 px-6 pt-5">
        <Show
          when={project()}
          fallback={
            <div class="flex h-8 items-center">
              <Show
                when={overview.state === "errored"}
                fallback={<Spinner class="h-4 w-4" />}
              >
                <p class="text-[13px] text-muted">Project not found</p>
              </Show>
            </div>
          }
        >
          {(p) => (
            <>
              <div class="flex items-center gap-2.5">
                <ProjectDot color={p().color} />
                <h1 class="text-[15px] font-semibold tracking-tight">
                  {p().name}
                </h1>
                <span class="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted">
                  {p().key}
                </span>
              </div>
              <Show when={p().description}>
                <p class="mt-1 max-w-2xl text-[13px] text-muted">
                  {p().description}
                </p>
              </Show>
            </>
          )}
        </Show>

        <div class="mt-4 inline-flex rounded-md border border-border p-0.5">
          <For each={TABS}>
            {(t) => (
              <button
                type="button"
                onClick={() => setTab(t.id)}
                class={`rounded-sm px-2.5 py-1 text-[13px] transition-colors ${
                  tab() === t.id
                    ? "bg-hover font-medium text-fg"
                    : "text-muted hover:text-fg"
                }`}
              >
                {t.label}
              </button>
            )}
          </For>
        </div>
      </header>

      <Show when={tab() === "overview"}>
        <Show
          when={overview()}
          fallback={
            <div class="flex min-h-0 flex-1 items-center justify-center">
              <Show
                when={overview.state === "errored"}
                fallback={<Spinner />}
              >
                <p class="text-[13px] text-muted">Could not load project</p>
              </Show>
            </div>
          }
        >
          {(o) => <Overview overview={o()} />}
        </Show>
      </Show>
      <Show when={tab() === "issues" ? project() : undefined} keyed>
        {(p) => <IssueList project={p} />}
      </Show>
      <Show when={tab() === "conversation"}>
        <Conversation projectId={params.projectId} />
      </Show>
      <Show when={tab() === "development" ? project() : undefined} keyed>
        {(p) => (
          <DevelopmentPanel
            projectId={p.id}
            workspaceId={p.workspace_id}
          />
        )}
      </Show>
    </div>
  );
}
