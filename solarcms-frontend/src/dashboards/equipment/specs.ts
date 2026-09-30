/**
 * The Transformer, PPC and VCB screens, as data.
 *
 * The client's reference screens (30 Sep 2026) for the Plant's HV equipment
 * are one shape three times — a few figures, a panel of contacts, a pair of
 * trends — so they are one screen (`EquipmentDashboard`) and three specs. Each
 * names Device *Types* and Tag codes, catalogue rows, never a Client, Plant or
 * Device (Guardrail 2), exactly as the Weather screen filters on `WMS`.
 *
 * Tag codes and units are the catalogue's (TAG_CATALOGUE §2.1, §2.5, §2.7).
 * Labels follow the reference in sentence case, corrected where the reference
 * names a signal as something it is not — the hover on every tile gives the
 * Tag's own name and code.
 */

import type { Position } from "@/components/devices/InverterView";
import type { IconComponent } from "@/components/layout/navigation";
import {
  IconFrequency,
  IconGauge,
  IconPower,
  IconThermometer,
  IconVoltage,
} from "@/components/icons";

export interface FigureSpec extends Position {
  icon: IconComponent;
  /**
   * Shown only where the Device reports this Tag or is bound to it. For a
   * variant's extra signal — the second winding thermometer of a 3-winding
   * Transformer — which on the other variant is not a gap, and a permanent
   * dash would say it is.
   */
  optional?: boolean;
}

export interface TrendSpec {
  key: string;
  title: string;
  /** One line, or several in one unit on one axis (Guardrail 22). */
  lines: FigureSpec[];
  /** Mark the maximum — only where the highest instant is a fact somebody acts on. */
  markPeak: boolean;
}

export interface EquipmentSpec {
  /** The page title. */
  title: string;
  /** What the screen is about, under the title while no Device is chosen. */
  intro: string;
  /** Device Types this screen shows, in the order a picker lists them. */
  typeCodes: string[];
  /** Names one Device in a picker label — "Transformer". */
  noun: string;
  /** Names one Device in a reason — "this Transformer". */
  subject: string;
  figures: FigureSpec[];
  flags: Position[];
  /** Full Tailwind class names, never assembled (Tailwind emits only literals). */
  flagGrid: string;
  trends: TrendSpec[];
  /**
   * Every Device of the Type at once, each in its own panel, instead of one
   * chosen from a picker. For a Type a Plant holds one per feeder (MASTER §3:
   * `VCB-IC-1`, `VCB-OG-2`) whose screen is contacts only — comparing breakers
   * side by side is the point, and a picker would hide all but one. A screen
   * with trends keeps the picker: trends are about one Device.
   */
  showEvery: boolean;
  empty: { title: string; detail: string };
}

// ── Transformer ─────────────────────────────────────────────────────────────

const OIL_TEMPERATURE: FigureSpec = { label: "Oil temperature", codes: ["OTI_TEMPERATURE"], icon: IconThermometer };
const WINDING_1_TEMPERATURE: FigureSpec = {
  label: "Winding 1 temperature",
  codes: ["WTI_1_TEMPERATURE"],
  icon: IconThermometer,
};
const WINDING_2_TEMPERATURE: FigureSpec = {
  label: "Winding 2 temperature",
  codes: ["WTI_2_TEMPERATURE"],
  icon: IconThermometer,
  optional: true,
};

/**
 * ⚠ No alarm or trip line is drawn on the temperature trends: the
 * Transformer's own settings have not been supplied (TAG_CATALOGUE T-10), and
 * the contacts below fire at them — a line at a number chosen here would be a
 * setting nobody made.
 */
export const TRANSFORMER: EquipmentSpec = {
  title: "Power Transformer",
  intro: "The Transformer's oil and winding temperatures and its protection contacts.",
  typeCodes: ["TRANSFORMER"],
  noun: "Transformer",
  subject: "this Transformer",
  figures: [OIL_TEMPERATURE, WINDING_1_TEMPERATURE, WINDING_2_TEMPERATURE],
  flags: [
    { label: "Oil temp. alarm", codes: ["OIL_TEMP_ALARM"] },
    { label: "Oil temp. trip", codes: ["OIL_TEMP_TRIP"] },
    { label: "Winding 1 temp. alarm", codes: ["WINDING_TEMP_1_ALARM"] },
    { label: "Winding 1 temp. trip", codes: ["WINDING_TEMP_1_TRIP"] },
    { label: "Winding 2 temp. alarm", codes: ["WINDING_TEMP_2_ALARM"] },
    { label: "Winding 2 temp. trip", codes: ["WINDING_TEMP_2_TRIP"] },
    { label: "Buchholz relay alarm", codes: ["BUCHHOLZ_RELAY_ALARM"] },
    { label: "Buchholz relay trip", codes: ["BUCHHOLZ_RELAY_TRIP"] },
    { label: "Magnetic oil gauge alarm", codes: ["MOG_ALARM"] },
  ],
  flagGrid: "grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4",
  trends: [
    { key: "oil", title: "Oil temperature", lines: [OIL_TEMPERATURE], markPeak: true },
    {
      key: "winding",
      title: "Winding temperature",
      lines: [WINDING_1_TEMPERATURE, WINDING_2_TEMPERATURE],
      markPeak: true,
    },
  ],
  showEvery: false,
  empty: {
    title: "No Transformer at this Plant",
    detail:
      "No Device of type TRANSFORMER is registered here, so there is nothing to show — not a Transformer that has gone quiet. A Plant connected at LV often has none, and that is normal.",
  },
};

