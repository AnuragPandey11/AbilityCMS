/**
 * The sign-in screen's moving ground: rows of solar modules under a navy sky,
 * with sunlight sweeping slowly across them.
 *
 * ── Why here and nowhere else ───────────────────────────────────────────────
 * Sign-in is the one screen with no data on it, so motion there cannot be
 * mistaken for a reading. Everywhere else on this platform movement has to be
 * caused by a figure changing or by the reader's pointer; a background that
 * drifted behind a dashboard would assert change nobody measured, and would
 * cost the GPU for as long as a control-room screen stays open.
 *
 * Chosen by the user on 21 Oct 2026 from rendered options ("Flowing light" or
 * "Solar field", on navy or following the theme): Solar field, on navy — the
 * brand as a surface, as the sidebar is, in both themes.
 *
 * ── What it costs, and when it stops ────────────────────────────────────────
 * One full-screen fragment shader in plain WebGL, no library. At most 30 frames
 * a second and about two million pixels whatever the display; nothing drawn
 * while the tab is hidden; one still frame when the system asks for reduced
 * motion. Where WebGL is missing, or its context is lost, the canvas stays
 * transparent and the navy gradient the page paints behind it is the whole
 * background — which is also what shows for the moment before the first frame.
 *
 * ── Colours ─────────────────────────────────────────────────────────────────
 * Fixed, like the equipment drawings' materials (`components/devices/art/`):
 * they are the drawing's own sky and panels, on a ground that is navy in both
 * themes, so nothing here should follow the theme. Sampled from the logo —
 * navy #21263B, deep navy #0F1D38, teal #397E92, cyan #62BCC8.
 */

import { useCallback, useRef } from "react";

const PALETTE = {
  skyLow: "#2B3756", // haze at the horizon
  skyHigh: "#0F1D38", // deep navy overhead
  haze: "#397E92", // teal
  sun: "#62BCC8", // cyan
  panel: "#17284A",
  gap: "#0A1226",
  glint: "#CDEEF3",
  glow: 0.6,
};

const MAX_FPS = 30;
const MAX_PIXEL_RATIO = 1.5;
const MAX_PIXELS = 2_000_000;
/** The frame shown under reduced motion: the glint is mid-field. */
const STILL_AT_S = 19;

const VERTEX = "attribute vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }";

