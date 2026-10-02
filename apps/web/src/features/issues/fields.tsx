import { createListCollection, Select } from "@ark-ui/solid";
import type {
  IssuePriority,
  IssueStatus,
  Label,
  WorkspaceMember,
} from "@relay/api-client";
import { createMemo, createSignal, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { CheckIcon, ChevronDownIcon } from "../../components/icons";
import { inputClass } from "../../components/ui";
import { api } from "../../lib/api";
import {
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  LabelChip,
  PRIORITY_LABEL,
  PriorityGlyph,
  STATUS_LABEL,
  StatusDot,
} from "./meta";

const triggerClass =
  "flex h-8 w-full items-center justify-between gap-2 rounded-md border border-border bg-bg px-2.5 text-[13px] text-fg outline-none transition-colors hover:bg-hover focus:border-accent disabled:opacity-50";
const contentClass =
  "z-50 min-w-36 rounded-md border border-border bg-surface p-1 shadow-md outline-none";
const itemClass =
  "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-hover";
const labelClass = "mb-1.5 block text-[13px] font-medium";

function SelectLabel(props: { text?: string }) {
  return (
    <Show when={props.text}>
      {(t) => <Select.Label class={labelClass}>{t()}</Select.Label>}
    </Show>
  );
}

function Chevron() {
  return (
    <Select.Indicator class="shrink-0 text-muted">
      <ChevronDownIcon class="h-3.5 w-3.5" />
    </Select.Indicator>
  );
}

export function StatusSelect(props: {
  value: IssueStatus;
  onChange: (v: IssueStatus) => void;
  disabled?: boolean;
  label?: string;
}) {
  const collection = createListCollection({
    items: ISSUE_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] })),
  });
  return (
    <Select.Root
      collection={collection}
      value={[props.value]}
      onValueChange={(d) => {
        const v = d.value[0];
        if (v !== undefined && v !== props.value) {
          // SAFETY: item values are built from ISSUE_STATUSES.
          props.onChange(v as IssueStatus);
        }
      }}
      positioning={{ placement: "bottom-start", sameWidth: true }}
      disabled={props.disabled}
    >
      <SelectLabel text={props.label} />
      <Select.Control>
        <Select.Trigger class={triggerClass} aria-label="Status">
          <span class="flex min-w-0 items-center gap-2">
            <StatusDot status={props.value} />
            <Select.ValueText />
          </span>
          <Chevron />
        </Select.Trigger>
      </Select.Control>
      <Portal>
        <Select.Positioner>
          <Select.Content class={contentClass}>
            <For each={collection.items}>
              {(item) => (
                <Select.Item item={item} class={itemClass}>
                  <StatusDot status={item.value} />
                  <Select.ItemText class="min-w-0 flex-1 truncate">
                    {item.label}
                  </Select.ItemText>
                  <Select.ItemIndicator>
                    <CheckIcon class="h-3.5 w-3.5" />
                  </Select.ItemIndicator>
                </Select.Item>
              )}
            </For>
          </Select.Content>
        </Select.Positioner>
      </Portal>
    </Select.Root>
  );
}

export function PrioritySelect(props: {
  value: IssuePriority;
  onChange: (v: IssuePriority) => void;
  disabled?: boolean;
  label?: string;
}) {
  const collection = createListCollection({
    items: ISSUE_PRIORITIES.map((p) => ({
      value: p,
      label: PRIORITY_LABEL[p],
    })),
  });
  return (
    <Select.Root
      collection={collection}
      value={[props.value]}
      onValueChange={(d) => {
        const v = d.value[0];
        if (v !== undefined && v !== props.value) {
          // SAFETY: item values are built from ISSUE_PRIORITIES.
          props.onChange(v as IssuePriority);
        }
      }}
      positioning={{ placement: "bottom-start", sameWidth: true }}
      disabled={props.disabled}
    >
      <SelectLabel text={props.label} />
      <Select.Control>
        <Select.Trigger class={triggerClass} aria-label="Priority">
          <span class="flex min-w-0 items-center gap-2">
            <PriorityGlyph priority={props.value} />
            <Select.ValueText />
          </span>
          <Chevron />
        </Select.Trigger>
      </Select.Control>
      <Portal>
        <Select.Positioner>
          <Select.Content class={contentClass}>
            <For each={collection.items}>
              {(item) => (
                <Select.Item item={item} class={itemClass}>
                  <PriorityGlyph priority={item.value} />
                  <Select.ItemText class="min-w-0 flex-1 truncate">
                    {item.label}
                  </Select.ItemText>
                  <Select.ItemIndicator>
                    <CheckIcon class="h-3.5 w-3.5" />
                  </Select.ItemIndicator>
                </Select.Item>
              )}
            </For>
          </Select.Content>
        </Select.Positioner>
      </Portal>
    </Select.Root>
  );
}

const UNASSIGNED = "__none";

