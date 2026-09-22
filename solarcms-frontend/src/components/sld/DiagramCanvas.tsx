/**
 * A pannable, zoomable, full-screen-able viewport for a diagram.
 *
 * A Single Line Diagram for a plant with twenty Inverters is wider than any
 * phone and taller than most laptops, and the two previous answers were both
 * wrong in the same way: `overflow: auto` makes a diagram something you scroll
 * past a keyhole, and shrinking it to fit makes the labels unreadable. Neither
 * lets someone standing in a plant with a phone find the box they are looking
 * for.
 *
 * So the diagram keeps its natural size and the *viewport* moves over it.
 *
 * ── What it handles ─────────────────────────────────────────────────────────
 * - **Drag to pan**, with a mouse, a finger, or a stylus. One pointer handler
 *   for all three: Pointer Events already unify them, and a separate touch path
 *   is how a diagram ends up working on a desk and not in a field.
 * - **Pinch to zoom**, two fingers, anchored between them — the gesture every
 *   map has trained people to expect, and the reason this exists at all.
 * - **Wheel to zoom**, anchored at the cursor. Plain wheel, not ctrl+wheel: the
 *   whole element is a canvas, there is nothing underneath it to scroll to, and
 *   requiring a modifier means a mouse user finds no zoom at all.
 * - **Buttons**, because a gesture nobody discovers is not a feature, and
 *   because a trackpad pinch is not available to everyone.
 * - **Fit**, which is the only control most people need: it sizes the content
 *   to the viewport and centres it.
 * - **Full screen**, native where the browser allows it, and a fixed overlay
 *   where it does not (iOS Safari refuses `requestFullscreen` on a div). Both
 *   are applied, so the control never silently does nothing.
 *
 * ── What it deliberately does not do ────────────────────────────────────────
 * It does not know what it is showing. No Device, no Tag, no Plant reaches this
 * file — it transforms a rectangle of children. That is what lets the same
 * viewport carry the electrical tree, the schematic row and anything drawn
 * later, and it is why zooming can never change what the diagram *claims*.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/** Below this the labels stop being readable; above it the boxes are absurd. */
const MIN_SCALE = 0.2;
const MAX_SCALE = 4;
/**
 * The smallest scale an *automatic* fit is allowed to choose.
 *
 * A pure fit optimises for "all of it on screen", which on a Plant with
 * seventeen Inverters side by side meant 23% — every box a grey smudge, every
 * label gone, and a diagram that answers no question at all. Below this the
 * fit stops shrinking and the viewport pans instead: some of the diagram,
 * readable, beats all of it, illegible. Pressing *Fit* still overrides this
 * and frames the whole thing, because that is a deliberate request to see the
 * shape rather than the detail, and zooming out by hand is unrestricted down
 * to `MIN_SCALE`.
 *
 * 0.55 is where the 9px type on a node stops being resolvable.
 */
const MIN_AUTOFIT_SCALE = 0.55;
/** One button press. A ratio rather than a step, so zooming is even at any scale. */
const BUTTON_STEP = 1.25;
/** Breathing room around a fitted diagram, in CSS pixels. */
const FIT_PADDING = 24;

interface Transform {
  x: number;
  y: number;
  k: number;
}

const IDENTITY: Transform = { x: 0, y: 0, k: 1 };

const clampScale = (k: number): number =>
  Math.min(MAX_SCALE, Math.max(MIN_SCALE, k));

/**
 * Zoom about a point in *viewport* coordinates, keeping what is under it still.
 *
 * The whole reason pinch-to-zoom feels right: the content under your fingers
 * must not slide away while you are looking at it.
 */
function zoomAbout(current: Transform, k: number, px: number, py: number): Transform {
  const next = clampScale(k);
  const ratio = next / current.k;
  return {
    k: next,
    x: px - (px - current.x) * ratio,
    y: py - (py - current.y) * ratio,
  };
}

export interface DiagramCanvasProps {
  children: ReactNode;
  /**
   * Height of the viewport when not full screen. The diagram inside may be any
   * size; this is the window onto it.
   */
  height?: number;
  /** Shown beside the controls — what is being looked at. */
  label?: string;
  /** Extra controls, rendered left of the zoom buttons. */
  actions?: ReactNode;
  /**
   * Re-fit whenever this changes. Pass something that identifies the content —
   * a device count, a plant id — so a diagram that grows a limb re-frames
   * itself instead of leaving the new part off-screen.
   */
  fitKey?: string | number;
}

