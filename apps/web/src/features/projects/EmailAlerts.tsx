// EmailAlerts — the channel's notify-by-email list. Every new message in
// the channel mails these addresses; needs SMTP configured (Settings →
// Email, or SMTP_* env on the server).
import { createSignal, Show } from "solid-js";
import { Dialog } from "@ark-ui/solid";
import { Portal } from "solid-js/web";
import type { Channel } from "@relay/api-client";
import { api } from "../../lib/api";
import { FormError, inputClass, SubmitButton } from "../../components/ui";
import { XIcon } from "../../components/icons";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function EmailAlerts(props: {
  channel: () => Channel | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [list, setList] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);

  async function save(e: SubmitEvent) {
    e.preventDefault();
    const ch = props.channel();
    if (!ch) return;
    const addrs = list()
      .split(/[\s,;]+/)
      .map((a) => a.trim())
      .filter(Boolean);
    setError(null);
    setPending(true);
    try {
      await api.updateChannel(ch.id, { email_alerts: addrs });
      props.onSaved();
      props.onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err, "Could not save email alerts"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(d) => {
        if (d.open) {
          setList((props.channel()?.email_alerts ?? []).join(", "));
          setError(null);
        }
        props.onOpenChange(d.open);
      }}
    >
      <Portal>
        <Dialog.Backdrop class="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Positioner class="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto p-4 pt-[10vh]">
          <Dialog.Content class="w-full max-w-md rounded-md border border-border bg-surface p-5 shadow-lg outline-none">
            <div class="flex items-start justify-between gap-3">
              <div>
                <Dialog.Title class="text-[14px] font-semibold">
                  Email alerts
                </Dialog.Title>
                <Dialog.Description class="mt-1 text-[12px] text-muted">
                  Every new message in #{props.channel()?.name} is emailed to
                  these addresses. Requires SMTP — Settings → Email, or SMTP_*
                  env on the server.
                </Dialog.Description>
              </div>
              <Dialog.CloseTrigger class="rounded p-1 text-muted transition-colors hover:bg-hover hover:text-fg">
                <XIcon class="h-4 w-4" />
              </Dialog.CloseTrigger>
            </div>
            <form onSubmit={save} class="mt-4 space-y-3">
              <textarea
                value={list()}
                onInput={(e) => setList(e.currentTarget.value)}
                placeholder="support@example.com, oncall@example.com"
                rows={3}
                class={inputClass + " resize-none"}
              />
              <div class="flex items-center gap-2">
                <SubmitButton pending={pending()}>Save</SubmitButton>
                <FormError message={error()} />
                <Show when={(props.channel()?.email_alerts?.length ?? 0) > 0}>
                  <span class="text-[11.5px] text-faint">
                    Clear the list to turn alerts off.
                  </span>
                </Show>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
