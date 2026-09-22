/**
 * Which panels the headline strip has already answered.
 *
 * ── The problem this solves ────────────────────────────────────────────────
 * The slot catalogue is free to put the same measurement in two positions, and
 * on a real Plant it does: `kpi.energy_today` and `energy.generated_today`
 * resolve to the identical source — `sum` of `ENERGY_TODAY` over every
 * `INVERTER` — and therefore to the identical number. That is correct in the
 * catalogue, because the two positions serve different screens. Rendered
 * together on one screen it is the same figure twice under two names, which is
 * the specific kind of redundancy that makes somebody wonder which one is real
 * and whether the difference between them means something.
 *
 * So a panel whose every slot is already on the headline strip is not drawn
 * again. **Deduplication is by resolved source, not by label or by slot code.**
 * The codes differ and the labels differ ("Today's Energy" / "Energy
 * Generated") — the only thing that makes them the same fact is that the server
 * resolved both to the same Device Type, Tag and aggregate.
 *
 * ⚠ It never *hides a figure*, only a second copy of one. A panel with one
 * duplicate and three distinct slots is drawn in full, because dropping the
 * duplicate row from inside a panel would leave a gap in a list whose order is
 * catalogue configuration.
 */

import type { ResolvedSlot } from "@/api/schemas";

/**
 * What makes two slots the same claim.
 *
 * A slot with no source is never equal to anything, including another
 * sourceless slot: two positions that cannot be answered are two separate
 * things this Plant cannot tell you, and collapsing them would hide the second
 * commissioning gap behind the first.
 */
export function sourceSignature(slot: ResolvedSlot): string | null {
  const source = slot.source;
  if (!source) return null;
  return [
    source.kind,
    source.device_type_code ?? "",
    source.tag_code ?? "",
    source.aggregate,
    // Included so `sum of 17 Inverters` and `sum of 4 Inverters` are different
    // claims — which they are, on a Plant part-way through commissioning.
    source.device_count,
  ].join("|");
}

/** True when every slot in `panel` is already answered by one in `shown`. */
export function fullyDuplicated(panel: ResolvedSlot[], shown: ResolvedSlot[]): boolean {
  if (panel.length === 0) return true;
  const already = new Set(
    shown.map(sourceSignature).filter((signature): signature is string => signature !== null),
  );
  return panel.every((slot) => {
    const signature = sourceSignature(slot);
    return signature !== null && already.has(signature);
  });
}
