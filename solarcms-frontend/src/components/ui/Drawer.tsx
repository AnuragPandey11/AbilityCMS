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
 *
 * ── It slides, and leaving takes a moment ───────────────────────────────────
 * The panel slides in from the right and back out; the backdrop fades. A closed
 * drawer therefore stays in the document while it leaves (AnimatePresence holds
 * it), and everything that belongs to *being open* — the Escape listener, the
 * scroll lock, giving focus back — is released when it **starts** to leave, not
 * when it finally unmounts. In a handover the next drawer takes focus in the
 * same commit; a release that waited for the slide to finish would take focus
 * back from it a quarter of a second later. A leaving drawer is also inert to
 * the pointer and hidden from assistive technology.
 */

import { useEffect, useId, useRef, type ReactNode } from "react";
import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import { IconClose } from "@/components/icons";

/**
 * Page-scroll locking, counted rather than remembered per drawer.
 *
 * ⚠ The obvious implementation — each drawer stores `document.body.style
 * .overflow` on open and writes it back on close — is wrong the moment two
 * drawers hand over to each other, which is exactly what a stage list opening
 * a Device does. The second drawer mounts while the first still has the body
 * locked, captures `"hidden"` as the value to restore, and puts it back when
 * it closes. The page is then locked with no drawer on screen and **cannot be
 * scrolled again for the rest of the session** — silent, and impossible to
 * attribute to the drawer that caused it.
 *
 * A count fixes it: the first drawer to open locks, the last to close
 * restores, and a handover never touches the lock at all.
 */
let openDrawers = 0;
let overflowBeforeLock = "";

function lockPageScroll(): () => void {
  if (openDrawers === 0) {
    overflowBeforeLock = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  openDrawers += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openDrawers = Math.max(0, openDrawers - 1);
    if (openDrawers === 0) document.body.style.overflow = overflowBeforeLock;
  };
}

/** In: decelerating, so the panel arrives rather than stops. Out: quicker. */
const PANEL_IN = { type: "tween", ease: [0.22, 1, 0.36, 1], duration: 0.26 } as const;
const PANEL_OUT = { type: "tween", ease: [0.4, 0, 1, 1], duration: 0.18 } as const;

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /**
   * `narrow` for a list behind a summary — the usual case. `wide` for a view
   * that is a whole screen of its own, such as one Inverter in full: still a
   * drawer, so the page behind is unchanged and Escape returns to it, but with
   * the width a grid of figures and charts needs. Its body is the sunken tray,
   * because what sits in it is cards.
   */
  size?: "narrow" | "wide";
}

export function Drawer(props: DrawerProps): JSX.Element {
  return (
    <AnimatePresence>{props.open ? <DrawerPanel key="drawer" {...props} /> : null}</AnimatePresence>
  );
}

function DrawerPanel({
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = "narrow",
}: DrawerProps): JSX.Element {
  // False from the moment the drawer starts to leave.
  const isPresent = useIsPresent();
  const panelRef = useRef<HTMLDivElement>(null);
  // Labelled by its own heading, so a title made of markup — a code beside a
  // name — still names the dialog for a screen reader.
  const headingId = useId();
  // Whatever had focus when this opened, so it can be given back on close. A
  // drawer that drops focus to <body> sends a keyboard user back to the top of
  // the document for every glance at a detail panel.
  const returnFocusTo = useRef<HTMLElement | null>(null);
  // The latest handler, so a caller passing a fresh function each render does
  // not re-run the effect — which would hand focus back and take it again.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isPresent) return;
    returnFocusTo.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus({ preventScroll: true });

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);

    // The page behind must not scroll under the drawer — on a trackpad the
    // scroll otherwise passes through and the reader loses their place.
    const releaseScroll = lockPageScroll();

    return () => {
      document.removeEventListener("keydown", onKey);
      releaseScroll();
      returnFocusTo.current?.focus?.();
    };
  }, [isPresent]);

  return (
    <div
      className={`fixed inset-0 z-50 flex justify-end overflow-hidden ${
        isPresent ? "" : "pointer-events-none"
      }`}
      aria-hidden={isPresent ? undefined : true}
    >
      <motion.button
        type="button"
        aria-label="Close the detail panel"
        onClick={onClose}
        className="absolute inset-0 bg-black/45 backdrop-blur-[1px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: { duration: 0.2 } }}
        exit={{ opacity: 0, transition: PANEL_OUT }}
      />
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        initial={{ x: "100%" }}
        animate={{ x: 0, transition: PANEL_IN }}
        exit={{ x: "100%", transition: PANEL_OUT }}
        className={`relative flex h-full w-full ${
          size === "wide" ? "max-w-[min(78rem,100vw)]" : "max-w-[min(30rem,100vw)]"
        } flex-col border-l border-line bg-surface-raised shadow-card outline-none`}
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 id={headingId} className={`${size === "wide" ? "text-xl" : "text-sm"} font-semibold text-ink`}>
              {title}
            </h2>
            {subtitle ? (
              <div
                className={`mt-0.5 leading-snug text-ink-muted ${size === "wide" ? "text-sm" : "text-[11px]"}`}
              >
                {subtitle}
              </div>
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

        <div
          className={`min-h-0 flex-1 overflow-y-auto ${
            size === "wide" ? "bg-surface-sunken/80 p-4 sm:p-5" : "px-4 py-3"
          }`}
        >
          {children}
        </div>

        {footer ? (
          <footer className="shrink-0 border-t border-line px-4 py-2.5">{footer}</footer>
        ) : null}
      </motion.div>
    </div>
  );
}
