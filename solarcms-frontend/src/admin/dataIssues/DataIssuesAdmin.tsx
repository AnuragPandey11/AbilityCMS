/**
 * Data Issues — everything the broker sends that the platform cannot use or
 * does not trust, with the fix beside each one.
 *
 * ── Why one screen ──────────────────────────────────────────────────────────
 * Each of these failures used to be visible somewhere — an unmapped key in a
 * Device's inspector, an unregistered topic in Plants & Devices, a rejected
 * value as a gap in a chart — and noticed nowhere, because none of them errors:
 * a renamed key decodes to nothing and the Tag simply stops. Gathered here,
 * each is a named row, grouped by kind so seventeen Inverters with the same
 * problem are one card with one "fix all", and ordered by what ignoring it
 * costs: data being thrown away first, then data that cannot be trusted, then
 * setup that leaves a screen unable to answer.
 *
 * ── What it never does ─────────────────────────────────────────────────────
 * It decides nothing. A rename or a move is *proposed* by the server and made
 * by a person; every fix calls the route that already owns the change. Marking
 * an issue as known deletes nothing and hides nothing — it moves to the Known
 * list, and Undo brings it back.
 */

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  useDataIssues,
  useDataIssuesSummary,
  useDeviceModels,
  usePlant,
  useTags,
} from "@/api/hooks";
import * as dataIssuesApi from "@/api/endpoints/dataIssues";
import * as devicesApi from "@/api/endpoints/devices";
import * as discoveryApi from "@/api/endpoints/discovery";
import type { DataIssue, IssueCategory } from "@/api/endpoints/dataIssues";
import { usePermission } from "@/auth/usePermission";
import { usePlantScope } from "@/state/usePlantScope";
import { PlantPicker } from "@/components/domain";
import { Badge, Button, Panel } from "@/components/ui";
import { EmptyState, ErrorState, SkeletonPanel } from "@/components/state";
import { IconCheck } from "@/components/icons";
import { formatAge, formatDateTime, formatTime } from "@/format/datetime";
import { CATEGORIES, groupByKind, kindInfo, num, str, type IssueGroup } from "./kinds";
import {
  AckControl, RowFix, RowSummary, compactInput, inverterModelFor, type FixContext,
} from "./fixes";
import { NewTagDrawer } from "./NewTagDrawer";
import { useIssueActions } from "./useIssueActions";

type Tab = IssueCategory | "known";

const EMPTY_TAB: Record<IssueCategory, string> = {
  data_lost:
    "Nothing is being thrown away: every topic, reading and string arriving for this Plant is registered and mapped.",
  data_wrong: "Nothing looks wrong: no rejected values, intervals match what arrives, and no replayed backlogs.",
  setup: "Setup is complete for everything these checks look at.",
};

