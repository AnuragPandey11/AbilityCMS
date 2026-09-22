/**
 * The four-stage schematic: PV Array → Inverters → Transformer → Grid.
 *
 * Always those four, always in that order, on every Plant. An operator
 * comparing two Plants cannot do it across two differently-shaped diagrams,
 * which is what a diagram derived from the real wiring necessarily produces.
 * Three views exist and they answer different questions:
 *
 *   PlantSchematic  is this Plant healthy, and does it compare to the others?
 *   PlantFlow       what is this Plant's actual chain of equipment?
 *   SldTree         which Inverter is the broken one?
 *
 * **Nothing about the folding happens here.** Which Devices belong to which
 * stage, and which figures each stage shows, are resolved by the backend from
 * `device_types.sld_stage` and the slot catalogue. This component draws what it
 * is given and adds no rule of its own — a Plant whose administrator moves VCBs
 * from the Transformer stage to the Grid stage changes a column, not this file.
 *
 * A stage with no Devices still renders. On a rooftop Plant an empty
 * Transformer stage is normal; on an 8 MW Plant it means a Device nobody
 * registered, and hiding it would conceal the second case to tidy the first.
 *
 * ── What replaced the glyphs, and why it matters ────────────────────────────
 * Each stage used to be labelled with a Unicode character — ▦ ⌁ ⊜ ⌸ — chosen
 * because they were to hand. They rendered in a different weight on every
 * platform, carried no information beyond "something is here", and made the one
 * diagram on the screen that is supposed to be read at a glance the cheapest
 * thing on it. Each stage now carries its equipment, drawn (`DeviceArt`), which
 * is what lets somebody find the transformer without reading four labels.
 *
 * ── The flow connector carries state, and only the state we have ────────────
 * The arrow between two stages is tinted by the *upstream* stage's health and
 * animated only while power is actually moving. An always-animated arrow is
 * decoration that says "working" on a dead plant at midnight, which is worse
 * than no arrow: it is an assertion, and it is wrong for half of every day.
 */

import type { ReactNode } from "react";
import type { SldStage, SldStages } from "@/api/schemas";
import { slotText } from "@/components/dashboard/SlotValue";
import { DeviceArt } from "@/components/devices/DeviceArt";
import { UNDEFINED_DISPLAY } from "@/format/value";

/**
 * Health → how the stage is framed.
 *
 * Partial loss is not an outage: eleven of twelve Inverters running must not be
 * coloured the same as a dead stage, or the colour stops being read.
 */
const HEALTH: Record<
  SldStage["health"],
  { frame: string; dot: string; rail: string; note: string }
> = {
  ok: {
    frame: "border-ok/35 bg-ok/[0.05]",
    dot: "bg-ok lamp-ok",
    rail: "text-ok",
    note: "Every Device in this stage is reporting.",
  },
  degraded: {
    frame: "border-warn/50 bg-warn/[0.06]",
    dot: "bg-warn lamp-warn",
    rail: "text-warn",
    note: "Some Devices in this stage are not reporting.",
  },
  down: {
    frame: "border-bad/50 bg-bad/[0.06]",
    dot: "bg-bad lamp-bad",
    rail: "text-bad",
    note: "No Device in this stage is reporting.",
  },
  unmonitored: {
    frame: "border-line border-dashed bg-surface-sunken",
    dot: "bg-ink-faint",
    rail: "text-ink-faint",
    note:
      "No Device is registered at this stage. Normal on a Plant that has none — " +
      "a commissioning gap on one that does.",
  },
};

/**
 * Which drawing stands for each stage.
 *
 * Two of the four stage codes collide with a Device Type code and two do not,
 * so this is an explicit map rather than passing the stage code straight
 * through: `GRID` as a Device Type does not exist, and `INVERTERS` (plural, the
 * stage) is not `INVERTER` (singular, the type).
 */
const STAGE_ART: Record<string, string> = {
  PV_ARRAY: "PV_ARRAY",
  INVERTERS: "INVERTER",
  TRANSFORMER: "TRANSFORMER",
  GRID: "GRID",
};

/**
 * The connector between two stages.
 *
 * `flowing` animates it. It is passed by the caller from a figure that is
 * actually moving, never assumed — see the note at the top of this file.
 */
function Connector({
  tone,
  flowing,
}: {
  tone: string;
  flowing: boolean;
}): JSX.Element {
  return (
    <div
      className={`flex shrink-0 items-center justify-center self-center ${tone}`}
      title={flowing ? "Power is flowing in this direction" : "No power is flowing right now"}
      aria-hidden
    >
      <svg width="26" height="14" viewBox="0 0 26 14" fill="none" className="overflow-visible">
        <path
          d="M0 7h18"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          opacity={flowing ? 0.9 : 0.35}
          strokeDasharray={flowing ? "4 4" : undefined}
        >
          {flowing ? (
            <animate
              attributeName="stroke-dashoffset"
              from="8"
              to="0"
              dur="0.9s"
              repeatCount="indefinite"
            />
          ) : null}
        </path>
        <path
          d="M16.5 3.4 21.5 7l-5 3.6"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          opacity={flowing ? 0.95 : 0.4}
        />
      </svg>
    </div>
  );
}

