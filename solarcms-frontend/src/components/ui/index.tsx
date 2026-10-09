/** Small presentational primitives. No data access, no branching on identity. */

import { useState, type InputHTMLAttributes, type ReactNode } from "react";
import { IconChevronDown } from "@/components/icons";

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = "",
  fill = false,
  padding = "p-4",
  tray = false,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /**
   * Make the body take the leftover height.
   *
   * For a Panel sitting in a grid row beside a taller one. A CSS grid stretches
   * every cell to the row's height, but the *card* stretching does not make its
   * *contents* stretch — so a short panel next to a chart renders as a box with
   * a third of its area blank underneath the content, which reads as a loading
   * state that never finishes. With `fill`, the body is a flex child that grows
   * and its own content can use `h-full`.
   */
  fill?: boolean;
  /** For a body that manages its own padding — a table, a full-bleed chart. */
  padding?: string;
  /**
   * The body is a tray a step below the card, for a panel whose content is
   * itself cards — the Plant cards, the Inverter cards. Card on card in the
   * same colour reads as one flat sheet with hairlines ruled across it; on a
   * tray the inner cards sit on something and read as objects you can pick up.
   */
  tray?: boolean;
}): JSX.Element {
  return (
    <section
      className={`surface-card rounded-card border border-line ${
        fill ? "flex flex-col" : ""
      } ${className}`}
    >
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title ? <h2 className="text-sm font-semibold text-ink">{title}</h2> : null}
            {subtitle ? (
              <p className="mt-0.5 text-xs leading-snug text-ink-muted">{subtitle}</p>
            ) : null}
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </header>
      )}
      <div
        className={`${padding} ${fill ? "min-h-0 flex-1" : ""} ${
          // Rounded to the card's own corners: the bottom two under a header,
          // all four when the tray is the whole card.
          tray ? `bg-surface-sunken/80 ${title || actions ? "rounded-b-card" : "rounded-card"}` : ""
        }`}
      >
        {children}
      </div>
    </section>
  );
}

export type BadgeTone = "neutral" | "ok" | "warn" | "bad" | "info" | "accent";

const TONES: Record<BadgeTone, string> = {
  neutral:
    "border-slate-200 bg-slate-100 text-slate-700 dark:border-line dark:bg-surface-sunken dark:text-ink-muted",
  ok:
    "border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-ok/30 dark:bg-ok/10 dark:text-ok",
  warn:
    "border-amber-300 bg-amber-100 text-amber-900 dark:border-warn/30 dark:bg-warn/10 dark:text-warn",
  bad:
    "border-rose-200 bg-rose-100 text-rose-800 dark:border-bad/30 dark:bg-bad/10 dark:text-bad",
  info:
    "border-blue-200 bg-blue-100 text-blue-800 dark:border-info/30 dark:bg-info/10 dark:text-info",
  accent:
    "border-cyan-200 bg-cyan-100 text-cyan-800 dark:border-accent/30 dark:bg-accent/10 dark:text-accent",
};