export function DataIssuesAdmin(): JSX.Element {
  const canManage = usePermission("plant.manage");
  const canCreateTag = usePermission("system.admin");
  const { plants, plantId, setPlantId } = usePlantScope();
  const plantQuery = usePlant(plantId);
  const issuesQuery = useDataIssues(plantId);
  const summaryQuery = useDataIssuesSummary();
  const modelsQuery = useDeviceModels();
  const tagsQuery = useTags();
  const actions = useIssueActions(plantId);
  const [chosenTab, setChosenTab] = useState<Tab | null>(null);
  const [newTag, setNewTag] = useState<{ code: string; onCreated: (code: string) => void } | null>(null);

  const timezone = plantQuery.data?.timezone ?? "Asia/Kolkata";
  const data = issuesQuery.data;
  const open = useMemo(() => (data?.issues ?? []).filter((i) => i.acknowledged === null), [data]);
  const known = useMemo(() => (data?.issues ?? []).filter((i) => i.acknowledged !== null), [data]);
  const counts = data?.counts;

  // The first category with something in it, until the reader picks one —
  // and back to that whenever the Plant changes.
  const autoTab: Tab =
    CATEGORIES.find((c) => (counts?.[c.value] ?? 0) > 0)?.value ?? "data_lost";
  const tab = chosenTab ?? autoTab;

  const ctx: FixContext | null = plantId === null ? null : {
    plantId,
    timezone,
    models: modelsQuery.data ?? [],
    tags: tagsQuery.data ?? [],
    actions,
    canManage,
    canCreateTag,
    createTag: (code, onCreated) => setNewTag({ code, onCreated }),
  };

  const groups = useMemo(
    () => (tab === "known" ? [] : groupByKind(open.filter((issue) => issue.category === tab))),
    [open, tab],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="page-title">Data Issues</h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-muted">
            What the broker is sending that the platform cannot use or does not trust — with the
            fix beside each one.
          </p>
        </div>
        <PlantPicker
          plants={plants}
          value={plantId}
          onChange={(id) => {
            setPlantId(id);
            setChosenTab(null);
            actions.clearDone();
          }}
          label="Plant"
          size="md"
        />
      </div>

      <FleetStrip
        current={plantId}
        onPick={(id) => {
          setPlantId(id);
          setChosenTab(null);
          actions.clearDone();
        }}
        summary={summaryQuery.data}
      />

      {summaryQuery.data && summaryQuery.data.unregistered_plants.length > 0 && ctx ? (
        <UnregisteredPlants summary={summaryQuery.data} ctx={ctx} />
      ) : null}

      {plantId === null ? (
        <EmptyState title="No Plants" detail="No Plants are visible to your account." />
      ) : issuesQuery.isLoading ? (
        <SkeletonPanel lines={8} />
      ) : issuesQuery.isError ? (
        <ErrorState error={issuesQuery.error} retry={() => void issuesQuery.refetch()} />
      ) : data && ctx && counts ? (
        <>
          <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Kind of issue">
            {CATEGORIES.map((category) => (
              <TabButton
                key={category.value}
                active={tab === category.value}
                onClick={() => setChosenTab(category.value)}
                label={category.label}
                count={counts[category.value]}
                tone={category.value === "setup" ? "neutral" : category.value === "data_lost" ? "bad" : "warn"}
              />
            ))}
            <TabButton
              active={tab === "known"}
              onClick={() => setChosenTab("known")}
              label="Known"
              count={counts.acknowledged}
              tone="neutral"
            />
            <span className="ml-auto flex items-center gap-2 text-[11px] text-ink-faint">
              Checked {formatTime(data.generated_at, timezone)}
              <button
                type="button"
                onClick={() => void issuesQuery.refetch()}
                className="rounded px-1 text-accent hover:underline disabled:opacity-50"
                disabled={issuesQuery.isFetching}
              >
                {issuesQuery.isFetching ? "Checking…" : "Re-check"}
              </button>
            </span>
          </div>

          {actions.done ? (
            <p
              role="status"
              className="flex items-start justify-between gap-3 rounded border border-ok/30 bg-ok/10 px-3 py-2 text-xs text-ok"
            >
              <span>{actions.done} The list updates as the next messages arrive.</span>
              <button type="button" onClick={actions.clearDone} className="shrink-0 hover:underline">
                Dismiss
              </button>
            </p>
          ) : null}

          {!data.can_see_unregistered ? (
            <p className="text-[11px] leading-relaxed text-ink-faint">
              Equipment publishing without being registered is visible to the platform administrator
              only, so it is not listed here.
            </p>
          ) : null}

          {tab === "known" ? (
            <KnownList issues={known} ctx={ctx} />
          ) : groups.length === 0 ? (
            <AllClear text={EMPTY_TAB[tab]} />
          ) : (
            groups.map((group) => <GroupCard key={group.kind} group={group} ctx={ctx} />)
          )}
        </>
      ) : null}

      {newTag ? (
        <NewTagDrawer
          suggestedCode={newTag.code}
          onClose={() => setNewTag(null)}
          onCreated={newTag.onCreated}
        />
      ) : null}
    </div>
  );
}

