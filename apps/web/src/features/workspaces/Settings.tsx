import { ApiClientError, type WorkspaceRole } from "@relay/api-client";
import {
  createResource,
  createSignal,
  For,
  Show,
  type ParentProps,
} from "solid-js";
import {
  Field,
  FormError,
  SubmitButton,
  inputClass,
  primaryButtonClass,
} from "../../components/ui";
import { api } from "../../lib/api";
import { useSession } from "../../stores/session";
import AgentsSection from "../agents/AgentsSection";
import GitHubAppSection from "../github/GitHubAppSection";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiClientError
    ? err.message
    : err instanceof Error
      ? err.message
      : fallback;
}

function Section(props: ParentProps<{ title: string }>) {
  return (
    <section class="border-t border-border py-6 first:border-t-0 first:pt-0">
      <h2 class="mb-4 text-[13px] font-semibold">{props.title}</h2>
      {props.children}
    </section>
  );
}

function ChangePasswordForm() {
  const [error, setError] = createSignal<string | null>(null);
  const [done, setDone] = createSignal(false);
  const [pending, setPending] = createSignal(false);

  async function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    setError(null);
    setDone(false);
    setPending(true);
    try {
      await api.changePassword(
        String(data.get("current_password") ?? ""),
        String(data.get("new_password") ?? ""),
      );
      form.reset();
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiClientError && err.status === 401
          ? "Current password is incorrect"
          : errorMessage(err, "Could not update password"),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} class="flex max-w-sm flex-col gap-4">
      <Field label="Current password">
        <input
          type="password"
          name="current_password"
          required
          autocomplete="current-password"
          class={inputClass}
        />
      </Field>
      <Field label="New password">
        <input
          type="password"
          name="new_password"
          required
          minlength={8}
          autocomplete="new-password"
          class={inputClass}
        />
      </Field>
      <FormError message={error()} />
      <Show when={done()}>
        <p class="text-[13px] text-muted">Password updated.</p>
      </Show>
      <div>
        <SubmitButton pending={pending()}>
          {pending() ? "Updating..." : "Change password"}
        </SubmitButton>
      </div>
    </form>
  );
}

