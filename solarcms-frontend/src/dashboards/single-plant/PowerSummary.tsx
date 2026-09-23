/**
 * The Power Summary drawer — current power on a ring against AC capacity, and
 * the four power figures under it, in the reference's order: DC, AC, export,
 * import.
 *
 * ── Why it is in the drawer and not on the page ─────────────────────────────
 * Current Power is already the second tile of the headline strip. A ring on
 * the page would put the same figure on the screen twice, 400px apart, and the
 * screen fits one viewport only because each figure is shown once. The ring is
 * the *detail* of that figure — how close to nameplate — so it opens with the
 * rest of the power detail, one click from the Power Summary card.
 *
 * ── Import power is shown, and blank, on purpose ────────────────────────────
 * The Tag catalogue has no import-*power* signal. The meters report import
 * *energy*, and whether their active power goes negative on import is a sign
 * convention nobody has confirmed (OPEN-15). Reading a negative export as
 * import would be a guess about the client's meter; printing 0.00 would be a
 * claim that nothing is being drawn. So the row is there, with a dash and the
 * reason, and it fills in the day a Device can answer it (Guardrail 26).
 */

import type { ResolvedSlot } from "@/api/schemas";
import { CapacityGauge } from "@/components/charts/CapacityGauge";
import { Provenance, SlotRow, undefinedExplanation } from "@/components/dashboard/SlotValue";
import { UNDEFINED_DISPLAY } from "@/format/value";

/** The power figures, in the order the reference lists them. Import follows. */
const POWER_ROWS = ["power.dc_power", "power.ac_power", "power.export_power"];

const IMPORT_POWER_REASON =
  "No Tag in the catalogue carries import power. The meter reports import energy (see Energy), " +
  "and whether its active power reads negative on import is a sign convention not yet confirmed " +
  "(OPEN-15) — so this is left blank rather than guessed.";

export function PowerSummary({
  slots,
  currentPower,
  acCapacityKw,
}: {
  /** The `power_summary` panel, as the server resolved it. */
  slots: ResolvedSlot[];
  /** The headline strip's `kpi.current_power`, the figure the ring draws. */
  currentPower: ResolvedSlot | undefined;
  acCapacityKw: number | null;
}): JSX.Element {
  const byCode = new Map(slots.map((slot) => [slot.slot_code, slot]));
  const powerRows = POWER_ROWS.map((code) => byCode.get(code)).filter(
    (slot): slot is ResolvedSlot => slot !== undefined,
  );
  // Everything else the panel carries — voltages and currents — kept, below.
  // Nothing the drawer showed before is dropped.
  const rest = [...slots]
    .filter((slot) => !POWER_ROWS.includes(slot.slot_code))
    .sort((a, b) => a.position - b.position);

  return (
    <div className="space-y-4">
      <CapacityGauge
        label={currentPower?.label ?? "Current Power"}
        value={currentPower?.value ?? null}
        unit={currentPower?.unit ?? null}
        capacity={acCapacityKw}
        capacityUnit="kW"
        source={currentPower ? <Provenance slot={currentPower} /> : null}
        undefinedReason={
          currentPower
            ? undefinedExplanation(currentPower)
            : "No Current Power position is configured for this Plant."
        }
      />

      <div className="divide-y divide-line-soft">
        {powerRows.map((slot) => (
          <SlotRow key={slot.slot_code} slot={slot} />
        ))}
        <div className="py-1.5 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-ink-muted">Import Power</span>
            <span className="flex items-baseline gap-2">
              <span className="text-[11px] text-ink-faint">no signal</span>
              <span className="figure font-medium text-ink-faint" title={IMPORT_POWER_REASON}>
                {UNDEFINED_DISPLAY}
              </span>
            </span>
          </div>
          <p className="mt-0.5 text-[11px] leading-snug text-ink-faint">{IMPORT_POWER_REASON}</p>
        </div>
      </div>

      {rest.length > 0 ? (
        <div>
          <div className="field-label mb-1">Voltage and current</div>
          <div className="divide-y divide-line-soft">
            {rest.map((slot) => (
              <SlotRow key={slot.slot_code} slot={slot} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
