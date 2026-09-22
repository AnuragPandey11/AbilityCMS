/**
 * Everything the platform knows about one Device, in one panel.
 *
 * ── Why it is one component and not five screens ────────────────────────────
 * The question after clicking a box in a diagram, a card in a carousel or a row
 * in the health table is always the same — *what is this thing and why is it
 * behaving like that* — and answering it used to mean visiting the Device list
 * for its identity, Tag Mapping for what it publishes, Device Health for
 * whether it is reporting, and the time-series explorer for its history. Four
 * screens, three of them administrative, to answer one question an operator has
 * while looking at a diagram.
 *
 * So this collects all of it: identity and model, the three groupings, the
 * topic, health, **every Tag the Device is bound to with its live value**, and
 * a chart of any one of them. Nothing here is new information — it is the same
 * endpoints the admin screens read, arranged around the Device rather than
 * around the table.
 *
 * ── The rules it inherits ───────────────────────────────────────────────────
 * - **Silence is not zero.** A Tag with no value renders "—". Zero is a claim
 *   about the equipment; silence is the absence of one.
 * - **Units come from the catalogue, never from a Tag's name** (§4.1). The
 *   client's own schedule mixes kWh and MWh inside one Device.
 * - **A `status` Tag is a contact, not a number** (§4.5). Drawn as a state,
 *   because plotting a trip contact as 1.00 hides the only thing that matters
 *   about it.
 * - **The three groupings stay three rows** (MASTER §3.4). "Feeds into", "sits
 *   in" and "transmitted by" are different facts; collapsing any two makes both
 *   unanswerable.
 * - **A Collector is named, never linked.** It is not a Device, so there is
 *   nothing to navigate to.
 */

import { useMemo, useState } from "react";
import type {
  Binding,
  DeviceDetail,
  DeviceListItem,
  Tag,
  TagCategory,
} from "@/api/schemas";
import {
  useBindings,
  useDevice,
  useReadings,
  useTagsById,
  useUnmappedKeys,
} from "@/api/hooks";
import { useLatestValues } from "@/api/useLatestValues";
import { DeviceArt } from "./DeviceArt";
import { Badge, Panel } from "@/components/ui";
import { CommStatusBadge } from "@/components/domain";
import { TrendChart } from "@/components/charts/TrendChart";
import { Skeleton } from "@/components/state";
import {
  IconClock,
  IconCollector,
  IconGauge,
  IconSignal,
  IconWarning,
  IconWiring,
} from "@/components/icons";
import { UNDEFINED_DISPLAY, formatDigital, formatValue, isDigital } from "@/format/value";
import { formatAge, formatDate, formatDateTime, ageSeconds } from "@/format/datetime";

/** Category order: what an operator looks at first, first. */
const CATEGORY_ORDER: TagCategory[] = [
  "performance",
  "electrical",
  "environmental",
  "status",
  "diagnostic",
];

const CATEGORY_LABEL: Record<string, string> = {
  performance: "Performance",
  electrical: "Electrical",
  environmental: "Environmental",
  status: "Status contacts",
  diagnostic: "Diagnostic",
};

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3 py-1 text-[11px]">
      <dt className="shrink-0 text-ink-faint" title={hint}>
        {label}
      </dt>
      <dd className="min-w-0 break-words text-right text-ink">{children}</dd>
    </div>
  );
}

const dash = (value: unknown): React.ReactNode =>
  value === null || value === undefined || value === "" ? (
    <span className="text-ink-faint">{UNDEFINED_DISPLAY}</span>
  ) : (
    String(value)
  );

/** A section heading inside the inspector. */
function Section({
  icon: Icon,
  title,
  note,
  children,
}: {
  icon: typeof IconGauge;
  title: string;
  note?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section>
      <h3 className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
        <span className="flex h-5 w-5 items-center justify-center rounded bg-accent/10 text-accent">
          <Icon size={12} />
        </span>
        {title}
      </h3>
      {note ? <p className="mb-1.5 text-[10px] leading-snug text-ink-faint">{note}</p> : null}
      {children}
    </section>
  );
}

