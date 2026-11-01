/**
 * Every tab a User may be given — the screens and the admin pages — as boxes
 * (the user's decision, 1 Nov 2026; migration 0046).
 *
 * A Client Admin and an Employee alike see exactly what is ticked here; only a
 * platform administrator sees everything unticked. A box is offered disabled,
 * with the reason on it, where ticking it could not work:
 *
 * - an admin page the person's **role** cannot use — the role lacks the
 *   permission the page needs, and a tick never grants one (every admin page,
 *   for an Employee or a Guest);
 * - a tab **you** do not have, if you are a Client Admin — you can give only
 *   what you hold;
 * - every box, if this is a **Client Admin's** list and you are not the
 *   platform administrator, who alone sets those.
 *
 * The server refuses all three regardless (`domain/access.grant_refusal`); this
 * only says so before the Save.
 */

import type { AccessCatalogue, AccessTab } from "@/api/endpoints/users";
import { dashboardLabel } from "@/auth/useDashboard";

/** `plant_overview` and `plant_list` are one screen: one box, both codes. */
const PLANTS_SCREEN = ["plant_overview", "plant_list"];

const ROLE_WORDS: Record<string, string> = {
  admin: "Client Admin",
  employee: "Client Employee",
  guest: "Guest",
};

interface Box {
  key: string;
  label: string;
  codes: string[];
  kind: "screen" | "admin";
  /** Why it cannot be ticked, or null. */
  blocked: string | null;
}

function boxes(
  catalogue: AccessCatalogue,
  role: string,
  editable: boolean,
  lockedReason: string,
): Box[] {
  const offered = new Set(catalogue.offered_by_role[role] ?? []);
  const givable = catalogue.givable === null ? null : new Set(catalogue.givable);
  const out: Box[] = [];
  const seen = new Set<string>();
  for (const tab of catalogue.tabs) {
    if (seen.has(tab.code)) continue;
    const codes = PLANTS_SCREEN.includes(tab.code) ? PLANTS_SCREEN : [tab.code];
    codes.forEach((code) => seen.add(code));
    out.push({
      key: codes[0],
      label: tab.kind === "screen" ? dashboardLabel(tab.code) : tab.name,
      codes,
      kind: tab.kind,
      blocked: blockedReason(tab, codes, role, offered, givable, editable, lockedReason),
    });
  }
  return out;
}

function blockedReason(
  tab: AccessTab,
  codes: string[],
  role: string,
  offered: Set<string>,
  givable: Set<string> | null,
  editable: boolean,
  lockedReason: string,
): string | null {
  if (!editable) return lockedReason;
  if (!codes.some((code) => offered.has(code))) {
    return `A ${ROLE_WORDS[role] ?? role} cannot use this page: the role does not hold ${
      tab.permission ?? "the permission it needs"
    }.`;
  }
  if (givable !== null && !codes.some((code) => givable.has(code))) {
    return "You do not have this tab yourself, so you cannot give it.";
  }
  return null;
}

export function TabChecklist({
  catalogue,
  role,
  selected,
  onChange,
  editable = true,
  lockedReason = "",
}: {
  catalogue: AccessCatalogue | undefined;
  /** The role the boxes are judged for: what it can use decides what is offered. */
  role: string;
  selected: string[];
  onChange: (next: string[]) => void;
  editable?: boolean;
  lockedReason?: string;
}): JSX.Element {
  if (!catalogue) {
    return <p className="text-xs text-ink-faint">Loading the tabs…</p>;
  }
  const all = boxes(catalogue, role, editable, lockedReason);
  const usable = all.filter((box) => box.blocked === null);
  const isTicked = (box: Box) => box.codes.some((code) => selected.includes(code));
  const toggle = (box: Box, on: boolean) =>
    onChange(
      on
        ? [...new Set([...selected, ...box.codes])]
        : selected.filter((code) => !box.codes.includes(code)),
    );
  const setAll = (kind: Box["kind"], on: boolean) => {
    const codes = usable.filter((box) => box.kind === kind).flatMap((box) => box.codes);
    onChange(on ? [...new Set([...selected, ...codes])] : selected.filter((c) => !codes.includes(c)));
  };

  const group = (kind: Box["kind"], title: string, note: string) => {
    const items = all.filter((box) => box.kind === kind);
    const usableHere = usable.filter((box) => box.kind === kind);
    const tickedHere = items.filter(isTicked).length;
    return (
      <fieldset className="min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <legend className="text-xs font-semibold text-ink">
            {title} <span className="font-normal text-ink-faint">{tickedHere} of {items.length}</span>
          </legend>
          {usableHere.length > 0 ? (
            <span className="flex gap-2 text-[11px]">
              <button type="button" className="text-accent hover:underline" onClick={() => setAll(kind, true)}>
                Tick all
              </button>
              <button type="button" className="text-accent hover:underline" onClick={() => setAll(kind, false)}>
                Clear
              </button>
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 text-[11px] leading-snug text-ink-faint">{note}</p>
        <div className="mt-1.5 grid grid-cols-1 gap-x-4 gap-y-1 rounded border border-line p-2 sm:grid-cols-2">
          {items.map((box) => (
            <label
              key={box.key}
              className={`flex items-center gap-2 text-xs ${box.blocked ? "text-ink-faint" : "text-ink"}`}
              title={box.blocked ?? undefined}
            >
              <input
                type="checkbox"
                checked={isTicked(box)}
                disabled={box.blocked !== null}
                onChange={(event) => toggle(box, event.target.checked)}
              />
              {box.label}
            </label>
          ))}
        </div>
      </fieldset>
    );
  };

  return (
    <div className="space-y-3">
      {group("screen", "Screens", "The monitoring tabs in their menu. A screen not ticked does not appear.")}
      {group(
        "admin",
        "Admin pages",
        role === "admin"
          ? "The pages under Administration. Each also needs its role permission, which a Client Admin holds."
          : "The pages under Administration. Only a Client Admin's role can use them, so they are greyed out here.",
      )}
    </div>
  );
}
