import {
  createResource,
  createSignal,
  For,
  Show,
  Switch,
} from "solid-js";
import { FormError, SubmitButton } from "../../components/ui";
import { api } from "../../lib/api";
import { markGitHub } from "./GitHub";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export default function GitHubAppSection(props: {
  workspaceId: string;
  canManage: boolean;
}) {
  const [app, { refetch: refetchApp }] = createResource(() =>
    api.getGitHubApp(),
  );
  const [installations, { refetch: refetchInst }] = createResource(
    () => (app()?.registered ? props.workspaceId : null),
    (ws) => api.listGitHubInstallations(ws),
  );
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);
  const [confirmDelete, setConfirmDelete] = createSignal(false);

  // GitHub's app-manifest flow: POST the manifest JSON to
  // github.com/settings/apps/new in a new navigation. We build a real
  // form and submit it — fetch can't cross-post a form.
  async function register() {
    setError(null);
    setPending(true);
    try {
      const { manifest, post_url } = await api.githubManifest(
        props.workspaceId,
      );
      const form = document.createElement("form");
      form.method = "POST";
      form.action = post_url;
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "manifest";
      input.value = JSON.stringify(manifest);
      form.appendChild(input);
      document.body.appendChild(form);
      form.submit();
    } catch (err) {
      setError(errorMessage(err, "Could not start GitHub registration"));
      setPending(false);
    }
  }

  async function remove() {
    setPending(true);
    setError(null);
    try {
      await api.deleteGitHubApp();
      setConfirmDelete(false);
      refetchApp();
      refetchInst();
    } catch (err) {
      setError(errorMessage(err, "Could not remove the app"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div class="flex flex-col gap-4">
      <p class="text-[13px] text-muted">
        Connect GitHub to mirror issues, track pull requests, and let agents
        inspect repository activity.
      </p>

      <Switch>
        <Show when={app()}>
          {(a) => (
            <Show
              when={a().registered}
              fallback={
                <Show when={props.canManage}>
                  <div>
                    <SubmitButton
                      pending={pending()}
                      onClick={register}
                      type="button"
                    >
                      <span class="inline-flex items-center gap-1.5">
                        {markGitHub("", "h-3.5 w-3.5")}
                        {pending()
                          ? "Opening GitHub…"
                          : "Register Relay as a GitHub App"}
                      </span>
                    </SubmitButton>
                    <p class="mt-2 max-w-md text-[11.5px] text-muted">
                      GitHub will ask you to confirm the app name and
                      permissions, then return here. Install it on your
                      repositories afterwards.
                    </p>
                  </div>
                </Show>
              }
            >
              <div class="flex items-center justify-between rounded-md border border-border bg-surface px-3 py-2.5">
                <div class="flex items-center gap-2.5">
                  {markGitHub("", "h-4 w-4")}
                  <div>
                    <p class="text-[13px] font-medium">{a().name ?? a().slug}</p>
                    <p class="font-mono text-[11px] text-muted">
                      app #{a().app_id}
                    </p>
                  </div>
                </div>
                <div class="flex items-center gap-3">
                  <Show when={a().install_url}>
                    <a
                      href={a().install_url}
                      class="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white"
                    >
                      Install on GitHub
                    </a>
                  </Show>
                  <Show when={props.canManage}>
                    <Show
                      when={!confirmDelete()}
                      fallback={
                        <button
                          type="button"
                          class="text-[12px] font-medium text-danger"
                          onClick={remove}
                          disabled={pending()}
                        >
                          Confirm remove
                        </button>
                      }
                    >
                      <button
                        type="button"
                        class="text-[12px] text-muted hover:text-danger"
                        onClick={() => setConfirmDelete(true)}
                      >
                        Remove
                      </button>
                    </Show>
                  </Show>
                </div>
              </div>

              <div>
                <h3 class="mb-1.5 text-[12px] font-medium text-muted">
                  Installations
                </h3>
                <ul class="divide-y divide-border rounded-md border border-border">
                  <For
                    each={installations()?.installations}
                    fallback={
                      <li class="px-3 py-2.5 text-[13px] text-muted">
                        None yet — install the app on a GitHub account or
                        organization.
                      </li>
                    }
                  >
                    {(i) => (
                      <li class="flex items-center gap-2.5 px-3 py-2.5">
                        {markGitHub("", "h-3.5 w-3.5 text-muted")}
                        <span class="text-[13px]">{i.account_login}</span>
                        <span class="font-mono text-[11px] text-muted">
                          #{i.installation_id}
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            </Show>
          )}
        </Show>
      </Switch>

      <FormError message={error()} />
    </div>
  );
}