export function DiagramCanvas({
  children,
  height = 420,
  label,
  actions,
  fitKey,
}: DiagramCanvasProps): JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);

  const [transform, setTransform] = useState<Transform>(IDENTITY);
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);

  /** Live pointers, by id. Two of them means a pinch, one means a pan. */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  /** Distance and midpoint at the moment the second finger landed. */
  const pinch = useRef<{ distance: number; k: number } | null>(null);

  const fit = useCallback((options?: { floor?: boolean }): void => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    // The content's *unscaled* size. `getBoundingClientRect` would return the
    // size at the current zoom and the fit would depend on where you started.
    const width = content.scrollWidth;
    const contentHeight = content.scrollHeight;
    if (width === 0 || contentHeight === 0) return;

    const available = {
      width: viewport.clientWidth - FIT_PADDING * 2,
      height: viewport.clientHeight - FIT_PADDING * 2,
    };
    // Never magnify to fill. A four-box diagram blown up to 3x looks like an
    // error, and the natural size is the size the labels were designed at.
    const ideal = Math.min(1, available.width / width, available.height / contentHeight);
    // `floor` is the automatic fit — on first paint and on resize. An explicit
    // press of Fit passes nothing and gets the true fit.
    const k = clampScale(options?.floor ? Math.max(ideal, MIN_AUTOFIT_SCALE) : ideal);
    // Centred in both axes, including when the content overflows.
    //
    // Left-aligning an overflow sounds right — start at the beginning of the
    // chain — and is wrong here: a tree lays its root out at the horizontal
    // *centre* of its own canvas with the leaves spread either side, so the
    // left edge of the SVG is empty margin. Left-aligned, the viewport opened
    // on blank space. Centred, an overflowing diagram opens on the root, which
    // is the part somebody navigates out from.
    setTransform({
      k,
      x: (viewport.clientWidth - width * k) / 2,
      y: (viewport.clientHeight - contentHeight * k) / 2,
    });
  }, []);

  // Fit on first paint and whenever the content identity changes. Layout
  // effect, not effect: measuring after the browser has painted produces one
  // frame of un-fitted diagram, which reads as a flicker on every navigation.
  useLayoutEffect(() => {
    const timer = window.setTimeout(() => fit({ floor: true }), 0);
    return () => window.clearTimeout(timer);
  }, [fit, fitKey, expanded]);

  // Re-fit when the viewport itself changes size — a phone rotating, a panel
  // beside it collapsing, the window being dragged narrower.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fit({ floor: true }));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [fit]);

  const zoomBy = useCallback((factor: number): void => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    // About the centre, which is what a button press means — the cursor is on
    // the button, not on the thing being looked at.
    setTransform((current) =>
      zoomAbout(
        current,
        current.k * factor,
        viewport.clientWidth / 2,
        viewport.clientHeight / 2,
      ),
    );
  }, []);

  // ── Full screen ───────────────────────────────────────────────────────────
  // Both paths, always. `requestFullscreen` is unsupported on a div in iOS
  // Safari and can be refused elsewhere, and a control that does nothing on the
  // device most likely to need it is worse than no control.
  const toggleExpanded = useCallback((): void => {
    const shell = shellRef.current;
    setExpanded((was) => !was);
    if (!shell) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      void shell.requestFullscreen?.().catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    // Leaving native full screen by Escape or the browser's own chrome must
    // take the overlay with it, or the page is left stuck under a panel with
    // no obvious way out.
    const onFullscreenChange = (): void => {
      if (!document.fullscreenElement) setExpanded(false);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent): void => {
      // Escape closes the overlay even where there was no native full screen
      // to close — the browser's own handler never fires in that case.
      if (event.key === "Escape") {
        setExpanded(false);
        if (document.fullscreenElement) {
          void document.exitFullscreen().catch(() => undefined);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  // ── Gestures ──────────────────────────────────────────────────────────────
  const localPoint = (event: React.PointerEvent): { x: number; y: number } => {
    const rect = viewportRef.current?.getBoundingClientRect();
    return {
      x: event.clientX - (rect?.left ?? 0),
      y: event.clientY - (rect?.top ?? 0),
    };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    // ⚠ Deliberately **no** `setPointerCapture` here. Capturing on press
    // retargets the compatibility mouse events too, so the `click` that ends a
    // press lands on this div instead of the node under the finger — and every
    // box in the diagram becomes unselectable. The capture is taken in
    // `onPointerMove`, once a real drag has started and there is no click left
    // to steal.
    pointers.current.set(event.pointerId, localPoint(event));
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), k: transform.k };
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    const point = localPoint(event);
    pointers.current.set(event.pointerId, point);

    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.current.distance > 0) {
        const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const k = pinch.current.k * (distance / pinch.current.distance);
        setTransform((current) => zoomAbout(current, k, midpoint.x, midpoint.y));
      }
      return;
    }

    const dx = point.x - previous.x;
    const dy = point.y - previous.y;
    // A press that has not moved is a click, not a pan. The threshold is what
    // keeps a slightly shaky tap on a node from becoming a one-pixel drag.
    if (!dragging && Math.hypot(dx, dy) < 2) return;
    if (!dragging) {
      // Now it is a drag: take the pointer so it keeps panning when it leaves
      // the viewport, which it will on a diagram wider than the window.
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }
    setTransform((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
  };

  const endPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) {
      // Deferred, so the click that ends a drag is swallowed by the guard below
      // rather than selecting whatever the finger happened to lift over.
      window.setTimeout(() => setDragging(false), 0);
    }
  };

  // Wheel is attached by hand rather than through onWheel: React's wheel
  // listener is passive, `preventDefault` inside it is ignored, and the page
  // scrolls behind the diagram while it zooms.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * 0.0015);
      setTransform((current) =>
        zoomAbout(
          current,
          current.k * factor,
          event.clientX - rect.left,
          event.clientY - rect.top,
        ),
      );
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, []);

  const percent = Math.round(transform.k * 100);

  return (
    <div
      ref={shellRef}
      className={
        expanded
          ? "fixed inset-0 z-50 flex flex-col bg-surface p-3"
          : "flex flex-col"
      }
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {label ? (
            <span className="truncate text-xs font-medium text-ink-muted">{label}</span>
          ) : null}
          {actions}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <CanvasButton
            onClick={() => zoomBy(1 / BUTTON_STEP)}
            title="Zoom out"
            label="Zoom out"
          >
            <svg {...ICON}><path d="M5 12h14" /></svg>
          </CanvasButton>
          <button
            type="button"
            onClick={() => fit()}
            title="Fit the whole diagram in view"
            className="min-w-[3.25rem] rounded-control border border-line bg-surface-raised px-1.5 py-1 font-mono text-[11px] text-ink-muted hover:text-ink"
          >
            {percent}%
          </button>
          <CanvasButton
            onClick={() => zoomBy(BUTTON_STEP)}
            title="Zoom in"
            label="Zoom in"
          >
            <svg {...ICON}><path d="M12 5v14M5 12h14" /></svg>
          </CanvasButton>
          <CanvasButton onClick={() => fit()} title="Fit to view" label="Fit to view">
            <svg {...ICON}>
              <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
            </svg>
          </CanvasButton>
          <CanvasButton
            onClick={toggleExpanded}
            title={expanded ? "Leave full screen (Esc)" : "Full screen"}
            label={expanded ? "Leave full screen" : "Full screen"}
            active={expanded}
          >
            {expanded ? (
              <svg {...ICON}>
                <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
              </svg>
            ) : (
              <svg {...ICON}>
                <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
                <path d="M9 9l-5-5M15 9l5-5M9 15l-5 5M15 15l5 5" opacity="0.45" />
              </svg>
            )}
          </CanvasButton>
        </div>
      </div>

      <div
        ref={viewportRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onClickCapture={(event) => {
          // A pan that ends over a node must not also select it. Capture phase,
          // so the node's own handler never runs.
          if (dragging) {
            event.stopPropagation();
            event.preventDefault();
          }
        }}
        style={{
          height: expanded ? undefined : height,
          // Without this the browser claims every touch for scrolling and the
          // pan never starts — the single line that decides whether any of this
          // works on a phone.
          touchAction: "none",
        }}
        className={`relative flex-1 overflow-hidden rounded border border-line bg-surface-sunken ${
          dragging ? "cursor-grabbing" : "cursor-grab"
        }`}
      >
        <div
          ref={contentRef}
          style={{
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.k})`,
            transformOrigin: "0 0",
            // Shrink-wrap the content so `scrollWidth` measures the diagram and
            // not the viewport it is sitting in.
            width: "max-content",
          }}
        >
          {children}
        </div>
      </div>

      <p className="mt-1.5 text-[11px] text-ink-faint">
        Drag to move · pinch or scroll to zoom · Fit re-frames the whole diagram
        {expanded ? " · Esc leaves full screen" : ""}
      </p>
    </div>
  );
}

const ICON = {
  width: 15,
  height: 15,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.9,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function CanvasButton({
  onClick,
  title,
  label,
  active = false,
  children,
}: {
  onClick: () => void;
  title: string;
  label: string;
  active?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={label}
      className={`rounded-control border p-1.5 transition ${
        active
          ? "border-accent bg-accent/10 text-accent"
          : "border-line bg-surface-raised text-ink-muted hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}
