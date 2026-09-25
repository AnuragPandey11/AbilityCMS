/**
 * How an Alarm Rule stands against the others sharing its code.
 *
 * The same precedence the alarm worker applies (`domain/alarm_logic.precedence`
 * on the server), told to the person writing the rule — so a rule that can
 * never win says so on screen instead of being stored, listed and silently
 * ignored. Two rules, in this order:
 *
 *  1. Scope decides first, and a narrower rule always wins:
 *     device → plant → device_type → client → global.
 *  2. Only at the same scope does the owner decide, and there a Client's own
 *     rule beats the platform default (agreed 25 Sep 2026).
 *
 * ⚠ Advisory only. The server resolves every Device on its own; this reads the
 * list the caller can see, so it can only be as complete as that list.
 */

import type { AlarmRule } from "@/api/schemas";

export type RuleShape = Pick<
  AlarmRule,
  "id" | "client_id" | "client_code" | "code" | "scope_type" | "scope_id" | "scope_code"
>;

export interface Standing {
  tone: "ok" | "warn";
  text: string;
}

export const SCOPE_RANK: Readonly<Record<string, number>> = {
  device: 0,
  plant: 1,
  device_type: 2,
  client: 3,
  global: 4,
};

const rank = (rule: RuleShape): number => SCOPE_RANK[rule.scope_type] ?? 9;

const scopeNoun = (scopeType: string): string => scopeType.replace("_", " ");

/** "device type INVERTER", "plant SF_SOUTH", "global". */
export function scopeLabel(rule: RuleShape): string {
  if (rule.scope_type === "global") return "global";
  return `${scopeNoun(rule.scope_type)} ${rule.scope_code ?? `#${rule.scope_id ?? "?"}`}`;
}

const ownerLabel = (rule: RuleShape): string => rule.client_code ?? "this Client";

/**
 * Whether a platform default and a Client's rule can ever reach the same
 * Device. Equal scopes overlap only on the same target; a default scoped to one
 * Client never meets another Client's rule. Anything else is assumed to
 * overlap somewhere — a narrower rule sits inside a wider one.
 */
function overlaps(platform: RuleShape, own: RuleShape): boolean {
  if (platform.scope_type === "client" && platform.scope_id !== own.client_id) {
    return false;
  }
  if (rank(platform) === rank(own)) return platform.scope_id === own.scope_id;
  return true;
}

/** A Client-owned rule against the platform defaults carrying its code. */
function againstDefaults(own: RuleShape, defaults: RuleShape[]): Standing | null {
  const relevant = defaults.filter((platform) => overlaps(platform, own));
  // A default narrower than this rule still wins wherever it applies. Only a
  // Type or Client default is reported: a default for one Plant or one Device
  // usually belongs to some other Client, and this list cannot tell.
  const beaten = relevant.find(
    (platform) =>
      rank(platform) < rank(own) &&
      (platform.scope_type === "device_type" || platform.scope_type === "client"),
  );
  if (beaten) {
    return {
      tone: "warn",
      text:
        `Does not replace the platform default: that one is scoped to ` +
        `${scopeLabel(beaten)}, which is narrower, so it still wins there. ` +
        `Scope this rule to ${scopeLabel(beaten)} or narrower to replace it.`,
    };
  }
  if (relevant.some((platform) => rank(platform) === rank(own))) {
    return {
      tone: "ok",
      text: `Replaces the platform default for ${ownerLabel(own)}: same scope, and the Client's own rule wins.`,
    };
  }
  if (relevant.some((platform) => rank(platform) > rank(own))) {
    return {
      tone: "ok",
      text: `Replaces the platform default within ${scopeLabel(own)}.`,
    };
  }
  return null;
}

/** A platform default against the Client rules that replace it. */
function againstClients(platform: RuleShape, owned: RuleShape[]): Standing | null {
  const replacing = owned.filter(
    (own) => overlaps(platform, own) && rank(own) <= rank(platform),
  );
  if (replacing.length === 0) return null;
  const parts = replacing.map((own) =>
    rank(own) === rank(platform)
      ? ownerLabel(own)
      : `${ownerLabel(own)} on ${scopeLabel(own)}`,
  );
  return {
    tone: "ok",
    text: `Replaced for ${[...new Set(parts)].join(", ")}. Those Devices do not use this default.`,
  };
}

/**
 * The standing of `rule` among `rules`, or null when nothing shares its code in
 * a way that matters. `rule` may be a draft that is not in `rules` yet.
 */
export function standingOf(rule: RuleShape, rules: RuleShape[]): Standing | null {
  const siblings = rules.filter(
    (other) => other.code === rule.code && other.id !== rule.id,
  );
  return rule.client_id === null
    ? againstClients(rule, siblings.filter((other) => other.client_id !== null))
    : againstDefaults(rule, siblings.filter((other) => other.client_id === null));
}
