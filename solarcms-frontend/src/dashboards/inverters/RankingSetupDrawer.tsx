/**
 * Sizes & tariff — the facts the Inverter ranking needs and nothing else
 * records: each Inverter's AC rating (energy lost while down is rating times
 * hours, the user's formula of 1 Nov 2026) and DC size (PR divides by it), and
 * the Plant's tariff.
 *
 * Saved through the routes that already own them (`PATCH /devices/{id}`,
 * `PATCH /plants/{id}`), so the server's permission check and audit apply as
 * anywhere else; only fields that changed are sent. "Same for every Inverter"
 * fills the boxes and saves nothing until Save — it is a typing aid, not an
 * estimate, and the person pressing Save is stating each size.
 *
 * The sizes are checked against the Plant's DC capacity where one is recorded:
 * a sum far from it is usually a typo in one row, and saying so here is cheaper
 * than a PR that is quietly wrong for a month.
 */

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import * as devicesApi from "@/api/endpoints/devices";
import * as plantsApi from "@/api/endpoints/plants";
import { isApiError } from "@/api/problem";
import type { RankedInverterRow } from "@/api/schemas";
import { Button, Drawer, Field, inputClass } from "@/components/ui";
import { formatNumber } from "@/format/value";
import { byCode } from "./ranking";

/** How far the sizes may sum from the Plant's DC capacity before it is said. */
const SUM_TOLERANCE = 0.02;
const MAX_KWP = 1_000_000;
const MAX_TARIFF = 1000;

const text = (value: number | null): string => (value === null ? "" : String(value));

function parseSize(raw: string): { value: number | null; error: string | null } {
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null, error: null };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return { value: null, error: "More than 0" };
  if (value > MAX_KWP) return { value: null, error: "Too large" };
  return { value, error: null };
}

function parseTariff(raw: string): { value: number | null; error: string | null } {
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null, error: null };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return { value: null, error: "0 or more" };
  if (value > MAX_TARIFF) return { value: null, error: `At most ₹${MAX_TARIFF}` };
  return { value, error: null };
}

