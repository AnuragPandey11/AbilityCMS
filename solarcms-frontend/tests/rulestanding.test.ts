/**
 * What the Alarm Rules screen tells someone about a rule's standing.
 *
 * The screen must agree with the server's precedence: scope first, and only at
 * the same scope does the Client's own rule beat the platform default. A rule
 * that cannot win must say so, since the server would store it without error.
 */

import { describe, expect, it } from "vitest";
import { scopeLabel, standingOf, type RuleShape } from "@/admin/ruleStanding";

const DEFAULT_OVERTEMP: RuleShape = {
  id: 9,
  client_id: null,
  client_code: null,
  code: "INV_OVERTEMP",
  scope_type: "device_type",
  scope_id: 3,
  scope_code: "INVERTER",
};

const own = (patch: Partial<RuleShape>): RuleShape => ({
  id: 50,
  client_id: 1,
  client_code: "SUNFIELD",
  code: "INV_OVERTEMP",
  scope_type: "device_type",
  scope_id: 3,
  scope_code: "INVERTER",
  ...patch,
});

describe("a Client's rule against the platform default", () => {
  it("replaces it at the same scope", () => {
    const standing = standingOf(own({}), [DEFAULT_OVERTEMP]);
    expect(standing?.tone).toBe("ok");
    expect(standing?.text).toContain("Replaces the platform default for SUNFIELD");
  });

  it("replaces it within a narrower scope", () => {
    const rule = own({ scope_type: "plant", scope_id: 2, scope_code: "SF_SOUTH" });
    expect(standingOf(rule, [DEFAULT_OVERTEMP])?.text).toBe(
      "Replaces the platform default within plant SF_SOUTH.",
    );
  });

  it("warns when the default is narrower and so still wins", () => {
    const rule = own({ scope_type: "client", scope_id: 1, scope_code: "SUNFIELD" });
    const standing = standingOf(rule, [DEFAULT_OVERTEMP]);
    expect(standing?.tone).toBe("warn");
    expect(standing?.text).toContain("device type INVERTER");
  });

  it("says nothing when the two can never meet", () => {
    // Same rank, different target: a rule about meters does not touch a
    // default about Inverters.
    const rule = own({ scope_id: 6, scope_code: "MFM" });
    expect(standingOf(rule, [DEFAULT_OVERTEMP])).toBeNull();
  });

  it("says nothing for a code with no default", () => {
    expect(standingOf(own({ code: "INV_TEMP_WARNING" }), [DEFAULT_OVERTEMP])).toBeNull();
  });
});

describe("a platform default against the Clients' rules", () => {
  it("names who replaced it, and where", () => {
    const rules = [
      DEFAULT_OVERTEMP,
      own({}),
      own({ id: 51, scope_type: "plant", scope_id: 2, scope_code: "SF_SOUTH" }),
      own({ id: 60, client_id: 2, client_code: "ROOFCO", scope_type: "client", scope_id: 2 }),
    ];
    // ROOFCO's rule is wider than the default, so it replaces nothing.
    expect(standingOf(DEFAULT_OVERTEMP, rules)?.text).toBe(
      "Replaced for SUNFIELD, SUNFIELD on plant SF_SOUTH. Those Devices do not use this default.",
    );
  });

  it("is silent when nobody has replaced it", () => {
    expect(standingOf(DEFAULT_OVERTEMP, [DEFAULT_OVERTEMP])).toBeNull();
  });
});

describe("scopeLabel", () => {
  it("falls back to the id when the target's code is not visible", () => {
    expect(scopeLabel(own({ scope_type: "plant", scope_id: 4, scope_code: null }))).toBe(
      "plant #4",
    );
  });
});
