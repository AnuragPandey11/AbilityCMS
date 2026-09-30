/**
 * The codes the broker is already carrying, offered beside a code field — so a
 * Client or Plant code is confirmed rather than typed.
 *
 * A code is the `{client}` or `{plant}` segment of every topic its equipment
 * publishes on, and topics are case-sensitive: `kular-green` and `KULAR_GREEN`
 * are different origins (Guardrail 5), and nothing errors when they disagree.
 * A registered code that differs from the topic only resolves by exact
 * `source_address` — so every Device registered so far works, and the first
 * *new* one is quarantined as "no Device registered for this topic". That
 * happened here once, with the Client code. Three things stop it recurring:
 *
 * - **Prefilled once** when exactly one unregistered code is arriving and the
 *   field is still empty — the one spelling that is certainly right. Once only,
 *   and never over anything typed: an auto-fill that overwrites is worse than
 *   none.
 * - **Confirmed** when what was typed is exactly a code that is arriving.
 * - **Caught** when what was typed differs from an arriving code only by case,
 *   `-`, `_` or spaces — a near-miss that would register cleanly and then
 *   decode nothing.
 *
 * Offered, never required: a Plant may be registered before its equipment is
 * wired, and a code nobody is publishing yet is not wrong. Broker discovery is
 * Super Admin only (an unregistered topic carries no Client), so for anyone
 * else this renders nothing and the field is typed as before.
 */

import { useEffect, useRef } from "react";

export interface PublishingCode {
  code: string;
  /** Not registered yet — the only codes that need a decision. */
  unregistered: boolean;
  /** For the chip's tooltip: how many Devices, when last heard. */
  title: string;
}

/** Case, hyphens, underscores and spaces removed — what a near-miss shares. */
export function looseKey(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * The arriving code that `typed` is a near-miss of, or null.
 *
 * Only unregistered codes: those are the ones being registered, and an exact
 * match anywhere means the typed code is already right.
 */
export function nearMiss(typed: string, codes: PublishingCode[]): string | null {
  const trimmed = typed.trim();
  if (!trimmed || codes.some((c) => c.code === trimmed)) return null;
  const key = looseKey(trimmed);
  return codes.find((c) => c.unregistered && looseKey(c.code) === key)?.code ?? null;
}

/**
 * Fill the field once, when there is exactly one unregistered code arriving and
 * nothing has been typed. Stops for good the moment anything is typed or filled.
 */
export function usePrefillOnce(
  value: string,
  codes: PublishingCode[] | undefined,
  fill: (code: string) => void,
): boolean {
  const done = useRef(false);
  const filledWith = useRef<string | null>(null);
  const candidates = (codes ?? []).filter((c) => c.unregistered);
  useEffect(() => {
    if (done.current) return;
    // Nothing to offer yet (loading, or the field is not on screen): decide
    // nothing, so a value the field held before it was shown cannot end it.
    if (codes === undefined) return;
    if (value.trim() !== "") {
      done.current = true;
      return;
    }
    if (candidates.length !== 1) return;
    done.current = true;
    filledWith.current = candidates[0]!.code;
    fill(candidates[0]!.code);
    // `fill` is a fresh closure each render; the refs make this run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, codes, candidates.length]);
  return filledWith.current !== null && filledWith.current === value;
}

export function PublishingCodes({
  typed,
  codes,
  onPick,
  prefilled = false,
}: {
  typed: string;
  /** Undefined while loading, or where discovery is not available. */
  codes: PublishingCode[] | undefined;
  onPick: (code: string) => void;
  /** Whether the field holds what `usePrefillOnce` put there. */
  prefilled?: boolean;
}): JSX.Element | null {
  if (!codes || codes.length === 0) return null;
  const trimmed = typed.trim();
  const exact = codes.find((c) => c.code === trimmed);
  const miss = nearMiss(typed, codes);
  const offered = codes.filter((c) => c.unregistered && c.code !== trimmed);

  return (
    <div className="mt-2 space-y-1.5" data-testid="publishing-codes">
      {miss ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded border border-warn/40 bg-warn/10 px-2 py-1 text-xs text-ink"
        >
          <span>
            The broker is receiving <span className="font-mono font-semibold">{miss}</span>, not{" "}
            <span className="font-mono">{trimmed}</span>. Topics are case-sensitive, so this code would
            never match its messages.
          </span>
          <button
            type="button"
            onClick={() => onPick(miss)}
            className="font-medium text-accent hover:underline"
          >
            Use {miss}
          </button>
        </div>
      ) : exact ? (
        <p className="text-[11px] text-ink-muted" title={exact.title}>
          {prefilled ? "Filled in from the broker: " : ""}
          <span className="font-mono text-ink">{exact.code}</span> matches what the broker is receiving
          {exact.unregistered ? "." : ", and is already registered."}
        </p>
      ) : null}
      {offered.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-ink-faint">Publishing, not registered yet:</span>
          {offered.map((c) => (
            <button
              key={c.code}
              type="button"
              onClick={() => onPick(c.code)}
              className="rounded border border-warn/40 bg-warn/5 px-1.5 py-0.5 font-mono text-[11px] text-ink hover:border-warn"
              title={`${c.title} Click to fill the code in.`}
            >
              {c.code}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
