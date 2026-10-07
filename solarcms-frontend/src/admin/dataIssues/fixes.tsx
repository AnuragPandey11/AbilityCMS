/**
 * One row of the Data Issues screen: what is wrong with this Device, and the
 * smallest control that fixes it.
 *
 * Every control calls the route that already owns the change — a binding, a
 * topic, the Device, the Plant — so it is refused by the same checks and
 * audited the same way as the screen that owns it. Where nothing here can fix
 * it (a Device that stopped, a value the equipment sends empty) the row says
 * so and offers only to mark it as known.
 */

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import * as dataIssuesApi from "@/api/endpoints/dataIssues";
import * as devicesApi from "@/api/endpoints/devices";
import * as discoveryApi from "@/api/endpoints/discovery";
import * as plantsApi from "@/api/endpoints/plants";
import type { DataIssue } from "@/api/endpoints/dataIssues";
import type { DeviceModel, Tag } from "@/api/schemas";
import { Button } from "@/components/ui";
import { formatAge, formatDateTime } from "@/format/datetime";
import {
  bool, bursts, num, numbers, plain, sample, str, strings, topics,
} from "./kinds";
import type { IssueActions } from "./useIssueActions";

export interface FixContext {
  plantId: number;
  timezone: string;
  models: DeviceModel[];
  tags: Tag[];
  actions: IssueActions;
  /** Holds `plant.manage`: register, attach, move, and edit Devices. */
  canManage: boolean;
  /** Holds `system.admin`: may add a Tag to the platform's catalogue. */
  canCreateTag: boolean;
  /** Open the new-Tag form; `onCreated` receives the new Tag's code. */
  createTag: (suggestedCode: string, onCreated: (code: string) => void) => void;
}

/**
 * A compact field. Not `inputClass`: that carries `w-full`, and when two width
 * utilities sit on one element Tailwind's stylesheet order decides, not the
 * class string — `w-full` won, and every compact field stretched to the row.
 * So this has no width, and every use states its own.
 */
export const compactInput =
  "h-8 rounded-control border border-line bg-surface-raised px-2 py-1 text-xs text-ink " +
  "placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 " +
  "focus:ring-accent/20 disabled:opacity-50";

const ago = (iso: string | null): string =>
  iso ? formatAge((Date.now() - Date.parse(iso)) / 1000) : "—";

// ── What the row says ───────────────────────────────────────────────────────

