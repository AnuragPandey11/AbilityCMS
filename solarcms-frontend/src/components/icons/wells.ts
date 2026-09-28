/**
 * Which hue an icon's well takes.
 *
 * Set by the icon, never by the caller (28 Sep 2026, at the user's direction,
 * light mode only): an icon is drawn for one quantity (see `./index.tsx`), so
 * colouring by icon makes the same quantity the same colour on every screen —
 * a bolt is yellow on the Portfolio, the Plant screen and the Inverter view
 * alike, and a tile cannot be yellow on one screen and teal on the next.
 *
 *   yellow  the sun and what it drives: instantaneous power, every irradiance.
 *   green   what generation adds up to: an energy counter, CO₂ avoided.
 *   red     the Alarm bell, a warning, a temperature.
 *   accent  everything else — ratios, time, communication, weather, equipment.
 *
 * ⚠ A hue names the *quantity*, never its condition. A red bell over "0 open"
 * is the Alarm tile, not an Alarm; the verdict stays in the figure's own
 * colour, which the caller sets only where it has made one. Callers that pass
 * a verdict tone for the well itself (`ok`/`warn`/`bad`) still win over this.
 *
 * In dark mode every hue resolves to the accent (`index.css`), so this map
 * changes nothing there.
 */

import type { ComponentType } from "react";
import {
  IconAlarm,
  IconBeam,
  IconDiffuse,
  IconEnergy,
  IconIrradiance,
  IconIrradianceHorizontal,
  IconIrradianceTilted,
  IconLeaf,
  IconPower,
  IconSun,
  IconThermometer,
  IconWarning,
  type IconProps,
} from "./index";

export type WellHue = "accent" | "yellow" | "green" | "red";

/**
 * Full class names, never assembled: Tailwind emits a `@layer components`
 * rule only for a class name that appears literally in the source.
 */
export const WELL_CLASS: Record<WellHue, string> = {
  accent: "icon-well",
  yellow: "icon-well icon-well-yellow",
  green: "icon-well icon-well-green",
  red: "icon-well icon-well-red",
};

const HUE_BY_ICON = new Map<ComponentType<IconProps>, WellHue>([
  [IconPower, "yellow"],
  [IconSun, "yellow"],
  [IconIrradiance, "yellow"],
  [IconIrradianceHorizontal, "yellow"],
  [IconIrradianceTilted, "yellow"],
  [IconBeam, "yellow"],
  [IconDiffuse, "yellow"],
  [IconEnergy, "green"],
  [IconLeaf, "green"],
  [IconAlarm, "red"],
  [IconWarning, "red"],
  [IconThermometer, "red"],
]);

export function wellHue(icon: ComponentType<IconProps> | undefined): WellHue {
  return (icon && HUE_BY_ICON.get(icon)) ?? "accent";
}

/** The well's class for this icon: `icon-well` plus its hue modifier, if any. */
export function iconWell(icon: ComponentType<IconProps> | undefined): string {
  return WELL_CLASS[wellHue(icon)];
}
