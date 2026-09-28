/**
 * The Plant search's matching rule: forgiving about how a code is typed,
 * strict about what a single letter means, and never widened by a near miss
 * when the query already matched something.
 */

import { describe, expect, it } from "vitest";
import { editDistance, matchRanges, rankMatches } from "@/state/searchMatch";

const byCode = (codes: string[], query: string) =>
  rankMatches(codes, (code) => [{ text: code }], query);

describe("editDistance", () => {
  it("counts an adjacent transposition as one slip", () => {
    expect(editDistance("norht", "north")).toBe(1);
    expect(editDistance("north", "north")).toBe(0);
    expect(editDistance("north", "south")).toBe(2);
  });
});

describe("rankMatches", () => {
  it("puts a prefix ahead of a match inside the text", () => {
    expect(byCode(["MIDNORTH", "NORTH_2"], "north")).toEqual(["NORTH_2", "MIDNORTH"]);
  });

  it("ignores separators, in the query and in the text", () => {
    expect(byCode(["SF_NORTH", "SF_SOUTH"], "sf-north")).toEqual(["SF_NORTH"]);
    expect(byCode(["SF_NORTH", "SF_SOUTH"], "sfnorth")).toEqual(["SF_NORTH"]);
    expect(byCode(["SF_NORTH", "SF_SOUTH"], "sf.so")).toEqual(["SF_SOUTH"]);
  });

  it("forgives a slip only when nothing matches as typed", () => {
    expect(byCode(["SF_NORTH", "SF_SOUTH"], "sf-norht")).toEqual(["SF_NORTH"]);
    // Half-typed, with a slip in it.
    expect(byCode(["SF_NORTH", "SF_SOUTH"], "norh")).toEqual(["SF_NORTH"]);
    // "planta1" matched PLANT_A1 as typed, so PLANT_A2 — one edit away — stays out.
    expect(byCode(["PLANT_A1", "PLANT_A2"], "planta1")).toEqual(["PLANT_A1"]);
  });

  it("never treats a digit as a slip", () => {
    expect(byCode(["INV_12", "INV_13"], "inv14")).toEqual([]);
  });

  it("does not guess from three letters", () => {
    expect(byCode(["SF_NORTH"], "nrt")).toEqual([]);
  });

  it("ranks a secondary field just below a primary one", () => {
    const items = [
      { code: "A", client: "Sunfield" },
      { code: "SUNNY", client: "Other" },
    ];
    const ranked = rankMatches(
      items,
      (item) => [{ text: item.code }, { text: item.client, secondary: true }],
      "sun",
    );
    expect(ranked.map((item) => item.code)).toEqual(["SUNNY", "A"]);
  });

  it("returns everything, in order, for an empty query", () => {
    expect(byCode(["B", "A"], "  ")).toEqual(["B", "A"]);
  });
});

describe("matchRanges", () => {
  it("spans the separators the query left out", () => {
    expect(matchRanges("SF_NORTH", "sf-no")).toEqual([[0, 5]]);
  });

  it("looks for a single letter only at a word's start", () => {
    expect(matchRanges("Sunfield North", "n")).toEqual([[9, 10]]);
  });

  it("highlights nothing for a near miss", () => {
    expect(matchRanges("SF_NORTH", "norht")).toEqual([]);
  });

  it("merges overlapping words", () => {
    expect(matchRanges("Warehouse Two", "ware house")).toEqual([[0, 9]]);
  });
});
