import { createSignal, For, Show } from "solid-js";
import type { BriefPolicy, Project, StatusDef } from "@relay/api-client";
import { api } from "../../lib/api";
import { ApiClientError } from "@relay/api-client";
import { statusDefs } from "./meta";
import { CheckIcon, PlusIcon, XIcon } from "../../components/icons";
import { ColorField, inputClass, primaryButtonClass } from "../../components/ui";

// Project-level customization sheet: issue lanes (custom statuses) and the
// linked local folder. Opened from the board header gear.
export function ProjectSettings(props: {
  project: Project;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [defs, setDefs] = createSignal<StatusDef[]>(
    statusDefs(props.project).map((d) => ({ ...d })),
  );
  const [folder, setFolder] = createSignal(props.project.local_path ?? "");
  const [policy, setPolicy] = createSignal<BriefPolicy>(
    (props.project.brief_policy as BriefPolicy) || "on_request",
  );
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const patch = (idx: number, p: Partial<StatusDef>) =>
    setDefs((cur) => cur.map((d, i) => (i === idx ? { ...d, ...p } : d)));

  const remove = (idx: number) =>
    setDefs((cur) => cur.filter((_, i) => i !== idx));

  const add = () =>
    setDefs((cur) => [
      ...cur,
      {
        id: `lane_${cur.length + 1}`,
        label: "New lane",
        color: "#06b6d4",
      },
    ]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = defs();
      const isDefault =
        next.length === 6 &&
        next.every((d, i) => d.id === statusDefs(undefined)[i]?.id);
      await api.setProjectStatuses(
        props.project.id,
        isDefault ? null : next,
      );
      const path = folder().trim();
      if ((path || null) !== (props.project.local_path ?? null)) {
        await api.setProjectLocalPath(props.project.id, path || null);
      }
      if (policy() !== props.project.brief_policy) {
        await api.setBriefPolicy(props.project.id, policy());
      }
      props.onSaved();
      props.onClose();
    } catch (e) {
      setError(
        e instanceof ApiClientError ? e.message : "Could not save settings",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onClose();
      }}
    >
      <div class="flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl border border-border bg-surface shadow-xl">
        <div class="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 class="text-[14px] font-semibold">Project settings</h2>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Close"
            class="rounded p-1 text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <XIcon class="h-4 w-4" />
          </button>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <p class="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted">
            Issue lanes
          </p>
          <ul class="flex flex-col gap-1.5">
            <For each={defs()}>
              {(d, i) => (
                <li class="flex items-center gap-2">
                  <ColorField
                    value={d.color}
                    label={`Color for ${d.label}`}
                    onPick={(hex) => patch(i(), { color: hex })}
                  />
                  <input
                    value={d.label}
                    aria-label="Lane label"
                    onInput={(e) => {
                      const label = e.currentTarget.value;
                      patch(i(), {
                        label,
                        // id follows the label until it diverges; keeps new
                        // lanes sane without an extra field
                        id: d.id.startsWith("lane_")
                          ? label
                              .toLowerCase()
                              .replace(/[^a-z0-9]+/g, "_")
                              .replace(/^_+|_+$/g, "") || d.id
                          : d.id,
                      });
                    }}
                    class={`${inputClass} flex-1 !h-7`}
                  />
                  <label
                    class="flex shrink-0 items-center gap-1 text-[11px] text-muted"
                    title="Terminal state — maps to GitHub 'closed'"
                  >
                    <input
                      type="checkbox"
                      checked={d.closed === true}
                      onChange={(e) =>
                        patch(i(), { closed: e.currentTarget.checked })
                      }
                      class="h-3.5 w-3.5 accent-[#06b6d4]"
                    />
                    closed
                  </label>
                  <button
                    type="button"
                    aria-label={`Remove ${d.label}`}
                    onClick={() => remove(i())}
                    disabled={defs().length <= 1}
                    class="rounded p-1 text-muted/60 transition-colors hover:text-red-500 disabled:opacity-30"
                  >
                    <XIcon class="h-3.5 w-3.5" />
                  </button>
                </li>
              )}
            </For>
          </ul>
          <button
            type="button"
            onClick={add}
            disabled={defs().length >= 24}
            class="mt-2 inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <PlusIcon class="h-3 w-3" /> Add lane
          </button>
          <p class="mt-2 text-[11px] text-muted/70">
            Reordering isn't supported yet; lanes appear in this order on the
            board. Deleting a lane leaves its issues invisible until they're
            moved via the issue page.
          </p>

          <p class="mb-2 mt-6 text-[11px] font-medium uppercase tracking-wider text-muted">
            Linked folder
          </p>
          <input
            value={folder()}
            onInput={(e) => setFolder(e.currentTarget.value)}
            placeholder="/path/to/repo on the server host"
            aria-label="Local folder path"
            class={inputClass}
          />
          <p class="mt-1.5 text-[11px] text-muted/70">
            Lets chat mention local files with{" "}
            <code class="rounded bg-surface-2 px-1 font-mono text-[10.5px]">
              @file:
            </code>{" "}
            and gives agents the{" "}
            <code class="rounded bg-surface-2 px-1 font-mono text-[10.5px]">
              file:read
            </code>{" "}
            tools. Path must exist on the machine running the Relay server.
          </p>

          <p class="mb-2 mt-6 text-[11px] font-medium uppercase tracking-wider text-muted">
            Visual briefs
          </p>
          <select
            value={policy()}
            onChange={(e) =>
              setPolicy(e.currentTarget.value as BriefPolicy)
            }
            aria-label="Brief policy"
            class={inputClass}
          >
            <option value="on_request">On request — agents explain when asked</option>
            <option value="pre_merge">Pre-merge — expected before approvals</option>
            <option value="never">Never — briefs disabled</option>
          </select>
          <p class="mt-1.5 text-[11px] text-muted/70">
            Controls when agents should post Excalidraw-style diagrams
            explaining their work. Agents read this through the{" "}
            <code class="rounded bg-surface-2 px-1 font-mono text-[10.5px]">
              get_brief_policy
            </code>{" "}
            tool.
          </p>

          <Show when={error()}>
            <p class="mt-3 text-[12px] text-red-500">{error()}</p>
          </Show>
        </div>
        <div class="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={props.onClose}
            class="h-8 rounded-md px-3 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving()}
            class={`${primaryButtonClass} inline-flex items-center gap-1.5`}
          >
            <CheckIcon class="h-3.5 w-3.5" />
            {saving() ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
