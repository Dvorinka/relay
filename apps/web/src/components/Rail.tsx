import type { Project } from "@relay/api-client";
import { A, useNavigate } from "@solidjs/router";
import {
  createResource,
  createSignal,
  For,
  Show,
  type ParentProps,
} from "solid-js";
import { api } from "../lib/api";
import { deriveKey } from "../lib/text";
import { useProjects } from "../stores/projects";
import { useSession } from "../stores/session";
import { InboxIcon, PlusIcon, SettingsIcon } from "./icons";
import { FormError, inputClass, SubmitButton } from "./ui";

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

function ProjectRow(props: { project: Project }) {
  return (
    <NavItem href={`/p/${props.project.id}`}>
      <span
        class="h-2 w-2 shrink-0 rounded-full"
        style={{
          "background-color": props.project.color ?? "var(--accent)",
        }}
      />
      <span class="shrink-0 font-mono text-[11px] text-muted">
        {props.project.key}
      </span>
      <span class="truncate">{props.project.name}</span>
    </NavItem>
  );
}

function NewProjectForm(props: { onDone: () => void }) {
  const session = useSession();
  const projects = useProjects();
  const navigate = useNavigate();
  const [name, setName] = createSignal("");
  const [key, setKey] = createSignal("");
  const [keyEdited, setKeyEdited] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);

  async function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    const workspace = session.workspaces()[0];
    if (!workspace) {
      setError("No workspace available");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const project = await projects.create({
        workspace_id: workspace.id,
        name: name().trim(),
        key: key().trim(),
      });
      props.onDone();
      navigate(`/p/${project.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create project");
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      class="flex flex-col gap-1.5 px-2 pb-2"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          props.onDone();
        }
      }}
    >
      <input
        ref={(el) => el.focus()}
        type="text"
        placeholder="Project name"
        aria-label="Project name"
        required
        value={name()}
        onInput={(e) => {
          setName(e.currentTarget.value);
          if (!keyEdited()) {
            setKey(deriveKey(e.currentTarget.value));
          }
        }}
        class={inputClass}
      />
      <input
        type="text"
        placeholder="KEY"
        aria-label="Project key"
        required
        pattern="[A-Z0-9]{2,6}"
        maxlength={6}
        title="2-6 uppercase letters or digits"
        value={key()}
        onInput={(e) => {
          setKeyEdited(true);
          setKey(e.currentTarget.value.toUpperCase());
        }}
        class={`${inputClass} font-mono uppercase`}
      />
      <FormError message={error()} />
      <div class="flex gap-1.5">
        <SubmitButton pending={pending()} class="h-7 px-2.5">
          {pending() ? "Creating..." : "Create"}
        </SubmitButton>
        <button
          type="button"
          onClick={props.onDone}
          class="inline-flex h-7 items-center justify-center rounded-md px-2.5 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export function Rail() {
  const session = useSession();
  const projects = useProjects();
  const [creating, setCreating] = createSignal(false);
  const workspaceName = () => session.workspaces()[0]?.name;
  const list = () => projects.projects() ?? [];

  return (
    <aside class="flex w-56 shrink-0 flex-col border-r border-border">
      <Show when={workspaceName()}>
        {(name) => (
          <div class="border-b border-border px-4 py-2.5">
            <p class="truncate text-[13px] font-medium">{name()}</p>
          </div>
        )}
      </Show>

      <nav class="flex flex-col gap-0.5 p-2">
        <NavItem href="/inbox">
          <InboxIcon class="h-3.5 w-3.5" />
          Inbox
        </NavItem>
      </nav>

      <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div class="flex items-center justify-between px-2 pb-1 pt-3">
          <span class="text-[11px] font-medium uppercase tracking-wider text-muted">
            Projects
          </span>
          <button
            type="button"
            aria-label="New project"
            title="New project"
            onClick={() => setCreating((v) => !v)}
            class="rounded p-0.5 text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <PlusIcon class="h-3.5 w-3.5" />
          </button>
        </div>

        <Show when={creating()}>
          <NewProjectForm onDone={() => setCreating(false)} />
        </Show>

        <For each={session.workspaces()}>
          {(ws) => {
            const wsProjects = () =>
              list().filter((p) => p.workspace_id === ws.id);
            return (
              <Show when={wsProjects().length > 0}>
                <Show when={session.workspaces().length > 1}>
                  <div class="truncate px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted">
                    {ws.name}
                  </div>
                </Show>
                <div class="flex flex-col gap-0.5">
                  <For each={wsProjects()}>
                    {(p) => <ProjectRow project={p} />}
                  </For>
                </div>
              </Show>
            );
          }}
        </For>

        <Show when={list().length === 0 && !projects.loading()}>
          <p class="px-2 py-1.5 text-[13px] text-muted/60">No projects yet</p>
        </Show>
      </div>

      <div class="mt-auto flex flex-col gap-0.5 border-t border-border p-2">
        <HealthStatus />
        <NavItem href="/settings">
          <SettingsIcon class="h-3.5 w-3.5" />
          Settings
        </NavItem>
      </div>
    </aside>
  );
}
