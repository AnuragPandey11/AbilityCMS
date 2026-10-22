/**
 * Where the pointer is on a card that opens something, for the light that
 * follows it (`.surface-interactive` in `index.css`).
 *
 * One listener for the whole document rather than one per card, writing two
 * custom properties on the card under the pointer — at most once a frame.
 * Mouse only: on a touch screen there is no pointer to follow, and the CSS
 * draws nothing there either.
 */

export function installPointerLight(): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  if (!window.matchMedia("(hover: hover)").matches) return () => undefined;

  let frame = 0;
  let pending: { card: HTMLElement; x: number; y: number } | null = null;

  const onMove = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    const card = (event.target as Element | null)?.closest?.(".surface-interactive");
    if (!(card instanceof HTMLElement)) return;
    const box = card.getBoundingClientRect();
    pending = { card, x: event.clientX - box.left, y: event.clientY - box.top };
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!pending) return;
      pending.card.style.setProperty("--pointer-x", `${pending.x}px`);
      pending.card.style.setProperty("--pointer-y", `${pending.y}px`);
    });
  };

  document.addEventListener("pointermove", onMove, { passive: true });
  return () => {
    document.removeEventListener("pointermove", onMove);
    if (frame) cancelAnimationFrame(frame);
  };
}