export function DeviceInspector({
  device,
  values,
  timezone,
  /** Resolves `parent_device_id` / `reports_via_device_id` to a code. */
  deviceLookup,
}: {
  device: DeviceListItem;
  /** Live frame merged over the last stored reading, keyed by tag id (§5.1). */
  values: Record<string, number> | undefined;
  timezone: string;
  deviceLookup?: Map<number, DeviceListItem>;
}): JSX.Element {
  const tagsById = useTagsById();
  // The list endpoint carries most of a Device but not its model, serial or
  // installation date — those come from the detail endpoint, and the panel is
  // useful before they land rather than blocking on them.
  const detailQuery = useDevice(device.id);
  const bindingsQuery = useBindings(device.id);
  const detail = detailQuery.data as DeviceDetail | undefined;
  /**
   * Payload keys arriving that no binding maps.
   *
   * Rendered **only when there are any**. On a correctly mapped Device this is
   * empty, and a section that says "nothing is wrong" on every Device is a
   * section people stop reading — which is precisely when it would matter, the
   * day equipment starts publishing a key nobody has mapped and its value is
   * being discarded on every message.
   */
  const unmappedQuery = useUnmappedKeys(device.id);
  // The endpoint unwraps the envelope, so this is already the key array.
  const unmapped = unmappedQuery.data ?? [];
  // Memoised: `?? []` makes a fresh array on every render, which would
  // recompute both groupings on every paint.
  const bindings = useMemo(() => bindingsQuery.data ?? [], [bindingsQuery.data]);

  /**
   * Which Tag the chart is showing.
   *
   * `null` until the operator picks one — this panel is opened to see *what* a
   * Device is doing far more often than to see one signal's history, and a
   * chart that fetches on open costs a request per click for a view most of
   * them never look at.
   */
  const [chartTagId, setChartTagId] = useState<number | null>(null);

  /**
   * The last stored value for **every** Tag this Device is bound to.
   *
   * The `values` passed in come from whatever opened this panel — a card, which
   * carries only the handful of figures its Device Type curates. Rendering the
   * full signal list against that made an Inverter read "6 of 18 reporting" and
   * showed twelve dashes on a machine that was publishing all eighteen. The
   * dashes were about the *caller's* query, not about the equipment, which is
   * exactly the reading an operator must never be given.
   *
   * One request for one Device over its own Tags. The live frame still wins per
   * Tag, so anything arriving on the socket is fresher than this.
   */
  const ownValues = useLatestValues(
    [device.id],
    bindings.map((binding) => binding.tag_id),
    bindings.length > 0,
  );
  const merged = useMemo(
    () => ({ ...ownValues.byDevice[device.id], ...values }),
    [ownValues.byDevice, device.id, values],
  );

  /** Bindings grouped by their Tag's category, in the order above. */
  const groups = useMemo(() => {
    const byCategory = new Map<string, { binding: Binding; tag: Tag | undefined }[]>();
    for (const binding of bindings) {
      const tag = tagsById.get(binding.tag_id);
      const category = tag?.category ?? "diagnostic";
      const bucket = byCategory.get(category);
      const entry = { binding, tag };
      if (bucket) bucket.push(entry);
      else byCategory.set(category, [entry]);
    }
    for (const entries of byCategory.values()) {
      entries.sort((a, b) => a.binding.tag_code.localeCompare(b.binding.tag_code));
    }
    return CATEGORY_ORDER.filter((category) => byCategory.has(category)).map((category) => ({
      category,
      entries: byCategory.get(category)!,
    }));
  }, [bindings, tagsById]);

  /** Tags that can be charted: anything that is not a two-state contact. */
  const chartable = useMemo(
    () =>
      bindings
        .map((binding) => ({ binding, tag: tagsById.get(binding.tag_id) }))
        .filter(({ tag }) => tag !== undefined && !isDigital(tag))
        .sort((a, b) => a.binding.tag_code.localeCompare(b.binding.tag_code)),
    [bindings, tagsById],
  );

  const age = ageSeconds(device.last_seen_at);
  const parent = device.parent_device_id
    ? deviceLookup?.get(device.parent_device_id)
    : undefined;
  const relay = device.reports_via_device_id
    ? deviceLookup?.get(device.reports_via_device_id)
    : undefined;

  // 24 hours of the selected Tag. Anchored to the minute so the query key is
  // stable and the chart is not refetched on every render.
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const readingsQuery = useReadings(
    {
      deviceIds: [device.id],
      tagIds: chartTagId === null ? [] : [chartTagId],
      from: new Date(now - 24 * 3_600_000).toISOString(),
      to: new Date(now).toISOString(),
      resolution: "agg_15m",
    },
    chartTagId !== null,
  );
  const chartTag = chartTagId === null ? undefined : tagsById.get(chartTagId);

  const boundCount = bindings.length;
  const reportingCount = bindings.filter(
    (binding) => merged[String(binding.tag_id)] !== undefined,
  ).length;

  return (
    <div className="space-y-4">
      {/* ── Identity ─────────────────────────────────────────────────────── */}
      <div className="surface-tile flex items-start gap-3 rounded-card border border-line p-3">
        <DeviceArt typeCode={device.type_code} size={76} />
        <dl className="min-w-0 flex-1">
          <Row label="Type">{device.type_name ?? device.type_code}</Row>
          <Row label="Model">
            {detailQuery.isLoading ? (
              <Skeleton className="ml-auto h-3 w-24" />
            ) : device.model_code ? (
              `${device.manufacturer ? `${device.manufacturer} ` : ""}${device.model_code}`
            ) : (
              dash(null)
            )}
          </Row>
          <Row label="Serial">{dash(detail?.serial_number ?? device.serial_number)}</Row>
          <Row
            label="Rated"
            hint="Nameplate capacity. Absent is not zero — no rated capacity and a rated capacity of zero are different statements about a machine."
          >
            {detail?.rated_capacity_kw != null
              ? formatValue(detail.rated_capacity_kw, "kW")
              : dash(null)}
          </Row>
          {device.variant ? <Row label="Variant">{device.variant}</Row> : null}
          <Row
            label="Strings"
            hint="How many inputs of the Model's repeating group this unit has. A fact about the unit, not the Model — with none recorded, none of the group is bound."
          >
            {dash(detail?.string_count ?? device.string_count)}
          </Row>
          <Row label="Installed">
            {detail?.installed_on ? formatDate(detail.installed_on, timezone) : dash(null)}
          </Row>
        </dl>
      </div>

      {/* ── Communication ────────────────────────────────────────────────── */}
      <Section
        icon={IconSignal}
        title="Communication"
        note="Whether we can hear this Device. Never whether the equipment is working — absence alone proves neither."
      >
        <dl className="divide-y divide-line-soft">
          <Row label="Status">
            <CommStatusBadge status={device.comm_status} />
          </Row>
          <Row label="Last seen">
            {device.last_seen_at ? (
              <span title={formatDateTime(device.last_seen_at, timezone)}>
                {age === null ? dash(null) : formatAge(age)}
              </span>
            ) : (
              <span className="text-ink-faint">never</span>
            )}
          </Row>
          <Row
            label="Expected interval"
            hint="Registered from measurement, never from a default. The health sweep calls a Device degraded at twice this, so a stale value here flags healthy equipment."
          >
            {device.expected_interval_s}s
          </Row>
          <Row
            label="Completeness 24h"
            hint="Share of the messages this Device was expected to send in the last day that arrived."
          >
            {detail?.completeness_24h != null
              ? `${(detail.completeness_24h * 100).toFixed(1)}%`
              : dash(device.completeness_24h)}
          </Row>
          <Row
            label="Frozen Tags"
            hint="Tags whose value has not changed for long enough to suspect a stuck sensor rather than a steady one."
          >
            {(detail?.frozen_tag_count ?? device.frozen_tag_count) ? (
              <span className="text-warn">{detail?.frozen_tag_count ?? device.frozen_tag_count}</span>
            ) : (
              "0"
            )}
          </Row>
          <Row
            label="Topic"
            hint="The MQTT topic is the sole authority for this Device's origin (Guardrail 5). Everything about where it sits is read from here."
          >
            {device.source_address ? (
              <code className="break-all font-mono text-[10px] text-ink-muted">
                {device.source_address}
              </code>
            ) : (
              <span className="text-ink-faint">not registered against a topic</span>
            )}
          </Row>
        </dl>
      </Section>

      {/* ── The three groupings ──────────────────────────────────────────── */}
      <Section
        icon={IconWiring}
        title="Placement"
        note="Three independent facts. Collapsing any two of them makes both unanswerable — which is why they are three rows."
      >
        <dl className="divide-y divide-line-soft">
          <Row
            label="Feeds into"
            hint="Electrical: what this Device is wired into. Set only in Wiring & Diagram, never inferred from the topic or the payload."
          >
            {device.parent_device_id ? (
              (parent?.code ?? `#${device.parent_device_id}`)
            ) : device.collector_code ? (
              <span className="text-ink-faint" title="A Device inside an enclosure has no edge of its own — the room owns the one that exists (Guardrail 20).">
                via its Collector
              </span>
            ) : (
              <span className="text-ink-faint">not wired</span>
            )}
          </Row>
          <Row
            label="Sits in"
            hint="The enclosure named by the topic's collector segment. A Collector is a room, not a component — it is never a node in the diagram (Guardrail 12)."
          >
            {device.collector_code ? (
              <span className="inline-flex items-center gap-1">
                <IconCollector size={12} className="text-ink-faint" />
                {device.collector_code}
              </span>
            ) : (
              <span className="text-ink-faint" title="A five-segment topic states there is no enclosure. That is a real answer, not a gap.">
                no enclosure
              </span>
            )}
          </Row>
          <Row
            label="Reports via"
            hint="Communication: what transmits this Device. A failure here is communication loss, not equipment downtime — without this distinction a failed datalogger is recorded as generation downtime."
          >
            {device.reports_via_device_id ? (
              (relay?.code ?? `#${device.reports_via_device_id}`)
            ) : (
              <span className="text-ink-faint">direct</span>
            )}
          </Row>
          <Row label="In power path">
            {device.in_power_path ? (
              <Badge tone="neutral">carries current</Badge>
            ) : (
              <Badge tone="neutral" title="Real, monitored equipment that carries no current — it is drawn in the diagram but has no place in the electrical tree.">
                no current
              </Badge>
            )}
          </Row>
          <Row label="SLD stage">
            {dash(device.sld_stage_override ?? device.sld_stage)}
            {device.sld_stage_override ? (
              <Badge tone="warn" title="A per-Device correction accepted against this Type's default. Expected to be empty.">
                override
              </Badge>
            ) : null}
          </Row>
        </dl>
      </Section>

      {/* ── Every Tag ────────────────────────────────────────────────────── */}
      <Section
        icon={IconGauge}
        title={`Signals — ${boundCount}`}
        note={
          boundCount === 0
            ? undefined
            : `${reportingCount} of ${boundCount} reporting a value. A Tag with no value shows "—": silence is not zero.`
        }
      >
        {bindingsQuery.isLoading ? (
          <div className="space-y-1">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : boundCount === 0 ? (
          <p className="text-[11px] leading-snug text-ink-faint">
            This Device has no Tag bindings, so every message it sends decodes into nothing.
            It will appear registered, healthy and online while carrying no readable value at
            all. Map its payload keys in Tag Mapping.
          </p>
        ) : (
          <div className="space-y-3">
            {groups.map(({ category, entries }) => (
              <div key={category}>
                <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-faint">
                  {CATEGORY_LABEL[category] ?? category}
                </div>
                <dl className="divide-y divide-line-soft">
                  {entries.map(({ binding, tag }) => {
                    const value = merged[String(binding.tag_id)];
                    const digital = isDigital(tag);
                    return (
                      <div
                        key={binding.id}
                        className="flex items-center justify-between gap-2 py-1"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-[11px] text-ink" title={tag?.name}>
                            {binding.tag_code}
                          </div>
                          <div className="truncate text-[9px] text-ink-faint">
                            {/* The payload key this Tag is mapped from. It is
                                the thing to quote when a value looks wrong,
                                and it lives on the admin screen otherwise. */}
                            key <code className="font-mono">{binding.source_key}</code>
                            {binding.scale !== 1 ? ` · ×${binding.scale}` : ""}
                            {binding.valid_min !== null && binding.valid_max !== null
                              ? ` · valid ${binding.valid_min}…${binding.valid_max}`
                              : ""}
                            {!binding.enabled ? " · disabled" : ""}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {digital ? (
                            /*
                              A Digital Input is a contact, not a quantity
                              (§4.5). It is drawn as a state with a lamp: a
                              trip contact rendered as "1.00" hides the only
                              thing that matters about it, which is that it
                              changed.
                            */
                            <span className="flex items-center gap-1.5">
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${
                                  value === undefined
                                    ? "bg-ink-faint"
                                    : value !== 0
                                      ? "bg-ok"
                                      : "bg-ink-faint"
                                }`}
                              />
                              <span
                                className={`text-[11px] ${
                                  value === undefined ? "text-ink-faint" : "text-ink"
                                }`}
                              >
                                {value === undefined
                                  ? UNDEFINED_DISPLAY
                                  : formatDigital(value)}
                              </span>
                            </span>
                          ) : (
                            <span
                              className={`font-mono text-[11px] tabular-nums ${
                                value === undefined ? "text-ink-faint" : "text-ink"
                              }`}
                            >
                              {value === undefined
                                ? UNDEFINED_DISPLAY
                                : formatValue(value, binding.unit)}
                            </span>
                          )}
                          {!digital ? (
                            <button
                              type="button"
                              onClick={() =>
                                setChartTagId((current) =>
                                  current === binding.tag_id ? null : binding.tag_id,
                                )
                              }
                              title={`Chart ${binding.tag_code} over the last 24 hours`}
                              aria-pressed={chartTagId === binding.tag_id}
                              className={`rounded border px-1 py-0.5 text-[9px] transition ${
                                chartTagId === binding.tag_id
                                  ? "border-accent/50 bg-accent/10 text-accent"
                                  : "border-line text-ink-faint hover:text-ink"
                              }`}
                            >
                              chart
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </dl>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* ── Keys arriving that nothing maps ──────────────────────────────── */}
      {unmapped.length > 0 ? (
        <Section
          icon={IconWarning}
          title={`Unmapped keys — ${unmapped.length}`}
          note="This Device is publishing these, and nothing is bound to them — their values are discarded on every message. Map them in Tag Mapping."
        >
          <ul className="divide-y divide-line-soft">
            {unmapped.map((key) => (
              <li
                key={key.source_key}
                className="flex items-center justify-between gap-2 py-1 text-[11px]"
              >
                <code className="font-mono text-ink">{key.source_key}</code>
                {key.suggested_tag_code ? (
                  <span className="text-ink-faint">
                    looks like{" "}
                    <span className="text-ink-muted">{key.suggested_tag_code}</span>
                  </span>
                ) : (
                  <span
                    className="text-ink-faint"
                    title="No Tag in the catalogue resembles this key. It may be a signal the platform has no Tag for yet."
                  >
                    no suggestion
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {/* ── History for one signal ───────────────────────────────────────── */}
      {chartable.length > 0 ? (
        <Section
          icon={IconClock}
          title="History"
          note="The last 24 hours of one signal, from this Device alone. Pick a signal with the chart button beside it."
        >
          {chartTagId === null ? (
            <p className="text-[11px] text-ink-faint">
              No signal selected. {chartable.length} of this Device&rsquo;s{" "}
              {boundCount} Tags can be charted — the rest are two-state contacts, which are
              shown as states above because plotting a trip contact as a number hides the
              only thing that matters about it.
            </p>
          ) : readingsQuery.isError ? (
            <p className="text-[11px] text-bad">
              That range could not be read. Narrow it, or try another signal.
            </p>
          ) : (
            <TrendChart
              points={(readingsQuery.data?.items ?? []).map((point) => ({
                at: point.bucket,
                value: point.quality === 0 || point.quality === null ? point.value : null,
                contributors: 1,
              }))}
              unit={chartTag?.unit ?? null}
              label={chartTag?.name ?? String(chartTagId)}
              tier={readingsQuery.data?.tier ?? null}
              provenance={device.code}
              timezone={timezone}
              height={168}
              isLoading={readingsQuery.isLoading}
              flaggedCount={
                (readingsQuery.data?.items ?? []).filter(
                  (point) => point.quality !== null && point.quality !== 0,
                ).length
              }
            />
          )}
        </Section>
      ) : null}
    </div>
  );
}

/** The same panel, wrapped for a page that is not already inside a drawer. */
export function DeviceInspectorPanel(
  props: Parameters<typeof DeviceInspector>[0],
): JSX.Element {
  return (
    <Panel title={`${props.device.code} — ${props.device.name}`}>
      <DeviceInspector {...props} />
    </Panel>
  );
}
