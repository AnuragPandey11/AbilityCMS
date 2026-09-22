/**
 * The materials the equipment artwork is painted with.
 *
 * ── Why the artwork carries its own palette ────────────────────────────────
 * Every other colour in this app is a theme token, because every other colour
 * means something the theme is allowed to restate: a status, a series, a
 * surface. Equipment colour is not one of those. A transformer tank is grey
 * because transformer tanks are grey, and a PV module is deep blue because
 * silicon under anti-reflective coating is deep blue. Re-tinting those with
 * `currentColor` — which is what `DeviceIcon` does, correctly, for the
 * status-coloured chrome it lives in — turns recognisable equipment into
 * silhouettes, and a silhouette of a transformer is indistinguishable from a
 * silhouette of a switchgear cubicle at 40px.
 *
 * So the artwork is full-colour and theme-independent, with two exceptions
 * that *are* theme tokens:
 *
 *   `--art-rim`    a rim light along the top edges, so a dark cabinet keeps a
 *                  readable silhouette against a dark page and a light one
 *                  does not glow on a white card.
 *   `--art-shadow` the contact shadow under the object.
 *
 * Both are set in `index.css` per theme. Everything else below is fixed.
 *
 * ── Why these are hex, not the `r g b` channel triples the tokens use ──────
 * Tailwind's alpha modifiers need bare channels; SVG gradient stops do not,
 * and `stop-color` with a hex plus a separate `stop-opacity` is what every
 * vector editor round-trips cleanly. Nothing here passes through Tailwind.
 */

/** Painted steel enclosure — inverters, boards, switchgear cubicles. */
export const STEEL = {
  light: "#e8edf2",
  mid: "#c3ccd6",
  dark: "#8f9aa7",
  shade: "#6c7683",
  edge: "#55606c",
} as const;

/** Galvanised / raw metal — frames, masts, pylons, radiator fins. */
export const GALV = {
  light: "#d6dde4",
  mid: "#aab4bf",
  dark: "#7d8794",
  edge: "#5a6470",
} as const;

/** Monocrystalline module glass. Deep blue, near-black at the top of the sheen. */
export const CELL = {
  light: "#2f6ea8",
  mid: "#1d4c7c",
  dark: "#123353",
  deep: "#0b2138",
  grid: "#5f93c4",
} as const;

/** Transformer / heavy plant enclosure — a warmer, darker grey than switchgear. */
export const TANK = {
  light: "#b9bfc4",
  mid: "#939aa1",
  dark: "#6d747c",
  edge: "#4d545c",
} as const;

/** Porcelain insulators and bushings. */
export const PORCELAIN = {
  light: "#f0ece2",
  mid: "#d6cfbe",
  dark: "#b0a794",
} as const;

/** Copper busbar and terminations. */
export const COPPER = {
  light: "#e2a878",
  mid: "#c07d47",
  dark: "#8e552b",
} as const;

/** An energised indicator or an illuminated display. Deliberately not the
 *  theme's `ok` token: this is a lamp on the equipment, not a status the
 *  platform is asserting about it. */
export const LIVE = {
  glow: "#3ddc84",
  core: "#8dffc0",
  dim: "#2a6b48",
} as const;

/** A display panel's backlight. */
export const SCREEN = {
  glass: "#0d1b24",
  lit: "#1b3a4a",
  text: "#6fd3c6",
} as const;

/** Theme-reactive, defined in `index.css`. */
/**
 * Composed from channels plus a separate alpha rather than a single colour,
 * for the same reason the theme tokens are: the alpha has to differ between
 * themes independently of the hue. A dark page needs a faint cool rim, a white
 * one a stronger warm one, and a shadow that works on white is invisible on
 * near-black at the same opacity.
 */
export const RIM = "rgb(var(--art-rim, 255 255 255) / var(--art-rim-alpha, 0.6))";
export const SHADOW = "rgb(var(--art-shadow, 15 30 25) / var(--art-shadow-alpha, 0.16))";