// ── PPC ─────────────────────────────────────────────────────────────────────

const ACTIVE_POWER_SETPOINT: FigureSpec = {
  label: "Active power setpoint",
  codes: ["ACTIVE_POWER_SETPOINT"],
  icon: IconPower,
};
const REACTIVE_POWER_SETPOINT: FigureSpec = {
  label: "Reactive power setpoint",
  codes: ["REACTIVE_POWER_SETPOINT"],
  icon: IconPower,
};

/**
 * Five setpoint / control-enable pairs, the pairing the client's own
 * (TAG_CATALOGUE §2.7), in the same order in both rows so each enable sits
 * under its setpoint. The reference lists "Power factor setpoint" among the
 * contacts; it is a ratio, so it is a figure here.
 *
 * ⚠ A setpoint of 0 while its control is disabled is the client's "not
 * commanded" sentinel (`assumptions.FREQUENCY_SETPOINT`), shown as sent — the
 * enable beneath it is what says whether it is in force.
 */
export const PPC: EquipmentSpec = {
  title: "Power Plant Controller",
  intro: "The Power Plant Controller's setpoints, and whether each control is enabled.",
  typeCodes: ["PPC"],
  noun: "PPC",
  subject: "this PPC",
  figures: [
    ACTIVE_POWER_SETPOINT,
    REACTIVE_POWER_SETPOINT,
    { label: "Voltage setpoint", codes: ["VOLTAGE_SETPOINT"], icon: IconVoltage },
    { label: "Power factor setpoint", codes: ["POWER_FACTOR_SETPOINT"], icon: IconGauge },
    { label: "Frequency setpoint", codes: ["FREQUENCY_SETPOINT"], icon: IconFrequency },
  ],
  flags: [
    { label: "Active power control", codes: ["ACTIVE_POWER_CONTROL_ENABLE"] },
    { label: "Reactive power control", codes: ["REACTIVE_POWER_CONTROL_ENABLE"] },
    { label: "Voltage control", codes: ["VOLTAGE_CONTROL_ENABLE"] },
    { label: "Power factor control", codes: ["POWER_FACTOR_CONTROL_ENABLE"] },
    { label: "Frequency control", codes: ["FREQUENCY_CONTROL_ENABLE"] },
  ],
  flagGrid: "grid gap-2.5 sm:grid-cols-2 lg:grid-cols-5",
  trends: [
    // The highest setpoint of the day is not a fact anyone acts on; when it
    // changed is, and the line shows that.
    { key: "active", title: "Active power setpoint", lines: [ACTIVE_POWER_SETPOINT], markPeak: false },
    { key: "reactive", title: "Reactive power setpoint", lines: [REACTIVE_POWER_SETPOINT], markPeak: false },
  ],
  showEvery: false,
  empty: {
    title: "No Power Plant Controller at this Plant",
    detail:
      "No Device of type PPC is registered here, so there is nothing to show — not a controller that has gone quiet. Many Plants have none, and that is normal.",
  },
};

// ── VCB ─────────────────────────────────────────────────────────────────────

/** All twelve are contacts: the VCB reports no analogue value (TAG_CATALOGUE §2.1). */
export const VCB: EquipmentSpec = {
  title: "Vacuum Circuit Breaker",
  intro: "Each breaker's position, protection and supply contacts.",
  typeCodes: ["VCB"],
  noun: "VCB",
  subject: "this breaker",
  figures: [],
  flags: [
    { label: "Breaker on", codes: ["VCB_ON_FEEDBACK"] },
    { label: "Tripped", codes: ["VCB_TRIP_FEEDBACK"] },
    { label: "Test mode", codes: ["VCB_IN_TEST_MODE"] },
    { label: "Service mode", codes: ["VCB_IN_SERVICE"] },
    { label: "Spring charged", codes: ["VCB_SPRING_CHARGE"] },
    { label: "Over-current relay", codes: ["VCB_OC_RELAY"] },
    { label: "AC supply fail", codes: ["AC_FAIL"] },
    { label: "DC supply fail", codes: ["DC_FAIL"] },
    // The catalogue's TC is the trip coil, and so is the Alarm Rule's name.
    { label: "Trip coil healthy", codes: ["VCB_TC_HEALTHY"] },
    { label: "Emergency push button", codes: ["VCB_EMERGENCY_PB"] },
    { label: "Relay unhealthy", codes: ["VCB_RELAY_UNHEALTHY"] },
    { label: "Remote mode", codes: ["VCB_REMOTE_SELECTION"] },
  ],
  flagGrid: "grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4",
  trends: [],
  showEvery: true,
  empty: {
    title: "No VCB at this Plant",
    detail:
      "No Device of type VCB is registered here, so there is nothing to show — not a breaker that has gone quiet. A Plant connected at LV often has none, and that is normal.",
  },
};
