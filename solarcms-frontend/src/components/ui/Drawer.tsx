/**
 * A slide-over detail panel.
 *
 * ── Why detail opens beside the page rather than inside it ──────────────────
 * The dashboard's constraint is that it fits one screen. An expander that grows
 * in place satisfies the first click and destroys the property: the section
 * below it moves, the screen becomes a scrolling document again, and closing
 * the expander leaves the reader somewhere they did not choose to be. A drawer
 * leaves the summary exactly where it was, so the answer to "what was I
 * looking at" is still on screen behind it, and closing returns to an unchanged
 * page.
 *
 * It is also the right shape for the content. These panels hold the *full* list
 * behind a summary — every slot in a panel, every Device in a stage — which is
 * a tall, narrow thing. A tall narrow thing in a wide page pushes everything
 * down; in a right-hand drawer it simply scrolls.
 *
 * ── Accessibility, which a div with an onClick does not get for free ────────
 * Escape closes it, the backdrop closes it, focus moves into the panel on open
 * and back to whatever opened it on close, and the page behind it does not
 * scroll while it is up. `role="dialog"` + `aria-modal` + a labelled heading,
 * so a screen reader announces it as a panel rather than reading it as more
 * page.
 */

import { useEffect, useRef, type ReactNode } from "react";
import { IconClose } from "@/components/icons";

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  // Whatever had focus when this opened, so it can be given back on close. A
  // drawer that drops focus to <body> sends a keyboard user back to the top of
  // the document for every glance at a detail panel.
  const returnFocusTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnFocusTo.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);

    // The page behind must not scroll under the drawer — on a trackpad the
    // scroll otherwise passes through and the reader loses their place.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      returnFocusTo.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="Close the detail panel"
        onClick={onClose}
        className="absolute inset-0 bg-black/45 backdrop-blur-[1px]"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
        className="relative flex h-full w-full max-w-[min(30rem,100vw)] flex-col border-l border-line bg-surface-raised shadow-card outline-none"
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">{title}</h2>
            {subtitle ? (
              <p className="mt-0.5 text-[11px] leading-snug text-ink-muted">{subtitle}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-control border border-line p-1.5 text-ink-muted transition hover:text-ink"
          >
            <IconClose size={15} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>

        {footer ? (
          <footer className="shrink-0 border-t border-line px-4 py-2.5">{footer}</footer>
        ) : null}
      </div>
    </div>
  );
}
