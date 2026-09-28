/**
 * A place at the end of the route's filter row that a page may fill.
 *
 * The Client filter and Plant search belong to the route (see
 * `PlantFilterBar` for why), and a page's own Plant and Period pickers belong
 * to the page. Portalling the page's pickers here puts them on the same line
 * as the route's filters without moving either owner.
 *
 * The same three states as `HeaderSlot`: `undefined` means no filter row (a
 * Client Admin, who has no Client filter, or a test), so the content renders
 * where it stands; `null` means the row exists but has not attached yet, so
 * the content renders nowhere for that one frame rather than paint and move.
 */

import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FilterRowSlotContext = createContext<HTMLElement | null | undefined>(undefined);

export const FilterRowSlotProvider = FilterRowSlotContext.Provider;

export function FilterRowContent({ children }: { children: ReactNode }): JSX.Element | null {
  const target = useContext(FilterRowSlotContext);
  if (target === undefined) return <>{children}</>;
  if (target === null) return null;
  return createPortal(children, target);
}
