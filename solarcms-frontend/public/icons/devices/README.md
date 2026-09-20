# Device Type icons

Drop an SVG here and name it in `SUPPLIED_ICONS` in
`src/components/devices/DeviceIcon.tsx`. Until a type is named there, it renders
the built-in drawing from that same file, so the app never waits on artwork.

```ts
export const SUPPLIED_ICONS: Record<string, string> = {
  INVERTER: "inverter.svg",
  TRANSFORMER: "transformer.svg",
};
```

The key is the canonical `device_types.code` the API sends — not a display
label, and not a lowercased variant.

## What the file has to be

**SVG, and single-colour.** Each icon is rendered as a CSS mask tinted with
`currentColor`, because these sit inside containers that are already coloured by
status: green when every Device of a stage is reporting, red when none is, muted
in a hierarchy row. An `<img>` cannot inherit that, so a fixed-colour icon would
be the one element on screen that stays the same shade in both themes and
through every state change.

The practical consequences:

- **Colour in the file is discarded.** Only the shape survives. A multicolour
  Flaticon icon arrives here monochrome — usually fine, but pick the flat or
  line style rather than the gradient one, or the result will be a silhouette.
- **Solid-fill icons read heavier than the built-in set**, which is drawn as
  1.6px strokes on a 24px grid. Prefer a line/outline style, or replace enough
  of the set that the mismatch is not visible side by side.
- **Trim the viewBox to the artwork.** The mask is `contain`-fitted, so padding
  baked into the file shrinks the icon relative to its neighbours.
- **Flatten text to paths** and drop `<style>` blocks; masks ignore CSS inside
  the file.

## Licensing

Flaticon's free tier requires attribution wherever the icon is used, and the
terms differ for redistribution inside a commercial product. Whoever adds files
here owns that obligation — record the source and licence alongside them, and
add the attribution to the UI if the licence calls for it.

## Device Type codes

From `DEFAULT_STAGE_BY_DEVICE_TYPE` in `solarcms-backend/src/solarcms/domain/
sld_stages.py`, plus the types outside the power path.

| Code | What it is | Stage |
| --- | --- | --- |
| `PV_ARRAY` | The modules themselves | PV Array |
| `SMB` | String Monitoring Box — per-string DC currents | PV Array |
| `DCDB` | DC Distribution Board | PV Array |
| `INVERTER` | DC → AC conversion | Inverters |
| `ACDB` | AC Distribution Board | Inverters |
| `ICR_SECTION` | Inverter Control Room | Inverters |
| `TRANSFORMER` | Step-up | Transformer |
| `VCB` | Vacuum Circuit Breaker | Transformer |
| `ISOLATOR` | Isolating switch | Transformer |
| `MCR_SECTION` | Main Control Room — HT switchgear | Grid |
| `MFM` | Multifunction meter, operational metering | Grid |
| `ABT_METER` | The sealed settlement instrument (I-8) | Grid |
| `NET_METER` | Net metering point | Grid |

Outside the power path, so they never appear in the diagram (Guardrail 11) but
do appear on Device cards and in lists:

| Code | What it is |
| --- | --- |
| `WMS` | Weather Monitoring Station — the denominator of Performance Ratio |
| `PPC` | Power Plant Controller |
| `PLANT_KPI` | Synthetic. The Plant's own figures, never a machine. |

A code with no file and no `SUPPLIED_ICONS` entry falls back to the generic
cabinet, so an unrecognised type still renders.