function TabButton({
  active, onClick, label, count, tone,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  tone: "bad" | "warn" | "neutral";
}): JSX.Element {
  const countTone =
    count === 0 ? "bg-surface-sunken text-ink-faint"
      : tone === "bad" ? "bg-bad/15 text-bad"
        : tone === "warn" ? "bg-warn/15 text-warn"
          : "bg-surface-sunken text-ink-muted";
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-control border px-3 py-1.5 text-xs font-medium transition ${
        active
          ? "border-accent bg-accent/10 text-accent"
          : "border-line bg-surface-raised text-ink-muted hover:text-ink"
      }`}
    >
      {label}
      <span className={`rounded px-1.5 text-[10px] font-semibold tabular-nums ${countTone}`}>{count}</span>
    </button>
  );
}

function AllClear({ text }: { text: string }): JSX.Element {
  return (
    <div className="surface-card flex items-start gap-3 rounded-card border border-line p-4">
      <span className="icon-well shrink-0">
        <IconCheck size={16} />
      </span>
      <p className="text-sm leading-relaxed text-ink-muted">{text}</p>
    </div>
  );
}

/** Every visible Plant with its open count, so the next one to look at is one click away. */
function FleetStrip({
  current, onPick, summary,
}: {
  current: number | null;
  onPick: (plantId: number) => void;
  summary: dataIssuesApi.DataIssuesSummary | undefined;
}): JSX.Element | null {
  if (!summary || summary.plants.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Open issues per Plant">
      {summary.plants.map((plant) => {
        const urgent = plant.counts.data_lost + plant.counts.data_wrong;
        const active = plant.plant_id === current;
        return (
          <button
            key={plant.plant_id}
            type="button"
            onClick={() => onPick(plant.plant_id)}
            aria-pressed={active}
            title={`${plant.name}: ${plant.counts.data_lost} lost, ${plant.counts.data_wrong} wrong, ${plant.counts.setup} setup`}
            className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition ${
              active ? "border-accent bg-accent/10 text-accent" : "border-line bg-surface-raised text-ink-muted hover:text-ink"
            }`}
          >
            <span className="truncate font-mono">{plant.code}</span>
            <span
              className={`rounded-full px-1.5 font-semibold tabular-nums ${
                plant.counts.data_lost > 0 ? "bg-bad/15 text-bad"
                  : urgent > 0 ? "bg-warn/15 text-warn"
                    : "bg-surface-sunken text-ink-faint"
              }`}
            >
              {urgent}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Client and Plant codes publishing that no registered Plant matches (platform administrator). */
