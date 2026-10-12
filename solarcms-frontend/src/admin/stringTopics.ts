/**
 * PV-string topics, read exactly as the server reads them
 * (`domain/commissioning.py`), and the one repair they need.
 *
 * An Inverter's PV strings arrive on a topic of their own —
 * `…/MCR/INVERTER_1_STRING16`, or on Vardhman Group's broker just
 * `…/MCR/INVERTER_1_STRING` — beside the Inverter's own `…/MCR/INVERTER_1`.
 * The Inverter is registered on its own topic and the string topic is
 * *attached* to it. Registered on the string topic instead, every power, energy
 * and voltage reading it sends is thrown away while every screen calls it
 * registered: four Inverters went that way on 12 Oct 2026, from a screen that
 * offered it. Only equipment whose own topic never publishes (ISPL's SMB1,
 * known only by `SMB1_STRING16`) is registered on a string topic.
 */

import * as devicesApi from "@/api/endpoints/devices";
import { isApiError } from "@/api/problem";

// The server's `STRING_TOPIC_DEVICE_SUFFIX`, `_STRING\d*`, anchored the same way.
const STRING_TOPIC = /^(.+?)_STRING\d*$/;

/** The Device whose PV strings a topic carries: `INVERTER_1_STRING16` → `INVERTER_1`. */
export function stringTopicOwner(deviceCode: string): string | null {
  const match = STRING_TOPIC.exec(deviceCode);
  return match?.[1] ?? null;
}

/** The last segment of a topic: the Device code it names. */
export function deviceCodeOf(topic: string): string {
  return topic.slice(topic.lastIndexOf("/") + 1);
}

/**
 * The topic a string topic's owner publishes its own readings on:
 * `…/MCR/INVERTER_1_STRING` → `…/MCR/INVERTER_1`. Only the last segment
 * changes — an owner sits in the same enclosure as its strings.
 */
export function ownTopicOf(topic: string): string | null {
  const cut = topic.lastIndexOf("/");
  if (cut === -1) return null;
  const owner = stringTopicOwner(topic.slice(cut + 1));
  return owner === null ? null : `${topic.slice(0, cut)}/${owner}`;
}

/** A Device registered on its own string topic: `INVERTER_1` on `…/INVERTER_1_STRING`. */
export function onItsOwnStringTopic(code: string, topic: string | null | undefined): boolean {
  return Boolean(topic) && stringTopicOwner(deviceCodeOf(topic as string)) === code;
}

export interface SuggestedBinding {
  source_key: string;
  tag_code: string;
}

export interface MoveResult {
  mapped: number;
  /** Keys the server would not map (already mapped, or the Tag already taken). */
  skipped: string[];
}

/**
 * Move a Device registered on its own string topic to its own topic.
 *
 * Three calls to the routes that already own each change, so each is refused
 * and audited as it is anywhere else: the Device's topic, then the string topic
 * attached back to it (only possible once it is no longer the primary), then
 * each reading its own topic sends, mapped to the Tag it usually means. A key
 * the server will not map is left for the Data Issues "unmapped" card rather
 * than failing the move, which has already happened by then.
 */
export async function moveToOwnTopic(
  deviceId: number,
  ownTopic: string,
  stringTopic: string,
  bindings: SuggestedBinding[],
): Promise<MoveResult> {
  await devicesApi.updateDevice(deviceId, { source_address: ownTopic });
  await devicesApi.addDeviceTopic(
    deviceId, stringTopic, "Kept as its string topic when moved to its own topic",
  );
  const result: MoveResult = { mapped: 0, skipped: [] };
  for (const binding of bindings) {
    try {
      await devicesApi.addBinding(deviceId, binding);
      result.mapped += 1;
    } catch (err) {
      if (isApiError(err) && err.status >= 400 && err.status < 500) {
        result.skipped.push(binding.source_key);
      } else {
        throw err;
      }
    }
  }
  return result;
}

/** One sentence for the screen after a move. */
export function describeMove(code: string, result: MoveResult): string {
  return (
    `${code} moved to its own topic, with its string topic still attached, and ` +
    `${result.mapped} reading(s) mapped.` +
    (result.skipped.length
      ? ` Not mapped: ${result.skipped.join(", ")} — see Data Issues.`
      : "")
  );
}