export function RankingSetupDrawer({
  open,
  onClose,
  plantId,
  plantName,
  plantDcKwp,
  tariff,
  inverters,
}: {
  open: boolean;
  onClose: () => void;
  plantId: number;
  plantName: string;
  plantDcKwp: number | null;
  tariff: number | null;
  inverters: RankedInverterRow[];
}): JSX.Element {
  const queryClient = useQueryClient();
  const sorted = useMemo(() => [...inverters].sort(byCode), [inverters]);
  const [sizes, setSizes] = useState<Record<number, string>>({});
  const [ratings, setRatings] = useState<Record<number, string>>({});
  const [ratingFill, setRatingFill] = useState("");
  const [tariffText, setTariffText] = useState("");
  const [fill, setFill] = useState("");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [failures, setFailures] = useState<string[]>([]);

  // Each opening starts from what is recorded, never from a half-edited form
  // left behind by the last one.
  useEffect(() => {
    if (!open) return;
    setSizes(Object.fromEntries(sorted.map((row) => [row.device_id, text(row.dc_capacity_kwp)])));
    setRatings(Object.fromEntries(sorted.map((row) => [row.device_id, text(row.rated_capacity_kw)])));
    setRatingFill("");
    setTariffText(text(tariff));
    setFill("");
    setNote(null);
    setFailures([]);
    // Only on opening: a refetch while the drawer is open must not wipe typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const parsed = sorted.map((row) => ({
    row,
    ...parseSize(sizes[row.device_id] ?? ""),
  }));
  const parsedRatings = sorted.map((row) => ({ row, ...parseSize(ratings[row.device_id] ?? "") }));
  const tariffParsed = parseTariff(tariffText);
  const invalid =
    parsed.some((entry) => entry.error !== null) ||
    parsedRatings.some((entry) => entry.error !== null) ||
    tariffParsed.error !== null;
  const changedSizes = parsed.filter((entry) => entry.error === null && entry.value !== entry.row.dc_capacity_kwp);
  // A rating is set here, never cleared: an empty box leaves the recorded one.
  const changedRatings = parsedRatings.filter(
    (entry) => entry.error === null && entry.value !== null && entry.value !== entry.row.rated_capacity_kw,
  );
  const tariffChanged = tariffParsed.error === null && tariffParsed.value !== tariff;
  const changedDevices = new Set([
    ...changedSizes.map((entry) => entry.row.device_id),
    ...changedRatings.map((entry) => entry.row.device_id),
  ]);
  const dirty = changedDevices.size > 0 || tariffChanged;
  const rated = parsedRatings.filter((entry) => entry.value !== null).length;

  const entered = parsed.filter((entry) => entry.value !== null);
  const sum = entered.reduce((total, entry) => total + (entry.value ?? 0), 0);
  const allEntered = entered.length === sorted.length && sorted.length > 0;
  const offBy =
    allEntered && plantDcKwp !== null && plantDcKwp > 0
      ? (sum - plantDcKwp) / plantDcKwp
      : null;

  const fillParsed = parseSize(fill);
  const ratingFillParsed = parseSize(ratingFill);
  const applyRatingFill = (onlyEmpty: boolean) => {
    if (ratingFillParsed.value === null) return;
    setRatings((current) => {
      const next = { ...current };
      for (const row of sorted) {
        if (!onlyEmpty || !(current[row.device_id] ?? "").trim()) {
          next[row.device_id] = String(ratingFillParsed.value);
        }
      }
      return next;
    });
  };
  const applyFill = (onlyEmpty: boolean) => {
    if (fillParsed.value === null) return;
    setSizes((current) => {
      const next = { ...current };
      for (const row of sorted) {
        if (!onlyEmpty || !(current[row.device_id] ?? "").trim()) {
          next[row.device_id] = String(fillParsed.value);
        }
      }
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    setNote(null);
    setFailures([]);
    const failed: string[] = [];
    // One request per Inverter, carrying whichever of its two figures changed.
    const updates = sorted
      .filter((row) => changedDevices.has(row.device_id))
      .map((row) => {
        const size = changedSizes.find((entry) => entry.row.device_id === row.device_id);
        const rating = changedRatings.find((entry) => entry.row.device_id === row.device_id);
        const body: Parameters<typeof devicesApi.updateDevice>[1] = {};
        if (rating) body.rated_capacity_kw = rating.value;
        if (size) {
          if (size.value === null) body.clear = ["dc_capacity_kwp"];
          else body.dc_capacity_kwp = size.value;
        }
        return { row, body };
      });
    const results = await Promise.allSettled(
      updates.map(({ row, body }) => devicesApi.updateDevice(row.device_id, body)),
    );
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        const reason = isApiError(result.reason) ? result.reason.displayMessage : "could not be saved";
        failed.push(`${updates[index].row.code}: ${reason}`);
      }
    });
    if (tariffChanged) {
      try {
        await plantsApi.updatePlant(plantId, { energy_tariff_inr_per_kwh: tariffParsed.value });
      } catch (error) {
        failed.push(`Tariff: ${isApiError(error) ? error.displayMessage : "could not be saved"}`);
      }
    }
    // Under the Plant: the ranking, the Device list and the Plant itself.
    await queryClient.invalidateQueries({ queryKey: ["plants", plantId] });
    await queryClient.invalidateQueries({ queryKey: ["devices"] });
    setSaving(false);
    setFailures(failed);
    const savedCount = updates.length - failed.filter((line) => !line.startsWith("Tariff")).length;
    if (failed.length === 0) {
      setNote(
        `Saved${savedCount > 0 ? ` ${savedCount} Inverter${savedCount === 1 ? "" : "s"}` : ""}` +
          `${tariffChanged ? `${savedCount > 0 ? " and" : ""} the tariff` : ""}. The ranking has been worked out again.`,
      );
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Sizes & tariff"
      subtitle={`${plantName} · what loss and PR are worked out from`}
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-ink-muted">
            {dirty ? `${changedDevices.size + (tariffChanged ? 1 : 0)} change(s) not saved` : "Nothing changed"}
          </span>
          <div className="flex gap-2">
            <Button onClick={onClose}>Close</Button>
            <Button variant="primary" disabled={!dirty || invalid || saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-6">
        <section>
          <Field
            label="Tariff (₹ per kWh)"
            hint="What a kWh from this Plant is worth under its sale agreement. Prices the energy an Inverter's stops cost; empty shows energy only."
            error={tariffParsed.error ?? undefined}
          >
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={tariffText}
              onChange={(event) => setTariffText(event.target.value)}
              className={inputClass}
              placeholder="e.g. 3.45"
            />
          </Field>
        </section>

        <section>
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h3 className="text-sm font-semibold text-ink">AC rating of each Inverter (kW)</h3>
            <span className="text-xs text-ink-muted">
              {rated} of {sorted.length} recorded
            </span>
          </div>
          <p className="mb-3 text-xs leading-relaxed text-ink-muted">
            The nameplate AC output. Energy lost while an Inverter is down is its rating times the hours it was
            down, so without one that Inverter&apos;s loss reads &quot;—&quot;.
          </p>
          <div className="mb-3 flex flex-wrap items-end gap-2 rounded-card border border-line bg-surface-sunken/60 p-3">
            <div className="w-36">
              <Field
                label="Same rating for all"
                error={ratingFill.trim() ? ratingFillParsed.error ?? undefined : undefined}
              >
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  value={ratingFill}
                  onChange={(event) => setRatingFill(event.target.value)}
                  className={inputClass}
                  placeholder="kW"
                />
              </Field>
            </div>
            <Button disabled={ratingFillParsed.value === null} onClick={() => applyRatingFill(true)}>
              Fill empty
            </Button>
            <Button disabled={ratingFillParsed.value === null} onClick={() => applyRatingFill(false)}>
              Fill all
            </Button>
          </div>
          <div className="divide-y divide-line overflow-hidden rounded-card border border-line">
            {parsedRatings.map(({ row, error }) => (
              <label key={row.device_id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 truncate text-sm font-medium text-ink">{row.code}</span>
                <span className="flex shrink-0 flex-col items-end">
                  <span className="w-32">
                    <input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      aria-label={`${row.code} AC rating in kW`}
                      value={ratings[row.device_id] ?? ""}
                      onChange={(event) =>
                        setRatings((current) => ({ ...current, [row.device_id]: event.target.value }))
                      }
                      className={`${inputClass} text-right ${error ? "border-bad" : ""}`}
                      placeholder="kW"
                    />
                  </span>
                  {error ? <span className="mt-0.5 text-[11px] text-bad">{error}</span> : null}
                </span>
              </label>
            ))}
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h3 className="text-sm font-semibold text-ink">DC size of each Inverter (kWp)</h3>
            <span className="text-xs text-ink-muted">
              {entered.length} of {sorted.length} recorded
            </span>
          </div>
          <p className="mb-3 text-xs leading-relaxed text-ink-muted">
            The panels connected to each Inverter, from the design — not its AC rating. PR divides by it, so
            it is never estimated from the Plant&apos;s total.
          </p>

          <div className="mb-3 flex flex-wrap items-end gap-2 rounded-card border border-line bg-surface-sunken/60 p-3">
            <div className="w-36">
              <Field label="Same size for all" error={fill.trim() ? fillParsed.error ?? undefined : undefined}>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  value={fill}
                  onChange={(event) => setFill(event.target.value)}
                  className={inputClass}
                  placeholder="kWp"
                />
              </Field>
            </div>
            <Button disabled={fillParsed.value === null} onClick={() => applyFill(true)}>
              Fill empty
            </Button>
            <Button disabled={fillParsed.value === null} onClick={() => applyFill(false)}>
              Fill all
            </Button>
          </div>

          <div className="divide-y divide-line overflow-hidden rounded-card border border-line">
            {parsed.map(({ row, error }) => (
              <label key={row.device_id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 truncate text-sm font-medium text-ink">{row.code}</span>
                <span className="flex shrink-0 flex-col items-end">
                  <span className="w-32">
                    <input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      aria-label={`${row.code} DC size in kWp`}
                      value={sizes[row.device_id] ?? ""}
                      onChange={(event) =>
                        setSizes((current) => ({ ...current, [row.device_id]: event.target.value }))
                      }
                      className={`${inputClass} text-right ${error ? "border-bad" : ""}`}
                      placeholder="kWp"
                    />
                  </span>
                  {error ? <span className="mt-0.5 text-[11px] text-bad">{error}</span> : null}
                </span>
              </label>
            ))}
          </div>

          {entered.length > 0 ? (
            <p
              className={`mt-2 text-xs ${
                offBy !== null && Math.abs(offBy) > SUM_TOLERANCE ? "text-warn" : "text-ink-muted"
              }`}
            >
              Sizes add up to {formatNumber(sum, { digits: 0 })} kWp
              {plantDcKwp !== null ? ` against the Plant's ${formatNumber(plantDcKwp, { digits: 0 })} kWp` : ""}
              {offBy !== null && Math.abs(offBy) > SUM_TOLERANCE
                ? ` — ${formatNumber(Math.abs(offBy) * 100, { digits: 1 })}% ${offBy > 0 ? "over" : "under"}. Check for a mistyped row.`
                : "."}
            </p>
          ) : null}
        </section>

        {note ? (
          <p className="rounded border border-ok/30 bg-ok/10 px-2 py-1 text-xs text-ok">{note}</p>
        ) : null}
        {failures.length > 0 ? (
          <div className="rounded border border-bad/30 bg-bad/10 px-2 py-1 text-xs text-bad">
            <p className="font-medium">Some changes were not saved:</p>
            <ul className="mt-1 list-disc pl-4">
              {failures.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Drawer>
  );
}
