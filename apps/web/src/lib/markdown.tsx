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
    <div class={`md ${props.class ?? ""}`} innerHTML={html()} />
  );
}
