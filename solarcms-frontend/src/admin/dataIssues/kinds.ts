/**
 * What each kind of data issue is called, and how its facts are read.
 *
 * The server classifies (`domain/data_issues.py`) and names each issue in a
 * sentence; this file only groups them for the screen — one card per kind, in
 * the order a person should deal with them — and reads the per-kind `facts`
 * without trusting their shape, since they arrive as JSON.
 */

import type { DataIssue, IssueCategory } from "@/api/endpoints/dataIssues";

export interface KindInfo {
  /** The card's heading: what is wrong, in plain words. */
  label: string;
  /** One sentence shared by every row of the card. */
  explain: string;
}

/** In the order they are shown inside their category. */
export const KINDS: Record<string, KindInfo> = {
  plant_silent: {
    label: "Plant stopped sending",
    explain: "Nothing has arrived from any of this Plant's Devices recently.",
  },
  topic_moved: {
    label: "Device moved to a new topic",
    explain:
      "A registered Device went quiet and a Device with the same name started sending on another topic. Moving it keeps its history in one place.",
  },
  unregistered_strings: {
    label: "String readings for a Device that is not registered",
    explain:
      "These topics carry the PV string readings of a Device that publishes nothing else. Registering it keeps them all, as one Device.",
  },
  string_topic_unattached: {
    label: "String readings not attached to their Inverter",
    explain:
      "An Inverter's PV strings arrive on a topic of their own. Until that topic is attached to the Inverter, its messages are thrown away.",
  },
  unregistered_topic: {
    label: "Sending data but not registered",
    explain:
      "Equipment under this Plant is publishing and nothing is registered for it, so every message is thrown away.",
  },
  key_renamed: {
    label: "Reading renamed by the equipment",
    explain:
      "A mapped reading stopped arriving and a new one with the same meaning started. Renaming the mapping keeps the values flowing into the same place.",
  },
  unmapped_key: {
    label: "Readings nobody has mapped",
    explain:
      "The Device sends these, but they are not mapped to a Tag, so their values are thrown away.",
  },
  strings_not_arriving: {
    label: "String readings that stopped arriving",
    explain:
      "An Inverter's PV string readings are missing from its recent messages — usually because the topic carrying them is not attached.",
  },
  binding_silent: {
    label: "Mapped readings that stopped arriving",
    explain:
      "These are mapped, but the Device's recent messages do not include them, so they have no new values.",
  },
  device_silent: {
    label: "Device stopped sending",
    explain: "Nothing has arrived from these Devices recently, while the rest of the Plant is sending.",
  },
  values_rejected: {
    label: "Values being rejected",
    explain:
      "Values outside their allowed range, or empty, are kept but not shown. A wrong unit or scale on the mapping causes it; so does a fault in the equipment.",
  },
  interval_slower: {
    label: "Sends less often than recorded",
    explain:
      "The recorded sending interval is shorter than the real one, so a working Device is shown as late or degraded.",
  },
  interval_faster: {
    label: "Sends more often than recorded",
    explain: "The recorded interval is longer than the real one, so a stop is noticed later than it could be.",
  },
  replay_burst: {
    label: "Old messages arrived in bursts",
    explain:
      "A backlog arrived all at once. These messages carry no time of measurement, so their readings are stored at the time they arrived.",
  },
  strings_hidden: {
    label: "Working strings not shown",
    explain: "PV inputs above the string count carry current, so String Analysis leaves them out.",
  },
  string_count_missing: {
    label: "Number of strings not set",
    explain: "String readings arrive, but String Analysis shows none until each Device's number of strings is set.",
  },
  string_count_high: {
    label: "String count higher than what arrives",
    explain: "Inputs above what the Device sends will show “no reading” in String Analysis.",
  },
  inverter_type_missing: {
    label: "Inverter type not set",
    explain:
      "Inverter Monitoring compares an Inverter only with others of the same type — string or central — so it cannot rank these yet.",
  },
  inverter_capacity_missing: {
    label: "Inverter size not set",
    explain: "Without each Inverter's rated kW, its output cannot be compared with the others.",
  },
  plant_capacity_missing: {
    label: "Plant capacity not set",
    explain: "Performance Ratio divides by the DC capacity and CUF by the AC capacity; without them both read as a dash.",
  },
};

const ORDER = Object.keys(KINDS);

export function kindInfo(kind: string): KindInfo {
  return KINDS[kind] ?? { label: kind.replace(/_/g, " "), explain: "" };
}

export const CATEGORIES: { value: IssueCategory; label: string; short: string }[] = [
  { value: "data_lost", label: "Data being lost", short: "Lost" },
  { value: "data_wrong", label: "Data looks wrong", short: "Wrong" },
  { value: "setup", label: "Setup incomplete", short: "Setup" },
];

export interface IssueGroup {
  kind: string;
  issues: DataIssue[];
}

/** One group per kind, in the order above, each sorted as the server sent it. */
export function groupByKind(issues: DataIssue[]): IssueGroup[] {
  const groups = new Map<string, DataIssue[]>();
  for (const issue of issues) {
    const list = groups.get(issue.kind) ?? [];
    list.push(issue);
    groups.set(issue.kind, list);
  }
  const rank = (kind: string): number => {
    const at = ORDER.indexOf(kind);
    return at === -1 ? ORDER.length : at;
  };
  return [...groups]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([kind, list]) => ({ kind, issues: list }));
}

// ── Reading facts without trusting their shape ─────────────────────────────

export function num(issue: DataIssue, key: string): number | null {
  const value = issue.facts[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function str(issue: DataIssue, key: string): string | null {
  const value = issue.facts[key];
  return typeof value === "string" && value !== "" ? value : null;
}

export function bool(issue: DataIssue, key: string): boolean {
  return issue.facts[key] === true;
}

export function strings(issue: DataIssue, key: string): string[] {
  const value = issue.facts[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function numbers(issue: DataIssue, key: string): number[] {
  const value = issue.facts[key];
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === "number") : [];
}

export interface TopicFact {
  topic: string;
  device_code: string;
  collector_code: string | null;
  interval_s: number | null;
  keys: string[];
}

/** `facts.topics` of an `unregistered_strings` issue. */
export function topics(issue: DataIssue): TopicFact[] {
  const value = issue.facts.topics;
  if (!Array.isArray(value)) return [];
  const out: TopicFact[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.topic !== "string") continue;
    out.push({
      topic: record.topic,
      device_code: typeof record.device_code === "string" ? record.device_code : record.topic,
      collector_code: typeof record.collector_code === "string" ? record.collector_code : null,
      interval_s: typeof record.interval_s === "number" ? record.interval_s : null,
      keys: Array.isArray(record.keys)
        ? record.keys.filter((k): k is string => typeof k === "string")
        : [],
    });
  }
  return out;
}

export interface BurstFact {
  minute: string;
  messages: number;
  topics: number;
}

/** `facts.bursts` of a `replay_burst` issue. */
export function bursts(issue: DataIssue): BurstFact[] {
  const value = issue.facts.bursts;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    return typeof record.minute === "string"
      && typeof record.messages === "number"
      && typeof record.topics === "number"
      ? [{ minute: record.minute, messages: record.messages, topics: record.topics }]
      : [];
  });
}

/** A sample value as it arrived, short enough for a row. */
export function sample(value: unknown): string {
  if (value === null || value === undefined) return "empty";
  if (typeof value === "string") return value.length > 24 ? `${value.slice(0, 24)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value).slice(0, 24);
}

/** A number for a sentence: no trailing zeros, at most three decimals. */
export function plain(value: number | null): string {
  if (value === null) return "—";
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}
