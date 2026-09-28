/**
 * Whether the sidebar is collapsed to its icon rail, remembered per browser.
 *
 * localStorage, like the theme, rather than the `selection` store's
 * sessionStorage: this is a preference about the screen somebody works at, not
 * a choice about what they are looking at, so a new tab should open the way the
 * last one was left.
 */

import { useCallback, useEffect, useState } from "react";

export const SIDEBAR_STORAGE_KEY = "solarcms.sidebar";

function readStored(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === "collapsed";
  } catch {
    // Private windows and blocked site data throw on access; expanded is fine.
    return false;
  }
}

export function useSidebarCollapsed(): { collapsed: boolean; toggle: () => void } {
  const [collapsed, setCollapsed] = useState(readStored);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? "collapsed" : "expanded");
    } catch {
      // Persistence is a convenience; the session still collapses correctly.
    }
  }, [collapsed]);

  const toggle = useCallback(() => setCollapsed((was) => !was), []);
  return { collapsed, toggle };
}
