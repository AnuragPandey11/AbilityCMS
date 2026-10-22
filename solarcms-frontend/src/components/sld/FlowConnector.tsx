/**
 * The link between two stages of the schematic, drawn as power moving along it.
 *
 * Small lights travel the wire while `flow.moving`, faster and closer together
 * as `flow.share` rises; with nothing flowing it is a still, faint line — the
 * drawing stops completely, so a Plant at night costs nothing to show. Under
 * reduced motion nothing travels and the line's weight carries the amount.
 *
 * The colour is the caller's (`tone`, a text colour class): the health of the
 * stage the power leaves. A canvas cannot read a class, so the drawing takes
 * the computed `color` of its own element, again whenever the theme changes.
 *
 * Every connector on screen shares one animation frame, and one scrolled out of
 * view or in a hidden tab leaves it.
 */

import { useEffect, useRef } from "react";
import { useReducedMotion } from "framer-motion";
import { useTheme } from "@/theme/ThemeProvider";
import type { LinkFlow } from "./flow";

const WIDTH = 40;
const HEIGHT = 14;
const SPRITE = 32;

type Job = (seconds: number) => void;

/** One requestAnimationFrame for every moving connector, running only while one is. */
const ticker = (() => {
  const jobs = new Set<Job>();
  let frame = 0;
  let last = 0;
  const run = (now: number) => {
    const seconds = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    jobs.forEach((job) => job(seconds));
    frame = jobs.size > 0 ? requestAnimationFrame(run) : 0;
  };
  return {
    add(job: Job) {
      jobs.add(job);
      if (!frame) {
        last = performance.now();
        frame = requestAnimationFrame(run);
      }
    },
    remove(job: Job) {
      jobs.delete(job);
      if (jobs.size === 0 && frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    },
  };
})();

function parseRgb(color: string): [number, number, number] {
  const parts = color.match(/\d+(\.\d+)?/g)?.map(Number) ?? [];
  return parts.length >= 3 ? [parts[0]!, parts[1]!, parts[2]!] : [100, 116, 139];
}

/** A soft dot of light in the link's colour; white-hot at the core on a dark page. */
function makeSprite([r, g, b]: [number, number, number], dark: boolean): HTMLCanvasElement {
  const sprite = document.createElement("canvas");
  sprite.width = SPRITE;
  sprite.height = SPRITE;
  const context = sprite.getContext("2d");
  if (!context) return sprite;
  const half = SPRITE / 2;
  const core = dark ? [r, g, b].map((v) => Math.round(v + (255 - v) * 0.55)) : [r, g, b];
  const gradient = context.createRadialGradient(half, half, 0, half, half, half);
  gradient.addColorStop(0, `rgba(${core[0]},${core[1]},${core[2]},1)`);
  gradient.addColorStop(0.2, `rgba(${r},${g},${b},0.95)`);
  gradient.addColorStop(0.42, `rgba(${r},${g},${b},${dark ? 0.32 : 0.2})`);
  gradient.addColorStop(1, `rgba(${r},${g},${b},0)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, SPRITE, SPRITE);
  return sprite;
}

export function FlowConnector({
  tone,
  flow,
  title,
}: {
  tone: string;
  flow: LinkFlow;
  title: string;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduce = useReducedMotion() ?? false;
  const { resolved } = useTheme();
  // Read by the running drawing, so a new figure every refresh changes the
  // pace without restarting it — the lights already on the wire keep going.
  const shareRef = useRef(flow.share ?? 0.5);
  shareRef.current = flow.share ?? 0.5;
  const repaintRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    // No 2D canvas (under test): the link is simply not drawn.
    if (!canvas || typeof CanvasRenderingContext2D === "undefined") return undefined;
    const context = canvas.getContext("2d");
    if (!context) return undefined;

    const [r, g, b] = parseRgb(getComputedStyle(canvas).color);
    const rgba = (alpha: number) => `rgba(${r},${g},${b},${alpha})`;
    const dark = resolved === "dark";
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = WIDTH * ratio;
    canvas.height = HEIGHT * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    const animate = flow.moving && !reduce;
    const sprite = animate ? makeSprite([r, g, b], dark) : null;
    const y = HEIGHT / 2;
    const x0 = 1.5;
    const x1 = WIDTH - 2.5;
    const travel = x1 - x0 - 6;
    let lights: { x: number; pace: number }[] = [];
    let owed = 0;
    let share = shareRef.current;

    const paint = () => {
      context.clearRect(0, 0, WIDTH, HEIGHT);
      context.lineCap = "round";
      context.lineJoin = "round";

      context.beginPath();
      context.moveTo(x0, y);
      context.lineTo(x1 - 1, y);
      if (flow.moving && reduce) {
        context.strokeStyle = rgba(0.9);
        context.lineWidth = 1.6 + 2.4 * shareRef.current;
      } else {
        context.strokeStyle = rgba(flow.moving ? 0.3 : 0.35);
        context.lineWidth = 1.6;
      }
      context.stroke();

      if (sprite && lights.length > 0) {
        context.globalCompositeOperation = dark ? "lighter" : "source-over";
        const size = 7 + 6 * share;
        for (const light of lights) {
          const along = light.x / travel;
          context.globalAlpha = Math.max(0, Math.min(1, along / 0.15, (1 - along) / 0.2));
          context.drawImage(sprite, x0 + light.x - size / 2, y - size / 2, size, size);
        }
        context.globalAlpha = 1;
        context.globalCompositeOperation = "source-over";
      }

      context.beginPath();
      context.moveTo(x1 - 5, y - 3.6);
      context.lineTo(x1, y);
      context.lineTo(x1 - 5, y + 3.6);
      context.strokeStyle = rgba(flow.moving ? 0.95 : 0.4);
      context.lineWidth = 1.6;
      context.stroke();
    };
    repaintRef.current = paint;
    paint();
    if (!animate) return () => {
      repaintRef.current = null;
    };

    const step: Job = (seconds) => {
      // Eased toward the latest figure, so a refresh changes pace smoothly.
      share += (shareRef.current - share) * (1 - Math.exp(-seconds * 3));
      owed += seconds * (1 + 6 * share);
      while (owed >= 1) {
        owed -= 1;
        lights.push({ x: 0, pace: 0.85 + Math.random() * 0.3 });
      }
      const speed = 16 + 44 * share;
      for (const light of lights) light.x += speed * light.pace * seconds;
      lights = lights.filter((light) => light.x < travel);
      paint();
    };

    let inView = true;
    const sync = () => {
      if (inView && !document.hidden) ticker.add(step);
      else ticker.remove(step);
    };
    const observer =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver((entries) => {
            inView = entries.some((entry) => entry.isIntersecting);
            sync();
          })
        : null;
    observer?.observe(canvas);
    document.addEventListener("visibilitychange", sync);
    sync();

    return () => {
      ticker.remove(step);
      observer?.disconnect();
      document.removeEventListener("visibilitychange", sync);
      repaintRef.current = null;
    };
  }, [flow.moving, tone, resolved, reduce]);

  // Still drawings show the amount in the line's weight; redraw when it changes.
  useEffect(() => {
    if (reduce || !flow.moving) repaintRef.current?.();
  }, [flow.share, flow.moving, reduce]);

  return (
    <div
      className={`flex shrink-0 items-center justify-center self-center ${tone}`}
      title={title}
      aria-hidden
    >
      <canvas ref={canvasRef} style={{ width: WIDTH, height: HEIGHT }} />
    </div>
  );
}
