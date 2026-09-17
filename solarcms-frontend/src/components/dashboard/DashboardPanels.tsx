/**
 * The fixed panels of the Plant dashboard.
 *
 * Same panels, same positions, every Plant — which is the whole argument against
 * a drag-and-drop canvas. A canvas makes every Plant a bespoke artefact somebody
 * has to build and nobody can compare with another; this makes every Plant the
 * same screen, answered by whatever equipment it happens to have.
 *
 * The titles here are the *only* thing about the layout that lives in the
 * frontend. Which slots a panel holds, what order they sit in, and which Device
 * answers each of them are all resolved by the backend, so adding a figure to
 * the Plant Status panel is a row in `dashboard_slots`, not a change here.
 *
 * A panel with nothing in it does not render. Slots the Plant cannot answer are
 * dropped server-side (`hide_when_unresolved`), so an empty panel means the
 * Plant has no instrumentation of that kind at all — a weather-station panel on
 * a Plant with no weather station is a permanent row of dashes that teaches
 * operators to ignore dashes.
 */

import type { ResolvedSlot } from "@/api/schemas";
import { Panel } from "@/components/ui";
import { SlotRow, SlotTile } from "./SlotValue";

/** Panel code → how it is titled and drawn. Presentation only. */
const PANEL_CHROME: Record<string, { title: string; subtitle?: string }> = {
  plant_status: {
    title: "Plant Status",
    subtitle: "Live figures at the Plant's electrical boundary.",
  },
  power_summary: {
    title: "Power Summary",
    subtitle: "DC in, AC out, and what crossed the meter. Each gap is a real loss.",
  },
  energy_summary: {
    title: "Energy Summary",
    subtitle: "Generated, exported and imported are three different quantities.",
  },
  environment: {
    title: "Weather Station",
    subtitle: "The denominator of Performance Ratio.",
  },
};

function byPosition(slots: ResolvedSlot[]): ResolvedSlot[] {
  return [...slots].sort((a, b) => a.position - b.position);
}

/** The headline row: large tiles, always in the same order. */
export function KpiSlotRow({ slots }: { slots: ResolvedSlot[] }): JSX.Element | null {
  if (slots.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
      {byPosition(slots).map((slot) => (
        <SlotTile key={slot.slot_code} slot={slot} />
      ))}
    </div>
  );
}

/** One list panel — label on the left, value and source on the right. */
export function SlotListPanel({
  panel,
  slots,
  className = "",
}: {
  panel: string;
  slots: ResolvedSlot[];
  className?: string;
}): JSX.Element | null {
  if (slots.length === 0) return null;
  const chrome = PANEL_CHROME[panel] ?? { title: panel };
  return (
    <Panel title={chrome.title} subtitle={chrome.subtitle} className={className}>
      <div className="divide-y divide-line-soft">
        {byPosition(slots).map((slot) => (
          <SlotRow key={slot.slot_code} slot={slot} />
        ))}
      </div>
    </Panel>
  );
}
