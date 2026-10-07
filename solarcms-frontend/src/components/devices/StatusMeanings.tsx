/**
 * Status code meanings: reading them wherever a code is shown, and the editor.
 *
 * The editor lists the codes this Plant's equipment actually sent this week,
 * grouped by Device Type and reading, so meanings are given to what arrives
 * rather than typed from a datasheet from memory; a code not seen yet can
 * still be added by number. Anyone who can see the Plant sees the meanings;
 * only `config.modify` may change them (the server enforces it too).
 */

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useStatusCodes } from "@/api/hooks";
import { qk } from "@/api/queryKeys";
import { isApiError } from "@/api/problem";
import * as statusCodesApi from "@/api/endpoints/statusCodes";
import type { StatusCode, StatusKind } from "@/api/endpoints/statusCodes";
import { Button, Drawer } from "@/components/ui";
import { Skeleton } from "@/components/state";
import { formatAge } from "@/format/datetime";
import {
  NO_MEANINGS,
  STATUS_KIND_WORD,
  statusLookup,
  type StatusLookup,
  type StatusMeaning,
} from "@/format/statusCode";

/** The Plant's meanings as a lookup; codes nobody described return null. */
export function useStatusLookup(plantId: number | null | undefined): {
  lookup: StatusLookup;
  canEdit: boolean;
} {
  const query = useStatusCodes(plantId);
  const lookup = useMemo(
    () => (query.data ? statusLookup(query.data) : NO_MEANINGS),
    [query.data],
  );
  return { lookup, canEdit: query.data?.can_edit ?? false };
}

/** A code as the client described it, or as sent with the reason. */
export function StatusCodeValue({
  value,
  meaning,
  size = "sm",
}: {
  value: number;
  meaning: StatusMeaning | null;
  size?: "xs" | "sm";
}): JSX.Element {
  const text = size === "xs" ? "text-[11px]" : "text-xs";
  if (!meaning) {
    return (
      <span
        className={`font-mono ${text} text-ink`}
        title={`Status code ${value}, shown as sent: no meaning has been recorded for it at this Plant. Add one under Status meanings on Inverter Monitoring.`}
      >
        {value}
      </span>
    );
  }
  return (
    <span
      className="inline-flex min-w-0 max-w-full items-center gap-1.5"
      title={`Status code ${value}: “${meaning.label}” — ${STATUS_KIND_WORD[meaning.kind].toLowerCase()}, as recorded for this Plant.${meaning.note ? ` ${meaning.note}` : ""}`}
    >
      {/* Badge-shaped but able to shorten: a long meaning must not push a
          card's header wider than the card. */}
      <span
        className={`min-w-0 truncate rounded border px-1.5 py-0.5 ${text} font-medium ${CHIP[meaning.kind]}`}
      >
        {meaning.label}
      </span>
      <span className={`shrink-0 font-mono ${text} text-ink-faint`}>{value}</span>
    </span>
  );
}

const CHIP: Record<StatusKind, string> = {
  normal: "border-ok/30 bg-ok/10 text-ok",
  standby: "border-line bg-surface-sunken text-ink-muted",
  warning: "border-warn/30 bg-warn/10 text-warn",
  fault: "border-bad/30 bg-bad/10 text-bad",
};

// ── The editor ──────────────────────────────────────────────────────────────

const KINDS: StatusKind[] = ["normal", "standby", "warning", "fault"];

const fieldClass =
  "h-8 rounded-control border border-line bg-surface-raised px-2 py-1 text-xs text-ink " +
  "placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 " +
  "focus:ring-accent/20 disabled:opacity-50";

interface Row {
  code: number;
  saved: StatusCode | null;
  devices: number | null;
  lastSeen: string | null;
}

interface Group {
  typeCode: string;
  tagCode: string;
  tagName: string;
  /** The payload keys it arrives as, from the bindings (`STS`). */
  keys: Set<string>;
  rows: Row[];
}

function groupsOf(
  codes: StatusCode[],
  observed: statusCodesApi.ObservedCode[],
  typeNames: Map<string, string>,
): Group[] {
  const groups = new Map<string, Group>();
  const groupFor = (typeCode: string, tagCode: string, tagName: string) => {
    const key = `${typeCode}|${tagCode}`;
    let group = groups.get(key);
    if (!group) {
      group = { typeCode, tagCode, tagName, keys: new Set(), rows: [] };
      groups.set(key, group);
    }
    return group;
  };
  for (const seen of observed) {
    const group = groupFor(seen.device_type_code, seen.tag_code, seen.tag_name);
    for (const key of seen.source_keys ?? []) group.keys.add(key);
    group.rows.push({
      code: seen.code,
      saved: null,
      devices: seen.devices,
      lastSeen: seen.last_seen,
    });
  }
  for (const entry of codes) {
    const group = groupFor(entry.device_type_code, entry.tag_code, entry.tag_name);
    const row = group.rows.find((candidate) => candidate.code === entry.code);
    if (row) row.saved = entry;
    else group.rows.push({ code: entry.code, saved: entry, devices: null, lastSeen: null });
  }
  for (const group of groups.values()) group.rows.sort((a, b) => a.code - b.code);
  return [...groups.values()].sort((a, b) =>
    `${typeNames.get(a.typeCode) ?? a.typeCode}${a.tagName}`.localeCompare(
      `${typeNames.get(b.typeCode) ?? b.typeCode}${b.tagName}`,
    ),
  );
}

