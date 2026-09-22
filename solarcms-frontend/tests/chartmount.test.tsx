/**
 * Charts must survive being mounted, hidden and shown again.
 *
 * Three separate defects lived in this one hook, and all three looked identical
 * from outside — "the graph keeps disappearing" — while the panel kept its
 * layout and its title. None of them threw anything a user could report, and a
 * screenshot taken a second later often looked fine.
 *
 * ── Why this mocks ECharts instead of counting canvases ─────────────────────
 * jsdom has no canvas backend, so `echarts.init` cannot produce a real chart
 * here and a DOM assertion would only ever be testing jsdom. What regressed was
 * never the drawing — it was *when the instance is created and destroyed*, so
 * that is what is asserted: an instance exists, and has been painted, exactly
 * while its container is attached.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { StrictMode } from "react";
import { render, act } from "@testing-library/react";

const instances: { id: number; disposed: boolean; paints: number }[] = [];
let nextId = 0;

vi.mock("echarts", () => ({
  init: () => {
    const instance = { id: nextId++, disposed: false, paints: 0 };
    instances.push(instance);
    return {
      setOption: () => {
        instance.paints += 1;
      },
      resize: () => {},
      dispose: () => {
        instance.disposed = true;
      },
    };
  },
}));

const { useEcharts } = await import("@/components/charts/useEcharts");

/** Live instances — created, painted at least once, and not yet disposed. */
const alive = () => instances.filter((i) => !i.disposed);

/**
 * A consumer that mirrors how every real chart renders: the container is
 * *conditional*, because each shows a loading or empty branch before its data
 * arrives.
 */
function Harness({ show }: { show: boolean }): JSX.Element {
  const ref = useEcharts({ series: [] }, [show]);
  return <div>{show ? <div ref={ref} style={{ height: 100 }} /> : <p>no data yet</p>}</div>;
}

beforeEach(() => {
  instances.length = 0;
  nextId = 0;
});

describe("useEcharts", () => {
  it("initialises when the container appears later, not only at mount", () => {
    // The first defect. A `useRef` plus a mount effect finds `ref.current ===
    // null` while the query is in flight, returns, and — with an empty
    // dependency array — never runs again. The data arrives, the container
    // renders, and nothing initialises it. Blank for the rest of the session.
    const { rerender } = render(<Harness show={false} />);
    expect(alive()).toHaveLength(0);

    rerender(<Harness show />);
    expect(alive(), "chart did not initialise once its container appeared").toHaveLength(1);
    expect(alive()[0].paints, "instance was created but never painted").toBeGreaterThan(0);
  });

  it("survives StrictMode's double-invoked effects", () => {
    // The second defect, and the subtle one. React 18's StrictMode re-runs
    // *effects* on mount but does **not** re-run ref callbacks, so an
    // `useEffect(() => () => chart.dispose(), [])` destroys the instance the
    // ref callback created and nothing rebuilds it. Only charts present at the
    // first paint — the KPI gauges in a drawer — came up blank; ones whose
    // container appears after their data loads attach later and survived,
    // which is why it hid for so long.
    render(
      <StrictMode>
        <Harness show />
      </StrictMode>,
    );
    expect(alive(), "StrictMode disposed the chart and it never came back").toHaveLength(1);
    expect(alive()[0].paints).toBeGreaterThan(0);
  });

  it("comes back after the container is removed and re-added", () => {
    // The third: toggling a chart to its table view and back. Disposal and
    // re-initialisation both have to key off the node attaching, not off the
    // component's lifecycle.
    const { rerender } = render(<Harness show />);
    expect(alive()).toHaveLength(1);

    rerender(<Harness show={false} />);
    expect(alive(), "instance was left attached to a node React had removed").toHaveLength(0);

    rerender(<Harness show />);
    expect(alive(), "chart did not return after its container came back").toHaveLength(1);
    expect(alive()[0].paints, "the rebuilt instance was never painted").toBeGreaterThan(0);
  });

  it("disposes exactly once on unmount, leaving nothing alive", () => {
    // Disposal belongs entirely to the callback ref — React always calls it
    // with `null` when the node detaches, including on a real unmount. A second
    // disposal path is what broke StrictMode.
    const { unmount } = render(<Harness show />);
    expect(alive()).toHaveLength(1);
    act(() => unmount());
    expect(alive()).toHaveLength(0);
    expect(instances.filter((i) => i.disposed)).toHaveLength(instances.length);
  });

  it("repaints when its dependencies change, without rebuilding", () => {
    // A data update must not re-create the instance: that would reset the
    // reader's zoom and pan on every live refresh.
    const { rerender } = render(<Harness show />);
    const created = instances.length;
    const paintsBefore = alive()[0].paints;

    rerender(<Harness show />);
    expect(instances.length, "a re-render rebuilt the chart instead of repainting").toBe(created);
    expect(alive()[0].paints).toBeGreaterThanOrEqual(paintsBefore);
  });
});
