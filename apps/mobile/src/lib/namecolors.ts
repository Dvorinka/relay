// Author name colors, mirroring apps/web: a per-workspace name→color map
// loaded once so message rows can honor each member's custom chat color
// without per-message joins.
import { api } from "./api";

const colors: Record<string, string> = {};
const loadedFor = new Set<string>();

export function nameColorFor(name: string): string | undefined {
  return colors[name];
}

export async function loadNameColors(workspaceId: string) {
  if (!workspaceId || loadedFor.has(workspaceId)) return;
  loadedFor.add(workspaceId);
  try {
    const { members } = await api.workspaceMembers(workspaceId);
    for (const m of members) {
      if (m.user.name_color) colors[m.user.name] = m.user.name_color;
    }
  } catch {
    loadedFor.delete(workspaceId);
  }
}

// Resolve the project → workspace mapping via the projects list (it carries
// workspace_id), then load that workspace's member colors.
export async function loadNameColorsForProject(projectId: string) {
  try {
    const { projects } = await api.projects();
    const ws = projects.find((p) => p.id === projectId)?.workspace_id;
    if (ws) await loadNameColors(ws);
  } catch {
    // Palette fallback still applies.
  }
}
