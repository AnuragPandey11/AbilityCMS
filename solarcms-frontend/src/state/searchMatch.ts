/**
 * Forgiving, ranked text matching — the Plant search's one rule, used by both
 * its suggestion list and the narrowing of the page's picker, so the two can
 * never disagree about what matches.
 *
 * What the plain substring match it replaced got wrong:
 * - **Separators are not content.** `sf-north`, `sf north`, `sfnorth` and
 *   `SF_NORTH` are one code typed four ways, so hyphens, underscores, dots and
 *   spaces are dropped before comparing, and accents are folded.
 * - **One letter is a prefix, never a substring.** `s` used to find every Plant
 *   on the fleet, because "Warehouse" and "Rooftops" contain an s. It now finds
 *   what *starts* with s: a code, a name, or a word in either.
 * - **A typo is forgiven, but only when nothing matches as typed.** `sf-norht`
 *   finds SF_NORTH. A near miss never *widens* a search that already found
 *   something, and a query word with a digit in it is never treated as a slip —
 *   `INV_12` and `INV_13` are different Devices, not one misspelt.
 *
 * Ranked: exact, then prefix, then a word's prefix, then substring, then near
 * miss, primary fields over secondary ones; ties keep the order they came in.
 */

export interface SearchField {
  text: string | null | undefined;
  /** Ranked just below a primary field that matches as well — a Client's name, beside a Plant's. */
  secondary?: boolean;
}

const EXACT = 100;
const PREFIX = 90;
const WORD_PREFIX = 80;
const SUBSTRING = 50;
const NEAR = 30;
const SECONDARY_PENALTY = 5;

const SEPARATORS = /[^\p{L}\p{N}]+/gu;

function fold(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Lower case, accents and separators gone: `SF_North` → `sfnorth`. */
export function compact(text: string): string {
  return fold(text).replace(SEPARATORS, "");
}

/** The query's whitespace-separated words, compacted. Each must match somewhere. */
export function queryTokens(query: string): string[] {
  return query.split(/\s+/).map(compact).filter(Boolean);
}

interface Prepared {
  full: string;
  words: string[];
  penalty: number;
}

function prepare(field: SearchField): Prepared | null {
  if (!field.text) return null;
  const full = compact(field.text);
  if (!full) return null;
  return {
    full,
    words: fold(field.text).split(SEPARATORS).filter(Boolean),
    penalty: field.secondary ? SECONDARY_PENALTY : 0,
  };
}

function strictScore(token: string, field: Prepared): number {
  if (field.full === token) return EXACT;
  if (field.full.startsWith(token)) return PREFIX;
  if (field.words.some((word) => word.startsWith(token))) return WORD_PREFIX;
  if (token.length >= 2 && field.full.includes(token)) return SUBSTRING;
  return 0;
}

/**
 * Optimal string alignment distance: insertions, deletions, substitutions and
 * adjacent transpositions each cost one — `norht` is one slip from `north`.
 */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/**
 * A near miss against the start of the field or of one of its words, compared
 * at lengths around the token's so a half-typed word with a slip still finds
 * its target. Four letters at least, since one edit in three leaves little.
 */
function nearScore(token: string, field: Prepared): number {
  if (token.length < 4 || /\p{N}/u.test(token)) return 0;
  const budget = token.length >= 8 ? 2 : 1;
  let best = Infinity;
  for (const candidate of [field.full, ...field.words]) {
    for (let length = token.length - budget; length <= token.length + budget; length++) {
      if (length < 1 || length > candidate.length) continue;
      best = Math.min(best, editDistance(token, candidate.slice(0, length)));
    }
  }
  return best <= budget ? NEAR - best * 5 : 0;
}

/**
 * `items` that match every word of `query`, best first. An empty query
 * returns `items` unchanged.
 */
export function rankMatches<T>(
  items: readonly T[],
  fieldsOf: (item: T) => SearchField[],
  query: string,
): T[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [...items];

  const prepared = items.map((item, index) => ({
    item,
    index,
    fields: fieldsOf(item)
      .map(prepare)
      .filter((field): field is Prepared => field !== null),
  }));

  const pass = (forgiving: boolean): T[] => {
    const scored: { item: T; index: number; total: number }[] = [];
    for (const { item, index, fields } of prepared) {
      let total = 0;
      let everyToken = true;
      for (const token of tokens) {
        let best = 0;
        for (const field of fields) {
          let score = strictScore(token, field);
          if (score === 0 && forgiving) score = nearScore(token, field);
          if (score > 0) best = Math.max(best, score - field.penalty);
        }
        if (best === 0) {
          everyToken = false;
          break;
        }
        total += best;
      }
      if (everyToken) scored.push({ item, index, total });
    }
    return scored.sort((a, b) => b.total - a.total || a.index - b.index).map((entry) => entry.item);
  };

  const strict = pass(false);
  return strict.length > 0 ? strict : pass(true);
}

/**
 * Where each query word appears in `text` as typed, separators allowed between
 * its letters, for highlighting a suggestion. A word's start is preferred, and
 * a single letter is looked for only there. A near miss highlights nothing,
 * which is honest: nothing in the text is what was typed.
 */
export function matchRanges(text: string, query: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const token of queryTokens(query)) {
    const body = [...token]
      .map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^\\p{L}\\p{N}]*");
    const atWordStart = new RegExp(`(?<![\\p{L}\\p{N}])${body}`, "iu").exec(text);
    const found = atWordStart ?? (token.length >= 2 ? new RegExp(body, "iu").exec(text) : null);
    if (found) ranges.push([found.index, found.index + found[0].length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}
