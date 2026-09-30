/**
 * The Performance tiles in the single-Plant headline strip.
 *
 * They sit in the first row of the page, beside a live figure, so they are
 * seen by everybody and read at the size of a measurement. The ways they can
 * state something false are pinned here: three "not defined" figures standing
 * in for a request that failed, a CUF arc coloured by thresholds it can never
 * reach, a derived figure that does not say its period, an impossible ratio
 * drawn as an arc, and a comparison drawn against something that cannot be
 * compared.
 *
 * The dials and the meter are plain SVG, so what is asserted is the drawing
 * itself: which classes the arc carries, what the labels say.
 */

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PlantKpisSchema, type KpiComparison, type KpiFigure, type PlantKpis } from "@/api/schemas";
import { partialCoverage, pointsChange, ratioTone } from "@/components/charts/RatioDial";
import {
  PerformanceDetailsButton,
  PerformancePanel,
  PerformanceTiles,
} from "@/dashboards/single-plant/PerformancePanel";

const figure = (value: number | null, variant = "provisional"): KpiFigure => ({
  value,
  variant,
  undefined_reason: value === null ? "no irradiation in period" : null,
});

const coverage = (ratio: number, complete = false) => ({
  ratio,
  complete,
  expected_samples: 415008,
  received_samples: Math.round(415008 * ratio),
  missing_seconds: 74520,
  excluded_seconds: 0,
});

const previous = (pr: number | null, cuf: number | null, ratio = 1): KpiComparison => ({
  period_start: "2026-09-27T18:30:00Z",
  period_end: "2026-09-28T04:30:00Z",
  measured_since: "2026-09-27T18:30:00Z",
  source_tier: "agg_1m",
  performance_ratio: figure(pr, "poa_uncorrected"),
  cuf: figure(cuf, "ac_capacity_calendar_hours"),
  coverage: coverage(ratio, ratio >= 1),
});

const kpis: PlantKpis = {
  plant_id: 1,
  period: "today",
  energy_kwh: 3268,
  performance_ratio: figure(0.788, "poa_uncorrected"),
  cuf: figure(0.028, "ac_capacity_calendar_hours"),
  availability: figure(1, "time_based_excluding_comms"),
  co2_avoided_kg: figure(2679),
  coverage: coverage(0.139),
  source_tier: "agg_1m",
  previous: previous(0.75, 0.031),
  assumptions_note: "All KPI formulas are provisional pending OPEN-16.",
};

const band = (props: Partial<Parameters<typeof PerformanceTiles>[0]> = {}) =>
  render(
    <PerformanceTiles
      kpis={kpis}
      period="today"
      isLoading={false}
      error={null}
      retry={() => {}}
      timeZone="Asia/Kolkata"
      {...props}
    />,
  );

/** One dial or meter, by the figure it names. */
const drawing = (label: string) => screen.getByRole("img", { name: new RegExp(`^${label} `) });