const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uSkyLo;
uniform vec3 uSkyHi;
uniform vec3 uA;
uniform vec3 uB;
uniform float uGlow;
uniform vec3 uPanel;
uniform vec3 uGap;
uniform vec3 uGlint;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = m * p;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / uRes.y;
  float h = 0.5;
  vec2 sun = vec2(0.24 + 0.04 * sin(uTime * 0.03), 0.84);
  vec3 col;
  if (uv.y >= h) {
    // Sky: deep navy overhead, haze at the horizon, a soft sun and drifting cloud.
    float sy = (uv.y - h) / (1.0 - h);
    col = mix(uSkyLo, uSkyHi, pow(sy, 0.7));
    vec2 d = (uv - sun) * vec2(aspect, 1.0);
    col = mix(col, uB, uGlow * exp(-dot(d, d) * 5.0));
    float haze = fbm(vec2(uv.x * aspect * 1.2 + uTime * 0.012, uv.y * 2.5));
    col = mix(col, uA, uGlow * 0.35 * haze * (1.0 - 0.6 * sy));
  } else {
    // Ground: rows of modules in perspective. Edges are anti-aliased by their
    // own on-screen width, worked out analytically, and fade into haze before
    // they are fine enough to shimmer.
    float dy = h - uv.y;
    float z = 0.09 / dy;
    float x = (uv.x - 0.5) * aspect * z;
    float rowK = 9.0;
    float rv = z * rowK;
    float drv = rowK * 0.09 / (dy * dy) / uRes.y;
    float rf = fract(rv);
    float fill = 0.58;
    float e = max(drv, 0.0001);
    float cover = clamp(rf / e, 0.0, 1.0) * clamp((fill - rf) / e, 0.0, 1.0);
    cover = mix(cover, fill, smoothstep(0.25, 1.0, drv));
    float colK = 22.0;
    float cv = x * colK;
    float dcv = colK * z / uRes.y;
    float dc = abs(fract(cv + 0.5) - 0.5);
    float lw = 0.04;
    float frameLine = 1.0 - smoothstep(lw, lw + dcv * 1.2, dc);
    frameLine *= 1.0 - smoothstep(0.08, 0.35, dcv);
    float fres = 1.0 - dy / h;
    vec3 panel = mix(uPanel, uSkyLo, 0.35 * fres * fres);
    // A glint sweeps across the field, and the sun lays a path toward the viewer.
    float gx = mod(uTime * 0.05, 2.4) - 0.6;
    float gs = (uv.x - gx - dy * 0.9) * 5.0;
    float glint = exp(-gs * gs);
    float ss = (uv.x - sun.x) * aspect * 3.0;
    float sunPath = exp(-ss * ss) * fres;
    float lit = uGlow * (0.8 * glint * (0.35 + 0.65 * fres) + 0.45 * sunPath);
    panel = mix(panel, uGlint, clamp(lit, 0.0, 1.0));
    panel = mix(panel, uGap, 0.5 * frameLine);
    col = mix(uGap, panel, cover);
    col = mix(col, uSkyLo, exp(-dy * 18.0));
  }
  // Dither, so the long sky gradient does not band.
  col += (hash(gl_FragCoord.xy + fract(uTime)) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}`;

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function prefersReducedMotion(): MediaQueryList | null {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;
}

/**
 * Draws on `canvas` until the returned function is called. Returns a no-op
 * when WebGL is unavailable or the shader does not compile — the canvas then
 * stays transparent, which is the fallback.
 */
function start(canvas: HTMLCanvasElement): () => void {
  // No WebGL in this browser at all (or under test): the gradient is the ground.
  if (typeof WebGLRenderingContext === "undefined") return () => undefined;
  let gl: WebGLRenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
    });
  } catch {
    gl = null;
  }
  if (!gl) return () => undefined;

  const compile = (type: number, source: string): WebGLShader | null => {
    const shader = gl!.createShader(type);
    if (!shader) return null;
    gl!.shaderSource(shader, source);
    gl!.compileShader(shader);
    return gl!.getShaderParameter(shader, gl!.COMPILE_STATUS) ? shader : null;
  };
  const vertex = compile(gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) return () => undefined;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return () => undefined;
  gl.useProgram(program);

  // One triangle that covers the screen.
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "aPos");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const at = (name: string) => gl!.getUniformLocation(program, name);
  const uRes = at("uRes");
  const uTime = at("uTime");
  gl.uniform3fv(at("uSkyLo"), rgb(PALETTE.skyLow));
  gl.uniform3fv(at("uSkyHi"), rgb(PALETTE.skyHigh));
  gl.uniform3fv(at("uA"), rgb(PALETTE.haze));
  gl.uniform3fv(at("uB"), rgb(PALETTE.sun));
  gl.uniform1f(at("uGlow"), PALETTE.glow);
  gl.uniform3fv(at("uPanel"), rgb(PALETTE.panel));
  gl.uniform3fv(at("uGap"), rgb(PALETTE.gap));
  gl.uniform3fv(at("uGlint"), rgb(PALETTE.glint));

  const reduce = prefersReducedMotion();
  let lost = false;
  let frame = 0;
  let last = 0;
  let seconds = 6;

  const resize = () => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const ratio = Math.min(
      window.devicePixelRatio || 1,
      MAX_PIXEL_RATIO,
      Math.sqrt(MAX_PIXELS / Math.max(1, width * height)),
    );
    const w = Math.max(1, Math.round(width * ratio));
    const h = Math.max(1, Math.round(height * ratio));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl!.viewport(0, 0, w, h);
  };

  const draw = (time: number) => {
    if (lost) return;
    gl!.uniform2f(uRes, canvas.width, canvas.height);
    gl!.uniform1f(uTime, time);
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);
    canvas.style.opacity = "1";
  };

  const loop = (now: number) => {
    frame = requestAnimationFrame(loop);
    const elapsed = now - last;
    if (elapsed < 1000 / MAX_FPS - 2) return;
    last = now;
    // Capped, so a tab that comes back from the background resumes rather
    // than jumping the light across the field.
    seconds += Math.min(elapsed, 100) / 1000;
    draw(seconds);
  };

  const stop = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };

  const update = () => {
    if (lost) return;
    stop();
    resize();
    if (reduce?.matches) {
      draw(STILL_AT_S);
    } else if (document.hidden) {
      draw(seconds);
    } else {
      last = performance.now();
      draw(seconds);
      frame = requestAnimationFrame(loop);
    }
  };

  const onLost = (event: Event) => {
    event.preventDefault();
    lost = true;
    stop();
    canvas.style.opacity = "0";
  };

  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
  observer?.observe(canvas);
  document.addEventListener("visibilitychange", update);
  reduce?.addEventListener("change", update);
  canvas.addEventListener("webglcontextlost", onLost);
  update();

  return () => {
    stop();
    observer?.disconnect();
    document.removeEventListener("visibilitychange", update);
    reduce?.removeEventListener("change", update);
    canvas.removeEventListener("webglcontextlost", onLost);
  };
}

export function ShaderGround(): JSX.Element {
  const stopRef = useRef<(() => void) | null>(null);
  // A callback ref, so drawing is bound to the canvas attaching and detaching
  // rather than to a component lifecycle (Guardrail 31's reasoning, for a
  // drawing this file owns rather than a chart library).
  const attach = useCallback((canvas: HTMLCanvasElement | null) => {
    stopRef.current?.();
    stopRef.current = canvas ? start(canvas) : null;
  }, []);

  return (
    <canvas
      ref={attach}
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 h-full w-full opacity-0 transition-opacity duration-700"
    />
  );
}