export function AssigneeSelect(props: {
  members: WorkspaceMember[];
  value: string | null;
  onChange: (userId: string | null) => void;
  disabled?: boolean;
  label?: string;
}) {
  const collection = createMemo(() =>
    createListCollection({
      items: [
        { value: UNASSIGNED, label: "Unassigned" },
        ...props.members.map((m) => ({
          value: m.user.id,
          label: m.user.name,
        })),
      ],
    }),
  );
  return (
    <Select.Root
      collection={collection()}
      value={[props.value ?? UNASSIGNED]}
      onValueChange={(d) => {
        const v = d.value[0];
        if (v === undefined) {
          return;
        }
        const next = v === UNASSIGNED ? null : v;
        if (next !== props.value) {
          props.onChange(next);
        }
      }}
      positioning={{ placement: "bottom-start", sameWidth: true }}
      disabled={props.disabled}
    >
      <SelectLabel text={props.label} />
      <Select.Control>
        <Select.Trigger class={triggerClass} aria-label="Assignee">
          <Select.ValueText class="min-w-0 truncate" />
          <Chevron />
        </Select.Trigger>
      </Select.Control>
      <Portal>
        <Select.Positioner>
          <Select.Content class={contentClass}>
            <For each={collection().items}>
              {(item) => (
                <Select.Item item={item} class={itemClass}>
                  <Select.ItemText class="min-w-0 flex-1 truncate">
                    {item.label}
                  </Select.ItemText>
                  <Select.ItemIndicator>
                    <CheckIcon class="h-3.5 w-3.5" />
                  </Select.ItemIndicator>
                </Select.Item>
              )}
            </For>
          </Select.Content>
        </Select.Positioner>
      </Portal>
    </Select.Root>
  );
}

/**
 * Multi-select over a project's labels plus an inline "create label" row.
 * The parent owns the labels list; `onLabelCreated` lets it append the new
 * label so the collection stays in sync.
 */
export function LabelsPicker(props: {
  projectId: string;
  labels: Label[];
  value: string[];
  onChange: (ids: string[]) => void;
  onLabelCreated: (label: Label) => void;
  disabled?: boolean;
  label?: string;
}) {
  const collection = createMemo(() =>
    createListCollection<Label>({
      items: props.labels,
      itemToValue: (l) => l.id,
      itemToString: (l) => l.name,
    }),
  );
  const [newName, setNewName] = createSignal("");
  const [newColor, setNewColor] = createSignal("#06b6d4");
  const [creating, setCreating] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function addLabel() {
    const name = newName().trim();
    if (!name || creating()) {
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const label = await api.createLabel(props.projectId, {
        name,
        color: newColor(),
      });
      props.onLabelCreated(label);
      props.onChange([...props.value, label.id]);
      setNewName("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not create label",
      );
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <Select.Root
        collection={collection()}
        multiple
        value={props.value}
        onValueChange={(d) => props.onChange(d.value)}
        positioning={{ placement: "bottom-start", sameWidth: true }}
        disabled={props.disabled}
      >
        <SelectLabel text={props.label} />
        <Select.Control>
          <Select.Trigger class={triggerClass} aria-label="Labels">
            <Select.ValueText
              class="min-w-0 truncate"
              placeholder="No labels"
            />
            <Chevron />
          </Select.Trigger>
        </Select.Control>
        <Portal>
          <Select.Positioner>
            <Select.Content class={contentClass}>
              <For
                each={collection().items}
                fallback={
                  <p class="px-2 py-1.5 text-[13px] text-muted">
                    No labels yet
                  </p>
                }
              >
                {(item) => (
                  <Select.Item item={item} class={itemClass}>
                    <span
                      class="h-2 w-2 shrink-0 rounded-full"
                      style={{ "background-color": item.color }}
                    />
                    <Select.ItemText class="min-w-0 flex-1 truncate">
                      {item.name}
                    </Select.ItemText>
                    <Select.ItemIndicator>
                      <CheckIcon class="h-3.5 w-3.5" />
                    </Select.ItemIndicator>
                  </Select.Item>
                )}
              </For>
            </Select.Content>
          </Select.Positioner>
        </Portal>
      </Select.Root>

      <Show when={props.value.length > 0}>
        <div class="mt-2 flex flex-wrap gap-1.5">
          <For each={props.labels.filter((l) => props.value.includes(l.id))}>
            {(l) => <LabelChip label={l} />}
          </For>
        </div>
      </Show>

      <div class="mt-2 flex items-center gap-1.5">
        <input
          type="color"
          value={newColor()}
          onInput={(e) => setNewColor(e.currentTarget.value)}
          aria-label="New label color"
          class="h-8 w-8 shrink-0 cursor-pointer rounded-md border border-border bg-bg p-1"
        />
        <input
          type="text"
          value={newName()}
          onInput={(e) => setNewName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void addLabel();
            }
          }}
          placeholder="New label"
          aria-label="New label name"
          maxlength={40}
          class={inputClass}
        />
        <button
          type="button"
          onClick={() => void addLabel()}
          disabled={creating() || newName().trim().length === 0}
          class="inline-flex h-8 shrink-0 items-center rounded-md border border-border px-2.5 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
        >
          Add
        </button>
      </div>
      <Show when={error()}>
        {(msg) => (
          <p class="mt-1 text-[12px] text-red-600 dark:text-red-400">{msg()}</p>
        )}
      </Show>
    </div>
  );
}