/** The row's own facts, one line, without repeating the card's heading. */
export function RowSummary({ issue, timezone }: { issue: DataIssue; timezone: string }): JSX.Element {
  const unit = str(issue, "unit");
  switch (issue.kind) {
    case "unregistered_topic":
    case "topic_moved":
    case "string_topic_unattached":
      return (
        <>
          <Topic value={str(issue, "topic")} />
          <Muted>
            {strings(issue, "keys").length} reading(s) · every ~{plain(num(issue, "interval_s"))} s ·
            last {ago(str(issue, "last_seen"))}
            {issue.kind === "topic_moved" ? <> · was <Mono>{str(issue, "old_topic") ?? "no topic"}</Mono></> : null}
          </Muted>
        </>
      );
    case "unregistered_strings":
      return (
        <>
          {topics(issue).map((t) => <Topic key={t.topic} value={t.topic} />)}
          <Muted>Carries the PV string readings of {str(issue, "owner_code")}.</Muted>
        </>
      );
    case "key_renamed":
      return (
        <Line>
          <Mono>{str(issue, "source_key")}</Mono> → <Mono>{str(issue, "new_key")}</Mono>, both meaning{" "}
          <Mono>{str(issue, "tag_code")}</Mono>
          <Muted inline>latest {sample(issue.facts.sample)}</Muted>
        </Line>
      );
    case "unmapped_key":
      return (
        <Line>
          <Mono>{str(issue, "source_key")}</Mono> = {sample(issue.facts.sample)}
          {str(issue, "suggested_tag_code") ? (
            <Muted inline>
              usually {str(issue, "suggested_tag_code")}
              {str(issue, "suggested_taken_by")
                ? `, already read from ${str(issue, "suggested_taken_by") ?? ""}`
                : ""}
            </Muted>
          ) : (
            <Muted inline>no Tag in the catalogue matches its name</Muted>
          )}
        </Line>
      );
    case "strings_not_arriving":
      return (
        <Line>
          Inputs {numbers(issue, "inputs").join(", ")}
          <Muted inline>{strings(issue, "keys").length} mapped reading(s) missing</Muted>
        </Line>
      );
    case "binding_silent":
      return (
        <Line>
          <Mono>{str(issue, "source_key")}</Mono> → <Mono>{str(issue, "tag_code")}</Mono>
          <Muted inline>not in the recent messages</Muted>
        </Line>
      );
    case "values_rejected": {
      const outOfRange = num(issue, "out_of_range") ?? 0;
      const empty = num(issue, "unparseable") ?? 0;
      return (
        <>
          <Line>
            <Mono>{str(issue, "tag_code")}</Mono>: {num(issue, "rejected")} of {num(issue, "total")} recent
            values rejected
            {bool(issue, "latest_rejected") ? <Muted inline>including the latest</Muted> : null}
          </Line>
          <Muted>
            {outOfRange > 0
              ? `Arrived as ${plain(num(issue, "flagged_min"))}${
                  num(issue, "flagged_max") !== num(issue, "flagged_min")
                    ? ` to ${plain(num(issue, "flagged_max"))}`
                    : ""
                }${unit ? ` ${unit}` : ""}; allowed ${plain(num(issue, "valid_min"))} to ${plain(
                  num(issue, "valid_max"),
                )}${unit ? ` ${unit}` : ""}.`
              : ""}
            {empty > 0 ? ` ${empty} arrived empty or not a number.` : ""}
            {bool(issue, "derived") ? " Calculated by the platform from other readings." : ""}
          </Muted>
        </>
      );
    }
    case "interval_slower":
    case "interval_faster":
      return (
        <Line>
          Recorded every {num(issue, "expected_interval_s")} s, actually every ~
          {num(issue, "measured_interval_s")} s
        </Line>
      );
    case "device_silent":
      return (
        <>
          <Line>Last heard {ago(str(issue, "last_heard"))}</Line>
          <Topic value={str(issue, "topic")} />
        </>
      );
    case "plant_silent":
      return <Line>{num(issue, "devices")} Device(s), none sending</Line>;
    case "replay_burst":
      return (
        <ul className="mt-0.5 space-y-0.5">
          {bursts(issue).map((burst) => (
            <li key={burst.minute} className="text-xs text-ink">
              {formatDateTime(burst.minute, timezone).slice(0, 16)} —{" "}
              <span className="tabular-nums">{burst.messages}</span> messages from {burst.topics} topic(s)
            </li>
          ))}
        </ul>
      );
    case "string_count_missing":
      return (
        <Line>
          Sends {num(issue, "inputs_sent")} string inputs
          <Muted inline>{num(issue, "inputs_with_current")} carried current in the last day</Muted>
        </Line>
      );
    case "isStringshidden":
      return (
        <Line>
          Count is {num(issue, "string_count")}, but input(s) {numbers(issue, "hidden").join(", ")} carry current
        </Line>
      );
    case "string_count_high":
      return (
        <Line>
          Count is {num(issue, "string_count")}, only {num(issue, "inputs_sent")} inputs arrive
        </Line>
      );
    case "inverter_type_missing":
      return (
        <Line>
          {bool(issue, "sends_strings")
            ? "Reports PV string inputs of its own — the way a string inverter reports."
            : "Its messages do not say which type it is."}
        </Line>
      );
    case "inverter_capacity_missing":
      return <Line>No rated kW recorded</Line>;
    case "plant_capacity_missing":
      return (
        <Line>
          DC {plain(num(issue, "dc_capacity_kwp"))} kWp · AC {plain(num(issue, "ac_capacity_kw"))} kW
        </Line>
      );
    default:
      return <Line>{issue.title}</Line>;
  }
}

function Line({ children }: { children: React.ReactNode }): JSX.Element {
  return <p className="text-sm leading-snug text-ink">{children}</p>;
}

