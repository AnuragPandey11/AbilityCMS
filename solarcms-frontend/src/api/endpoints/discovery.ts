/**
 * What the broker is publishing — the facts onboarding should be built on.
 *
 * Engineers configure and publish before we onboard, so the Client codes, Plant
 * codes, Collector names, Device codes and payload keys are all observable
 * *before* anyone fills in a form. These endpoints turn onboarding from typing
 * into confirming.
 *
 * ⚠ Super Admin only, and not by choice. An unregistered Device's topic is
 * quarantined with `client_id = NULL`, because attributing it to a Client by
 * reading the topic is the inference Guardrail 5 forbids. `mqtt_raw_v` shows
 * those rows to a platform administrator alone.
 *
 * ⚠ This reflects what **ingest has received**, not what the broker holds. If
 * ingest is stopped or cannot reach the broker, discovery goes quiet — which is
 * honest, because in that state nobody knows what is being published.
 */

import { z } from "zod";
import { request } from "../client";
import { parse } from "../schemas";

export const DiscoveredClientSchema = z.object({
  client_code: z.string(),
  plant_codes: z.array(z.string()),
  topics: z.number(),
  messages: z.number(),
  last_seen: z.string(),
  /** Already registered — offer it as "open", never as "create". */
  registered_client_id: z.number().nullable(),
});
export type DiscoveredClient = z.infer<typeof DiscoveredClientSchema>;

export const DiscoveredDeviceSchema = z.object({
  device_code: z.string(),
  /** `null` is a real answer: the five-segment shape has no enclosure. */
  collector_code: z.string().nullable(),
  topic: z.string(),
  messages: z.number(),
  last_seen: z.string(),
  ever_quarantined: z.boolean(),
  registered_device_id: z.number().nullable(),
  /**
   * Measured gap between messages on this topic, so liveness is judged against
   * its own cadence. `null` when it has been seen once and there is no gap.
   */
  interval_s: z.number().nullable().optional(),
  /**
   * `live` — publishing now, judged against its own interval.
   * `silent` — seen in the window but stopped.
   *
   * ⚠ Only a `live` topic is a registration candidate. Registering a `silent`
   * one produces a Device that never reports, which looks exactly like broken
   * equipment on every screen afterwards.
   */
  status: z.enum(["live", "silent"]).optional(),
  /** Dismissed from discovery by somebody. Hidden unless asked for. */
  ignored: z.boolean().optional(),
});
export type DiscoveredDevice = z.infer<typeof DiscoveredDeviceSchema>;

export const DiscoveredPlantSchema = z.object({
  plant_code: z.string(),
  devices: z.array(DiscoveredDeviceSchema),
  collectors: z.array(z.string()),
  device_count: z.number(),
  /** Publishing now and registered to nothing — the only rows needing a decision. */
  unregistered_count: z.number(),
  /** Stopped publishing and never registered: retired shapes, not equipment. */
  silent_unregistered_count: z.number().optional(),
  last_seen: z.string(),
  registered_plant_id: z.number().nullable(),
});
export type DiscoveredPlant = z.infer<typeof DiscoveredPlantSchema>;

export const ObservedKeySchema = z.object({
  source_key: z.string(),
  sample_value: z.unknown(),
  /**
   * What the registry thinks this key means — a **suggestion only**.
   *
   * Device Type decides it: `VRY` is 11.037 from an MFM on an 11 kV feeder and
   * 799.9 from an Inverter on an 800 V bus. The binding an operator confirms is
   * the authority, never this.
   */
  suggested_tag_code: z.string().nullable(),
  /** Nothing maps it — a signal the Device really sends that we would discard. */
  unmapped: z.boolean(),
});
export type ObservedKey = z.infer<typeof ObservedKeySchema>;

export const ObservedTopicSchema = z.object({
  topic: z.string(),
  seen: z.boolean(),
  messages: z.number(),
  first_seen: z.string().optional(),
  last_seen: z.string().optional(),
  last_payload: z.unknown().nullable(),
  flat_payload: z.record(z.unknown()).optional(),
  payload_timestamp: z.string().nullable().optional(),
  /**
   * A Device registered for this exact topic, if any.
   *
   * ⚠ Distinct from `quarantined`, which records what happened to one message
   * when it arrived. A topic quarantined all last week and registered this
   * morning still has quarantined history; reporting that as "no Device
   * registered" tells the operator to fix something already fixed.
   */
  registered_device_id: z.number().nullable().optional(),
  quarantined: z.boolean().optional(),
  reason: z.string().nullable().optional(),
  keys: z.array(ObservedKeySchema),
  unmapped_count: z.number().optional(),
  /** Measured, never assumed — this is what `expected_interval_s` should be. */
  interval_s: z.number().nullable(),
});
export type ObservedTopic = z.infer<typeof ObservedTopicSchema>;

export async function discoverClients(): Promise<DiscoveredClient[]> {
  return parse(
    z.array(DiscoveredClientSchema),
    await request("/discovery/clients"),
    "GET /discovery/clients",
  );
}

export async function discoverPlants(clientCode: string): Promise<DiscoveredPlant[]> {
  return parse(
    z.array(DiscoveredPlantSchema),
    await request("/discovery/plants", { params: { client_code: clientCode } }),
    "GET /discovery/plants",
  );
}

export async function discoverTopic(
  topic: string,
  deviceTypeCode?: string | null,
): Promise<ObservedTopic> {
  return parse(
    ObservedTopicSchema,
    await request("/discovery/topic", {
      params: { topic, device_type_code: deviceTypeCode ?? undefined },
    }),
    "GET /discovery/topic",
  );
}
