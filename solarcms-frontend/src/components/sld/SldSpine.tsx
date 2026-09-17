/**
 * The four-stage schematic: PV Array → Inverters → Transformer → Grid.
 *
 * Always those four, always in that order, on every Plant. An operator comparing
 * two Plants cannot do it across two differently-shaped diagrams, which is what
 * `PlantFlow` — which derives its stages from the real wiring — necessarily
 * produces. Both views are kept because they answer different questions:
 *
 *   SldSpine   is this Plant healthy, and does it compare to the others?
 *   PlantFlow  what is this Plant's actual chain of equipment?
 *   SldTree    which Inverter is the broken one?
 *
 * **Nothing about the folding happens here.** Which Devices belong to which
 * stage, and which figures each stage shows, are resolved by the backend from
 * `device_types.sld_stage` and the slot catalogue. This component draws what it
 * is given and adds no rule of its own — a Plant whose administrator moves VCBs
 * from the Transformer stage to the Grid stage changes a column, not this file.
 *
 * A stage with no Devices still renders. On a rooftop Plant an empty Transformer
 * stage is normal; on an 8 MW Plant it means a Device nobody registered, and
 * hiding it would conceal the second case to tidy up the first.
 */

import type { SldStage, SldStages } from "@/api/schemas";
import { slotText } from "@/components/dashboard/SlotValue";
import { UNDEFINED_DISPLAY } from "@/format/value";

const STAGE_GLYPH: Record<string, string> = {
  PV_ARRAY: "▦",
  INVERTERS: "⌁",
  TRANSFORMER: "⊜",
  GRID: "⌸",
};

const HEALTH_STYLE: Record<
  SldStage["health"],
  { border: string; dot: string; note: string }
> = {
  ok: {
    border: "border-ok/50",
    dot: "bg-ok",
    note: "Every Device in this stage is reporting.",
  },
  degraded: {
    // Partial loss is not an outage. Eleven of twelve Inverters running must not
    // be coloured the same as a dead stage, or the colour stops being read.
    border: "border-warn/60",
    dot: "bg-warn",
    note: "Some Devices in this stage are not reporting.",
  },
  down: {
    border: "border-bad/60",
    dot: "bg-bad",
    note: "No Device in this stage is reporting.",
  },
  unmonitored: {
    border: "border-line",
    dot: "bg-ink-faint",
    note:
      "No Device is registered at this stage. Normal on a Plant that has none — " +
      "a commissioning gap on one that does.",
  },
};

function StageBox({ stage }: { stage: SldStage }): JSX.Element {
  const style = HEALTH_STYLE[stage.health];
  return (
    <div
      className={`flex min-w-[9.5rem] flex-1 flex-col rounded-card border ${style.border} bg-surface-raised p-3`}
      title={style.note}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink">
          <span aria-hidden className="text-base leading-none text-ink-muted">
            {STAGE_GLYPH[stage.code] ?? "▢"}
          </span>
          {stage.label}
        </span>
        <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`} />
      </div>

      <div className="mt-1 text-[11px] text-ink-muted">
        {stage.instrumented ? (
          <span
            title="Devices reporting, out of those registered at this stage."
            className={stage.online_count < stage.device_count ? "text-warn" : undefined}
          >
            {stage.online_count} / {stage.device_count} online
          </span>
        ) : (
          <span className="text-ink-faint">not instrumented</span>
        )}
      </div>

      <dl className="mt-2 space-y-1">
        {stage.slots.map((slot) => (
          <div key={slot.slot_code} className="flex items-baseline justify-between gap-2">
            <dt className="truncate text-[11px] text-ink-muted">{slot.label}</dt>
            <dd
              className={`shrink-0 font-mono text-xs ${
                slot.value === null ? "text-ink-faint" : "text-ink"
              }`}
              title={
                slot.source?.is_aggregated
                  ? `${slot.source.aggregate} of ${slot.source.device_count} Devices`
                  : undefined
              }
            >
              {slotText(slot)}
              {slot.unit && slot.value !== null ? (
                <span className="ml-1 text-ink-muted">{slot.unit}</span>
              ) : null}
            </dd>
          </div>
        ))}
        {stage.slots.length === 0 ? (
          <p className="text-[11px] text-ink-faint">{UNDEFINED_DISPLAY}</p>
        ) : null}
      </dl>
    </div>
  );
}

export function SldSpine({ sld }: { sld: SldStages }): JSX.Element {
  return (
    <div>
      {/*
        Left to right, generation to grid — the direction every single line
        diagram an engineer has seen is drawn, even though `parent_device_id`
        points the other way ("what do I feed into"). Wraps on a narrow screen
        rather than scrolling horizontally: four boxes stacked still read in
        order, where a cut-off row does not.
      */}
      <div className="flex flex-wrap items-stretch gap-2">
        {sld.stages.map((stage, index) => (
          <div key={stage.code} className="flex flex-1 items-stretch gap-2">
            <StageBox stage={stage} />
            {index < sld.stages.length - 1 ? (
              <span
                aria-hidden
                className="self-center text-lg text-ink-faint"
                title="Power flows this way"
              >
                →
              </span>
            ) : null}
          </div>
        ))}
      </div>

      {sld.unstaged.length > 0 ? (
        <p className="mt-3 text-[11px] text-warn">
          <strong>{sld.unstaged.length}</strong> Device
          {sld.unstaged.length === 1 ? "" : "s"} carry current but belong to no stage:{" "}
          {sld.unstaged.map((d) => d.code).join(", ")}. Their Device Type has no{" "}
          <code>sld_stage</code>, so they are missing from this diagram — set one in the
          catalogue.
        </p>
      ) : null}
    </div>
  );
}
