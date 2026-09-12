/**
 * The socket's state, said plainly in the header.
 *
 * `no_rooms` is not an error and must not read as one: the socket connected and
 * the User is simply assigned to no Plants (I-5). Saying "disconnected" there
 * sends someone to look at the broker for an access-control fact.
 */

import { useLiveSocket } from "./LiveSocket";

const PRESENTATION: Record<string, { label: string; dot: string; title: string }> = {
  open: {
    label: "Live",
    dot: "bg-ok",
    title: "Receiving live Readings.",
  },
  connecting: {
    label: "Connecting",
    dot: "bg-warn animate-pulse",
    title: "Opening the live connection.",
  },
  closed: {
    label: "Reconnecting",
    dot: "bg-bad",
    title:
      "The live connection dropped and is retrying with backoff. Values shown are " +
      "the last known ones, with their age.",
  },
  no_rooms: {
    label: "No Plants assigned",
    dot: "bg-ink-faint",
    title:
      "Connected, but no Plants are visible to this account. Plant Assignments are " +
      "granted explicitly — zero assignments means zero Plants.",
  },
};

export function LiveIndicator(): JSX.Element {
  const { status, rooms } = useLiveSocket();
  const presentation = PRESENTATION[status] ?? PRESENTATION.closed;
  return (
    <span
      className="inline-flex items-center gap-2 rounded border border-line px-2 py-1 text-xs text-ink-muted"
      title={`${presentation.title}${rooms.length > 0 ? ` (${rooms.length} room(s))` : ""}`}
    >
      <span className={`h-2 w-2 rounded-full ${presentation.dot}`} />
      {presentation.label}
    </span>
  );
}
