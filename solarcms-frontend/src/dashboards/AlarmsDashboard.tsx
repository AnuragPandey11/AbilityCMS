/**
 * `alarms` (§6.6).
 *
 * Four things this screen must get right:
 *
 * - One breach produces **exactly one** Alarm, not one per Reading. Apparent
 *   duplicates are a real bug worth reporting, never de-duplicated here.
 * - A **Collector failure surfaces as one Alarm covering many Devices** — the
 *   Devices it absorbed are shown, because nine "Inverter offline" rows would be
 *   the wrong picture.
 * - `classification` separates `communication` from `equipment` (tender §18), so
 *   the filter does too.
 * - Acknowledging is gated on `alarm.acknowledge`, and `escalation_level` is
 *   shown: an Alarm at L2 has already woken somebody.
 *
 * A platform administrator also narrows by Client and search (`PlantFilterBar`,
 * mounted by the route). The Client is sent to the server; the search is
 * applied here, by Plant — which leaves out Alarms attached to no Plant while
 * a search is in force, since there is nothing of theirs to match.
 */

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAlarms, usePlantDevices } from "@/api/hooks";
import * as alarmsApi from "@/api/endpoints/alarms";
import type { Alarm, AlarmSeverity, AlarmState } from "@/api/schemas";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { Button, Panel, Badge, inputClass } from "@/components/ui";
import { EmptyState, ErrorState, SkeletonTable } from "@/components/state";
import {
  AlarmStateBadge,
  ClassificationBadge,
  EscalationBadge,
  PlantPicker,
  SeverityBadge,
  alarmSortValue,
} from "@/components/domain";
import { formatDateTime } from "@/format/datetime";
import { formatNumber } from "@/format/value";
import { usePermission } from "@/auth/usePermission";
import { usePlantFilter } from "@/state/usePlantFilter";
import { useAuth } from "@/auth/AuthProvider";
import { isApiError } from "@/api/problem";

const STATES: (AlarmState | "")[] = ["", "active", "acknowledged", "resolved"];
const SEVERITIES: (AlarmSeverity | "")[] = ["", "critical", "high", "medium", "low"];
const CLASSIFICATIONS = ["", "communication", "equipment"] as const;

