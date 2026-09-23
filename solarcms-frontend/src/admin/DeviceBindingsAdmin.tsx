/**
 * Device bindings (§7.2) — the most dangerous screen in the application.
 *
 * A binding decides how **every future Reading** from that Device is decoded, so
 * three things are made explicit rather than implied:
 *
 * 1. `PUT` **replaces** the whole set. A form that looks like a merge silently
 *    drops bindings, so the replace semantics are stated on the screen and in
 *    the save confirmation.
 * 2. Existing Readings are **not** retroactively re-decoded. `mqtt_raw` retains
 *    payloads for 90 days and is the only route back — and that is a backend
 *    replay, not something this screen does.
 * 3. The scale is per-Device on purpose (MASTER §3.5): field wiring never
 *    matches the datasheet, so the catalogue default is a starting point only.
 *
 * ⚠ **Known limitation.** §7.2 asks for the current binding to sit beside a live
 * sample of the *raw payload key*. No endpoint exposes `mqtt_raw`, so the
 * closest available evidence is shown instead: the live **decoded** value for
 * each bound Tag, from the WebSocket. That confirms a binding is producing
 * something, but not what the publisher called the key. Reading raw payload keys
 * needs a backend endpoint over `mqtt_raw_v` that does not exist yet.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useBindings,
  useDevice,
  useDeviceModelTags,
  usePlantDevices,
  useTags,
  useUnmappedKeys,
} from "@/api/hooks";
import * as devicesApi from "@/api/endpoints/devices";
import { isApiError } from "@/api/problem";
import { Button, Field, Panel, Badge, inputClass } from "@/components/ui";
import {
  EmptyState,
  ErrorState,
  ForbiddenState,
  SkeletonTable,
} from "@/components/state";
import { PlantPicker } from "@/components/domain";
import { usePermission } from "@/auth/usePermission";
import { usePlantScope } from "@/state/usePlantScope";
import { useLiveSocket } from "@/live/LiveSocket";
import { formatValue, formatDigital } from "@/format/value";
import { formatAge } from "@/format/datetime";

interface DraftBinding {
  source_key: string;
  tag_code: string;
  scale: string;
  value_offset: string;
  valid_min: string;
  valid_max: string;
  enabled: boolean;
}

export function DeviceBindingsAdmin(): JSX.Element {
  const canConfigure = usePermission("config.modify");
  const queryClient = useQueryClient();
  const { plants, plantId, setPlantId } = usePlantScope();
  const devicesQuery = usePlantDevices(plantId);
  const tagsQuery = useTags();
  const { devices: liveDevices } = useLiveSocket();

  const [deviceId, setDeviceId] = useState<number | null>(null);
  const [draft, setDraft] = useState<DraftBinding[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const bindingsQuery = useBindings(deviceId, canConfigure);
  const deviceQuery = useDevice(deviceId);
  const modelTagsQuery = useDeviceModelTags(
    deviceQuery.data?.device_model_id ?? null,
  );

  // Rows for every Tag on the Device's Model that the draft does not bind yet.
  // The Model's schedule is the client's own signal list for that Device Type
  // (TAG_CATALOGUE §2); the source key defaults to the alias observed on their
  // broker where one exists, and to the Tag code otherwise — both to be checked
  // against the live frame before saving.
  const addModelTags = () => {
    const bound = new Set(draft.map((binding) => binding.tag_code));
    const additions = (modelTagsQuery.data ?? [])
      .filter((tag) => !bound.has(tag.tag_code))
      .map((tag) => ({
        source_key: tag.default_source_key ?? tag.tag_code,
        tag_code: tag.tag_code,
        scale: String(tag.scale_default),
        value_offset: "0",
        valid_min: tag.valid_min === null ? "" : String(tag.valid_min),
        valid_max: tag.valid_max === null ? "" : String(tag.valid_max),
        enabled: true,
      }));
    setDraft((previous) => [...previous, ...additions]);
  };
  const unboundModelTagCount = (modelTagsQuery.data ?? []).filter(
    (tag) => !draft.some((binding) => binding.tag_code === tag.tag_code),
  ).length;

  useEffect(() => {
    // Reload the draft whenever the Device or the server's set changes, so an
    // edit is never applied on top of another operator's save.
    if (!bindingsQuery.data) return;
    setDraft(
      bindingsQuery.data.map((binding) => ({
        source_key: binding.source_key,
        tag_code: binding.tag_code,
        scale: String(binding.scale),
        value_offset: String(binding.value_offset),
        valid_min: binding.valid_min === null ? "" : String(binding.valid_min),
        valid_max: binding.valid_max === null ? "" : String(binding.valid_max),
        enabled: binding.enabled,
      })),
    );
    setConfirming(false);
  }, [bindingsQuery.data]);

  const save = useMutation({
    mutationFn: () =>
      devicesApi.replaceBindings(
        deviceId as number,
        draft.map((binding) => ({
          source_key: binding.source_key,
          tag_code: binding.tag_code,
          scale: binding.scale ? Number(binding.scale) : 1,
          value_offset: binding.value_offset ? Number(binding.value_offset) : 0,
          valid_min:
            binding.valid_min === "" ? null : Number(binding.valid_min),
          valid_max:
            binding.valid_max === "" ? null : Number(binding.valid_max),
          enabled: binding.enabled,
        })),
      ),
    onSuccess: (response) => {
      setError(null);
      setConfirming(false);
      setResult(
        `${response.bindings} binding(s) written. The ingest worker's topic ` +
          `resolution cache was ${response.resolution_cache}, so the change takes ` +
          `effect on the next message. Readings already stored keep their previous ` +
          `decoding.`,
      );
      void queryClient.invalidateQueries({
        queryKey: ["devices", deviceId, "bindings"],
      });
    },
    onError: (err) => {
      setResult(null);
      setError(
        isApiError(err) ? err.displayMessage : "Could not save the bindings.",
      );
    },
  });

  const devices = devicesQuery.data ?? [];
  const device = devices.find((candidate) => candidate.id === deviceId) ?? null;
  const liveFrame = deviceId ? liveDevices[deviceId] : undefined;
  // How far this Model's repeating group runs, so the settings panel only offers
  // a string count to Devices that actually have one.
  const modelRepeatMax = (modelTagsQuery.data ?? []).reduce(
    (highest, tag) => Math.max(highest, tag.repeat_index ?? 0),
    0,
  );

  const removedCount = useMemo(() => {
    const existing = new Set((bindingsQuery.data ?? []).map((b) => b.tag_code));
    for (const binding of draft) existing.delete(binding.tag_code);
    return existing.size;
  }, [bindingsQuery.data, draft]);

  if (!canConfigure) {
    return (
      <ForbiddenState detail="Editing Device bindings requires the config.modify permission." />
    );
  }

  const update = (index: number, patch: Partial<DraftBinding>) =>
    setDraft((previous) =>
      previous.map((binding, i) =>
        i === index ? { ...binding, ...patch } : binding,
      ),
    );

  /** The live decoded value for a bound Tag, if the socket has one. */
  const liveFor = (tagCode: string): string => {
    const tag = (tagsQuery.data ?? []).find(
      (candidate) => candidate.code === tagCode,
    );
    if (!tag || !liveFrame) return "—";
    const value = liveFrame.values[tag.id];
    if (value === undefined) return "—";
    return tag.category === "status"
      ? formatDigital(value)
      : formatValue(value, tag.unit);
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="page-title">Device bindings</h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          A binding decides how every future Reading from this Device is
          decoded.
        </p>
      </div>

      <Panel title="Device">
        <div className="flex flex-wrap items-end gap-3">
          <PlantPicker
            plants={plants}
            value={plantId}
            onChange={setPlantId}
            label="Plant"
          />
          <label className="text-xs text-ink-muted">
            Device
            <select
              value={deviceId ?? ""}
              onChange={(event) =>
                setDeviceId(
                  event.target.value ? Number(event.target.value) : null,
                )
              }
              className={`${inputClass} mt-1 w-72`}
            >
              <option value="">Choose…</option>
              {devices.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.code} — {candidate.type_code}
                </option>
              ))}
            </select>
          </label>
          {device?.source_address ? (
            <span className="text-[11px] text-ink-faint">
              Topic <span className="font-mono">{device.source_address}</span>
            </span>
          ) : null}
        </div>
      </Panel>

      {deviceId !== null ? (
        <DeviceSettings deviceId={deviceId} modelRepeatMax={modelRepeatMax} />
      ) : null}

      {deviceId !== null ? (
        <UnmappedSignals
          deviceId={deviceId}
          onBind={(sourceKey, tagCode) =>
            setDraft((previous) =>
              previous.some((binding) => binding.tag_code === tagCode)
                ? // Already bound to something else: point the existing row at
                  // this key rather than adding a second binding for one Tag,
                  // which the unique constraint would reject on save anyway.
                  previous.map((binding) =>
                    binding.tag_code === tagCode
                      ? { ...binding, source_key: sourceKey }
                      : binding,
                  )
                : [
                    ...previous,
                    {
                      source_key: sourceKey,
                      tag_code: tagCode,
                      scale: "1",
                      value_offset: "0",
                      valid_min: "",
                      valid_max: "",
                      enabled: true,
                    },
                  ],
            )
          }
        />
      ) : null}

      {deviceId === null ? (
        <EmptyState
          title="Choose a Device"
          detail="Bindings are per Device, because field wiring never matches the datasheet."
        />
      ) : bindingsQuery.isLoading ? (
        <SkeletonTable rows={8} columns={6} />
      ) : bindingsQuery.isError ? (
        <ErrorState
          error={bindingsQuery.error}
          retry={() => void bindingsQuery.refetch()}
        />
      ) : (
        <>
          <div className="rounded border border-warn/30 bg-warn/10 px-3 py-2 text-[11px] leading-relaxed text-ink-muted">
            <strong className="text-warn">
              Saving replaces the entire set.
            </strong>{" "}
            Any row removed here is deleted, not left in place. Existing
            Readings are <strong>not</strong> re-decoded —{" "}
            <span className="font-mono">mqtt_raw</span> keeps the original
            payloads for 90 days and a backend replay is the only route back.
          </div>

          <div className="rounded border border-line bg-surface px-3 py-2 text-[11px] leading-relaxed text-ink-faint">
            The <em>Live</em> column shows the value each binding is currently
            producing, taken from the live socket. It is the decoded value, not
            the raw payload key the publisher sent — no endpoint exposes raw
            payloads, so the key itself cannot be shown here yet.
            {liveFrame ? (
              <span className="ml-1">
                Last frame{" "}
                {formatAge((Date.now() - Date.parse(liveFrame.at)) / 1000)}.
              </span>
            ) : (
              <span className="ml-1">
                No live frame has arrived for this Device.
              </span>
            )}
          </div>

          {result ? (
            <div className="rounded border border-ok/30 bg-ok/10 px-3 py-2 text-xs text-ok">
              {result}
            </div>
          ) : null}
          {error ? (
            <div className="rounded border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad">
              {error}
            </div>
          ) : null}

          <Panel
            title={`Bindings — ${device?.code ?? ""}`}
            subtitle={`${draft.length} row(s). The catalogue's scale is a default of last resort; the authoritative scale is here.`}
          >
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-line text-left text-ink-muted">
                    <th className="px-2 py-1.5">Source key</th>
                    <th className="px-2 py-1.5">Tag</th>
                    <th className="px-2 py-1.5">Unit</th>
                    <th className="px-2 py-1.5">Scale</th>
                    <th className="px-2 py-1.5">Offset</th>
                    <th className="px-2 py-1.5">Valid min</th>
                    <th className="px-2 py-1.5">Valid max</th>
                    <th className="px-2 py-1.5">On</th>
                    <th className="px-2 py-1.5 text-right">Live</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {draft.map((binding, index) => {
                    const tag = (tagsQuery.data ?? []).find(
                      (candidate) => candidate.code === binding.tag_code,
                    );
                    return (
                      <tr key={index} className="border-b border-line/60">
                        <td className="px-2 py-1">
                          <input
                            value={binding.source_key}
                            onChange={(event) =>
                              update(index, { source_key: event.target.value })
                            }
                            className={`${inputClass} font-mono`}
                          />
                        </td>
                        <td className="px-2 py-1">
                          <select
                            value={binding.tag_code}
                            onChange={(event) =>
                              update(index, { tag_code: event.target.value })
                            }
                            className={inputClass}
                          >
                            {(tagsQuery.data ?? []).map((candidate) => (
                              <option key={candidate.id} value={candidate.code}>
                                {candidate.code}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-2 py-1 text-ink-muted">
                          {/* Verbatim from the catalogue. Never converted. */}
                          {tag?.unit ?? "—"}
                          {tag?.category === "status" ? (
                            <Badge
                              tone="info"
                              title="A Digital Input is never throttled — min_interval_s is 0, enforced by a CHECK constraint."
                            >
                              DI
                            </Badge>
                          ) : null}
                        </td>
                        <td className="px-2 py-1">
                          <input
                            value={binding.scale}
                            onChange={(event) =>
                              update(index, { scale: event.target.value })
                            }
                            className={`${inputClass} w-20`}
                          />
                        </td>
                        <td className="px-2 py-1">
                          <input
                            value={binding.value_offset}
                            onChange={(event) =>
                              update(index, {
                                value_offset: event.target.value,
                              })
                            }
                            className={`${inputClass} w-20`}
                          />
                        </td>
                        <td className="px-2 py-1">
                          <input
                            value={binding.valid_min}
                            onChange={(event) =>
                              update(index, { valid_min: event.target.value })
                            }
                            className={`${inputClass} w-20`}
                          />
                        </td>
                        <td className="px-2 py-1">
                          <input
                            value={binding.valid_max}
                            onChange={(event) =>
                              update(index, { valid_max: event.target.value })
                            }
                            className={`${inputClass} w-20`}
                          />
                        </td>
                        <td className="px-2 py-1">
                          <input
                            type="checkbox"
                            checked={binding.enabled}
                            onChange={(event) =>
                              update(index, { enabled: event.target.checked })
                            }
                          />
                        </td>
                        <td className="px-2 py-1 text-right font-mono text-info">
                          {liveFor(binding.tag_code)}
                        </td>
                        <td className="px-2 py-1">
                          <Button
                            variant="ghost"
                            onClick={() =>
                              setDraft((previous) =>
                                previous.filter((_, i) => i !== index),
                              )
                            }
                            title="Removing a row deletes the binding when saved."
                          >
                            ✕
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                onClick={() =>
                  setDraft((previous) => [
                    ...previous,
                    {
                      source_key: "",
                      tag_code: tagsQuery.data?.[0]?.code ?? "",
                      scale: "1",
                      value_offset: "0",
                      valid_min: "",
                      valid_max: "",
                      enabled: true,
                    },
                  ])
                }
              >
                Add a binding
              </Button>
              <Button
                onClick={addModelTags}
                disabled={
                  modelTagsQuery.isPending || unboundModelTagCount === 0
                }
                title="Adds a row for every signal on this Device's Model that is not bound yet. Source keys are defaults — verify each against the live frame."
              >
                {modelTagsQuery.data && unboundModelTagCount === 0
                  ? "All Model signals bound"
                  : `Add the Model's signals${unboundModelTagCount ? ` (${unboundModelTagCount})` : ""}`}
              </Button>

              {confirming ? (
                <>
                  <span className="text-[11px] text-warn">
                    Replace all {bindingsQuery.data?.length ?? 0} existing
                    binding(s) with these {draft.length}?
                    {removedCount > 0
                      ? ` ${removedCount} will be deleted and stop decoding.`
                      : ""}
                  </span>
                  <Button
                    variant="danger"
                    disabled={save.isPending}
                    onClick={() => save.mutate()}
                  >
                    {save.isPending ? "Saving…" : "Yes, replace"}
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirming(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button variant="primary" onClick={() => setConfirming(true)}>
                  Save bindings
                </Button>
              )}
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}

/**
 * Signals this Device is publishing that nothing is bound to.
 *
 * The single most useful thing during commissioning, and it exists nowhere else:
 * an unmapped key never becomes a Reading, so no query over history can reveal
 * one. Until this panel existed the only symptom was a Tag that stayed empty,
 * which is indistinguishable from a sensor that has failed.
 *
 * The suggestion beside each key is the registry's own alias — the client writes
 * "AMBINT TEMP." and the canonical Tag is AMBIENT_TEMPERATURE. A suggestion
 * only: the binding is the authority, and the operator confirms it.
 */
function UnmappedSignals({
  deviceId,
  onBind,
}: {
  deviceId: number;
  onBind: (sourceKey: string, tagCode: string) => void;
}): JSX.Element | null {
  const queryClient = useQueryClient();
  const keysQuery = useUnmappedKeys(deviceId);
  const keys = keysQuery.data ?? [];

  const forget = useMutation({
    mutationFn: () => devicesApi.forgetUnmappedKeys(deviceId),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: ["devices", deviceId, "unmapped-keys"],
      }),
  });

  if (keysQuery.isLoading || keys.length === 0) return null;

  return (
    <Panel
      title={`${keys.length} unmapped signal(s)`}
      subtitle="This Device is publishing these, and they are being discarded."
      actions={
        <button
          type="button"
          onClick={() => forget.mutate()}
          className="text-[11px] text-ink-muted hover:text-ink hover:underline"
          title="Clears the list so it rebuilds from what arrives next. Use after binding them."
        >
          Clear list
        </button>
      }
    >
      <div className="flex flex-wrap gap-2">
        {keys.map((key) => (
          <div
            key={key.source_key}
            className="flex items-center gap-2 rounded border border-warn/30 bg-warn/5 px-2 py-1"
          >
            <span className="font-mono text-xs text-ink">{key.source_key}</span>
            {key.suggested_tag_code ? (
              <button
                type="button"
                onClick={() =>
                  onBind(key.source_key, key.suggested_tag_code as string)
                }
                className="text-[11px] text-accent hover:underline"
                title={`Add a draft binding to ${key.suggested_tag_code}. Nothing is saved until you press Save bindings.`}
              >
                bind to {key.suggested_tag_code}
              </button>
            ) : (
              <span className="text-[11px] text-ink-faint">
                no matching Tag — add one to the registry first
              </span>
            )}
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
        Binding one adds a draft row below. Nothing is written until the bindings
        are saved, and saved bindings apply to the next message, never to
        Readings already stored.
      </p>
    </Panel>
  );
}

/**
 * The Device's own settings: topic, interval, capacity, string count, wiring.
 *
 * Separate from the bindings because they fail differently. A wrong binding
 * decodes a number incorrectly; a missing topic means nothing arrives at all,
 * and a wrong `expected_interval_s` means a dead Device still reads as healthy.
 * Both were previously fixable only by re-running onboarding.
 */
function DeviceSettings({
  deviceId,
  modelRepeatMax,
}: {
  deviceId: number;
  modelRepeatMax: number;
}): JSX.Element | null {
  const queryClient = useQueryClient();
  const deviceQuery = useDevice(deviceId);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const device = deviceQuery.data;

  useEffect(() => {
    if (!device) return;
    setForm({
      name: device.name,
      source_address: device.source_address ?? "",
      expected_interval_s: String(device.expected_interval_s),
      rated_capacity_kw:
        device.rated_capacity_kw === null ? "" : String(device.rated_capacity_kw),
      string_count: device.string_count === null ? "" : String(device.string_count),
    });
  }, [device]);

  const save = useMutation({
    mutationFn: () =>
      devicesApi.updateDevice(deviceId, {
        name: form.name || undefined,
        source_address: form.source_address || undefined,
        expected_interval_s: form.expected_interval_s
          ? Number(form.expected_interval_s)
          : undefined,
        rated_capacity_kw: form.rated_capacity_kw
          ? Number(form.rated_capacity_kw)
          : undefined,
        string_count: form.string_count ? Number(form.string_count) : undefined,
        // Emptying a box means "remove this", which a PATCH cannot express by
        // omission — `null` and "unchanged" are the same JSON.
        clear: [
          form.source_address ? null : "source_address",
          form.string_count ? null : "string_count",
        ].filter((field): field is string => field !== null),
      }),
    onSuccess: () => {
      setError(null);
      setNote(
        "Saved. The ingest worker's topic cache was invalidated, so the change " +
          "takes effect on the next message.",
      );
      void queryClient.invalidateQueries({ queryKey: ["devices", deviceId] });
    },
    onError: (err) => {
      setNote(null);
      setError(
        isApiError(err) ? err.displayMessage : "Could not save the Device.",
      );
    },
  });

  const reseed = useMutation({
    mutationFn: () => devicesApi.bindFromModel(deviceId, false),
    onSuccess: (result) => {
      setError(null);
      setNote(
        `${result.bound} Tag(s) seeded from the Model` +
          (result.strings ? ` including ${result.strings} PV string(s).` : "."),
      );
      void queryClient.invalidateQueries({
        queryKey: ["devices", deviceId, "bindings"],
      });
    },
    onError: (err) =>
      setError(
        isApiError(err) ? err.displayMessage : "Could not seed from the Model.",
      ),
  });

  if (!device) return null;

  return (
    <Panel
      title="Device settings"
      subtitle="Topic, interval, capacity and string count. These fail differently from bindings."
      actions={
        <button
          type="button"
          onClick={() => setOpen((previous) => !previous)}
          className="text-[11px] text-ink-muted hover:text-ink hover:underline"
        >
          {open ? "Hide" : "Edit"}
        </button>
      }
    >
      {!open ? (
        <div className="flex flex-wrap gap-4 text-[11px] text-ink-muted">
          <span>
            Topic{" "}
            <span className="font-mono text-ink">
              {device.source_address ?? "not set"}
            </span>
          </span>
          <span>
            Interval <span className="text-ink">{device.expected_interval_s}s</span>
          </span>
          <span>
            Capacity{" "}
            <span className="text-ink">
              {device.rated_capacity_kw ?? "not set"} kW
            </span>
          </span>
          {modelRepeatMax > 0 ? (
            <span>
              PV strings{" "}
              <span className="text-ink">{device.string_count ?? "not set"}</span>{" "}
              of {modelRepeatMax}
            </span>
          ) : null}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Field label="Name">
              <input
                value={form.name ?? ""}
                onChange={(event) =>
                  setForm((f) => ({ ...f, name: event.target.value }))
                }
                className={inputClass}
              />
            </Field>
            <Field
              label="MQTT topic"
              hint="The sole authority for whose data a message is."
            >
              <input
                value={form.source_address ?? ""}
                onChange={(event) =>
                  setForm((f) => ({ ...f, source_address: event.target.value }))
                }
                className={`${inputClass} font-mono text-xs`}
              />
            </Field>
            <Field
              label="Expected interval (s)"
              hint="From observation. Health thresholds multiply this."
            >
              <input
                type="number"
                min={1}
                value={form.expected_interval_s ?? ""}
                onChange={(event) =>
                  setForm((f) => ({
                    ...f,
                    expected_interval_s: event.target.value,
                  }))
                }
                className={`${inputClass} border-warn/40`}
              />
            </Field>
            <Field
              label="Rated capacity (kW)"
              hint="Specific yield is energy ÷ capacity; without it there is none."
            >
              <input
                type="number"
                value={form.rated_capacity_kw ?? ""}
                onChange={(event) =>
                  setForm((f) => ({
                    ...f,
                    rated_capacity_kw: event.target.value,
                  }))
                }
                className={inputClass}
              />
            </Field>
            {modelRepeatMax > 0 ? (
              <Field
                label="PV strings on this unit"
                hint={`Up to ${modelRepeatMax}. Re-seed from the Model after changing it.`}
              >
                <input
                  type="number"
                  min={0}
                  max={modelRepeatMax}
                  value={form.string_count ?? ""}
                  onChange={(event) =>
                    setForm((f) => ({ ...f, string_count: event.target.value }))
                  }
                  className={inputClass}
                />
              </Field>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving…" : "Save Device"}
            </Button>
            <Button
              disabled={reseed.isPending}
              onClick={() => reseed.mutate()}
              title="Adds any Tags on the Model that are not bound yet. Existing bindings and their corrections are left alone."
            >
              {reseed.isPending ? "Seeding…" : "Seed missing Tags from Model"}
            </Button>
          </div>

          {note ? (
            <p className="rounded border border-ok/30 bg-ok/10 px-2 py-1 text-xs text-ok">
              {note}
            </p>
          ) : null}
          {error ? (
            <p className="rounded border border-bad/30 bg-bad/10 px-2 py-1 text-xs text-bad">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </Panel>
  );
}