describe("Performance tiles", () => {
  it("shows the three figures without a click", () => {
    band();
    expect(screen.getByText("Performance Ratio")).toBeInTheDocument();
    expect(screen.getByText("CUF")).toBeInTheDocument();
    expect(screen.getByText("Availability")).toBeInTheDocument();
    expect(drawing("Performance Ratio")).toBeInTheDocument();
    expect(drawing("CUF")).toBeInTheDocument();
    expect(drawing("Availability")).toBeInTheDocument();
  });

  it("says in words what each figure is measured against", () => {
    band();
    expect(screen.getByText(/plane-of-array irradiance, not temperature-corrected/)).toBeInTheDocument();
    expect(screen.getByText(/AC capacity, every hour since midnight/)).toBeInTheDocument();
    expect(screen.getByText(/time-weighted; comms loss not counted as downtime/)).toBeInTheDocument();
    // The code itself stays on the tooltip, never in the footnote.
    expect(screen.queryByText(/poa uncorrected/)).not.toBeInTheDocument();
  });

  it("counts a young Plant's CUF hours from its first reading", () => {
    band({
      kpis: {
        ...kpis,
        period: "month",
        period_start: "2026-08-31T18:30:00Z",
        measured_since: "2026-09-21T16:26:00Z",
      },
      period: "month",
    });
    expect(screen.getByText(/AC capacity, every hour since the first reading/)).toBeInTheDocument();
  });

  it("keeps the figures' coverage on the button into their detail", () => {
    let opened = 0;
    render(
      <PerformanceDetailsButton kpis={kpis} period="today" onOpen={() => (opened += 1)} />,
    );
    // 13.9% of the day's samples: shown in the same row as the figures, never
    // only behind the click (Guardrail 18).
    expect(screen.getByText("14% coverage")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Performance details/ }));
    expect(opened).toBe(1);
  });

  it("names the period on every tile, beside a figure that is live", () => {
    band({ period: "month", kpis: { ...kpis, previous: null } });
    expect(screen.getAllByText("This month")).toHaveLength(3);
  });

  it("reports a failed request as an error, never as undefined figures", () => {
    band({ kpis: undefined, error: new Error("network down") });
    expect(screen.getByText("network down")).toBeInTheDocument();
    expect(screen.queryByText(/not defined/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("draws nothing while loading", () => {
    band({ kpis: undefined, isLoading: true });
    expect(screen.queryByText("CUF")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("colours CUF with the chart colour, never by the 80/60 bands PR uses", () => {
    band();
    // PR at 78.8% is below 80: amber, and a pill says so in words.
    expect(drawing("Performance Ratio").querySelector("path.stroke-warn.dial-glow-warn")).not.toBeNull();
    // CUF at 2.8% would be deep red if it were banded. It is not.
    expect(drawing("CUF").querySelector("path.stroke-chart.dial-glow-chart")).not.toBeNull();
    expect(drawing("CUF").querySelector(".stroke-bad.dial-glow-bad")).toBeNull();
    expect(screen.getAllByText("Below 80%")).toHaveLength(1);
  });

  it("draws good news in the chart colour, not green", () => {
    band({ kpis: { ...kpis, performance_ratio: figure(0.852, "poa_uncorrected") } });
    const pr = drawing("Performance Ratio");
    expect(pr.querySelector("path.dial-glow-chart")).not.toBeNull();
    expect(pr.querySelector(".stroke-ok")).toBeNull();
    expect(screen.queryByText(/^Below/)).not.toBeInTheDocument();
  });
});

describe("The comparison with the previous period", () => {
  it("marks yesterday to the same time and states the change in points", () => {
    band();
    expect(drawing("Performance Ratio")).toHaveAccessibleName(
      "Performance Ratio 78.8%; Yesterday, same time 75.0%",
    );
    expect(screen.getByText("+3.8 pts")).toBeInTheDocument();
    expect(screen.getByText("−0.3 pts")).toBeInTheDocument();
    expect(screen.getAllByText("Yesterday, same time")).toHaveLength(2);
    expect(screen.getByText("75.0%")).toBeInTheDocument();
  });

  it("says when yesterday's figure rests on partial coverage", () => {
    band({ kpis: { ...kpis, previous: previous(0.75, 0.031, 0.092) } });
    // Guardrail 18 for the comparison: a hole yesterday moves the delta.
    expect(screen.getAllByText("at 9.2% coverage")).toHaveLength(2);
  });

  it("says so, rather than vanishing, when the Plant had not reported by then", () => {
    band({ kpis: { ...kpis, previous: null } });
    expect(screen.getAllByText("Yesterday, same time")).toHaveLength(2);
    expect(screen.queryByText(/pts$/)).not.toBeInTheDocument();
    expect(drawing("Performance Ratio")).toHaveAccessibleName("Performance Ratio 78.8%");
  });

  it("has nothing to compare a lifetime with", () => {
    band({ period: "lifetime", kpis: { ...kpis, period: "lifetime", previous: null } });
    expect(screen.queryByText(/Yesterday|Last month|Last year/)).not.toBeInTheDocument();
  });

  it("names the right previous period for a month", () => {
    band({ period: "month", kpis: { ...kpis, period: "month" } });
    expect(screen.getAllByText("Last month, same date")).toHaveLength(2);
  });

  it("draws no change against a figure that was never defined", () => {
    band({ kpis: { ...kpis, previous: previous(null, 0.031) } });
    expect(drawing("Performance Ratio")).not.toHaveTextContent(/pts/);
    expect(drawing("Performance Ratio")).toHaveAccessibleName("Performance Ratio 78.8%");
    // CUF still compares: its previous figure is defined.
    expect(screen.getByText("−0.3 pts")).toBeInTheDocument();
  });
});

describe("Figures a dial must not draw as an arc", () => {
  it("draws undefined as a dash over a dashed track, never as 0%", () => {
    band({ kpis: { ...kpis, performance_ratio: figure(null, "poa_uncorrected") } });
    const pr = drawing("Performance Ratio");
    expect(pr).toHaveAccessibleName("Performance Ratio not defined");
    expect(pr.querySelector("path[stroke-dasharray]")).not.toBeNull();
    expect(pr.querySelector("circle")).toBeNull();
    expect(screen.getByText("No irradiation in period.")).toBeInTheDocument();
  });

  it("shows an impossible ratio unaltered and flagged, with no arc and no change", () => {
    band({ kpis: { ...kpis, performance_ratio: figure(3.892, "poa_uncorrected") } });
    const pr = drawing("Performance Ratio");
    // The figure stays on screen as measured (Guardrail 33)…
    expect(pr).toHaveTextContent("389.2%");
    // …but nothing is drawn as though it were a reading.
    expect(pr.querySelector("circle")).toBeNull();
    expect(pr.querySelector(".dial-glow-chart, .dial-glow-warn, .dial-glow-bad")).toBeNull();
    expect(screen.queryByText("+313.9 pts")).not.toBeInTheDocument();
    expect(screen.getAllByText(/Outside 0–100%/)).toHaveLength(1);
  });

  it("gives Availability a figure over a meter, flagged the same way", () => {
    band({ kpis: { ...kpis, availability: figure(0.574, "time_based_excluding_comms") } });
    const meter = drawing("Availability");
    expect(meter.querySelector("rect.fill-bad:not([fill-opacity])")).not.toBeNull();
    expect(screen.getByText("Below 60%")).toBeInTheDocument();
  });
});

describe("Ratio helpers", () => {
  it("bands only where asked, and only for news", () => {
    expect(ratioTone(0.85, true)).toBe("chart");
    expect(ratioTone(0.7, true)).toBe("warn");
    expect(ratioTone(0.5, true)).toBe("bad");
    expect(ratioTone(0.02, false)).toBe("chart");
  });

  it("states a change in points with a true minus sign", () => {
    expect(pointsChange(0.852, 0.831)).toBe("+2.1 pts");
    expect(pointsChange(0.974, 0.999)).toBe("−2.5 pts");
    expect(pointsChange(0.8, 0.80001)).toBe("no change");
  });

  it("mentions coverage only when it fell short", () => {
    expect(partialCoverage(coverage(1, true))).toBeNull();
    expect(partialCoverage(coverage(0.985))).toBeNull();
    expect(partialCoverage(coverage(0.62))).toBe("62% coverage");
    expect(partialCoverage(null)).toBeNull();
  });

  it("parses a response from an API that predates the comparison", () => {
    const older: Record<string, unknown> = { ...kpis };
    delete older.previous;
    expect(PlantKpisSchema.parse(older).previous).toBeUndefined();
    expect(PlantKpisSchema.parse({ ...older, previous: null }).previous).toBeNull();
  });
});

describe("The detail drawer", () => {
  it("leaves the dials out, and carries what they cannot say", () => {
    render(<PerformancePanel kpis={kpis} period="today" />);
    // The coverage bar is an image too; the dials and the meter are not here.
    expect(screen.queryByRole("img", { name: /^(Performance Ratio|CUF|Availability) / })).toBeNull();
    expect(screen.getByText(/Energy \(today\)/)).toBeInTheDocument();
    expect(screen.getByText("agg_1m")).toBeInTheDocument();
  });
});