export function AlarmsDashboard(): JSX.Element {
  const queryClient = useQueryClient();
  const canAcknowledge = usePermission("alarm.acknowledge");
  const canExport = usePermission("data.export");
  const { me } = useAuth();
  const filter = usePlantFilter();
  const plants = filter.matches;

  const [state, setState] = useState<AlarmState | "">("active");
  const [severity, setSeverity] = useState<AlarmSeverity | "">("");
  const [classification, setClassification] = useState<string>("");
  const [plantId, setPlantId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // A Plant the Client filter or search has since excluded falls back to "All"
  // of what remains, rather than holding a choice the picker no longer lists.
  useEffect(() => {
    if (plantId !== null && !plants.some((plant) => plant.id === plantId)) setPlantId(null);
  }, [plantId, plants]);

  const alarmsQuery = useAlarms({
    state: state || null,
    severity: severity || null,
    plantId,
    clientId: filter.clientId,
    limit: 500,
  });

  // Used to name the Devices a Collector-level Alarm absorbed.
  const devicesQuery = usePlantDevices(plantId);

  const acknowledge = useMutation({
    mutationFn: (alarmId: number) => alarmsApi.acknowledgeAlarm(alarmId),
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ["alarms"] });
    },
    onError: (error) => {
      setActionError(
        isApiError(error) ? error.displayMessage : "Could not acknowledge the Alarm.",
      );
    },
  });

  /**
   * Devices that report through the Alarm's Device. When the Alarm is on a
   * Collector, these are the Devices whose data stopped with it — the ones that
   * would otherwise each have raised their own row.
   */
  const absorbedDevices = (alarm: Alarm) => {
    if (!alarm.device_id) return [];
    return (devicesQuery.data ?? []).filter(
      (device) => device.reports_via_device_id === alarm.device_id,
    );
  };

  const plantsById = new Map((me?.plants ?? []).map((plant) => [plant.id, plant]));
  const searchedPlantIds =
    plantId === null && filter.search !== ""
      ? new Set(plants.map((plant) => plant.id))
      : null;
  const filtered = (alarmsQuery.data ?? []).filter(
    (alarm) =>
      (classification ? alarm.classification === classification : true) &&
      (searchedPlantIds ? alarm.plant_id !== null && searchedPlantIds.has(alarm.plant_id) : true),
  );

  // Across Plants, a row must say which Plant it is from — and, for a platform
  // administrator looking across Clients, whose.
  const plantColumn: Column<Alarm> = {
    key: "plant",
    header: "Plant",
    width: "150px",
    render: (alarm) => {
      const plant = alarm.plant_id !== null ? plantsById.get(alarm.plant_id) : undefined;
      if (!plant) return <span className="text-ink-faint">—</span>;
      const client = filter.enabled && filter.clientId === null ? filter.clientOf(plant.id) : undefined;
      return (
        <span className="flex flex-col leading-tight" title={plant.name}>
          <span className="font-mono text-xs">{plant.code}</span>
          {client ? <span className="text-[11px] text-ink-faint">{client.label}</span> : null}
        </span>
      );
    },
    sortValue: (alarm) =>
      (alarm.plant_id !== null ? plantsById.get(alarm.plant_id)?.code : null) ?? null,
    filterValue: (alarm) => {
      const plant = alarm.plant_id !== null ? plantsById.get(alarm.plant_id) : undefined;
      return plant ? `${plant.code} ${plant.name} ${filter.clientOf(plant.id)?.label ?? ""}` : "";
    },
  };

  const columns: Column<Alarm>[] = [
    {
      key: "severity",
      header: "Severity",
      width: "100px",
      render: (alarm) => <SeverityBadge severity={alarm.severity} />,
      sortValue: (alarm) => alarmSortValue(alarm),
      filterValue: (alarm) => alarm.severity,
    },
    {
      key: "state",
      header: "State",
      width: "130px",
      render: (alarm) => (
        <span className="flex items-center gap-1">
          <AlarmStateBadge state={alarm.state} />
          <EscalationBadge level={alarm.escalation_level} />
        </span>
      ),
      sortValue: (alarm) => alarm.state,
      filterValue: (alarm) => alarm.state,
    },
    {
      key: "opened",
      header: "Opened",
      width: "170px",
      render: (alarm) => (
        <span className="font-mono text-xs">{formatDateTime(alarm.opened_at)}</span>
      ),
      sortValue: (alarm) => Date.parse(alarm.opened_at),
    },
    ...(plantId === null && (me?.plants.length ?? 0) > 1 ? [plantColumn] : []),
    {
      key: "device",
      header: "Device",
      width: "130px",
      render: (alarm) =>
        alarm.device_code ?? <span className="text-ink-faint">Plant-level</span>,
      sortValue: (alarm) => alarm.device_code,
      filterValue: (alarm) => alarm.device_code ?? "",
    },
    {
      key: "message",
      header: "Message",
      render: (alarm) => (
        <span>
          {alarm.message}
          <span className="ml-2 text-ink-faint">{alarm.rule_code}</span>
        </span>
      ),
      filterValue: (alarm) => `${alarm.message} ${alarm.rule_code}`,
    },
    {
      key: "classification",
      header: "Class",
      width: "130px",
      render: (alarm) => <ClassificationBadge classification={alarm.classification} />,
      sortValue: (alarm) => alarm.classification,
      filterValue: (alarm) => alarm.classification ?? "",
    },
    {
      key: "trigger",
      header: "Trigger",
      align: "right",
      width: "110px",
      render: (alarm) => formatNumber(alarm.trigger_value),
      sortValue: (alarm) => alarm.trigger_value,
    },
    {
      key: "action",
      header: "",
      width: "120px",
      render: (alarm) => {
        const absorbed = absorbedDevices(alarm);
        return (
          <span className="flex items-center justify-end gap-1">
            {absorbed.length > 0 ? (
              <Button
                variant="ghost"
                onClick={() => setExpanded(expanded === alarm.id ? null : alarm.id)}
                title="This Alarm covers the Devices that report through it."
              >
                +{absorbed.length}
              </Button>
            ) : null}
            {/* A-4. Absence hides the control; the server refuses it regardless. */}
            {canAcknowledge && alarm.state === "active" ? (
              <Button
                onClick={() => acknowledge.mutate(alarm.id)}
                disabled={acknowledge.isPending}
              >
                Ack
              </Button>
            ) : null}
          </span>
        );
      },
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="page-title">Alarms</h1>
          <p className="mt-1.5 text-sm text-ink-muted">
            One breach is one Alarm. A Collector failure appears once, covering every
            Device it carries.
          </p>
        </div>
      </div>

      <Panel title="Filters">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-ink-muted">
            State
            <select
              value={state}
              onChange={(event) => setState(event.target.value as AlarmState | "")}
              className={`${inputClass} mt-1 w-36`}
            >
              {STATES.map((option) => (
                <option key={option} value={option}>
                  {option || "Any"}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-ink-muted">
            Severity
            <select
              value={severity}
              onChange={(event) => setSeverity(event.target.value as AlarmSeverity | "")}
              className={`${inputClass} mt-1 w-36`}
            >
              {SEVERITIES.map((option) => (
                <option key={option} value={option}>
                  {option || "Any"}
                </option>
              ))}
            </select>
          </label>
          <label
            className="text-xs text-ink-muted"
            title="Tender §18 keeps communication loss and equipment downtime separate; conflating them corrupts availability."
          >
            Classification
            <select
              value={classification}
              onChange={(event) => setClassification(event.target.value)}
              className={`${inputClass} mt-1 w-40`}
            >
              {CLASSIFICATIONS.map((option) => (
                <option key={option} value={option}>
                  {option || "Any"}
                </option>
              ))}
            </select>
          </label>
          <PlantPicker
            plants={plants}
            value={plantId}
            onChange={setPlantId}
            allowAll
            label="Plant"
          />
        </div>
      </Panel>

      {actionError ? (
        <div className="rounded border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad">
          {actionError}
        </div>
      ) : null}

      <Panel
        title={`${filtered.length} Alarm(s)`}
        subtitle="Sorted by severity or any column. Duplicates would be a real backend bug — none are removed here."
      >
        {alarmsQuery.isLoading ? (
          <SkeletonTable rows={8} columns={7} />
        ) : alarmsQuery.isError ? (
          <ErrorState error={alarmsQuery.error} retry={() => void alarmsQuery.refetch()} />
        ) : filtered.length === 0 ? (
          <EmptyState
            title="No Alarms match"
            detail={
              filter.active && plants.length === 0
                ? "No Plant matches the Client and search above."
                : state === "active"
                  ? "Nothing is currently in alarm for the selected filters."
                  : "No Alarms match the selected filters."
            }
          />
        ) : (
          <>
            <DataTable
              rows={filtered}
              columns={columns}
              rowKey={(alarm) => alarm.id}
              filterPlaceholder="Filter by message, Device, rule…"
              exportFilename={canExport ? "alarms.csv" : undefined}
            />
            {expanded !== null ? (
              <div className="mt-3 rounded border border-info/30 bg-info/10 p-3">
                <p className="text-xs font-medium text-info">
                  Devices covered by Alarm #{expanded}
                </p>
                <p className="mt-1 text-[11px] text-ink-muted">
                  These report through the alarmed Device. They are absorbed into this
                  one Alarm rather than raising one each — a Collector failure is one
                  event, not nine.
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {absorbedDevices(
                    filtered.find((alarm) => alarm.id === expanded) as Alarm,
                  ).map((device) => (
                    <Badge key={device.id} tone="neutral">
                      {device.code}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}
      </Panel>
    </div>
  );
}
