/**
 * The screen shown while signing in: digital rain, the logo, the step under
 * way and a bar that follows it (`auth/signInScreen.ts` says why it is driven
 * by the real steps and how long it stays).
 *
 * Mounted once at the root, beside the routes, because it has to survive the
 * login page being replaced by the dashboard. Renders nothing while idle.
 */

import { useEffect, useRef, useState } from "react";
import { BrandMark } from "@/components/layout/BrandMark";
import {
  SIGN_IN_FADE_MS,
  SIGN_IN_LABEL,
  grantedHoldMs,
  nextProgress,
  useSignInScreen,
} from "@/auth/signInScreen";
import "./SignInScreen.css";

const CYAN = "55, 214, 238";
const HEAD = "225, 251, 255";
const GLYPHS = "0101010110011001234567897";

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function SignInScreen(): JSX.Element | null {
  const phase = useSignInScreen((state) => state.phase);
  if (phase === "idle") return null;
  return <SignInScreenView />;
}

function SignInScreenView(): JSX.Element {
  const phase = useSignInScreen((state) => state.phase);
  const [progress, setProgress] = useState(0);
  const [still] = useState(prefersReducedMotion);

  // The bar: eased towards the current step's ceiling, frame by frame.
  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    let value = 0;
    const tick = (now: number) => {
      const { phase: current, fullAt } = useSignInScreen.getState();
      // Without motion, each step shows its ceiling at once.
      value = still
        ? nextProgress(value, current, 60_000, 0)
        : nextProgress(value, current, now - last, fullAt - Date.now());
      last = now;
      setProgress(value);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [still]);

  // Granted: hold long enough to be seen, then fade onto the application.
  useEffect(() => {
    if (phase !== "granted" || progress < 100) return;
    const { startedAt, close } = useSignInScreen.getState();
    const timer = window.setTimeout(close, grantedHoldMs(startedAt, Date.now()));
    return () => window.clearTimeout(timer);
  }, [phase, progress]);

  useEffect(() => {
    if (phase !== "closing") return;
    const timer = window.setTimeout(
      () => useSignInScreen.getState().reset(),
      still ? 0 : SIGN_IN_FADE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [phase, still]);

  const label = phase === "idle" ? "" : SIGN_IN_LABEL[phase];
  const done = phase === "granted" || phase === "closing";
  const percent = Math.floor(progress);

  return (
    <div className="signin-screen" data-closing={phase === "closing"}>
      <DigitalRain still={still} />
      <FloorGrid />
      <div className="signin-vignette" />

      <div className="relative z-10 flex w-full flex-col items-center px-5">
        <BrandMark height={84} onNavy />

        <div className="mt-[clamp(2rem,6vh,3.5rem)] w-[min(720px,100%)]">
          <div className="signin-rule" />
          <p
            role="status"
            aria-live="polite"
            className="signin-status py-[clamp(0.7rem,2vh,1.1rem)] text-center text-[clamp(1.05rem,2.4vw,2.2rem)]"
          >
            <span className={done ? undefined : "signin-dots"}>{label}</span>
          </p>
          <div className="signin-rule" />
        </div>

        <div
          className="signin-bar mt-[clamp(1.5rem,4.5vh,2.5rem)] flex w-[min(720px,100%)] items-center gap-4 rounded-xl px-3 py-2.5 sm:px-4 sm:py-3"
          role="progressbar"
          aria-label="Signing in"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <Segments progress={progress} />
          <span className="signin-percent w-[4ch] shrink-0 text-right text-[clamp(1rem,1.9vw,1.6rem)]">
            {percent}%
          </span>
        </div>
      </div>
    </div>
  );
}

function Segments({ progress }: { progress: number }): JSX.Element {
  // Fewer, wider blocks on a phone, so each one stays a block.
  const [count] = useState(() => (window.innerWidth < 640 ? 20 : 34));
  const lit = Math.round((progress / 100) * count);
  return (
    <div className="flex h-[clamp(1.25rem,3.2vh,1.9rem)] min-w-0 flex-1 gap-[3px]" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <span key={index} className="signin-segment flex-1 rounded-[3px]" data-on={index < lit} />
      ))}
    </div>
  );
}

