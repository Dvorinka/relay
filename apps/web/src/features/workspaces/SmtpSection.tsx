// SMTP setup — in-app alternative to SMTP_* env vars. Powers channel
// email alerts and any transactional mail (auth magic links included).
import { createResource, createSignal, Show } from "solid-js";
import { FormError, inputClass, SubmitButton } from "../../components/ui";
import { api } from "../../lib/api";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export default function SmtpSection(props: { canManage: boolean }) {
  const [smtp, { refetch }] = createResource(() =>
    api.getSmtpSettings().catch(() => null),
  );
  const [error, setError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);
  const [testTo, setTestTo] = createSignal("");
  const [testing, setTesting] = createSignal(false);

  const envBacked = () => smtp()?.smtp.source === "env";

  async function save(e: SubmitEvent) {
    e.preventDefault();
    const data = new FormData(e.currentTarget as HTMLFormElement);
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      await api.putSmtpSettings({
        host: String(data.get("host") ?? "").trim(),
        port: Number(data.get("port") ?? 587),
        username: String(data.get("username") ?? "").trim(),
        password: String(data.get("password") ?? ""),
        from_address: String(data.get("from_address") ?? "").trim(),
        from_name: String(data.get("from_name") ?? "").trim(),
      });
      setNotice("Saved — in-app settings now override any SMTP_* env.");
      refetch();
    } catch (err) {
      setError(errorMessage(err, "Could not save SMTP settings"));
    } finally {
      setPending(false);
    }
  }

  async function sendTest() {
    setError(null);
    setNotice(null);
    setTesting(true);
    try {
      await api.testSmtp(testTo());
      setNotice("Test email sent — check the inbox.");
    } catch (err) {
      setError(errorMessage(err, "Test email failed"));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div class="space-y-3 text-[13px]">
      <p class="text-muted">
        Outgoing mail for channel email alerts and account flows. Configure
        here or with{" "}
        <code class="font-mono text-[12px]">
          SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM
        </code>{" "}
        env vars — in-app settings win when both exist.
      </p>

      <Show when={smtp()?.smtp.configured === false && !envBacked()}>
        <p class="text-muted">Not configured yet.</p>
      </Show>
      <Show when={envBacked()}>
        <p class="rounded-md border border-border bg-hover/40 px-3 py-2 text-[12px] text-muted">
          Serving from environment:{" "}
          <span class="font-mono text-fg">
            {smtp()?.smtp.host}:{smtp()?.smtp.port}
          </span>{" "}
          as {smtp()?.smtp.from_address}. Save the form to take over with an
          in-app config.
        </p>
      </Show>

      <Show when={props.canManage} fallback={
        <Show when={smtp()?.smtp.configured}>
          <p class="text-muted">
            SMTP configured — only workspace admins can change it.
          </p>
        </Show>
      }>
        <form onSubmit={save} class="grid grid-cols-2 gap-2">
          <label class="col-span-1 flex flex-col gap-1">
            <span class="text-[11px] font-medium text-muted">Host</span>
            <input
              name="host"
              required
              placeholder="smtp.example.com"
              value={smtp()?.smtp.host ?? ""}
              class={inputClass}
            />
          </label>
          <label class="col-span-1 flex flex-col gap-1">
            <span class="text-[11px] font-medium text-muted">Port</span>
            <input
              name="port"
              type="number"
              required
              placeholder="587"
              value={smtp()?.smtp.port ?? "587"}
              class={inputClass}
            />
          </label>
          <label class="col-span-1 flex flex-col gap-1">
            <span class="text-[11px] font-medium text-muted">Username</span>
            <input
              name="username"
              autocomplete="off"
              placeholder="optional for open relays"
              value={smtp()?.smtp.username ?? ""}
              class={inputClass}
            />
          </label>
          <label class="col-span-1 flex flex-col gap-1">
            <span class="text-[11px] font-medium text-muted">Password</span>
            <input
              name="password"
              type="password"
              autocomplete="new-password"
              placeholder={
                smtp()?.smtp.has_password ? "•••••• (kept if empty)" : "optional"
              }
              class={inputClass}
            />
          </label>
          <label class="col-span-1 flex flex-col gap-1">
            <span class="text-[11px] font-medium text-muted">From address</span>
            <input
              name="from_address"
              type="email"
              required
              placeholder="relay@example.com"
              value={smtp()?.smtp.from_address ?? ""}
              class={inputClass}
            />
          </label>
          <label class="col-span-1 flex flex-col gap-1">
            <span class="text-[11px] font-medium text-muted">From name</span>
            <input
              name="from_name"
              placeholder="Relay"
              value={smtp()?.smtp.from_name ?? ""}
              class={inputClass}
            />
          </label>
          <div class="col-span-2 flex items-center gap-2">
            <SubmitButton pending={pending()}>Save SMTP</SubmitButton>
            <FormError message={error()} />
            <Show when={notice()}>
              <span class="text-[12px] text-green-500">{notice()}</span>
            </Show>
          </div>
        </form>

        <Show when={smtp()?.smtp.configured}>
          <div class="flex items-center gap-2 border-t border-border/60 pt-3">
            <input
              type="email"
              placeholder="send a test to…"
              value={testTo()}
              onInput={(e) => setTestTo(e.currentTarget.value)}
              class={inputClass + " max-w-56"}
            />
            <button
              type="button"
              disabled={testing() || !testTo().includes("@")}
              onClick={() => void sendTest()}
              class="rounded-md border border-border px-3 py-1.5 text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
            >
              {testing() ? "Sending…" : "Send test"}
            </button>
          </div>
        </Show>
      </Show>

      <p class="text-[12px] text-faint">
        Then pick a channel → mail icon in its header → add the addresses
        that should get every new message. Port 465 uses implicit TLS; other
        ports use STARTTLS when the server offers it.
      </p>
    </div>
  );
}
