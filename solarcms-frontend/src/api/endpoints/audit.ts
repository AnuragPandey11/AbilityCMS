import { z } from "zod";
import { request } from "../client";
import { AuditEntrySchema, parse, type AuditEntry } from "../schemas";

/** Read-only by construction: no write route exists, the trail is immutable. */
export async function listAudit(
  params: {
    action?: string | null;
    since?: string | null;
    limit?: number;
  } = {},
): Promise<AuditEntry[]> {
  const body = await request("/audit", {
    params: {
      action: params.action ?? undefined,
      since: params.since ?? undefined,
      limit: params.limit ?? 100,
    },
  });
  return parse(z.array(AuditEntrySchema), body, "GET /audit");
}