export function Badge({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  title?: string;
}): JSX.Element {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-medium ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  type = "button",
  variant = "secondary",
  disabled,
  title,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  title?: string;
  className?: string;
}): JSX.Element {
  const variants: Record<string, string> = {
    primary: "bg-accent text-on-accent hover:bg-accent-strong border-accent shadow-soft",
    secondary: "border-slate-300 dark:border-line bg-white dark:bg-surface-raised text-ink hover:bg-slate-50 dark:hover:bg-surface-sunken shadow-sm",
    danger: "border-rose-200 bg-rose-100 text-rose-800 dark:border-bad/40 dark:bg-bad/10 dark:text-bad hover:bg-rose-200 dark:hover:bg-bad/20",
    ghost: "border-transparent text-slate-600 dark:text-ink-muted hover:text-slate-900 dark:hover:text-ink",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-control border px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * Pick one of a few mutually exclusive modes.
 *
 * Used where a screen owns a noun but two genuinely different *jobs* — adding
 * one and editing an existing one. Those were previously an editor with a
 * "+ New" button tucked beside the picker, which reads as an action on the
 * thing being edited rather than as a different task, so people looking to
 * create went hunting for a screen that did not exist.
 *
 * Rendered as a radio group, not a row of buttons: the options are exclusive
 * and one is always chosen, which is what a radio group means to assistive
 * technology and what arrow-key navigation is for.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  label,
  size = "sm",
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: ReactNode; hint?: string }[];
  /** Names the group for a screen reader — the visible heading rarely does. */
  label: string;
  /** `lg` for a page's title band, beside a large `PeriodPicker`. */
  size?: "sm" | "lg";
}): JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`inline-flex rounded-control border border-line bg-surface-sunken ${
        size === "lg" ? "gap-1 p-1" : "p-0.5"
      }`}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.hint}
            onClick={() => onChange(option.value)}
            className={`rounded-control transition ${
              size === "lg" ? "px-4 py-1.5 text-sm font-semibold" : "px-3 py-1.5 text-xs font-medium"
            } ${
              active
                ? "bg-white dark:bg-surface-raised text-slate-900 dark:text-accent shadow-[0_1px_2px_rgba(0,0,0,0.08)] font-semibold"
                : "text-slate-600 dark:text-ink-muted hover:text-slate-900 dark:hover:text-ink"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A native `<select>` wearing a styled face — for a page's title band, where
 * the control sits beside large pickers and should look like one of them.
 *
 * The select is still the real control: it is laid transparently over the
 * face, so the browser's own list, keyboard handling and screen-reader
 * semantics are untouched. What the face adds is only what a native closed
 * select cannot render — mixed styling inside the chosen value (a Plant's code
 * in mono beside its name).
 */
export function SelectBox({
  label,
  display,
  value,
  onChange,
  children,
  className = "",
  size = "md",
}: {
  label?: ReactNode;
  /** What the closed control shows — the chosen option, styled. */
  display: ReactNode;
  value: string;
  onChange: (value: string) => void;
  /** `<option>` elements. */
  children: ReactNode;
  className?: string;
  /** `sm` for a dense filter row, level with an `sm` segmented control. */
  size?: "sm" | "md";
}): JSX.Element {
  const small = size === "sm";
  return (
    <label className={`inline-flex items-center ${small ? "gap-2" : "gap-2.5"}`}>
      {label ? (
        <span className={`whitespace-nowrap font-medium text-ink-muted ${small ? "text-xs" : "text-sm"}`}>
          {label}
        </span>
      ) : null}
      <span
        className={`surface-tile relative inline-flex items-center justify-between rounded-control border border-slate-300 dark:border-line bg-white dark:bg-surface-raised shadow-[inset_0_1px_1px_rgba(0,0,0,0.03)] transition focus-within:ring-2 focus-within:ring-accent/40 hover:border-slate-400 dark:hover:border-line-strong ${
          small ? "min-w-[10rem] gap-2 px-2.5 py-1.5 text-xs" : "min-w-[13rem] gap-3 px-3.5 py-2 text-sm"
        } ${className}`}
      >
        <span className="min-w-0 truncate font-semibold text-ink">{display}</span>
        <IconChevronDown size={small ? 12 : 14} className="shrink-0 text-ink-muted" />
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
        >
          {children}
        </select>
      </span>
    </label>
  );
}

export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <label className="block">
      <span className="text-xs font-medium text-ink">
        {label}
        {required ? <span className="ml-1 text-bad">*</span> : null}
      </span>
      <div className="mt-1">{children}</div>
      {hint ? <p className="mt-1 text-[11px] leading-snug text-ink-faint">{hint}</p> : null}
      {error ? <p className="mt-1 text-[11px] text-bad">{error}</p> : null}
    </label>
  );
}

export const inputClass =
  "w-full rounded-control border border-slate-300 dark:border-line bg-white dark:bg-surface-raised px-2.5 py-1.5 text-sm text-ink " +
  "shadow-[inset_0_1px_1px_rgba(0,0,0,0.03)] placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 " +
  "focus:ring-accent/20 disabled:opacity-50";

function EyeIcon({ off }: { off: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
      <path
        d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2.9" stroke="currentColor" strokeWidth="1.6" />
      {off ? (
        <path d="M4 20 20 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      ) : null}
    </svg>
  );
}

/**
 * A password field with a reveal control.
 *
 * The reveal is a `button`, not a checkbox, and carries `aria-pressed` so a
 * screen reader announces the current state rather than a label that has
 * silently inverted. It never changes `autoComplete`: switching the input's
 * type is enough, and rewriting the token makes password managers re-prompt.
 */
export function PasswordInput({
  value,
  onChange,
  className = "",
  ...rest
}: {
  value: string;
  onChange: (next: string) => void;
  className?: string;
} & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "type" | "className"
>): JSX.Element {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <input
        {...rest}
        type={visible ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`${inputClass} pr-10 ${className}`}
      />
      <button
        type="button"
        onClick={() => setVisible((current) => !current)}
        aria-pressed={visible}
        aria-label={visible ? "Hide password" : "Show password"}
        title={visible ? "Hide password" : "Show password"}
        // Excluded from the tab order: tabbing from the password field should
        // reach the submit button, not a display control.
        tabIndex={-1}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-control text-ink-faint transition hover:text-ink"
      >
        <EyeIcon off={visible} />
      </button>
    </div>
  );
}

/**
 * An inline explanation. Used heavily for provisional formulas and unit
 * caveats — a figure presented as settled makes its later correction look like
 * a defect (§4.3).
 */
export function InfoHint({ text }: { text: string }): JSX.Element {
  return (
    <span
      title={text}
      className="ml-1 inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-ink-faint text-[9px] leading-none text-ink-faint"
      aria-label={text}
    >
      i
    </span>
  );
}

export function Toolbar({ children }: { children: ReactNode }): JSX.Element {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

export function SectionHeading({
  children,
  note,
}: {
  children: ReactNode;
  note?: string;
}): JSX.Element {
  return (
    <div className="mb-3 flex items-baseline gap-2">
      <h2 className="text-sm font-semibold text-ink">{children}</h2>
      {note ? <span className="text-xs text-ink-faint">{note}</span> : null}
    </div>
  );
}

/**
 * Re-exported so callers keep one import site for presentational primitives.
 * They live in their own files because each is substantial enough to deserve
 * its own header — a slide-over has focus management and scroll locking to
 * explain, and a carousel has two input methods to justify.
 */
export { Drawer } from "./Drawer";
export { Carousel, CarouselItem } from "./Carousel";
