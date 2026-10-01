import type { CreateProjectRequest, Project } from "@relay/api-client";
import {
  createContext,
  createResource,
  useContext,
  type Accessor,
  type ParentProps,
  type Resource,
} from "solid-js";
import { api } from "../lib/api";

export interface ProjectsStore {
  projects: Resource<Project[]>;
  /** True only during the initial fetch, not background refetches. */
  loading: Accessor<boolean>;
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

  const store: ProjectsStore = {
    projects,
    loading,
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