function StageBox({
  stage,
  onSelect,
  selected,
  compact,
}: {
  stage: SldStage;
  onSelect?: (stage: SldStage) => void;
  selected?: boolean;
  compact?: boolean;
}): JSX.Element {
  const style = HEALTH[stage.health];
  const interactive = onSelect !== undefined;

  const body: ReactNode = (
    <>
      <div className="flex w-full items-start justify-between gap-1.5">
        <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-ink">
          {stage.label}
        </span>
        <span
          className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`}
          title={style.note}
        />
      </div>

      {/* The artwork takes the leftover height and stays centred in it, so a
          stage box stretched by a taller neighbour in the grid row distributes
          the slack around the drawing rather than dropping it all into one gap
          above the figures. */}
      <div className="flex w-full flex-1 flex-col items-center justify-center py-1">
        <DeviceArt typeCode={STAGE_ART[stage.code] ?? stage.code} size={compact ? 58 : 74} />
        <div className="mt-1 text-[10px] text-ink-muted">
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
      </div>

      <dl className="w-full space-y-0.5 border-t border-line-soft pt-1.5">
        {stage.slots.map((slot) => (
          <div key={slot.slot_code} className="flex items-baseline justify-between gap-1.5">
            <dt className="truncate text-[10px] text-ink-muted">{slot.label}</dt>
            <dd
              className={`shrink-0 font-mono text-[11px] tabular-nums ${
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
                <span className="ml-0.5 text-[9px] text-ink-muted">{slot.unit}</span>
              ) : null}
            </dd>
          </div>
        ))}
        {stage.slots.length === 0 ? (
          <p className="text-[10px] text-ink-faint">{UNDEFINED_DISPLAY}</p>
        ) : null}
      </dl>
    </>
  );

  const className =
    `flex min-w-[8.5rem] flex-1 flex-col items-center rounded-card border px-2 py-2.5 text-left transition ` +
    `${style.frame} ${selected ? "ring-2 ring-accent/40" : ""} ` +
    `${interactive ? "cursor-pointer hover:border-accent/50" : ""}`;

  if (!interactive) {
    return (
      <div className={className} title={style.note}>
        {body}
      </div>
    );
  }
  return (
    <button type="button" onClick={() => onSelect?.(stage)} className={className} title={style.note}>
      {body}
    </button>
  );
}

export function PlantSchematic({
  sld,
  onSelectStage,
  selectedStage,
  compact = false,
}: {
  sld: SldStages;
  /** Makes each stage a button — the drill-down into its Devices. */
  onSelectStage?: (stage: SldStage) => void;
  selectedStage?: string | null;
  compact?: boolean;
}): JSX.Element {
  /**
   * Whether power is moving out of a stage.
   *
   * Read from the stage's own resolved slots: any power or current figure that
   * is present and non-zero. Deliberately **not** inferred from health — a
   * stage can be perfectly healthy and producing nothing, which is every solar
   * plant every night, and an arrow that animates because the comms are fine
   * would be asserting generation from a communications fact.
   */
  const isFlowing = (stage: SldStage): boolean =>
    stage.slots.some((slot) => {
      if (slot.value === null) return false;
      const unit = (slot.unit ?? "").toLowerCase();
      const isRate = unit === "kw" || unit === "mw" || unit === "w" || unit === "a";
      return isRate && Math.abs(slot.value) > 0.001;
    });

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/*
        Scrolls sideways when four stages will not fit legibly.
        
        On a 390px phone four equal columns is ~85px each, at which the figures
        inside them are unreadable and — worse — the row was simply *clipped* by
        the panel, so Transformer and Grid could not be reached at all. A
        horizontal scroll keeps the diagram in its real order, which is the only
        thing about it that carries meaning: PV Array → Inverters → Transformer
        → Grid, left to right, on every Plant.
        
        ⚠ Not `flex-wrap`. Wrapping puts Transformer under PV Array and the row
        stops reading as a sequence — and this diagram's entire argument is that
        it is the same four boxes in the same order on every Plant, so an
        operator can compare two of them.
      */}
      <div className="flex flex-1 items-stretch gap-1 overflow-x-auto pb-1 [scrollbar-width:thin]">
        {sld.stages.map((stage, index) => (
          <div key={stage.code} className="flex flex-1 items-stretch gap-1">
            <StageBox
              stage={stage}
              onSelect={onSelectStage}
              selected={selectedStage === stage.code}
              compact={compact}
            />
            {index < sld.stages.length - 1 ? (
              <Connector tone={HEALTH[stage.health].rail} flowing={isFlowing(stage)} />
            ) : null}
          </div>
        ))}
      </div>

      {sld.unstaged.length > 0 ? (
        <p className="mt-2 text-[10px] leading-snug text-warn">
          <strong>{sld.unstaged.length}</strong> Device
          {sld.unstaged.length === 1 ? "" : "s"} carry current but belong to no stage:{" "}
          {sld.unstaged.map((device) => device.code).join(", ")}. Their Device Type has no{" "}
          <code>sld_stage</code>, so they are missing from this diagram — set one in the
          catalogue.
        </p>
      ) : null}
    </div>
  );
}
