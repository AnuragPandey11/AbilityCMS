/**
 * A horizontal strip of cards that pages with buttons and scrolls with a
 * finger.
 *
 * ── Why this instead of letting the section grow downwards ──────────────────
 * Seventeen Inverters stacked vertically is 17 × 120px of page, and everything
 * underneath — the schematic, the alarms, the environment — falls off the
 * bottom of the screen. The dashboard's job is to hold as much as possible in
 * one view, so a set of peers that is long in one dimension goes sideways: the
 * first three or four are visible, the rest are one gesture away, and nothing
 * below them moves.
 *
 * ── Both input methods, because both users exist ────────────────────────────
 * It is a native scroll container with CSS scroll-snap, so a phone or a
 * trackpad just swipes it and the browser does the physics, the momentum and
 * the accessibility. The buttons drive the *same* container via `scrollBy`,
 * for the desktop user with a mouse and no horizontal wheel — which is the case
 * a custom transform-based carousel usually serves while breaking touch.
 *
 * Nothing here is virtualised or transformed, so keyboard focus moving into a
 * card off-screen scrolls it into view by itself. A `translateX` carousel
 * cannot do that without extra code, and usually does not have it.
 *
 * ── The buttons say when they are useless ───────────────────────────────────
 * They disable at each end and vanish entirely when everything already fits,
 * which is the single-Inverter rooftop Plant. A control that does nothing
 * teaches people to stop trying controls.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { IconChevronLeft, IconChevronRight } from "@/components/icons";

export function Carousel({
  children,
  ariaLabel,
  /** Pixels per button press. Defaults to most of a viewport width. */
  step,
  className = "",
}: {
  children: ReactNode;
  ariaLabel: string;
  step?: number;
  className?: string;
}): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);

  const measure = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    // A 2px tolerance: sub-pixel layout means `scrollLeft + clientWidth` rarely
    // lands exactly on `scrollWidth`, and without it the right button stays
    // enabled forever at the end of the strip.
    const max = track.scrollWidth - track.clientWidth;
    setAtStart(track.scrollLeft <= 2);
    setAtEnd(track.scrollLeft >= max - 2);
  }, []);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    measure();
    track.addEventListener("scroll", measure, { passive: true });
    // Also on resize: a card count that fits at 1600px overflows at 1100px, so
    // whether the buttons are needed at all changes with the window.
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => {
      track.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [measure, children]);

  const page = (direction: -1 | 1) => {
    const track = trackRef.current;
    if (!track) return;
    const distance = step ?? Math.max(track.clientWidth * 0.8, 240);
    track.scrollBy({ left: direction * distance, behavior: "smooth" });
  };

  // Both ends reachable means it all fits: hide the controls rather than
  // showing two permanently dead buttons.
  const overflows = !(atStart && atEnd);

  return (
    <div className={`relative min-w-0 ${className}`}>
      <div
        ref={trackRef}
        role="group"
        aria-label={ariaLabel}
        className="flex w-full gap-2 overflow-x-auto scroll-smooth pb-1 [scrollbar-width:thin] snap-x snap-mandatory"
      >
        {children}
      </div>

      {overflows ? (
        <>
          <button
            type="button"
            onClick={() => page(-1)}
            disabled={atStart}
            aria-label="Scroll left"
            className="absolute -left-1 top-1/2 z-10 -translate-y-1/2 rounded-full border border-line bg-surface-raised/95 p-1.5 text-ink-muted shadow-card backdrop-blur transition hover:text-ink disabled:pointer-events-none disabled:opacity-0"
          >
            <IconChevronLeft size={15} />
          </button>
          <button
            type="button"
            onClick={() => page(1)}
            disabled={atEnd}
            aria-label="Scroll right"
            className="absolute -right-1 top-1/2 z-10 -translate-y-1/2 rounded-full border border-line bg-surface-raised/95 p-1.5 text-ink-muted shadow-card backdrop-blur transition hover:text-ink disabled:pointer-events-none disabled:opacity-0"
          >
            <IconChevronRight size={15} />
          </button>
          {/* A fade at each overflowing edge, so a half-visible card reads as
              "there is more" rather than as a card that has been cut off. */}
          {!atStart ? (
            <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-surface-raised to-transparent" />
          ) : null}
          {!atEnd ? (
            <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-surface-raised to-transparent" />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** One slide. `snap-start` so paging lands on a card edge, never mid-card. */
export function CarouselItem({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return <div className={`shrink-0 snap-start ${className}`}>{children}</div>;
}
