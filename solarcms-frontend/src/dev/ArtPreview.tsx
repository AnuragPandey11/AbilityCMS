/**
 * A contact sheet of every equipment drawing, at the sizes they are used at.
 *
 * Development only — mounted at `/dev/art` and not reachable from any
 * navigation. It exists because artwork cannot be reviewed one drawing at a
 * time: the whole point of the set is that twenty drawings share one light
 * direction, one material palette and one scale, and the only way to see that
 * hold (or fail) is side by side, in both themes.
 */

import { DeviceArt } from "@/components/devices/DeviceArt";

const CODES = [
  "PV_ARRAY", "SMB", "DCDB", "MODULE_TRACKER",
  "INVERTER", "ACDB", "PPC", "TRANSFORMER",
  "VCB", "ISOLATOR", "MFM", "ABT_METER",
  "NET_METER", "MCR_SECTION", "GRID", "WMS",
  "PLANT_KPI", "UPS", "DC_POWER_BANK", "ANNUNCIATOR",
  "FIRE_SYSTEM", "SLDC_TELEMETRY", "UNKNOWN_TYPE",
];

export function ArtPreview(): JSX.Element {
  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-ink">Equipment artwork</h1>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {CODES.map((code) => (
          <div key={code}
               className="flex flex-col items-center rounded-card border border-line bg-surface-raised p-3">
            <DeviceArt typeCode={code} size={104} title={code} />
            <span className="mt-2 text-[10px] font-medium tracking-wide text-ink-muted">{code}</span>
          </div>
        ))}
      </div>

      <h2 className="text-sm font-semibold text-ink">At diagram size (56px) on a sunken surface</h2>
      <div className="flex flex-wrap gap-2 rounded-card border border-line bg-surface-sunken p-4">
        {CODES.map((code) => (
          <DeviceArt key={code} typeCode={code} size={56} title={code} />
        ))}
      </div>

      <h2 className="text-sm font-semibold text-ink">At list size (32px)</h2>
      <div className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface-raised p-4">
        {CODES.map((code) => (
          <DeviceArt key={code} typeCode={code} size={32} title={code} />
        ))}
      </div>
    </div>
  );
}
