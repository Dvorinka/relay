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

export function SettingsIcon(props: IconProps): JSX.Element {
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
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v1.7M8 12.8v1.7M14.5 8h-1.7M3.2 8H1.5M12.6 3.4l-1.2 1.2M4.6 11.4 3.4 12.6M12.6 12.6l-1.2-1.2M4.6 4.6 3.4 3.4" />
    </svg>
  );
}