function Muted({ children, inline = false }: { children: React.ReactNode; inline?: boolean }): JSX.Element {
  return inline ? (
    <span className="ml-1.5 text-xs text-ink-muted">· {children}</span>
  ) : (
    <p className="mt-0.5 text-xs leading-snug text-ink-muted">{children}</p>
  );
}

function Mono({ children }: { children: React.ReactNode }): JSX.Element {
  return <span className="font-mono text-[12px]">{children}</span>;
}

/** A topic wraps rather than truncates: the end — the Device code — is what is read. */
function Topic({ value }: { value: string | null }): JSX.Element | null {
  if (!value) return null;
  return <p className="break-all font-mono text-[11px] leading-snug text-ink-muted">{value}</p>;
}

// ── What the row can do ─────────────────────────────────────────────────────

/** Fixed by editing mappings alone — `config.modify`, which the screen itself needs. */
const MAPPING_ONLY = new Set([
  "unmapped_key", "key_renamed", "binding_silent", "strings_not_arriving", "values_rejected",
  "replay_burst", "plant_silent",
]);

export function RowFix({ issue, ctx }: { issue: DataIssue; ctx: FixContext }): JSX.Element | null {
  const busy = Boolean(ctx.actions.busy[issue.key]);
  if (!ctx.canManage && !MAPPING_ONLY.has(issue.kind)) {
    return (
      <span className="text-xs text-ink-faint">Fixing this needs the plant.manage permission.</span>
    );
  }
  switch (issue.kind) {
    case "unregistered_topic":
      return <RegisterFix issue={issue} ctx={ctx} busy={busy} />;
    case "unregistered_strings":
      return <RegisterFix issue={issue} ctx={ctx} busy={busy} />;
    case "string_topic_unattached": {
      const owner = num(issue, "owner_device_id");
      const topic = str(issue, "topic");
      return (
        <Button
          variant="primary"
          disabled={busy || owner === null || topic === null}
          onClick={() =>
            void ctx.actions.run([issue.key], async () => {
              await devicesApi.addDeviceTopic(owner as number, topic as string, "Attached from Data Issues");
            }, `Attached to ${str(issue, "owner_code") ?? "its Inverter"}.`)
          }
        >
          {busy ? "Attaching…" : `Attach to ${str(issue, "owner_code") ?? "its Inverter"}`}
        </Button>
      );
    }
    case "topic_moved":
      return <MoveFix issue={issue} ctx={ctx} busy={busy} />;
    case "key_renamed": {
      const deviceId = issue.device_id;
      const bindingId = num(issue, "binding_id");
      const newKey = str(issue, "new_key");
      return (
        <Button
          variant="primary"
          disabled={busy || deviceId === null || bindingId === null || newKey === null}
          onClick={() =>
            void ctx.actions.run([issue.key], async () => {
              await devicesApi.updateBinding(deviceId as number, bindingId as number, {
                source_key: newKey as string,
              });
            }, `Now reading ${str(issue, "tag_code") ?? "it"} from ${newKey ?? ""}.`)
          }
        >
          {busy ? "Renaming…" : `Read it from ${newKey ?? "the new name"}`}
        </Button>
      );
    }
    case "unmapped_key":
      return <MapKeyFix issue={issue} ctx={ctx} busy={busy} />;
    case "binding_silent": {
      const deviceId = issue.device_id;
      const bindingId = num(issue, "binding_id");
      return (
        <Button
          disabled={busy || deviceId === null || bindingId === null}
          title="The mapping is kept but switched off, and it can be switched back on in Tag Mapping."
          onClick={() =>
            void ctx.actions.run([issue.key], async () => {
              await devicesApi.updateBinding(deviceId as number, bindingId as number, { enabled: false });
            }, `${str(issue, "source_key") ?? "That reading"} is no longer expected.`)
          }
        >
          {busy ? "Saving…" : "Stop expecting it"}
        </Button>
      );
    }
    case "strings_not_arriving": {
      const deviceId = issue.device_id;
      const bindingIds = numbers(issue, "binding_ids");
      return (
        <Button
          disabled={busy || deviceId === null || bindingIds.length === 0}
          title="Switch these mappings off — for an Inverter that does not have these inputs. They can be switched back on in Tag Mapping."
          onClick={() =>
            void ctx.actions.run([issue.key], async () => {
              for (const bindingId of bindingIds) {
                await devicesApi.updateBinding(deviceId as number, bindingId, { enabled: false });
              }
            }, `${bindingIds.length} string readings are no longer expected on ${issue.device_code ?? "it"}.`)
          }
        >
          {busy ? "Saving…" : "Stop expecting them"}
        </Button>
      );
    }
    case "values_rejected":
      return bool(issue, "derived") || num(issue, "binding_id") === null ? null : (
        <RangeFix issue={issue} ctx={ctx} busy={busy} />
      );
    case "interval_slower":
    case "interval_faster": {
      const measured = num(issue, "measured_interval_s");
      const deviceId = issue.device_id;
      return (
        <Button
          variant="primary"
          disabled={busy || measured === null || deviceId === null}
          onClick={() =>
            void ctx.actions.run([issue.key], async () => {
              await devicesApi.updateDevice(deviceId as number, { expected_interval_s: measured as number });
            }, `Recorded interval set to ${measured ?? "—"} s.`)
          }
        >
          {busy ? "Saving…" : `Use ${measured ?? "—"} s`}
        </Button>
      );
    }
    case "string_count_missing":
    case "isStringshidden":
    case "string_count_high":
      return <StringCountFix issue={issue} ctx={ctx} busy={busy} />;
    case "inverter_type_missing":
      return <InverterTypeFix issue={issue} ctx={ctx} busy={busy} />;
    case "inverter_capacity_missing":
      return <NumberFix
        issue={issue} ctx={ctx} busy={busy} unit="kW" label="Rated size"
        initial={null}
        save={(value) => devicesApi.updateDevice(issue.device_id as number, { rated_capacity_kw: value })
          .then(() => undefined)}
        done={(value) => `${issue.device_code ?? "Inverter"} rated size set to ${value} kW.`}
      />;
    case "plant_capacity_missing":
      return <PlantCapacityFix issue={issue} ctx={ctx} busy={busy} />;
    case "device_silent":
      return (
        <Link to="/admin/plant-setup" className="text-xs font-medium text-accent hover:underline">
          Open in Plants &amp; Devices →
        </Link>
      );
    default:
      return null;
  }
}

