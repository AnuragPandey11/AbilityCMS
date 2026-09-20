/**
 * A collapsible view of whatever the broker actually sent.
 *
 * Onboarding asks someone to confirm that what is arriving is what they meant
 * to configure. That is impossible against a wall of minified JSON, and it is
 * impossible against a summary — a summary is *our* reading of the payload, and
 * the whole point of showing it is to let a human check our reading.
 *
 * So: the real payload, structured, with everything foldable. Objects and
 * arrays collapse; leaves are typed by colour so a number that arrived as the
 * string `"0.0"` is visibly a string, which matters here — the client's broker
 * sends every value quoted, and a Tag that silently coerced them would hide it.
 *
 * Deliberately not a generic "JSON editor": nothing here is editable. The
 * payload is evidence, and evidence that can be typed over is not evidence.
 */

import { useState, type ReactNode } from "react";

/** Depth at which branches start folded, so a big payload opens readable. */
const OPEN_DEPTH = 2;

function Punct({ children }: { children: ReactNode }): JSX.Element {
  return <span className="text-ink-faint">{children}</span>;
}

/** A leaf, coloured by its *actual* JSON type — not by what it looks like. */
function Leaf({ value }: { value: unknown }): JSX.Element {
  if (value === null) return <span className="text-ink-faint italic">null</span>;
  if (typeof value === "boolean") {
    return <span className="text-info">{String(value)}</span>;
  }
  if (typeof value === "number") {
    return <span className="text-accent">{value}</span>;
  }
  // Quoted deliberately. The client publishes `"0.0"`, a string, and a viewer
  // that rendered it bare would hide the single most common data-quality
  // question asked of these payloads.
  return <span className="text-ok">&quot;{String(value)}&quot;</span>;
}

function Branch({
  name,
  value,
  depth,
  isLast,
}: {
  name: string | null;
  value: unknown;
  depth: number;
  isLast: boolean;
}): JSX.Element {
  const container =
    value !== null && typeof value === "object" ? (value as object) : null;
  const [open, setOpen] = useState(depth < OPEN_DEPTH);

  const label =
    name === null ? null : (
      <>
        <span className="text-ink">{name}</span>
        <Punct>: </Punct>
      </>
    );

  if (container === null) {
    return (
      <div style={{ paddingLeft: depth * 14 }} className="leading-6">
        {label}
        <Leaf value={value} />
        {isLast ? null : <Punct>,</Punct>}
      </div>
    );
  }

  const entries: [string, unknown][] = Array.isArray(container)
    ? container.map((item, index) => [String(index), item])
    : Object.entries(container as Record<string, unknown>);
  const [openBrace, closeBrace] = Array.isArray(container) ? ["[", "]"] : ["{", "}"];

  return (
    <div style={{ paddingLeft: depth * 14 }} className="leading-6">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        className="text-left hover:bg-surface-sunken"
        title={open ? "Collapse" : `Expand — ${entries.length} item(s)`}
      >
        <span className="mr-1 inline-block w-3 text-ink-faint">
          {open ? "▾" : "▸"}
        </span>
        {label}
        <Punct>{openBrace}</Punct>
        {open ? null : (
          <>
            <span className="px-1 text-[11px] text-ink-faint">
              {entries.length} item{entries.length === 1 ? "" : "s"}
            </span>
            <Punct>{closeBrace}</Punct>
            {isLast ? null : <Punct>,</Punct>}
          </>
        )}
      </button>
      {open ? (
        <>
          {entries.map(([key, item], index) => (
            <Branch
              key={key}
              name={Array.isArray(container) ? null : key}
              value={item}
              depth={depth + 1}
              isLast={index === entries.length - 1}
            />
          ))}
          <div style={{ paddingLeft: depth * 14 }}>
            <Punct>{closeBrace}</Punct>
            {isLast ? null : <Punct>,</Punct>}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function JsonTree({
  value,
  empty = "Nothing received.",
}: {
  value: unknown;
  /** Shown instead of an empty object, so "no data" never looks like "{}". */
  empty?: string;
}): JSX.Element {
  const isEmpty =
    value === null ||
    value === undefined ||
    (typeof value === "object" && Object.keys(value as object).length === 0);

  if (isEmpty) {
    return <p className="p-3 text-xs text-ink-faint">{empty}</p>;
  }

  return (
    <div className="overflow-auto rounded border border-line bg-surface-sunken p-3 font-mono text-[11px]">
      <Branch name={null} value={value} depth={0} isLast />
    </div>
  );
}
