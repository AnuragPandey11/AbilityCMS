/**
 * Light/dark toggle.
 *
 * Two visual states, three underlying values. The button flips between light
 * and dark; the "Follow system" reset is offered in the title so a user who
 * wants the OS preference back is not stuck with an explicit choice forever.
 */

import { useTheme } from "./ThemeProvider";

function SunIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M12 2.6v2.2M12 19.2v2.2M4.2 12H2m20 0h-2.2M6.3 6.3 4.8 4.8m14.4 14.4-1.5-1.5M6.3 17.7l-1.5 1.5M19.2 4.8l-1.5 1.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true">
      <path
        d="M20 13.4A8.2 8.2 0 1 1 10.6 4a6.6 6.6 0 0 0 9.4 9.4Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ThemeToggle({ className = "" }: { className?: string }): JSX.Element {
  const { resolved, choice, toggle, setChoice } = useTheme();
  const next = resolved === "dark" ? "light" : "dark";

  return (
    <div className={`inline-flex items-center ${className}`}>
      <button
        type="button"
        onClick={toggle}
        // Alt-click returns to the OS preference without needing a third state
        // in the control itself.
        onAuxClick={() => setChoice("system")}
        aria-label={`Switch to ${next} theme`}
        title={
          choice === "system"
            ? `Following your system theme (${resolved}). Click for ${next}.`
            : `${choice[0].toUpperCase()}${choice.slice(1)} theme. Click for ${next}.`
        }
        className="inline-flex h-8 w-8 items-center justify-center rounded-control border border-line bg-surface-raised text-ink-muted transition hover:border-accent/40 hover:text-accent"
      >
        {resolved === "dark" ? <MoonIcon /> : <SunIcon />}
      </button>
    </div>
  );
}
