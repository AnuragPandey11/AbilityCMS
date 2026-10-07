/**
 * A button that opens a short list of checkboxes — "which of these to show".
 *
 * For a handful of independent toggles that would crowd a toolbar as a row of
 * switches. Every option says what it is, and an option that cannot be chosen
 * here stays in the list, disabled, with the reason beside it: an option that
 * silently disappears on one Plant reads as a feature that does not exist.
 *
 * Escape and a click outside close it; focus returns to the button.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { IconChevronDown } from "@/components/icons";

export interface CheckboxOption<T extends string> {
  value: T;
  label: string;
  /** One line under the label: what choosing it draws. */
  description?: string;
  /** Set when it cannot be chosen here, and why. */
  disabledReason?: string | null;
  /** A key for the option — the line it draws, say. */
  swatch?: ReactNode;
}

/** `w-72`, the list's width, for deciding which edge it hangs from. */
const PANEL_WIDTH_PX = 288;

export function CheckboxMenu<T extends string>({
  label,
  ariaLabel,
  options,
  selected,
  onChange,
}: {
  label: string;
  /** Names the group for a screen reader when `label` does not say enough. */
  ariaLabel?: string;
  options: CheckboxOption<T>[];
  selected: ReadonlySet<T>;
  onChange: (next: Set<T>) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  /**
   * Which edge of the button the list hangs from. Right by default (the menu
   * usually ends a toolbar), left when that would run it off the screen —
   * on a phone the button wraps to the left edge, and a right-hung list was
   * cut off there, labels and all.
   */
  const [hangLeft, setHangLeft] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  // Only what is both chosen and choosable counts: a disabled option that was
  // on by default is not being shown, and the count must not say it is.
  const active = options.filter((option) => selected.has(option.value) && !option.disabledReason).length;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = (value: T) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          const rect = buttonRef.current?.getBoundingClientRect();
          if (rect) setHangLeft(rect.right < Math.min(PANEL_WIDTH_PX, window.innerWidth - 16));
          setOpen((shown) => !shown);
        }}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={panelId}
        className="flex items-center gap-2 rounded-control border border-line bg-surface-raised px-3 py-1.5 text-sm font-medium text-ink transition hover:border-line-strong"
      >
        {label}
        {active > 0 ? (
          <span className="rounded-full bg-accent/15 px-1.5 text-xs font-semibold text-accent">{active}</span>
        ) : null}
        <IconChevronDown size={14} className={`text-ink-muted transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div
          id={panelId}
          role="group"
          aria-label={ariaLabel ?? label}
          className={`surface-card absolute ${hangLeft ? "left-0" : "right-0"} z-30 mt-1.5 max-h-[min(70vh,30rem)] w-72 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-card border border-line p-1.5 shadow-card`}
        >
          {options.map((option) => {
            const disabled = Boolean(option.disabledReason);
            return (
              <label
                key={option.value}
                className={`flex gap-2.5 rounded-control px-2.5 py-2 ${
                  disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer hover:bg-surface-sunken"
                }`}
                title={option.disabledReason ?? undefined}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--c-accent))]"
                  checked={selected.has(option.value) && !disabled}
                  disabled={disabled}
                  onChange={() => toggle(option.value)}
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-sm font-medium text-ink">
                    {option.swatch}
                    {option.label}
                  </span>
                  {option.disabledReason ? (
                    <span className="mt-0.5 block text-[11px] leading-snug text-ink-faint">
                      {option.disabledReason}
                    </span>
                  ) : option.description ? (
                    <span className="mt-0.5 block text-[11px] leading-snug text-ink-muted">
                      {option.description}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