/** Register a topic nobody registered — or, for string topics, their owner. */
function RegisterFix({ issue, ctx, busy }: { issue: DataIssue; ctx: FixContext; busy: boolean }): JSX.Element {
  const isStrings = issue.kind === "unregistered_strings";
  const ownerTopics = isStrings ? topics(issue) : [];
  const code = isStrings ? (str(issue, "owner_code") ?? "") : (str(issue, "device_code") ?? "");
  const suggestedType = str(issue, "suggested_type");
  const candidates = useMemo(
    () => (suggestedType ? ctx.models.filter((m) => m.device_type_code === suggestedType) : ctx.models),
    [ctx.models, suggestedType],
  );
  const [modelId, setModelId] = useState<number | null>(candidates[0]?.id ?? null);
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState("");

  if (bool(issue, "code_taken")) {
    return <DismissTopics issue={issue} ctx={ctx} busy={busy} />;
  }

  const register = (): void => {
    if (modelId === null) return;
    const primary = isStrings ? ownerTopics[0] : null;
    const topic = isStrings ? primary?.topic : str(issue, "topic");
    if (!topic) return;
    const keys = isStrings
      ? [...new Set(ownerTopics.flatMap((t) => t.keys))]
      : strings(issue, "keys");
    const interval = isStrings ? primary?.interval_s : num(issue, "interval_s");
    void ctx.actions.run([issue.key], async () => {
      const created = await devicesApi.createDevice(ctx.plantId, {
        code,
        name: code.replace(/[_-]+/g, " "),
        device_model_id: modelId,
        source_address: topic,
        // Read from the topic, never chosen — the topic decides the enclosure.
        collector_code: isStrings ? (primary?.collector_code ?? null) : str(issue, "collector_code"),
        // Measured, never the assumed default: health thresholds multiply it.
        expected_interval_s: Math.max(1, Math.round(interval ?? 60)),
        // What it sends, and only that. The Model's schedule would add every
        // signal it *could* send — each one then reported as stopped arriving.
        bind_from_model: keys.length === 0,
        observed_keys: keys,
      });
      for (const extra of ownerTopics.slice(1)) {
        await devicesApi.addDeviceTopic(created.id, extra.topic, "Attached when registered from Data Issues");
      }
    }, `${code} registered${isStrings && ownerTopics.length > 1 ? `, with ${ownerTopics.length} topics` : ""}.`);
  };

  return (
    <div className="flex w-full flex-wrap items-end gap-2 sm:w-auto">
      <label className="min-w-0 flex-1 basis-48 sm:flex-none">
        <span className="sr-only">Device Model for {code}</span>
        <select
          value={modelId ?? ""}
          onChange={(event) => setModelId(event.target.value ? Number(event.target.value) : null)}
          className={`${compactInput} w-full sm:w-56`}
          title="Decides the Device Type — and so how each reading's name is understood."
        >
          {candidates.length === 0 ? <option value="">No Device Model</option> : null}
          {candidates.map((model) => (
            <option key={model.id} value={model.id}>
              {model.device_type_code} — {model.model_code}
              {model.variant ? ` (${model.variant})` : ""}
            </option>
          ))}
        </select>
      </label>
      <Button variant="primary" disabled={busy || modelId === null} onClick={register}>
        {busy ? "Registering…" : `Register ${code}`}
      </Button>
      {dismissing ? (
        <span className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why (optional)"
            aria-label="Why dismiss it"
            className={`${compactInput} min-w-0 flex-1 sm:w-48 sm:flex-none`}
          />
          <Button
            disabled={busy}
            onClick={() =>
              void ctx.actions.run([issue.key], async () => {
                const all = isStrings ? ownerTopics.map((t) => t.topic) : [str(issue, "topic") ?? ""];
                for (const topic of all.filter(Boolean)) {
                  await discoveryApi.ignoreTopic(topic, reason.trim() || null);
                }
              }, "Dismissed. It can be brought back from discovery.")
            }
          >
            Dismiss
          </Button>
          <Button variant="ghost" onClick={() => setDismissing(false)}>Cancel</Button>
        </span>
      ) : (
        <Button
          variant="ghost"
          onClick={() => setDismissing(true)}
          title="Stop offering it for registration. Nothing is deleted, and it can be brought back."
        >
          Dismiss…
        </Button>
      )}
    </div>
  );
}