function CodeRow({
  plantId,
  group,
  row,
  canEdit,
}: {
  plantId: number;
  group: Group;
  row: Row;
  canEdit: boolean;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState(row.saved?.label ?? "");
  const [kind, setKind] = useState<StatusKind>(row.saved?.kind ?? "normal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = label.trim() !== (row.saved?.label ?? "") || kind !== (row.saved?.kind ?? "normal");

  const refresh = () => queryClient.invalidateQueries({ queryKey: qk.statusCodes(plantId) });

  const save = async () => {
    if (!label.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await statusCodesApi.setStatusCode(plantId, {
        device_type_code: group.typeCode,
        tag_code: group.tagCode,
        code: row.code,
        label: label.trim(),
        kind,
      });
      await refresh();
    } catch (err) {
      setError(isApiError(err) ? err.displayMessage : "Could not save this meaning.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!row.saved) return;
    setBusy(true);
    setError(null);
    try {
      await statusCodesApi.deleteStatusCode(plantId, row.saved.id);
      setLabel("");
      setKind("normal");
      await refresh();
    } catch (err) {
      setError(isApiError(err) ? err.displayMessage : "Could not remove this meaning.");
    } finally {
      setBusy(false);
    }
  };

  const seen =
    row.devices !== null && row.lastSeen
      ? [
          `${row.devices} Device${row.devices === 1 ? "" : "s"}`,
          formatAge((Date.now() - Date.parse(row.lastSeen)) / 1000),
        ]
      : ["not sent", "this week"];

  return (
    <li className="py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="w-20 shrink-0" title={`Sent by ${seen.join(", last ")}`}>
          <div className="font-mono text-sm font-semibold text-ink">{row.code}</div>
          <div className="truncate text-[10px] leading-tight text-ink-faint">{seen[0]}</div>
          <div className="truncate text-[10px] leading-tight text-ink-faint">{seen[1]}</div>
        </div>
        {canEdit ? (
          <form
            className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <input
              className={`${fieldClass} min-w-0 flex-1 basis-32`}
              value={label}
              maxLength={80}
              placeholder="What it means"
              aria-label={`Meaning of code ${row.code}`}
              onChange={(event) => setLabel(event.target.value)}
            />
            <select
              className={`${fieldClass} w-24`}
              value={kind}
              aria-label={`Kind of code ${row.code}`}
              onChange={(event) => setKind(event.target.value as StatusKind)}
            >
              {KINDS.map((option) => (
                <option key={option} value={option}>
                  {STATUS_KIND_WORD[option]}
                </option>
              ))}
            </select>
            <Button type="submit" variant="primary" disabled={busy || !changed || !label.trim()}>
              {row.saved ? "Update" : "Save"}
            </Button>
            {row.saved ? (
              <Button variant="ghost" disabled={busy} onClick={() => void remove()}>
                Remove
              </Button>
            ) : null}
          </form>
        ) : (
          <div className="min-w-0 flex-1">
            {row.saved ? (
              <StatusCodeValue value={row.code} meaning={{ ...row.saved }} />
            ) : (
              <span className="text-xs text-ink-faint">No meaning recorded</span>
            )}
          </div>
        )}
      </div>
      {error ? <p className="mt-1 text-[11px] text-bad">{error}</p> : null}
    </li>
  );
}

function AddCode({
  plantId,
  groups,
}: {
  plantId: number;
  groups: Group[];
}): JSX.Element | null {
  const queryClient = useQueryClient();
  const [groupKey, setGroupKey] = useState(
    groups[0] ? `${groups[0].typeCode}|${groups[0].tagCode}` : "",
  );
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<StatusKind>("normal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (groups.length === 0) return null;
  const group = groups.find((g) => `${g.typeCode}|${g.tagCode}` === groupKey) ?? groups[0];
  const number = Number(code);
  const valid = code.trim() !== "" && Number.isInteger(number) && label.trim() !== "";

  const add = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await statusCodesApi.setStatusCode(plantId, {
        device_type_code: group.typeCode,
        tag_code: group.tagCode,
        code: number,
        label: label.trim(),
        kind,
      });
      setCode("");
      setLabel("");
      setKind("normal");
      await queryClient.invalidateQueries({ queryKey: qk.statusCodes(plantId) });
    } catch (err) {
      setError(isApiError(err) ? err.displayMessage : "Could not add this code.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="rounded-card border border-dashed border-line p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
    >
      <div className="text-xs font-medium text-ink">Add a code not sent yet</div>
      <p className="mt-0.5 text-[11px] leading-snug text-ink-faint">
        From the equipment&apos;s manual, so a code that has not happened yet is named the first
        time it does.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {groups.length > 1 ? (
          <select
            className={`${fieldClass} w-full sm:w-auto`}
            value={groupKey}
            aria-label="Which equipment and reading"
            onChange={(event) => setGroupKey(event.target.value)}
          >
            {groups.map((g) => (
              <option key={`${g.typeCode}|${g.tagCode}`} value={`${g.typeCode}|${g.tagCode}`}>
                {g.typeCode} · {g.tagName}
              </option>
            ))}
          </select>
        ) : null}
        <input
          className={`${fieldClass} w-24`}
          inputMode="numeric"
          value={code}
          placeholder="Code"
          aria-label="Code"
          onChange={(event) => setCode(event.target.value.replace(/[^\d-]/g, ""))}
        />
        <input
          className={`${fieldClass} min-w-0 flex-1 basis-40`}
          value={label}
          maxLength={80}
          placeholder="What it means"
          aria-label="Meaning"
          onChange={(event) => setLabel(event.target.value)}
        />
        <select
          className={`${fieldClass} w-28`}
          value={kind}
          aria-label="Kind"
          onChange={(event) => setKind(event.target.value as StatusKind)}
        >
          {KINDS.map((option) => (
            <option key={option} value={option}>
              {STATUS_KIND_WORD[option]}
            </option>
          ))}
        </select>
        <Button type="submit" variant="secondary" disabled={busy || !valid}>
          Add
        </Button>
      </div>
      {error ? <p className="mt-1 text-[11px] text-bad">{error}</p> : null}
    </form>
  );
}

const NO_NAMES = new Map<string, string>();

export function StatusMeaningsDrawer({
  open,
  onClose,
  plantId,
  plantName,
  typeNames,
}: {
  open: boolean;
  onClose: () => void;
  plantId: number;
  plantName: string;
  /** Device Type names by code, for the group headings. Memoise it. */
  typeNames?: Map<string, string>;
}): JSX.Element {
  const query = useStatusCodes(open ? plantId : null);
  const names = typeNames ?? NO_NAMES;
  const groups = useMemo(
    () => (query.data ? groupsOf(query.data.codes, query.data.observed, names) : []),
    [query.data, names],
  );
  const canEdit = query.data?.can_edit ?? false;
  const described = query.data?.codes.length ?? 0;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Status code meanings"
      subtitle={
        <>
          What each status code means at {plantName}. A code nobody has described is shown as the
          equipment sent it.
          {!canEdit && query.data ? " Only an administrator can change these." : ""}
        </>
      }
    >
      {query.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 rounded-card" />
          <Skeleton className="h-10 rounded-card" />
          <Skeleton className="h-10 rounded-card" />
        </div>
      ) : query.isError ? (
        <p className="text-sm text-bad">The status codes could not be loaded. Try again shortly.</p>
      ) : groups.length === 0 ? (
        <p className="text-sm leading-snug text-ink-muted">
          No equipment at this Plant has sent a status code this week, so there is nothing to
          describe yet. Codes appear here as soon as one arrives.
        </p>
      ) : (
        <div className="space-y-5">
          <p className="text-xs text-ink-muted">
            {described === 0
              ? "No meanings recorded yet."
              : `${described} meaning${described === 1 ? "" : "s"} recorded.`}{" "}
            The kind sets the colour: normal is green, a warning amber, a fault red; standby stays
            plain.
          </p>
          {groups.map((group) => (
            <section key={`${group.typeCode}|${group.tagCode}`}>
              <h3 className="text-sm font-semibold text-ink">
                {names.get(group.typeCode) ?? group.typeCode} · {group.tagName}
                {group.keys.size > 0 ? (
                  <span className="ml-1.5 font-normal text-ink-muted">
                    sent as <code className="font-mono">{[...group.keys].join(", ")}</code>
                  </span>
                ) : null}
              </h3>
              <ul className="mt-1 divide-y divide-line-soft">
                {group.rows.map((row) => (
                  <CodeRow
                    // A saved meaning changing underneath resets the row's draft.
                    key={`${row.code}|${row.saved?.updated_at ?? "new"}`}
                    plantId={plantId}
                    group={group}
                    row={row}
                    canEdit={canEdit}
                  />
                ))}
              </ul>
            </section>
          ))}
          {canEdit ? <AddCode plantId={plantId} groups={groups} /> : null}
        </div>
      )}
    </Drawer>
  );
}
