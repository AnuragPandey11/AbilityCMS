/**
 * A thin ECharts binding.
 *
 * ECharts rather than an SVG-per-point library because a day of 1-minute data
 * for eight Tags is ~11,500 points and the raw tier can return 20,000 (§1). The
 * chart owns its own DOM inside the ref; React never reaches into it.
 */

import { useEffect, useRef } from "react";
import * as echarts from "echarts";

export function useEcharts(
  option: echarts.EChartsOption,
  deps: unknown[] = [],
): React.RefObject<HTMLDivElement> {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    chartRef.current = echarts.init(containerRef.current, undefined, {
      renderer: "canvas",
    });
    const observer = new ResizeObserver(() => chartRef.current?.resize());
    observer.observe(containerRef.current);
    return () => {
      observer.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    // notMerge: a series removed from `option` must disappear rather than
    // linger from the previous render — stale series are how a chart ends up
    // showing a Tag the Device is no longer bound to.
    chartRef.current?.setOption(option, { notMerge: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return containerRef;
}

/**
 * The shared theme fragments moved to `@/theme/tokens` and became a *function*,
 * because a constant is evaluated once at module load and would freeze whichever
 * theme happened to be active then. Re-exported here so the chart modules keep
 * one import site.
 */
export { chartTheme } from "@/theme/tokens";