function DismissTopics({ issue, ctx, busy }: { issue: DataIssue; ctx: FixContext; busy: boolean }): JSX.Element {
  const topic = str(issue, "topic");
  return (
    <Button
      disabled={busy || topic === null}
      title="Stop offering it for registration. Nothing is deleted, and it can be brought back."
      onClick={() =>
        void ctx.actions.run([issue.key], async () => {
          await discoveryApi.ignoreTopic(topic as string, "Same name as a registered Device");
        }, "Dismissed. It can be brought back from discovery.")
      }
    >
      {busy ? "Dismissing…" : "Dismiss this topic"}
    </Button>
  );
}

function MoveFix({ issue, ctx, busy }: { issue: DataIssue; ctx: FixContext; busy: boolean }): JSX.Element {
  const topic = str(issue, "topic");
  const collector = str(issue, "collector_code");
  const deviceId = issue.device_id;
  return (
    <Button
      variant="primary"
      disabled={busy || topic === null || deviceId === null}
      onClick={() => {
        const ok = window.confirm(
          `Move ${issue.device_code ?? "this Device"} to\n${topic ?? ""}?\n\n` +
            "Its history stays with it, and new messages on the new topic are stored as its own.",
        );
        if (!ok) return;
        void ctx.actions.run([issue.key], async () => {
          // The topic decides the enclosure, so the Collector moves with it.
          await devicesApi.updateDevice(deviceId as number, collector
            ? { source_address: topic as string, collector_code: collector }
            : { source_address: topic as string, clear: ["collector_code"] });
        }, `${issue.device_code ?? "Device"} moved to its new topic.`);
      }}
    >
      {busy ? "Moving…" : "Move to the new topic"}
    </Button>
  );
}

