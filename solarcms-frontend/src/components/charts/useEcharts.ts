/**
 * A thin ECharts binding.
 *
 * ECharts rather than an SVG-per-point library because a day of 1-minute data
 * for eight Tags is ~11,500 points and the raw tier can return 20,000 (§1). The
 * chart owns its own DOM inside the ref; React never reaches into it.
 *
 * ── Why this is a callback ref and not `useRef` ─────────────────────────────
 * The obvious binding is a `useRef` plus a mount effect that calls
 * `echarts.init(ref.current)`. It has a failure mode that is silent, permanent,
 * and looks exactly like a data problem:
 *
 *   1. The component mounts while its query is still in flight, so it renders a
 *      loading or empty branch and **the chart container is not in the DOM**.
 *   2. The mount effect runs, finds `ref.current === null`, and returns. With an
 *      empty dependency array it never runs again.
 *   3. The data arrives, the container renders — and nothing initialises it. The
 *      option effect calls `chart?.setOption(...)` on a null chart and quietly
 *      does nothing.
 *   4. The panel is blank for the rest of the session.
 *
 * The same thing happens every time a container is conditionally swapped out
 * and back: switching a chart to its table view and back, or toggling between
 * two charts in one panel, left a permanently empty frame. From outside it read
 * as "the graph keeps disappearing".
 *
 * A callback ref is called by React with the node **whenever it attaches or
 * detaches**, so initialisation is tied to the container actually existing
 * rather than to a moment in the component's lifecycle. Attaching initialises
 * and immediately paints the latest option; detaching disposes and disconnects
 * the observer, so nothing leaks and no instance is left pointing at a node
 * that has been removed from the document.
 *
 * ⚠ The option is kept in a ref as well as in the dependency effect. On
 * re-attach the effect does not necessarily re-run — its dependencies may be
 * unchanged — so the newly created instance has to be painted from the latest
 * option at attach time or it comes up blank.
 */

import { useCallback, useEffect, useRef } from "react";
import * as echarts from "echarts";

export function useEcharts(
  option: echarts.EChartsOption,
  deps: unknown[] = [],
): (node: HTMLDivElement | null) => void {
  const chartRef = useRef<echarts.ECharts | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  // Always the option from the most recent render, so an attach that happens
  // between dependency changes still paints the current data.
  const optionRef = useRef(option);
  optionRef.current = option;

  const setContainer = useCallback((node: HTMLDivElement | null) => {
    // Tear down whatever was attached before — React calls a changed callback
    // ref with `null` first, but a node can also be swapped in one commit.
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (chartRef.current) {
      chartRef.current.dispose();
      chartRef.current = null;
    }
    if (!node) return;

    const chart = echarts.init(node, undefined, { renderer: "canvas" });
    chartRef.current = chart;
    // notMerge: a series removed from `option` must disappear rather than
    // linger from the previous render — stale series are how a chart ends up
    // showing a Tag the Device is no longer bound to.
    chart.setOption(optionRef.current, { notMerge: true });

    // A container inside a flex or grid panel is frequently 0×0 on the frame it
    // first attaches. ECharts sizes to the node it was given, so without this
    // the chart would stay at zero until something else forced a resize.
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(node);
    observerRef.current = observer;
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(optionRef.current, { notMerge: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  /*
    ⚠ **There is deliberately no unmount effect disposing the chart**, and
    adding one back breaks every chart that is on screen at first paint.

    React 18's StrictMode double-invokes *effects* on mount — run, clean up,
    run again — but it does **not** re-run ref callbacks. An
    `useEffect(() => () => chart.dispose(), [])` therefore fires during that
    simulated remount, destroys the instance the ref callback created, and
    nothing ever calls the ref again to rebuild it. The panel keeps its layout
    and loses its canvas, permanently.

    It hid well: a chart whose container appears *after* its data arrives —
    most of them — attaches once StrictMode has finished, so it survived. Only
    the ones rendered on the first paint, like the KPI gauges in a drawer, came
    up blank.

    Cleanup belongs entirely to the callback ref. React always invokes it with
    `null` when the node detaches, including on a real unmount, so disposal and
    observer teardown happen exactly once and exactly when the node goes away.
  */

  return setContainer;
}

/**
 * The shared theme fragments moved to `@/theme/tokens` and became a *function*,
 * because a constant is evaluated once at module load and would freeze whichever
 * theme happened to be active then. Re-exported here so the chart modules keep
 * one import site.
 */
export { chartTheme } from "@/theme/tokens";
