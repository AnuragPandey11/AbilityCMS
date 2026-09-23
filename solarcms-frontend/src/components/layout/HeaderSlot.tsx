/**
 * A place in the application header that a page may fill.
 *
 * The header belongs to `AppShell` and the page to the route, so a page that
 * wants its identity in the top bar — the Plant's code, status and nameplate
 * beside the live state — portals it there rather than the shell learning
 * about every page.
 *
 * ⚠ Three states, and two of them must not be collapsed. `undefined` means no
 * shell at all (a test, a preview), so the content renders where it stands.
 * `null` means the shell exists but its slot has not attached yet — the first
 * render, before the callback ref fires — so the content renders *nowhere*
 * for that one frame. Rendering it inline there instead would paint it in the
 * page and then move it, and remount whatever state it holds.
 */

import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

const HeaderSlotContext = createContext<HTMLElement | null | undefined>(undefined);

export const HeaderSlotProvider = HeaderSlotContext.Provider;

export function HeaderContent({ children }: { children: ReactNode }): JSX.Element | null {
  const target = useContext(HeaderSlotContext);
  if (target === undefined) return <>{children}</>;
  if (target === null) return null;
  return createPortal(children, target);
}
