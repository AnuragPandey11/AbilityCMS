import { z } from "zod";
import { request } from "../client";
import { ClientSchema, parse, type Client } from "../schemas";

/** Super Admin only (`system.admin`). */
export async function listClients(): Promise<Client[]> {
  return parse(
    z.array(ClientSchema),
    await request("/clients"),
    "GET /clients",
  );
}

// `POST /clients` returns the new row without `created_at`.
const CreatedClientSchema = ClientSchema.omit({ created_at: true });
export type CreatedClient = z.infer<typeof CreatedClientSchema>;

export interface ClientCommercials {
  /** The operator's own account number for this Client. Unique when present. */
  client_number?: string | null;
  /** 15-character GSTIN. Shape-checked by the API and by a CHECK constraint. */
  gst_number?: string | null;
  /**
   * The Client organisation's commercial contact — NOT a login. A User signs in
   * through their own `users.email`; this address has no account attached.
   */
  contact_email?: string | null;
  contract_start_date?: string | null;
}

/**
 * Super Admin only (`system.admin`). The new Client starts in `onboarding`.
 *
 * ⚠ A JSON body, not query parameters. It used to be the latter, which was
 * tolerable for two strings and is not for a commercial record — a GSTIN or an
 * email in a query string ends up in every access log and proxy cache along the
 * way.
 *
 * `contract_valid_days` is a duration because that is how the contract reads;
 * the API adds it to the start date once and stores a real expiry date, so no
 * caller ever has to recompute it.
 */
export async function createClient(
  input: {
    code: string;
    name: string;
    is_demo?: boolean;
    contract_valid_days?: number | null;
  } & ClientCommercials,
): Promise<CreatedClient> {
  return parse(
    CreatedClientSchema,
    await request("/clients", { method: "POST", body: input }),
    "POST /clients",
  );
}

/**
 * ⚠ `is_demo` is an access-control switch, not a label: I-6 permits a Guest only
 * on a demonstration Client, and the visibility policy reads this column.
 *
 * Renewal takes `contract_valid_till` as a date rather than a duration: "it now
 * runs to this date" is the actual operation, and re-deriving it from a day
 * count would need a base date the caller has not supplied.
 */
export async function updateClient(
  clientId: number,
  body: {
    name?: string | null;
    status?: string | null;
    is_demo?: boolean | null;
    contract_valid_till?: string | null;
  } & ClientCommercials,
): Promise<unknown> {
  return request(`/clients/${clientId}`, { method: "PATCH", body });
}
