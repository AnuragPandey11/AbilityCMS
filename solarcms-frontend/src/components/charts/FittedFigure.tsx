/**
 * A headline figure that fits the box it is in.
 *
 * Every tile on a monitoring wall is a fixed-width grid cell, and a lifetime
 * energy figure is as many digits as the Plant has been running years. The
 * two obvious fixes are both wrong: wrapping puts half a number on the next
 * line, and truncating turns `1,241,466` into `1,241,4…`, which reads as a
 * smaller, real number. So the figure *scales down* to the width available —
 * digits stay whole, the unit stays beside them — and only when the floor is
 * reached does the unit drop to its own line.
 *
 * Measured, not guessed: a fixed size that fits eight digits is one digit
 * away from the same bug. The measurement is imperative on purpose — React
 * state here would mean a paint at the wrong size before the corrected one.
 *
 * ⚠ The floor is an **absolute size in pixels**, not a ratio of the original.
 * A ratio floor is the right shape for a 24px tile and quietly wrong
 * everywhere else: the same 0.55 applied to the 14px figures on a Plant card
 * yields 7.7px, which is not a small number but an unreadable one. Shrinking
 * is a last resort in any case — a caller with a figure too long for its box
 * should compact the numeral (`formatHeadline`) rather than rely on this.
 */

import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Never render a figure smaller than this, whatever the box does. */
const MIN_FONT_PX = 11;

export function FittedFigure({
  value,
  unit,
  className = "",
  unitClassName = "text-sm text-ink-muted",
  title,
}: {
  value: ReactNode;
  /** Rendered beside the figure, smaller and muted. Omitted when undefined. */
  unit?: string | null;
  /** Classes for the figure itself — size, weight, colour. */
  className?: string;
  unitClassName?: string;
  title?: string;
}): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const figure = useRef<HTMLSpanElement>(null);
  const unitEl = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const container = box.current;
    const text = figure.current;
    if (!container || !text) return;

    const fit = () => {
      const available = container.clientWidth;
      // jsdom and a not-yet-laid-out tile both report 0; nothing to fit to.
      if (available <= 0) return;
      text.style.fontSize = "";
      const gap = unitEl.current ? unitEl.current.offsetWidth + 4 : 0;
      const natural = text.scrollWidth;
      if (natural + gap <= available) return;

      // The size the figure would render at untouched, which is what the
      // pixel floor has to be expressed against.
      const basePx = parseFloat(getComputedStyle(text).fontSize) || 16;
      const minScale = Math.min(1, MIN_FONT_PX / basePx);

      // Keep the unit on the line if the figure can shrink enough; otherwise
      // let it wrap below and give the figure the whole width.
      const withUnit = (available - gap) / natural;
      const scale = Math.max(
        minScale,
        withUnit >= minScale ? withUnit : available / natural,
      );
      text.style.fontSize = `${(scale * 100).toFixed(1)}%`;
    };

    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    return () => observer.disconnect();
  }, [value, unit]);

  return (
    <div
      ref={box}
      className="flex min-w-0 flex-wrap items-baseline gap-x-1"
      title={title}
    >
      <span ref={figure} className={`whitespace-nowrap leading-tight ${className}`}>
        {value}
      </span>
      {unit ? (
        <span ref={unitEl} className={`whitespace-nowrap ${unitClassName}`}>
          {unit}
        </span>
      ) : null}
    </div>
  );
}