function UnregisteredPlants({
  summary, ctx,
}: {
  summary: dataIssuesApi.DataIssuesSummary;
  ctx: FixContext;
}): JSX.Element {
  return (
    <Panel
      title="Publishing, with no Plant registered for it"
      subtitle="These Client and Plant codes are sending data that matches no registered Plant, so every message is thrown away."
    >
      <ul className="space-y-2">
        {summary.unregistered_plants.map((entry) => {
          const key = `plant:${entry.client_code}/${entry.plant_code}`;
          return (
            <li key={key} className="rounded-control border border-line bg-surface-sunken/40 p-3">
              <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
                <div className="min-w-0 flex-1 basis-64">
                  <p className="text-sm text-ink">
                    <span className="font-mono">{entry.client_code}</span> /{" "}
                    <span className="font-mono">{entry.plant_code}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {entry.topics.length} topic(s) · {entry.messages} message(s) · last{" "}
                    {formatAge((Date.now() - Date.parse(entry.last_seen)) / 1000)} ·{" "}
                    {entry.client_registered ? "the Client is registered" : "the Client is not registered either"}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to={entry.client_registered ? "/admin/plant-setup" : "/admin/onboarding"}
                    className="rounded-control border border-accent bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-strong"
                  >
                    {entry.client_registered ? "Add the Plant →" : "Onboard the Client →"}
                  </Link>
                  <Button
                    variant="ghost"
                    disabled={Boolean(ctx.actions.busy[key])}
                    title="Stop offering these topics. Nothing is deleted, and they can be brought back."
                    onClick={() =>
                      void ctx.actions.run([key], async () => {
                        for (const topic of entry.topics) {
                          await discoveryApi.ignoreTopic(topic, "Dismissed from Data Issues");
                        }
                      }, `${entry.client_code}/${entry.plant_code} dismissed.`)
                    }
                  >
                    Dismiss its topics
                  </Button>
                </div>
              </div>
              {ctx.actions.errors[key] ? (
                <p className="mt-2 text-xs text-bad">{ctx.actions.errors[key]}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/** One kind of issue: what it is, every row of it, and the fixes that apply to all. */
/** Rows shown before "Show all": enough to see the pattern, short enough to reach the next card. */
const ROWS_BEFORE_MORE = 5;

function GroupCard({ group, ctx }: { group: IssueGroup; ctx: FixContext }): JSX.Element {
  const info = kindInfo(group.kind);
  const [expanded, setExpanded] = useState(false);
  // A card of seventeen identical rows is fixed from its header; the rows are
  // there to check, so most of them can wait behind one press.
  const collapsible = group.issues.length > ROWS_BEFORE_MORE + 1;
  const shown = collapsible && !expanded ? group.issues.slice(0, ROWS_BEFORE_MORE) : group.issues;
  return (
    <Panel
      title={
        <span className="flex flex-wrap items-center gap-2">
          {info.label}
          <Badge tone="neutral">{group.issues.length}</Badge>
        </span>
      }
      subtitle={info.explain}
      actions={<BulkActions group={group} ctx={ctx} />}
    >
      <ul className="space-y-2">
        {shown.map((issue) => (
          <IssueRow key={issue.key} issue={issue} ctx={ctx} />
        ))}
      </ul>
      {collapsible ? (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          className="mt-3 w-full rounded-control border border-dashed border-line py-2 text-xs font-medium text-accent hover:bg-accent/5"
        >
          {expanded
            ? "Show fewer"
            : `Show all ${group.issues.length} (${group.issues.length - ROWS_BEFORE_MORE} more)`}
        </button>
      ) : null}
    </Panel>
  );
}

function IssueRow({ issue, ctx }: { issue: DataIssue; ctx: FixContext }): JSX.Element {
  const error = ctx.actions.errors[issue.key];
  return (
    <li
      className={`rounded-control border p-3 ${
        error ? "border-bad/40 bg-bad/5" : "border-line bg-surface-sunken/40"
      }`}
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          {issue.device_code ? (
            <p className="mb-0.5 font-mono text-xs font-semibold text-ink">{issue.device_code}</p>
          ) : null}
          <RowSummary issue={issue} timezone={ctx.timezone} />
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          <RowFix issue={issue} ctx={ctx} />
          <AckControl issues={[issue]} ctx={ctx} />
        </div>
      </div>
      {error ? <p className="mt-2 text-xs text-bad">{error}</p> : null}
      <details className="mt-1.5">
        <summary className="cursor-pointer text-[11px] text-ink-faint hover:text-ink">Why this matters</summary>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-ink-muted">{issue.detail}</p>
      </details>
    </li>
  );
}

/** Fixes that make sense for every row of a card at once. */
function BulkActions({ group, ctx }: { group: IssueGroup; ctx: FixContext }): JSX.Element | null {
  const issues = group.issues;
  const keys = issues.map((issue) => issue.key);
  const busy = keys.some((key) => ctx.actions.busy[key]);
  const byKey = new Map(issues.map((issue) => [issue.key, issue]));
  const each = (work: (issue: DataIssue) => Promise<void>) => async (key: string): Promise<void> => {
    const issue = byKey.get(key);
    if (issue) await work(issue);
  };
  if (issues.length < 2) return null;

  let fix: JSX.Element | null = null;
  switch (group.kind) {
    case "string_topic_unattached":
      fix = ctx.canManage ? (
        <Button
          variant="primary"
          disabled={busy}
          onClick={() =>
            void ctx.actions.run(keys, each(async (issue) => {
              await devicesApi.addDeviceTopic(
                num(issue, "owner_device_id") as number, str(issue, "topic") as string,
                "Attached from Data Issues",
              );
            }), `${issues.length} string topics attached.`)
          }
        >
          Attach all {issues.length}
        </Button>
      ) : null;
      break;
    case "key_renamed":
      fix = (
        <Button
          variant="primary"
          disabled={busy}
          onClick={() =>
            void ctx.actions.run(keys, each(async (issue) => {
              await devicesApi.updateBinding(issue.device_id as number, num(issue, "binding_id") as number, {
                source_key: str(issue, "new_key") as string,
              });
            }), `${issues.length} mappings renamed.`)
          }
        >
          Rename all {issues.length}
        </Button>
      );
      break;
    case "unmapped_key": {
      const ready = issues.filter((issue) => str(issue, "suggested_tag_code") && !str(issue, "suggested_taken_by"));
      fix = ready.length > 1 ? (
        <Button
          variant="primary"
          disabled={busy}
          title="Map each key to the Tag its name usually means, with scale 1. Keys with no suggestion are left for you."
          onClick={() =>
            void ctx.actions.run(ready.map((i) => i.key), each(async (issue) => {
              await devicesApi.addBinding(issue.device_id as number, {
                source_key: str(issue, "source_key") as string,
                tag_code: str(issue, "suggested_tag_code") as string,
              });
            }), `${ready.length} readings mapped.`)
          }
        >
          Map the {ready.length} suggested
        </Button>
      ) : null;
      break;
    }
    case "interval_slower":
    case "interval_faster":
      fix = ctx.canManage ? (
        <Button
          variant="primary"
          disabled={busy}
          onClick={() =>
            void ctx.actions.run(keys, each(async (issue) => {
              await devicesApi.updateDevice(issue.device_id as number, {
                expected_interval_s: num(issue, "measured_interval_s") as number,
              });
            }), `${issues.length} intervals set to what was measured.`)
          }
        >
          Use what was measured for all {issues.length}
        </Button>
      ) : null;
      break;
    case "string_count_missing":
      fix = ctx.canManage ? (
        <Button
          variant="primary"
          disabled={busy}
          title="Set each Device's string count to the number of inputs it sends."
          onClick={() =>
            void ctx.actions.run(keys, each(async (issue) => {
              await devicesApi.updateDevice(issue.device_id as number, {
                string_count: num(issue, "inputs_sent") as number,
              });
            }), `${issues.length} string counts set to what each Device sends.`)
          }
        >
          Set each to what it sends
        </Button>
      ) : null;
      break;
    case "inverter_type_missing": {
      const stringModel = inverterModelFor(ctx.models, "string");
      const centralModel = inverterModelFor(ctx.models, "central");
      fix = ctx.canManage ? (
        <span className="flex flex-wrap gap-2">
          {stringModel ? (
            <Button
              disabled={busy}
              onClick={() =>
                void ctx.actions.run(keys, each(async (issue) => {
                  await devicesApi.updateDevice(issue.device_id as number, { device_model_id: stringModel.id });
                }), `${issues.length} Inverters recorded as string inverters.`)
              }
            >
              All string
            </Button>
          ) : null}
          {centralModel ? (
            <Button
              disabled={busy}
              onClick={() =>
                void ctx.actions.run(keys, each(async (issue) => {
                  await devicesApi.updateDevice(issue.device_id as number, { device_model_id: centralModel.id });
                }), `${issues.length} Inverters recorded as central inverters.`)
              }
            >
              All central
            </Button>
          ) : null}
        </span>
      ) : null;
      break;
    }
    case "inverter_capacity_missing":
      fix = ctx.canManage ? <SameForAll issues={issues} ctx={ctx} /> : null;
      break;
    case "values_rejected":
      fix = <SharedRange issues={issues} ctx={ctx} />;
      break;
    default:
      fix = null;
  }

  return (
    <span className="flex flex-wrap items-center justify-end gap-2">
      {fix}
      <AckControl issues={issues} ctx={ctx} label={`Mark all ${issues.length} as known`} />
    </span>
  );
}

function SameForAll({ issues, ctx }: { issues: DataIssue[]; ctx: FixContext }): JSX.Element {
  const [value, setValue] = useState("");
  const parsed = Number(value);
  const valid = value.trim() !== "" && Number.isFinite(parsed) && parsed > 0;
  const keys = issues.map((issue) => issue.key);
  const busy = keys.some((key) => ctx.actions.busy[key]);
  const byKey = new Map(issues.map((issue) => [issue.key, issue]));
  return (
    <span className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-ink-muted">
        Same for all
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          inputMode="decimal"
          aria-label="Rated size for every Inverter listed"
          className={`${compactInput} w-20`}
        />
        kW
      </label>
      <Button
        variant="primary"
        disabled={busy || !valid}
        onClick={() =>
          void ctx.actions.run(keys, async (key) => {
            const issue = byKey.get(key);
            if (issue?.device_id != null) {
              await devicesApi.updateDevice(issue.device_id, { rated_capacity_kw: parsed });
            }
          }, `${issues.length} Inverters set to ${parsed} kW.`)
        }
      >
        Apply to {issues.length}
      </Button>
    </span>
  );
}

/**
 * One scale and range for every Device rejecting the same Tag — seventeen
 * Inverters sending a status code above an assumed range are one decision.
 * Only mappings: a calculated Tag has none to adjust.
 */
function SharedRange({ issues, ctx }: { issues: DataIssue[]; ctx: FixContext }): JSX.Element | null {
  const byTag = new Map<string, DataIssue[]>();
  for (const issue of issues) {
    const tag = str(issue, "tag_code");
    if (!tag || num(issue, "binding_id") === null || issue.device_id === null) continue;
    byTag.set(tag, [...(byTag.get(tag) ?? []), issue]);
  }
  const shared = [...byTag].filter(([, list]) => list.length > 1);
  const [open, setOpen] = useState(false);
  const [tag, setTag] = useState<string>(shared[0]?.[0] ?? "");
  if (shared.length === 0) return null;
  const chosen = byTag.get(tag) ?? shared[0]?.[1] ?? [];
  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} title="Set one scale and allowed range on every Device rejecting the same Tag.">
        Adjust together…
      </Button>
    );
  }
  return (
    <span className="flex w-full flex-wrap items-end gap-2">
      {shared.length > 1 ? (
        <label className="flex flex-col gap-0.5 text-[11px] text-ink-muted">
          Tag
          <select
            value={tag}
            onChange={(event) => setTag(event.target.value)}
            className={`${compactInput} w-40`}
          >
            {shared.map(([code, list]) => (
              <option key={code} value={code}>{code} ({list.length})</option>
            ))}
          </select>
        </label>
      ) : null}
      {/* Keyed on the Tag, so switching Tag starts from that Tag's own values. */}
      <SharedRangeForm key={tag} issues={chosen} ctx={ctx} onDone={() => setOpen(false)} />
    </span>
  );
}

function SharedRangeForm({
  issues, ctx, onDone,
}: {
  issues: DataIssue[];
  ctx: FixContext;
  onDone: () => void;
}): JSX.Element {
  const first = issues[0];
  const initial = (key: string): string => {
    const value = first ? num(first, key) : null;
    return value === null ? "" : String(value);
  };
  const [scale, setScale] = useState(initial("scale") || "1");
  const [min, setMin] = useState(initial("valid_min"));
  const [max, setMax] = useState(initial("valid_max"));
  const tag = first ? (str(first, "tag_code") ?? "") : "";
  const unit = first ? (str(first, "unit") ?? "") : "";
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
  const keys = issues.map((issue) => issue.key);
  const busy = keys.some((key) => ctx.actions.busy[key]);
  const byKey = new Map(issues.map((issue) => [issue.key, issue]));
  const field = (label: string, value: string, set: (v: string) => void): JSX.Element => (
    <label className="flex flex-col gap-0.5 whitespace-nowrap text-[11px] text-ink-muted">
      {label}
      <input
        value={value}
        onChange={(event) => set(event.target.value)}
        inputMode="decimal"
        placeholder="none"
        className={`${compactInput} w-24`}
      />
    </label>
  );
  return (
    <>
      {field("Scale ×", scale, setScale)}
      {field(`Min ${unit}`, min, setMin)}
      {field(`Max ${unit}`, max, setMax)}
      <Button
        variant="primary"
        disabled={busy || !valid}
        onClick={() =>
          void ctx.actions.run(keys, async (key) => {
            const issue = byKey.get(key);
            const bindingId = issue ? num(issue, "binding_id") : null;
            if (issue?.device_id != null && bindingId !== null) {
              await devicesApi.updateBinding(issue.device_id, bindingId, parsed);
            }
          }, `${tag} updated on ${issues.length} Devices. It applies to values from now on.`).then(onDone)
        }
      >
        {busy ? "Saving…" : `Apply to ${issues.length} × ${tag}`}
      </Button>
      <Button variant="ghost" onClick={onDone}>Cancel</Button>
    </>
  );
}

/** Issues marked as known: still listed, with who, when and why, and an Undo. */
function KnownList({ issues, ctx }: { issues: DataIssue[]; ctx: FixContext }): JSX.Element {
  if (issues.length === 0) {
    return (
      <AllClear text="Nothing has been marked as known on this Plant. An issue marked as known is listed here — never hidden — and can be brought back with Undo." />
    );
  }
  return (
    <Panel
      title="Known"
      subtitle="Marked as known by a person. Still true, still listed — Undo returns it to the open list."
    >
      <ul className="space-y-2">
        {issues.map((issue) => {
          const ack = issue.acknowledged;
          const busy = Boolean(ctx.actions.busy[issue.key]);
          return (
            <li key={issue.key} className="rounded-control border border-line bg-surface-sunken/40 p-3">
              <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
                <div className="min-w-0 flex-1 basis-64">
                  <p className="text-sm text-ink">{issue.title}</p>
                  {ack ? (
                    <p className="mt-0.5 text-xs text-ink-muted">
                      Known since {formatDateTime(ack.created_at, ctx.timezone).slice(0, 16)}
                      {ack.created_by ? ` · ${ack.created_by}` : ""}
                      {ack.note ? ` — “${ack.note}”` : ""}
                    </p>
                  ) : null}
                </div>
                <Button
                  disabled={busy || !ack}
                  onClick={() =>
                    ack && void ctx.actions.run([issue.key], async () => {
                      await dataIssuesApi.unacknowledge(ack.id);
                    }, "Back in the open list.")
                  }
                >
                  {busy ? "Undoing…" : "Undo"}
                </Button>
              </div>
              {ctx.actions.errors[issue.key] ? (
                <p className="mt-2 text-xs text-bad">{ctx.actions.errors[issue.key]}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
