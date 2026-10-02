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
}

function linkifyExtension(projectId?: string) {
  return {
    extensions: [
      {
        name: "relayLink",
        level: "inline" as const,
        start(src: string) {
          return src.match(/[A-Za-z]/)?.index;
        },
        tokenizer(src: string): RelayToken | undefined {
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

export function renderMarkdown(body: string, projectId?: string): string {
  return DOMPurify.sanitize(
    parserFor(projectId).parse(body, { async: false }),
  );
}

export function Markdown(props: {
  body: string;
  class?: string;
  projectId?: string;
}) {
  const html = createMemo(() => renderMarkdown(props.body, props.projectId));
  return (
    <div
      class={`md ${props.class ?? ""}`}
      innerHTML={html()}
      onClick={(e) => {
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
