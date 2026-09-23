/** @type {import('tailwindcss').Config} */

/**
 * Every colour resolves through a CSS custom property defined in `index.css`,
 * so a theme switch is a single attribute change on <html> rather than a class
 * swap on every element. The `rgb(var(--x) / <alpha-value>)` form is what keeps
 * the alpha modifiers (`bg-ok/10`, `border-accent/30`) working — Tailwind
 * substitutes the opacity into the slot.
 */
const token = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // Semantic only. No colour is named after a Client or a Plant (F-14).
        surface: {
          DEFAULT: token("surface"),
          raised: token("surface-raised"),
          sunken: token("surface-sunken"),
        },
        line: {
          DEFAULT: token("line"),
          soft: token("line-soft"),
          strong: token("line-strong"),
        },
        ink: {
          DEFAULT: token("ink"),
          muted: token("ink-muted"),
          faint: token("ink-faint"),
        },
        accent: {
          DEFAULT: token("accent"),
          strong: token("accent-strong"),
          soft: token("accent-soft"),
        },
        // Text on an accent fill: white in light, navy in dark, where the
        // accent is light enough that white on it would be 2.2:1.
        "on-accent": token("on-accent"),
        // The sidebar's own palette — navy in both themes (see `index.css`).
        nav: {
          DEFAULT: token("nav"),
          deep: token("nav-deep"),
          ink: token("nav-ink"),
          muted: token("nav-muted"),
          faint: token("nav-faint"),
          line: token("nav-line"),
          accent: token("nav-accent"),
        },
        ok: token("ok"),
        warn: token("warn"),
        bad: token("bad"),
        info: token("info"),
        // Quality codes 0..3 (§4.2). Bad quality must never look like data.
        q0: token("q0"),
        q1: token("q1"),
        q2: token("q2"),
        q3: token("q3"),
      },
      boxShadow: {
        card: "var(--shadow-card)",
        soft: "var(--shadow-soft)",
      },
      borderRadius: {
        card: "14px",
        control: "10px",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
