import { z } from "zod";
import { request } from "../client";
import { RegionSchema, parse, type Region } from "../schemas";

/** Catalogue: readable by every authenticated User. */
export async function listRegions(): Promise<Region[]> {
  return parse(
    z.array(RegionSchema),
    await request("/regions"),
    "GET /regions",
  );
}

/** Super Admin only (`system.admin`). Codes follow ISO 3166-2, e.g. `IN-UP`. */
export async function createRegion(input: {
  code: string;
  name: string;
  country?: string;
  grid_emission_factor_kg_per_kwh?: number | null;
}): Promise<Region> {
  return parse(
    RegionSchema,
    await request("/regions", {
      method: "POST",
      body: {
        code: input.code,
        name: input.name,
        country: input.country ?? "IN",
        grid_emission_factor_kg_per_kwh:
          input.grid_emission_factor_kg_per_kwh ?? null,
      },
    }),
    "POST /regions",
  );
}
