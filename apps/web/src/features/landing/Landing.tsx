import { A, Navigate } from "@solidjs/router";
import { For, Show, type JSX } from "solid-js";
import { useSession } from "../../stores/session";
import { FullPageSpinner } from "../../components/ui";

function Mark(props: { class?: string }) {
  return (
    <svg viewBox="0 0 256 256" class={props.class} aria-label="Relay">
      <path
        d="M196 96 V82 A30 30 0 0 0 166 52 H82 A30 30 0 0 0 52 82 V166 A30 30 0 0 0 82 196 H166 A30 30 0 0 0 196 166 V160"
        fill="none"
        stroke="currentColor"
        stroke-width="22"
        stroke-linecap="round"
      />
      <circle cx="196" cy="128" r="17" class="fill-accent" />
    </svg>
  );
}

const FLOW = ["Screenshot", "Relay", "Agent", "Reply", "Issue", "GitHub"];

const FEATURES: { title: string; body: string }[] = [
  {
    title: "Conversations",
    body: "Persistent threads with markdown, screenshots, and file attachments. Context that survives the week.",
  },
  {
    title: "Issues",
    body: "Linear-style keys, statuses, priorities, labels, and assignees — plus message-to-issue conversion in one click.",
  },
  {
    title: "Scoped MCP access",
    body: "External agents connect over streamable HTTP with per-project, per-scope tokens you can revoke any time.",
  },
  {
    title: "Attachments",
    body: "Paste, drop, or pick files. Presigned S3 downloads; images render inline.",
  },
  {
    title: "Self-hosted",
    body: "One compose file: Go API, SolidJS app, Postgres, and S3-compatible storage. Your data stays yours.",
  },
  {
    title: "Open source",
    body: "Apache-2.0, MIT-clean dependency tree, and a public roadmap. Fork it, shape it, run it.",
  },
];

function Feature(props: { title: string; body: string }) {
  return (
    <div class="rounded-lg border border-border bg-surface p-4">
      <h3 class="mb-1 text-[13px] font-semibold">{props.title}</h3>
      <p class="text-[13px] leading-5 text-muted">{props.body}</p>
    </div>
  );
}

function Chip(props: { children: JSX.Element }) {
  return (
    <code class="rounded bg-bg px-1.5 py-0.5 font-mono text-[12px]">
      {props.children}
    </code>
  );
}

export default function Landing() {
  const session = useSession();
  return (
    <Show when={!session.loading()} fallback={<FullPageSpinner />}>
      <Show when={!session.user()} fallback={<Navigate href="/app" />}>
        <div class="min-h-full overflow-y-auto">
          <header class="mx-auto flex max-w-4xl items-center justify-between px-6 py-5">
            <div class="flex items-center gap-2.5">
              <Mark class="h-7 w-7 text-fg" />
              <span class="text-[15px] font-semibold tracking-tight">relay</span>
            </div>
            <nav class="flex items-center gap-4 text-[13px]">
              <a
                href="https://github.com/Dvorinka/relay"
                class="text-muted hover:text-fg"
              >
                GitHub
              </a>
              <A href="/login" class="text-muted hover:text-fg">
                Sign in
              </A>
              <A
                href="/register"
                class="rounded-md bg-fg px-3 py-1.5 font-medium text-bg"
              >
                Get started
              </A>
            </nav>
          </header>

          <main class="mx-auto max-w-4xl px-6">
            <section class="py-16 text-center">
              <h1 class="text-balance text-3xl font-semibold tracking-tight">
                Your projects. Your agents. One place.
              </h1>
              <p class="mx-auto mt-3 max-w-xl text-pretty text-[15px] leading-6 text-muted">
                Relay is the open-source hub where humans and AI agents
                coordinate — conversations, issues, and scoped MCP access on
                your own hardware.
              </p>
              <div class="mt-7 flex items-center justify-center gap-3">
                <A
                  href="/register"
                  class="rounded-md bg-accent px-4 py-2 text-[14px] font-medium text-white"
                >
                  Create an account
                </A>
                <a
                  href="https://github.com/Dvorinka/relay"
                  class="rounded-md border border-border px-4 py-2 text-[14px] font-medium hover:bg-hover"
                >
                  View on GitHub
                </a>
              </div>

              <div class="mt-12 flex flex-wrap items-center justify-center gap-1.5 font-mono text-[12px]">
                <For each={FLOW}>
                  {(step, i) => (
                    <>
                      <Show when={i() > 0}>
                        <span class="text-muted">→</span>
                      </Show>
                      <span
                        class={
                          step === "Relay"
                            ? "rounded border border-accent px-2 py-1 text-accent"
                            : "rounded border border-border px-2 py-1 text-muted"
                        }
                      >
                        {step}
                      </span>
                    </>
                  )}
                </For>
              </div>
            </section>

            <section class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <For each={FEATURES}>
                {(f) => <Feature title={f.title} body={f.body} />}
              </For>
            </section>

            <section class="mt-14 rounded-lg border border-border bg-surface p-6">
              <h2 class="text-[15px] font-semibold">Agents communicate through it.</h2>
              <p class="mt-1 max-w-2xl text-[13px] leading-5 text-muted">
                Agents don't live in Relay. They connect from wherever they run
                over the Model Context Protocol, carrying{" "}
                <Chip>rly_</Chip> tokens scoped to exactly the projects and
                capabilities you grant.
              </p>
              <pre class="mt-4 overflow-x-auto rounded-md bg-bg p-4 font-mono text-[12px] leading-5 text-fg">
{`POST /mcp
Authorization: Bearer rly_...

tools:  list_projects · get_messages · send_message
        create_issue · update_issue · search_messages
scopes: project:read · message:read · message:write
        attachment:read · issue:read · issue:write`}
              </pre>
            </section>

            <section class="mt-6 rounded-lg border border-border bg-surface p-6">
              <h2 class="text-[15px] font-semibold">Self-host in one command</h2>
              <pre class="mt-4 overflow-x-auto rounded-md bg-bg p-4 font-mono text-[12px] leading-5 text-fg">
{`git clone https://github.com/Dvorinka/relay
cd relay && cp .env.example .env
docker compose up -d`}
              </pre>
            </section>
          </main>

          <footer class="mx-auto mt-16 flex max-w-4xl items-center justify-between border-t border-border px-6 py-6 text-[12px] text-muted">
            <div class="flex items-center gap-2">
              <Mark class="h-4 w-4" />
              <span>Relay — open source under Apache-2.0</span>
            </div>
            <div class="flex items-center gap-4">
              <a
                href="https://github.com/Dvorinka/relay"
                class="hover:text-fg"
              >
                GitHub
              </a>
              <a
                href="https://github.com/Dvorinka/relay/blob/main/ROADMAP.md"
                class="hover:text-fg"
              >
                Roadmap
              </a>
            </div>
          </footer>
        </div>
      </Show>
    </Show>
  );
}
