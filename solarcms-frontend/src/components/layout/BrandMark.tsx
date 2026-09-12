/**
 * The product lockup, matching the client's mockups.
 *
 * This is platform branding, not Client branding — it never varies by the
 * signed-in Client, Plant or Device (F-14, Guardrail 2). A Client logo, if one
 * is ever wanted, belongs in configuration beside the Client row, not here.
 */

export function BrandMark({
  compact = false,
}: {
  /** Sidebar rail: mark only, no wordmark. */
  compact?: boolean;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2.5">
      <span
        aria-hidden="true"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] bg-gradient-to-br from-accent to-accent-strong shadow-soft"
      >
        <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
          <path d="M13.4 2 5 13.2h5.3L9.6 22 19 10.6h-5.4L13.4 2Z" fill="#fff" />
        </svg>
      </span>
      {compact ? null : (
        <span className="min-w-0 leading-none">
          <span className="block truncate text-[15px] font-bold tracking-tight text-ink">
            ABILITY
          </span>
          <span className="mt-1 block truncate text-[9px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
            Automation
          </span>
        </span>
      )}
    </div>
  );
}
