/**
 * Line icons for the sign-in page: the card's controls, and on desktop the
 * industry panels, the capability row and the footer drawn over the client's
 * artwork (`LoginArtwork.tsx`). The phone artwork carries its own lettering.
 */

import type { ReactNode } from "react";

function Line({
  children,
  size = 24,
  className = "",
  strokeWidth = 1.7,
}: {
  children: ReactNode;
  size?: number;
  className?: string;
  strokeWidth?: number;
}): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {children}
    </svg>
  );
}

type IconProps = { size?: number; className?: string; strokeWidth?: number };

export const MailIcon = (p: IconProps) => (
  <Line {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3.5 6.5 12 13l8.5-6.5M3.5 18l6-6M20.5 18l-6-6" />
  </Line>
);
export const LockIcon = (p: IconProps) => (
  <Line {...p}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3M12 15v2" />
  </Line>
);
export const EyeIcon = (p: IconProps) => (
  <Line {...p}>
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
  </Line>
);
export const EyeOffIcon = (p: IconProps) => (
  <Line {...p}>
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
    <path d="M4 4l16 16" />
  </Line>
);
export const ArrowRightIcon = (p: IconProps) => (
  <Line {...p}>
    <path d="M4 12h16M14 6l6 6-6 6" />
  </Line>
);
export const DesktopIcon = (p: IconProps) => (
  <Line {...p}>
    <rect x="3" y="4" width="18" height="12" rx="1.5" />
    <path d="M8 20h8M12 16v4" />
  </Line>
);
export const TabletIcon = (p: IconProps) => (
  <Line {...p}>
    <rect x="5" y="2.5" width="14" height="19" rx="2" />
    <path d="M11 18.5h2" />
  </Line>
);
export const PhoneIcon = (p: IconProps) => (
  <Line {...p}>
    <rect x="7.5" y="2.5" width="9" height="19" rx="2" />
    <path d="M11 18.5h2" />
  </Line>
);
export const SunIcon = (p: IconProps) => (
  <Line {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
  </Line>
);
export const WindIcon = (p: IconProps) => (
  <Line {...p}>
    <path d="M3 8h10a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h7a2.5 2.5 0 1 1-2.5 2.5" />
  </Line>
);
export const WavesIcon = (p: IconProps) => (
  <Line {...p}>
    <path d="M2 8c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2M2 13c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2M2 18c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2" />
  </Line>
);
export const FactoryIcon = (p: IconProps) => (
  <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    width={p.size ?? 24}
    height={p.size ?? 24}
    fill="currentColor"
    className={p.className}
  >
    <path d="M2 21V9l6 3V9l6 3V4h3l1 8 4 .5V21H2Zm3-3h2v-3H5v3Zm4 0h2v-3H9v3Zm4 0h2v-3h-2v3Zm4 0h2v-3h-2v3Z" />
  </svg>
);
export const MonitorChartIcon = (p: IconProps) => (
  <Line {...p}>
    <rect x="2.5" y="3.5" width="19" height="13" rx="1.5" />
    <path d="M8 20.5h8M12 16.5v4M6 13l3.5-4 3 2.5L17 7M14.5 7H17v2.5" />
  </Line>
);
export const BarsUpIcon = (p: IconProps) => (
  <Line {...p}>
    <path d="M4 21V14M10 21V10M16 21V12M22 21H2M5 10l5-4 4 2 6-5M16 3h4v4" />
  </Line>
);
export const CloudUploadIcon = (p: IconProps) => (
  <Line {...p}>
    <path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5 4.75 4.75 0 0 1 17.5 18M12 20v-8M8.5 14.5 12 11l3.5 3.5" />
  </Line>
);
export const BellIcon = (p: IconProps) => (
  <Line {...p}>
    <path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2ZM10 21h4M20 3l.5 1.5L22 5l-1.5.5L20 7l-.5-1.5L18 5l1.5-.5L20 3Z" />
  </Line>
);
export const GearIcon = (p: IconProps) => (
  <Line {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M10.3 2.5h3.4l.5 2.4 1.7.7 2.1-1.3 2.4 2.4-1.3 2.1.7 1.7 2.4.5v3.4l-2.4.5-.7 1.7 1.3 2.1-2.4 2.4-2.1-1.3-1.7.7-.5 2.4h-3.4l-.5-2.4-1.7-.7-2.1 1.3-2.4-2.4 1.3-2.1-.7-1.7-2.4-.5v-3.4l2.4-.5.7-1.7-1.3-2.1 2.4-2.4 2.1 1.3 1.7-.7.5-2.4Z" />
  </Line>
);
export const DatabaseIcon = (p: IconProps) => (
  <Line {...p}>
    <ellipse cx="12" cy="5.5" rx="8" ry="3" />
    <path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
  </Line>
);
export const ShieldCheckIcon = (p: IconProps) => (
  <Line {...p}>
    <path d="M12 2.5 4.5 5.5v6c0 4.6 3.2 8.4 7.5 10 4.3-1.6 7.5-5.4 7.5-10v-6L12 2.5Z" />
    <path d="m8.5 12 2.5 2.5 4.5-5" />
  </Line>
);
