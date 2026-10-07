/**
 * Turning a status code into what the client says it means.
 *
 * A status code is a number the Device sent (`DEVICE_STATUS`, the Inverter's
 * `STS`); what it means depends on the make, so the client records it per
 * Plant (migration 0032). Where nobody has, the code is shown as sent — never
 * translated by a guess, because "512 → Running" invented here would be read
 * as the Inverter's own word.
 */

import type { PlantStatusCodes, StatusKind } from "@/api/endpoints/statusCodes";

export interface StatusMeaning {
  code: number;
  label: string;
  kind: StatusKind;
  note: string | null;
}

export type StatusLookup = (
  deviceTypeCode: string | null | undefined,
  tagCode: string | null | undefined,
  value: number | null | undefined,
) => StatusMeaning | null;

export const NO_MEANINGS: StatusLookup = () => null;

const keyOf = (typeCode: string, tagCode: string, code: number) => `${typeCode}|${tagCode}|${code}`;

/** A lookup over one Plant's recorded meanings. */
export function statusLookup(data: PlantStatusCodes | undefined): StatusLookup {
  if (!data || data.codes.length === 0) return NO_MEANINGS;
  const byKey = new Map(
    data.codes.map((entry) => [
      keyOf(entry.device_type_code, entry.tag_code, entry.code),
      { code: entry.code, label: entry.label, kind: entry.kind, note: entry.note },
    ]),
  );
  return (typeCode, tagCode, value) => {
    // A code is a whole number; anything else is not one of the client's codes.
    if (!typeCode || !tagCode || value === null || value === undefined) return null;
    if (!Number.isInteger(value)) return null;
    return byKey.get(keyOf(typeCode, tagCode, value)) ?? null;
  };
}

export const STATUS_KIND_WORD: Record<StatusKind, string> = {
  normal: "Normal",
  standby: "Standby",
  warning: "Warning",
  fault: "Fault",
};

/**
 * The client's own verdict on a code, in the status colours: the kind is a
 * judgement they made when they described it, so it may wear one. Standby is
 * neither good nor bad news and stays neutral.
 */
export const STATUS_KIND_TONE: Record<StatusKind, "ok" | "muted" | "warn" | "bad"> = {
  normal: "ok",
  standby: "muted",
  warning: "warn",
  fault: "bad",
};

/** "Grid connected (512)", or the code alone where nothing is recorded. */
export function statusText(value: number, meaning: StatusMeaning | null): string {
  return meaning ? `${meaning.label} (${value})` : String(value);
}
