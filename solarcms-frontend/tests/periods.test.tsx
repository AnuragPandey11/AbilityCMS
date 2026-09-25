/**
 * The Period control and what it says about the span it chose.
 *
 * Periods are calendar periods in the Plant's zone (the backend's
 * `domain/periods`). The screen names where the one on show began, so "month"
 * reads as "since the 1st" rather than leaving it to the reader to guess
 * between that and the last thirty days.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlantKpis } from "@/api/schemas";
import { PeriodPicker } from "@/components/domain";
import { periodSince } from "@/dashboards/single-plant/PerformancePanel";
import { useSelection } from "@/state/selection";

const KOLKATA = "Asia/Kolkata";

function kpis(periodStart: string | null, measuredSince: string | null): PlantKpis {
  return { period_start: periodStart, measured_since: measuredSince } as PlantKpis;
}

describe("periodSince", () => {
  it("names today as since midnight", () => {
    const start = "2026-09-22T18:30:00Z";
    expect(periodSince(kpis(start, start), "today", KOLKATA)).toBe("since midnight");
  });

  it("names the 1st in the Plant's zone, not UTC's 31st", () => {
    const start = "2026-08-31T18:30:00Z";
    expect(periodSince(kpis(start, start), "month", KOLKATA)).toBe("since 01-09-2026");
  });

  it("says when a Plant younger than the period was first heard", () => {
    expect(
      periodSince(kpis("2026-08-31T18:30:00Z", "2026-09-21T16:26:00Z"), "month", KOLKATA),
    ).toBe("since 01-09-2026 (first reading 21-09-2026)");
  });

  it("dates a lifetime from its first reading", () => {
    const first = "2026-09-21T16:26:00Z";
    expect(periodSince(kpis(first, first), "lifetime", KOLKATA)).toBe(
      "since the first reading, 21-09-2026",
    );
  });

  it("says nothing when the server did not say where the period began", () => {
    expect(periodSince(kpis(null, null), "month", KOLKATA)).toBeNull();
    expect(periodSince(undefined, "month", KOLKATA)).toBeNull();
  });
});

describe("PeriodPicker", () => {
  it("announces which period is chosen", () => {
    const onChange = vi.fn();
    render(<PeriodPicker value="month" onChange={onChange} size="lg" />);
    const group = screen.getByRole("radiogroup", { name: "Period" });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "month" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "today" })).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("radio", { name: "year" }));
    expect(onChange).toHaveBeenCalledWith("year");
  });
});

describe("the chart window", () => {
  beforeEach(() => useSelection.getState().reset());

  it("is remembered beside the period, and reset with it", () => {
    useSelection.getState().setTrendRange("7d");
    useSelection.getState().setPeriod("month");
    expect(useSelection.getState()).toMatchObject({ trendRange: "7d", period: "month" });
    useSelection.getState().reset();
    expect(useSelection.getState()).toMatchObject({ trendRange: "today", period: "today" });
  });

  it("is one per chart panel: the Weather window never moves the Power trend's", () => {
    useSelection.getState().setWeatherRange("30d");
    expect(useSelection.getState()).toMatchObject({ weatherRange: "30d", trendRange: "today" });
    useSelection.getState().setTrendRange("7d");
    expect(useSelection.getState()).toMatchObject({ weatherRange: "30d", trendRange: "7d" });
    useSelection.getState().reset();
    expect(useSelection.getState()).toMatchObject({ weatherRange: "today", trendRange: "today" });
  });
});
