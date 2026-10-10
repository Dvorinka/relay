// LinkPreview renders an OG card under a message that links to a web page.
// The fetch goes through GET /api/unfurl — the server does the request
// (SSRF-guarded) and caches the outcome, so a room full of readers costs
// one outbound fetch total.
import { createResource, Show, type JSX } from "solid-js";
import type { UnfurlResult } from "@relay/api-client";
import { api } from "../lib/api";
import { ExternalLinkIcon } from "./icons";

const cache = new Map<string, Promise<UnfurlResult | null>>();

function unfurl(url: string) {
  let p = cache.get(url);
  if (!p) {
    p = api.unfurl(url).catch(() => null);
    cache.set(url, p);
  }
  return p;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function LinkPreview(props: { url: string }): JSX.Element {
  const [data] = createResource(() => props.url, unfurl);
  const ready = () => data()?.found && data()!.title;
  return (
    <Show when={ready()}>
      <a
        href={props.url}
        target="_blank"
        rel="noreferrer noopener"
        class="mt-1.5 flex max-w-md items-stretch gap-3 overflow-hidden rounded-xl border border-border bg-surface p-2.5 transition-colors hover:bg-hover"
      >
        <div class="min-w-0 flex-1">
          <div class="truncate text-[11px] font-medium uppercase tracking-wide text-faint">
            {data()!.site_name || hostOf(props.url)}
          </div>
          <div class="mt-0.5 truncate text-[13px] font-semibold text-fg">
            {data()!.title}
          </div>
          <Show when={data()!.description}>
            <div class="mt-0.5 line-clamp-2 text-[12px] leading-snug text-muted">
              {data()!.description}
            </div>
          </Show>
        </div>
        <Show
          when={data()!.image_url}
          fallback={<ExternalLinkIcon class="h-4 w-4 shrink-0 self-center text-faint" />}
        >
          {(src) => (
            <img
              src={src()}
              alt=""
              loading="lazy"
              class="h-16 w-16 shrink-0 rounded-lg border border-border object-cover"
            />
          )}
        </Show>
      </a>
    </Show>
  );
}
