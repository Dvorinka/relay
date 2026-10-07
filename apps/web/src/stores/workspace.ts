import { createMemo, createSignal, type Accessor } from "solid-js";
import type { WorkspaceWithRole } from "@relay/api-client";

const KEY = "relay.activeWorkspace";

// The workspace the rail treats as current — workspaces are separate
// namespaces (different companies, different projects), so the rail shows
// one at a time and switching is one click. Persists across sessions.
const [chosen, setChosen] = createSignal(localStorage.getItem(KEY) ?? "");

export function setActiveWorkspace(id: string) {
  setChosen(id);
  localStorage.setItem(KEY, id);
}

// Resolves the stored choice against the live list; falls back to the
// first workspace when unset or when the stored one vanished (left/deleted).
export function activeWorkspace(
  workspaces: Accessor<WorkspaceWithRole[]>,
): Accessor<WorkspaceWithRole | undefined> {
  return createMemo(() => {
    const list = workspaces();
    return list.find((w) => w.id === chosen()) ?? list[0];
  });
}
