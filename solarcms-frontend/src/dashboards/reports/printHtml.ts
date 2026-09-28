/**
 * Print a server-rendered page through the browser's own dialog, where
 * "Save as PDF" is one of the destinations.
 *
 * The fallback for the PDF button when the server has no PDF renderer
 * installed (WeasyPrint is an optional extra): the page printed is the one
 * the server would have rendered, so the result is the same table either way.
 *
 * A hidden frame rather than a new window: the page arrives after an `await`,
 * by which time the click is no longer a user gesture and a popup is blocked.
 */
export function printHtml(html: string): void {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  Object.assign(frame.style, {
    position: "fixed",
    right: "0",
    bottom: "0",
    width: "0",
    height: "0",
    border: "0",
  });
  frame.srcdoc = html;
  frame.onload = () => {
    const view = frame.contentWindow;
    if (!view) {
      frame.remove();
      return;
    }
    const remove = () => frame.remove();
    view.addEventListener("afterprint", remove);
    // Not every browser fires `afterprint`; never leave the frame behind.
    window.setTimeout(remove, 60_000);
    view.focus();
    view.print();
  };
  document.body.appendChild(frame);
}
