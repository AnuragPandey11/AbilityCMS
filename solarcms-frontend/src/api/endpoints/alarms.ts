import { z } from "zod";
import { request } from "../client";
import {
  AlarmRuleSchema,
  AlarmSchema,
  parse,
  type Alarm,
  type AlarmRule,
  type AlarmSeverity,
  type AlarmState,
} from "../schemas";

export interface AlarmQuery {
  state?: AlarmState | null;
  severity?: AlarmSeverity | null;
  plantId?: number | null;
  since?: string | null;
  limit?: number;
}

/**
 * One breach produces exactly one Alarm, not one per Reading, and a Collector
 * failure surfaces as one Alarm covering many Devices. Apparent duplicates are a
 * real bug worth reporting — never de-duplicated client-side (§6.6).
 */
export async function listAlarms(query: AlarmQuery = {}): Promise<Alarm[]> {
  const body = await request("/alarms", {
    params: {
      state: query.state ?? undefined,
      severity: query.severity ?? undefined,
      plant_id: query.plantId ?? undefined,
      since: query.since ?? undefined,
      limit: query.limit ?? 100,
    },
  });
  return parse(z.array(AlarmSchema), body, "GET /alarms");
}

export async function acknowledgeAlarm(alarmId: number): Promise<unknown> {
  return request(`/alarms/${alarmId}/acknowledge`, { method: "POST" });
}

/**
 * A Client's own rules plus the platform defaults (`client_id: null`), which are
 * read-only here. To change a default a Client creates a more specific rule and
 * scope resolution prefers it: device → plant → device_type → global (§7.3).
 */
export async function listAlarmRules(): Promise<AlarmRule[]> {
  return parse(
    z.array(AlarmRuleSchema),
    await request("/alarm-rules"),
    "GET /alarm-rules",
  );
}

export interface AlarmRuleWrite {
  code: string;
  name: string;
  scope_type?: string;
  scope_id?: number | null;
  tag_code?: string | null;
  operator: string;
  /** Absent for `is_true`/`is_false` — the contact is the condition. */
  threshold?: number | null;
  threshold_high?: number | null;
  clear_threshold?: number | null;
  duration_s?: number;
  severity?: string;
  classification?: string | null;
  enabled?: boolean;
}

export async function createAlarmRule(body: AlarmRuleWrite): Promise<unknown> {
  return request("/alarm-rules", { method: "POST", body });
}

/**
 * A platform default is invisible to this UPDATE and returns 404 rather than
 * silently editing every Client's inherited rule.
 */
export async function updateAlarmRule(
  ruleId: number,
  body: AlarmRuleWrite,
): Promise<unknown> {
  return request(`/alarm-rules/${ruleId}`, { method: "PATCH", body });
}
