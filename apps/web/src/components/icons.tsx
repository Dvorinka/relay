import type { JSX } from "solid-js";

type IconProps = { class?: string };

export function RelayMark(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 256 256" class={props.class} aria-hidden="true">
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

export function SearchIcon(props: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      class={props.class}
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
    </svg>
  );
}

export function InboxIcon(props: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      class={props.class}
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M2 9.5V11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9.5" />
      <path d="M2 9.5 3.7 4.6A1.5 1.5 0 0 1 5.1 3.5h5.8a1.5 1.5 0 0 1 1.4 1.1L14 9.5" />
      <path d="M2 9.5h3.5a2.5 2.5 0 0 0 5 0H14" />
    </svg>
  );
}

export function PlusIcon(props: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      class={props.class}
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

export function PaperclipIcon(props: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      class={props.class}
      fill="none"
      stroke="currentColor"
      stroke-width="2.25"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

export function FileIcon(props: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      class={props.class}
      fill="none"
      stroke="currentColor"
      stroke-width="2.25"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M13 2v7h7" />
    </svg>
  );
}

export function ChevronDownIcon(props: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      class={props.class}
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}

export function CheckIcon(props: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      class={props.class}
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  );
}

export function IssueIcon(props: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      class={props.class}
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M5.75 8h4.5M8.75 6.5 10.25 8l-1.5 1.5" />
    </svg>
  );
}

export function GitPullRequestIcon(props: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      class={props.class}
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="4.5" cy="4" r="2" />
      <circle cx="4.5" cy="12" r="2" />
      <circle cx="11.5" cy="12" r="2" />
      <path d="M4.5 6v4M11.5 10V6.5a2 2 0 0 0-2-2h-1" />
    </svg>
  );
}

export function XIcon(props: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      class={props.class}
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export function SettingsIcon(props: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      class={props.class}
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function SunIcon(props: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      class={props.class}
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1" />
    </svg>
  );
}

export function MoonIcon(props: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      class={props.class}
      aria-hidden="true"
    >
      <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z" />
    </svg>
  );
}

export function MenuIcon(props: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      class={props.class}
      aria-hidden="true"
    >
      <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
    </svg>
  );
}

export function ReplyIcon(props: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
      aria-hidden="true"
    >
      <path d="M6.5 3 2.5 7l4 4" />
      <path d="M2.5 7h6a4 4 0 0 1 4 4v2" />
    </svg>
  );
}

export function PencilIcon(props: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
      aria-hidden="true"
    >
      <path d="M10.8 2.7a1.6 1.6 0 0 1 2.5 2.5l-8 8L2 14l.8-3.3 8-8Z" />
    </svg>
  );
}

export function SmileIcon(props: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      class={props.class}
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.5" />
      <path d="M5.5 9.5a3.4 3.4 0 0 0 5 0" />
      <path d="M5.7 6.3h.01M10.3 6.3h.01" stroke-width="2" />
    </svg>
  );
}

export function LockIcon(props: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      class={props.class}
      aria-hidden="true"
    >
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}
