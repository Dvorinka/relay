import { Dialog } from "@ark-ui/solid";
import type { IssuePriority, IssueStatus, Project } from "@relay/api-client";
import { useNavigate } from "@solidjs/router";
import { createResource, createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import { FormError, inputClass, SubmitButton } from "../../components/ui";
import { api } from "../../lib/api";
import { AssigneeSelect, LabelsPicker, PrioritySelect, StatusSelect } from "./fields";

export function NewIssueDialog(props: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const [title, setTitle] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [status, setStatus] = createSignal<IssueStatus>("backlog");
  const [priority, setPriority] = createSignal<IssuePriority>("none");
  const [assigneeId, setAssigneeId] = createSignal<string | null>(null);
  const [labelIds, setLabelIds] = createSignal<string[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);

  // Fetched lazily: the resources only run while the dialog is open.
  const [members] = createResource(
    () => (props.open ? props.project.workspace_id : null),
    async (id) => (await api.listWorkspaceMembers(id)).members,
  );
  const [labels, { mutate: mutateLabels }] = createResource(
    () => (props.open ? props.project.id : null),
    async (id) => (await api.listLabels(id)).labels,
  );

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    const t = title().trim();
    if (!t || pending()) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      const desc = description().trim();
      const aid = assigneeId();
      const lids = labelIds();
      const issue = await api.createIssue(props.project.id, {
        title: t,
        ...(desc ? { description: desc } : {}),
        status: status(),
        priority: priority(),
        ...(aid ? { assignee_id: aid } : {}),
        ...(lids.length > 0 ? { label_ids: lids } : {}),
      });
      props.onOpenChange(false);
      navigate(`/p/${props.project.id}/i/${issue.id}`);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not create issue",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(d) => props.onOpenChange(d.open)}
    >
      <Portal>
        <Dialog.Backdrop class="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Positioner class="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto p-4 pt-[10vh]">
          <Dialog.Content class="w-full max-w-lg rounded-md border border-border bg-surface p-5 shadow-lg outline-none">
            <Dialog.Title class="text-[14px] font-semibold">
              New issue
            </Dialog.Title>
            <form onSubmit={submit} class="mt-4 flex flex-col gap-4">
              <input
                ref={(el) => requestAnimationFrame(() => el.focus())}
                type="text"
                value={title()}
                onInput={(e) => setTitle(e.currentTarget.value)}
                placeholder="Issue title"
                aria-label="Title"
                required
                maxlength={200}
                class={inputClass}
              />
              <textarea
                value={description()}
                onInput={(e) => setDescription(e.currentTarget.value)}
                placeholder="Description (markdown)"
                aria-label="Description"
                rows={4}
                maxlength={20000}
                class={`${inputClass} resize-y`}
              />
              <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <StatusSelect
                  label="Status"
                  value={status()}
                  onChange={setStatus}
                />
                <PrioritySelect
                  label="Priority"
                  value={priority()}
                  onChange={setPriority}
                />
                <AssigneeSelect
                  label="Assignee"
                  members={members() ?? []}
                  value={assigneeId()}
                  onChange={setAssigneeId}
                />
              </div>
              <LabelsPicker
                label="Labels"
                projectId={props.project.id}
                labels={labels() ?? []}
                value={labelIds()}
                onChange={setLabelIds}
                onLabelCreated={(l) =>
                  mutateLabels((cur) => [...(cur ?? []), l])
                }
              />
              <FormError message={error()} />
              <div class="flex justify-end gap-2">
                <Dialog.CloseTrigger
                  type="button"
                  class="inline-flex h-8 items-center justify-center rounded-md px-3 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg"
                >
                  Cancel
                </Dialog.CloseTrigger>
                <SubmitButton pending={pending()}>
                  {pending() ? "Creating..." : "Create issue"}
                </SubmitButton>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
