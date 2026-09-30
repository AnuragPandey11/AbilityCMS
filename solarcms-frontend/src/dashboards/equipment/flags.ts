/**
 * What a contact on the Transformer, PPC and VCB screens says.
 *
 * ── The word is the contact, the colour is an Alarm ─────────────────────────
 * The word is the state as the equipment sends it — `"ON": "TRUE"` on the
 * client's VCB — so TRUE or FALSE, never ON/OFF: the contacts are named as
 * predicates ("Tripped", "Spring charged", "Trip circuit healthy"), and
 * "Tripped: ON" reads as nothing.
 *
 * Whether that state is *bad* is not something this screen can tell from the
 * word. The client's reference paints every TRUE red and every FALSE green,
 * which makes a closed breaker ("Breaker ON: TRUE") and a healthy trip circuit
 * look like faults and a failed one look healthy. The platform already holds
 * the answer as data: the Alarm Rules say which state of which contact is a
 * fault (`is_true` on a Buchholz trip, `is_false` on "trip circuit healthy"),
 * and the alarm worker applies them with precedence, debounce and
 * acknowledgement. So a flag is marked only where an **open Alarm names its
 * Tag** — the rule's verdict, never one invented here — active in red,
 * acknowledged in amber as the Alarms screen shows them. A contact no rule
 * watches stays neutral in either state, because nobody has said which of its
 * states is the fault.
 *
 * ⚠ A contact that has just entered its fault state reads neutral until the
 * rule's debounce elapses and the Alarm opens (0 s on every trip contact, up
 * to 60 s on health contacts), and neutral for as long as the alarm worker is
 * not running — the System Health page is what says so.
 */

import type { Alarm, AlarmSeverity } from "@/api/schemas";
import { UNDEFINED_DISPLAY } from "@/format/value";

export type FlagTone = "neutral" | "bad" | "warn";

export interface FlagState {
  /** TRUE, FALSE, or the dash for no reading. */
  word: string;
  tone: FlagTone;
  /** The open Alarm naming this contact, if any. */
  alarm: Alarm | null;
}

const SEVERITY_RANK: Record<AlarmSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Open means not resolved: active, or acknowledged and still standing. */
export function isOpen(alarm: Pick<Alarm, "state">): boolean {
  return alarm.state === "active" || alarm.state === "acknowledged";
}

/**
 * The open Alarm to show for each Tag: active before acknowledged, then the
 * most severe, then the most recent — the one somebody most needs to see
 * where two rules watch one contact.
 */
export function openAlarmsByTag(alarms: Alarm[], deviceId: number): Map<string, Alarm> {
  const out = new Map<string, Alarm>();
  const rank = (alarm: Alarm) =>
    [alarm.state === "active" ? 0 : 1, SEVERITY_RANK[alarm.severity] ?? 9, -Date.parse(alarm.opened_at)] as const;
  const before = (a: Alarm, b: Alarm) => {
    const [x, y] = [rank(a), rank(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  };
  for (const alarm of alarms) {
    if (!isOpen(alarm) || alarm.device_id !== deviceId || !alarm.tag_code) continue;
    const held = out.get(alarm.tag_code);
    if (!held || before(alarm, held) < 0) out.set(alarm.tag_code, alarm);
  }
  return out;
}

export function flagState(
  value: number | null,
  tagCode: string | undefined,
  alarms: Map<string, Alarm>,
): FlagState {
  const word = value === null || !Number.isFinite(value) ? UNDEFINED_DISPLAY : value === 0 ? "FALSE" : "TRUE";
  // An Alarm stays open after the Device goes quiet, and still names the
  // contact: the dash is the reading, the colour is the Alarm.
  const alarm = tagCode ? (alarms.get(tagCode) ?? null) : null;
  const tone: FlagTone = !alarm ? "neutral" : alarm.state === "active" ? "bad" : "warn";
  return { word, tone, alarm };
}
