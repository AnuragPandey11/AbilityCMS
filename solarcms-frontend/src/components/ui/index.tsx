/** Small presentational primitives. No data access, no branching on identity. */

import { useState, type InputHTMLAttributes, type ReactNode } from "react";

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = "",
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <section
      className={`rounded-card border border-line bg-surface-raised shadow-soft ${className}`}
    >
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            {title ? <h2 className="text-sm font-semibold text-ink">{title}</h2> : null}
            {subtitle ? (
              <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>
            ) : null}
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export type BadgeTone = "neutral" | "ok" | "warn" | "bad" | "info" | "accent";

const TONES: Record<BadgeTone, string> = {
  neutral: "border-line bg-surface-sunken text-ink-muted",
  ok: "border-ok/30 bg-ok/10 text-ok",
  warn: "border-warn/30 bg-warn/10 text-warn",
  bad: "border-bad/30 bg-bad/10 text-bad",
  info: "border-info/30 bg-info/10 text-info",
  accent: "border-accent/30 bg-accent/10 text-accent",
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
    primary: "bg-accent text-white hover:bg-accent-strong border-accent shadow-soft",
    secondary: "border-line bg-surface-raised text-ink hover:bg-surface-sunken",
    danger: "border-bad/40 bg-bad/10 text-bad hover:bg-bad/20",
    ghost: "border-transparent text-ink-muted hover:text-ink",
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
  "w-full rounded-control border border-line bg-surface-raised px-2.5 py-1.5 text-sm text-ink " +
  "placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 " +
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
