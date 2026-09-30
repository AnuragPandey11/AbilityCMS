/**
 * System Health arranges the server's verdicts. What it must never do: show a
 * process that is up and failing as fine, or leave a problem off the banner.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PlatformHealthSchema, type PlatformHealth } from "@/api/schemas";
import { PlatformHealthView, agoText, problems, span } from "@/admin/SystemHealthAdmin";

const AS_OF = "2026-09-30T12:00:00+00:00";
const at = (secondsAgo: number) => new Date(Date.parse(AS_OF) - secondsAgo * 1000).toISOString();

const process = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  purpose: `${name} does its job.`,
  state: "working",
  tone: "ok",
  reason: "Working.",
  pid: 100,
  host: "mac",
  started_at: at(3600),
  beat_at: at(5),
  last_cycle_at: at(5),
  cycles: 700,
  last_write_at: at(5),
  last_write: "412 readings, 30 raw messages",
  last_error_at: null,
  last_error: null,
  errors: 0,
  recent_errors: 0,
  supervised: { pid: 100, state: "running", started_at: at(3600), restarts: 0, last_exit_code: null,
    last_exit_at: null, last_ran_for_s: null, next_start_at: null },
  ...over,
});

const body = (over: Partial<Record<string, unknown>> = {}) => ({
  as_of: AS_OF,
  overall: "ok",
  redis: { ok: true, error: null },
  processes: [
    process("api", { last_cycle_at: null, last_write_at: null, last_write: null }),
    process("ingest"),
    process("alarm"),
    process("health_sweeper"),
    process("scheduler"),
  ],
  broker: {
    state: "connected", tone: "ok", reason: "Connected to localhost:1883.", broker: "localhost:1883",
    topics: ["scms/v1/#", "SCMS/V1/#"], connected: true, connected_at: at(3600),
    last_message_at: at(3), messages: 12345, error: null,
  },
  supervisor: {
    state: "working", tone: "ok", reason: "Running; restarts any process that exits.",
    pid: 99, host: "mac", started_at: at(3600), beat_at: at(4), log_dir: "/tmp/logs",
  },
  ...over,
});

const parsed = (over: Partial<Record<string, unknown>> = {}): PlatformHealth =>
  PlatformHealthSchema.parse(body(over));

const view = (health: PlatformHealth) =>
  render(
    <MemoryRouter>
      <PlatformHealthView health={health} />
    </MemoryRouter>,
  );

describe("the verdicts", () => {
  it("shows nothing to fix when everything is working", () => {
    view(parsed());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("process-ingest").dataset.state).toBe("working");
    expect(screen.getByTestId("broker").textContent).toContain("scms/v1/#");
  });

  it("puts a process that is up but failing on the banner, worst first", () => {
    // The failure this page exists for: alive, looping, failing every time.
    const health = parsed({
      overall: "bad",
      processes: [
        process("api"),
        process("ingest"),
        process("alarm", { state: "degraded", tone: "warn", reason: "3 unit(s) failed recently." }),
        process("health_sweeper", {
          state: "failing", tone: "bad",
          reason: "Running, but its latest unit of work failed 20 s ago: permission denied",
          last_error_at: at(20), last_error: "InsufficientPrivilege: permission denied", errors: 57,
        }),
        process("scheduler"),
      ],
    });
    view(health);
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("2 problems");
    const items = [...banner.querySelectorAll("li")].map((li) => li.textContent ?? "");
    expect(items[0]).toContain("Device health sweep: Running, but its latest unit of work failed");
    expect(items[1]).toContain("Alarm checks");
    const card = screen.getByTestId("process-health_sweeper");
    expect(card.dataset.state).toBe("failing");
    expect(card.textContent).toContain("InsufficientPrivilege: permission denied");
  });

  it("says a process is unsupervised rather than showing zero restarts", () => {
    view(parsed({ processes: [process("scheduler", { supervised: null })] }));
    expect(screen.getByTestId("process-scheduler").textContent).toContain("not supervised");
  });

  it("names a broker that is connected but silent", () => {
    const health = parsed({
      overall: "warn",
      broker: { ...body().broker, state: "quiet", tone: "warn",
        reason: "Connected, but nothing has arrived for 12 min." },
    });
    expect(problems(health).map((p) => p.text)).toEqual([
      "Broker: Connected, but nothing has arrived for 12 min.",
    ]);
  });

  it("reports Redis being gone as the problem, since no heartbeat can be read", () => {
    const health = parsed({ overall: "bad", redis: { ok: false, error: "ConnectionError: refused" },
      processes: [], broker: null, supervisor: null });
    expect(problems(health)[0]?.text).toContain("Redis is unreachable");
  });

  it("reads an unknown state or tone as bad, never as fine", () => {
    const health = parsed({ processes: [process("ingest", { state: "exploded", tone: "purple" })] });
    expect(health.processes[0]?.tone).toBe("bad");
  });
});

describe("times", () => {
  it("counts back from the server's clock, and says 'ago' once", () => {
    expect(agoText(at(30), Date.parse(AS_OF))).toBe("30s ago");
    expect(agoText(at(12 * 60), Date.parse(AS_OF))).toBe("12m ago");
    expect(agoText(null, Date.parse(AS_OF))).toBe("never");
    expect(agoText(null, Date.parse(AS_OF), "none yet")).toBe("none yet");
  });

  it("gives a length of time without 'ago'", () => {
    expect(span(3.2)).toBe("3s");
    expect(span(125)).toBe("2m");
  });
});
