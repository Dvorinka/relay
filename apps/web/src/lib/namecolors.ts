// Workspace member name→color map, loaded once per workspace so message
// rows can honor each user's custom chat color without per-message joins.
import { createSignal } from "solid-js";
import { api } from "./api";

const [colors, setColors] = createSignal<Record<string, string>>({});
let loadedFor = "";

export function nameColorFor(name: string): string | undefined {
  return colors()[name];
}

export async function loadNameColors(workspaceId: string) {
  if (loadedFor === workspaceId) return;
  loadedFor = workspaceId;
  try {
    const { members } = await api.listWorkspaceMembers(workspaceId);
    const map: Record<string, string> = {};
    for (const m of members) {
      const c = m.user.name_color;
      if (c) map[m.user.name] = c;
    }
    setColors(map);
  } catch {
    loadedFor = "";
  }
}
