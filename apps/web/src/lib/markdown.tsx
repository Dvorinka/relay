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

// One shared parser instance: GFM, soft line breaks become <br>, and raw
// HTML in the source is escaped (never passed through) before the output
// is sanitized again by DOMPurify.
const parser = new Marked({
  gfm: true,
  breaks: true,
  walkTokens(token) {
    if (token.type === "html") {
      token.text = escapeHtml(token.text);
    }
  },
});

export function renderMarkdown(body: string): string {
  return DOMPurify.sanitize(parser.parse(body, { async: false }));
}

export function Markdown(props: { body: string; class?: string }) {
  const html = createMemo(() => renderMarkdown(props.body));
  return (
    <div class={`md ${props.class ?? ""}`} innerHTML={html()} />
  );
}