const NEW_TAG = "__new__";

function MapKeyFix({ issue, ctx, busy }: { issue: DataIssue; ctx: FixContext; busy: boolean }): JSX.Element {
  const key = str(issue, "source_key") ?? "";
  const suggested = str(issue, "suggested_tag_code");
  const takenBy = str(issue, "suggested_taken_by");
  const takenBinding = num(issue, "suggested_binding_id");
  const [tagCode, setTagCode] = useState<string>(suggested && !takenBy ? suggested : "");
  const [scale, setScale] = useState("1");
  const deviceId = issue.device_id;

  const byCategory = useMemo(() => {
    const groups = new Map<string, Tag[]>();
    for (const tag of ctx.tags.filter((t) => t.formula === null)) {
      const list = groups.get(tag.category) ?? [];
      list.push(tag);
      groups.set(tag.category, list);
    }
    return [...groups].sort(([a], [b]) => a.localeCompare(b));
  }, [ctx.tags]);

  const scaleValue = Number(scale);
  const valid = tagCode !== "" && tagCode !== NEW_TAG && Number.isFinite(scaleValue) && scaleValue !== 0;

  return (
    <div className="flex w-full flex-wrap items-end gap-2 sm:w-auto">
      <label className="min-w-0 flex-1 basis-56 sm:flex-none">
        <span className="sr-only">Tag for {key}</span>
        <select
          value={tagCode}
          onChange={(event) => {
            const value = event.target.value;
            if (value === NEW_TAG) {
              ctx.createTag(key, (code) => setTagCode(code));
              return;
            }
            setTagCode(value);
          }}
          className={`${compactInput} w-full sm:w-64`}
        >
          <option value="">Map to a Tag…</option>
          {byCategory.map(([category, tags]) => (
            <optgroup key={category} label={category}>
              {tags.map((tag) => (
                <option key={tag.id} value={tag.code}>
                  {tag.code} · {tag.name} ({tag.unit})
                </option>
              ))}
            </optgroup>
          ))}
          {ctx.canCreateTag ? <option value={NEW_TAG}>＋ A new kind of reading…</option> : null}
        </select>
      </label>
      <label className="flex items-center gap-1 text-xs text-ink-muted" title="Each value is multiplied by this before it is stored. 1 when the equipment already sends the Tag's unit.">
        ×
        <input
          value={scale}
          onChange={(event) => setScale(event.target.value)}
          inputMode="decimal"
          aria-label={`Scale for ${key}`}
          className={`${compactInput} w-16`}
        />
      </label>
      <Button
        variant="primary"
        disabled={busy || !valid || deviceId === null}
        onClick={() =>
          void ctx.actions.run([issue.key], async () => {
            await devicesApi.addBinding(deviceId as number, {
              source_key: key, tag_code: tagCode, scale: scaleValue,
            });
          }, `${key} is now stored as ${tagCode}.`)
        }
      >
        {busy ? "Mapping…" : "Map"}
      </Button>
      {takenBy && takenBinding !== null && suggested ? (
        <Button
          disabled={busy || deviceId === null}
          title={`${suggested} is read from ${takenBy} now. This reads it from ${key} instead.`}
          onClick={() =>
            void ctx.actions.run([issue.key], async () => {
              await devicesApi.updateBinding(deviceId as number, takenBinding, { source_key: key });
            }, `${suggested} is now read from ${key}.`)
          }
        >
          Read {suggested} from {key} instead
        </Button>
      ) : null}
    </div>
  );
}

