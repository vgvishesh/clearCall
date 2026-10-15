/** Inline SVG icons (24×24, 1.8 stroke, currentColor). Decorative: always aria-hidden; the button carries the label. */
import type { JSX } from "preact";

export type IconProps = { size?: number; class?: string };

export function Svg({
  size = 24,
  class: cls,
  children,
}: IconProps & { children: JSX.Element | JSX.Element[] }) {
  return (
    <svg
      class={cls ? `icon ${cls}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const MicIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
  </Svg>
);

export const MicOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 9.5V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.6 2.5" />
    <path d="M18.5 11a6.5 6.5 0 0 1-1 3.4M5.5 11a6.5 6.5 0 0 0 10.2 5.3M12 17.5V21M4 4l16 16" />
  </Svg>
);

export const CamIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="6" width="13" height="12" rx="3" />
    <path d="m16 10.5 5-3v9l-5-3" />
  </Svg>
);

export const CamOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 6h3a3 3 0 0 1 3 3v3.5m0 3.5a3 3 0 0 1-3 2H6a3 3 0 0 1-3-3V9a3 3 0 0 1 2-2.8" />
    <path d="m16 10.5 5-3v9l-3.2-1.9M3 3l18 18" />
  </Svg>
);

export const FlipIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9.5V8a2 2 0 0 1 2-2h1.5L9 4h6l1.5 2H18a2 2 0 0 1 2 2v1.5M20 14.5V16a2 2 0 0 1-2 2h-1.5" />
    <path d="M4 14.5V16a2 2 0 0 0 2 2h6" />
    <path d="m10 16 2 2-2 2M14 8l-2-2 2-2" />
  </Svg>
);

export const ShareIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 15V3.5M8 7.5l4-4 4 4" />
    <path d="M7 11H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1" />
  </Svg>
);

export const MoreIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="5.5" cy="12" r="1.2" fill="currentColor" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    <circle cx="18.5" cy="12" r="1.2" fill="currentColor" />
  </Svg>
);

export const LeaveIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.4 13.6c4.8-4.3 12.4-4.3 17.2 0 .6.5.6 1.4.1 2l-1.4 1.6a1.3 1.3 0 0 1-1.7.2l-2.1-1.4a1.3 1.3 0 0 1-.6-1.2l.1-1.6a12 12 0 0 0-5.9 0l.1 1.6c0 .5-.2.9-.6 1.2l-2.1 1.4a1.3 1.3 0 0 1-1.7-.2l-1.4-1.6c-.5-.6-.5-1.5.1-2z" />
  </Svg>
);

export const PeopleIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5" />
    <path d="M15.5 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c2 .7 3.2 2.6 3.5 5.2" />
  </Svg>
);

export const SignalWeakIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 18v-2" />
    <path d="M10 18v-5" opacity="0.35" />
    <path d="M15 18v-8" opacity="0.35" />
    <path d="M20 18V7" opacity="0.35" />
  </Svg>
);

export const MusicIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 18V5.5l11-2V16" />
    <circle cx="6.5" cy="18" r="2.5" />
    <circle cx="17.5" cy="16" r="2.5" />
  </Svg>
);

export const HeadphonesIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 15v-3a8 8 0 0 1 16 0v3" />
    <rect x="3" y="14" width="4.5" height="6.5" rx="2" />
    <rect x="16.5" y="14" width="4.5" height="6.5" rx="2" />
  </Svg>
);

export const CloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const RetryIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 12a8 8 0 1 1-2.4-5.7" />
    <path d="M20 4v4.5h-4.5" />
  </Svg>
);

export const SpeakerIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
    <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
  </Svg>
);

export const ArrowRightIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
);

export const VideoPlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="6" width="13" height="12" rx="3" />
    <path d="m16 10.5 5-3v9l-5-3M9.5 9.5v5M7 12h5" />
  </Svg>
);

export const AlertIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5.5M12 16.5v.01" />
  </Svg>
);

export const PhoneEndedIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 4h3l1.5 4-2 1.3a10 10 0 0 0 5.2 5.2l1.3-2 4 1.5v3a2 2 0 0 1-2 2A15 15 0 0 1 3 6a2 2 0 0 1 2-2" />
  </Svg>
);

export const IosShareIcon = (p: IconProps) => (
  <Svg {...p} size={p.size ?? 18}>
    <path d="M12 14V3.5M8.5 7 12 3.5 15.5 7" />
    <path d="M8 10H6.5A1.5 1.5 0 0 0 5 11.5v8A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-8a1.5 1.5 0 0 0-1.5-1.5H16" />
  </Svg>
);

export const CopyIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="8.5" y="8.5" width="12" height="12" rx="2.5" />
    <path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5" />
  </Svg>
);

export const ExternalIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 4h6v6M20 4l-9 9" />
    <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
  </Svg>
);

export const ArrowUpIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 20V5M6 11l6-6 6 6" />
  </Svg>
);

/** The Clearcall mark: two overlapping rings in a rounded square. Matches public/logo.svg. */
export function LogoMark({ size = 40 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      aria-hidden="true"
      focusable="false"
      class="logo-mark"
    >
      <rect width="512" height="512" rx="120" fill="#14171c" />
      <circle cx="210" cy="256" r="100" fill="none" stroke="#4cc2ff" stroke-width="36" />
      <circle cx="302" cy="256" r="100" fill="none" stroke="#f2f4f7" stroke-width="36" />
    </svg>
  );
}
