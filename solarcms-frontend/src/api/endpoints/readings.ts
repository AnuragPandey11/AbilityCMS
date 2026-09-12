import { request, requestBlob } from "../client";
import {
  ReadingsResponseSchema,
  parse,
  type ReadingsResponse,
  type Tier,
} from "../schemas";

export interface ReadingsQuery {
  deviceIds: number[];
  tagIds?: number[];
  from: Date | string;
  to: Date | string;
  /** `auto` lets the server pick the tier. Prefer it (§9). */
  resolution?: Tier | "auto";
}

function toIso(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString();
}

function params(query: ReadingsQuery) {
  return {
    device_ids: query.deviceIds,
    tag_ids: query.tagIds && query.tagIds.length > 0 ? query.tagIds : undefined,
    from: toIso(query.from),
    to: toIso(query.to),
    resolution: query.resolution ?? "auto",
  };
}

/**
 * History, tier-routed.
 *
 * The response carries the tier that actually served it, which is not always the
 * one the range implies: a six-hour window two months ago comes from an
 * aggregate because raw was dropped at thirty days. Label it, or a smoothed
 * daily line reads as a measurement (§9).
 *
 * A 422 here may be the point cap rather than a validation error — narrow the
 * range, the Devices or the Tags; do not retry.
 */
export async function getReadings(
  query: ReadingsQuery,
): Promise<ReadingsResponse> {
  const body = await request("/readings", { params: params(query) });
  return parse(ReadingsResponseSchema, body, "GET /readings");
}

/** CSV. A separate permission from viewing: `data.export` (MASTER §4.3). */
export async function exportReadings(query: ReadingsQuery): Promise<Blob> {
  return requestBlob("/readings/export", params(query));
}