/** A receding grid, lit, along the bottom of the screen. */
function FloorGrid(): JSX.Element {
  const vertical = Array.from({ length: 41 }, (_, i) => i - 20);
  const horizontal = Array.from({ length: 9 }, (_, i) => 300 * ((i + 1) / 9) ** 2);
  return (
    <svg
      className="signin-floor"
      viewBox="0 0 1600 300"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <g stroke={`rgb(${CYAN})`} strokeOpacity="0.32" strokeWidth="1" fill="none">
        {vertical.map((i) => (
          <line
            key={`v${i}`}
            x1={800 + i * 34}
            y1="0"
            x2={800 + i * 300}
            y2="300"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {horizontal.map((y) => (
          <line key={`h${y}`} x1="0" y1={y} x2="1600" y2={y} vectorEffect="non-scaling-stroke" />
        ))}
      </g>
      <line
        x1="0"
        y1="1"
        x2="1600"
        y2="1"
        stroke={`rgb(${CYAN})`}
        strokeOpacity="0.55"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

interface Drop {
  x: number;
  y: number;
  speed: number;
  size: number;
  alpha: number;
  row: number;
  glyph: string;
  glow: boolean;
}

// Three depths, far to near: smaller, dimmer and slower further away.
const LAYERS = [
  { size: 11, alpha: 0.4, speed: [1, 2.2], gap: 1.35, glow: false },
  { size: 15, alpha: 0.7, speed: [1.6, 3.2], gap: 1.7, glow: true },
  { size: 21, alpha: 1, speed: [2.4, 4.4], gap: 2.6, glow: true },
] as const;

function glyph(): string {
  return GLYPHS[Math.floor(Math.random() * GLYPHS.length)] ?? "0";
}

function makeDrops(width: number, height: number): Drop[] {
  const drops: Drop[] = [];
  for (const layer of LAYERS) {
    const step = layer.size * layer.gap;
    for (let x = Math.random() * step; x < width; x += step * (0.7 + Math.random() * 0.6)) {
      drops.push({
        x,
        y: Math.random() * height * 1.2 - height * 0.2,
        speed: layer.speed[0] + Math.random() * (layer.speed[1] - layer.speed[0]),
        size: layer.size,
        alpha: layer.alpha,
        row: -1,
        glyph: glyph(),
        glow: layer.glow,
      });
    }
  }
  return drops;
}

/**
 * Falling columns of digits on a canvas. Each frame fades what is there a
 * little (to transparent, so the page's gradient shows through) and draws each
 * column's new head bright, re-drawing the one it left in the trail colour.
 */
function DigitalRain({ still }: { still: boolean }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const ctx: CanvasRenderingContext2D = context;

    let width = 0;
    let height = 0;
    let drops: Drop[] = [];
    let frame = 0;
    let last = performance.now();

    const step = (dt: number) => {
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = `rgba(0, 0, 0, ${Math.min(0.5, 0.04 * dt)})`;
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = "source-over";

      for (const drop of drops) {
        drop.y += drop.speed * dt;
        const row = Math.floor(drop.y / drop.size);
        if (row === drop.row) continue;
        ctx.font = `${drop.size}px ui-monospace, "SF Mono", Menlo, monospace`;
        if (drop.row >= 0) {
          ctx.shadowColor = `rgba(${CYAN}, 0.8)`;
          ctx.shadowBlur = drop.glow ? drop.size * 0.45 : 0;
          ctx.fillStyle = `rgba(${CYAN}, ${drop.alpha})`;
          ctx.fillText(drop.glyph, drop.x, drop.row * drop.size);
        }
        drop.row = row;
        drop.glyph = glyph();
        ctx.fillStyle = `rgba(${HEAD}, ${drop.alpha})`;
        ctx.shadowColor = `rgba(${CYAN}, 0.9)`;
        ctx.shadowBlur = drop.glow ? drop.size * 0.8 : 0;
        ctx.fillText(drop.glyph, drop.x, row * drop.size);
        if (drop.y > height + drop.size * 6) {
          drop.y = -Math.random() * height * 0.4;
          drop.row = -1;
        }
      }
      ctx.shadowBlur = 0;
    };

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      drops = makeDrops(width, height);
      // Run the rain for a moment before the first paint, so the screen opens
      // full rather than empty.
      for (let i = 0; i < 160; i += 1) step(1);
    };

    resize();
    if (!still) {
      const tick = (now: number) => {
        // In 60 fps frames, so speeds read as pixels per frame.
        step(Math.min((now - last) / 16.7, 3));
        last = now;
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    }
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  }, [still]);

  return <canvas ref={ref} className="signin-rain" aria-hidden="true" />;
}
