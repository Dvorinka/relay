import type { CreateProjectRequest, Project } from "@relay/api-client";
import {
  createContext,
  createMemo,
  createResource,
  createSignal,
  useContext,
  type Accessor,
  type ParentProps,
  type Resource,
} from "solid-js";
import { api } from "../lib/api";

export type ProjectSort = "activity" | "name" | "manual";

const SORT_KEY = "relay.projects.sort";
const ORDER_KEY = "relay.projects.order";

const [projectSort, setProjectSortSig] = createSignal<ProjectSort>(
  (localStorage.getItem(SORT_KEY) as ProjectSort) || "activity",
);
const [projectOrder, setProjectOrderSig] = createSignal<string[]>(
  JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]") as string[],
);

export function setProjectSort(s: ProjectSort) {
  setProjectSortSig(s);
  localStorage.setItem(SORT_KEY, s);
}
export function setProjectOrder(ids: string[]) {
  setProjectOrderSig(ids);
  localStorage.setItem(ORDER_KEY, JSON.stringify(ids));
}
export function useProjectSort() {
  return { projectSort, projectOrder };
}

const activityOf = (p: Project) =>
  Date.parse(p.last_activity_at ?? p.created_at ?? "") || 0;

// One ordering for every project list in the app — the Home grid and the
// rail agree because they share this memo's ordering.
export function sortedProjects(list: Project[] | undefined): Project[] {
  const items = [...(list ?? [])];
  const mode = projectSort();
  if (mode === "name") return items.sort((a, b) => a.name.localeCompare(b.name));
  if (mode === "manual") {
    const order = new Map(projectOrder().map((id, i) => [id, i]));
    // unranked projects sink to the bottom, stable by name
    return items.sort(
      (a, b) =>
        (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity) ||
        a.name.localeCompare(b.name),
    );
  }
  return items.sort((a, b) => activityOf(b) - activityOf(a));
}

export interface ProjectsStore {
  projects: Resource<Project[]>;
  /** True only during the initial fetch, not background refetches. */
  loading: Accessor<boolean>;
  /** Projects in the user's chosen order. */
  sorted: Accessor<Project[]>;
  create: (input: CreateProjectRequest) => Promise<Project>;
  refresh: () => Promise<void>;
}

const ProjectsContext = createContext<ProjectsStore>();

/**
 * Lives inside the authed shell (App) so the project list is only fetched
 * once the session is known to be signed in.
 */
export function ProjectsProvider(props: ParentProps) {
  const [projects, { mutate, refetch }] = createResource<Project[]>(
    async () => (await api.listProjects()).projects,
  );

  const loading = () => projects.state === "pending";
  const sorted = createMemo(() => sortedProjects(projects()));

  const store: ProjectsStore = {
    projects,
    loading,
    sorted,
    create: async (input) => {
      const project = await api.createProject(input);
      mutate((list) => [...(list ?? []), project]);
      return project;
    },
    refresh: async () => {
      await refetch();
    },
  };

  return (
    <ProjectsContext.Provider value={store}>
      {props.children}
    </ProjectsContext.Provider>
  );
}

export function useProjects(): ProjectsStore {
  const ctx = useContext(ProjectsContext);
  if (!ctx) {
    throw new Error("useProjects must be used within <ProjectsProvider>");
  }
  return ctx;
}
