/**
 * Line icons for the sign-in card.
 *
 * The page's scenery, logo, industry panels and footer are the client's own
 * artwork (`public/ability-cms-desktop-*.jpg`, `ability-cms-mobile-*.jpg`); only the
 * card's controls are drawn in code.
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