function RangeFix({ issue, ctx, busy }: { issue: DataIssue; ctx: FixContext; busy: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [scale, setScale] = useState(plain(num(issue, "scale") ?? 1));
  const [min, setMin] = useState(num(issue, "valid_min") === null ? "" : plain(num(issue, "valid_min")));
  const [max, setMax] = useState(num(issue, "valid_max") === null ? "" : plain(num(issue, "valid_max")));
  const deviceId = issue.device_id;
  const bindingId = num(issue, "binding_id");
  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} title="Change the scale or the allowed range of this mapping.">
        Adjust mapping…
      </Button>
    );
  }
  const parsed = {
    scale: Number(scale),
    valid_min: min.trim() === "" ? null : Number(min),
    valid_max: max.trim() === "" ? null : Number(max),
  };
  const valid =
    Number.isFinite(parsed.scale) && parsed.scale !== 0
    && (parsed.valid_min === null || Number.isFinite(parsed.valid_min))
    && (parsed.valid_max === null || Number.isFinite(parsed.valid_max))
    && (parsed.valid_min === null || parsed.valid_max === null || parsed.valid_min <= parsed.valid_max);
  const unit = str(issue, "unit") ?? "";
  return (
    <div className="flex w-full flex-wrap items-end gap-2">
      <NumberField label="Scale ×" value={scale} onChange={setScale} />
      <NumberField label={`Min ${unit}`} value={min} onChange={setMin} placeholder="none" />
      <NumberField label={`Max ${unit}`} value={max} onChange={setMax} placeholder="none" />
      <Button
        variant="primary"
        disabled={busy || !valid || deviceId === null || bindingId === null}
        onClick={() =>
          void ctx.actions.run([issue.key], async () => {
            await devicesApi.updateBinding(deviceId as number, bindingId as number, parsed);
          }, `${str(issue, "tag_code") ?? "Mapping"} updated. It applies to values from now on.`)
        }
      >
        {busy ? "Saving…" : "Save"}
      </Button>
      <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      <p className="w-full text-[11px] text-ink-faint">
        Applies to values from now on; values already stored keep how they were read.
      </p>
    </div>
  );
}

function NumberField({
  label, value, onChange, placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}): JSX.Element {
  return (
    <label className="flex min-w-[5.5rem] flex-1 flex-col gap-0.5 text-[11px] text-ink-muted sm:flex-none">
      {label}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode="decimal"
        placeholder={placeholder}
        className={`${compactInput} w-full sm:w-24`}
      />
    </label>
  );
}

function StringCountFix({ issue, ctx, busy }: { issue: DataIssue; ctx: FixContext; busy: boolean }): JSX.Element {
  const sent = num(issue, "inputs_sent");
  const hidden = numbers(issue, "hidden");
  const suggested = issue.kind === "isStringshidden" ? Math.max(sent ?? 0, ...hidden) : sent;
  return (
    <NumberFix
      issue={issue} ctx={ctx} busy={busy} label="Strings" unit=""
      initial={suggested}
      integer
      hint={sent !== null ? `What it sends: ${sent}` : undefined}
      save={(value) => devicesApi.updateDevice(issue.device_id as number, { string_count: value })
        .then(() => undefined)}
      done={(value) => `${issue.device_code ?? "Device"} set to ${value} strings.`}
    />
  );
}

function NumberFix({
  issue, ctx, busy, label, unit, initial, integer = false, hint, save, done,
}: {
  issue: DataIssue;
  ctx: FixContext;
  busy: boolean;
  label: string;
  unit: string;
  initial: number | null;
  integer?: boolean;
  hint?: string;
  save: (value: number) => Promise<void>;
  done: (value: number) => string;
}): JSX.Element {
  const [value, setValue] = useState(initial === null ? "" : String(initial));
  const parsed = Number(value);
  const valid = value.trim() !== "" && Number.isFinite(parsed) && parsed > 0
    && (!integer || Number.isInteger(parsed));
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-ink-muted" title={hint}>
        {label}
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          inputMode={integer ? "numeric" : "decimal"}
          aria-label={`${label} for ${issue.device_code ?? "this Device"}`}
          className={`${compactInput} w-20`}
        />
        {unit}
      </label>
      <Button
        variant="primary"
        disabled={busy || !valid || issue.device_id === null}
        onClick={() => void ctx.actions.run([issue.key], () => save(parsed), done(parsed))}
      >
        {busy ? "Saving…" : "Save"}
      </Button>
      {hint ? <span className="text-[11px] text-ink-faint">{hint}</span> : null}
    </div>
  );
}