function MemberList(props: { workspaceId: string; canInvite: boolean }) {
  const [members, { refetch }] = createResource(
    () => props.workspaceId,
    async (id) => (await api.listWorkspaceMembers(id)).members,
  );
  const [inviteError, setInviteError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);

  async function onInvite(e: SubmitEvent) {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    setInviteError(null);
    setPending(true);
    try {
      await api.inviteToWorkspace(props.workspaceId, {
        email: String(data.get("email") ?? ""),
        role: String(data.get("role") ?? "member") as WorkspaceRole,
      });
      form.reset();
      await refetch();
    } catch (err) {
      setInviteError(
        err instanceof ApiClientError && err.status === 404
          ? "No account exists for that email"
          : errorMessage(err, "Invite failed"),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div class="flex flex-col gap-4">
      <ul class="divide-y divide-border rounded-md border border-border">
        <For
          each={members()}
          fallback={
            <li class="px-3 py-2.5 text-[13px] text-muted">
              {members.state === "errored"
                ? "Could not load members"
                : "Loading members..."}
            </li>
          }
        >
          {(m) => (
            <li class="flex items-center gap-3 px-3 py-2.5">
              <div class="min-w-0 flex-1">
                <p class="truncate text-[13px] font-medium">{m.user.name}</p>
                <p class="truncate text-[13px] text-muted">{m.user.email}</p>
              </div>
              <span class="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted">
                {m.role}
              </span>
            </li>
          )}
        </For>
      </ul>

      <Show when={props.canInvite}>
        <form onSubmit={onInvite} class="flex max-w-sm flex-col gap-3">
          <div class="flex gap-2">
            <input
              type="email"
              name="email"
              required
              placeholder="teammate@example.com"
              aria-label="Invite email"
              class={inputClass}
            />
            <select name="role" class={inputClass} aria-label="Role">
              <option value="member">member</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <FormError message={inviteError()} />
          <div>
            <SubmitButton pending={pending()}>
              {pending() ? "Adding..." : "Add member"}
            </SubmitButton>
          </div>
        </form>
      </Show>
    </div>
  );
}

function NewWorkspaceForm(props: { onCreated: () => void }) {
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);

  async function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    const data = new FormData(e.currentTarget as HTMLFormElement);
    const slug = String(data.get("slug") ?? "").trim();
    setError(null);
    setPending(true);
    try {
      await api.createWorkspace({
        name: String(data.get("name") ?? "").trim(),
        ...(slug ? { slug } : {}),
      });
      props.onCreated();
    } catch (err) {
      setError(errorMessage(err, "Could not create workspace"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} class="flex max-w-sm flex-col gap-4">
      <Field label="Workspace name">
        <input type="text" name="name" required class={inputClass} />
      </Field>
      <Field label="Slug (optional)">
        <input
          type="text"
          name="slug"
          pattern="[a-z0-9-]+"
          class={inputClass}
        />
      </Field>
      <FormError message={error()} />
      <div>
        <SubmitButton pending={pending()}>
          {pending() ? "Creating..." : "Create workspace"}
        </SubmitButton>
      </div>
    </form>
  );
}

export default function Settings() {
  const session = useSession();
  const current = () => session.workspaces()[0];
  const canInvite = () => {
    const role = current()?.role;
    return role === "owner" || role === "admin";
  };
  const [showNew, setShowNew] = createSignal(false);
  const [avatarError, setAvatarError] = createSignal<string | null>(null);

  return (
    <div class="mx-auto w-full max-w-2xl px-6 py-8">
      <h1 class="mb-6 text-[15px] font-semibold">Settings</h1>

      <Section title="Account">
        <div class="mb-5 flex items-center gap-3">
          <Show
            when={session.user()?.avatar_url}
            fallback={
              <span class="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface font-mono text-[13px] text-muted">
                {(session.user()?.name ?? "?").slice(0, 1).toUpperCase()}
              </span>
            }
          >
            {(url) => (
              <img
                src={url()}
                alt=""
                class="h-10 w-10 rounded-full border border-border object-cover"
              />
            )}
          </Show>
          <div class="min-w-0 flex-1">
            <p class="text-[13px] font-medium">{session.user()?.name}</p>
            <p class="text-[13px] text-muted">{session.user()?.email}</p>
          </div>
          <label class="cursor-pointer rounded-md border border-border bg-surface px-2.5 py-1 text-[12px] hover:bg-hover">
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              class="sr-only"
              onChange={async (e) => {
                const f = e.currentTarget.files?.[0];
                if (!f) return;
                try {
                  await api.uploadAvatar(f);
                  await session.refresh();
                } catch (err) {
                  setAvatarError(errorMessage(err, "Upload failed"));
                }
                e.currentTarget.value = "";
              }}
            />
            Set avatar
          </label>
        </div>
        <FormError message={avatarError()} />
        <ChangePasswordForm />
      </Section>

      <Section title="Workspace">
        <Show
          when={current()}
          fallback={
            <div class="flex flex-col gap-4">
              <p class="text-[13px] text-muted">
                You are not in a workspace yet.
              </p>
              <NewWorkspaceForm onCreated={() => session.refresh()} />
            </div>
          }
        >
          {(ws) => (
            <div class="flex flex-col gap-5">
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-[13px] font-medium">{ws().name}</p>
                  <p class="font-mono text-[11px] text-muted">
                    {ws().slug} · {ws().role}
                  </p>
                </div>
                <button
                  type="button"
                  class={primaryButtonClass}
                  onClick={() => setShowNew((v) => !v)}
                >
                  New workspace
                </button>
              </div>
              <Show when={showNew()}>
                <NewWorkspaceForm
                  onCreated={() => {
                    setShowNew(false);
                    session.refresh();
                  }}
                />
              </Show>
              <MemberList workspaceId={ws().id} canInvite={canInvite()} />
            </div>
          )}
        </Show>
      </Section>

      <Show when={current()}>
        {(ws) => (
          <>
            <Section title="Agents">
              <AgentsSection workspaceId={ws().id} canManage={canInvite()} />
            </Section>
            <Section title="GitHub">
              <GitHubAppSection workspaceId={ws().id} canManage={canInvite()} />
            </Section>
          </>
        )}
      </Show>
    </div>
  );
}
