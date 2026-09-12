/**
 * Error presentation (§8). Two rules that are easy to violate by being helpful:
 * a 500's detail stays opaque, and a 404 never claims a thing does not exist.
 */

import { describe, expect, it } from "vitest";
import { ApiError, fieldErrors, toProblem } from "@/api/problem";

const problem = (status: number, detail: string) =>
  new ApiError({ type: "about:blank", title: "x", status, detail });

describe("displayMessage", () => {
  it("never shows a 500's detail (Guardrail 7)", () => {
    const error = problem(500, "relation readings does not exist for role solarcms_api");
    expect(error.displayMessage).not.toContain("readings");
    expect(error.displayMessage).not.toContain("solarcms_api");
  });

  it("does not claim a 404 does not exist", () => {
    // RLS returned nothing; saying "does not exist" leaks whether it does.
    const error = problem(404, "plant not found");
    expect(error.displayMessage).toMatch(/not accessible/);
    expect(error.displayMessage).not.toMatch(/does not exist/);
  });

  it("shows a 409's detail verbatim — these are actionable", () => {
    const detail =
      "financial reports require an ABT Meter; none is registered. I-11 forbids computing them from an MFM.";
    expect(problem(409, detail).displayMessage).toBe(detail);
    expect(problem(409, detail).isConflict).toBe(true);
  });

  it("shows a 403's detail so the user learns which permission is missing", () => {
    const error = problem(403, "permission alarm.acknowledge required");
    expect(error.displayMessage).toContain("alarm.acknowledge");
    expect(error.isForbidden).toBe(true);
  });
});

describe("the readings point cap", () => {
  it("is distinguished from ordinary validation", () => {
    const capped = problem(
      422,
      "query would return roughly 84000 points, above the 20000 limit; narrow the range",
    );
    expect(capped.isPointCap).toBe(true);
    expect(problem(422, "`to` must follow `from`").isPointCap).toBe(false);
  });
});

describe("normalising non-problem bodies", () => {
  it("turns FastAPI's own validation body into the same shape", () => {
    const normalised = toProblem(422, { detail: [{ loc: ["body", "code"], msg: "required", type: "x" }] }, "/plants");
    expect(normalised.status).toBe(422);
    expect(normalised.type).toBe("about:blank");
  });

  it("survives a body that is not JSON at all", () => {
    const normalised = toProblem(502, null, "/plants");
    expect(normalised.status).toBe(502);
    expect(normalised.detail).toBe("request failed");
  });
});

describe("fieldErrors", () => {
  it("extracts per-field messages for inline display", () => {
    const error = problem(
      422,
      JSON.stringify([{ loc: ["body", "code"], msg: "field required", type: "missing" }]),
    );
    expect(fieldErrors(error)).toEqual({ code: "field required" });
  });

  it("returns nothing for a non-validation error", () => {
    expect(fieldErrors(problem(403, "nope"))).toEqual({});
  });
});