/** The reference Model of the Inverter Type with this variant, for "String" / "Central". */
export function inverterModelFor(models: DeviceModel[], variant: "string" | "central"): DeviceModel | null {
  const matching = models.filter((m) => m.device_type_code === "INVERTER" && m.variant === variant);
  return matching.find((m) => m.model_code.startsWith("ref-")) ?? matching[0] ?? null;
}

function InverterTypeFix({ issue, ctx, busy }: { issue: DataIssue; ctx: FixContext; busy: boolean }): JSX.Element {
  const choices = (["string", "central"] as const)
    .map((variant) => ({ variant, model: inverterModelFor(ctx.models, variant) }))
    .filter((choice): choice is { variant: "string" | "central"; model: DeviceModel } => choice.model !== null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {choices.map(({ variant, model }) => (
        <Button
          key={variant}
          variant={variant === "string" && bool(issue, "sends_strings") ? "primary" : "secondary"}
          disabled={busy || issue.device_id === null}
          title={`Record it as ${model.model_code}. Its mappings are kept.`}
          onClick={() =>
            void ctx.actions.run([issue.key], async () => {
              await devicesApi.updateDevice(issue.device_id as number, { device_model_id: model.id });
            }, `${issue.device_code ?? "Inverter"} recorded as a ${variant} inverter.`)
          }
        >
          {variant === "string" ? "String inverter" : "Central inverter"}
        </Button>
      ))}
    </div>
  );
}

function PlantCapacityFix({ issue, ctx, busy }: { issue: DataIssue; ctx: FixContext; busy: boolean }): JSX.Element {
  const [dc, setDc] = useState(num(issue, "dc_capacity_kwp") === null ? "" : String(num(issue, "dc_capacity_kwp")));
  const [ac, setAc] = useState(num(issue, "ac_capacity_kw") === null ? "" : String(num(issue, "ac_capacity_kw")));
  const body: { dc_capacity_kwp?: number; ac_capacity_kw?: number } = {};
  if (dc.trim() !== "") body.dc_capacity_kwp = Number(dc);
  if (ac.trim() !== "") body.ac_capacity_kw = Number(ac);
  const values = Object.values(body);
  const valid = values.length > 0 && values.every((v) => Number.isFinite(v) && v > 0);
  return (
    <div className="flex w-full flex-wrap items-end gap-2 sm:w-auto">
      <NumberField label="DC kWp" value={dc} onChange={setDc} placeholder="not set" />
      <NumberField label="AC kW" value={ac} onChange={setAc} placeholder="not set" />
      <Button
        variant="primary"
        disabled={busy || !valid}
        onClick={() =>
          void ctx.actions.run([issue.key], async () => {
            await plantsApi.updatePlant(ctx.plantId, body);
          }, "Plant capacity saved.")
        }
      >
        {busy ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}

// ── Marking an issue as known ───────────────────────────────────────────────

/**
 * "This is known" — with who and why. Never deletes or hides the issue: it
 * moves to the Known list, and Undo brings it back.
 */
export function AckControl({
  issues, ctx, label = "Mark as known", defaultNote = "",
}: {
  issues: DataIssue[];
  ctx: FixContext;
  label?: string;
  defaultNote?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState(defaultNote);
  const keys = issues.map((issue) => issue.key);
  const busy = keys.some((key) => ctx.actions.busy[key]);
  if (!open) {
    return (
      <Button
        variant="ghost"
        onClick={() => setOpen(true)}
        title="Record that this is known and needs nothing from the platform — for example the client's equipment. It moves to the Known list, where it can be undone."
      >
        {label}
      </Button>
    );
  }
  return (
    <span className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
      <input
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Why — e.g. raised with the client"
        aria-label="Why it is known"
        className={`${compactInput} min-w-0 flex-1 sm:w-64 sm:flex-none`}
        autoFocus
      />
      <Button
        disabled={busy}
        onClick={() =>
          void ctx.actions.run(keys, async (key) => {
            await dataIssuesApi.acknowledge(ctx.plantId, key, note.trim() || null);
          }, issues.length > 1 ? `${issues.length} issues marked as known.` : "Marked as known.")
        }
      >
        {busy ? "Saving…" : issues.length > 1 ? `Mark ${issues.length} as known` : "Mark as known"}
      </Button>
      <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
    </span>
  );
}
