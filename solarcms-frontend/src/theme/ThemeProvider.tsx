/**
 * Theme state.
 *
 * Three values, not two: "system" is a real choice and the default, so a user
 * who has never touched the toggle follows their OS. Only an explicit "light"
 * or "dark" writes `data-theme` onto <html>; "system" removes the attribute and
 * lets the `prefers-color-scheme` block in `index.css` decide.
 *
 * `version` exists for the canvas charts. ECharts paints into a canvas and
 * cannot inherit a CSS variable, so every chart re-reads its colours when this
 * number changes (see `theme/tokens.ts`). Without it a theme switch leaves the
 * charts in the previous palette until the next data refresh.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ThemeChoice = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "solarcms.theme";

interface ThemeContextValue {
  choice: ThemeChoice;
  resolved: ResolvedTheme;
  setChoice: (next: ThemeChoice) => void;
  toggle: () => void;
  /** Bumped on every effective theme change; chart deps include it. */
  version: number;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function prefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

function readStoredChoice(): ThemeChoice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // Private windows and blocked site data throw on access; the default is fine.
  }
  return "system";
}

/** Applied before React mounts too — see the inline script in `index.html`. */
export function applyTheme(choice: ThemeChoice): ResolvedTheme {
  const resolved: ResolvedTheme =
    choice === "system" ? (prefersDark() ? "dark" : "light") : choice;
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
  return resolved;
}

export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [choice, setChoiceState] = useState<ThemeChoice>(readStoredChoice);
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    choice === "system" ? (prefersDark() ? "dark" : "light") : choice,
  );
  const [version, setVersion] = useState(0);

  useEffect(() => {
    setResolved(applyTheme(choice));
    setVersion((n) => n + 1);
  }, [choice]);

  // While following the OS, a change there must take effect immediately.
  useEffect(() => {
    if (choice !== "system") return;
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      setResolved(applyTheme("system"));
      setVersion((n) => n + 1);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [choice]);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Persistence is a convenience; the session still themes correctly.
    }
  }, []);

  // The toggle is a two-state control over what the user currently *sees*, so
  // it always lands on an explicit choice rather than cycling back to "system".
  const toggle = useCallback(() => {
    setChoice(resolved === "dark" ? "light" : "dark");
  }, [resolved, setChoice]);

  const value = useMemo(
    () => ({ choice, resolved, setChoice, toggle, version }),
    [choice, resolved, setChoice, toggle, version],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    // A chart rendered outside the provider (a unit test, say) should still
    // paint rather than crash; it simply never re-reads its palette.
    return {
      choice: "system",
      resolved: "light",
      setChoice: () => undefined,
      toggle: () => undefined,
      version: 0,
    };
  }
  return context;
}
