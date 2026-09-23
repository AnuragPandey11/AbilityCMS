/**
 * The product lockup: Ability Automation's logo.
 *
 * This is platform branding, not Client branding — it never varies by the
 * signed-in Client, Plant or Device (F-14, Guardrail 2). A Client logo, if one
 * is ever wanted, belongs in configuration beside the Client row, not here.
 *
 * Two variants, because the logo is navy lettering and navy on a dark ground
 * disappears. The reversed one lifts only the lettering; the orange arrow and
 * the teal swoosh are the brand and stay exactly as drawn. Both are derived
 * from the client's raster by `brand/derive.py` — re-run it, never hand-edit
 * the PNGs — and both should be replaced by the client's own vector and
 * reversed artwork once they supply it.
 */

import logo from "@/assets/brand/ability-logo.png";
import logoReversed from "@/assets/brand/ability-logo-reversed.png";
import mark from "@/assets/brand/ability-mark.png";
import markReversed from "@/assets/brand/ability-mark-reversed.png";
import { useTheme } from "@/theme/ThemeProvider";

// Intrinsic sizes, so the box is reserved before the image decodes and nothing
// below it jumps when it arrives.
const LOGO = { width: 404, height: 104 };
const MARK = { width: 139, height: 94 };

export function BrandMark({
  compact = false,
  height = 44,
  onNavy = false,
}: {
  /** Sidebar rail: the symbol only, no wordmark. */
  compact?: boolean;
  /** Rendered height in px; the width follows the artwork's own proportions. */
  height?: number;
  /**
   * The ground is navy whatever the theme — the sidebar — so the lettering is
   * always the reversed one. Navy lettering on a navy sidebar would vanish.
   */
  onNavy?: boolean;
}): JSX.Element {
  // `resolved`, not `choice`: "system" has to become light or dark here too.
  // Read unconditionally — a hook behind `||` is a hook called conditionally.
  const { resolved } = useTheme();
  const dark = onNavy || resolved === "dark";
  const size = compact ? MARK : LOGO;
  const src = compact ? (dark ? markReversed : mark) : dark ? logoReversed : logo;

  return (
    <img
      src={src}
      alt="Ability Automation Solutions"
      width={Math.round((height * size.width) / size.height)}
      height={height}
      draggable={false}
      // `object-contain` so a container narrower than the artwork shrinks it
      // rather than squashing it.
      className="block max-w-full shrink-0 select-none object-contain object-left"
    />
  );
}
