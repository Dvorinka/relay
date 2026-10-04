import type { MentionRef } from "@relay/api-client";
import DOMPurify from "dompurify";
import { Marked } from "marked";
import { createMemo } from "solid-js";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ESCAPES[c] ?? c);
}

// Inline tokens that look like references get linkified:
//   owner/repo#123  -> GitHub issue/PR
//   KEY-123         -> Relay issue (resolved through the /k/ redirect route)
interface RelayToken {
  type: "relayLink";
  raw: string;
  href?: string;
  key?: string;
  text: string;
  fileSrc?: "local" | "github";
  fileRepo?: string;
  filePath?: string;
  personKind?: string;
  personName?: string;
}

// Mentions resolved against the message currently being rendered. Marked
// renderers can't take per-call context, and parsing is synchronous, so a
// module slot filled by renderMarkdown is the simplest correct channel.
let activeMentions: MentionRef[] = [];

// A mention token matches when the message carries a resolved person ref
// with the same handle — display name, slug, or the space-dash form the
// composer inserts.
function personMatch(
  name: string,
  kind: string,
): MentionRef | undefined {
  const n = name.toLowerCase();
  return activeMentions.find(
    (r) =>
      (r.kind === "user" || r.kind === "agent") &&
      (kind === "bare" || r.kind === kind) &&
      (r.ref.toLowerCase() === n ||
        r.label.toLowerCase() === n ||
        r.label.toLowerCase().replace(/\s+/g, "-") === n),
  );
}

function linkifyExtension(projectId?: string) {
  return {
    extensions: [
      {
        name: "relayLink",
        level: "inline" as const,
        start(src: string) {
          return src.match(/[@A-Za-z0-9]/)?.index;
        },
        tokenizer(src: string): RelayToken | undefined {
          // @gh:owner/repo:path — linked-repo file mention
          const ghFile = src.match(
            /^@gh:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+):([^\s]+)/,
          );
          if (ghFile) {
            return {
              type: "relayLink",
              raw: ghFile[0],
              text: ghFile[2] ?? ghFile[0],
              fileSrc: "github",
              fileRepo: ghFile[1] ?? "",
              filePath: ghFile[2] ?? "",
            };
          }
          // @file:path — linked local folder mention
          const localFile = src.match(/^@file:([^\s]+)/);
          if (localFile) {
            return {
              type: "relayLink",
              raw: localFile[0],
              text: localFile[1] ?? "",
              fileSrc: "local",
              filePath: localFile[1] ?? "",
            };
          }
          // @agent:slug / @user:name — explicit person mentions
          const person = src.match(/^@(agent|user):([A-Za-z0-9][\w.-]{0,59})/);
          if (person) {
            return {
              type: "relayLink",
              raw: person[0],
              text: person[0],
              personKind: person[1] ?? "",
              personName: person[2] ?? "",
            };
          }
          // @name — bare mention; the renderer only chips it when the
          // message's resolved mentions confirm a real person, otherwise
          // the raw text falls through untouched (emails, handles, etc).
          const bare = src.match(/^@([A-Za-z0-9][\w.-]{0,59})(?![\w@.:-])/);
          if (bare && personMatch(bare[1] ?? "", "bare")) {
            return {
              type: "relayLink",
              raw: bare[0],
              text: bare[0],
              personKind: "bare",
              personName: bare[1] ?? "",
            };
          }
          const gh = src.match(
            /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)(?![\d\w])/,
          );
          if (gh) {
            return {
              type: "relayLink",
              raw: gh[0],
              text: `${gh[1]}#${gh[2]}`,
              href: `https://github.com/${gh[1]}/issues/${gh[2]}`,
            };
          }
          const key = src.match(/^([A-Z][A-Z0-9]{1,9}-\d+)(?![\d\w-])/);
          const k = key?.[1];
          if (k) {
            return {
              type: "relayLink",
              raw: key![0],
              text: k,
              key: k,
            };
          }
          return undefined;
        },
        renderer(token: RelayToken) {
          if (token.fileSrc && token.filePath) {
            const name = escapeHtml(
              token.filePath.split("/").pop() ?? token.filePath,
            );
            const repo = escapeHtml(token.fileRepo ?? "");
            const path = escapeHtml(token.filePath);
            return (
              `<button type="button" class="md-ref md-file" ` +
              `data-file-src="${token.fileSrc}" data-repo="${repo}" ` +
              `data-path="${path}" title="${path}">${name}</button>`
            );
          }
          if (token.personKind) {
            const hit = personMatch(
              token.personName ?? "",
              token.personKind,
            );
            if (hit?.found && hit.id) {
              const href =
                hit.kind === "agent"
                  ? `/app/ag/${hit.id}`
                  : `/app/u/${hit.id}`;
              return (
                `<a href="${href}" class="md-ref md-mention md-mention-${hit.kind}" ` +
                `data-uid="${hit.id}" data-pkind="${hit.kind}">@${escapeHtml(hit.label)}</a>`
              );
            }
            // bare @names that didn't resolve render as plain text —
            // anything else keeps a quiet chip so explicit syntax stays
            // visually distinct even for missing entities
            if (token.personKind === "bare") {
              return escapeHtml(token.raw);
            }
            return (
              `<span class="md-ref md-mention md-mention-miss" data-kind="${token.personKind}">` +
              `@${escapeHtml(token.personName ?? "")}</span>`
            );
          }
          if (token.href) {
            return `<a href="${token.href}" target="_blank" rel="noreferrer" class="md-ref">${token.text}</a>`;
          }
          if (token.key && projectId) {
            return `<a href="/app/p/${projectId}/k/${token.key}" class="md-ref">${token.key}</a>`;
          }
          return `<code class="md-ref-key">${token.text}</code>`;
        },
      },
    ],
  };
}

