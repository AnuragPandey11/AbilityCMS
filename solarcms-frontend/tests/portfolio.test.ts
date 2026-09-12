/**
 * The portfolio exclusion rule (§6.1, MASTER §6.5) and Plant scoping.
 */

import { describe, expect, it } from "vitest";
import { isOnboarding } from "@/components/domain";

describe("portfolio exclusion", () => {
  it("excludes draft and commissioning Plants from totals", () => {
    expect(isOnboarding("draft")).toBe(true);
    expect(isOnboarding("commissioning")).toBe(true);
  });

  it("counts every other status", () => {
    for (const status of ["active", "suspended", "decommissioned"]) {
      expect(isOnboarding(status)).toBe(false);
    }
  });
});