const parsers = new Map<string, Marked>();

// Fenced code blocks render with a language header and a copy affordance,
// Discord-style. The copy button's handler is delegated in <Markdown> -
// DOMPurify strips inline handlers.
function codeRenderer(token: { text: string; lang?: string }): string {
  const lang = (token.lang ?? "").trim().split(/\s/)[0] ?? "";
  const label = lang === "" ? "text" : escapeHtml(lang);
  return (
    `<div class="md-pre"><div class="md-pre-head"><span>${label}</span>` +
    `<button type="button" class="md-pre-copy">copy</button></div>` +
    `<pre><code>${escapeHtml(token.text)}</code></pre></div>`
  );
}

function parserFor(projectId?: string): Marked {
  const cacheKey = projectId ?? "";
  let p = parsers.get(cacheKey);
  if (!p) {
    p = new Marked({
      gfm: true,
      breaks: true,
      walkTokens(token) {
        if (token.type === "html") {
          token.text = escapeHtml(token.text);
        }
      },
      ...linkifyExtension(projectId),
    });
    p.use({ renderer: { code: codeRenderer } });
    parsers.set(cacheKey, p);
  }
  return p;
}

export function renderMarkdown(
  body: string,
  projectId?: string,
  mentions?: MentionRef[],
): string {
  activeMentions = mentions ?? [];
  try {
    return DOMPurify.sanitize(
      parserFor(projectId).parse(body, { async: false }),
    );
  } finally {
    activeMentions = [];
  }
}

export function Markdown(props: {
  body: string;
  class?: string;
  projectId?: string;
  mentions?: MentionRef[];
}) {
  const html = createMemo(() =>
    renderMarkdown(props.body, props.projectId, props.mentions),
  );
  return (
    <div
      class={`md ${props.class ?? ""}`}
      innerHTML={html()}
      onClick={(e) => {
        // Mention chips open the profile modal — navigation stays as
        // fallback via the real href for middle-click/new-tab.
        const mention = (e.target as HTMLElement).closest(".md-mention");
        if (mention) {
          const uid = mention.getAttribute("data-uid");
          const kind = mention.getAttribute("data-pkind");
          if (uid && kind) {
            e.preventDefault();
            window.dispatchEvent(
              new CustomEvent("relay:open-profile", {
                detail: { id: uid, kind },
              }),
            );
            return;
          }
        }
        const file = (e.target as HTMLElement).closest(".md-file");
        if (file) {
          e.preventDefault();
          window.dispatchEvent(
            new CustomEvent("relay:open-file", {
              detail: {
                src: file.getAttribute("data-file-src"),
                repo: file.getAttribute("data-repo") || undefined,
                path: file.getAttribute("data-path"),
                projectId: props.projectId,
              },
            }),
          );
          return;
        }
        const btn = (e.target as HTMLElement).closest(".md-pre-copy");
        const code = btn?.parentElement?.nextElementSibling?.textContent;
        if (!btn || code == null) return;
        const done = () => {
          btn.textContent = "copied";
          setTimeout(() => {
            btn.textContent = "copy";
          }, 1200);
        };
        if (navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(code).then(done, () => {});
        } else {
          // insecure-context fallback (LAN dev origins)
          const ta = document.createElement("textarea");
          ta.value = code;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
          done();
        }
      }}
    />
  );
}
